import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { AttractionContent } from '../../domain/ports.ts';
import { editDistance, normalizeName } from '../../domain/services/attraction-index.ts';

/**
 * 景点内容库只读查询（attractions.db，由 npm run db:import-attractions 构建）。
 * 匹配规则与 attraction-index.ts 一致：精确 → 包含 → 编辑距离三档；
 * 有城市时先按城市过滤（「这个城市有这个景点」），无城市时全局唯一名才收。
 */

interface LightRow {
  id: number;
  name_norm: string;
  intro_len: number;
}

interface FullRow {
  name: string;
  name_cn: string;
  city: string;
  address: string;
  intro: string;
  open_time: string;
  ticket: string;
  tips: string;
  duration: string;
  season: string;
  rating: string;
  images: string;
  link: string;
  intro_len: number;
}

/** 打开景点库（只查询不写入）；文件不存在返回 null（调用方回退在线检索） */
export function openAttractionDatabase(filePath: string): DatabaseSync | null {
  if (filePath !== ':memory:' && !fs.existsSync(filePath)) return null;
  try {
    return new DatabaseSync(filePath);
  } catch {
    return null;
  }
}

/** 城市名归一：剥省/市后缀，与数据集文件名（裸城市名）对齐 */
function normalizeCity(value: string): string {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/(?:省|市|自治区|特别行政区)$/, '');
}

function parseImages(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((u) => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

function toContent(row: FullRow): AttractionContent {
  return {
    name: row.name,
    nameCn: row.name_cn,
    city: row.city,
    address: row.address,
    intro: row.intro,
    openTime: row.open_time,
    ticket: row.ticket,
    tips: row.tips,
    duration: row.duration,
    season: row.season,
    rating: row.rating,
    images: parseImages(row.images),
    link: row.link,
    introLen: row.intro_len
  };
}

export class AttractionRepository {
  private readonly db: DatabaseSync | null;

  constructor(db: DatabaseSync | null) {
    this.db = db;
  }

  /** 库内条目总数；未导入时为 0 */
  count(): number {
    if (!this.db) return 0;
    try {
      const row = this.db.prepare('SELECT COUNT(*) n FROM attractions').get() as { n: number };
      return Number(row.n);
    } catch {
      return 0;
    }
  }

  /** 按城市+景点名查资料；未命中、跨城歧义或库缺失返回 null */
  findByCityAndName(city: string, topic: string): AttractionContent | null {
    if (!this.db) return null;
    const key = normalizeName(topic);
    if (!key) return null;

    const cityNorm = normalizeCity(city);
    if (cityNorm) {
      const lightRows = this.db
        .prepare('SELECT id, name_norm, intro_len FROM attractions WHERE city = ?')
        .all(cityNorm) as unknown as LightRow[];
      const best = this.pickBest(lightRows, key);
      return best === null ? null : this.fetchById(best);
    }

    // 无城市：全局等值命中且唯一才收，避免拿错城的同名景点
    const rows = this.db
      .prepare('SELECT id, name_norm, intro_len FROM attractions WHERE name_norm = ? LIMIT 2')
      .all(key) as unknown as LightRow[];
    if (rows.length !== 1) return null;
    return this.fetchById(rows[0].id);
  }

  /** 三档匹配取最优：同档内按（编辑距离升序、名称长度升序） */
  private pickBest(rows: LightRow[], key: string): number | null {
    let best: { id: number; tier: number; distance: number; length: number } | null = null;
    for (const row of rows) {
      const name = row.name_norm;
      if (!name) continue;

      let tier: number;
      let distance: number;
      if (name === key) {
        tier = 0;
        distance = 0;
      } else if (name.includes(key) || key.includes(name)) {
        tier = 1;
        distance = editDistance(key, name);
      } else {
        distance = editDistance(key, name);
        const max = Math.max(key.length, name.length);
        if (distance <= Math.max(1, Math.floor(max / 3)) && distance * 2 <= max) tier = 2;
        else continue;
      }

      if (
        !best ||
        tier < best.tier ||
        (tier === best.tier &&
          (distance < best.distance ||
            (distance === best.distance && name.length < best.length)))
      ) {
        best = { id: row.id, tier, distance, length: name.length };
      }
    }
    return best ? best.id : null;
  }

  private fetchById(id: number): AttractionContent | null {
    const row = this.db!
      .prepare('SELECT * FROM attractions WHERE id = ?')
      .get(id) as unknown as FullRow | undefined;
    return row ? toContent(row) : null;
  }
}
