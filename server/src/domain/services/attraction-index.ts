/**
 * 全国景点名候选集：资料检索失败时给出「您是不是要找」的地名建议。
 * 归一化与编辑距离规则与小程序端 web/core/naming.js 保持一致，阈值与 packs.js findSimilar 一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 候选集条目：景点名 + 所在城市 */
export interface AttractionEntry {
  name: string;
  city: string;
}

/** 默认数据文件：server/data/national-attractions.json（由脚本从全国城市景点 CSV 生成） */
const DEFAULT_DATA_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../data/national-attractions.json'
);

let indexCache: AttractionEntry[] | null = null;

/** 懒加载候选集：NATIONAL_ATTRACTIONS_FILE 可覆盖路径（测试注入 fixture）；文件缺失或损坏时返回空数组不抛错 */
function loadIndex(): AttractionEntry[] {
  if (indexCache) return indexCache;
  const file = process.env.NATIONAL_ATTRACTIONS_FILE || DEFAULT_DATA_FILE;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    indexCache = Array.isArray(parsed) ? (parsed as AttractionEntry[]) : [];
  } catch {
    indexCache = [];
  }
  return indexCache;
}

/** 名称归一化：与小程序端 naming.js normalizeName 完全一致（去空白、迭代去行政区前缀、去景区后缀、转小写） */
export function normalizeName(value: string): string {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/^(?:河南省|洛阳市|洛阳)+/, '')
    .replace(/(?:风景区|景区)$/, '')
    .toLowerCase();
}

/** 字符级编辑距离：与小程序端 naming.js 相同的滚动数组实现 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const n = b.length;
  let prev: number[] = [];
  const curr: number[] = [];
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1)
      );
    }
    prev = curr.slice();
  }
  return prev[n];
}

/**
 * 地名建议：对候选集做三档匹配——完全相等、包含关系、编辑距离（阈值同 packs.js findSimilar）。
 * 完全相同的候选名也返回，用于提示正确写法；按（距离升序、name 长度升序）取前 limit 条。
 */
export function suggestAttractions(input: string, limit = 3): AttractionEntry[] {
  const key = normalizeName(input);
  if (!key) return [];

  const matches: Array<{ entry: AttractionEntry; distance: number }> = [];
  for (const entry of loadIndex()) {
    const name = normalizeName(entry.name);
    if (!name) continue;

    if (name === key) {
      // 一档：完全相等
      matches.push({ entry, distance: 0 });
      continue;
    }
    if (name.includes(key) || key.includes(name)) {
      // 二档：包含关系（如输入截短「龙门」），不受编辑距离阈值限制
      matches.push({ entry, distance: editDistance(key, name) });
      continue;
    }
    // 三档：编辑距离近似，容忍错别字
    const distance = editDistance(key, name);
    const max = Math.max(key.length, name.length);
    if (distance <= Math.max(1, Math.floor(max / 3)) && distance * 2 <= max) {
      matches.push({ entry, distance });
    }
  }

  matches.sort((a, b) => a.distance - b.distance || a.entry.name.length - b.entry.name.length);
  return matches.slice(0, limit).map((m) => m.entry);
}
