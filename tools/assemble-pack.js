#!/usr/bin/env node
/**
 * 装配资源包：content.json（生成端产出的文稿）→ pack.json → 素材转换 → 校验。
 *
 * 用法：
 *   node tools/assemble-pack.js --content packs-src/longmen/content.json \
 *        --assets packs-src/longmen --out cdn/longmen
 *   node tools/assemble-pack.js --content ... --out ... --no-assets   # 图片已就位，跳过转换
 *
 * 约定：图片默认按「两位序号-幕 id.jpg」推导，立绘默认按
 * 「narrator/{讲述人 id}-{姿态}.png」推导；需要例外时在 content.json 里显式给路径。
 *
 * 退出码：0 通过校验；非 0 表示转换或校验失败。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

function buildPack(content) {
  const locale = content.defaultLocale || 'zh-CN';
  const scenes = content.scenes || [];
  const hasBody = scenes.some((scene) => scene && scene.body);

  const pack = {
    id: content.id,
    schemaVersion: hasBody ? 2 : 1,
    version: content.version || 1,
    defaultLocale: locale,
    locales: content.locales || [locale],
    title: content.title,
    subtitle: content.subtitle
  };

  pack.cover = content.cover || 'cover.jpg';
  // 每次装配都视为一次刷新，供服务端判断 180 天保鲜期
  pack.refreshedAt = new Date().toISOString();
  if (content.ttlDays > 0) pack.ttlDays = content.ttlDays;
  if (content.masterId) pack.masterId = content.masterId;
  if (content.persona) pack.persona = content.persona;
  if (content.summary) pack.summary = content.summary;
  if (content.author) pack.author = content.author;
  if (content.generated) pack.generated = true;
  if (Array.isArray(content.tags) && content.tags.length) pack.tags = content.tags;
  if (Array.isArray(content.pois) && content.pois.length) pack.pois = content.pois;
  pack.theme = content.theme || { bg: '#16130F', text: '#F2EBDD', accent: '#C9A227' };

  if (content.narrator) {
    const narrator = content.narrator;
    pack.narrator = {
      id: narrator.id,
      name: narrator.name,
      title: narrator.title || ''
    };
    // 整包共用立绘：显式给出 portraits 时直接透传（生成包为 narrator/{id}-default.jpg）
    if (narrator.portraits && typeof narrator.portraits === 'object') {
      pack.narrator.portraits = narrator.portraits;
    } else {
      const poses = Array.isArray(narrator.poses) ? narrator.poses : [];
      const portraits = {};
      poses.forEach((pose) => {
        portraits[pose] = 'narrator/' + narrator.id + '-' + pose + '.png';
      });
      if (Object.keys(portraits).length) pack.narrator.portraits = portraits;
    }
    // 全局立绘本身是 3:4 完整画面时置真，客户端改用 aspectFit 完整显示
    if (narrator.portraitFit === true) pack.narrator.portraitFit = true;
    // 不透明插画需要四边羽化；透明抠图立绘不写此字段
    if (narrator.portraitMask === true) pack.narrator.portraitMask = true;
  }

  pack.scenes = (content.scenes || []).map((scene, index) => {
    const item = {
      id: scene.id,
      title: scene.title,
      subtitle: scene.subtitle,
      image: scene.image || pad(index + 1) + '-' + scene.id + '.jpg',
      imageAlt: scene.imageAlt || scene.title,
      layout: scene.layout,
      transition: scene.transition || 'zoom-out',
      holdMs: scene.holdMs || 7000
    };

    // v2 单页正文；v1 保留旧的 paragraphs / pages
    if (scene.body) {
      item.body = scene.body;
      if (Array.isArray(scene.images) && scene.images.length) item.images = scene.images;
    } else {
      item.paragraphs = scene.paragraphs;
      item.pages = scene.pages;
    }

    if (scene.narration) item.narration = scene.narration;
    if (scene.narratorPose) item.narratorPose = scene.narratorPose;
    if (scene.portrait) item.portrait = scene.portrait;
    // 音频元数据：MP3 发布在 cdn/audio/{packId}/，不进包目录
    if (scene.audio) item.audio = scene.audio;
    return item;
  });

  return pack;
}

/**
 * 正文落盘：内联 Markdown 写到 body/{序号}-{幕 id}.md；
 * 路径形态则从 content.json 所在目录复制到输出目录的同名位置。
 */
