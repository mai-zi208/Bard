/**
 * 路线规划全局单例：流水线不挂在页面实例上，切到资源包页再切回来仍是「正在规划」；
 * 规划快照落本地存储，应用重启也能续跑；生成失败的站点自动重试一次，仍失败则跳过不卡流程。
 */
const config = require('../config');
const loader = require('./loader');
const cache = require('./cache');
const remote = require('./remote');
const task = require('./task');
const naming = require('./naming');
const settings = require('./settings');

const CURRENT_KEY = 'plan_current_v1';
/** 路线历史列表（数组，最新在前） */
const ROUTES_KEY = 'plan_routes_v1';
/** 旧版单条路线键，读到即迁移 */
const ROUTE_KEY = 'plan_route_v1';
/** 历史路线保留条数 */
const ROUTES_MAX = 20;
/** 规划快照有效期：超时直接丢弃 */
const CURRENT_TTL = 6 * 60 * 60 * 1000;
/** 轮询节奏与 packs 页一致：3 秒一轮，最多 100 轮 */
const POLL_MS = 3000;
const MAX_ATTEMPTS = 100;

let state = null;
let listeners = [];
let timers = {};
let following = {};
let run = 0;
let inited = false;
let remotePacks = [];

/* ---------------- 状态广播 ---------------- */

function emit() {
  const snap = getState();
  listeners.forEach((fn) => fn(snap));
}

function getState() {
  if (!state) return { stage: 'idle' };
  return Object.assign({}, state, state.map || {});
}

function persist() {
  try {
    if (state && state.stage === 'planning') {
      const copy = Object.assign({}, state);
      delete copy.map;
      copy.updatedAt = Date.now();
      wx.setStorageSync(CURRENT_KEY, copy);
    } else {
      wx.removeStorageSync(CURRENT_KEY);
    }
  } catch (err) {
    /* 存储失败不影响流程 */
  }
}

/* ---------------- 路线解析接口 ---------------- */

function requestPlan(text) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, settings.keyHeaders());
    if (config.API_TOKEN) headers['x-api-token'] = config.API_TOKEN;

    wx.request({
      url: (config.API_BASE || '') + '/plan',
      method: 'POST',
      data: { text: text },
      header: headers,
      timeout: 15000,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300 && res.data) {
          resolve(res.data);
          return;
        }
        const data = res.data || {};
        const err = new Error(data.error || 'HTTP ' + res.statusCode);
        err.statusCode = res.statusCode;
        reject(err);
      },
      fail(err) {
        reject(err);
      }
    });
  });
}

/* ---------------- 候选比对 ---------------- */

function collectCandidates() {
  const localIds = {};
  cache.listLocal().forEach((item) => {
    localIds[item.id] = true;
  });

  const candidates = (loader.getPackList() || []).map((pack) => ({
    id: pack.id,
    title: pack.title,
    coverUrl: pack.coverUrl
  }));

  remotePacks.forEach((pack) => {
    if (candidates.some((item) => item.id === pack.id)) return;
    if (pack.deprecated && !localIds[pack.id]) return;
    candidates.push({
      id: pack.id,
      title: pack.title,
      coverUrl: remote.packBase(pack.id) + pack.cover
    });
  });

  Object.keys(localIds).forEach((id) => {
    if (candidates.some((item) => item.id === id)) return;
    const pack = loader.getLocalPack(id);
    if (pack) {
      candidates.push({ id: id, title: pack.title, coverUrl: pack.coverUrl });
    }
  });

  return candidates;
}

/**
 * 景点名匹配：精确 → 包含 → 一字之差（编辑距离 ≤1）。
 * 规划接口只给景点名不给讲述人，同名不同讲述人也视为已有包，避免重复生成。
 */
function findExisting(topic) {
  const key = naming.normalizeName(topic);
  if (!key) return null;

  let best = null;
  let bestDiff = 99;
  collectCandidates().forEach((pack) => {
    const name = naming.normalizeName(pack.title);
    if (!name) return;
    let diff;
    if (name === key) {
      diff = 0;
    } else if (name.indexOf(key) >= 0 || key.indexOf(name) >= 0) {
      diff = Math.abs(name.length - key.length) + 1;
    } else if (key.length >= 3 && naming.editDistance(name, key) <= 1) {
      diff = naming.editDistance(name, key) + 2;
    } else {
      return;
    }
    if (diff < bestDiff) {
      bestDiff = diff;
      best = pack;
    }
  });
  return best;
}

