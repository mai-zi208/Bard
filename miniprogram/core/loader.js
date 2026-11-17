/**
 * 资源包读取层：页面不直接接触 pack.json。
 * 数据源为 packs/registry.js（由 tools/build-pack.js 生成）。
 */
const registry = require('../packs/registry.js');
const config = require('../config.js');

const CN_NUM = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖', '拾'];
const CN_PLAIN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const DEFAULT_LOCALE = 'zh-CN';
const DEFAULT_PACK = 'baimasi';
/** 内置包各自是一个资源分包，根目录 packs/{id}，分包名 pack-{id} */
const SUBPACKAGE_PREFIX = 'pack-';
/** 列表封面放在主包，避免进入列表就下载全部分包 */
const BUILTIN_COVER_DIR = '/covers/';
/** v1 多屏 / v2 单页 Markdown 都支持 */
const SUPPORTED_SCHEMA_VERSIONS = [1, 2];

/** 结构不可用或版本未知时拒绝渲染，避免白屏 */
function isSupported(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (!Array.isArray(raw.scenes) || !raw.scenes.length) return false;
  const version = raw.schemaVersion;
  return version === undefined || version === null || SUPPORTED_SCHEMA_VERSIONS.indexOf(version) >= 0;
}

/** 本地化字段：纯字符串 / 数组 / { locale: value } 三级回退 */
function pick(value, locale) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.slice();
  if (typeof value === 'object') {
    if (value[locale] !== undefined) return value[locale];
    if (value[DEFAULT_LOCALE] !== undefined) return value[DEFAULT_LOCALE];
    const keys = Object.keys(value);
    return keys.length ? value[keys[0]] : '';
  }
  return '';
}

/** 幕内分页：pages 优先，paragraphs 视为单屏 */
function toPages(scene, locale) {
  const pages = pick(scene.pages, locale);
  if (Array.isArray(pages) && pages.length) {
    return pages
      .map((page, i) => ({ index: i, paras: Array.isArray(page) ? page.slice() : [] }))
      .filter((page) => page.paras.length);
  }
  const paragraphs = pick(scene.paragraphs, locale);
  return Array.isArray(paragraphs) && paragraphs.length
    ? [{ index: 0, paras: paragraphs }]
    : [];
}

/**
 * v2 正文：内置包用 registry 内联的 bodies；已下载在线包直接读本地 md。
 * 读不到时返回空串，由组件退回段落结构，不阻断渲染。
 */
function readBody(scene, locale, bodies, localDir) {
  const rel = pick(scene.body, locale);
  if (typeof rel !== 'string' || !rel) return '';
  if (localDir) {
    try {
      return wx.getFileSystemManager().readFileSync(localDir + '/' + rel, 'utf-8');
    } catch (err) {
      return '';
    }
  }
  return (bodies && bodies[scene.id]) || '';
}

