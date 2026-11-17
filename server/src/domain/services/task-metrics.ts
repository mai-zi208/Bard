import type { TaskRecord } from '../types.ts';

export interface StageMetric {
  stage: string;
  count: number;
  avgMs: number;
  maxMs: number;
}

export interface FailureMetric {
  stage: string;
  error: string;
  count: number;
  lastAt: number;
}

export interface RecentFailure {
  id: string;
  topic: string;
  stage: string;
  error: string;
  at: number;
}

export interface TaskMetrics {
  generatedAt: number;
  /** 统计窗口内的任务数（调用方传入最近 N 条） */
  total: number;
  byStatus: Record<string, number>;
  active: number;
  /** 窗口内命中复用（生成源未更新，直接发布已有包）的任务数 */
  reused: number;
  /** 复用率：reused / total，保留 4 位小数 */
  reuseRate: number;
  stages: StageMetric[];
  failures: FailureMetric[];
  recentFailures: RecentFailure[];
}

const ERROR_MAX = 80;

function isTerminal(task: TaskRecord): boolean {
  return task.status === 'done' || task.status === 'failed';
}

/** 失败发生的阶段：取最后一个业务阶段（排除「失败」「完成」这类终态） */
function failedStage(task: TaskRecord): string {
  const stages = task.stageLog
    .map((mark) => mark.stage)
    .filter((stage) => stage && stage !== '失败' && stage !== '完成');
  return stages.length ? stages[stages.length - 1] : '未知';
}

/** 从任务记录汇总阶段耗时与失败分布；进行中的当前阶段不计入均值 */
export function buildTaskMetrics(tasks: TaskRecord[], now = Date.now()): TaskMetrics {
  const byStatus: Record<string, number> = { queued: 0, running: 0, validating: 0, done: 0, failed: 0 };
  const durations = new Map<string, number[]>();
  let reused = 0;

  for (const task of tasks) {
    byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
    if (task.reused) reused += 1;

    const marks = task.stageLog;
    for (let i = 0; i < marks.length; i += 1) {
      const mark = marks[i];
      if (!mark.stage) continue;

      let end: number | null = null;
      if (i + 1 < marks.length) {
        end = marks[i + 1].at;
      } else if (isTerminal(task)) {
        end = task.updatedAt;
      }
      if (end === null) continue;

      const list = durations.get(mark.stage) ?? [];
      list.push(Math.max(0, end - mark.at));
      durations.set(mark.stage, list);
    }
  }

  const stages: StageMetric[] = Array.from(durations, ([stage, list]) => ({
    stage,
    count: list.length,
    avgMs: Math.round(list.reduce((sum, value) => sum + value, 0) / list.length),
    maxMs: Math.max(...list)
  })).sort((a, b) => b.avgMs - a.avgMs);

  const failures = new Map<string, FailureMetric>();
  const recentFailures: RecentFailure[] = [];

  for (const task of tasks) {
    if (task.status !== 'failed') continue;

    const stage = failedStage(task);
    const error = task.error || '未知错误';
    const key = stage + '|' + error.slice(0, ERROR_MAX);
    const item = failures.get(key) ?? {
      stage: stage,
      error: error.slice(0, ERROR_MAX),
      count: 0,
      lastAt: 0
    };
    item.count += 1;
    item.lastAt = Math.max(item.lastAt, task.updatedAt);
    failures.set(key, item);

    recentFailures.push({
      id: task.id,
      topic: task.topic,
      stage: stage,
      error: error,
      at: task.updatedAt
    });
  }

  recentFailures.sort((a, b) => b.at - a.at);

  return {
    generatedAt: now,
    total: tasks.length,
    byStatus: byStatus,
    active: (byStatus.queued ?? 0) + (byStatus.running ?? 0) + (byStatus.validating ?? 0),
    reused: reused,
    reuseRate: tasks.length ? Math.round((reused / tasks.length) * 10000) / 10000 : 0,
    stages: stages,
    failures: Array.from(failures.values()).sort((a, b) => b.count - a.count || b.lastAt - a.lastAt),
    recentFailures: recentFailures.slice(0, 10)
  };
}
