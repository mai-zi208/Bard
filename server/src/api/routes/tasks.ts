import type { FastifyInstance } from 'fastify';
import type { SubmitLimiter } from '../../domain/services/submit-limiter.ts';
import type { TaskService } from '../../domain/services/task-service.ts';
import { guardPersona, guardTopic } from '../../domain/services/topic-guard.ts';

export interface SubmitGuard {
  /** 非空时校验 x-api-token 请求头 */
  apiToken: string;
  limiter: SubmitLimiter;
}

/** 客户端契约：POST /tasks、GET /tasks/{id}（见技术方案 13.6） */
export function registerTaskRoutes(
  app: FastifyInstance,
  tasks: TaskService,
  guard?: SubmitGuard
): void {
  app.post('/tasks', async (request, reply) => {
    if (guard) {
      if (guard.apiToken && request.headers['x-api-token'] !== guard.apiToken) {
        return reply.code(401).send({ error: '缺少或错误的提交令牌' });
      }
      if (!guard.limiter.allow(request.ip)) {
        return reply.code(429).send({ error: '提交过于频繁，请稍后再试' });
      }
    }

    const body = (request.body ?? {}) as { topic?: unknown; persona?: unknown };
    const topic = String(body.topic ?? '').trim();

    if (!topic) {
      return reply.code(400).send({ error: 'topic required' });
    }

    const verdict = guardTopic(topic);
    if (!verdict.ok) {
      return reply.code(400).send({ error: verdict.reason });
    }

    const persona = String(body.persona ?? '').trim();
    const personaVerdict = guardPersona(persona);
    if (!personaVerdict.ok) {
      return reply.code(400).send({ error: personaVerdict.reason });
    }

    const result = tasks.submit(topic, persona);
    if (!result.ok) {
      return reply.code(429).send({ error: '生成队列已满，请稍后再试' });
    }

    request.log.info({ taskId: result.taskId, topic }, '创建生成任务');
    return { taskId: result.taskId };
  });

  app.get('/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const view = tasks.view(id);

    if (!view) {
      return reply.code(404).send({ error: 'task not found' });
    }

    return view;
  });

  /** 运维视图：最近任务的状态分布、阶段耗时与失败分布 */
  app.get('/metrics', async (request, reply) => {
    if (guard && guard.apiToken && request.headers['x-api-token'] !== guard.apiToken) {
      return reply.code(401).send({ error: '缺少或错误的提交令牌' });
    }

    return tasks.metrics();
  });
}