/** 去掉 Markdown 标记，供结束页取一句收尾 */
function plainText(md) {
  return String(md || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 幕讲解音频：元数据来自 pack.json 的 scene.audio，MP3 发布在包外 cdn/audio/{packId}/。
 * 本地已下载则优先离线播放，否则走 CDN 流播。
 * 本地目录在 USER_DATA_PATH/audio/{packId}/，独立于包目录，避免包更新换入时被清掉。
 */
function sceneAudio(packId, sceneId, meta) {
  const file = 'scene-' + sceneId + '.mp3';
  const local = wx.env.USER_DATA_PATH + '/audio/' + packId + '/' + file;
  let localPath = '';
  try {
    wx.getFileSystemManager().accessSync(local);
    localPath = local;
  } catch (err) {
    localPath = '';
  }
  // CDN_BASE 留空时没有在线音频；本地也没有就当作无音频，避免请求相对路径必然失败
  const remoteUrl = config.CDN_BASE ? config.CDN_BASE + '/audio/' + packId + '/' + file : '';
  if (!remoteUrl && !localPath) return null;
  return {
    durSec: meta.durSec || 0,
    bytes: meta.bytes || 0,
    sha256: meta.sha256 || '',
    localPath: localPath,
    remoteUrl: remoteUrl
  };
}

function decorate(pack, locale, baseUrl, bodies, localDir) {
  const root = baseUrl || '/packs/' + pack.id + '/';
  const narrator = pack.narrator
    ? {
        id: pack.narrator.id,
        name: pick(pack.narrator.name, locale),
        title: pick(pack.narrator.title, locale),
        portraits: pack.narrator.portraits || {},
        /** 全局立绘是 3:4 完整画面时置真，避免被当成裁切立绘拉伸 */
        portraitFit: pack.narrator.portraitFit === true,
        /** 生成包只有一张不透明插画，需要四边羽化才能溶进背景照片 */
        portraitMask: pack.narrator.portraitMask === true
      }
    : null;

  const rawScenes = Array.isArray(pack.scenes) ? pack.scenes : [];
  const total = rawScenes.length;
  const totalLabel = CN_NUM[total] || String(total);
  const totalLabelPlain = CN_PLAIN[total] || String(total);

  const scenes = rawScenes.map((scene, i) => {
    const pose = scene.narratorPose || 'default';
    // 按幕插画优先；旧包继续用讲述人的全局立绘
    const portrait = scene.portrait
      ? scene.portrait
      : narrator && (narrator.portraits[pose] || narrator.portraits.default);
    const pages = toPages(scene, locale);
    const body = readBody(scene, locale, bodies, localDir);

    return {
      id: scene.id,
      index: i,
      indexLabel: CN_NUM[i + 1] || String(i + 1),
      totalLabel: totalLabel,
      title: pick(scene.title, locale),
      subtitle: pick(scene.subtitle, locale),
      imageUrl: root + scene.image,
      imageAlt: pick(scene.imageAlt, locale),
      pages: pages,
      paragraphs: (pages[0] && pages[0].paras) || [],
      /** v2 正文 Markdown（原始文本），空串时渲染层走 pages / paragraphs */
      body: body,
      /** 正文内图片的相对路径基址 */
      bodyBase: root,
      transition: scene.transition || 'zoom-out',
      holdMs: scene.holdMs || 6000,
      /** 幕讲解音频；无 audio 元数据时为 null，按钮置灰 */
      audio: scene.audio ? sceneAudio(pack.id, scene.id, scene.audio) : null,
      portraitUrl: portrait ? root + portrait : '',
      /** 按幕插画与 3:4 完整立绘都要完整显示，不裁切 */
      portraitFit: !!scene.portrait || !!(narrator && narrator.portraitFit),
      /** 不透明插画需要四边羽化；透明抠图立绘本身边缘已柔和 */
      portraitMask: !!scene.portrait || !!(narrator && narrator.portraitMask)
    };
  });

  // 通用场景点位：可选，供浮窗回答周边与餐饮；旧包无此字段时为空数组
  const pois = (Array.isArray(pack.pois) ? pack.pois : [])
    .map((poi) => {
      if (!poi || typeof poi !== 'object') return null;
      const sceneId = typeof poi.sceneId === 'string' ? poi.sceneId : '';
      const at = sceneId ? rawScenes.findIndex((scene) => scene && scene.id === sceneId) : -1;
      return {
        id: poi.id,
        name: pick(poi.name, locale),
        type: poi.type || 'sight',
        desc: pick(poi.desc, locale),
        walk: pick(poi.walk, locale),
        sceneId: sceneId,
        sceneIndex: at,
        sceneTitle: at >= 0 ? pick(rawScenes[at].title, locale) : ''
      };
    })
    .filter((poi) => poi && poi.id && poi.name);

  const title = pick(pack.title, locale);
  const shortTitle = title.length > 4 ? title.slice(2) : title;
  const first = scenes[0];
  let quote = '';
  if (first && first.body) {
    // v2：取首幕正文最后一句收尾
    const sentences = plainText(first.body)
      .split(/[。！？!?]/)
      .map((item) => item.trim())
      .filter(Boolean);
    quote = (sentences.length ? sentences[sentences.length - 1] : '').slice(0, 40) + '。';
  } else {
    const tailPage = first && first.pages.length ? first.pages[first.pages.length - 1] : null;
    quote =
      tailPage && tailPage.paras.length
        ? tailPage.paras[tailPage.paras.length - 1]
        : '';
  }

  return {
    id: pack.id,
    schemaVersion: pack.schemaVersion,
    /** 内容版本：音频缓存按它判断是否需要重下 */
    version: pack.version || 1,
    defaultLocale: pack.defaultLocale,
    title: title,
    shortTitle: shortTitle,
    subtitle: pick(pack.subtitle, locale),
    summary: pick(pack.summary, locale),
    author: pack.author || '',
    aiGenerated: pack.generated === true || pack.aiGenerated === true,
    tags: Array.isArray(pack.tags) ? pack.tags.slice(0, 5) : [],
    theme: pack.theme || null,
    coverUrl: root + pack.cover,
    sealChar: shortTitle.charAt(0),
    total: total,
    totalLabel: totalLabel,
    totalLabelPlain: totalLabelPlain,
    narratorName: narrator ? narrator.name : '',
    narratorTitle: narrator ? narrator.title : '',
    quote: quote,
    pois: pois,
    scenes: scenes
  };
}

function getPack(id, locale) {
  const target = id || DEFAULT_PACK;
  const raw = registry.find((pack) => pack.id === target);
  if (!raw || !isSupported(raw)) return null;
  return decorate(raw, locale || DEFAULT_LOCALE, '', raw.bodies, '');
}

/** 内置包对应的分包名；非内置包返回空串，无需加载 */
function subpackageOf(id) {
  if (!id) return '';
  return registry.some((pack) => pack && pack.id === id) ? SUBPACKAGE_PREFIX + id : '';
}

/** 已下载的在线包：pack.json 从本地目录读，素材地址指向同一目录 */
function getLocalPack(id, locale) {
  if (!id) return null;
  const dir = wx.env.USER_DATA_PATH + '/packs/' + id;
  let raw;
  try {
    raw = JSON.parse(wx.getFileSystemManager().readFileSync(dir + '/pack.json', 'utf-8'));
  } catch (err) {
    return null;
  }
  if (!isSupported(raw)) return null;
  return decorate(raw, locale || DEFAULT_LOCALE, dir + '/', null, dir);
}

function getPackList(locale) {
  return registry.filter(isSupported).map((raw) => {
    const pack = decorate(raw, locale || DEFAULT_LOCALE);
    const facts = [pack.total + ' 幕'];
    if (pack.narratorName) facts.push(pack.narratorName + '讲述');

    return {
      id: pack.id,
      title: pack.title,
      shortTitle: pack.shortTitle,
      subtitle: pack.subtitle,
      summary: pack.summary,
      // 内置包封面在主包内，图片不随分包下载
      coverUrl: BUILTIN_COVER_DIR + pack.id + '.jpg',
      tags: pack.tags,
      total: pack.total,
      narratorName: pack.narratorName,
      aiGenerated: pack.generated === true || pack.aiGenerated === true,
      statusText: '内置',
      facts: facts.filter(Boolean)
    };
  });
}

module.exports = {
  DEFAULT_PACK: DEFAULT_PACK,
  getPack: getPack,
  getLocalPack: getLocalPack,
  getPackList: getPackList,
  subpackageOf: subpackageOf
};