function ensureManifest() {
  const cached = remote.cachedManifest();
  if (cached) {
    remotePacks = cached;
    return Promise.resolve(cached);
  }
  return remote.fetchManifest().then((packs) => {
    if (packs && packs.length) remotePacks = packs;
    return packs || [];
  });
}

/* ---------------- 站点状态推进 ---------------- */

function patchStop(i, patch) {
  if (!state || !state.stops[i]) return;
  state.stops[i] = Object.assign({}, state.stops[i], patch);
  const generating = state.stops.filter((stop) => stop.state === 'gen');
  state.readyCount = state.stops.filter((stop) => stop.state === 'ok').length;
  state.genName = generating.length ? generating[0].name : '';
  persist();
  emit();
  checkAdvance();
}

function markReady(i, packId, coverUrl) {
  patchStop(i, {
    state: 'ok',
    packId: packId,
    coverUrl: coverUrl || '',
    statusText: '已入库',
    percent: 100
  });
}

function markSkip(i, reason) {
  patchStop(i, {
    state: 'skip',
    statusText: reason || '已跳过',
    percent: 0,
    taskId: ''
  });
}

/** 生成异常：先自动重试一次，再失败就跳过，不卡整条流水线 */
function failStop(i, r, reason) {
  const stop = state && state.stops[i];
  if (!stop || r !== run || stop.state === 'ok' || stop.state === 'skip') return;
  if (!stop.attempted) {
    patchStop(i, { attempted: true, taskId: '', percent: 0, statusText: '异常，自动重试' });
    submitFor(i, r);
    return;
  }
  markSkip(i, reason || '生成失败，已跳过');
}

/** 全部站点进入终态（入库或跳过）后铺地图 */
function checkAdvance() {
  if (!state || state.stage !== 'planning') return;
  const pending = state.stops.filter((stop) => stop.state === 'queue' || stop.state === 'gen');
  if (pending.length) return;
  if (state.stops.some((stop) => stop.state === 'ok')) {
    finishPlanning();
    return;
  }
  wx.showToast({ title: '资源包都没生成成功，换个说法试试', icon: 'none' });
  cancel();
}

/* ---------------- 生成任务 ---------------- */

function submitFor(i, r) {
  const stop = state.stops[i];
  return task
    .submit(stop.name, stop.persona || '', state.city || '')
    .then((res) => {
      if (inited && r !== run) return;
      if (!res || !res.taskId) throw new Error('missing taskId');
      patchStop(i, { state: 'gen', statusText: '排队中', percent: 0, taskId: res.taskId });
      follow(i, res.taskId, r);
    })
    .catch(() => {
      failStop(i, r, '提交失败，已跳过');
    });
}

function follow(i, taskId, r) {
  if (!taskId || following[taskId]) return;
  following[taskId] = true;

  const stopFollow = () => {
    delete following[taskId];
    if (timers[taskId]) {
      clearTimeout(timers[taskId]);
      delete timers[taskId];
    }
  };

  const tick = (attempt) => {
    if (r !== run) {
      stopFollow();
      return;
    }
    if (attempt > MAX_ATTEMPTS) {
      stopFollow();
      failStop(i, r, '生成超时，已跳过');
      return;
    }

    timers[taskId] = setTimeout(() => {
      task
        .poll(taskId)
        .then((res) => {
          if (r !== run) {
            stopFollow();
            return;
          }
          if (!res || !res.status) {
            tick(attempt + 1);
            return;
          }
          if (res.status === 'done') {
            stopFollow();
            settleGenerated(i, res.packId, r);
            return;
          }
          if (res.status === 'failed') {
            stopFollow();
            failStop(i, r, '生成失败，已跳过');
            return;
          }
          const percent = res.progress || 0;
          patchStop(i, {
            statusText: res.status === 'queued' ? '排队中' : '生成 ' + percent + '%',
            percent: percent
          });
          tick(attempt + 1);
        })
        .catch((err) => {
          if (r !== run) {
            stopFollow();
            return;
          }
          if (err && err.statusCode === 404) {
            stopFollow();
            failStop(i, r, '任务已失效，已跳过');
            return;
          }
          tick(attempt + 1);
        });
    }, POLL_MS);
  }

  tick(0);
}

