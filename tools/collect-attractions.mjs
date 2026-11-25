#!/usr/bin/env node
/**
 * 景点信息 + 图片采集：openbayes 全国景点 CSV → 本地数据集（供后续制作讲解数据集）。
 *
 * 用法：
 *   node tools/collect-attractions.mjs 洛阳 [郑州 ...]
 *
 * 输入：data/openbayes-attractions/extracted/citydata/<城市>.csv
 *   表头 名字,链接,地址,介绍,开放时间,图片链接,评分,建议游玩时间,建议季节,门票,小贴士,Page
 *   字段含带换行的引号字段，必须逐字符状态机解析（正确处理 "" 转义），不能按行 split。
 *   「名字」形如「龙门石窟Longmen Grottoes」，取开头连续中文段。
 *
 * 输出：data/attraction-dataset/<城市>/
 *   index.jsonl   每景点一行（含 images 明细与 portrait_count）
 *   images/<序号>-<净化景点名>/<n>.jpg
 *   dataset.json  城市级统计
 *
 * 图片 URL 实测结论（2026-11，洛阳样本）：
 *   - CSV「图片链接」每格通常只有 1 个 URL（形如
 *     https://img1.qunarzz.com/travel/d0/1604/47/xxx.jpg_480x360x95_hash.jpg 或
 *     https://tr-osdcp.qunarzz.com/tr-osd-tr-mapi/img/xxx.jpg_480x360x95_hash.jpg），
 *     解析时仍按 http token 拆分并去重，兼容未来多 URL 格。
 *   - 把 `\.jpg_[^/]*$` 截到 `.jpg` 即「原图」，两域名均实测 200，且尺寸大
 *     （如 3200x2400、1600x1200、1440x1080），因此优先取原图、失败回退变体 URL。
 *   - 把变体里 `_480x360x95` 换成 `_720x1080x95`：tr-osdcp 域名不校验 hash 尺寸段，
 *     返回 720x1080 竖裁图（200）；img1 域名 hash 与尺寸绑定，返回 403。
 *     即竖版变体只对 tr-osdcp 有效，且是裁剪而非原图，故仅作兜底候选。
 *   - 去掉 hash 段的 URL（`..._960x1280x95.jpg`）一律 404，不可用。
 *   - CSV 图不足的景点用 Bing 图片搜索兜底（www.bing.com 会 302 到 cn.bing.com，
 *     需带 UA 跟重定向；解析 HTML 内 murl 直链。不带 qft 竖图过滤时结果相关，
 *     带 qft 反而混入无关图，故竖图判定在下载后按真实宽高做）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSV_DIR = path.join(ROOT, 'data', 'openbayes-attractions', 'extracted', 'citydata');
const OUT_DIR = path.join(ROOT, 'data', 'attraction-dataset');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_IMAGES_PER_SPOT = 5;
const CONCURRENCY = 4;
const TIMEOUT_MS = 15000;
const MAX_BYTES = 8 * 1024 * 1024;
// Bing 兜底：图片数不足该值或缺竖图时触发补采
const FILL_TARGET = 3;
// 图库/水印站域名过滤（搜索结果常混入带水印样图）
const STOCK_BLOCKLIST = [
  '699pic.com', 'ibaotu.com', 'baotu.com', 'hellorf.com', '16pic.com',
  '588ku.com', 'nipic.com', 'qiantu.com', '51miz.com', 'veer.com',
  'shutterstock.com', 'gettyimages.com', '163nn.com', 'tuchong.com'
];

/** 逐字符状态机解析 CSV：支持引号字段内换行与 "" 转义 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** 「名字」取开头连续中文段，如 龙门石窟Longmen Grottoes → 龙门石窟 */
function chineseName(raw) {
  const m = String(raw || '').trim().match(/^[\u4e00-\u9fa5·]+/);
  return m ? m[0] : String(raw || '').trim();
}

/** 文件名净化：去 Windows/POSIX 非法字符与首尾点，限长 */
function sanitizeName(name) {
  return (
    name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/\s+/g, '_')
      .replace(/^\.+|\.+$/g, '')
      .slice(0, 40) || 'spot'
  );
}

