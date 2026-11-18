import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TaskRecord } from '../domain/types.ts';
import { aggregateGenerateTasks, diffList, flattenList, loadHotList, parseArgs } from './hot-common.ts';

function record(partial: Partial<TaskRecord>): TaskRecord {
  return {
    id: 't1',
    topic: '',
    persona: '',
    kind: 'generate',
    status: 'done',
    stage: '',
    progress: 100,
    packId: '',
    error: '',
    reused: false,
    stageLog: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...partial
  };
}

test('parseArgs 支持 --key value / --key=value / --flag', () => {
  const args = parseArgs(['--url', 'http://a:1', '--top=5', '--dry-run']);
  assert.equal(args.get('url'), 'http://a:1');
  assert.equal(args.get('top'), '5');
  assert.equal(args.get('dry-run'), true);
  assert.throws(() => parseArgs(['位置参数']));
});

test('loadHotList 校验结构并在报错中带文件路径', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-'));
  const good = path.join(dir, 'good.json');
  fs.writeFileSync(good, JSON.stringify({ updated: '2026-11-18', cities: [{ city: '洛阳', topics: ['龙门石窟'] }] }));
  const list = loadHotList(good);
  assert.equal(list.cities[0].city, '洛阳');

  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ cities: [{ city: '洛阳', topics: ['  '] }] }));
  assert.throws(() => loadHotList(bad), (err: Error) => err.message.includes(bad));
  assert.throws(() => loadHotList(path.join(dir, 'missing.json')), (err: Error) => err.message.includes('不存在'));
});

test('flattenList 展开并按归一名去重', () => {
  const items = flattenList({
    updated: '',
    cities: [
      { city: '洛阳', topics: ['龙门石窟', '洛阳市龙门石窟景区'] },
      { city: '郑州', topics: ['少林寺'] }
    ]
  });
  assert.deepEqual(items.map((i) => i.topic), ['龙门石窟', '少林寺']);
});

test('aggregateGenerateTasks 只计 generate、按归一名合并、count 降序', () => {
  const stats = aggregateGenerateTasks([
    record({ topic: '洛阳市龙门石窟景区', status: 'done', reused: true, createdAt: 3000 }),
    record({ topic: '龙门石窟', status: 'failed', createdAt: 2000 }),
    record({ topic: '少林寺', createdAt: 1000 }),
    record({ topic: '龙门石窟', kind: 'refresh', createdAt: 4000 })
  ]);
  assert.equal(stats.length, 2);
  const longmen = stats[0];
  assert.equal(longmen.key, '龙门石窟');
  assert.equal(longmen.count, 2);
  assert.equal(longmen.done, 1);
  assert.equal(longmen.failed, 1);
  assert.equal(longmen.reused, 1);
  assert.equal(longmen.lastSubmittedAt, 3000);
  assert.deepEqual(longmen.names, ['洛阳市龙门石窟景区', '龙门石窟']);
});

test('diffList 输出清单零提交与高频未入清单两段差异', () => {
  const list = { updated: '', cities: [{ city: '洛阳', topics: ['龙门石窟', '应天门'] }] };
  const stats = aggregateGenerateTasks([
    record({ topic: '龙门石窟' }),
    record({ topic: '少林寺' }),
    record({ topic: '少林寺' }),
    record({ topic: '少林寺' })
  ]);
  const diff = diffList(list, stats, 3);
  assert.deepEqual(diff.listedButNoSubmit, ['应天门']);
  assert.deepEqual(diff.hotButUnlisted.map((s) => s.key), ['少林寺']);
});
