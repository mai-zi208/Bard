import test from 'node:test';
import assert from 'node:assert/strict';
import type { GenerationPipeline, TaskPatch, TaskStore } from '../ports.ts';
import type { SourceEntry, TaskKind, TaskRecord } from '../types.ts';
import type { CatalogService } from './catalog-service.ts';
import { TaskService } from './task-service.ts';

const ACTIVE = ['queued', 'running', 'validating'];

class MemoryTaskStore implements TaskStore {
  records: TaskRecord[] = [];
  private seq = 0;

  create(topic: string, persona: string, kind: TaskKind = 'generate'): TaskRecord {
    this.seq += 1;
    const record: TaskRecord = {
      id: 't' + this.seq,
      topic,
      persona,
      kind,
      status: 'queued',
      stage: '',
      progress: 0,
      packId: '',
      error: '',
      reused: false,
      stageLog: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    this.records.push(record);
    return record;
  }

  find(id: string): TaskRecord | null {
    return this.records.find((record) => record.id === id) ?? null;
  }

  findActive(topic: string, persona: string, kind: TaskKind = 'generate'): TaskRecord | null {
    return (
      this.records.find(
        (record) =>
          record.topic === topic &&
          record.persona === persona &&
          record.kind === kind &&
          ACTIVE.includes(record.status)
      ) ?? null
    );
  }

  countActive(): number {
    return this.records.filter((record) => ACTIVE.includes(record.status)).length;
  }

  nextQueued(): TaskRecord | null {
    return this.records.find((record) => record.status === 'queued') ?? null;
  }

  update(id: string, patch: TaskPatch): void {
    const record = this.find(id);
    if (!record) return;
    if (patch.status !== undefined) record.status = patch.status;
    if (patch.stage !== undefined) record.stage = patch.stage;
    if (patch.progress !== undefined) record.progress = patch.progress;
    if (patch.packId !== undefined) record.packId = patch.packId;
    if (patch.error !== undefined) record.error = patch.error;
    if (patch.reused !== undefined) record.reused = patch.reused;
  }

  requeueInterrupted(): void {}

  listRecent(limit: number): TaskRecord[] {
    return this.records.slice(0, limit);
  }
}

function makeService(store: MemoryTaskStore, maxQueue: number): TaskService {
  const catalog = { listPacks: () => [] } as unknown as CatalogService;
  return new TaskService(store, catalog, null, maxQueue);
}

test('同一景物重复提交复用进行中的任务', () => {
  const store = new MemoryTaskStore();
  const service = makeService(store, 8);

  const first = service.submit('洛阳关林', '');
  const second = service.submit('洛阳关林', '');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;

  assert.equal(first.taskId, second.taskId);
  assert.equal(store.records.length, 1);
});

test('讲述人不同不视为重复任务', () => {
  const store = new MemoryTaskStore();
  const service = makeService(store, 8);

  service.submit('洛阳关林', '');
  service.submit('洛阳关林', '武则天');
  assert.equal(store.records.length, 2);
});

test('达到队列上限后拒绝新任务，同名提交复用已有任务', () => {
  const store = new MemoryTaskStore();
  const service = makeService(store, 2);

  assert.equal(service.submit('景点甲', '').ok, true);
  assert.equal(service.submit('景点乙', '').ok, true);

  const rejected = service.submit('景点丙', '');
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.reason, 'queue_full');

  const repeated = service.submit('景点甲', '');
  assert.equal(repeated.ok, true);
  if (repeated.ok) assert.equal(repeated.taskId, 't1');
  assert.equal(store.records.length, 2);
});

