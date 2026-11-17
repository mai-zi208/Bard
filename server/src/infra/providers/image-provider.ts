import fs from 'node:fs';
import type { ImageAsset, ImageProvider } from '../../domain/ports.ts';
import { extensionOf, imageSize } from './http.ts';

/** 生成接口未就绪时返回的占位图固定为这个长度，画面是「The image is generating...」 */
const PLACEHOLDER_BYTES = 176626;

/** 出图提示词统一追加的收尾约束：竖幅实景、无文字水印 */
const SCENE_PROMPT_SUFFIX = '，中国景点实景照片，主体清晰居中，自然光，画面干净，无文字，无水印';

/** 外部出图服务配置：OpenAI images 兼容接口 */
export interface ImageGenConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  size: string;
  timeoutMs: number;
}

/**
 * 配图：全部由出图服务生成，不再检索真实照片。
 * 配了出图服务就走 OpenAI images 兼容接口，没配则退回内置 trae 接口。
 */
export class ImageGenerationProvider implements ImageProvider {
  readonly gen: ImageGenConfig;

  constructor(gen?: Partial<ImageGenConfig>) {
    this.gen = {
      baseUrl: gen?.baseUrl ?? '',
      apiKey: gen?.apiKey ?? '',
      model: gen?.model ?? 'qwen-image-2.1-pro',
      size: gen?.size ?? '1024x1536',
      timeoutMs: gen?.timeoutMs ?? 180000
    };
  }

  /** 按本幕画面描述生成主图 */
  async fetchScene(sceneId: string, prompt: string, fileBase: string): Promise<ImageAsset> {
    return this.generate(sceneId, prompt + SCENE_PROMPT_SUFFIX, fileBase, 'portrait_16_9');
  }

  /** 历史人物没有实拍可取，整包只生成一张人物插画：人物立于景物之前 */
  async fetchPortrait(
    persona: string,
    site: { title: string },
    fileBase: string
  ): Promise<ImageAsset> {
    const prompt =
      `国风人物插画：中国历史人物${persona}立于「${site.title}」的景物之前，侧身抬手示意，` +
      `身着与${site.title}相称的古代服饰，` +
      `背景是${site.title}标志性景物的虚化环境，只作场景交代，不抢人物；` +
      '人物为画面主体，姿态舒展，工笔重彩，竖幅，构图完整，无文字，无水印，' +
      '背景与人物同色系并自然延伸到画面边缘，避免纯黑背景与黑色边框';

    return this.generate('default', prompt, fileBase, 'portrait_4_3');
  }

  private async generate(
    sceneId: string,
    prompt: string,
    fileBase: string,
    sizeParam: 'portrait_16_9' | 'portrait_4_3'
  ): Promise<ImageAsset> {
    if (this.gen.baseUrl && this.gen.apiKey) {
      return this.generateByApi(sceneId, prompt, fileBase);
    }
    return this.generateByTrae(sceneId, prompt, fileBase, sizeParam);
  }

  /** OpenAI images 兼容接口：POST {baseUrl}/images/generations，优先取 b64_json，其次取 url */
  private async generateByApi(sceneId: string, prompt: string, fileBase: string): Promise<ImageAsset> {
    const url = this.gen.baseUrl + '/images/generations';

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + this.gen.apiKey
        },
        body: JSON.stringify({
          model: this.gen.model,
          prompt,
          n: 1,
          size: this.gen.size,
          response_format: 'b64_json'
        }),
        signal: AbortSignal.timeout(this.gen.timeoutMs)
      });
    } catch (err) {
      throw new Error('配图生成失败：出图服务不可达（' + (err instanceof Error ? err.message : String(err)) + '）');
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error('配图生成失败：出图服务返回 ' + res.status + (detail ? '（' + detail.slice(0, 120) + '）' : ''));
    }

    const payload = (await res.json().catch(() => null)) as {
      data?: Array<{ b64_json?: string; url?: string }>;
    } | null;
    const item = payload?.data?.[0];
    if (!item) throw new Error('配图生成失败：出图服务没有返回图片');

    let buf: Buffer;
    if (item.b64_json) {
      buf = Buffer.from(item.b64_json, 'base64');
    } else if (item.url) {
      const imgRes = await fetch(item.url, { signal: AbortSignal.timeout(this.gen.timeoutMs) });
      if (!imgRes.ok) throw new Error('配图生成失败：下载生成图返回 ' + imgRes.status);
      buf = Buffer.from(await imgRes.arrayBuffer());
    } else {
      throw new Error('配图生成失败：出图服务返回内容既无 b64_json 也无 url');
    }

    return this.writeGenerated(sceneId, buf, fileBase, url);
  }

  /** 内置 trae 接口：未配置外部出图服务时使用 */
  private async generateByTrae(
    sceneId: string,
    prompt: string,
    fileBase: string,
    sizeParam: 'portrait_16_9' | 'portrait_4_3'
  ): Promise<ImageAsset> {
    const url =
      'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=' +
      encodeURIComponent(prompt) +
      '&image_size=' +
      sizeParam;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(120000)
    });
    if (!res.ok) {
      throw new Error('配图生成失败：' + res.status);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === PLACEHOLDER_BYTES) {
      throw new Error(
        '配图生成失败：出图接口只返回占位图（未配置 IMAGE_API_BASE_URL / IMAGE_API_KEY），请改用可用的出图服务'
      );
    }

    return this.writeGenerated(sceneId, buf, fileBase, url);
  }

  private writeGenerated(
    sceneId: string,
    buf: Buffer,
    fileBase: string,
    sourceUrl: string
  ): ImageAsset {
    const size = imageSize(buf);
    if (!size) {
      throw new Error('配图生成失败：返回内容不是图片');
    }

    const file = fileBase + '.' + extensionOf(size);
    fs.writeFileSync(file, buf);

    return {
      sceneId,
      file,
      provider: 'generated',
      sourceUrl,
      width: size.width,
      height: size.height
    };
  }
}
