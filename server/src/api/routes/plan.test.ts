import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { SubmitLimiter } from '../../domain/services/submit-limiter.ts';
import type { PlanResult, RoutePlanner } from '../../domain/ports.ts';
import { parsePlan } from '../../infra/providers/plan-provider.ts';
import { registerPlanRoutes } from './plan.ts';

const PLAN: PlanResult = {
  tags: ['2 天', '洛阳', '人文古迹', '节奏舒缓'],
  city: '洛阳',
  persona: '',
  stops: [
    { name: '白马寺', lat: 34.7216, lng: 112.6021 },
    { name: '洛阳博物馆', lat: 34.6457, lng: 112.4525 },
    { name: '龙门石窟', lat: 34.5594, lng: 112.4678 }
  ]
};

function fakePlanner(result: PlanResult, calls: string[]): RoutePlanner {
  return {
    plan: async (wish: string) => {
      calls.push(wish);
      return result;
    }
  };
}

function failingPlanner(message: string): RoutePlanner {
  return {
    plan: async () => {
      throw new Error(message);
    }
  };
}

async function makeApp(planner: RoutePlanner, apiToken = '', perMinute = 10) {
  const app = Fastify();
  registerPlanRoutes(app, planner, { apiToken, limiter: new SubmitLimiter(perMinute) });
  return app;
}

test('一句话愿望返回标签与顺路景点', async () => {
  const calls: string[] = [];
  const app = await makeApp(fakePlanner(PLAN, calls));

  const res = await app.inject({ method: 'POST', url: '/plan', payload: { text: ' 想周末去洛阳看古迹 ' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), PLAN);
  assert.deepEqual(calls, ['想周末去洛阳看古迹']);

  await app.close();
});

test('愿望超过 60 字时截断后交给规划器', async () => {
  const calls: string[] = [];
  const app = await makeApp(fakePlanner(PLAN, calls));

  const res = await app.inject({ method: 'POST', url: '/plan', payload: { text: '洛'.repeat(80) } });
  assert.equal(res.statusCode, 200);
  assert.equal(calls[0].length, 60);

  await app.close();
});

test('空愿望返回 400', async () => {
  const app = await makeApp(fakePlanner(PLAN, []));

  const blank = await app.inject({ method: 'POST', url: '/plan', payload: { text: '   ' } });
  assert.equal(blank.statusCode, 400);
  assert.equal(blank.json().error, 'text required');

  const missing = await app.inject({ method: 'POST', url: '/plan', payload: {} });
  assert.equal(missing.statusCode, 400);

  await app.close();
});

test('模型返回非法 JSON 时返回 5xx 并带原因', async () => {
  const app = await makeApp(failingPlanner('行程规划失败：模型返回的不是合法 JSON'));

  const res = await app.inject({ method: 'POST', url: '/plan', payload: { text: '去洛阳玩两天' } });
  assert.equal(res.statusCode, 502);
  assert.match(res.json().error, /不是合法 JSON/);

  await app.close();
});

test('设置令牌后缺少或错误令牌返回 401', async () => {
  const app = await makeApp(fakePlanner(PLAN, []), 'secret');

  const missing = await app.inject({ method: 'POST', url: '/plan', payload: { text: '去洛阳' } });
  assert.equal(missing.statusCode, 401);

  const ok = await app.inject({
    method: 'POST',
    url: '/plan',
    headers: { 'x-api-token': 'secret' },
    payload: { text: '去洛阳' }
  });
  assert.equal(ok.statusCode, 200);

  await app.close();
});

test('parsePlan 剥掉 Markdown 围栏并收下合法输出', () => {
  const content = '```json\n' + JSON.stringify(PLAN) + '\n```';
  assert.deepEqual(parsePlan(content), PLAN);
});

test('parsePlan 按名去重并压进 3–6 站', () => {
  const stops = Array.from({ length: 8 }, (_, i) => ({
    name: '景点' + (i % 6),
    lat: 34.6 + i * 0.01,
    lng: 112.4 + i * 0.01
  }));
  const result = parsePlan(JSON.stringify({ tags: ['a', 'b', 'c', 'd', 'e'], stops }));
  assert.equal(result.stops.length, 6);
  assert.equal(new Set(result.stops.map((stop) => stop.name)).size, 6);
  assert.equal(result.tags.length, 4);
});

test('parsePlan 提取讲述人，未指定时为空串', () => {
  const three = [
    { name: '白马寺', lat: 34.7216, lng: 112.6021 },
    { name: '龙门石窟', lat: 34.5594, lng: 112.4678 },
    { name: '关林', lat: 34.6056, lng: 112.4935 }
  ];
  const withPersona = parsePlan(JSON.stringify({ tags: ['洛阳'], persona: ' 武则天 ', stops: three }));
  assert.equal(withPersona.persona, '武则天');
  const without = parsePlan(JSON.stringify({ tags: ['洛阳'], stops: three }));
  assert.equal(without.persona, '');
});

test('parsePlan 提取城市裸名，剥省市后缀、缺省为空串', () => {
  const three = [
    { name: '白马寺', lat: 34.7216, lng: 112.6021 },
    { name: '龙门石窟', lat: 34.5594, lng: 112.4678 },
    { name: '关林', lat: 34.6056, lng: 112.4935 }
  ];
  assert.equal(parsePlan(JSON.stringify({ city: '洛阳市', stops: three })).city, '洛阳');
  assert.equal(parsePlan(JSON.stringify({ city: ' 洛阳 ', stops: three })).city, '洛阳');
  assert.equal(parsePlan(JSON.stringify({ stops: three })).city, '');
});

test('parsePlan 丢弃坐标越界或名称为空的景点', () => {
  const pool = {
    tags: ['洛阳'],
    stops: [
      { name: '白马寺', lat: 34.7216, lng: 112.6021 },
      { name: '坏纬度', lat: 900, lng: 112.4 },
      { name: '', lat: 34.7, lng: 112.4 },
      { name: '坏经度', lat: 34.7, lng: 7 },
      { name: '龙门石窟', lat: 34.5594, lng: 112.4678 },
      { name: '关林', lat: 34.6056, lng: 112.4935 }
    ]
  };
  const result = parsePlan(JSON.stringify(pool));
  assert.deepEqual(
    result.stops.map((stop) => stop.name),
    ['白马寺', '龙门石窟', '关林']
  );
});

test('parsePlan 对非 JSON 与零景点抛错，单景点愿望收下 1 站', () => {
  assert.throws(() => parsePlan('抱歉，我无法规划'), /不是合法 JSON/);
  assert.throws(() => parsePlan(JSON.stringify({ tags: ['洛阳'], stops: [] })), /可用景点不足/);
  const single = parsePlan(
    JSON.stringify({ tags: ['洛阳'], stops: [{ name: '白马寺', lat: 34.7, lng: 112.6 }] })
  );
  assert.equal(single.stops.length, 1);
});
