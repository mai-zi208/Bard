import fs from 'node:fs';
import path from 'node:path';
import type { BuiltinPackEntry, BuiltinPackPort } from '../../domain/ports.ts';

/** 本地化字段：内置包多为字符串，兼容 { 'zh-CN': ... } 对象形态 */
function pickText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const fields = value as Record<string, unknown>;
    const hit = fields['zh-CN'] ?? Object.values(fields)[0];
    return typeof hit === 'string' ? hit : '';
  }
  return '';
}

/**
 * 内置包目录（miniprogram/packs/{id}/pack.json）读取。
 * 内置包随小程序发布、不进 cdn/，服务端索引不到，提交去重时单独读取。
 */
export class BuiltinPackStore implements BuiltinPackPort {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  list(): BuiltinPackEntry[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return [];
    }

    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.read(entry.name))
      .filter((pack): pack is BuiltinPackEntry => pack !== null);
  }

  private read(dirName: string): BuiltinPackEntry | null {
    const file = path.join(this.dir, dirName, 'pack.json');
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      const title = pickText(raw.title);
      if (!title) return null;
      const narrator = raw.narrator as Record<string, unknown> | undefined;
      return {
        id: typeof raw.id === 'string' && raw.id ? raw.id : dirName,
        title,
        narratorName: narrator ? pickText(narrator.name) : ''
      };
    } catch {
      return null;
    }
  }
}
