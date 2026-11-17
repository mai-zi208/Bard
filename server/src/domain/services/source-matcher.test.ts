import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPublished, matchSource, matchVariant, normalizeTopic } from './source-matcher.ts';
import type { PublishedPack, SourceEntry } from '../types.ts';

function source(
  id: string,
  title: string,
  masterId = '',
  persona = ''
): SourceEntry {
  return {
    id,
    dir: 'packs-src/' + id,
    title,
    titleNorm: normalizeTopic(title),
    narratorId: '',
    narratorName: persona,
    masterId,
    persona,
    contentMtime: 0
  };
}

function published(id: string, title: string): PublishedPack {
  return {
    id,
    version: 1,
    title,
    subtitle: '',
    summary: '',
    tags: [],
    total: 10,
    narratorName: '',
    cover: 'cover.jpg',
    bytes: 0,
    audioCount: 0,
    files: [],
    publishedAt: 0,
    refreshedAt: 0,
    ttlDays: 0,
    masterId: '',
    persona: '',
    aiGenerated: false
  };
}

test('normalizeTopic 去掉行政区前缀、景区后缀与空白', () => {
  assert.equal(normalizeTopic(' 洛阳市 龙门石窟景区 '), '龙门石窟');
  assert.equal(normalizeTopic('河南省洛阳白马寺风景区'), '白马寺');
  assert.equal(normalizeTopic('LongMen'), 'longmen');
});

test('matchSource 支持归一化精确匹配与包含匹配', () => {
  const sources = [source('longmen', '龙门石窟'), source('baimasi', '洛阳白马寺')];

  assert.equal(matchSource(sources, '洛阳市龙门石窟景区')?.id, 'longmen');
  assert.equal(matchSource(sources, '白马寺')?.id, 'baimasi');
  assert.equal(matchSource(sources, '不存在'), null);
  assert.equal(matchSource(sources, '   '), null);
});

test('母本匹配跳过人物变体，变体按母本 + 讲述人匹配', () => {
  const sources = [
    source('baimasi--wuzetian', '白马寺', 'baimasi', '武则天'),
    source('baimasi', '白马寺'),
    source('baimasi--libai', '白马寺', 'baimasi', '李白')
  ];

  assert.equal(matchSource(sources, '白马寺')?.id, 'baimasi');
  assert.equal(matchVariant(sources, 'baimasi', '武则天')?.id, 'baimasi--wuzetian');
  assert.equal(matchVariant(sources, 'baimasi', '杜甫'), null);
  assert.equal(matchVariant(sources, '', '武则天'), null);
});

test('matchPublished 优先标题精确命中，再退回包含匹配', () => {
  const packs = [published('guanlin', '洛阳关林'), published('mingtang', '洛阳明堂天堂')];

  assert.equal(matchPublished(packs, '洛阳关林')?.id, 'guanlin');
  assert.equal(matchPublished(packs, '关林景区')?.id, 'guanlin');
  assert.equal(matchPublished(packs, '明堂')?.id, 'mingtang');
  assert.equal(matchPublished(packs, '龙门石窟'), null);
});