/** 从「图片链接」格提取 http(s) URL，按出现顺序去重，最多 5 个 */
function extractUrls(cell) {
  const found = String(cell || '').match(/https?:\/\/\S+/g) || [];
  const seen = new Set();
  const out = [];
  for (let u of found) {
    u = u.replace(/[)（）,，;"'\]]+$/, '');
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
    if (out.length >= MAX_IMAGES_PER_SPOT) break;
  }
  return out;
}

/** 原图 URL：把 .jpg 之后的变体后缀截掉；无后缀时返回 null */
function originalUrl(url) {
  const orig = url.replace(/\.jpg_[^/]*$/, '.jpg');
  return orig === url ? null : orig;
}

/** 竖版变体候选：_480x360x95 → _720x1080x95（仅 tr-osdcp 域名实测有效，见文件头结论） */
function portraitVariant(url) {
  return /_480x360x95/.test(url) ? url.replace('_480x360x95', '_720x1080x95') : null;
}

/** 解析 JPEG（SOF0/1/2）与 PNG（IHDR）真实宽高；其它格式返回 null */
function imageSize(buf) {
  if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return null;
  }
  if (
    buf.length > 24 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return null;
}

// 项目配图约束：竖图优先
function isPortrait(width, height) {
  return height >= 1000 && width >= 600 && width / height <= 1.2;
}

async function fetchImage(url, referer) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: referer || 'https://travel.qunar.com/' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const ct = res.headers.get('content-type') || '';
  if (!ct.startsWith('image/')) throw new Error('content-type ' + ct);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0 || buf.length > MAX_BYTES) throw new Error('size ' + buf.length);
  return buf;
}

/** 下载单个候选 URL（含 1 次重试）；返回 buf 或 null */
async function downloadWithRetry(url, referer) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetchImage(url, referer);
    } catch (e) {
      if (attempt === 1) {
        console.log('    失败 ' + url + ' : ' + e.message);
        return null;
      }
    }
  }
  return null;
}

/**
 * Bing 图片搜索取候选直链。实测（2026-11）：结果项 m= 属性 JSON 含 murl/t（标题）
 * 但无 w/h 元数据；「地名」或「地名 景点」查询相关（标题含名率 15/15），
 * 三词以上组合（如 地名 手机壁纸）会整体跑题，故只发短查询并按标题字符重合度过滤；
 * 不带 qft 竖图过滤（混入无关图），竖图判定在下载后按真实宽高做。
 */
async function bingImageCandidates(query, name, limit) {
  const url =
    'https://cn.bing.com/images/search?q=' +
    encodeURIComponent(query) +
    '&form=HDRSC2&first=1';
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const html = await res.text();
  const strong = [];
  const seen = new Set();
  // 标题相关性：景点名至少一半字符出现在标题中（全名强匹配太严——如「龙门石窟」
  // 的图常题为「卢舍那大佛」；而跑题页标题几乎不含任何重合字符）
  const need = Math.max(1, Math.ceil(name.length / 2));
  const re = /&quot;murl&quot;:&quot;(https?:\/\/[\s\S]*?)&quot;[\s\S]{0,500}?&quot;t&quot;:&quot;([\s\S]*?)&quot;/g;
  let m;
  while ((m = re.exec(html))) {
    const u = m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    const title = m[2].replace(/&amp;/g, '&');
    let overlap = 0;
    for (const ch of new Set(name)) if (title.includes(ch)) overlap++;
    if (overlap < need) continue;
    const host = (() => { try { return new URL(u).hostname; } catch { return ''; } })();
    if (!host || STOCK_BLOCKLIST.some((d) => host.endsWith(d))) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    strong.push(u);
    if (strong.length >= limit) break;
  }
  return strong;
}

/**
 * 采集一个景点的图片：每个源 URL 依次尝试 原图 → 变体 → 竖版变体，
 * 命中即止；同景点内按内容 sha1 去重。
 * 若最终不足 FILL_TARGET 张或缺竖图，用 Bing 图片搜索兜底补采。
 * 返回 { images, failed }
 */
async function collectSpotImages(name, city, spotUrls, spotDir) {
  const images = [];
  const failed = [];
  const sha1s = new Set();

  const saveImage = (buf, source) => {
    const digest = crypto.createHash('sha1').update(buf).digest('hex');
    if (sha1s.has(digest)) return true; // 重复图视为已处理
    sha1s.add(digest);
    const size = imageSize(buf);
    const file = path
      .relative(OUT_DIR, path.join(spotDir, (images.length + 1) + '.jpg'))
      .replace(/\\/g, '/');
    fs.mkdirSync(spotDir, { recursive: true });
    fs.writeFileSync(path.join(spotDir, (images.length + 1) + '.jpg'), buf);
    images.push({
      file,
      width: size ? size.width : null,
      height: size ? size.height : null,
      bytes: buf.length,
      portrait: size ? isPortrait(size.width, size.height) : false,
      source
    });
    return true;
  };

  for (const url of spotUrls) {
    const candidates = [originalUrl(url), url, portraitVariant(url)].filter(
      (u, idx, arr) => u && arr.indexOf(u) === idx
    );
    let buf = null;
    for (const cand of candidates) {
      buf = await downloadWithRetry(cand);
      if (buf) break;
    }
    if (!buf) {
      failed.push(url);
      continue;
    }
    saveImage(buf, 'qunar');
    if (images.length >= MAX_IMAGES_PER_SPOT) break;
  }

  // Bing 兜底：数量不足或无竖图时补采
  const needFill = images.length < FILL_TARGET || !images.some((im) => im.portrait);
  if (needFill) {
    const queries = [name, name + ' 景点', name + ' ' + city];
    for (const q of queries) {
      if (images.length >= MAX_IMAGES_PER_SPOT) break;
      if (images.length >= FILL_TARGET && images.some((im) => im.portrait)) break;
      let cands;
      try {
        cands = await bingImageCandidates(q, name, 8);
      } catch (e) {
        console.log('  [' + name + '] Bing 搜索失败：' + e.message);
        break;
      }
      for (const cUrl of cands) {
        if (images.length >= MAX_IMAGES_PER_SPOT) break;
        if (images.length >= FILL_TARGET && images.some((im) => im.portrait)) break;
        const buf = await downloadWithRetry(cUrl, 'https://www.bing.com/');
        if (buf) saveImage(buf, 'bing');
      }
      await new Promise((r) => setTimeout(r, 400)); // 轻度限速
    }
  }
  return { images, failed };
}

