import type { DatabaseSync } from 'node:sqlite';
import type { PackIndex } from '../../domain/ports.ts';
import type { PublishedPack } from '../../domain/types.ts';

interface PackRow {
  id: string;
  version: number;
  title: string;
  subtitle: string;
  summary: string;
  tags: string;
  total: number;
  narrator_name: string;
  cover: string;
  bytes: number;
  ai_generated: number;
  published_at: number;
  refreshed_at: number;
  ttl_days: number;
  master_id: string;
  persona: string;
}

function toPack(row: PackRow): PublishedPack {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags);
    if (Array.isArray(parsed)) tags = parsed.map(String);
  } catch {
    tags = [];
  }

  return {
    id: row.id,
    version: row.version,
    title: row.title,
    subtitle: row.subtitle,
    summary: row.summary,
    tags: tags,
    total: row.total,
    narratorName: row.narrator_name,
    cover: row.cover,
    bytes: row.bytes,
    // 索引只用于标题/讲述人匹配，清单里的音频数由 CdnStore 扫描磁盘时统计
    audioCount: 0,
    files: [],
    publishedAt: row.published_at,
    refreshedAt: row.refreshed_at || row.published_at,
    ttlDays: Number(row.ttl_days) || 0,
    masterId: row.master_id || '',
    persona: row.persona || '',
    aiGenerated: row.ai_generated === 1
  };
}

export class PackRepository implements PackIndex {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  replaceAll(packs: PublishedPack[]): void {
    const insert = this.db.prepare(
      `INSERT INTO packs (id, version, title, subtitle, summary, tags, total, narrator_name, cover, bytes, ai_generated, published_at, refreshed_at, ttl_days, master_id, persona, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const indexedAt = Date.now();

    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM packs');
      packs.forEach((pack) => {
        insert.run(
          pack.id,
          pack.version,
          pack.title,
          pack.subtitle,
          pack.summary,
          JSON.stringify(pack.tags),
          pack.total,
          pack.narratorName,
          pack.cover,
          pack.bytes,
          pack.aiGenerated ? 1 : 0,
          pack.publishedAt,
          pack.refreshedAt,
          pack.ttlDays,
          pack.masterId,
          pack.persona,
          indexedAt
        );
      });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  list(): PublishedPack[] {
    const rows = this.db.prepare('SELECT * FROM packs ORDER BY id ASC').all() as unknown as PackRow[];
    return rows.map(toPack);
  }
}