function materializeBody(scene, index, srcDir, out) {
  const raw = scene.body;
  if (typeof raw !== 'string' || !raw) return null;
  const bodyDir = path.join(out, 'body');

  if (raw.indexOf('\n') >= 0) {
    const rel = 'body/' + pad(index + 1) + '-' + scene.id + '.md';
    fs.mkdirSync(bodyDir, { recursive: true });
    fs.writeFileSync(path.join(out, rel), raw, 'utf8');
    return rel;
  }

  const rel = raw.replace(/^\.\//, '');
  const src = path.resolve(srcDir, rel);
  if (!fs.existsSync(src)) {
    console.error(`正文文件不存在：${src}`);
    process.exit(1);
  }
  const target = path.join(out, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(src, target);
  return rel;
}

/**
 * 重新装配时保留已有 extras：content.json 未写 pois 不代表点位不存在，
 * 编辑器发布与流水线重装都不应把它们抹掉。
 */
function keepExtras(pack, out) {
  const file = path.join(out, 'pack.json');
  if (!fs.existsSync(file)) return pack;

  let prev;
  try {
    prev = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn('已有 pack.json 无法解析，跳过点位保留');
    return pack;
  }

  if (!Array.isArray(pack.pois) && Array.isArray(prev.pois)) pack.pois = prev.pois;

  // 音频元数据同样保留：content.json 没写 audio 不代表已发布的音频不存在
  if (Array.isArray(pack.scenes) && Array.isArray(prev.scenes)) {
    const prevAudio = new Map(prev.scenes.map((scene) => [scene.id, scene.audio]));
    pack.scenes.forEach((scene) => {
      if (!scene.audio && prevAudio.get(scene.id)) scene.audio = prevAudio.get(scene.id);
    });
  }

  return pack;
}

function main() {
  const contentPath = argValue('--content');
  if (!contentPath) {
    console.error('缺少 --content <content.json>');
    process.exit(1);
  }

  let content;
  try {
    content = JSON.parse(fs.readFileSync(path.resolve(ROOT, contentPath), 'utf8'));
  } catch (err) {
    console.error('content.json 读取失败：' + err.message);
    process.exit(1);
  }

  if (!content.id || !Array.isArray(content.scenes)) {
    console.error('content.json 至少需要 id 与 scenes');
    process.exit(1);
  }

  const out = path.resolve(ROOT, argValue('--out', path.join('cdn', content.id)));
  const assets = argValue('--assets', '');
  const skipAssets = process.argv.indexOf('--no-assets') >= 0;
  const bodySrcDir = path.dirname(path.resolve(ROOT, contentPath));

  const pack = buildPack(content);
  fs.mkdirSync(out, { recursive: true });

  // v2 正文先落盘，再把 pack.json 里的路径指向输出目录内的副本
  pack.scenes.forEach((scene, index) => {
    if (!scene.body) return;
    const rel = materializeBody(content.scenes[index], index, bodySrcDir, out);
    if (rel) scene.body = rel;
  });

  keepExtras(pack, out);
  fs.writeFileSync(path.join(out, 'pack.json'), JSON.stringify(pack, null, 2) + '\n', 'utf8');
  console.log('已写入 pack.json：' + pack.scenes.length + ' 幕');

  if (!skipAssets && assets) {
    const src = path.resolve(ROOT, assets);
    const map = path.join(src, 'sources.json');
    const args = ['tools/convert-assets.py', '--src', src, '--out', out];
    if (fs.existsSync(map)) args.push('--map', map);
    const sceneMaxKb = argValue('--scene-max-kb', '');
    if (sceneMaxKb) args.push('--scene-max-kb', sceneMaxKb);
    const convert = spawnSync('python', args, { cwd: ROOT, stdio: 'inherit' });
    if (convert.status !== 0) {
      console.error('素材转换失败');
      process.exit(convert.status || 1);
    }
  }

  const check = spawnSync(
    'node',
    ['tools/validate-pack.js', '--dir', path.dirname(out), path.basename(out)],
    { cwd: ROOT, stdio: 'inherit' }
  );
  process.exit(check.status || 0);
}

main();
