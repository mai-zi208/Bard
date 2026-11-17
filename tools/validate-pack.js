#!/usr/bin/env node
/**
 * 资源包校验：按 docs/技术方案.md §3.5 执行。
 *
 * 用法：
 *   node tools/validate-pack.js                 # 校验 miniprogram/packs 下全部资源包
 *   node tools/validate-pack.js baimasi         # 只校验指定包
 *   node tools/validate-pack.js --dir cdn       # 校验发布目录（在线包）
 *
 * 退出码：0 通过（可能有警告）；1 存在阻断性错误。
 */

const fs = require('fs');
const path = require('path');

const MP_DIR = path.resolve(__dirname, '..', 'miniprogram');
const PACKS_DIR = path.join(MP_DIR, 'packs');
const COVERS_DIR = path.join(MP_DIR, 'covers');
const APP_JSON = path.join(MP_DIR, 'app.json');

const LIMITS = {
  packOnline: 3 * 1024 * 1024,
  packSubpackage: 2 * 1024 * 1024,
  cover: 200 * 1024,
  coverThumb: 80 * 1024,
  scene: 400 * 1024,
  narrator: 150 * 1024,
  portrait: 90 * 1024,
  inlineImage: 300 * 1024,
  inlineScene: 600 * 1024,
};

const SCENE_MIN = 5;
const SCENE_MAX = 40;
const BODY_MAX_CHARS = 20000;
const POI_MAX = 20;
const POI_TYPES = ['service', 'food', 'exit', 'sight'];
const TRANSITIONS = ['zoom-out', 'rise', 'slide', 'fade'];
const POSES = ['default', 'explain', 'point', 'think'];
/** 母本 id 为「景点slug」，人物变体为「景点slug--人物slug」，允许一到两个连字符分段 */
const ID_RE = /^[a-z0-9]+(-{1,2}[a-z0-9]+)*$/;

const errors = [];
const warnings = [];

function error(where, message) {
  errors.push(`[错误] ${where}：${message}`);
}

function warn(where, message) {
  warnings.push(`[警告] ${where}：${message}`);
}

/** 本地化字段：纯字符串 / 字符串数组，或 { locale: value } */
function readLocalized(value, locale, where, label, list) {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    if (!value.every((v) => typeof v === 'string')) {
      error(where, `${label} 数组内必须全部为字符串`);
      return undefined;
    }
    return value;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.includes(locale)) {
      error(where, `${label} 使用对象形态但缺少 defaultLocale(${locale}) 的值`);
    }
    if (keys.length === 1) {
      warn(where, `${label} 使用对象形态但只包含一种语言，建议改为纯字符串形态`);
    }
    const picked = value[locale];
    if (list) {
      if (!Array.isArray(picked) || !picked.every((v) => typeof v === 'string')) {
        error(where, `${label} 在 ${locale} 下必须是字符串数组`);
        return undefined;
      }
      return picked;
    }
    if (typeof picked !== 'string') {
      error(where, `${label} 在 ${locale} 下必须是字符串`);
      return undefined;
    }
    return picked;
  }
  error(where, `${label} 类型不符，应为字符串${list ? '数组' : ''}或本地化对象`);
  return undefined;
}

/** 幕内分页：字符串数组的数组，或 { locale: [[...]] } */
function readPages(value, locale, where) {
  if (value === undefined) return undefined;
  let raw = value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    raw = value[locale];
    if (raw === undefined) {
      error(where, 'pages 使用对象形态但缺少 defaultLocale 的值');
      return undefined;
    }
  }
  const valid =
    Array.isArray(raw) &&
    raw.every((page) => Array.isArray(page) && page.every((p) => typeof p === 'string'));
  if (!valid) {
    error(where, 'pages 应为「每页为字符串数组」的数组');
    return undefined;
  }
  return raw;
}

/** 单块规格：≤60 字、无首尾空格、无连续空行 */
function checkBlocks(where, blocks) {
  blocks.forEach((p, pi) => {
    if (p.length > 60) warn(where, `第 ${pi + 1} 块超过 60 字：${p.length}`);
    if (p !== p.trim()) warn(where, `第 ${pi + 1} 块存在首尾空格`);
    if (/\n\s*\n/.test(p)) warn(where, `第 ${pi + 1} 块存在连续空行`);
  });
}

