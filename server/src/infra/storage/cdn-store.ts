import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PublishedStore } from '../../domain/ports.ts';
import type { PublishedPack } from '../../domain/types.ts';
import { pickLocalized } from '../../domain/localized.ts';

/** 与 tools/build-manifest.js 保持一致：这些文件不进清单 */
const SKIP = new Set(['manifest.json', 'sources.md', 'script.md']);

interface FileChecksum {
  sha256: string;
  size: number;
}

/** 逐文件摘要：客户端下载后按 sha256 + size 校验，截断或被篡改即丢弃 */
function checksumOf(abs: string): FileChecksum {
  const buf = fs.readFileSync(abs);
  return {
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    size: buf.length
  };
}

/** 兼容 ISO 字符串与毫秒时间戳，解析失败返回 0 */
function parseTime(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function listFiles(dir: string, base: string): string[] {
  const out: string[] = [];
  fs.readdirSync(path.join(dir, base)).forEach((name) => {
    const rel = base ? base + '/' + name : name;
    const abs = path.join(dir, rel);
    if (fs.statSync(abs).isDirectory()) {
      out.push(...listFiles(dir, rel));
    } else if (!SKIP.has(name)) {
      out.push(rel);
    }
  });
  return out;
}

/** 发布目录（cdn/）：扫描资源包、写清单 */
export class CdnStore implements PublishedStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  scan(): PublishedPack[] {
    if (!fs.existsSync(this.root)) return [];

    return fs
      .readdirSync(this.root)
      .map((name) => path.join(this.root, name))
      .filter((dir) => {
        try {
          return fs.statSync(dir).isDirectory();
        } catch {
          return false;
        }
      })
      .filter((dir) => fs.existsSync(path.join(dir, 'pack.json')))
      .map((dir) => this.readPack(dir))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  writeManifest(packs: PublishedPack[]): void {
    fs.mkdirSync(this.root, { recursive: true });

    const manifest = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      packs: packs.map((pack) => ({
        id: pack.id,
        version: pack.version,
        ...(Number(pack.minVersion) > 0 ? { minVersion: Number(pack.minVersion) } : {}),
        ...(pack.deprecated === true ? { deprecated: true } : {}),
        title: pack.title,
        subtitle: pack.subtitle,
        summary: pack.summary,
        tags: pack.tags,
        total: pack.total,
        narratorName: pack.narratorName,
        cover: pack.cover,
        bytes: pack.bytes,
        audioCount: pack.audioCount,
        aiGenerated: pack.aiGenerated,
        refreshedAt: new Date(pack.refreshedAt).toISOString(),
        ...(pack.ttlDays > 0 ? { ttlDays: pack.ttlDays } : {}),
        ...(pack.masterId ? { masterId: pack.masterId } : {}),
        ...(pack.persona ? { persona: pack.persona } : {}),
        files: pack.files,
        checksums: pack.files.reduce<Record<string, FileChecksum>>((acc, rel) => {
          acc[rel] = checksumOf(path.join(this.root, pack.id, rel));
          return acc;
        }, {})
      }))
    };

    // 先写临时文件再原子替换，避免客户端读到半截清单；上一版留作回滚
    const target = path.join(this.root, 'manifest.json');
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    if (fs.existsSync(target)) {
      fs.copyFileSync(target, target + '.bak');
    }
    fs.renameSync(tmp, target);
  }

  packMtime(id: string): number {
    try {
      return fs.statSync(path.join(this.root, id, 'pack.json')).mtimeMs;
    } catch {
      return 0;
    }
  }

  private readPack(dir: string): PublishedPack {
    const packPath = path.join(dir, 'pack.json');
    const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
    const locale = pack.defaultLocale || 'zh-CN';

    const files = listFiles(dir, '').sort();
    const ordered = ['pack.json', pack.cover].concat(
      files.filter((file) => file !== 'pack.json' && file !== pack.cover)
    );

    let bytes = 0;
    ordered.forEach((rel) => {
      bytes += fs.statSync(path.join(dir, rel)).size;
    });

    const publishedAt = fs.statSync(packPath).mtimeMs;
    const narratorName = pack.narrator ? pickLocalized(pack.narrator.name, locale) : '';

    return {
      id: pack.id,
      version: pack.version || 1,
      minVersion: Number(pack.minVersion) > 0 ? Number(pack.minVersion) : 0,
      deprecated: pack.deprecated === true,
      title: pickLocalized(pack.title, locale),
      subtitle: pickLocalized(pack.subtitle, locale),
      summary: pickLocalized(pack.summary, locale),
      tags: Array.isArray(pack.tags) ? pack.tags : [],
      total: Array.isArray(pack.scenes) ? pack.scenes.length : 0,
      narratorName: narratorName,
      cover: pack.cover,
      bytes: bytes,
      audioCount: Array.isArray(pack.scenes)
        ? pack.scenes.filter((scene: { audio?: unknown }) => scene && scene.audio).length
        : 0,
      files: ordered,
      publishedAt: publishedAt,
      refreshedAt: parseTime(pack.refreshedAt) || publishedAt,
      ttlDays: Number(pack.ttlDays) > 0 ? Number(pack.ttlDays) : 0,
      masterId: String(pack.masterId || ''),
      persona: String(pack.persona || narratorName),
      aiGenerated: pack.generated === true || pack.aiGenerated === true
    };
  }
}
