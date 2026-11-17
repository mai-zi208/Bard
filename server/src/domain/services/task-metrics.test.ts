import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskRecord } from '../types.ts';
import { buildTaskMetrics } from './task-metrics.ts';

function makeTask(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    id: 't1',
    topic: '洛阳关林',
    persona: '',
    kind: 'generate',
    status: 'done',
    stage: '完成',
    progress: 100,
    packId: 'guanlin',
    error: '',
    reused: false,
    stageLog: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  };
}

test('阶段耗时按相邻打点计算，最后阶段以 updatedAt 收尾', () => {
  const task = makeTask({
    stageLog: [
      { stage: '检索资料', at: 1000 },
      { stage: '撰写文稿', at: 4000 },
      { stage: '完成', at: 10000 }
    ],
    updatedAt: 10000
  });

  const metrics = buildTaskMetrics([task], 20000);
  const byStage = Object.fromEntries(metrics.stages.map((item) => [item.stage, item]));

  assert.equal(byStage['检索资料'].avgMs, 3000);
  assert.equal(byStage['撰写文稿'].avgMs, 6000);
  assert.equal(byStage['完成'].avgMs, 0);
  assert.equal(metrics.stages[0].stage, '撰写文稿');
});

test('进行中的当前阶段不计入耗时', () => {
  const task = makeTask({
    status: 'running',
    stage: '获取真实配图',
    updatedAt: 9000,
    stageLog: [
      { stage: '检索资料', at: 1000 },
      { stage: '获取真实配图', at: 4000 }
    ]
  });

  const metrics = buildTaskMetrics([task], 60000);
  assert.deepEqual(metrics.stages, [{ stage: '检索资料', count: 1, avgMs: 3000, maxMs: 3000 }]);
  assert.equal(metrics.active, 1);
});

test('失败按阶段与错误聚合，最近失败按时间倒序', () => {
  const failedA = makeTask({
    id: 'a',
    topic: '白马寺',
    status: 'failed',
    stage: '失败',
    error: '未配置生成服务（缺少 LLM_API_KEY）',
    updatedAt: 5000,
    stageLog: [
      { stage: '匹配生成源', at: 1000 },
      { stage: '失败', at: 5000 }
    ]
  });
  const failedB = makeTask({ ...failedA, id: 'b', topic: '龙门石窟', updatedAt: 8000 });
  const done = makeTask({ id: 'c' });

  const metrics = buildTaskMetrics([failedA, failedB, done], 10000);

  assert.equal(metrics.failures.length, 1);
  assert.equal(metrics.failures[0].stage, '匹配生成源');
  assert.equal(metrics.failures[0].count, 2);
  assert.equal(metrics.failures[0].lastAt, 8000);
  assert.deepEqual(
    metrics.recentFailures.map((item) => item.id),
    ['b', 'a']
  );
  assert.equal(metrics.byStatus.done, 1);
  assert.equal(metrics.byStatus.failed, 2);
});

test('复用率按窗口内 reused 任务占比计算', () => {
  const tasks = [
    makeTask({ id: 'a', reused: true }),
    makeTask({ id: 'b', reused: true }),
    makeTask({ id: 'c' }),
    makeTask({ id: 'd', status: 'failed', error: '装配失败' })
  ];

  const metrics = buildTaskMetrics(tasks, 0);

  assert.equal(metrics.reused, 2);
  assert.equal(metrics.reuseRate, 0.5);
});
