import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AttractionRepository, openAttractionDatabase } from './attraction-repository.ts';
import { createAttractionsDb } from '../../scripts/import-attractions.ts';

/** 用与导入脚本相同的建表逻辑造 :memory: fixture */
function seededDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE attractions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, name_cn TEXT NOT NULL, name_norm TEXT NOT NULL,
      city TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', intro TEXT NOT NULL DEFAULT '',
      open_time TEXT NOT NULL DEFAULT '', ticket TEXT NOT NULL DEFAULT '', tips TEXT NOT NULL DEFAULT '',
      duration TEXT NOT NULL DEFAULT '', season TEXT NOT NULL DEFAULT '', rating TEXT NOT NULL DEFAULT '',
      images TEXT NOT NULL DEFAULT '[]', link TEXT NOT NULL DEFAULT '', intro_len INTEGER NOT NULL DEFAULT 0,
      UNIQUE (city, name_norm)
    );
  `);
  const insert = db.prepare(
    `INSERT INTO attractions (name, name_cn, name_norm, city, intro, images, link, intro_len)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insert.run('龙门石窟Longmen Grottoes', '龙门石窟', '龙门石窟', '洛阳', '世界文化遗产。'.repeat(100), '["https://a/x.jpg_480x360x95_1.jpg"]', 'http://q/longmen', 700);
  insert.run('白马寺', '白马寺', '白马寺', '洛阳', '中国第一古刹。', '[]', 'http://q/baima', 7);
  insert.run('关林', '关林', '关林', '洛阳', '武圣庙。', '[]', 'http/q/guanlin', 4);
  insert.run('少林寺', '少林寺', '少林寺', '郑州', '禅宗祖庭。', '[]', 'http://q/shaolin', 5);
  insert.run('关帝庙', '关帝庙', '关帝庙', '洛阳', '洛阳关帝庙。', '[]', '', 6);
  insert.run('关帝庙', '关帝庙', '关帝庙', '运城', '运城关帝庙。', '[]', '', 6);
  return db;
}

test('精确命中：洛阳+龙门石窟，图片与介绍齐全', () => {
  const repo = new AttractionRepository(seededDb());
  const hit = repo.findByCityAndName('洛阳', '龙门石窟');
  assert.ok(hit);
  assert.equal(hit.nameCn, '龙门石窟');
  assert.equal(hit.introLen, 700);
  assert.deepEqual(hit.images, ['https://a/x.jpg_480x360x95_1.jpg']);
});

test('包含命中：输入截短「龙门」匹配龙门石窟', () => {
  const repo = new AttractionRepository(seededDb());
  assert.equal(repo.findByCityAndName('洛阳', '龙门')?.nameCn, '龙门石窟');
});

test('编辑距离命中：错别字「龙马石窟」仍匹配龙门石窟', () => {
  const repo = new AttractionRepository(seededDb());
  assert.equal(repo.findByCityAndName('洛阳', '龙马石窟')?.nameCn, '龙门石窟');
});

test('城市过滤：郑州没有龙门石窟不误命中', () => {
  const repo = new AttractionRepository(seededDb());
  assert.equal(repo.findByCityAndName('郑州', '龙门石窟'), null);
});

test('城市名归一：带「市」后缀也能命中', () => {
  const repo = new AttractionRepository(seededDb());
  assert.ok(repo.findByCityAndName('洛阳市', '白马寺'));
});

test('无城市时全局唯一名才收，跨城同名判歧义', () => {
  const repo = new AttractionRepository(seededDb());
  assert.equal(repo.findByCityAndName('', '少林寺')?.city, '郑州');
  assert.equal(repo.findByCityAndName('', '关帝庙'), null);
});

test('归一化为空或库缺失返回 null', () => {
  assert.equal(new AttractionRepository(seededDb()).findByCityAndName('洛阳', '  '), null);
  const repo = new AttractionRepository(null);
  assert.equal(repo.findByCityAndName('洛阳', '龙门石窟'), null);
  assert.equal(repo.count(), 0);
});

test('count 统计条目数', () => {
  assert.equal(new AttractionRepository(seededDb()).count(), 6);
});

test('openAttractionDatabase：文件不存在返回 null，存在则打开', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-repo-'));
  const file = path.join(dir, 'attractions.db');
  assert.equal(openAttractionDatabase(file), null);
  const writable = createAttractionsDb(file);
  writable.close();
  const db = openAttractionDatabase(file);
  assert.ok(db);
  assert.equal(new AttractionRepository(db).count(), 0);
  db.close();
});
