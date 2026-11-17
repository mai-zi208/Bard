import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AssemblerPort, AssembleOptions } from '../../domain/ports.ts';
import type { AssembleResult, SourceEntry } from '../../domain/types.ts';

/** 装配适配器：调用现有 tools/assemble-pack.js，不在服务里重写转图与校验逻辑 */
export class PackAssembler implements AssemblerPort {
  private readonly root: string;
  private readonly cdnDir: string;

  constructor(root: string, cdnDir: string) {
    this.root = root;
    this.cdnDir = cdnDir;
  }

  run(source: SourceEntry, options: AssembleOptions = {}): Promise<AssembleResult> {
    const sourceDir = path.relative(this.root, source.dir);
    const finalDir = path.join(this.cdnDir, source.id);
    // 先写到 cdn/.tmp/{id}：临时目录名必须与 pack.id 一致，否则校验会报「id 与目录名不一致」
    const tmpDir = path.join(this.cdnDir, '.tmp', source.id);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    // 带上上一版 pack.json，装配脚本据此保留已有 pois、portraitFit 等字段
    const previousPack = path.join(finalDir, 'pack.json');
    if (fs.existsSync(previousPack)) {
      fs.copyFileSync(previousPack, path.join(tmpDir, 'pack.json'));
    }
    const outDir = path.relative(this.root, tmpDir);

    return new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [
          'tools/assemble-pack.js',
          '--content',
          path.join(sourceDir, 'content.json'),
          '--assets',
          sourceDir,
          '--out',
          outDir,
          ...(options.sceneMaxKb ? ['--scene-max-kb', String(options.sceneMaxKb)] : [])
        ],
        { cwd: this.root }
      );

      let log = '';
      const collect = (chunk: Buffer) => {
        log = (log + chunk.toString()).slice(-2000);
      };

      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('error', (err) => {
        discard(tmpDir);
        resolve({ ok: false, log: err.message });
      });
      child.on('close', (code) => {
        if (code !== 0) {
          discard(tmpDir);
          resolve({ ok: false, log: log });
          return;
        }
        try {
          publish(tmpDir, finalDir);
          resolve({ ok: true, log: log });
        } catch (err) {
          discard(tmpDir);
          const message = err instanceof Error ? err.message : String(err);
          resolve({ ok: false, log: '发布换入失败：' + message });
        }
      });
    });
  }
}

function discard(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 目录本就不存在或已被清理 */
  }
}

/** 临时目录整体换入发布目录：先挪走旧版，再换入新版，换入失败回滚 */
function publish(tmpDir: string, finalDir: string): void {
  const backupRoot = path.join(path.dirname(finalDir), '.backup');
  fs.mkdirSync(backupRoot, { recursive: true });
  const backupDir = path.join(backupRoot, path.basename(finalDir));
  // 只保留上一版
  fs.rmSync(backupDir, { recursive: true, force: true });

  const hadPrevious = fs.existsSync(finalDir);
  if (hadPrevious) fs.renameSync(finalDir, backupDir);

  try {
    fs.renameSync(tmpDir, finalDir);
  } catch (err) {
    if (hadPrevious) fs.renameSync(backupDir, finalDir);
    throw err;
  }
}
