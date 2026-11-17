import type { DatabaseSync } from 'node:sqlite';
import type { RefreshCooldownStore } from '../../domain/ports.ts';

/** 刷新失败冷却：单独建表，重扫索引（清空 packs 表）不会误删冷却记录 */
export class RefreshCooldownRepository implements RefreshCooldownStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  get(packId: string): number {
    const row = this.db
      .prepare('SELECT retry_after FROM refresh_cooldowns WHERE pack_id = ?')
      .get(packId) as { retry_after: number } | undefined;
    return row ? Number(row.retry_after) : 0;
  }

  set(packId: string, retryAfter: number): void {
    this.db
      .prepare(
        `INSERT INTO refresh_cooldowns (pack_id, retry_after) VALUES (?, ?)
         ON CONFLICT(pack_id) DO UPDATE SET retry_after = excluded.retry_after`
      )
      .run(packId, retryAfter);
  }

  clear(packId: string): void {
    this.db.prepare('DELETE FROM refresh_cooldowns WHERE pack_id = ?').run(packId);
  }
}
