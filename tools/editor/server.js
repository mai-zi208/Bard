#!/usr/bin/env node
/**
 * 资源包编辑器本地服务（浏览器单页，零依赖）。
 *
 * 只编辑生成源 packs-src/{id}/content.json，发布物始终由装配脚本产出：
 *   校验 → tools/assemble-pack.js 装配到 cdn/.tmp/editor/{id} 并跑 validate-pack
 *   发布 → 校验通过后把该临时目录整体换入 cdn/{id}/（旧版留 cdn/.backup/{id}/），再重建 manifest.json
 *
 * 用法：node tools/editor/server.js [--port 8790]
 * 打开：http://127.0.0.1:8790
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.join(ROOT, 'packs-src');
const CDN_DIR = path.join(ROOT, 'cdn');
const TMP_ROOT = path.join(CDN_DIR, '.tmp', 'editor');
const EDITOR_DIR = __dirname;

const HOST = '127.0.0.1';
const portIndex = process.argv.indexOf('--port');
const PORT = Number(portIndex >= 0 ? process.argv[portIndex + 1] : 0) || 8790;

const MAX_BODY = 12 * 1024 * 1024;
const ASSEMBLE_TIMEOUT = 10 * 60 * 1000;
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.md': 'text/markdown; charset=utf-8'
};

/** 最近一次校验结果：id → { hash, ok, errors, warnings, log, at } */
const lastChecks = new Map();

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

function pick(value, locale) {
  const lang = locale || 'zh-CN';
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => String(item)).join('');
  if (typeof value === 'object') {
    if (value[lang] !== undefined) return String(value[lang]);
    const key = Object.keys(value)[0];
    return key ? String(value[key]) : '';
  }
  return '';
}

function srcDirOf(id) {
  return path.join(SRC_DIR, id);
}

function pubDirOf(id) {
  return path.join(CDN_DIR, id);
}

function tmpDirOf(id) {
  return path.join(TMP_ROOT, id);
}

/** 只允许访问指定目录内的文件，挡住 ../ 与绝对路径 */
function safeJoin(base, rel) {
  const abs = path.resolve(base, rel);
  const prefix = path.resolve(base) + path.sep;
  return abs.startsWith(prefix) ? abs : null;
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function sendJson(res, status, data) {
  const text = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(text);
}

function sendFile(res, file, type) {
  if (!isFile(file)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('文件不存在');
    return;
  }
  res.writeHead(200, {
    'content-type': type || CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-store'
  });
  fs.createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体超过 12MB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

/** 跑一个 node 脚本并收集输出；超时直接杀掉，避免卡死编辑器 */
function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT });
    let log = '';
    const collect = (chunk) => {
      log = (log + chunk.toString('utf8')).slice(-12000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => resolve({ code: -1, log: err.message }));
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 进程已退出 */
      }
    }, ASSEMBLE_TIMEOUT);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, log });
    });
  });
}

function parseLog(log) {
  const errors = [];
  const warnings = [];
  log.split(/\r?\n/).forEach((line) => {
    if (line.startsWith('[错误]')) errors.push(line);
    else if (line.startsWith('[警告]')) warnings.push(line);
  });
  return { errors, warnings };
}

