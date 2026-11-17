import type { DatabaseSync } from 'node:sqlite';
import type { SourceIndex } from '../../domain/ports.ts';
import type { SourceEntry } from '../../domain/types.ts';

interface SourceRow {
  id: string;
  dir: string;
  title: string;
  title_norm: string;
  narrator_id: string;
  narrator_name: string;
  master_id: string;
  persona: string;
  content_mtime: number;
}

function toSource(row: SourceRow): SourceEntry {
  return {
    id: row.id,
    dir: row.dir,
    title: row.title,
    titleNorm: row.title_norm,
    narratorId: row.narrator_id,
    narratorName: row.narrator_name,
    masterId: row.master_id,
    persona: row.persona,
    contentMtime: row.content_mtime
  };
}

export class SourceRepository implements SourceIndex {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  replaceAll(sources: SourceEntry[]): void {
    const insert = this.db.prepare(
      `INSERT INTO sources (id, dir, title, title_norm, narrator_id, narrator_name, master_id, persona, content_mtime, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const indexedAt = Date.now();

    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM sources');
      sources.forEach((source) => {
        insert.run(
          source.id,
          source.dir,
          source.title,
          source.titleNorm,
          source.narratorId,
          source.narratorName,
          source.masterId,
          source.persona,
          source.contentMtime,
          indexedAt
        );
      });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  list(): SourceEntry[] {
    const rows = this.db.prepare('SELECT * FROM sources ORDER BY id ASC').all() as unknown as SourceRow[];
    return rows.map(toSource);
  }
}
