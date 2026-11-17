import fs from 'node:fs';
import path from 'node:path';
import { config, doubaoConfig } from '../config.ts';
import { PackAssembler } from '../infra/pipeline/assembler.ts';
import {
  ContentGenerationPipeline,
  type PipelineDeps
} from '../infra/pipeline/generation-pipeline.ts';
import { DoubaoProvider } from '../infra/providers/doubao-provider.ts';

/**
 * 给已有资源包补齐配音：回读生成源里「有正文但没音频」的幕，用默认音色合成，
 * 写回 content.json 并把版本 +1 重新装配发布；已配音的幕保持原样。
 * 用法（server 目录）：npm run audio:backfill -- [包ID...]，不带参数处理全部缺配音的包。
 */
if (!doubaoConfig.apiKey) {
  console.error('缺少 DOUBAO_TTS_API_KEY，请先在 server/.env 里填写');
  process.exit(1);
}

const pipeline = new ContentGenerationPipeline({
  voice: new DoubaoProvider(doubaoConfig),
  assembler: new PackAssembler(config.projectRoot, config.cdnDir),
  audioDir: path.join(config.cdnDir, 'audio'),
  sourceDir: config.srcDir,
  sceneBudgetKb: 2000,
  // 补齐配音只用到上面几项，其余端口不会被调用
  research: null,
  writer: null,
  images: null,
  sources: null,
  cleanup: null,
  sceneLimit: 0
} as unknown as PipelineDeps);

/** 统计生成源里还有几幕等着配音 */
function pendingCount(packId: string): number {
  const file = path.join(config.srcDir, packId, 'content.json');
  if (!fs.existsSync(file)) return -1;
  const content = JSON.parse(fs.readFileSync(file, 'utf8')) as { scenes?: Record<string, unknown>[] };
  const scenes = Array.isArray(content.scenes) ? content.scenes : [];
  return scenes.filter((scene) => {
    const text = String(scene.body || scene.narration || '').trim();
    return Boolean(text) && !scene.audio;
  }).length;
}

const wanted = process.argv.slice(2).filter(Boolean);
const ids = wanted.length
  ? wanted
  : fs
      .readdirSync(config.srcDir)
      .filter((name) => !name.startsWith('.'))
      .filter((name) => fs.existsSync(path.join(config.srcDir, name, 'content.json')));

let total = 0;
for (const id of ids) {
  const pending = pendingCount(id);
  if (pending < 0) {
    console.log(`[跳过] ${id}：生成源不存在`);
    continue;
  }
  if (pending === 0) {
    console.log(`[跳过] ${id}：没有缺音频的幕`);
    continue;
  }

  console.log(`[补齐] ${id}：${pending} 幕，开始合成`);
  const started = Date.now();
  let lastStage = '';
  const result = await pipeline.topUpAudio!(id, {
    report(progress, stage) {
      if (stage !== lastStage) {
        lastStage = stage;
        console.log(`  ${id} ${stage} ${progress}%`);
      }
    }
  });
  total += result.filled;
  console.log(
    `[完成] ${id}：补了 ${result.filled} 幕，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`
  );
}

console.log(`全部完成，共补 ${total} 幕配音`);
