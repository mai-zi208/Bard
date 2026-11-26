import fs from 'node:fs';
import path from 'node:path';
import { config, doubaoConfig, generationConfig, imageApiConfig, llmConfig, refreshConfig, taskConfig } from './config.ts';
import { buildServer } from './api/server.ts';
import { CatalogService } from './domain/services/catalog-service.ts';
import { SubmitLimiter } from './domain/services/submit-limiter.ts';
import { TaskService } from './domain/services/task-service.ts';
import { openDatabase } from './infra/db/database.ts';
import { PackAssembler } from './infra/pipeline/assembler.ts';
import { ContentGenerationPipeline } from './infra/pipeline/generation-pipeline.ts';
import { ImageGenerationProvider } from './infra/providers/image-provider.ts';
import { BaiduResearchProvider } from './infra/providers/research-provider.ts';
import { TieredResearchProvider } from './infra/providers/db-research-provider.ts';
import { QwenScriptWriter } from './infra/providers/script-provider.ts';
import { QwenRoutePlanner } from './infra/providers/plan-provider.ts';
import { DoubaoProvider } from './infra/providers/doubao-provider.ts';
import { AttractionRepository, openAttractionDatabase } from './infra/repositories/attraction-repository.ts';
import type { TaskKeyOverrides } from './domain/types.ts';
import { PackRepository } from './infra/repositories/pack-repository.ts';
import { RefreshCooldownRepository } from './infra/repositories/refresh-cooldown-repository.ts';
import { SourceRepository } from './infra/repositories/source-repository.ts';
import { TaskRepository } from './infra/repositories/task-repository.ts';
import { CdnStore } from './infra/storage/cdn-store.ts';
import { BuiltinPackStore } from './infra/storage/builtin-pack-store.ts';
import { PackCleaner } from './infra/storage/pack-cleaner.ts';
import { PackSourceWriter } from './infra/storage/pack-source-writer.ts';
import { SourceStore } from './infra/storage/source-store.ts';

fs.mkdirSync(config.cdnDir, { recursive: true });

const db = openDatabase(config.dbPath);

const catalog = new CatalogService(
  new CdnStore(config.cdnDir),
  new SourceStore(config.srcDir),
  new PackRepository(db),
  new SourceRepository(db)
);

const assembler = new PackAssembler(config.projectRoot, config.cdnDir);
// 生成失败清理与「同景点同讲述人」旧包清理共用同一个实例
const cleaner = new PackCleaner(config.srcDir, config.cdnDir);

// 配音：豆包在线合成（配了 API Key 才启用）
const voice = new DoubaoProvider(doubaoConfig);

// 景点内容库：命中时跳过在线检索；未导入（attractions.db 缺失）时全部回退百度
const attractions = new AttractionRepository(openAttractionDatabase(config.attractionsDbPath));
const attractionCount = attractions.count();
console.log(
  attractionCount
    ? `[景点库] 已加载 ${attractionCount} 条（${config.attractionsDbPath}）`
    : '[景点库] 未导入，资料检索全部走在线（npm run db:import-attractions 可构建）'
);

const research = new TieredResearchProvider(attractions, new BaiduResearchProvider());
const sources = new PackSourceWriter(config.srcDir, config.assetsDir);

/**
 * 按密钥覆盖构建生成流水线：客户端自带 key 时优先用自带，缺省项回退服务端 .env。
 * 文本模型没有可用 key 时返回 null：任务会明确失败，而不是产出残缺包。
 */
function createPipeline(overrides?: TaskKeyOverrides): ContentGenerationPipeline | null {
  const llmKey = overrides?.llm || llmConfig.apiKey;
  if (!llmKey) return null;
  const ttsConfig = overrides?.tts ? { ...doubaoConfig, apiKey: overrides.tts } : doubaoConfig;
  return new ContentGenerationPipeline({
    research,
    writer: new QwenScriptWriter({ ...llmConfig, apiKey: llmKey }),
    images: new ImageGenerationProvider(
      overrides?.image ? { ...imageApiConfig, apiKey: overrides.image } : imageApiConfig
    ),
    sources,
    cleanup: cleaner,
    assembler,
    sceneLimit: generationConfig.sceneMax,
    sceneBudgetKb: 2000,
    voice: ttsConfig === doubaoConfig ? voice : new DoubaoProvider(ttsConfig),
    audioDir: path.join(config.cdnDir, 'audio'),
    sourceDir: config.srcDir,
    publishedVersion: (packId) => catalog.findPublishedById(packId)?.version ?? 0,
    eagerAudioScenes: generationConfig.eagerAudioScenes
  });
}

// 没有 LLM key 时不构建默认流水线：任务会明确失败，而不是产出残缺包
const pipeline = createPipeline();

const tasks = new TaskService(
  new TaskRepository(db),
  catalog,
  pipeline,
  taskConfig.maxQueue,
  {
    cooldownDays: refreshConfig.cooldownDays,
    cooldowns: new RefreshCooldownRepository(db)
  },
  generationConfig.audioTopUp,
  cleaner,
  new BuiltinPackStore(config.builtinPackDir),
  createPipeline
);

catalog.reindex();
tasks.start();

const app = await buildServer({
  cdnDir: config.cdnDir,
  catalog,
  tasks,
  planner: new QwenRoutePlanner(llmConfig),
  plannerFactory: (llmKey) => new QwenRoutePlanner({ ...llmConfig, apiKey: llmKey })
});

async function shutdown(signal: string): Promise<void> {
  app.log.info('收到 ' + signal + '，正在关闭');
  tasks.stop();
  await app.close();
  db.close();
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

await app.listen({ port: config.port, host: config.host });
app.log.info('CDN 目录：' + config.cdnDir);
app.log.info('生成源目录：' + config.srcDir);
app.log.info('数据库：' + config.dbPath);
app.log.info(
  pipeline
    ? '生成流水线：已启用（' + llmConfig.model + '）'
    : '生成流水线：未启用（缺少 LLM_API_KEY）'
);
app.log.info(
  '配音合成：' +
    (pipeline && voice.enabled ? voiceLabel() : '未启用（检查 DOUBAO_TTS_API_KEY）')
);
app.log.info('后台配音补齐：' + (generationConfig.audioTopUp ? '已启用' : '已暂停（AUDIO_TOPUP=0）'));

function voiceLabel(): string {
  return (
    '豆包在线（' +
    doubaoConfig.resourceId +
    '；默认音色 ' +
    doubaoConfig.speaker +
    '，有讲述人时按人物自动匹配音色）'
  );
}
app.log.info(
  '提交保护：' +
    (taskConfig.apiToken ? '令牌校验已开启' : '未设置 API_TOKEN，跳过令牌校验') +
    '；单来源限流 ' +
    (taskConfig.submitPerMinute > 0 ? taskConfig.submitPerMinute + ' 次/分钟' : '不限')
);
