/**
 * 生成链路共用的轻量 HTTP 工具：不引入额外依赖，直接用 Node 内置 fetch。
 * 只放文本抓取、HTML 去标签与图片尺寸识别，业务解析留在各 provider 里。
 */

export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export interface TextResponse {
  url: string;
  status: number;
  text: string;
}

export async function fetchText(
  url: string,
  userAgent: string,
  timeoutMs = 20000,
  referer?: string
): Promise<TextResponse> {
  const headers: Record<string, string> = {
    'user-agent': userAgent,
    'accept-language': 'zh-CN,zh;q=0.9'
  };
  // 部分搜索接口（如 image.so.com）缺少 referer 会返回 HTML 而不是 JSON
  if (referer) headers.referer = referer;

  const res = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  });
  return { url: res.url, status: res.status, text: await res.text() };
}

const NAMED: Record<string, string> = {
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  quot: '"',
  amp: '&',
  lt: '<',
  gt: '>',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  middot: '·',
  times: '×'
};

export function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (all, name: string) => NAMED[name.toLowerCase()] ?? all);
}

/** 粗暴但稳定的正文提取：去脚本样式、去标签、压空白 */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
}

export interface ImageSize {
  width: number;
  height: number;
  type: 'jpeg' | 'png' | 'webp';
}

/** 读取 JPEG / PNG / WebP 头部尺寸，避免为了校验引入图片库 */
export function imageSize(buf: Buffer): ImageSize | null {
  if (buf.length < 24) return null;

  if (buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), type: 'png' };
  }

  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buf[offset + 1];
      const len = buf.readUInt16BE(offset + 2);
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return {
          height: buf.readUInt16BE(offset + 5),
          width: buf.readUInt16BE(offset + 7),
          type: 'jpeg'
        };
      }
      offset += 2 + len;
    }
    return null;
  }

  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const type = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (type === 'VP8X') {
      return {
        width: buf.readUIntLE(start + 4, 3) + 1,
        height: buf.readUIntLE(start + 7, 3) + 1,
        type: 'webp'
      };
    }
    if (type === 'VP8 ') {
      return {
        width: buf.readUInt16LE(start + 6) & 0x3fff,
        height: buf.readUInt16LE(start + 8) & 0x3fff,
        type: 'webp'
      };
    }
    if (type === 'VP8L') {
      const bits = buf.readUInt32LE(start + 1);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
        type: 'webp'
      };
    }
    offset = start + size + (size % 2);
  }
  return null;
}

export function extensionOf(size: ImageSize): string {
  return size.type === 'png' ? 'png' : size.type === 'webp' ? 'webp' : 'jpg';
}
