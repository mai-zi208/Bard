import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { CatalogService } from '../domain/services/catalog-service.ts';
import type { TaskService } from '../domain/services/task-service.ts';
import type { RoutePlanner } from '../domain/ports.ts';
import { registerCatalogRoutes } from './routes/catalog.ts';
import { registerPlanRoutes } from './routes/plan.ts';
import { registerTaskRoutes, type SubmitGuard } from './routes/tasks.ts';

export interface ServerDeps {
  cdnDir: string;
  catalog: CatalogService;
  tasks: TaskService;
  planner: RoutePlanner;
  submitGuard?: SubmitGuard;
}

/** 发布目录可读：挂载丢失或权限异常时探针能第一时间发现 */
function cdnReadable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** 发布目录所在磁盘剩余字节；取不到时返回 null，不影响 /health 可用性 */
function diskFree(dir: string): number | null {
  try {
    const stat = fs.statfsSync(dir);
    return stat.bavail * stat.bsize;
  } catch {
    return null;
  }
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' }
  });

  await app.register(cors, { origin: true });

  // 静态发布：manifest.json 与资源包文件均按根路径暴露，保持客户端既有契约
  await app.register(fastifyStatic, {
    root: deps.cdnDir,
    prefix: '/',
    cacheControl: false,
    setHeaders(res, filePath) {
      const name = path.basename(filePath);
      if (name === 'manifest.json') {
        res.setHeader('Cache-Control', 'no-store');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=300');
      }
    }
  });

  app.get('/health', async () => ({
    ok: true,
    time: new Date().toISOString(),
    packs: deps.catalog.listPacks().length,
    sources: deps.catalog.listSources().length,
    cdnReadable: cdnReadable(deps.cdnDir),
    diskFree: diskFree(deps.cdnDir),
    queueLength: deps.tasks.queueLength()
  }));

  registerTaskRoutes(app, deps.tasks, deps.submitGuard);
  registerCatalogRoutes(app, deps.catalog);
  registerPlanRoutes(app, deps.planner, deps.submitGuard);

  return app;
}