/** 并发 ≤CONCURRENCY 的任务池 */
async function runPool(tasks, limit) {
  const queue = tasks.slice();
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const task = queue.shift();
      await task();
    }
  });
  await Promise.all(workers);
}

async function collectCity(city) {
  const csvPath = path.join(CSV_DIR, city + '.csv');
  if (!fs.existsSync(csvPath)) {
    console.error('找不到 CSV：' + csvPath);
    return null;
  }
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const header = rows[0];
  const col = (name) => header.indexOf(name);
  const spots = rows.slice(1).filter((r) => (r[col('名字')] || '').trim());

  const cityDir = path.join(OUT_DIR, city);
  fs.mkdirSync(cityDir, { recursive: true });
  // 重跑前清空旧图目录，保证文件编号与 index.jsonl 一致
  fs.rmSync(path.join(cityDir, 'images'), { recursive: true, force: true });

  const records = new Array(spots.length);
  const failedCounts = new Array(spots.length).fill(0);
  let done = 0;
  const jobs = spots.map((row, i) => async () => {
    const name = chineseName(row[col('名字')]);
    const spotDir = path.join(cityDir, 'images', String(i + 1).padStart(2, '0') + '-' + sanitizeName(name));
    const urls = extractUrls(row[col('图片链接')]);
    const { images, failed } = await collectSpotImages(name, city, urls, spotDir);
    failedCounts[i] = failed.length;
    records[i] = {
      name,
      city,
      qunar_url: (row[col('链接')] || '').trim(),
      address: (row[col('地址')] || '').trim(),
      intro: (row[col('介绍')] || '').trim(),
      open_time: (row[col('开放时间')] || '').trim(),
      rating: (row[col('评分')] || '').trim(),
      suggest_time: (row[col('建议游玩时间')] || '').trim(),
      suggest_season: (row[col('建议季节')] || '').trim(),
      ticket: (row[col('门票')] || '').trim(),
      tips: (row[col('小贴士')] || '').trim(),
      images,
      portrait_count: images.filter((im) => im.portrait).length,
      collected_at: new Date().toISOString()
    };
    if (failed.length) {
      console.log('  [' + name + '] 图片下载失败 ' + failed.length + ' 个 URL');
    }
    done++;
    if (done % 10 === 0 || done === spots.length) {
      console.log('  进度 ' + done + '/' + spots.length);
    }
  });
  await runPool(jobs, CONCURRENCY);

  fs.writeFileSync(path.join(cityDir, 'index.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  const imagesOk = records.reduce((n, r) => n + r.images.length, 0);
  const imagesFailed = failedCounts.reduce((n, x) => n + x, 0);
  const spotsWithPortrait = records.filter((r) => r.portrait_count > 0).length;
  const bingImages = records.reduce(
    (n, r) => n + r.images.filter((im) => im.source === 'bing').length,
    0
  );
  const dataset = {
    city,
    spots: records.length,
    images_ok: imagesOk,
    images_bing: bingImages,
    images_failed: imagesFailed,
    spots_with_portrait: spotsWithPortrait,
    note: '图片来自 qunarzz CDN（优先原图，截掉 .jpg_ 变体后缀）+ Bing 图片搜索兜底（不足3张或缺竖图时补采，source=bing）；portrait=竖图(高≥1000且宽≥600且宽高比≤1.2)'
  };
  fs.writeFileSync(path.join(cityDir, 'dataset.json'), JSON.stringify(dataset, null, 2) + '\n', 'utf8');
  console.log(
    city + '：景点 ' + records.length + '，图片 ' + imagesOk + '，含竖图景点 ' + spotsWithPortrait
  );
  return { records, cityDir };
}

async function main() {
  const cities = process.argv.slice(2);
  if (!cities.length) {
    console.error('用法：node tools/collect-attractions.mjs 洛阳 [郑州 ...]');
    process.exit(1);
  }
  for (const city of cities) {
    await collectCity(city);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
