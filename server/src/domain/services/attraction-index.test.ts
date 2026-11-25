import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editDistance, normalizeName, suggestAttractions } from './attraction-index.ts';

// 用临时 fixture + 环境变量注入候选集，避免依赖 1MB 级真实数据文件
const fixtureFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'attractions-test-')), 'fixture.json');
fs.writeFileSync(
  fixtureFile,
  JSON.stringify([
    { name: '龙门石窟', city: '洛阳' },
    { name: '白马寺', city: '洛阳' },
    { name: '少林寺', city: '郑州' },
    { name: '云台山', city: '焦作' },
    { name: '老君山', city: '洛阳' }
  ]),
  'utf8'
);
process.env.NATIONAL_ATTRACTIONS_FILE = fixtureFile;

test('归一化与小程序端 naming.js 一致：去空白、行政区前缀与景区后缀', () => {
  assert.equal(normalizeName(' 河南省洛阳市龙门石窟风景区 '), '龙门石窟');
  assert.equal(normalizeName('洛阳老君山景区'), '老君山');
  assert.equal(normalizeName('龙门石窟'), '龙门石窟');
  assert.equal(normalizeName(''), '');
  assert.equal(editDistance('龙马石窟', '龙门石窟'), 1);
  assert.equal(editDistance('', 'abc'), 3);
});

test('错别字「龙马石窟」建议出「龙门石窟」', () => {
  const suggestions = suggestAttractions('龙马石窟');
  assert.ok(suggestions.length > 0);
  assert.equal(suggestions[0].name, '龙门石窟');
  assert.equal(suggestions[0].city, '洛阳');
});

test('完全相同的候选名也返回，用于提示正确写法', () => {
  const suggestions = suggestAttractions('龙门石窟');
  assert.deepEqual(suggestions, [{ name: '龙门石窟', city: '洛阳' }]);
});

test('超出编辑距离阈值不误报', () => {
  assert.deepEqual(suggestAttractions('关林庙'), []);
  assert.deepEqual(suggestAttractions('天涯海角'), []);
});

test('包含关系命中：输入截短「龙门」也能建议「龙门石窟」', () => {
  const suggestions = suggestAttractions('龙门');
  assert.equal(suggestions[0].name, '龙门石窟');
});

test('输入归一化为空时返回空数组', () => {
  assert.deepEqual(suggestAttractions('  '), []);
  assert.deepEqual(suggestAttractions('洛阳景区'), []);
});
