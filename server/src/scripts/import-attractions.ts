import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';
import { normalizeName } from '../domain/services/attraction-index.ts';

/**
 * 景点内容库导入：把 OpenBayes 全国城市景点 CSV（352 城）清洗后写入独立 SQLite
 * （server/data/attractions.db），供生成流水线优先取资料、跳过在线检索。
 * 用法（server 目录）：npm run db:import-attractions [-- --dir CSV目录] [-- --out attractions.db]
 * 全量重建：每次运行删除旧库重写，保证与数据集一致。
 */

/* ---------- CSV 解析（字段内可含换行与转义引号） ---------- */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n') {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else if (c !== '\r') {
      cur += c;
    }
  }
  if (cur || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

/* ---------- 字段清洗（导出纯函数供单测） ---------- */

/** 名字：剥掉拉丁字母词（「龙门石窟Longmen Grottoes」→「龙门石窟」），保留数字（798艺术区） */
export function cleanName(raw: string): string {
  const stripped = String(raw || '')
    .replace(/[A-Za-z][A-Za-z0-9 .&'/-]*/g, '')
    .replace(/\s+/g, '')
    .trim();
  return stripped || String(raw || '').trim();
}

/** 介绍：去 URL、去「地址:/电话:/官网:」标签行，压缩多余空行 */
export function cleanIntro(raw: string): string {
  let text = String(raw || '');
  text = text.replace(/https?:\/\/\S+/g, '');
  text = text
    .split('\n')
    .filter((line) => !/^\s*(?:地址|电话|官网|网址)\s*[:：]\s*$/.test(line))
    .join('\n');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/** 地址：只取「地址:」块的值，丢弃电话/官网；无标签时整列即地址 */
export function cleanAddress(raw: string): string {
  const text = String(raw || '').trim();
  if (!text) return '';
  const match = text.match(/地址\s*[:：]\s*([\s\S]*?)(?=\s*(?:电话|官网|网址)\s*[:：]|$)/);
  const value = (match ? match[1] : text).replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  return value.slice(0, 200);
}

/** 门票：Python dict repr 解析为「票种：价格」行；解析不出则保留原文 */
export function parseTicket(raw: string): string {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (!text.startsWith('{')) return text.replace(/\s+/g, ' ');

  const lines: string[] = [];
  const entry = /'([^']*)'\s*:\s*\[([^\]]*)\]/g;
  for (const m of text.matchAll(entry)) {
    const kind = m[1].replace(/\\[nrt]/g, '').replace(/\s+/g, '').trim();
    const prices = m[2]
      .split(',')
      .map((p) => p.replace(/['"\s]/g, ''))
      .filter(Boolean)
      .join('、');
    if (kind && prices) lines.push(`${kind}：${prices}`);
  }
  return lines.length ? lines.join('\n') : text.replace(/\s+/g, ' ');
}

/** 图片链接：拆出 http(s) URL 数组（实测每行至多 1 张） */
export function parseImages(raw: string): string[] {
  return String(raw || '')
    .split(/[,\s;；]+/)
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//.test(u));
}

/** 缩略图 URL → 原图：剥掉 qunarzz 的 _宽x高x质量_hash 后缀 */
export function originalImageUrl(url: string): string {
  return String(url || '').replace(/_\d+x\d+x\d+_[0-9a-f]+(\.(?:jpe?g|png|webp))?$/i, '');
}

/** 去空白后的字数，作为资料充足度判定依据 */
export function introLength(intro: string): number {
  return intro.replace(/\s+/g, '').length;
}

interface AttractionRow {
  name: string;
  nameCn: string;
  nameNorm: string;
  city: string;
  address: string;
  intro: string;
  openTime: string;
  ticket: string;
  tips: string;
  duration: string;
  season: string;
  rating: string;
  images: string;
  link: string;
  introLen: number;
}

/** 单条 CSV 记录 → 入库行；名字无效返回 null。季节文本若已含于小贴士则置空避免重复 */
export function buildRow(city: string, record: string[]): AttractionRow | null {
  const rawName = (record[0] || '').trim();
  if (!rawName) return null;
  const nameCn = cleanName(rawName);
  const nameNorm = normalizeName(nameCn) || normalizeName(rawName);
  if (!nameNorm) return null;

  const intro = cleanIntro(record[3] || '');
  const tips = (record[10] || '').replace(/\s+/g, ' ').trim();
  const seasonRaw = (record[8] || '').replace(/\s+/g, ' ').trim();
  const season =
    seasonRaw && tips && tips.replace(/\s+/g, '').includes(seasonRaw.replace(/\s+/g, '')) ? '' : seasonRaw;

  return {
    name: rawName,
    nameCn,
    nameNorm,
    city,
    address: cleanAddress(record[2] || ''),
    intro,
    openTime: (record[4] || '').trim(),
    ticket: parseTicket(record[9] || ''),
    tips,
    duration: (record[7] || '').replace(/\s+/g, ' ').trim(),
    season,
    rating: (record[6] || '').trim(),
    images: JSON.stringify(parseImages(record[5] || '')),
    link: (record[1] || '').trim(),
    introLen: introLength(intro)
  };
}

/* ---------- 建库与导入 ---------- */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS attractions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  name_cn   TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  city      TEXT NOT NULL,
  address   TEXT NOT NULL DEFAULT '',
  intro     TEXT NOT NULL DEFAULT '',
  open_time TEXT NOT NULL DEFAULT '',
  ticket    TEXT NOT NULL DEFAULT '',
  tips      TEXT NOT NULL DEFAULT '',
  duration  TEXT NOT NULL DEFAULT '',
  season    TEXT NOT NULL DEFAULT '',
  rating    TEXT NOT NULL DEFAULT '',
  images    TEXT NOT NULL DEFAULT '[]',
  link      TEXT NOT NULL DEFAULT '',
  intro_len INTEGER NOT NULL DEFAULT 0,
  UNIQUE (city, name_norm)
);

CREATE INDEX IF NOT EXISTS idx_attractions_city ON attractions (city);
CREATE INDEX IF NOT EXISTS idx_attractions_norm ON attractions (name_norm);
`;

export function createAttractionsDb(filePath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      args.set(argv[i].slice(2), argv[++i]);
    }
  }
  return args;
}

export function importAttractions(csvDir: string, dbPath: string): {
  files: number;
  rows: number;
  inserted: number;
  skipped: number;
  rich: number;
} {
  const files = fs.readdirSync(csvDir).filter((f) => f.endsWith('.csv')).sort();
  if (!files.length) throw new Error(`CSV 目录中没有数据文件：${csvDir}`);

  // 全量重建：删旧库（含 WAL/SHM）避免脏数据残留
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }

  const db = createAttractionsDb(dbPath);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO attractions
     (name, name_cn, name_norm, city, address, intro, open_time, ticket, tips, duration, season, rating, images, link, intro_len)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let rows = 0;
  let inserted = 0;
  let skipped = 0;
  let rich = 0;
  db.exec('BEGIN');
  for (const file of files) {
    const city = path.basename(file, '.csv').trim();
    const parsed = parseCsv(fs.readFileSync(path.join(csvDir, file), 'utf8'));
    const header = (parsed[0] || []).map((h) => h.trim());
    if (header[0] !== '名字') continue;

    for (const record of parsed.slice(1)) {
      if (record.length < header.length) {
        skipped++;
        continue;
      }
      const row = buildRow(city, record);
      if (!row) {
        skipped++;
        continue;
      }
      rows++;
      const info = insert.run(
        row.name, row.nameCn, row.nameNorm, row.city, row.address, row.intro,
        row.openTime, row.ticket, row.tips, row.duration, row.season, row.rating,
        row.images, row.link, row.introLen
      );
      if (Number(info.changes) > 0) {
        inserted++;
        if (row.introLen >= 400) rich++;
      }
    }
  }
  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  db.close();
  return { files: files.length, rows, inserted, skipped, rich };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const csvDir =
    args.get('dir') ||
    process.env.ATTRACTION_CSV_DIR ||
    path.resolve(here, '..', '..', '..', 'data', 'openbayes-attractions', 'extracted', 'citydata');
  const dbPath = args.get('out') || config.attractionsDbPath;

  const stats = importAttractions(csvDir, dbPath);
  const sizeMb = (fs.statSync(dbPath).size / 1024 / 1024).toFixed(1);
  console.log(
    `[导入] CSV ${stats.files} 个文件，有效 ${stats.rows} 行，入库 ${stats.inserted} 条` +
      `（重复跳过 ${stats.rows - stats.inserted}，无效 ${stats.skipped}），介绍≥400字 ${stats.rich} 条 → ${dbPath}（${sizeMb}MB）`
  );
}
