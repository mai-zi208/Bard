import fs from 'node:fs';
import path from 'node:path';
import type { SourceStorePort } from '../../domain/ports.ts';
import type { SourceEntry } from '../../domain/types.ts';
import { normalizeTopic } from '../../domain/services/source-matcher.ts';

/** 生成源目录（packs-src/）：每个含 content.json 的子目录是一个可装配的景物 */
export class SourceStore implements SourceStorePort {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  scan(): SourceEntry[] {
    if (!fs.existsSync(this.root)) return [];

    const entries: SourceEntry[] = [];

    fs.readdirSync(this.root).forEach((name) => {
      // .refresh-backup 等内部目录不是可装配的生成源
      if (name.startsWith('.')) return;

      const dir = path.join(this.root, name);
      const contentPath = path.join(dir, 'content.json');

      try {
        if (!fs.statSync(dir).isDirectory() || !fs.existsSync(contentPath)) return;

        const content = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
        const title = String(content.title || '');
        const narrator = content.narrator || {};

        entries.push({
          id: String(content.id || name),
          dir: dir,
          title: title,
          titleNorm: normalizeTopic(title),
          narratorId: String(narrator.id || ''),
          narratorName: String(narrator.name || ''),
          masterId: String(content.masterId || ''),
          persona: String(content.persona || narrator.name || ''),
          contentMtime: fs.statSync(contentPath).mtimeMs
        });
      } catch {
        // 单个源目录损坏不影响其余索引
      }
    });

    return entries.sort((a, b) => a.id.localeCompare(b.id));
  }

  contentMtime(source: SourceEntry): number {
    try {
      return fs.statSync(path.join(source.dir, 'content.json')).mtimeMs;
    } catch {
      return 0;
    }
  }
}
