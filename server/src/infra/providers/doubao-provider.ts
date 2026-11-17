import { createHash } from 'node:crypto';
import type { SceneAudioMeta, VoiceSynthPort } from '../../domain/ports.ts';
import { encodeMp3, pcmToWav } from './audio-encode.ts';

export interface DoubaoConfig {
  /** V3 HTTP 单向流式地址；留空即未启用 */
  url: string;
  /** 新版控制台 API Key */
  apiKey: string;
  /** 资源 ID：seed-tts-2.0 / seed-tts-1.0 / seed-icl-*.0 */
  resourceId: string;
  /** 官方音色 speaker id */
  speaker: string;
  /** 输出采样率，需在 [8000,16000,22050,24000,32000,44100,48000] 内 */
  sampleRate: number;
  /** 语速 [-50,100] */
  speechRate: number;
  timeoutMs: number;
  /** 单幕时长上限（秒），超过判该幕配音失败 */
  maxSec: number;
}

export interface DoubaoDeps {
  fetchImpl?: typeof fetch;
  /** PCM → MP3；默认 ffmpeg-static，单测注入 fake */
  encodeMp3?: (wav: Buffer) => Promise<Buffer>;
}

/** 合成结束的成功码，之后不再有音频数据 */
const DONE_CODE = 20000000;

/** 从流式响应里切出完整的 JSON 对象：兼容按行与连排两种写法 */
function findJsonEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 豆包语音合成（火山引擎 V3 HTTP 单向流式）：
 * 请求 44.1kHz 裸 PCM，流式响应里按 base64 拼音频，结束时用 ffmpeg 转 64k MP3。
 * 选择 PCM 而不是直接要 MP3，是为了用字节数精确算时长，元数据不依赖解析 MP3 帧。
 */
export class DoubaoProvider implements VoiceSynthPort {
  private readonly cfg: DoubaoConfig;
  private readonly deps: DoubaoDeps;

  constructor(cfg: DoubaoConfig, deps: DoubaoDeps = {}) {
    this.cfg = cfg;
    this.deps = deps;
  }

  get enabled(): boolean {
    return Boolean(this.cfg.url && this.cfg.apiKey && this.cfg.speaker);
  }

  synthesize(
    text: string,
    options?: { speaker?: string }
  ): Promise<{ mp3: Buffer; meta: SceneAudioMeta } | null> {
    if (!this.enabled || !text.trim()) return Promise.resolve(null);
    const speaker = options?.speaker || this.cfg.speaker;
    if (speaker === this.cfg.speaker) return this.runOne(text, speaker);
    // 人物音色可能因账号权限或下线不可用：失败后退回默认音色重试一次，避免整幕无声
    return this.runOne(text, speaker).then((result) => {
      if (result) return result;
      console.warn(`[配音] 音色 ${speaker} 合成失败，改用默认音色 ${this.cfg.speaker} 重试`);
      return this.runOne(text, this.cfg.speaker);
    });
  }

  private async runOne(
    text: string,
    speaker: string
  ): Promise<{ mp3: Buffer; meta: SceneAudioMeta } | null> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    try {
      const res = await fetchImpl(this.cfg.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.cfg.apiKey,
          'x-api-resource-id': this.cfg.resourceId,
          'x-api-request-id': createHash('sha1').update(text).digest('hex').slice(0, 32)
        },
        body: JSON.stringify({
          user: { uid: 'travel-server' },
          req_params: {
            text,
            speaker,
            audio_params: {
              format: 'pcm',
              sample_rate: this.cfg.sampleRate,
              speech_rate: this.cfg.speechRate
            },
            // additions 在协议里是 json 字符串，不是对象
            additions: JSON.stringify({ disable_markdown_filter: true })
          }
        }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs)
      });

      if (!res.ok) throw new Error('配音提交失败 HTTP ' + res.status);

      const pcm = await this.collectPcm(res);
      if (!pcm.length) throw new Error('配音结果没有音频数据');

      const durSec = pcm.length / (this.cfg.sampleRate * 2);
      if (durSec > this.cfg.maxSec) {
        throw new Error(`该幕音频 ${Math.round(durSec)}s 超过上限 ${this.cfg.maxSec}s`);
      }

      const mp3 = await (this.deps.encodeMp3 ?? encodeMp3)(
        pcmToWav(pcm, this.cfg.sampleRate)
      );
      if (!mp3.length) throw new Error('MP3 转码结果为空');

      return {
        mp3,
        meta: {
          durSec: Math.round(durSec),
          bytes: mp3.length,
          sha256: createHash('sha256').update(mp3).digest('hex')
        }
      };
    } catch (err) {
      console.warn('[配音] ' + (err instanceof Error ? err.message : String(err)));
      return null;
    }
  }

  /** 读流式响应：每块是 {code,message,data}，data 为 base64 音频分片 */
  private async collectPcm(res: Response): Promise<Buffer> {
    if (!res.body) throw new Error('配音响应没有可读的流');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const chunks: Buffer[] = [];
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const start = buffer.indexOf('{');
        if (start < 0) {
          buffer = '';
          break;
        }
        const end = findJsonEnd(buffer, start);
        if (end < 0) {
          buffer = buffer.slice(start);
          break;
        }

        const payload = JSON.parse(buffer.slice(start, end + 1)) as {
          code?: number;
          message?: string;
          data?: string | null;
        };
        buffer = buffer.slice(end + 1);

        const code = Number(payload.code ?? 0);
        if (code === DONE_CODE) return Buffer.concat(chunks);
        if (code > 0) {
          throw new Error('配音服务返回 ' + code + (payload.message ? '：' + payload.message : ''));
        }
        if (payload.data) chunks.push(Buffer.from(payload.data, 'base64'));
      }
    }

    if (!chunks.length) throw new Error('配音流结束但没有收到音频');
    return Buffer.concat(chunks);
  }
}
