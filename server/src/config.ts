import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const projectRoot = path.resolve(serverRoot, '..');

function dirFromEnv(key: string, fallback: string): string {
  const value = process.env[key];
  return value ? path.resolve(value) : fallback;
}

export const config = {
  port: Number(process.env.PORT ?? 8788),
  host: process.env.HOST ?? '0.0.0.0',
  projectRoot,
  cdnDir: dirFromEnv('CDN_DIR', path.join(projectRoot, 'cdn')),
  srcDir: dirFromEnv('SRC_DIR', path.join(projectRoot, 'packs-src')),
  /** 小程序内置包目录：服务端提交去重时也要认出这些已内置的景点 */
  builtinPackDir: dirFromEnv('BUILTIN_PACK_DIR', path.join(projectRoot, 'web', 'packs')),
  dbPath: dirFromEnv('DB_PATH', path.join(serverRoot, 'data', 'app.db')),
  assetsDir: dirFromEnv('ASSETS_DIR', path.join(projectRoot, 'assets'))
};

/** 文稿生成用的 OpenAI 兼容服务（通义千问）；缺 key 时任务明确失败，不做静默降级 */
export const llmConfig = {
  apiKey: process.env.LLM_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? '',
  baseUrl: (process.env.LLM_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(
    /\/+$/,
    ''
  ),
  model: process.env.LLM_MODEL ?? 'qwen3.7-plus',
  /** 千问混合思考模型：思考内容与正文共用 max_tokens，默认关闭以免长 JSON 被截断 */
  enableThinking: process.env.LLM_ENABLE_THINKING === '1',
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 180000)
};

export const taskConfig = {
  /** 同时排队/执行的生成任务上限，0 表示不限制；防止批量提交打爆生成额度 */
  maxQueue: Number(process.env.TASK_QUEUE_MAX ?? 8),
  /** 提交令牌：设置后 POST /tasks 需带 x-api-token 头；为空表示不校验 */
  apiToken: process.env.API_TOKEN ?? '',
  /** 单来源每分钟最多提交次数，0 表示不限制 */
  submitPerMinute: Number(process.env.TASK_RATE_LIMIT ?? 10)
};

export const refreshConfig = {
  /** 刷新任务失败后的冷却天数，避免反复消耗生成额度；不再按保鲜期自动触发刷新 */
  cooldownDays: Number(process.env.PACK_REFRESH_COOLDOWN_DAYS ?? 7)
};

export const generationConfig = {
  /** 0 表示不限制，幕数由景物清单决定（校验规则 5–40） */
  sceneMax: Number(process.env.GENERATION_SCENE_MAX ?? 0),
  /** 主任务同步生成配音的幕数：0 表示全量一次生成；设为前 N 幕时其余幕发布后由后台任务补齐 */
  eagerAudioScenes: Number(process.env.AUDIO_EAGER_SCENES ?? 0),
  /** 后台配音补齐总开关：AUDIO_TOPUP=0 暂停（不排队、已排任务直接失败），默认开启 */
  audioTopUp: process.env.AUDIO_TOPUP !== '0'
};

/**
 * 出图服务：OpenAI images 兼容接口（POST {baseUrl}/images/generations）。
 * 现在配图全部由该服务生成，未配置时退回内置 trae 接口（只返回占位图，会直接判失败）。
 */
export const imageApiConfig = {
  baseUrl: (process.env.IMAGE_API_BASE_URL ?? '').replace(/\/+$/, ''),
  apiKey: process.env.IMAGE_API_KEY ?? '',
  model: process.env.IMAGE_API_MODEL ?? 'qwen-image-2.1-pro',
  /** 竖图尺寸，按服务商支持的范围填，如 1024x1536 / 1024x1792 */
  size: process.env.IMAGE_API_SIZE ?? '1024x1536',
  timeoutMs: Number(process.env.IMAGE_API_TIMEOUT_MS ?? 180000)
};

/**
 * 配音合成：火山引擎豆包语音合成（V3 HTTP 单向流式）。
 * 配了 API Key 即启用；音色用官方现成音色（seed-tts-2.0 音色列表）。
 */
export const doubaoConfig = {
  url: process.env.DOUBAO_TTS_URL ?? 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
  apiKey: process.env.DOUBAO_TTS_API_KEY ?? '',
  /** 资源 ID 决定模型与计费：seed-tts-2.0 / seed-tts-1.0；复刻音色用 seed-icl-2.0 */
  resourceId: process.env.DOUBAO_TTS_RESOURCE_ID ?? 'seed-tts-2.0',
  /** 官方音色 speaker id；2.0 音色与 1.0 音色不可混用 */
  speaker: process.env.DOUBAO_TTS_SPEAKER ?? 'zh_female_gaolengyujie_uranus_bigtts',
  /** 输出采样率，保留 44.1kHz 避免高频被砍 */
  sampleRate: Number(process.env.DOUBAO_TTS_SAMPLE_RATE ?? 44100),
  /** 语速 [-50,100]，0 为原速 */
  speechRate: Number(process.env.DOUBAO_TTS_SPEECH_RATE ?? 0),
  /** 单幕时长上限（秒），超过判该幕配音失败，防 TTS 拖尾复读 */
  maxSec: Number(process.env.TTS_MAX_SEC ?? 90),
  timeoutMs: Number(process.env.DOUBAO_TTS_TIMEOUT_MS ?? 60000)
};
