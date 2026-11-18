import fs from 'node:fs';
import { normalizeTopic } from '../domain/services/source-matcher.ts';
import type { TaskRecord } from '../domain/types.ts';

/**
 * 热门景点清单与批量预生成脚本共用的纯函数：
 * 清单解析、命令行参数解析、提交频次聚合、清单与实际热度的差异比对。
 * 无顶层副作用，可被单测直接 import。
 */

/** 人工确认的热门清单结构（hot-topics.json） */
export interface HotList {
  updated: string;
  cities: { city: string; topics: string[] }[];
}

/** 解析 --key value / --key=value / --flag 形式的命令行参数 */
export function parseArgs(argv: string[]): Map<string, string | true> {
  const args = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error('多余的位置参数：' + token + '（只支持 --key value / --flag）');
    const eq = token.indexOf('=');
    if (eq >= 0) {
      args.set(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args.set(key, next);
      i += 1;
    } else {
      args.set(key, true);
    }
  }
  return args;
}

/** 读取并校验热门清单，报错信息带文件路径 */
export function loadHotList(file: string): HotList {
  if (!fs.existsSync(file)) throw new Error('热门清单不存在：' + file);

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error('热门清单不是合法 JSON：' + file + '（' + (err instanceof Error ? err.message : String(err)) + '）');
  }

  const list = raw as Partial<HotList>;
  if (!Array.isArray(list.cities)) throw new Error('热门清单缺少 cities 数组：' + file);

  for (const group of list.cities) {
    if (!group || typeof group.city !== 'string') throw new Error('热门清单存在缺少 city 的分组：' + file);
    if (!Array.isArray(group.topics) || group.topics.some((t) => typeof t !== 'string' || !t.trim())) {
      throw new Error('热门清单「' + group.city + '」的 topics 必须是非空字符串数组：' + file);
    }
  }

  return { updated: typeof list.updated === 'string' ? list.updated : '', cities: list.cities };
}

/** 展开清单并按归一名去重（同景点多城市重复出现时保留第一条） */
export function flattenList(list: HotList): { city: string; topic: string }[] {
  const seen = new Set<string>();
  const items: { city: string; topic: string }[] = [];
  for (const group of list.cities) {
    for (const topic of group.topics) {
      const key = normalizeTopic(topic);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push({ city: group.city, topic: topic.trim() });
    }
  }
  return items;
}

/** 单个归一景点的提交频次统计 */
export interface TopicStat {
  key: string;
  /** 用户实际提交过的原始写法样例 */
  names: string[];
  count: number;
  done: number;
  failed: number;
  reused: number;
  lastSubmittedAt: number;
  lastStatus: string;
}

/** 只统计母本生成类任务（refresh/audio 不反映热度），按 normalizeTopic 分组，count 降序 → 最近提交降序 */
export function aggregateGenerateTasks(records: TaskRecord[]): TopicStat[] {
  const groups = new Map<string, TopicStat>();

  for (const record of records) {
    if (record.kind !== 'generate') continue;
    const key = normalizeTopic(record.topic);
    if (!key) continue;

    let stat = groups.get(key);
    if (!stat) {
      stat = { key, names: [], count: 0, done: 0, failed: 0, reused: 0, lastSubmittedAt: 0, lastStatus: '' };
      groups.set(key, stat);
    }

    stat.count += 1;
    if (record.status === 'done') stat.done += 1;
    if (record.status === 'failed') stat.failed += 1;
    if (record.reused) stat.reused += 1;
    if (!stat.names.includes(record.topic) && stat.names.length < 5) stat.names.push(record.topic);
    if (record.createdAt > stat.lastSubmittedAt) {
      stat.lastSubmittedAt = record.createdAt;
      stat.lastStatus = record.status;
    }
  }

  return [...groups.values()].sort(
    (a, b) => b.count - a.count || b.lastSubmittedAt - a.lastSubmittedAt
  );
}

/** 清单与真实热度的双向差异 */
export function diffList(
  list: HotList,
  stats: TopicStat[],
  minCount = 3
): { listedButNoSubmit: string[]; hotButUnlisted: TopicStat[] } {
  const statKeys = new Set(stats.map((stat) => stat.key));
  const listKeys = new Set(flattenList(list).map((item) => normalizeTopic(item.topic)));

  const listedButNoSubmit = flattenList(list)
    .filter((item) => !statKeys.has(normalizeTopic(item.topic)))
    .map((item) => item.topic);

  const hotButUnlisted = stats.filter((stat) => stat.count >= minCount && !listKeys.has(stat.key));

  return { listedButNoSubmit, hotButUnlisted };
}