test('已有同景点同讲述人的资源包时直接复用，不再生成', async () => {
  const store = new MemoryTaskStore();
  const catalog = {
    listPacks: () => [
      { id: 'baimasi', title: '白马寺', persona: '', narratorName: '', deprecated: false }
    ]
  } as unknown as CatalogService;
  let called = 0;
  const pipeline = {
    run: async () => {
      called += 1;
      return { packId: 'baimasi', title: '白马寺' };
    }
  } as unknown as GenerationPipeline;
  const service = new TaskService(store, catalog, pipeline, 8);

  const res = service.submit('洛阳市白马寺景区', '');
  assert.equal(res.ok, true);
  assert.equal(store.records[0].status, 'done');
  assert.equal(store.records[0].packId, 'baimasi');
  assert.equal(store.records[0].reused, true);

  await runOnce(service);
  assert.equal(called, 0);
});

test('已有同景点同讲述人的人物包时直接复用', () => {
  const store = new MemoryTaskStore();
  const catalog = {
    listPacks: () => [
      {
        id: 'baimasi--wuzetian',
        title: '白马寺',
        persona: '武则天',
        narratorName: '武则天',
        deprecated: false
      }
    ]
  } as unknown as CatalogService;
  const service = new TaskService(store, catalog, null, 8);

  const res = service.submit('白马寺', '武则天');
  assert.equal(res.ok, true);
  assert.equal(store.records[0].status, 'done');
  assert.equal(store.records[0].packId, 'baimasi--wuzetian');
  assert.equal(store.records[0].reused, true);
});

test('已有内置包时直接复用内置包，不调用生成', async () => {
  const store = new MemoryTaskStore();
  const catalog = { listPacks: () => [] } as unknown as CatalogService;
  let called = 0;
  const pipeline = {
    run: async () => {
      called += 1;
      return { packId: 'shaolin-si', title: '少林寺' };
    }
  } as unknown as GenerationPipeline;
  const builtin = {
    list: () => [{ id: 'shaolin', title: '少林寺', narratorName: '' }]
  };
  const service = new TaskService(store, catalog, pipeline, 8, null, true, null, builtin);

  const res = service.submit('洛阳市少林寺景区', '');
  assert.equal(res.ok, true);
  assert.equal(store.records[0].status, 'done');
  assert.equal(store.records[0].packId, 'shaolin');
  assert.equal(store.records[0].reused, true);

  await runOnce(service);
  assert.equal(called, 0);
});

test('内置包与已发布包同名时优先复用内置包', () => {
  const store = new MemoryTaskStore();
  const catalog = {
    listPacks: () => [
      { id: 'shaolin-si', title: '少林寺', persona: '', narratorName: '', deprecated: false }
    ]
  } as unknown as CatalogService;
  const builtin = {
    list: () => [{ id: 'shaolin', title: '少林寺', narratorName: '' }]
  };
  const service = new TaskService(store, catalog, null, 8, null, true, null, builtin);

  const res = service.submit('少林寺', '');
  assert.equal(res.ok, true);
  assert.equal(store.records[0].packId, 'shaolin');
  assert.equal(store.records[0].reused, true);
});

test('内置包只有默认讲述人时，同景点指定人物仍生成', () => {
  const store = new MemoryTaskStore();
  const catalog = { listPacks: () => [] } as unknown as CatalogService;
  const builtin = {
    list: () => [{ id: 'shaolin', title: '少林寺', narratorName: '' }]
  };
  const service = new TaskService(store, catalog, null, 8, null, true, null, builtin);

  const res = service.submit('少林寺', '达摩');
  assert.equal(res.ok, true);
  assert.equal(store.records[0].status, 'queued');
  assert.equal(store.records[0].reused, false);
});

function masterSource(): SourceEntry {
  return {
    id: 'demo',
    dir: '/tmp/demo',
    title: '白马寺',
    titleNorm: '白马寺',
    narratorId: '',
    narratorName: '',
    masterId: '',
    persona: '',
    contentMtime: 10
  };
}

function variantSource(): SourceEntry {
  return {
    ...masterSource(),
    id: 'demo--wuzetian',
    narratorName: '武则天',
    masterId: 'demo',
    persona: '武则天',
    contentMtime: 20
  };
}

