import type { FastifyInstance } from 'fastify';
import type { SubmitGuard } from './tasks.ts';
import type { RoutePlanner } from '../../domain/ports.ts';

/** 一句话愿望的长度上限：超出截断，防止把长文塞进提示词 */
const TEXT_MAX = 60;

/** 客户端契约：POST /plan（一句话旅行愿望 → 标签 + 顺路景点坐标） */
export function registerPlanRoutes(
  app: FastifyInstance,
  planner: RoutePlanner,
  guard?: SubmitGuard
): void {
  app.post('/plan', async (request, reply) => {
    if (guard) {
      if (guard.apiToken && request.headers['x-api-token'] !== guard.apiToken) {
        return reply.code(401).send({ error: '缺少或错误的提交令牌' });
      }
      if (!guard.limiter.allow(request.ip)) {
        return reply.code(429).send({ error: '请求过于频繁，请稍后再试' });
      }
    }

    const body = (request.body ?? {}) as { text?: unknown };
    const wish = String(body.text ?? '').trim();

    if (!wish) {
      return reply.code(400).send({ error: 'text required' });
    }

    try {
      const plan = await planner.plan(wish.slice(0, TEXT_MAX));
      request.log.info({ wish, stops: plan.stops.length }, '行程规划完成');
      return plan;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      request.log.warn({ wish, reason: message }, '行程规划失败');
      return reply.code(502).send({ error: message || '行程规划失败，请稍后再试' });
    }
  });
}