/** 生成源列表：只收录有 content.json 的目录 */
function listPacks() {
  if (!fs.existsSync(SRC_DIR)) return [];
  return fs
    .readdirSync(SRC_DIR)
    .filter((name) => name.charAt(0) !== '.')
    .map((name) => path.join(SRC_DIR, name))
    .filter((dir) => fs.statSync(dir).isDirectory() && isFile(path.join(dir, 'content.json')))
    .map((dir) => {
      const id = path.basename(dir);
      const entry = {
        id,
        title: id,
        scenes: 0,
        published: isFile(path.join(CDN_DIR, id, 'pack.json')),
        generated: false,
        persona: ''
      };
      try {
        const content = JSON.parse(fs.readFileSync(path.join(dir, 'content.json'), 'utf8'));
        entry.title = pick(content.title) || id;
        entry.scenes = Array.isArray(content.scenes) ? content.scenes.length : 0;
        entry.generated = content.generated === true;
        entry.persona = typeof content.persona === 'string' ? content.persona : '';
      } catch {
        entry.broken = true;
      }
      return entry;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function readSourcesMap(srcDir) {
  const file = path.join(srcDir, 'sources.json');
  if (!isFile(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function mediaUrl(variant, id, rel) {
  const clean = rel.split(path.sep).join('/');
  return '/media/' + variant + '/' + encodeURIComponent(id) + '/' + encodeURI(clean);
}

/**
 * 媒体解析顺序：本次校验的临时目录 → 已发布目录 → 生成源原图。
 * 生成源文件名与发布名不一致时，按 sources.json、scene-{id}.*、narrator-{pose}.* 反查。
 */
function resolveMedia(id, rel, hint) {
  if (!rel) return null;
  const info = hint || {};
  const dirs = [
    ['tmp', tmpDirOf(id)],
    ['pub', pubDirOf(id)]
  ];
  for (const item of dirs) {
    const abs = safeJoin(item[1], rel);
    if (abs && isFile(abs)) return { url: mediaUrl(item[0], id, rel), variant: item[0], rel };
  }

  const srcDir = srcDirOf(id);
  const direct = safeJoin(srcDir, rel);
  if (direct && isFile(direct)) return { url: mediaUrl('src', id, rel), variant: 'src', rel };

  const candidates = [];
  const map = readSourcesMap(srcDir);
  if (typeof map[rel] === 'string') candidates.push(map[rel]);
  const exts = ['jpg', 'jpeg', 'png', 'webp'];
  if (info.kind === 'scene' && info.sceneId) {
    exts.forEach((ext) => candidates.push('scene-' + info.sceneId + '.' + ext));
  }
  if (info.kind === 'portrait') {
    const pose = info.pose || 'default';
    if (info.narratorId) exts.forEach((ext) => candidates.push('narrator-' + info.narratorId + '-' + pose + '.' + ext));
    exts.forEach((ext) => candidates.push('narrator-' + pose + '.' + ext));
    if (info.sceneId) exts.forEach((ext) => candidates.push('portrait-' + info.sceneId + '.' + ext));
  }
  if (info.kind === 'cover') exts.forEach((ext) => candidates.push('cover.' + ext));

  for (const name of candidates) {
    const abs = safeJoin(srcDir, name);
    if (abs && isFile(abs)) return { url: mediaUrl('src', id, name), variant: 'src', rel: name };
  }

  return { url: mediaUrl('pub', id, rel), variant: 'missing', rel };
}

function imageRel(scene, index) {
  if (typeof scene.image === 'string' && scene.image) return scene.image;
  return pad(index + 1) + '-' + String(scene.id || 'scene') + '.jpg';
}

/** 立绘：优先按幕插画，其次讲述人全局立绘，最后生成源的原图 */
function portraitOf(scene, narrator) {
  if (typeof scene.portrait === 'string' && scene.portrait) {
    return { rel: scene.portrait, hint: { kind: 'portrait', sceneId: scene.id } };
  }
  if (!narrator) return null;
  const pose = scene.narratorPose || 'default';
  if (narrator.portraits && typeof narrator.portraits === 'object') {
    const rel = narrator.portraits[pose] || narrator.portraits.default;
    if (rel) return { rel, hint: { kind: 'portrait', pose } };
  }
  if (Array.isArray(narrator.poses) && narrator.poses.length) {
    const used = narrator.poses.includes(pose) ? pose : narrator.poses[0];
    return {
      rel: 'narrator/' + narrator.id + '-' + used + '.png',
      hint: { kind: 'portrait', pose: used, narratorId: narrator.id }
    };
  }
  return null;
}

function buildMedia(id, content) {
  const scenes = Array.isArray(content.scenes) ? content.scenes : [];
  const narrator = content.narrator && typeof content.narrator === 'object' ? content.narrator : null;
  return {
    cover: resolveMedia(id, typeof content.cover === 'string' ? content.cover : 'cover.jpg', { kind: 'cover' }),
    scenes: scenes.map((scene, index) => {
      const item = scene && typeof scene === 'object' ? scene : {};
      const portrait = portraitOf(item, narrator);
      return {
        id: item.id,
        image: resolveMedia(id, imageRel(item, index), { kind: 'scene', sceneId: item.id }),
        portrait: portrait ? resolveMedia(id, portrait.rel, portrait.hint) : null
      };
    })
  };
}

function packDetail(id) {
  const file = path.join(srcDirOf(id), 'content.json');
  if (!isFile(file)) throw new Error('找不到生成源：packs-src/' + id + '/content.json');

  let content;
  try {
    content = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error('content.json 解析失败：' + err.message);
  }

  const check = lastChecks.get(id) || null;
  return {
    id,
    content,
    media: buildMedia(id, content),
    published: isFile(path.join(pubDirOf(id), 'pack.json')),
    savedAt: fs.statSync(file).mtime.toISOString(),
    check: check
      ? { ok: check.ok, errors: check.errors, warnings: check.warnings, at: check.at }
      : null
  };
}

/** 编辑只落在生成源，发布物由装配脚本重建 */
function saveContent(id, content) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new Error('content 必须是对象');
  }
  if (content.id !== id) {
    throw new Error('content.id 必须与目录名一致：' + id);
  }
  if (!Array.isArray(content.scenes) || !content.scenes.length) {
    throw new Error('content.scenes 不能为空');
  }
  const file = path.join(srcDirOf(id), 'content.json');
  const text = JSON.stringify(content, null, 2) + '\n';
  fs.writeFileSync(file + '.tmp', text, 'utf8');
  fs.renameSync(file + '.tmp', file);
  lastChecks.delete(id);
  return {
    hash: crypto.createHash('sha256').update(text).digest('hex'),
    savedAt: new Date().toISOString()
  };
}

function hashOfFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 校验：装配到 cdn/.tmp/editor/{id}，校验不过不碰发布目录 */
async function runCheck(id, hash) {
  const tmp = tmpDirOf(id);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  // 带上上一版 pack.json，让装配脚本保留已有 pois、portraitFit 等字段
  const previous = path.join(pubDirOf(id), 'pack.json');
  if (isFile(previous)) fs.copyFileSync(previous, path.join(tmp, 'pack.json'));

  const result = await runNode([
    'tools/assemble-pack.js',
    '--content',
    path.join('packs-src', id, 'content.json'),
    '--assets',
    path.join('packs-src', id),
    '--out',
    path.relative(ROOT, tmp)
  ]);

  const parsed = parseLog(result.log);
  if (result.code !== 0 && !parsed.errors.length) {
    parsed.errors.push('[错误] 装配失败，退出码 ' + result.code);
  }
  const check = {
    ok: result.code === 0 && parsed.errors.length === 0,
    hash,
    errors: parsed.errors,
    warnings: parsed.warnings,
    log: result.log,
    at: new Date().toISOString()
  };
  lastChecks.set(id, check);
  return check;
}

/** 临时目录整体换入发布目录：旧版先挪进 .backup，换入失败回滚 */
function swapIn(id) {
  const tmp = tmpDirOf(id);
  const final = pubDirOf(id);
  if (!isFile(path.join(tmp, 'pack.json'))) {
    throw new Error('临时目录缺少装配结果，请重新校验');
  }
  const backupRoot = path.join(CDN_DIR, '.backup');
  fs.mkdirSync(backupRoot, { recursive: true });
  const backup = path.join(backupRoot, id);
  fs.rmSync(backup, { recursive: true, force: true });

  const hadPrevious = fs.existsSync(final);
  if (hadPrevious) fs.renameSync(final, backup);
  try {
    fs.renameSync(tmp, final);
  } catch (err) {
    if (hadPrevious) fs.renameSync(backup, final);
    throw err;
  }
}

async function checkPack(id, content) {
  const saved = saveContent(id, content);
  const check = await runCheck(id, saved.hash);
  return {
    ok: check.ok,
    errors: check.errors,
    warnings: check.warnings,
    log: check.log,
    at: check.at,
    media: buildMedia(id, JSON.parse(fs.readFileSync(path.join(srcDirOf(id), 'content.json'), 'utf8')))
  };
}

async function publishPack(id, content) {
  const saved = saveContent(id, content);
  const cached = lastChecks.get(id);
  const canReuse =
    cached &&
    cached.ok &&
    cached.hash === saved.hash &&
    isFile(path.join(tmpDirOf(id), 'pack.json'));

  let check = canReuse ? cached : await runCheck(id, saved.hash);
  if (!check.ok) {
    return {
      ok: false,
      errors: check.errors,
      warnings: check.warnings,
      log: check.log,
      at: check.at
    };
  }

  swapIn(id);
  lastChecks.delete(id);

  const manifest = await runNode(['tools/build-manifest.js']);
  return {
    ok: true,
    errors: [],
    warnings: check.warnings,
    log: check.log + '\n' + manifest.log,
    manifestOk: manifest.code === 0,
    at: new Date().toISOString(),
    media: buildMedia(id, JSON.parse(fs.readFileSync(path.join(srcDirOf(id), 'content.json'), 'utf8')))
  };
}

/** 路由：/api/packs、/api/packs/{id}、check / publish、/media/{tmp|pub|src}/{id}/{文件} */
async function handle(req, res) {
  const rawUrl = req.url || '/';
  const queryAt = rawUrl.indexOf('?');
  const rawPath = queryAt >= 0 ? rawUrl.slice(0, queryAt) : rawUrl;

  if (req.method === 'GET' && (rawPath === '/' || rawPath === '/index.html')) {
    return sendFile(res, path.join(EDITOR_DIR, 'index.html'));
  }
  if (req.method === 'GET' && rawPath === '/app.js') {
    return sendFile(res, path.join(EDITOR_DIR, 'app.js'));
  }
  if (req.method === 'GET' && rawPath === '/style.css') {
    return sendFile(res, path.join(EDITOR_DIR, 'style.css'));
  }

  if (rawPath === '/api/packs') {
    if (req.method !== 'GET') return sendJson(res, 405, { message: '方法不支持' });
    return sendJson(res, 200, listPacks());
  }

  const packMatch = /^\/api\/packs\/([^/]+)(\/[a-z]+)?$/.exec(rawPath);
  if (packMatch) {
    const id = decodeURIComponent(packMatch[1]);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return sendJson(res, 400, { message: '资源包 id 不合法' });
    const action = packMatch[2] || '';

    if (!action && req.method === 'GET') return sendJson(res, 200, packDetail(id));

    if (!action && (req.method === 'PUT' || req.method === 'POST')) {
      const body = await readJsonBody(req);
      const saved = saveContent(id, body.content);
      return sendJson(res, 200, { ok: true, savedAt: saved.savedAt });
    }

    if (action === '/check' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await checkPack(id, body.content);
      return sendJson(res, result.ok ? 200 : 422, result);
    }

    if (action === '/publish' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await publishPack(id, body.content);
      return sendJson(res, result.ok ? 200 : 422, result);
    }

    return sendJson(res, 404, { message: '接口不存在' });
  }

  const mediaMatch = /^\/media\/(tmp|pub|src)\/([^/]+)\/(.+)$/.exec(rawPath);
  if (mediaMatch && req.method === 'GET') {
    const variant = mediaMatch[1];
    const id = decodeURIComponent(mediaMatch[2]);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return sendJson(res, 400, { message: '资源包 id 不合法' });
    let rel;
    try {
      rel = decodeURIComponent(mediaMatch[3]);
    } catch {
      return sendJson(res, 400, { message: '路径编码不合法' });
    }
    const base =
      variant === 'tmp' ? tmpDirOf(id) : variant === 'pub' ? pubDirOf(id) : srcDirOf(id);
    const abs = safeJoin(base, rel);
    if (!abs) return sendJson(res, 400, { message: '路径不合规' });
    return sendFile(res, abs);
  }

  return sendJson(res, 404, { message: '接口不存在' });
}

function main() {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) sendJson(res, 500, { message });
      else res.end();
    });
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`端口 ${PORT} 已被占用，换一个：node tools/editor/server.js --port 8791`);
    } else {
      console.error('编辑器启动失败：' + (err instanceof Error ? err.message : String(err)));
    }
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    console.log('资源包编辑器：http://' + HOST + ':' + PORT);
    console.log('生成源：packs-src/{id}/content.json；发布前必须通过校验');
  });
}

main();
