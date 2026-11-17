const app = getApp();
const loader = require('../../core/loader');
const cache = require('../../core/cache');
const remote = require('../../core/remote');
const task = require('../../core/task');

/** 同名判定：去空白、行政区前缀与「景区」后缀，与服务端归一化保持一致 */
function normalizeName(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/^(?:河南省|洛阳市|洛阳)+/, '')
    .replace(/(?:风景区|景区)$/, '')
    .toLowerCase();
}

/** 「导游」「现代导游」与空串都表示默认讲述人，与服务端归一化保持一致 */
function normalizePersonaName(value) {
  const name = String(value || '').trim();
  if (!name || name === '导游' || name === '现代导游') return '';
  return name;
}

/** 资源包身份：同标题 + 同讲述人视为同一个包，不再区分内置与在线 */
function packKey(title, narratorName) {
  return normalizeName(title) + '|' + normalizePersonaName(narratorName);
}

/**
 * 资源包显示名：有明确讲述人时拼上「·人物名」，默认讲述人保持景点名。
 */
function displayTitle(title, narratorName) {
  const persona = normalizePersonaName(narratorName);
  return persona ? title + '·' + persona : title;
}

/**
 * 是否与内置包重复：
 * 1. 同标题 + 同讲述人；
 * 2. 同标题，且这一侧是默认讲述人（内置包已覆盖该景点的母本）。
 */
function duplicatesBuiltin(builtin, builtinKeys, title, narratorName) {
  if (builtinKeys[packKey(title, narratorName)]) return true;
  if (normalizePersonaName(narratorName) !== '') return false;
  const key = normalizeName(title);
  return builtin.some((pack) => normalizeName(pack.title) === key);
}

/** 字符级编辑距离：用于识别地名的错别字 */
function editDistance(a, b) {
  if (a === b) return 0;
  const n = b.length;
  let prev = [];
  let curr = [];
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1)
      );
    }
    prev = curr.slice();
  }
  return prev[n];
}

/** 输入约定「景点-人物身份」：最后一个横线前是景物，横线后是人物 */
function parseInput(value) {
  const raw = String(value || '').trim();
  const parts = raw.split(/\s*[-－—–]\s*/);
  if (parts.length < 2) return { topic: raw, persona: '' };

  const persona = parts.pop().trim();
  const topic = parts.join('-').trim();
  if (topic.length < 2 || persona.length < 2) return { topic: raw, persona: '' };
  return { topic: topic, persona: persona };
}

/** 未完成任务的本地存档，离开页面或重启小程序后可恢复 */
const PENDING_KEY = 'packs.pendingTasks';