/** 生成完成：强刷清单拿到新包，自动下载包体与音频，再标为已入库 */
function settleGenerated(i, packId, r) {
  if (!packId) {
    failStop(i, r, '已生成但找不到包，已跳过');
    return;
  }
  remote.fetchManifest(true).then((packs) => {
    if (r !== run) return;
    remotePacks = packs || [];
    const entry = (packs || []).filter((pack) => pack.id === packId)[0];
    const cover = entry ? remote.packBase(packId) + entry.cover : '';
    if (!entry) {
      markReady(i, packId, cover);
      return;
    }
    ensureLocal(i, packId, cover, r);
  });
}

/** 命中在线包但本地没有：先自动下载包体与音频，再标已入库 */
function ensureLocal(i, packId, coverUrl, r) {
  const isBuiltin = (loader.getPackList() || []).some((pack) => pack.id === packId);
  const entry = isBuiltin ? null : remotePacks.filter((pack) => pack.id === packId)[0];
  if (isBuiltin || !entry || cache.isLocal(packId)) {
    markReady(i, packId, coverUrl);
    return Promise.resolve();
  }
  return cache
    .downloadPack(Object.assign({}, entry, { baseUrl: remote.packBase(packId) }))
    .then(() => autoSaveAudio(packId, entry.version))
    .catch(() => {
      /* 下载失败也标记就绪：进入游览时 tour 页会提示，回列表页可重试 */
    })
    .then(() => {
      if (r !== run) return;
      markReady(i, packId, coverUrl);
    });
}

/** 包内全部讲解音频的补存；失败静默，与 packs.js 同口径 */
function autoSaveAudio(id, version) {
  const stateAudio = cache.audioState(id);
  if (stateAudio && (stateAudio.version || 1) === (version || 1)) return Promise.resolve();

  const pack = loader.getPack(id) || loader.getLocalPack(id);
  if (!pack) return Promise.resolve();
  const items = pack.scenes
    .filter((scene) => scene.audio && scene.audio.remoteUrl)
    .map((scene) => ({
      rel: 'scene-' + scene.id + '.mp3',
      url: scene.audio.remoteUrl,
      expected: { size: scene.audio.bytes, sha256: scene.audio.sha256 }
    }));
  if (!items.length) return Promise.resolve();

  return cache.downloadAudio(id, version || 1, items).catch(() => {});
}

/* ---------------- 流水线主流程 ---------------- */

function matchStops(r) {
  let queue = Promise.resolve();
  state.stops.forEach((unused, i) => {
    queue = queue.then(() => {
      if (r !== run) return;
      const stop = state.stops[i];
      if (stop.state === 'ok' || stop.state === 'skip') return;
      if (stop.state === 'gen') {
        // 断点续跑：已有任务号的接着轮询，没有的重新提交
        if (stop.taskId) follow(i, stop.taskId, r);
        else submitFor(i, r);
        return;
      }
      const existing = findExisting(stop.name);
      if (existing) {
        return ensureLocal(i, existing.id, existing.coverUrl, r);
      }
      return submitFor(i, r);
    });
  });
}

function start(text) {
  init();
  run += 1;
  const r = run;
  stopFollows();

  state = {
    stage: 'planning',
    step: 1,
    intentText: text,
    tags: [],
    stops: [],
    readyCount: 0,
    genName: ''
  };
  persist();
  emit();

  requestPlan(text)
    .then((res) => {
      if (r !== run) return;
      applyPlan(res, r);
    })
    .catch((err) => {
      if (r !== run) return;
      wx.showToast({ title: err && err.statusCode ? err.message : '规划失败，请检查网络', icon: 'none' });
      cancel();
    });
}

