import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { SubmitLimiter } from '../../domain/services/submit-limiter.ts';
import type { TaskService } from '../../domain/services/task-service.ts';
import { registerTaskRoutes } from './tasks.ts';

/** 只验证鉴权与限流，不触发生成流水线 */
function fakeTasks(calls?: { topic: string; persona: string }[]): TaskService {
  return {
    submit: (topic: string, persona = '') => {
      if (calls) calls.push({ topic, persona });
      return { ok: true, taskId: 't1' };
    },
    view: () => null,
    metrics: () => ({
      generatedAt: 0,
      total: 0,
      byStatus: {},
      active: 0,
      stages: [],
      failures: [],
      recentFailures: []
    })
  } as unknown as TaskService;
}

async function makeApp(
  apiToken: string,
  perMinute: number,
  calls?: { topic: string; persona: string }[]
) {
  const app = Fastify();
  registerTaskRoutes(app, fakeTasks(calls), {
    apiToken,
    limiter: new SubmitLimiter(perMinute)
  });
  return app;
}

test('设置令牌后缺少或错误令牌返回 401', async () => {
  const app = await makeApp('secret', 10);

  const missing = await app.inject({ method: 'POST', url: '/tasks', payload: { topic: '白马寺' } });
  assert.equal(missing.statusCode, 401);

  const wrong = await app.inject({
    method: 'POST',
    url: '/tasks',
    headers: { 'x-api-token': 'nope' },
    payload: { topic: '白马寺' }
  });
  assert.equal(wrong.statusCode, 401);

  const ok = await app.inject({
    method: 'POST',
    url: '/tasks',
    headers: { 'x-api-token': 'secret' },
    payload: { topic: '白马寺' }
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().taskId, 't1');
});

test('未设置令牌时不校验请求头', async () => {
  const app = await makeApp('', 10);
  const res = await app.inject({ method: 'POST', url: '/tasks', payload: { topic: '白马寺' } });
  assert.equal(res.statusCode, 200);
});

test('同一来源超过每分钟上限返回 429', async () => {
  const app = await makeApp('', 2);
  const send = () => app.inject({ method: 'POST', url: '/tasks', payload: { topic: '白马寺' } });

  assert.equal((await send()).statusCode, 200);
  assert.equal((await send()).statusCode, 200);
  assert.equal((await send()).statusCode, 429);
});

test('空主题返回 400', async () => {
  const app = await makeApp('', 10);
  const res = await app.inject({ method: 'POST', url: '/tasks', payload: { topic: '  ' } });
  assert.equal(res.statusCode, 400);
});

test('主题未通过安全检测时返回 400', async () => {
  const app = await makeApp('', 10);
  const res = await app.inject({ method: 'POST', url: '/tasks', payload: { topic: '洛阳赌博场所' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /不适宜/);
});

test('人物身份不合法时返回 400', async () => {
  const app = await makeApp('', 10);
  const res = await app.inject({
    method: 'POST',
    url: '/tasks',
    payload: { topic: '白马寺', persona: '武' }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /人物身份/);
});

test('人物身份随主题一起提交', async () => {
  const calls: { topic: string; persona: string }[] = [];
  const app = await makeApp('', 10, calls);
  const res = await app.inject({
    method: 'POST',
    url: '/tasks',
    payload: { topic: '白马寺', persona: '武则天' }
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [{ topic: '白马寺', persona: '武则天' }]);
});

test('/metrics 受令牌保护并可返回统计', async () => {
  const app = await makeApp('secret', 10);

  const missing = await app.inject({ method: 'GET', url: '/metrics' });
  assert.equal(missing.statusCode, 401);

  const ok = await app.inject({ method: 'GET', url: '/metrics', headers: { 'x-api-token': 'secret' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().total, 0);
});
