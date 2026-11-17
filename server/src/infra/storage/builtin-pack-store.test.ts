import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BuiltinPackStore } from './builtin-pack-store.ts';

test('读取内置包标题与讲述人，忽略非包目录', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-packs-'));

  fs.mkdirSync(path.join(root, 'shaolin'));
  fs.writeFileSync(
    path.join(root, 'shaolin', 'pack.json'),
    JSON.stringify({ id: 'shaolin', title: '少林寺' }),
    'utf8'
  );

  fs.mkdirSync(path.join(root, 'demo'));
  fs.writeFileSync(
    path.join(root, 'demo', 'pack.json'),
    JSON.stringify({
      id: 'demo',
      title: { 'zh-CN': '演示景点' },
      narrator: { name: '武则天' }
    }),
    'utf8'
  );

  // 目录下的非包文件（构建产物）应被忽略
  fs.writeFileSync(path.join(root, 'registry.js'), 'module.exports = []', 'utf8');
  fs.mkdirSync(path.join(root, 'empty'));

  const list = new BuiltinPackStore(root)
    .list()
    .sort((a, b) => a.id.localeCompare(b.id));

  assert.deepEqual(list, [
    { id: 'demo', title: '演示景点', narratorName: '武则天' },
    { id: 'shaolin', title: '少林寺', narratorName: '' }
  ]);

  fs.rmSync(root, { recursive: true, force: true });
});

test('内置包目录不存在时返回空清单', () => {
  const store = new BuiltinPackStore(path.join(os.tmpdir(), 'builtin-packs-missing-dir'));
  assert.deepEqual(store.list(), []);
});
