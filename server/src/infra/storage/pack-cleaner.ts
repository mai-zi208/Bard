import fs from 'node:fs';
import path from 'node:path';
import type { PackCleanupPort } from '../../domain/ports.ts';

/** 生成失败时删除半成品，避免脏目录被下一次索引扫进 manifest */
export class PackCleaner implements PackCleanupPort {
  private readonly srcDir: string;
  private readonly cdnDir: string;

  constructor(srcDir: string, cdnDir: string) {
    this.srcDir = srcDir;
    this.cdnDir = cdnDir;
  }

  remove(packId: string): void {
    const audioRoot = path.join(this.cdnDir, 'audio');
    const targets = [
      path.join(this.srcDir, packId),
      path.join(this.cdnDir, packId),
      // 包外音频：正式目录与暂存目录一并清理
      path.join(audioRoot, packId),
      path.join(audioRoot, '.tmp-' + packId)
    ];

    for (const target of targets) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch (err) {
        console.warn('[生成] 清理失败：' + target, err);
      }
    }
  }
}