/** /plan 返回：{ title?, tags?, days?, stops: [{ name, lat, lng, meta? }] } */
function applyPlan(res, r) {
  const raw = res && Array.isArray(res.stops) ? res.stops : [];
  const stops = raw
    .map((stop, i) => {
      const name = String((stop && (stop.name || stop.title)) || '').trim();
      const lat = Number(stop && stop.lat);
      const lng = Number(stop && stop.lng);
      return {
        index: i,
        name: name,
        glyph: name.charAt(0),
        lat: isFinite(lat) ? lat : null,
        lng: isFinite(lng) ? lng : null,
        meta: String((stop && (stop.meta || stop.subtitle)) || '').trim(),
        /** 该站指定讲述人；缺省时用整线 persona */
        persona: String((stop && (stop.persona || stop.narratorName)) || '').trim(),
        packId: '',
        coverUrl: '',
        state: 'queue',
        statusText: '排队中',
        percent: 0,
        taskId: '',
        attempted: false
      };
    })
    .filter((stop) => stop.name);

  if (!stops.length) {
    wx.showToast({ title: '没排出景点，换个说法试试', icon: 'none' });
    cancel();
    return;
  }

  // 整线指定了讲述人：补到没单独指定的站，并在意图标签里亮出来
  const routePersona = String((res && res.persona) || '').trim();
  if (routePersona) {
    stops.forEach(function (s) {
      if (!s.persona) s.persona = routePersona;
    });
  }

  state.stops = stops;
  // 规划推断出的城市：提交生成任务时带上，服务端据此检索景点内容库
  state.city = String((res && res.city) || '').trim();
  state.tags = (res && Array.isArray(res.tags) ? res.tags : []).slice(0, 6);
  if (routePersona) state.tags.push(routePersona + ' 讲述');
  state.route = {
    title: (res && res.title) || state.intentText,
    days: res && Number(res.days) > 0 ? Number(res.days) : 0,
    tags: state.tags
  };
  state.step = 2;
  persist();
  emit();

  ensureManifest().then(() => {
    if (r !== run) return;
    matchStops(r);
  });
}

/* ---------------- 地图数据 ---------------- */

const FALLBACK_CENTER = { latitude: 34.68, longitude: 112.45 };

function buildMap(routeStops, title, days) {
  // 保留原始站序：marker id 与 routeIds 下标一致，缺坐标的站不进图
  const placed = [];
  routeStops.forEach((stop, i) => {
    if (stop.lat !== null && stop.lng !== null) placed.push({ stop: stop, i: i });
  });

  const markers = placed.map((item) => ({
    id: item.i,
    latitude: item.stop.lat,
    longitude: item.stop.lng,
    iconPath: item.stop.coverUrl || '',
    width: 56,
    height: 56,
    callout: {
      content: item.stop.name,
      color: '#1c2733',
      fontSize: 12,
      borderRadius: 8,
      bgColor: '#ffffff',
      padding: 6,
      display: 'BYCLICK',
      textAlign: 'center'
    }
  }));

  const points = placed.map((item) => ({ latitude: item.stop.lat, longitude: item.stop.lng }));
  const polyline =
    points.length > 1 ? [{ points: points, color: '#c8a03fDD', width: 4, dottedLine: true }] : [];

  const metaParts = [routeStops.length + ' 站'];
  if (days) metaParts.push('约 ' + days + ' 天');
  metaParts.push(routeStops.length + ' 个资源包已就绪');

  return {
    center: points.length ? points[0] : FALLBACK_CENTER,
    markers: markers,
    polyline: polyline,
    includePoints: points,
    routeTitle: title,
    routeMeta: metaParts.join(' · '),
    routeIds: routeStops.map((stop) => stop.packId),
    sheetStops: routeStops.map((stop, i) => ({
      index: i,
      name: stop.name,
      glyph: stop.glyph,
      coverUrl: stop.coverUrl,
      packId: stop.packId
    }))
  };
}

function finishPlanning() {
  run += 1; // 全部就绪，停掉残余轮询
  stopFollows();
  state.step = 3;

  const routeStops = state.stops.filter((stop) => stop.state === 'ok');
  const route = state.route || { title: state.intentText, days: 0 };
  state.map = buildMap(routeStops, route.title, route.days);
  state.stage = 'map';

  const saved = {
    id: 'r' + Date.now(),
    title: route.title,
    tags: route.tags || [],
    days: route.days || 0,
    stops: routeStops.map((stop) => ({
      name: stop.name,
      glyph: stop.glyph,
      packId: stop.packId,
      coverUrl: stop.coverUrl,
      lat: stop.lat,
      lng: stop.lng
    })),
    createdAt: Date.now()
  };
  state.routeId = saved.id;
  try {
    const list = readRoutes();
    const keyOf = (r) =>
      r.title + '|' + (r.stops || []).map((s) => s.name).join(',');
    const dup = list.findIndex((r) => keyOf(r) === keyOf(saved));
    if (dup >= 0) list.splice(dup, 1);
    list.unshift(saved);
    if (list.length > ROUTES_MAX) list.length = ROUTES_MAX;
    wx.setStorageSync(ROUTES_KEY, list);
  } catch (err) {
    /* 存储失败不影响本次查看 */
  }
  persist();
  emit();
}

