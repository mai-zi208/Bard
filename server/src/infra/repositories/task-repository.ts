import type { DatabaseSync } from 'node:sqlite';
import type { TaskPatch, TaskStore } from '../../domain/ports.ts';
import type { StageMark, TaskKind, TaskRecord, TaskStatus } from '../../domain/types.ts';

interface TaskRow {
  id: string;
  topic: string;
  persona: string;
  kind: string;
  status: string;
  stage: string;
  progress: number;
  pack_id: string;
  error: string;
  reused: number;
  stage_log: string;
  created_at: number;
  updated_at: number;
}

function parseStageLog(value: string): StageMark[] {
  try {
    const parsed = JSON.parse(value || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is StageMark =>
        !!item && typeof item.stage === 'string' && typeof item.at === 'number'
    );
  } catch (err) {
    return [];
  }
}

function toRecord(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    topic: row.topic,
    persona: row.persona,
    kind: row.kind === 'refresh' ? 'refresh' : row.kind === 'audio' ? 'audio' : 'generate',
    status: row.status as TaskStatus,
    stage: row.stage,
    progress: row.progress,
    packId: row.pack_id,
    error: row.error,
    reused: row.reused === 1,
    stageLog: parseStageLog(row.stage_log),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function createId(): string {
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export class TaskRepository implements TaskStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(topic: string, persona: string, kind: TaskKind = 'generate'): TaskRecord {
    const now = Date.now();
    const record: TaskRecord = {
      id: createId(),
      topic: topic,
      persona: persona,
      kind: kind,
      status: 'queued',
      stage: '',
      progress: 0,
      packId: '',
      error: '',
      reused: false,
      stageLog: [],
      createdAt: now,
      updatedAt: now
    };

    this.db
      .prepare(
        `INSERT INTO tasks (id, topic, persona, kind, status, stage, progress, pack_id, error, reused, stage_log, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.topic,
        record.persona,
        record.kind,
        record.status,
        record.stage,
        record.progress,
        record.packId,
        record.error,
        0,
        '[]',
        record.createdAt,
        record.updatedAt
      );

    return record;
  }

  find(id: string): TaskRecord | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** 同一景物 + 讲述人 + 类型只保留一个进行中的任务，重复提交直接复用 */
  findActive(topic: string, persona: string, kind: TaskKind = 'generate'): TaskRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM tasks WHERE topic = ? AND persona = ? AND kind = ? AND status IN ('queued', 'running', 'validating') ORDER BY created_at DESC LIMIT 1"
      )
      .get(topic, persona, kind) as TaskRow | undefined;
    return row ? toRecord(row) : null;
  }

  countActive(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS total FROM tasks WHERE status IN ('queued', 'running', 'validating')"
      )
      .get() as { total: number } | undefined;
    return row ? Number(row.total) : 0;
  }

  nextQueued(): TaskRecord | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1")
      .get() as TaskRow | undefined;
    return row ? toRecord(row) : null;
  }

  update(id: string, patch: TaskPatch): void {
    const now = Date.now();
    const sets: string[] = [];
    const params: (string | number)[] = [];

    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (patch.stage !== undefined) {
      sets.push('stage = ?');
      params.push(patch.stage);
    }
    if (patch.progress !== undefined) {
      sets.push('progress = ?');
      params.push(patch.progress);
    }
    if (patch.packId !== undefined) {
      sets.push('pack_id = ?');
      params.push(patch.packId);
    }
    if (patch.error !== undefined) {
      sets.push('error = ?');
      params.push(patch.error);
    }
    if (patch.reused !== undefined) {
      sets.push('reused = ?');
      params.push(patch.reused ? 1 : 0);
    }

    // 阶段变化时追加打点，供 /metrics 统计各阶段耗时
    if (patch.stage !== undefined) {
      const current = this.db
        .prepare('SELECT stage, stage_log FROM tasks WHERE id = ?')
        .get(id) as { stage: string; stage_log: string } | undefined;
      if (current && current.stage !== patch.stage) {
        const log = parseStageLog(current.stage_log);
        log.push({ stage: patch.stage, at: now });
        sets.push('stage_log = ?');
        params.push(JSON.stringify(log));
      }
    }

    sets.push('updated_at = ?');
    params.push(now);
    params.push(id);

    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  listRecent(limit: number): TaskRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?')
      .all(limit) as unknown as TaskRow[];
    return rows.map(toRecord);
  }

  /** 进程重启时把未完成任务放回队列，避免任务永久卡在 running/validating */
  requeueInterrupted(): void {
    this.db
      .prepare(
        "UPDATE tasks SET status = 'queued', stage = '', progress = 0, updated_at = ? WHERE status IN ('running', 'validating')"
      )
      .run(Date.now());
  }
}
