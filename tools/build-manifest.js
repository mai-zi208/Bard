#!/usr/bin/env node
/**
 * 扫描发布目录，生成远端清单 manifest.json。
 *
 * 用法：node tools/build-manifest.js [--dir cdn]
 *
 * 清单结构：
 * {
 *   schemaVersion: 1,
 *   updatedAt: ISO 时间,
 *   packs: [{ id, version, minVersion, deprecated, title, subtitle, summary, tags, total,
 *             narratorName, cover, bytes, aiGenerated, files: [],
 *             checksums: { 相对路径: { sha256, size } } }]
 * }
 * files 为包内相对路径，客户端按顺序下载并按 checksums 校验。
 * minVersion / deprecated 缺省时不输出：前者表示不限最低版本，后者表示未下架。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKIP = new Set(['manifest.json', 'sources.md', 'script.md']);

/** 逐文件摘要：客户端下载后按 sha256 + size 校验，截断或被篡改即丢弃 */
function checksumOf(abs) {
  const buf = fs.readFileSync(abs);
  return {
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    size: buf.length
  };
}

/** 与 loader 一致的本地化取值 */
function pick(value, locale) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.slice();
  if (typeof value === 'object') {
    if (value[locale] !== undefined) return value[locale];
    const keys = Object.keys(value);
    return keys.length ? value[keys[0]] : '';
  }
  return '';
}

function listFiles(dir, base) {
  const out = [];
  fs.readdirSync(path.join(dir, base)).forEach((name) => {
    const rel = base ? base + '/' + name : name;
    const abs = path.join(dir, rel);
    if (fs.statSync(abs).isDirectory()) {
      out.push.apply(out, listFiles(dir, rel));
    } else if (!SKIP.has(name)) {
      out.push(rel);
    }
  });
  return out;
}

function buildEntry(dir, root) {
  const pack = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
  const locale = pack.defaultLocale || 'zh-CN';
  const files = listFiles(dir, '').sort();
  const ordered = ['pack.json', pack.cover].concat(
    files.filter((f) => f !== 'pack.json' && f !== pack.cover)
  );

  let bytes = 0;
  ordered.forEach((rel) => {
    bytes += fs.statSync(path.join(dir, rel)).size;
  });

  return {
    id: pack.id,
    version: pack.version || 1,
    // 本地版本低于 minVersion 时必须更新才能进入；软下架不再推荐新用户下载
    ...(Number(pack.minVersion) > 0 ? { minVersion: Number(pack.minVersion) } : {}),
    ...(pack.deprecated === true ? { deprecated: true } : {}),
    title: pick(pack.title, locale),
    subtitle: pick(pack.subtitle, locale),
    summary: pick(pack.summary, locale),
    tags: Array.isArray(pack.tags) ? pack.tags : [],
    total: Array.isArray(pack.scenes) ? pack.scenes.length : 0,
    narratorName: pack.narrator ? pick(pack.narrator.name, locale) : '',
    cover: pack.cover,
    bytes: bytes,
    audioCount: Array.isArray(pack.scenes) ? pack.scenes.filter((s) => s && s.audio).length : 0,
    aiGenerated: pack.generated === true || pack.aiGenerated === true,
    files: ordered,
    checksums: ordered.reduce((acc, rel) => {
      acc[rel] = checksumOf(path.join(dir, rel));
      return acc;
    }, {})
  };
}

function main() {
  const args = process.argv.slice(2);
  const dirIndex = args.indexOf('--dir');
  const dir = path.resolve(dirIndex >= 0 ? args[dirIndex + 1] : path.join(ROOT, 'cdn'));

  if (!fs.existsSync(dir)) {
    console.error('找不到发布目录：' + dir);
    process.exit(1);
  }

  const packs = fs
    .readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((item) => fs.statSync(item).isDirectory())
    .filter((item) => fs.existsSync(path.join(item, 'pack.json')))
    .map((item) => buildEntry(item, dir));

  const manifest = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    packs: packs
  };

  // 先写临时文件再原子替换，避免客户端读到半截清单；上一版留作回滚
  const out = path.join(dir, 'manifest.json');
  fs.writeFileSync(out + '.tmp', JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  if (fs.existsSync(out)) {
    fs.copyFileSync(out, out + '.bak');
  }
  fs.renameSync(out + '.tmp', out);
  console.log(
    '已生成 ' + path.relative(process.cwd(), out) + '，' + packs.length + ' 个在线包'
  );
  packs.forEach((pack) => {
    console.log(
      '  ' + pack.id + '  v' + pack.version + '  ' + (pack.bytes / 1024).toFixed(0) + 'KB  ' + pack.files.length + ' 个文件'
    );
  });
}

main();