/* ---------------- 路线历史 ---------------- */

function readRoutes() {
  let list = [];
  try {
    list = wx.getStorageSync(ROUTES_KEY) || [];
  } catch (err) {
    list = [];
  }
  if (!Array.isArray(list)) list = [];

  // 迁移旧版单条路线
  try {
    const legacy = wx.getStorageSync(ROUTE_KEY);
    if (legacy && legacy.stops && legacy.stops.length) {
      if (!legacy.id) legacy.id = 'r' + (legacy.createdAt || Date.now());
      list.unshift(legacy);
      wx.setStorageSync(ROUTES_KEY, list);
      wx.removeStorageSync(ROUTE_KEY);
    }
  } catch (err) {
    /* ignore */
  }

  return list.filter((route) => route && route.stops && route.stops.length);
}

function listRoutes() {
  return readRoutes();
}

function deleteRoute(id) {
  try {
    const list = readRoutes().filter((route) => route.id !== id);
    wx.setStorageSync(ROUTES_KEY, list);
  } catch (err) {
    /* ignore */
  }
  if (state && state.stage === 'map' && state.routeId === id) {
    run += 1;
    stopFollows();
    state = { stage: 'idle' };
    persist();
  }
  emit();
}

/** 从历史列表打开某条路线的地图视图 */
function openRoute(id) {
  const list = readRoutes();
  const route = list.filter((r) => r.id === id)[0] || list[0];
  if (!route) return;
  init();
  run += 1;
  stopFollows();
  const routeStops = route.stops.map((stop, i) =>
    Object.assign({ index: i, state: 'ok', statusText: '已入库', percent: 100 }, stop)
  );
  state = {
    stage: 'map',
    step: 3,
    routeId: route.id,
    intentText: route.title,
    tags: route.tags || [],
    stops: routeStops,
    readyCount: routeStops.length,
    genName: '',
    route: { title: route.title, days: route.days, tags: route.tags || [] },
    map: buildMap(routeStops, route.title, route.days)
  };
  persist();
  emit();
}

/* ---------------- 退出与恢复 ---------------- */

function backToInput() {
  if (state) state.stage = 'idle';
  persist();
  emit();
}

function cancel() {
  run += 1;
  stopFollows();
  state = { stage: 'idle' };
  persist();
  emit();
}

function stopFollows() {
  Object.keys(timers).forEach((taskId) => clearTimeout(timers[taskId]));
  timers = {};
  following = {};
}

/** 首次使用时恢复：进行中的规划快照续跑 */
function init() {
  if (inited) return;
  inited = true;

  let saved = null;
  try {
    saved = wx.getStorageSync(CURRENT_KEY);
  } catch (err) {
    /* ignore */
  }
  if (!saved || saved.stage !== 'planning' || Date.now() - (saved.updatedAt || 0) > CURRENT_TTL) {
    try {
      wx.removeStorageSync(CURRENT_KEY);
    } catch (err) {
      /* ignore */
    }
    return;
  }

  run += 1;
  const r = run;
  state = saved;
  remotePacks = remote.cachedManifest() || [];
  emit();
  ensureManifest().then(() => {
    if (r !== run) return;
    matchStops(r);
  });
}

function subscribe(fn) {
  init();
  listeners.push(fn);
  fn(getState());
  return () => {
    listeners = listeners.filter((item) => item !== fn);
  };
}

module.exports = {
  start: start,
  cancel: cancel,
  backToInput: backToInput,
  subscribe: subscribe,
  getState: getState,
  listRoutes: listRoutes,
  deleteRoute: deleteRoute,
  openRoute: openRoute
};
