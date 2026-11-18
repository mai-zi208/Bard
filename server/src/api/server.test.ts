import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CatalogService } from '../domain/services/catalog-service.ts';
import type { TaskService } from '../domain/services/task-service.ts';
import type { RoutePlanner } from '../domain/ports.ts';
import { buildServer } from './server.ts';

test('/health 暴露发布目录可读性、磁盘剩余与队列长度', async () => {
  const cdnDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-health-'));
  const app = await buildServer({
    cdnDir,
    catalog: { listPacks: () => [], listSources: () => [] } as unknown as CatalogService,
    tasks: { queueLength: () => 3 } as unknown as TaskService,
    planner: { plan: async () => ({ tags: [], persona: '', stops: [] }) } as unknown as RoutePlanner
  });

  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);

  const body = res.json();
  assert.equal(body.packs, 0);
  assert.equal(body.cdnReadable, true);
  assert.ok(body.diskFree === null || typeof body.diskFree === 'number');
  assert.equal(body.queueLength, 3);

  await app.close();
  fs.rmSync(cdnDir, { recursive: true, force: true });
});
