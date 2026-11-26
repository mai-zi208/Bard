import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  topic       TEXT NOT NULL,
  persona     TEXT NOT NULL DEFAULT '',
  city        TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'generate',
  status      TEXT NOT NULL,
  stage       TEXT NOT NULL DEFAULT '',
  progress    INTEGER NOT NULL DEFAULT 0,
  pack_id     TEXT NOT NULL DEFAULT '',
  error       TEXT NOT NULL DEFAULT '',
  reused      INTEGER NOT NULL DEFAULT 0,
  stage_log   TEXT NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks (status, created_at);

CREATE TABLE IF NOT EXISTS packs (
  id            TEXT PRIMARY KEY,
  version       INTEGER NOT NULL DEFAULT 1,
  title         TEXT NOT NULL DEFAULT '',
  subtitle      TEXT NOT NULL DEFAULT '',
  summary       TEXT NOT NULL DEFAULT '',
  tags          TEXT NOT NULL DEFAULT '[]',
  total         INTEGER NOT NULL DEFAULT 0,
  narrator_name TEXT NOT NULL DEFAULT '',
  cover         TEXT NOT NULL DEFAULT '',
  bytes         INTEGER NOT NULL DEFAULT 0,
  ai_generated  INTEGER NOT NULL DEFAULT 0,
  published_at  INTEGER NOT NULL DEFAULT 0,
  refreshed_at  INTEGER NOT NULL DEFAULT 0,
  ttl_days      INTEGER NOT NULL DEFAULT 0,
  master_id     TEXT NOT NULL DEFAULT '',
  persona       TEXT NOT NULL DEFAULT '',
  indexed_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_cooldowns (
  pack_id       TEXT PRIMARY KEY,
  retry_after   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,
  dir           TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  title_norm    TEXT NOT NULL DEFAULT '',
  narrator_id   TEXT NOT NULL DEFAULT '',
  narrator_name TEXT NOT NULL DEFAULT '',
  master_id     TEXT NOT NULL DEFAULT '',
  persona       TEXT NOT NULL DEFAULT '',
  content_mtime INTEGER NOT NULL DEFAULT 0,
  indexed_at    INTEGER NOT NULL
);
`;

export function openDatabase(filePath: string): DatabaseSync {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** 老库补列：CREATE TABLE IF NOT EXISTS 不会给已有表加字段 */
function migrate(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'stage')) {
    db.exec("ALTER TABLE tasks ADD COLUMN stage TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.some((column) => column.name === 'stage_log')) {
    db.exec("ALTER TABLE tasks ADD COLUMN stage_log TEXT NOT NULL DEFAULT '[]'");
  }
  if (!columns.some((column) => column.name === 'kind')) {
    db.exec("ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'generate'");
  }
  if (!columns.some((column) => column.name === 'city')) {
    db.exec("ALTER TABLE tasks ADD COLUMN city TEXT NOT NULL DEFAULT ''");
  }

  const packColumns = db.prepare('PRAGMA table_info(packs)').all() as { name: string }[];
  if (!packColumns.some((column) => column.name === 'ai_generated')) {
    db.exec('ALTER TABLE packs ADD COLUMN ai_generated INTEGER NOT NULL DEFAULT 0');
  }
  if (!packColumns.some((column) => column.name === 'refreshed_at')) {
    db.exec('ALTER TABLE packs ADD COLUMN refreshed_at INTEGER NOT NULL DEFAULT 0');
  }
  if (!packColumns.some((column) => column.name === 'ttl_days')) {
    db.exec('ALTER TABLE packs ADD COLUMN ttl_days INTEGER NOT NULL DEFAULT 0');
  }
  if (!packColumns.some((column) => column.name === 'master_id')) {
    db.exec("ALTER TABLE packs ADD COLUMN master_id TEXT NOT NULL DEFAULT ''");
  }
  if (!packColumns.some((column) => column.name === 'persona')) {
    db.exec("ALTER TABLE packs ADD COLUMN persona TEXT NOT NULL DEFAULT ''");
  }

  const sourceColumns = db.prepare('PRAGMA table_info(sources)').all() as { name: string }[];
  if (!sourceColumns.some((column) => column.name === 'master_id')) {
    db.exec("ALTER TABLE sources ADD COLUMN master_id TEXT NOT NULL DEFAULT ''");
  }
  if (!sourceColumns.some((column) => column.name === 'persona')) {
    db.exec("ALTER TABLE sources ADD COLUMN persona TEXT NOT NULL DEFAULT ''");
  }
}
