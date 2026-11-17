import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CdnStore } from './cdn-store.ts';

test('清单为每个文件输出 sha256 与 size', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-store-'));
  const dir = path.join(root, 'demo');
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });

  fs.writeFileSync(
    path.join(dir, 'pack.json'),
    JSON.stringify({
      id: 'demo',
      schemaVersion: 1,
      version: 3,
      minVersion: 2,
      deprecated: true,
      title: '测试包',
      cover: 'cover.jpg',
      refreshedAt: '2026-01-01T00:00:00.000Z',
      ttlDays: 30,
      masterId: 'demo-master',
      persona: '武则天',
      scenes: [{ id: 'scene-1' }]
    })
  );
  fs.writeFileSync(path.join(dir, 'cover.jpg'), 'cover-bytes');
  fs.writeFileSync(path.join(dir, 'images', '01.jpg'), 'scene-bytes');

  const store = new CdnStore(root);
  store.writeManifest(store.scan());

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const entry = manifest.packs[0];

  assert.deepEqual(entry.files, ['pack.json', 'cover.jpg', 'images/01.jpg']);
  assert.equal(entry.version, 3);
  // 最低版本与软下架标记随清单输出，客户端据此强制更新 / 隐藏
  assert.equal(entry.minVersion, 2);
  assert.equal(entry.deprecated, true);
  assert.equal(entry.refreshedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(entry.ttlDays, 30);
  assert.equal(entry.masterId, 'demo-master');
  assert.equal(entry.persona, '武则天');
  assert.equal(entry.checksums['images/01.jpg'].size, Buffer.byteLength('scene-bytes'));
  assert.equal(
    entry.checksums['images/01.jpg'].sha256,
    crypto.createHash('sha256').update('scene-bytes').digest('hex')
  );
  assert.notEqual(
    entry.checksums['cover.jpg'].sha256,
    entry.checksums['images/01.jpg'].sha256
  );

  // 再次写入时原子替换，并保留上一版清单
  const first = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
  store.writeManifest(store.scan());
  assert.equal(fs.readFileSync(path.join(root, 'manifest.json.bak'), 'utf8'), first);
  assert.equal(fs.existsSync(path.join(root, 'manifest.json.tmp')), false);

  fs.rmSync(root, { recursive: true, force: true });
});