/** 极简图片尺寸读取（JPEG / PNG / WebP），用于校验图片规格 */
function imageSize(buf) {
  if (buf.length < 24) return null;

  if (buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buf[offset + 1];
      const len = buf.readUInt16BE(offset + 2);
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }
      offset += 2 + len;
    }
    return null;
  }

  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const type = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (type === 'VP8X') {
      return {
        width: buf.readUIntLE(start + 4, 3) + 1,
        height: buf.readUIntLE(start + 7, 3) + 1,
      };
    }
    if (type === 'VP8 ') {
      return {
        width: buf.readUInt16LE(start + 6) & 0x3fff,
        height: buf.readUInt16LE(start + 8) & 0x3fff,
      };
    }
    if (type === 'VP8L') {
      const bits = buf.readUInt32LE(start + 1);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    offset = start + size + (size % 2);
  }
  return null;
}

function checkAsset(packDir, packId, relPath, kind, where) {
  if (typeof relPath !== 'string' || !relPath) {
    error(where, `${kind} 文件路径为空`);
    return;
  }
  if (relPath.includes('..') || relPath.startsWith('/') || relPath.includes('\\')) {
    error(where, `${kind} 路径不合规（禁止路径穿越与绝对路径）：${relPath}`);
    return;
  }
  if (/\.webp$/i.test(relPath)) {
    warn(where, `${kind} 为 webp，真机 <image> 默认不解析，建议改为 jpg / png：${relPath}`);
  } else if (!/\.(jpe?g|png)$/i.test(relPath)) {
    warn(where, `${kind} 格式不在白名单（jpg / png）：${relPath}`);
  }
  const abs = path.join(packDir, relPath);
  if (!fs.existsSync(abs)) {
    error(where, `${kind} 文件不存在：${relPath}`);
    return;
  }
  const stat = fs.statSync(abs);
  const buf = fs.readFileSync(abs);
  const size = imageSize(buf);

  if (kind === '封面图') {
    if (stat.size > LIMITS.cover) error(where, `封面图超过 200KB：${(stat.size / 1024).toFixed(0)}KB`);
    if (size && (size.width < 900 || size.height < 1200)) {
      error(where, `封面图尺寸不足 900×1200：${size.width}×${size.height}`);
    }
  } else if (kind === '分镜图') {
    if (stat.size > LIMITS.scene) error(where, `分镜图超过 400KB：${(stat.size / 1024).toFixed(0)}KB`);
    if (size && size.width < 1080) {
      error(where, `分镜图宽度不足 1080：${size.width}×${size.height}`);
    }
    if (size && Math.abs(size.width / size.height - 9 / 16) > 0.02) {
      error(where, `分镜图不是 9:16：${size.width}×${size.height}`);
    }
  } else if (kind === '立绘') {
    if (stat.size > LIMITS.narrator) error(where, `立绘超过 150KB：${(stat.size / 1024).toFixed(0)}KB`);
    if (size && (size.width < 360 || size.width > 900)) {
      error(where, `立绘宽度应在 360–900 之间：${size.width}`);
    }
    if (size && size.height > 1400) {
      error(where, `立绘高度应 ≤1400：${size.height}`);
    }
  } else if (kind === '人物插画') {
    if (stat.size > LIMITS.portrait) error(where, `人物插画超过 90KB：${(stat.size / 1024).toFixed(0)}KB`);
    if (size && (size.width < 600 || size.width > 900)) {
      error(where, `人物插画宽度应在 600–900 之间：${size.width}`);
    }
    if (size && size.height > 1400) {
      error(where, `人物插画高度应 ≤1400：${size.height}`);
    }
    if (size && Math.abs(size.width / size.height - 3 / 4) > 0.03) {
      error(where, `人物插画不是 3:4：${size.width}×${size.height}`);
    }
  } else if (kind === '正文内嵌图') {
    if (stat.size > LIMITS.inlineImage) {
      error(where, `正文内嵌图超过 300KB：${(stat.size / 1024).toFixed(0)}KB`);
    }
    if (size && size.width > 1080) {
      error(where, `正文内嵌图宽度超过 1080：${size.width}`);
    }
  }
}

/** 去掉 Markdown 标记后统计正文字数 */
function markdownPlain(md) {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, '');
}

