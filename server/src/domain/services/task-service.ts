import type {
  BuiltinPackPort,
  GeneratedPack,
  GenerationPipeline,
  PackCleanupPort,
  RefreshCooldownStore,
  TaskPatch,
  TaskStore
} from '../ports.ts';
import type { TaskKeyOverrides, TaskRecord, TaskView } from '../types.ts';
import type { CatalogService } from './catalog-service.ts';
import { DAY_MS } from './pack-freshness.ts';
import { normalizePersona } from './persona.ts';
import { normalizeTopic } from './source-matcher.ts';
import { buildTaskMetrics, type TaskMetrics } from './task-metrics.ts';

export type SubmitResult = { ok: true; taskId: string } | { ok: false; reason: 'queue_full' };

/** 刷新冷却的运行参数 */
export interface RefreshRuntime {
  cooldownDays: number;
  cooldowns: RefreshCooldownStore;
}

/**
 * 任务服务：单工作者串行处理队列。
 * 同一景点 + 同一讲述人（含无人物）在提交时去重：
 * 已有内置包或已发布包直接复用，有同名任务在排队/生成则复用同一任务，不重复生成；
 * 历史上带后缀的同名重复包在生成成功后清理。
 */
export class TaskService {
  private readonly tasks: TaskStore;
  private readonly catalog: CatalogService;
  private readonly pipeline: GenerationPipeline | null;
  private readonly maxQueue: number;
  private readonly refresh: RefreshRuntime | null;
  /** 后台配音补齐开关：关闭后不再入队新任务，已排的补齐任务直接标记失败 */
  private readonly audioTopUp: boolean;
  /** 清理同景点同讲述人的历史重复包；未注入时跳过 */
  private readonly cleanup: PackCleanupPort | null;
  /** 小程序内置包清单：随客户端发布、不在 cdn/ 索引里，去重时也要认 */
  private readonly builtin: BuiltinPackPort | null;
  /** 按任务密钥覆盖构建流水线：用户自带 key 时优先用它，未注入则只用默认流水线 */
  private readonly pipelineFactory: ((overrides?: TaskKeyOverrides) => GenerationPipeline | null) | null;
  /** 任务 id → 客户端自带密钥；仅存内存，进程重启后回退服务端配置 */
  private readonly keyOverrides = new Map<string, TaskKeyOverrides>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    tasks: TaskStore,
    catalog: CatalogService,
    pipeline: GenerationPipeline | null,
    maxQueue = 8,
    refresh: RefreshRuntime | null = null,
    audioTopUp = true,
    cleanup: PackCleanupPort | null = null,
    builtin: BuiltinPackPort | null = null,
    pipelineFactory: ((overrides?: TaskKeyOverrides) => GenerationPipeline | null) | null = null
  ) {
    this.tasks = tasks;
    this.catalog = catalog;
    this.pipeline = pipeline;
    this.maxQueue = maxQueue;
    this.refresh = refresh;
    this.audioTopUp = audioTopUp;
    this.cleanup = cleanup;
    this.builtin = builtin;
    this.pipelineFactory = pipelineFactory;
  }

  start(intervalMs = 800): void {
    if (this.timer) return;
    this.tasks.requeueInterrupted();
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  submit(topic: string, persona = '', city = '', keys?: TaskKeyOverrides): SubmitResult {
    // 「导游」与空串同义：都产出母本
    const name = normalizePersona(persona);

    // 同一景点 + 同一讲述人已有任务在排队/生成：复用该任务，不重复排队
    const active = this.tasks.findActive(topic, name, 'generate');
    if (active) return { ok: true, taskId: active.id };

    // 已有同景点同讲述人的资源包：直接复用，不再重复生成
    const existing = this.findExisting(topic, name);
    if (existing) {
      const task = this.tasks.create(topic, name, 'generate', city);
      this.tasks.update(task.id, {
        status: 'done',
        stage: '已存在',
        progress: 100,
        packId: existing.id,
        reused: true
      });
      return { ok: true, taskId: task.id };
    }

    if (this.maxQueue > 0 && this.tasks.countActive() >= this.maxQueue) {
      return { ok: false, reason: 'queue_full' };
    }

    const task = this.tasks.create(topic, name, 'generate', city);
    if (keys && (keys.llm || keys.image || keys.tts)) {
      this.keyOverrides.set(task.id, keys);
    }
    return { ok: true, taskId: task.id };
  }

  /** 该任务实际使用的流水线：带客户端密钥时用工厂单独构建，否则用服务端默认流水线 */
  private pipelineFor(task: TaskRecord): GenerationPipeline | null {
    return this.pipelineById(task.id);
  }

  /** 同景点 + 同讲述人已存在：内置包优先，其次已发布包；软下架的包不参与复用 */
  private findExisting(topic: string, persona: string): { id: string } | null {
    const title = normalizeTopic(topic);
    if (!title) return null;

    // 内置包随小程序发布，不在 cdn/ 索引里；同景点同讲述人时优先复用内置包
    const builtin = (this.builtin?.list() ?? []).find(
      (item) =>
        normalizeTopic(item.title) === title &&
        normalizePersona(item.narratorName) === persona
    );
    if (builtin) return builtin;

    return (
      this.catalog
        .listPacks()
        .find(
          (item) =>
            !item.deprecated &&
            normalizeTopic(item.title) === title &&
            normalizePersona(item.persona || item.narratorName || '') === persona
        ) ?? null
    );
  }

  view(id: string): TaskView | null {
    const task = this.tasks.find(id);
    if (!task) return null;
    return {
      status: task.status,
      stage: task.stage,
      progress: task.progress,
      packId: task.packId,
      error: task.error
    };
  }

  /** 进行中与排队中的任务数，供 /health 观察队列积压 */
  queueLength(): number {
    return this.tasks.countActive();
  }

  /** 最近 200 条任务的阶段耗时与失败分布，供运维排查 */
  metrics(): TaskMetrics {
    return buildTaskMetrics(this.tasks.listRecent(200));
  }

  private async tick(): Promise<void> {
    if (this.busy) return;

    const task = this.tasks.nextQueued();
    if (!task) return;

    this.busy = true;
    try {
      await this.process(task);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.fail(task, message);
    } finally {
      // 任务终态后释放内存里的自带密钥（补齐配音任务已在队列时复制过）
      this.keyOverrides.delete(task.id);
      this.busy = false;
    }
  }

  private async process(task: TaskRecord): Promise<void> {
    if (task.kind === 'refresh') {
      await this.processRefresh(task);
      return;
    }
    if (task.kind === 'audio') {
      await this.processAudio(task);
      return;
    }

    this.tasks.update(task.id, { status: 'running', stage: '匹配生成源', progress: 5 });

    const persona = normalizePersona(task.persona);
    if (!persona) {
      await this.processMaster(task);
      return;
    }
    await this.processVariant(task, persona);
  }

  /** 母本：现代导游讲述；提交阶段已去重，走到这里说明需要新建或重建 */
  private async processMaster(task: TaskRecord): Promise<void> {
    const pipeline = this.pipelineFor(task);
    if (!pipeline) {
      this.fail(task, '未配置生成服务（缺少 LLM_API_KEY）');
      return;
    }

    const generated = await pipeline.run(
      { topic: task.topic, persona: '', city: task.city },
      {
        report: (progress, stage) => {
          this.tasks.update(task.id, { status: 'running', stage, progress });
        }
      }
    );

    this.tasks.update(task.id, { status: 'validating', stage: '刷新清单', progress: 96 });
    this.catalog.reindex();
    this.purgeDuplicates(generated, '');
    this.finish(task, generated.packId, false);
    this.queueAudioTopUp(generated, task.topic, '', task.id);
  }

  /** 人物变体：母本作为素材底稿；提交阶段已去重，走到这里说明需要新建或重建 */
  private async processVariant(task: TaskRecord, persona: string): Promise<void> {
    this.tasks.update(task.id, { status: 'running', stage: '匹配母本', progress: 5 });
    let master = this.catalog.findSource(task.topic);
    const pipeline = this.pipelineFor(task);
    let masterPendingAudio = false;

    if (!master) {
      if (!pipeline) {
        this.fail(task, '未配置生成服务（缺少 LLM_API_KEY）');
        return;
      }
      // 没有母本时先生成母本，再由母本改写人物变体
      const generatedMaster = await pipeline.run(
        { topic: task.topic, persona: '', city: task.city },
        {
          report: (progress, stage) => {
            this.tasks.update(task.id, { status: 'running', stage, progress });
          }
        }
      );
      masterPendingAudio = Boolean(generatedMaster.pendingAudio);
      this.catalog.reindex();
      master = this.catalog.findSource(task.topic);
      if (!master) {
        this.fail(task, '母本生成后仍找不到生成源');
        return;
      }
    }

    if (!pipeline) {
      this.fail(task, '未配置生成服务（缺少 LLM_API_KEY）');
      return;
    }

    // 提交阶段已按「母本 + 讲述人」去重，这里只在缺失时补建变体
    const generated = await pipeline.run(
      { topic: task.topic, persona, city: task.city, variant: { masterId: master.id } },
      {
        report: (progress, stage) => {
          this.tasks.update(task.id, { status: 'running', stage, progress });
        }
      }
    );

    // 人物与景点不符：不产出变体，直接复用现代导游母本
    if (generated.personaMismatch) {
      this.tasks.update(task.id, { status: 'validating', stage: '刷新清单', progress: 96 });
      this.catalog.reindex();
      this.finish(task, master.id, true);
      if (masterPendingAudio) {
        this.queueAudioTopUp(
          { packId: master.id, title: master.title, pendingAudio: true },
          task.topic,
          '',
          task.id
        );
      }
      return;
    }

    this.tasks.update(task.id, { status: 'validating', stage: '刷新清单', progress: 96 });
    this.catalog.reindex();
    this.purgeDuplicates(generated, persona);
    this.finish(task, generated.packId, false);
    this.queueAudioTopUp(generated, task.topic, persona, task.id);
  }

  /** 后台刷新：原地重新生成，成功后版本 +1；失败保留旧包并进入冷却 */
  private async processRefresh(task: TaskRecord): Promise<void> {
    const packId = task.packId;
    const pack = packId ? this.catalog.findPublishedById(packId) : null;

    if (!pack) {
      this.fail(task, '刷新失败：资源包不存在');
      return;
    }

    this.tasks.update(task.id, { status: 'running', stage: '刷新资源包', progress: 5 });

    // 变体包刷新沿用母本：只重写正文，分镜仍链接母本
    const persona = normalizePersona(task.persona || pack.persona);
    const variant = pack.masterId ? { masterId: pack.masterId } : undefined;
    const pipeline = this.pipelineFor(task);

    if (!pipeline) {
      this.fail(task, '未配置生成服务（缺少 LLM_API_KEY）');
      return;
    }

    try {
      const generated = await pipeline.run(
        {
          topic: task.topic,
          persona,
          city: task.city,
          refresh: { packId: packId, version: pack.version + 1 },
          ...(variant ? { variant } : {})
        },
        {
          report: (progress, stage) => {
            this.tasks.update(task.id, { status: 'running', stage, progress });
          }
        }
      );

      this.tasks.update(task.id, { status: 'validating', stage: '刷新清单', progress: 96 });
      this.catalog.reindex();
      this.purgeDuplicates(generated, persona);
      this.refresh?.cooldowns.clear(packId);
      this.finish(task, generated.packId, false);
      this.queueAudioTopUp(generated, task.topic, persona);
    } catch (err) {
      this.refresh?.cooldowns.set(
        packId,
        Date.now() + Math.max(0, this.refresh.cooldownDays) * DAY_MS
      );
      throw err;
    }
  }

  /**
   * 主任务生成后如需补齐剩余配音，排一个后台任务；
   * 每个资源包各自补齐，不按主题合并，避免同名不同包互相跳过。
   */
  private queueAudioTopUp(generated: GeneratedPack, topic: string, persona: string, parentTaskId = ''): void {
    if (!this.audioTopUp) return;
    const pipeline = parentTaskId ? this.pipelineById(parentTaskId) : this.pipeline;
    if (!generated.pendingAudio || !pipeline?.topUpAudio) return;

    if (this.maxQueue > 0 && this.tasks.countActive() >= this.maxQueue) return;

    const name = normalizePersona(persona);
    const task = this.tasks.create(topic, name, 'audio');
    this.tasks.update(task.id, { packId: generated.packId });
    // 主任务带了客户端自带密钥：补齐配音的后台任务沿用同一批密钥
    const overrides = parentTaskId ? this.keyOverrides.get(parentTaskId) : undefined;
    if (overrides) this.keyOverrides.set(task.id, overrides);
  }

  private pipelineById(taskId: string): GenerationPipeline | null {
    const overrides = this.keyOverrides.get(taskId);
    if (overrides && this.pipelineFactory) return this.pipelineFactory(overrides);
    return this.pipeline;
  }

  /** 后台补齐配音：把剩余幕补完后重新发布一版，客户端按新版本整体下载 */
  private async processAudio(task: TaskRecord): Promise<void> {
    const packId = task.packId;
    if (!this.audioTopUp) {
      // 暂停期间不消耗配音额度：排队中的补齐任务直接结束，不阻塞后面的生成任务
      this.tasks.update(task.id, {
        status: 'failed',
        stage: '失败',
        error: '后台配音补齐已暂停（AUDIO_TOPUP=0）'
      });
      return;
    }
    if (!packId) {
      this.fail(task, '配音补齐失败：缺少资源包 id');
      return;
    }
    const pipeline = this.pipelineFor(task);
    if (!pipeline?.topUpAudio) {
      this.fail(task, '未配置生成服务（缺少 LLM_API_KEY）');
      return;
    }

    this.tasks.update(task.id, { status: 'running', stage: '生成讲解音频', progress: 5 });
    const result = await pipeline.topUpAudio(packId, {
      report: (progress, stage) => {
        this.tasks.update(task.id, { status: 'running', stage, progress });
      }
    });

    if (!result.filled) {
      this.finish(task, packId, true);
      return;
    }

    this.tasks.update(task.id, { status: 'validating', stage: '刷新清单', progress: 96 });
    this.catalog.reindex();
    this.finish(task, packId, false);
  }

  /** 同一景点 + 同一讲述人只保留一个包：清掉历史上因重名加后缀留下的重复发布包 */
  private purgeDuplicates(pack: GeneratedPack, persona: string): void {
    if (!this.cleanup) return;
    const title = normalizeTopic(pack.title);
    const name = normalizePersona(persona);
    const duplicates = this.catalog
      .listPacks()
      .filter(
        (item) =>
          item.id !== pack.packId &&
          normalizeTopic(item.title) === title &&
          normalizePersona(item.persona || item.narratorName || '') === name
      );
    if (!duplicates.length) return;

    duplicates.forEach((item) => this.cleanup!.remove(item.id));
    this.catalog.reindex();
    console.log('[生成] 已清理同景点同讲述人的旧包：' + duplicates.map((item) => item.id).join('、'));
  }

  private finish(task: TaskRecord, packId: string, reused: boolean): void {
    const patch: TaskPatch = { status: 'done', stage: '完成', progress: 100, packId, reused };
    this.tasks.update(task.id, patch);
  }

  private fail(task: TaskRecord, error: string): void {
    this.tasks.update(task.id, { status: 'failed', stage: '失败', error });
    // 生成/装配失败可能留下半成品，重建索引让 manifest 回到磁盘真实状态
    this.catalog.reindex();
  }
}
