import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PackCleaner } from './pack-cleaner.ts';

test('PackCleaner 删除源目录与发布包，其他包不受影响', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-cleaner-'));
  const srcDir = path.join(root, 'packs-src');
  const cdnDir = path.join(root, 'cdn');

  for (const dir of [
    path.join(srcDir, 'demo'),
    path.join(cdnDir, 'demo'),
    path.join(srcDir, 'keep'),
    path.join(cdnDir, 'keep')
  ]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'file.txt'), 'x');
  }

  new PackCleaner(srcDir, cdnDir).remove('demo');

  assert.equal(fs.existsSync(path.join(srcDir, 'demo')), false);
  assert.equal(fs.existsSync(path.join(cdnDir, 'demo')), false);
  assert.equal(fs.existsSync(path.join(srcDir, 'keep')), true);
  assert.equal(fs.existsSync(path.join(cdnDir, 'keep')), true);

  fs.rmSync(root, { recursive: true, force: true });
});