Page({
  data: {
    statusBarHeight: 20,
    heroList: [],
    heroIndex: 0,
    more: [],
    topic: '',
    tasks: []
  },

  onLoad() {
    // 欢迎页已预取过内置包列表时直接复用
    this.builtin = app.globalData.builtinPacks || loader.getPackList();
    this.remotePacks = [];
    this.timers = {};
    this.following = {};
    this.unloaded = false;

    // 先只渲染内置包，保证首帧尽快出现；本地包扫描放到首帧之后
    this.render(false);
    this.restorePending();
    setTimeout(() => {
      if (!this.unloaded) this.render();
    }, 50);
  },

  onShow() {
    this.resumePending();
    // 每次进入页面都拉最新清单：生成可能在离开页面期间完成，命中缓存会看不到新包
    this.loadRemote(true);
  },

  onUnload() {
    this.unloaded = true;
    Object.keys(this.timers || {}).forEach((taskId) => clearTimeout(this.timers[taskId]));
    this.timers = {};
    this.following = {};
  },

  onInput(e) {
    this.setData({ topic: e.detail.value });
  },

  onSubmit() {
    this.startTask((this.data.topic || '').trim());
  },

  startTask(value) {
    const input = String(value || '').trim();
    if (!input || this.submitting) return;
    const parsed = parseInput(input);
    if (!parsed.topic) return;

    // 先确保拿到清单：命中缓存不发请求，失败也继续，不阻断提交
    this.submitting = true;
    this.ensureManifest().then(() => {
      this.submitting = false;
      if (this.unloaded) return;

      // 同景点同讲述人已有资源包：直接复用，不重复生成
      const existing = this.findExisting(parsed.topic, parsed.persona);
      if (existing) {
        this.setData({ topic: '' });
        wx.showToast({ title: '已有资源包，直接打开', icon: 'none' });
        this.openById(existing.id);
        return;
      }

      const similar = this.findSimilar(parsed.topic, parsed.persona);
      if (similar) {
        this.promptSimilar(similar, input, parsed);
        return;
      }
      this.sendTask(input, parsed);
    });
  },

  /** 近似地名：提示先纠正到正确包；真实别名的生成需求仍放行 */
  promptSimilar(similar, input, parsed) {
    this.setData({ topic: '' });
    wx.showModal({
      title: '地名可能有误',
      content: '没有找到「' + input + '」，是不是想找《' + similar.title + '》？',
      confirmText: similar.downloaded ? '去游览' : '去下载',
      cancelText: '仍要生成',
      success: (res) => {
        if (res.confirm) {
          this.openById(similar.id);
        } else if (res.cancel) {
          this.sendTask(input, parsed);
        }
      }
    });
  },

  sendTask(input, parsed) {
    this.submitting = true;
    task
      .submit(parsed.topic, parsed.persona)
      .then((res) => {
        this.submitting = false;
        if (!res || !res.taskId) throw new Error('missing taskId');
        this.setData({ topic: '' });

        this.addTask(res.taskId, input);
        this.follow(res.taskId);
      })
      .catch((err) => {
        this.submitting = false;
        const title = err && err.statusCode ? err.message : '提交失败，请检查网络';
        wx.showToast({ title: title, icon: 'none' });
      });
  },

  retryTask(e) {
    if (this.submitting) return;
    const taskId = e.currentTarget.dataset.taskid;
    const item = this.data.tasks.filter((task) => task.taskId === taskId)[0];
    if (!item || !item.failed) return;
    this.dropTask(taskId);
    this.startTask(item.topic);
  },

  /** 删除失败的占位行：服务端任务已失败，这里只清掉前端的待办记录与轮询 */
  deleteTask(e) {
    const taskId = e.currentTarget.dataset.taskid;
    const title = e.currentTarget.dataset.title || '这个资源包';
    if (!taskId) return;

    wx.showModal({
      title: '删除失败记录',
      content: '删除后《' + title + '》不再显示，可重新提交生成，确定删除？',
      confirmText: '删除',
      confirmColor: '#b4472f',
      success: (res) => {
        if (!res.confirm) return;
        if (this.timers[taskId]) {
          clearTimeout(this.timers[taskId]);
          delete this.timers[taskId];
        }
        delete this.following[taskId];
        this.dropTask(taskId);
        wx.showToast({ title: '已删除', icon: 'none' });
      }
    });
  },

  /** 全部可选包：内置 + 在线清单 + 清单已下线但本地仍保留的包 */
  collectCandidates() {
    const localIds = {};
    cache.listLocal().forEach((item) => {
      localIds[item.id] = true;
    });

    const candidates = (this.builtin || []).map((pack) => ({
      id: pack.id,
      title: pack.title,
      narratorName: pack.narratorName || '',
      downloaded: true
    }));

    (this.remotePacks || []).forEach((pack) => {
      if (candidates.some((item) => item.id === pack.id)) return;
      // 软下架且本地没有的包不再参与匹配，避免提示「去下载」后又拒绝
      if (pack.deprecated && !localIds[pack.id]) return;
      candidates.push({
        id: pack.id,
        title: pack.title,
        narratorName: pack.narratorName || '',
        downloaded: !!localIds[pack.id]
      });
    });

    // 本地有、但当前清单里已下线的包
    Object.keys(localIds).forEach((id) => {
      if (candidates.some((item) => item.id === id)) return;
      const pack = loader.getLocalPack(id);
      if (pack) {
        candidates.push({
          id: id,
          title: pack.title,
          narratorName: pack.narratorName || '',
          downloaded: true
        });
      }
    });

    return candidates;
  },

  /** 同景点同讲述人已有包：提交前直接复用，不再重复生成 */
  findExisting(topic, persona) {
    const key = normalizeName(topic);
    if (!key) return null;

    const person = normalizePersonaName(persona);
    return (
      this.collectCandidates().find(
        (pack) =>
          normalizeName(pack.title) === key &&
          normalizePersonaName(pack.narratorName) === person
      ) || null
    );
  },

  /** 近似地名（错别字）：归一化后编辑距离 1–2 且差异不超过一半；指定人物时同样要求讲述人一致 */
  findSimilar(topic, persona) {
    const key = normalizeName(topic);
    if (key.length < 2) return null;

    const person = String(persona || '').trim();
    let best = null;
    let bestDistance = 99;
    this.collectCandidates().forEach((pack) => {
      const name = normalizeName(pack.title);
      if (!name || name === key) return;
      if (person && String(pack.narratorName || '').trim() !== person) return;
      const distance = editDistance(key, name);
      const max = Math.max(key.length, name.length);
      if (distance <= Math.max(1, Math.floor(max / 3)) && distance * 2 <= max && distance < bestDistance) {
        best = pack;
        bestDistance = distance;
      }
    });
    return best;
  },

  addTask(taskId, topic) {
    const tasks = this.data.tasks.concat({
      taskId: taskId,
      topic: topic,
      glyph: topic.charAt(0),
      statusText: '排队中',
      failed: false
    });
    this.setData({ tasks: tasks });
    this.savePending(tasks);
  },

  updateTask(taskId, patch) {
    const tasks = this.data.tasks.map((item) =>
      item.taskId === taskId ? Object.assign({}, item, patch) : item
    );
    this.setData({ tasks: tasks });
    this.savePending(tasks);
  },

  dropTask(taskId) {
    const tasks = this.data.tasks.filter((item) => item.taskId !== taskId);
    this.setData({ tasks: tasks });
    this.savePending(tasks);
  },

  restorePending() {
    let list = [];
    try {
      list = wx.getStorageSync(PENDING_KEY) || [];
    } catch (err) {
      list = [];
    }
    const tasks = (Array.isArray(list) ? list : []).filter(
      (item) => item && item.taskId && item.topic
    );
    if (tasks.length) this.setData({ tasks: tasks });
  },

  /** 页面回到前台或重启后，继续轮询未结束的任务 */
  resumePending() {
    (this.data.tasks || []).forEach((item) => {
      if (item.failed) return;
      this.follow(item.taskId);
    });
  },

  savePending(tasks) {
    try {
      wx.setStorageSync(PENDING_KEY, tasks || []);
    } catch (err) {
      // 存档失败不影响主流程
    }
  },

  /** 3 秒一轮，最长约 5 分钟；同一任务不会重复起轮询 */
  follow(taskId) {
    if (this.following[taskId]) return;
    this.following[taskId] = true;

    const stop = () => {
      delete this.following[taskId];
      if (this.timers[taskId]) {
        clearTimeout(this.timers[taskId]);
        delete this.timers[taskId];
      }
    };

    const tick = (attempt) => {
      if (attempt > 100) {
        stop();
        this.dropTask(taskId);
        wx.showToast({ title: '生成超时', icon: 'none' });
        return;
      }

      this.timers[taskId] = setTimeout(() => {
        task
          .poll(taskId)
          .then((res) => {
            if (this.unloaded) {
              stop();
              return;
            }
            if (!res || !res.status) {
              tick(attempt + 1);
              return;
            }
            if (res.status === 'done') {
              stop();
              this.dropTask(taskId);
              // 强制绕过清单缓存，刚生成的包立刻出现在列表里
              this.loadRemote(true).then(() => this.cacheNewPack(res.packId));
              return;
            }
            if (res.status === 'failed') {
              stop();
              this.updateTask(taskId, {
                statusText: '失败：' + (res.error || '生成失败') + '（点击重试）',
                failed: true
              });
              wx.showToast({ title: res.error || '生成失败', icon: 'none' });
              return;
            }
            const percent = res.progress || 0;
            let statusText = '生成中 ' + percent + '%';
            if (res.status === 'queued') statusText = '排队中';
            else if (res.stage) statusText = res.stage + ' ' + percent + '%';
            else if (res.status === 'validating') statusText = '校验中 ' + percent + '%';
            this.updateTask(taskId, { statusText: statusText, failed: false });
            tick(attempt + 1);
          })
          .catch((err) => {
            if (this.unloaded) {
              stop();
              return;
            }
            // 服务端已没有该任务（重启或数据清理），去掉残留行
            if (err && err.statusCode === 404) {
              stop();
              this.dropTask(taskId);
              return;
            }
            tick(attempt + 1);
          });
      }, 3000);
    };

    tick(0);
  },

  /** 顶部轮播已下载包；列表展示全部 */
  render(includeLocal) {
    const builtin = this.builtin || [];
    const builtinKeys = {};
    builtin.forEach((pack) => {
      builtinKeys[packKey(pack.title, pack.narratorName)] = true;
    });
    const builtinIds = builtin.map((pack) => pack.id);
    // 内置包不再单独标注：随包内置即视为已下载；音频仍在 CDN，单独显示存/删状态
    const builtinRows = builtin.map((pack) => {
      // 内置包以 registry 为准：早期按在线包下过同名 id 的旧本地副本可能缺音频元数据
      const source = includeLocal !== false ? loader.getPack(pack.id) : null;
      const audioCount = source ? source.scenes.filter((scene) => scene.audio).length : 0;
      return {
        id: pack.id,
        title: displayTitle(pack.title, pack.narratorName),
        subtitle: pack.subtitle,
        total: pack.total,
        coverUrl: pack.coverUrl,
        statusText: '已下载',
        downloaded: true,
        removable: false,
        aiGenerated: !!pack.aiGenerated,
        facts: pack.facts,
        tags: pack.tags,
        audioCount: audioCount,
        audioDownloaded: audioCount > 0 && !!cache.audioState(pack.id)
      };
    });

    // 首帧跳过 storage 与本地 pack.json 读取，避免阻塞渲染
    const localList = includeLocal === false ? [] : cache.listLocal();
    const localVersions = {};
    localList.forEach((item) => {
      localVersions[item.id] = item.version || 1;
    });

    const online = (this.remotePacks || [])
      // 与内置包重复：同标题同讲述人，或同标题的默认讲述人母本，合并为同一项
      .filter((pack) => !duplicatesBuiltin(builtin, builtinKeys, pack.title, pack.narratorName))
      // 隐藏标记只对"未下载"生效：本地已下载的包始终展示
      .filter(
        (pack) => !(cache.isHidden(pack.id, pack.version) && !localVersions[pack.id])
      )
      // 软下架且本地没有的包不再出现在列表里
      .filter((pack) => !(pack.deprecated && !(localVersions[pack.id] > 0)))
      .map((pack) => {
        const localVersion = localVersions[pack.id] || 0;
        const downloaded = localVersion > 0;
        const minVersion = pack.minVersion || 0;
        // 讲解音频：仅已下载的包可存到本地（音频文件在包目录之外）
        let audioCount = 0;
        if (downloaded) {
          const localPack = loader.getLocalPack(pack.id);
          if (localPack) {
            audioCount = localPack.scenes.filter((scene) => scene.audio).length;
          }
        }
        // 清单登记了音频但本地包没有音频元数据：说明本地是旧版包，需要重新下载换新
        const staleAudio = downloaded && Number(pack.audioCount || 0) > 0 && audioCount === 0;
        // 版本不等即更新：服务端回滚到低版本时也能跟上；软下架包不再更新
        const updatable = downloaded && !pack.deprecated && (pack.version !== localVersion || staleAudio);
        const required = downloaded && !pack.deprecated && localVersion < minVersion;
        return {
          id: pack.id,
          title: displayTitle(pack.title, pack.narratorName || pack.persona),
          subtitle: pack.subtitle,
          total: pack.total,
          coverUrl: remote.packBase(pack.id) + pack.cover,
          remote: true,
          downloaded: downloaded,
          updatable: updatable,
          // 在线包一律可删：生成失败留下的残缺包也能被用户移除，出新版本后自动回来
          removable: true,
          audioCount: audioCount,
          audioDownloaded: audioCount > 0 && !!cache.audioState(pack.id),
          statusText: pack.deprecated
            ? '已下架'
            : required
              ? '需更新'
              : updatable
                ? '可更新'
                : downloaded
                  ? '已下载'
                  : '可下载'
        };
      });

    // 已下载包不依赖清单：断网或清单失败时，标题与封面直接读本地 pack.json
    const downloadedOnline = localList
      .filter((item) => builtinIds.indexOf(item.id) < 0)
      .map((item) => {
        const local = loader.getLocalPack(item.id);
        if (!local) return null;
        // 与内置包重复：合并到内置包那一项
        if (duplicatesBuiltin(builtin, builtinKeys, local.title, local.narratorName)) return null;
        const audioCount = local.scenes.filter((scene) => scene.audio).length;
        return {
          id: item.id,
          title: displayTitle(local.title, local.narratorName),
          subtitle: local.subtitle,
          total: local.total,
          coverUrl: local.coverUrl,
          statusText: '已下载',
          removable: true,
          aiGenerated: !!local.aiGenerated,
          facts: [local.total + ' 幕', '离线可游'],
          tags: local.tags,
          audioCount: audioCount,
          audioDownloaded: audioCount > 0 && !!cache.audioState(item.id)
        };
      })
      .filter(Boolean);

    const remoteIds = {};
    (this.remotePacks || []).forEach((pack) => {
      remoteIds[pack.id] = true;
    });
    // 清单已下线但本地仍保留的包，也要出现在列表里
    const localOnly = downloadedOnline
      .filter((pack) => !remoteIds[pack.id])
      .map((pack) => ({
        id: pack.id,
        title: pack.title,
        subtitle: pack.subtitle,
        total: pack.total,
        coverUrl: pack.coverUrl,
        remote: true,
        downloaded: true,
        updatable: false,
        removable: true,
        statusText: '已下载',
        aiGenerated: pack.aiGenerated,
        facts: pack.facts,
        tags: pack.tags,
        // 断网/清单不可达时也要能存音频，与在线行保持一致
        audioCount: pack.audioCount,
        audioDownloaded: pack.audioDownloaded
      }));

    const heroList = builtinRows.concat(downloadedOnline);

    const heroIndex = this.data.heroIndex < heroList.length ? this.data.heroIndex : 0;

    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      heroList: heroList,
      heroIndex: heroIndex,
      more: builtinRows.concat(online).concat(localOnly)
    });
  },

  onHeroChange(e) {
    this.setData({ heroIndex: e.detail.current });
  },

  openHeroItem(e) {
    this.open(e.currentTarget.dataset.id);
  },

  loadRemote(force) {
    return remote.fetchManifest(force).then((packs) => {
      if (!packs.length) return;
      this.remotePacks = packs;
      this.render();
    });
  },

  /** 提交前确保有清单：命中 TTL 缓存不发请求，没有缓存才等一次请求，失败也继续 */
  ensureManifest() {
    const cached = remote.cachedManifest();
    if (cached) {
      this.remotePacks = cached;
      return Promise.resolve(cached);
    }
    if (this.manifestWaiting) return this.manifestWaiting;

    this.manifestWaiting = remote.fetchManifest().then((packs) => {
      this.manifestWaiting = null;
      if (packs && packs.length) {
        this.remotePacks = packs;
        this.render();
      }
      return packs || [];
    });
    return this.manifestWaiting;
  },

  openPack(e) {
    this.openById(e.currentTarget.dataset.id);
  },

  /** 删除在线包：已下载的清本地文件与记录；未下载/残缺的仅隐藏，远端出新版本后回到列表 */
  deletePack(e) {
    const id = e.currentTarget.dataset.id;
    const title = e.currentTarget.dataset.title || '这个资源包';
    if (!id) return;

    const downloaded = cache.listLocal().some((item) => item.id === id);
    wx.showModal({
      title: '删除资源包',
      content: downloaded
        ? '删除《' + title + '》后需要重新下载，确定删除？'
        : '删除后《' + title + '》不再显示，线上发布新版本时会自动回来，确定删除？',
      confirmText: '删除',
      confirmColor: '#b4472f',
      success: (res) => {
        if (!res.confirm) return;
        // 记住删除时的远端版本：同一版本不再回到列表，远端出新版本才重新出现
        const remote = (this.remotePacks || []).filter((pack) => pack.id === id)[0];
        cache.hide(id, remote ? remote.version : 0);
        cache.remove(id);
        this.render();
        wx.showToast({ title: '已删除', icon: 'none' });
      }
    });
  },

  /** 包内登记的全部讲解音频下载任务；内置包与已下载在线包都支持，无音频返回空数组 */
  audioItemsOf(id) {
    // 内置包优先 registry：本地可能存在早期在线包留下的同名旧副本，音频元数据不全
    const builtin = (this.builtin || []).some((pack) => pack.id === id);
    const pack = builtin ? loader.getPack(id) : loader.getLocalPack(id) || loader.getPack(id);
    if (!pack) return [];
    return pack.scenes
      .filter((scene) => scene.audio && scene.audio.remoteUrl)
      .map((scene) => ({
        rel: 'scene-' + scene.id + '.mp3',
        url: scene.audio.remoteUrl,
        expected: { size: scene.audio.bytes, sha256: scene.audio.sha256 }
      }));
  },

  /**
   * 下载资源包后自动补存讲解音频，保证首次离线也能听。
   * 同版本已存过则跳过；silent 为真时不显示进度（内置包在后台补存）。
   * 失败只忽略，用户仍可在列表页手动重试。
   */
  autoSaveAudio(id, version, silent) {
    const state = cache.audioState(id);
    if (state && (state.version || 1) === (version || 1)) return Promise.resolve();

    const items = this.audioItemsOf(id);
    if (!items.length) return Promise.resolve();

    // 同一包同时只跑一轮，避免重复进出页面时并发下载互相清目录
    this.audioSaving = this.audioSaving || {};
    if (this.audioSaving[id]) return Promise.resolve();
    this.audioSaving[id] = true;

    return cache
      .downloadAudio(id, version || 1, items, (done, total) => {
        if (silent) return;
        const percent = Math.round((done / total) * 100);
        wx.showLoading({ title: '音频 ' + percent + '%', mask: true });
      })
      .then(() => {
        if (!this.unloaded) this.render();
      })
      .catch(() => {
        /* 音频失败不影响资源包本身的离线使用 */
      })
      .then(() => {
        delete this.audioSaving[id];
      });
  },

  /** 下载/删除整包讲解音频：音频存在包目录之外，离线也能听 */
  toggleAudio(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || this.audioDownloading) return;

    const state = cache.audioState(id);
    if (state) {
      wx.showModal({
        title: '删除讲解音频',
        content: '删除后仍可在线播放，但信号不好时听不了。确定删除本地音频？',
        confirmText: '删除',
        confirmColor: '#b4472f',
        success: (res) => {
          if (!res.confirm) return;
          cache.removeAudio(id).then(() => {
            this.render();
            wx.showToast({ title: '已删除音频', icon: 'none' });
          });
        }
      });
      return;
    }

    const items = this.audioItemsOf(id);
    if (!items.length) {
      wx.showToast({ title: '该包暂无讲解音频', icon: 'none' });
      return;
    }

    const entry = (this.remotePacks || []).filter((pack) => pack.id === id)[0];
    const builtin = (this.builtin || []).some((pack) => pack.id === id);
    const localPack = builtin ? loader.getPack(id) : loader.getLocalPack(id) || loader.getPack(id);
    // 内置包与打开时的后台补存保持同一版本口径，避免每次进页面重复下载
    const version = builtin
      ? (localPack && localPack.version) || 1
      : (entry && entry.version) || (localPack && localPack.version) || 1;
    this.audioDownloading = true;
    wx.showLoading({ title: '准备音频', mask: true });
    cache
      .downloadAudio(id, version, items, (done, total) => {
        const percent = Math.round((done / total) * 100);
        wx.showLoading({ title: '音频 ' + percent + '%', mask: true });
      })
      .then(() => {
        wx.hideLoading();
        this.audioDownloading = false;
        this.render();
        wx.showToast({ title: '音频已存，离线可听', icon: 'none' });
      })
      .catch(() => {
        wx.hideLoading();
        this.audioDownloading = false;
        wx.showToast({ title: '音频下载失败', icon: 'none' });
      });
  },

  /** 内置直接开；在线未下载/可更新先下载；已下载直接开 */
  openById(id) {
    if (!id) return;

    const builtinIds = (this.builtin || []).map((pack) => pack.id);
    if (builtinIds.indexOf(id) >= 0) {
      // 内置包本体已离线，讲解音频仍在 CDN：首次打开时后台补存，不阻塞进入
      const builtinPack = loader.getPack(id);
      this.autoSaveAudio(id, (builtinPack && builtinPack.version) || 1, true);
      this.open(id);
      return;
    }

    const pack = (this.remotePacks || []).filter((item) => item.id === id)[0];
    if (!pack) {
      this.open(id);
      return;
    }

    const local = cache.listLocal().filter((item) => item.id === id)[0];
    const localVersion = local ? local.version || 1 : 0;

    // 软下架：已下载的继续离线可用，未下载的不再提供
    if (pack.deprecated) {
      if (localVersion) {
        this.open(id);
        return;
      }
      wx.showToast({ title: '该资源包已下架', icon: 'none' });
      return;
    }

    // 版本不等即更新（含服务端回滚）；低于 minVersion 时也必须先更新
    const minVersion = pack.minVersion || 0;
    if (!localVersion || pack.version !== localVersion || localVersion < minVersion) {
      this.download(id);
      return;
    }

    // 已下载且版本一致：后台补存讲解音频，老版本下载的包也能离线听
    this.autoSaveAudio(id, localVersion, true);
    this.open(id);
  },

  /**
   * 生成完成后的自动落盘：清单里能查到该包就自动下载，包体与全部讲解音频一并存本地。
   * 已下载、清单缺失、正在下载别的包时退回普通提示，不打断用户。
   */
  cacheNewPack(packId) {
    if (this.unloaded) return;
    const ready =
      packId && (this.remotePacks || []).some((pack) => pack.id === packId);
    const downloaded = packId && cache.listLocal().some((item) => item.id === packId);
    if (!ready || downloaded || this.downloading) {
      wx.showToast({ title: '已生成，点击即可游览', icon: 'none' });
      return;
    }
    this.download(packId, false);
  },

  download(id, autoOpen) {
    if (this.downloading) return;
    const entry = (this.remotePacks || []).filter((pack) => pack.id === id)[0];
    if (!entry) return;

    this.downloading = true;
    wx.showLoading({ title: '准备下载', mask: true });

    cache
      .downloadPack(Object.assign({}, entry, { baseUrl: remote.packBase(id) }), (done, total) => {
        const percent = Math.round((done / total) * 100);
        wx.showLoading({ title: '下载 ' + percent + '%', mask: true });
      })
      .then(() => {
        // 包体就绪后顺手把讲解音频存到本地，断网也能听
        wx.showLoading({ title: '准备音频', mask: true });
        return this.autoSaveAudio(id, entry.version);
      })
      .then(() => {
        wx.hideLoading();
        this.downloading = false;
        this.render();
        // 生成完成后自动落盘时不跳转，让用户自己决定什么时候游览
        if (autoOpen === false) {
          wx.showToast({ title: '已下载，可离线游览', icon: 'none' });
          return;
        }
        this.open(id);
      })
      .catch((err) => {
        wx.hideLoading();
        this.downloading = false;
        // 校验失败携带具体文件名，其余（网络、写盘）统一提示重试
        const message = err && typeof err.message === 'string' ? err.message : '';
        const title = message.indexOf('文件') === 0 ? message : '下载失败，请重试';
        wx.showToast({ title: title, icon: 'none' });
      });
  },

  open(id) {
    wx.navigateTo({ url: '/pages/tour/tour?pack=' + id });
  }
});