async function runOnce(service: TaskService): Promise<void> {
  service.start(5);
  await new Promise((resolve) => setTimeout(resolve, 40));
  service.stop();
}

test('同母本同人物重新生成时覆盖同一变体包', async () => {
  const store = new MemoryTaskStore();
  const master = masterSource();
  const variant = variantSource();
  const catalog = {
    findSource: () => master,
    findVariant: (masterId: string, persona: string) =>
      masterId === 'demo' && persona === '武则天' ? variant : null,
    isSourceStale: () => false,
    isVariantStale: () => false,
    listPacks: () => [],
    findPublishedById: () => null,
    reindex: () => {}
  } as unknown as CatalogService;

  const calls: { persona: string; masterId: string }[] = [];
  const pipeline = {
    run: async (input: { persona: string; variant?: { masterId: string } }) => {
      calls.push({
        persona: input.persona,
        masterId: input.variant?.masterId ?? ''
      });
      return { packId: 'demo--wuzetian', title: '白马寺' };
    }
  } as unknown as GenerationPipeline;

  const service = new TaskService(store, catalog, pipeline, 8);

  service.submit('白马寺', '武则天');
  await runOnce(service);

  assert.deepEqual(calls, [{ persona: '武则天', masterId: 'demo' }]);
  assert.equal(store.records[0].status, 'done');
  assert.equal(store.records[0].packId, 'demo--wuzetian');
  assert.equal(store.records[0].reused, false);
});

test('变体源缺失时以母本为底稿生成人物变体', async () => {
  const store = new MemoryTaskStore();
  const master = masterSource();
  const catalog = {
    findSource: () => master,
    findVariant: () => null,
    isSourceStale: () => false,
    isVariantStale: () => false,
    listPacks: () => [],
    findPublishedById: () => null,
    reindex: () => {}
  } as unknown as CatalogService;

  const calls: { persona: string; masterId: string }[] = [];
  const pipeline = {
    run: async (
      input: { persona: string; variant?: { masterId: string } }
    ) => {
      calls.push({
        persona: input.persona,
        masterId: input.variant?.masterId ?? ''
      });
      return { packId: 'demo--wuzetian', title: '白马寺' };
    }
  } as unknown as GenerationPipeline;

  const service = new TaskService(store, catalog, pipeline, 8);

  service.submit('白马寺', '武则天');
  await runOnce(service);

  assert.deepEqual(calls, [{ persona: '武则天', masterId: 'demo' }]);
  assert.equal(store.records[0].packId, 'demo--wuzetian');
  assert.equal(store.records[0].status, 'done');
});

test('生成成功后清理同景点同讲述人的旧重复包', async () => {
  const store = new MemoryTaskStore();
  const master = masterSource();
  const removed: string[] = [];
  // 提交时没有同名包（不会被去重），生成期间扫描出历史重复包
  let packs: unknown[] = [];
  const catalog = {
    findSource: () => master,
    findVariant: () => null,
    isSourceStale: () => false,
    isVariantStale: () => false,
    listPacks: () => packs,
    findPublishedById: () => null,
    reindex: () => {}
  } as unknown as CatalogService;
  const pipeline = {
    run: async () => {
      packs = [
        { id: 'demo', title: '白马寺', persona: '', narratorName: '' },
        { id: 'demo--wuzetian', title: '白马寺', persona: '武则天', narratorName: '武则天' },
        { id: 'other', title: '龙门石窟', persona: '', narratorName: '' }
      ];
      return { packId: 'demo-2', title: '白马寺' };
    }
  } as unknown as GenerationPipeline;

  const service = new TaskService(store, catalog, pipeline, 8, null, true, {
    remove: (id: string) => removed.push(id)
  });

  service.submit('白马寺', '');
  await runOnce(service);

  assert.deepEqual(removed, ['demo']);
  assert.equal(store.records[0].packId, 'demo-2');
  assert.equal(store.records[0].status, 'done');
});
