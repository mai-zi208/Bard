import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PackSourceInput } from '../../domain/ports.ts';
import { PackSourceWriter } from './pack-source-writer.ts';

function setup(): { root: string; writer: PackSourceWriter; dir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-source-writer-'));
  const src = path.join(root, 'packs-src');
  const dir = path.join(src, 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'content.json'),
    JSON.stringify({ id: 'demo', version: 2, title: '旧标题' })
  );
  fs.writeFileSync(path.join(dir, 'old-image.jpg'), 'old');
  return { root, writer: new PackSourceWriter(src, path.join(root, 'assets')), dir };
}

test('刷新失败回滚旧源，成功提交后删除备份', () => {
  const { root, writer, dir } = setup();

  const failed = writer.beginRefresh('demo');
  assert.equal(failed.id, 'demo');
  assert.equal(fs.existsSync(path.join(dir, 'content.json')), false);
  fs.writeFileSync(path.join(dir, 'content.json'), JSON.stringify({ id: 'demo', version: 3 }));
  failed.rollback();

  const restored = JSON.parse(fs.readFileSync(path.join(dir, 'content.json'), 'utf8'));
  assert.equal(restored.version, 2);
  assert.equal(fs.existsSync(path.join(dir, 'old-image.jpg')), true);

  const ok = writer.beginRefresh('demo');
  fs.writeFileSync(path.join(dir, 'content.json'), JSON.stringify({ id: 'demo', version: 3 }));
  ok.commit();

  const committed = JSON.parse(fs.readFileSync(path.join(dir, 'content.json'), 'utf8'));
  assert.equal(committed.version, 3);
  assert.equal(fs.existsSync(path.join(dir, 'old-image.jpg')), false);

  const backups = path.join(path.dirname(dir), '.refresh-backup');
  assert.equal(
    fs.existsSync(backups) ? fs.readdirSync(backups).length : 0,
    0,
    '成功后不保留源备份'
  );

  fs.rmSync(root, { recursive: true, force: true });
});

function writeMaster(root: string): { writer: PackSourceWriter; dir: string } {
  const src = path.join(root, 'packs-src');
  const dir = path.join(src, 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'content.json'),
    JSON.stringify({
      id: 'demo',
      version: 2,
      title: '白马寺',
      scenes: [
        {
          id: 'shanmen',
          title: '山门',
          subtitle: '三门并立',
          imageAlt: '山门',
          pose: '合十而立',
          body: '第一段。\n\n第二段。\n\n第三段。'
        }
      ]
    })
  );
  fs.writeFileSync(
    path.join(dir, 'images.json'),
    JSON.stringify({
      cover: { file: 'cover.jpg', width: 900, height: 1200 },
      scenes: [{ file: 'scene-shanmen.jpg', width: 1080, height: 1920 }]
    })
  );
  fs.writeFileSync(path.join(dir, 'scene-shanmen.jpg'), 'scene-image');
  fs.writeFileSync(path.join(dir, 'cover.jpg'), 'cover-image');
  return { writer: new PackSourceWriter(src, path.join(root, 'assets')), dir };
}

test('readMaster 读取母本正文与分镜，变体源不作为母本', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-source-read-'));
  const { writer, dir } = writeMaster(root);

  const master = writer.readMaster('demo');
  assert.ok(master);
  assert.equal(master.scenes[0].pose, '合十而立');
  assert.match(master.scenes[0].body, /第一段/);
  assert.equal(master.images.length, 1);
  assert.equal(master.images[0].file, path.join(dir, 'scene-shanmen.jpg'));
  assert.equal(master.cover?.file, path.join(dir, 'cover.jpg'));

  fs.mkdirSync(path.join(path.dirname(dir), 'demo--wuzetian'));
  fs.writeFileSync(
    path.join(path.dirname(dir), 'demo--wuzetian', 'content.json'),
    JSON.stringify({ id: 'demo--wuzetian', masterId: 'demo', persona: '武则天', scenes: [] })
  );
  assert.equal(writer.readMaster('demo--wuzetian'), null);

  fs.rmSync(root, { recursive: true, force: true });
});

test('人物变体写源时复用母本分镜并写入母本标记', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-source-variant-'));
  const { writer } = writeMaster(root);
  const master = writer.readMaster('demo');
  assert.ok(master);

  const created = writer.createDir('demo--wuzetian');
  const input: PackSourceInput = {
    dir: created.dir,
    version: 1,
    outline: {
      id: created.id,
      title: '白马寺',
      subtitle: '',
      summary: '',
      tags: [],
      scenes: [
        {
          id: 'shanmen',
          title: '山门',
          subtitle: '三门并立',
          imageAlt: '山门',
          pose: '合十而立',
          brief: '',
          imageQuery: ''
        }
      ]
    },
    scripts: {
      scenes: [
        {
          id: 'shanmen',
          body: '甲。\n\n乙。\n\n丙。',
          transition: 'fade',
          holdMs: 9000,
          sources: []
        }
      ]
    },
    narrator: { id: 'narrator', name: '武则天', title: '大周圣神皇帝' },
    images: master.images.map((image) => ({ ...image, provider: 'linked' as const, sourceUrl: '' })),
    portrait: null,
    cover: { ...master.cover!, provider: 'linked' as const, sourceUrl: '' },
    references: [],
    masterId: master.id,
    linkImages: true
  };
  writer.write(input);

  const content = JSON.parse(fs.readFileSync(path.join(created.dir, 'content.json'), 'utf8'));
  assert.equal(content.masterId, 'demo');
  assert.equal(content.persona, '武则天');
  assert.equal(content.narrator.name, '武则天');

  assert.equal(
    fs.readFileSync(path.join(created.dir, 'scene-shanmen.jpg'), 'utf8'),
    'scene-image'
  );
  assert.equal(fs.readFileSync(path.join(created.dir, 'cover.jpg'), 'utf8'), 'cover-image');
  // 母本文件仍保留
  assert.equal(fs.existsSync(master.images[0].file), true);

  fs.rmSync(root, { recursive: true, force: true });
});