/** v2 单页正文：Markdown 白名单、内嵌图与字数 */
function checkBody(packDir, packId, scene, locale, where) {
  const rel = readLocalized(scene.body, locale, where, 'body', false);
  if (!rel) {
    error(where, 'v2 缺少 body');
    return;
  }
  if (!/\.md$/i.test(rel)) {
    error(where, `body 必须是 .md 文件：${rel}`);
    return;
  }
  if (rel.includes('..') || rel.startsWith('/') || rel.includes('\\')) {
    error(where, `body 路径不合规（禁止路径穿越与绝对路径）：${rel}`);
    return;
  }

  const abs = path.join(packDir, rel);
  if (!fs.existsSync(abs)) {
    error(where, `body 文件不存在：${rel}`);
    return;
  }

  const md = fs.readFileSync(abs, 'utf8');
  const plain = markdownPlain(md);
  if (!plain.length) error(where, 'body 为空');
  else if (plain.length > BODY_MAX_CHARS) {
    error(where, `单幕正文超过 ${BODY_MAX_CHARS} 字：${plain.length}`);
  } else if (plain.length < 150) {
    warn(where, `单幕正文少于 150 字，低于规范下限：${plain.length}`);
  }

  if (/^\s*\|.*\|\s*$/m.test(md)) error(where, 'body 含表格语法，白名单不支持');
  if (/```/.test(md)) error(where, 'body 含代码块，白名单不支持');
  if (/<[a-zA-Z/][^>]*>/.test(md)) error(where, 'body 含内嵌 HTML，白名单不支持');
  if (/\[\^[^\]]+\]/.test(md)) error(where, 'body 含脚注语法，白名单不支持');

  const imageRe = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
  let match;
  let count = 0;
  let total = 0;
  while ((match = imageRe.exec(md))) {
    const src = match[2];
    count += 1;
    if (/^(https?:)?\/\//.test(src) || /^data:/.test(src)) {
      error(where, `正文图片禁止外链：${src}`);
      continue;
    }
    if (src.startsWith('/') || src.includes('..') || src.includes('\\')) {
      error(where, `正文图片路径不合规：${src}`);
      continue;
    }
    const imgAbs = path.join(packDir, src);
    if (!fs.existsSync(imgAbs)) {
      error(where, `正文图片不存在：${src}`);
      continue;
    }
    const stat = fs.statSync(imgAbs);
    if (stat.size > LIMITS.inlineImage) {
      error(where, `正文图片超过 300KB：${src} ${(stat.size / 1024).toFixed(0)}KB`);
    }
    total += stat.size;
    const size = imageSize(fs.readFileSync(imgAbs));
    if (size && size.width > 1080) error(where, `正文图片宽度超过 1080：${src} ${size.width}`);
    if (!/\.(jpe?g|png)$/i.test(src)) warn(where, `正文图片建议使用 jpg / png：${src}`);
  }
  if (!count) warn(where, '正文没有内嵌图');
  if (total > LIMITS.inlineScene) {
    error(where, `单幕正文图片合计超过 600KB：${(total / 1024).toFixed(0)}KB`);
  }

  if (scene.images !== undefined) {
    if (!Array.isArray(scene.images) || !scene.images.every((v) => typeof v === 'string')) {
      error(where, 'images 必须是字符串数组');
    } else {
      scene.images.forEach((src) =>
        checkAsset(packDir, packId, src, '正文内嵌图', `${where}.images`)
      );
    }
  }
}

/**
 * 通用场景点位（可选）：浮窗回答周边与餐饮的数据来源。
 * 旧包不写 pois 不报错；sceneId 可省略，省略时只用于全包层面的回答。
 */
function checkPois(pack, locale, whereBase, sceneIds) {
  const pois = pack.pois;
  if (pois === undefined) return;

  if (!Array.isArray(pois)) {
    error(whereBase, 'pois 必须是数组');
    return;
  }
  if (pois.length > POI_MAX) error(whereBase, `pois 超过 ${POI_MAX} 条：${pois.length}`);

  const ids = new Set();
  pois.forEach((poi, i) => {
    const where = `${whereBase} pois[${i}]${poi && poi.id ? '(' + poi.id + ')' : ''}`;
    if (!poi || typeof poi !== 'object') {
      error(where, '点位必须是对象');
      return;
    }

    if (typeof poi.id !== 'string' || !ID_RE.test(poi.id)) {
      error(where, 'id 缺失或命名不合规（小写字母、数字、连字符）');
    } else if (ids.has(poi.id)) {
      error(where, `id 重复：${poi.id}`);
    } else {
      ids.add(poi.id);
    }

    const name = readLocalized(poi.name, locale, where, 'name', false);
    if (!name) error(where, '缺少 name');
    else if (name.length > 12) error(where, `name 超过 12 字：${name.length}`);

    if (!POI_TYPES.includes(poi.type)) {
      error(where, `type 取值非法：${poi.type}（可选 ${POI_TYPES.join(' / ')}）`);
    }

    const desc = readLocalized(poi.desc, locale, where, 'desc', false);
    if (!desc) warn(where, '缺少 desc');
    else if (desc.length > 60) error(where, `desc 超过 60 字：${desc.length}`);

    const walk = readLocalized(poi.walk, locale, where, 'walk', false);
    if (walk && walk.length > 40) error(where, `walk 超过 40 字：${walk.length}`);

    if (poi.sceneId !== undefined) {
      if (typeof poi.sceneId !== 'string' || !sceneIds.has(poi.sceneId)) {
        error(where, `sceneId 指向不存在的幕：${poi.sceneId}`);
      }
    }
  });
}

function validatePack(packDir, allIds) {
  const meta = path.basename(packDir);
  const isBuiltin = packDir.indexOf(PACKS_DIR + path.sep) === 0;
  const packPath = path.join(packDir, 'pack.json');
  if (!fs.existsSync(packPath)) {
    error(meta, '缺少 pack.json');
    return;
  }

  let pack;
  try {
    pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
  } catch (err) {
    error(meta, `pack.json 不是合法 JSON：${err.message}`);
    return;
  }

  const whereBase = pack.id || meta;

  if (typeof pack.id !== 'string' || !ID_RE.test(pack.id)) {
    error(whereBase, 'id 缺失或不符合命名规则（小写字母、数字、连字符）');
  } else if (pack.id !== meta) {
    error(whereBase, `id 必须与目录名一致：目录为 ${meta}`);
  } else if (allIds.has(pack.id)) {
    error(whereBase, `id 与其他资源包重复：${pack.id}`);
  } else {
    allIds.add(pack.id);
  }

  const version = pack.schemaVersion;
  if (version !== 1 && version !== 2) error(whereBase, 'schemaVersion 必须为 1 或 2');
  const v2 = version === 2;
  if (typeof pack.defaultLocale !== 'string' || !pack.defaultLocale) {
    error(whereBase, 'defaultLocale 缺失');
  }
  const locale = pack.defaultLocale;

  if (pack.locales !== undefined) {
    if (!Array.isArray(pack.locales) || !pack.locales.every((l) => typeof l === 'string')) {
      error(whereBase, 'locales 必须是字符串数组');
    } else if (locale && !pack.locales.includes(locale)) {
      error(whereBase, 'defaultLocale 不在 locales 声明内');
    }
  }

  const title = readLocalized(pack.title, locale, whereBase, 'title', false);
  if (!title) error(whereBase, '缺少标题 title');
  else if (title.length > 20) error(whereBase, `title 超过 20 字：${title.length}`);

  const subtitle = readLocalized(pack.subtitle, locale, whereBase, 'subtitle', false);
  if (!subtitle) warn(whereBase, '缺少 subtitle');
  else if (subtitle.length > 30) error(whereBase, `subtitle 超过 30 字：${subtitle.length}`);

  const summary = readLocalized(pack.summary, locale, whereBase, 'summary', false);
  if (summary && summary.length > 60) error(whereBase, `summary 超过 60 字：${summary.length}`);

  if (!pack.theme || typeof pack.theme !== 'object') {
    warn(whereBase, '缺少 theme，将使用全局主题');
  } else {
    ['bg', 'text', 'accent'].forEach((key) => {
      if (!/^#[0-9a-fA-F]{6}$/.test(pack.theme[key] || '')) {
        error(whereBase, `theme.${key} 必须是三位或六位十六进制色值`);
      }
    });
  }

  if (pack.tags !== undefined) {
    if (!Array.isArray(pack.tags) || pack.tags.length > 5) error(whereBase, 'tags 必须是最多 5 项的数组');
  }

  if (typeof pack.cover !== 'string' || !pack.cover) {
    error(whereBase, '缺少封面 cover');
  } else {
    checkAsset(packDir, pack.id, pack.cover, '封面图', whereBase);
  }

  if (pack.narrator !== undefined) {
    const n = pack.narrator;
    if (typeof n !== 'object' || !n.id || !ID_RE.test(n.id)) {
      error(whereBase, 'narrator.id 缺失或命名不合规');
    }
    const name = readLocalized(n.name, locale, whereBase, 'narrator.name', false);
    if (!name) error(whereBase, 'narrator.name 缺失');
    else if (name.length > 8) error(whereBase, `narrator.name 超过 8 字：${name.length}`);

    const ntitle = readLocalized(n.title, locale, whereBase, 'narrator.title', false);
    if (ntitle && ntitle.length > 12) error(whereBase, `narrator.title 超过 12 字：${ntitle.length}`);

    // 全局立绘可选；旧包仍可只按幕提供 scenes[].portrait
    if (n.portraits !== undefined) {
      if (!n.portraits || typeof n.portraits !== 'object') {
        error(whereBase, 'narrator.portraits 必须是对象');
      } else {
        if (!n.portraits.default) error(whereBase, 'narrator.portraits 至少提供 default');
        Object.keys(n.portraits).forEach((key) => {
          if (!POSES.includes(key)) error(whereBase, `未知立绘姿态：${key}`);
          checkAsset(packDir, pack.id, n.portraits[key], '立绘', `${whereBase} narrator.portraits.${key}`);
        });
      }
    }
    if (n.portraitMask !== undefined && typeof n.portraitMask !== 'boolean') {
      error(whereBase, 'narrator.portraitMask 必须是布尔值');
    }
  }

  const scenes = pack.scenes;
  if (!Array.isArray(scenes)) {
    error(whereBase, 'scenes 必须是数组');
    return;
  }
  if (scenes.length < SCENE_MIN || scenes.length > SCENE_MAX) {
    error(whereBase, `scenes 数量应在 ${SCENE_MIN}–${SCENE_MAX} 之间，当前 ${scenes.length}`);
  }

  const sceneIds = new Set();
  scenes.forEach((scene, i) => {
    const where = `${whereBase} scenes[${i}]${scene && scene.id ? '(' + scene.id + ')' : ''}`;
    if (!scene || typeof scene !== 'object') {
      error(where, '场景必须是对象');
      return;
    }
    if (typeof scene.id !== 'string' || !ID_RE.test(scene.id)) {
      error(where, 'scene.id 缺失或命名不合规');
    } else if (sceneIds.has(scene.id)) {
      error(where, `scene.id 重复：${scene.id}`);
    } else {
      sceneIds.add(scene.id);
    }

    const sTitle = readLocalized(scene.title, locale, where, 'title', false);
    if (!sTitle) error(where, '缺少 title');
    else if (sTitle.length > 12) error(where, `title 超过 12 字：${sTitle.length}`);

    const sSub = readLocalized(scene.subtitle, locale, where, 'subtitle', false);
    if (!sSub) warn(where, '缺少 subtitle');
    else if (sSub.length > 20) error(where, `subtitle 超过 20 字：${sSub.length}`);

    const alt = readLocalized(scene.imageAlt, locale, where, 'imageAlt', false);
    if (alt && alt.length > 40) error(where, `imageAlt 超过 40 字：${alt.length}`);

    if (typeof scene.image !== 'string' || !scene.image) {
      error(where, '缺少 image');
    } else {
      checkAsset(packDir, pack.id, scene.image, '分镜图', `${where}.image`);
    }

    if (scene.portrait !== undefined) {
      checkAsset(packDir, pack.id, scene.portrait, '人物插画', `${where}.portrait`);
    }

    if (v2) {
      checkBody(packDir, pack.id, scene, locale, where);
    } else {
      const paragraphs = readLocalized(scene.paragraphs, locale, where, 'paragraphs', true);
      const pages = readPages(scene.pages, locale, where);

      if (pages) {
        if (pages.length > 3) error(where, `pages 超过 3 页：${pages.length}`);
        pages.forEach((page, pi) => {
          const at = `${where}.pages[${pi}]`;
          if (!page.length) {
            error(where, `第 ${pi + 1} 屏为空`);
            return;
          }
          if (page.length > 3) error(where, `第 ${pi + 1} 屏超过 3 块：${page.length}`);
          checkBlocks(at, page);
          const total = page.reduce((sum, p) => sum + p.length, 0);
          if (total > 160) warn(where, `第 ${pi + 1} 屏合计超过 160 字：${total}`);
        });
      } else if (!paragraphs || !paragraphs.length) {
        error(where, 'paragraphs 与 pages 至少提供一个');
      } else {
        if (paragraphs.length > 3) error(where, `paragraphs 超过 3 块：${paragraphs.length}`);
        checkBlocks(where, paragraphs);
        const total = paragraphs.reduce((sum, p) => sum + p.length, 0);
        if (total > 160) warn(where, `paragraphs 合计超过 160 字：${total}`);
      }
    }

    if (scene.transition !== undefined && !TRANSITIONS.includes(scene.transition)) {
      error(where, `transition 取值非法：${scene.transition}`);
    }
    if (scene.narratorPose !== undefined && !POSES.includes(scene.narratorPose)) {
      error(where, `narratorPose 取值非法：${scene.narratorPose}`);
    }
    if (scene.holdMs !== undefined) {
      if (typeof scene.holdMs !== 'number' || scene.holdMs < 2000 || scene.holdMs > 15000) {
        error(where, 'holdMs 必须是 2000–15000 的数字');
      }
    }
  });

  checkPois(pack, locale, whereBase, sceneIds);

  // 人物插画不再按幕强制：新包整包共用 narrator.portraits，旧包的 scenes[].portrait 仍按单张校验

  // 整包体积
  let total = 0;
  (function walk(dir) {
    fs.readdirSync(dir).forEach((name) => {
      const abs = path.join(dir, name);
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) walk(abs);
      else total += stat.size;
    });
  })(packDir);

  if (total > LIMITS.packOnline) {
    error(whereBase, `整包体积超过 3MB：${(total / 1024 / 1024).toFixed(2)}MB`);
  } else if (isBuiltin && total > LIMITS.packSubpackage) {
    error(
      whereBase,
      `内置分包体积超过 2MB：${(total / 1024 / 1024).toFixed(2)}MB，请压低分镜图质量`
    );
  } else if (!isBuiltin && total > LIMITS.packSubpackage) {
    warn(whereBase, `整包体积超过 2MB：${(total / 1024 / 1024).toFixed(2)}MB，如需内置到分包请再压缩`);
  } else {
    console.log(`  ${whereBase} 整包 ${(total / 1024).toFixed(0)}KB，${scenes.length} 幕`);
  }
}

/**
 * 内置包的分包布局：每个包在 app.json 声明 root=packs/{id}、name=pack-{id}，
 * 列表封面放在主包 covers/{id}.jpg（≤80KB），避免进列表就下载全部分包。
 */
function checkSubpackageLayout(dirs) {
  let app;
  try {
    app = JSON.parse(fs.readFileSync(APP_JSON, 'utf8'));
  } catch (err) {
    error('app.json', `无法读取：${err.message}`);
    return;
  }

  const declared = {};
  (app.subPackages || app.subpackages || []).forEach((item) => {
    if (item && item.name) declared[item.name] = item.root;
  });

  dirs.forEach((dir) => {
    const id = path.basename(dir);
    const root = 'packs/' + id;
    const name = 'pack-' + id;
    if (declared[name] !== root) {
      error(id, `app.json 未声明资源分包 ${name}（root 应为 ${root}）`);
    }

    const cover = path.join(COVERS_DIR, id + '.jpg');
    if (!fs.existsSync(cover)) {
      error(id, `主包封面缺失：covers/${id}.jpg`);
      return;
    }
    const size = fs.statSync(cover).size;
    if (size > LIMITS.coverThumb) {
      error(id, `主包封面超过 80KB：covers/${id}.jpg ${(size / 1024).toFixed(0)}KB`);
    }
  });
}

function main() {
  const args = process.argv.slice(2);
  let packsDir = PACKS_DIR;
  let target = null;

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--dir' && args[i + 1]) {
      packsDir = path.resolve(args[i + 1]);
      i += 1;
    } else {
      target = args[i];
    }
  }

  if (!fs.existsSync(packsDir)) {
    console.error(`找不到资源包目录：${packsDir}`);
    process.exit(1);
  }

  const dirs = fs
    .readdirSync(packsDir)
    .map((name) => path.join(packsDir, name))
    .filter((dir) => fs.statSync(dir).isDirectory())
    // .backup/.tmp 是发布过程目录，不是资源包
    .filter((dir) => path.basename(dir).charAt(0) !== '.')
    // 无 pack.json 的目录不参与校验：cdn/audio 是包外音频根，不是资源包
    .filter((dir) => fs.existsSync(path.join(dir, 'pack.json')));

  const allIds = new Set();
  if (path.resolve(packsDir) === PACKS_DIR) checkSubpackageLayout(dirs);
  dirs
    .filter((dir) => !target || path.basename(dir) === target)
    .forEach((dir) => {
      console.log(`校验 ${path.basename(dir)} …`);
      validatePack(dir, allIds);
    });

  warnings.forEach((w) => console.warn(w));
  errors.forEach((e) => console.error(e));

  console.log(`\n结果：${errors.length} 个错误，${warnings.length} 个警告`);
  process.exit(errors.length ? 1 : 0);
}

main();
