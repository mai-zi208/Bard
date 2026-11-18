const app = getApp();
const loader = require('../../core/loader');
const cache = require('../../core/cache');
const remote = require('../../core/remote');
const naming = require('../../core/naming');
const planner = require('../../core/planner');

/** 「试试这样说」示例：点选后整句替换输入框 */
const EXAMPLES = [
  { label: '一天看尽洛阳石刻', value: '一天看尽洛阳石刻' },
  { label: '雨天 · 室内线', value: '雨天两日 · 只走室内线' },
  { label: '老城慢走 + 夜市', value: '老城慢走半天，晚上逛夜市' }
];

Page({
  data: {
    statusBarHeight: 20,
    stage: 'input',
    text: '',
    /** 只用于示例回填等程序化赋值；手动输入不回写，避免打断输入法 */
    textValue: '',
    examples: EXAMPLES,
    library: [],
    packCount: 0,
    savedRoutes: [],

    /* 规划中 */
    step: 1,
    intentText: '',
    tags: [],
    stops: [],
    readyCount: 0,
    genName: '',

    /* 地图 */
    center: { latitude: 34.68, longitude: 112.45 },
    markers: [],
    polyline: [],
    includePoints: [],
    routeTitle: '',
    routeMeta: '',
    routeIds: [],
    sheetStops: []
  },

  onLoad() {
    this.setData({ statusBarHeight: app.globalData.statusBarHeight });
    this._un = planner.subscribe((st) => this.applyState(st));
    this.refreshLibrary();
    this.refreshRoutes();
  },

  onShow() {
    this.refreshLibrary();
    this.refreshRoutes();
  },

  onUnload() {
    // 只解除订阅：规划流水线在 core/planner 里继续跑，切回来还能看到
    if (this._un) this._un();
  },

  /** planner 状态 → 视图数据 */
  applyState(st) {
    const patch = {
      stage: st.stage === 'idle' ? 'input' : st.stage,
      step: st.step || 1,
      intentText: st.intentText || '',
      tags: st.tags || [],
      stops: st.stops || [],
      readyCount: st.readyCount || 0,
      genName: st.genName || ''
    };
    if (st.stage === 'map') {
      patch.center = st.center;
      patch.markers = st.markers;
      patch.polyline = st.polyline;
      patch.includePoints = st.includePoints;
      patch.routeTitle = st.routeTitle;
      patch.routeMeta = st.routeMeta;
      patch.routeIds = st.routeIds || [];
      patch.sheetStops = st.sheetStops || [];
    }
    this.setData(patch);
    // 回到输入界面时刷新历史路线（刚生成完的立刻可见）
    if (patch.stage === 'input') this.refreshRoutes();
  },

  /* ---------------- 输入阶段 ---------------- */

  /** 输入只更新按钮态，不回写 value，避免输入法被打断 */
  onInput(e) {
    this.setData({ text: e.detail.value });
  },

  onExample(e) {
    const value = e.currentTarget.dataset.value || '';
    this.setData({ text: value, textValue: value });
  },

  onGenerate() {
    const text = (this.data.text || '').trim();
    if (!text) {
      wx.showToast({ title: '先说一句想去哪', icon: 'none' });
      return;
    }
    planner.start(text);
  },

  /** 用给定清单拼串联列表行；纯函数，不触发任何再刷新 */
  buildLibraryRows(manifest) {
    const localIds = {};
    cache.listLocal().forEach((item) => {
      localIds[item.id] = true;
    });

    const builtin = app.globalData.builtinPacks || loader.getPackList();
    const rows = builtin.map((pack) => ({
      id: pack.id,
      name: pack.shortTitle || pack.title,
      title: naming.displayTitle(pack.title, pack.narratorName),
      coverUrl: pack.coverUrl,
      glyph: (pack.title || '').charAt(0)
    }));

    (manifest || []).forEach((pack) => {
      if (rows.some((row) => row.id === pack.id)) return;
      if (pack.deprecated && !localIds[pack.id]) return;
      rows.push({
        id: pack.id,
        name: pack.title,
        title: naming.displayTitle(pack.title, pack.narratorName || pack.persona),
        coverUrl: remote.packBase(pack.id) + pack.cover,
        glyph: (pack.title || '').charAt(0)
      });
    });

    return rows;
  },

  /** 串联列表：内置 + 在线清单（软下架且本地没有的不展示） */
  refreshLibrary() {
    const rows = this.buildLibraryRows(remote.cachedManifest());
    this.setData({ library: rows, packCount: rows.length });

    // 清单过期时后台拉一次，只在内容真的变了才更新；绝不回调 refreshLibrary 自身
    remote.fetchManifest().then((packs) => {
      const ids = rows.map((row) => row.id).join('|');
      const next = this.buildLibraryRows(packs);
      if (next.map((row) => row.id).join('|') === ids) return;
      this.setData({ library: next, packCount: next.length });
    });
  },

  openPack(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/tour/tour?pack=' + id });
  },

  /* ---------------- 已生成的路线 ---------------- */

  /** 历史路线列表（最新在前），带可读时间 */
  refreshRoutes() {
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    const savedRoutes = planner.listRoutes().map((route) => {
      const d = new Date(route.createdAt || Date.now());
      return Object.assign({}, route, {
        createdLabel:
          (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
      });
    });
    this.setData({ savedRoutes });
  },

  onViewRoute(e) {
    planner.openRoute(e.currentTarget.dataset.id);
  },

  onDeleteRoute(e) {
    planner.deleteRoute(e.currentTarget.dataset.id);
    this.refreshRoutes();
  },

  /* ---------------- 规划阶段 ---------------- */

  /** 左上角返回：退出规划界面，服务端任务不受影响 */
  onBackToInput() {
    planner.cancel();
  },

  /* ---------------- 地图阶段 ---------------- */

  onMarkerTap(e) {
    const markerId = Number(e.detail && e.detail.markerId);
    if (isFinite(markerId)) this.openStop(markerId);
  },

  onSheetTap(e) {
    this.openStop(Number(e.currentTarget.dataset.index));
  },

  /** 直达该站资源包，带路线上下文供连续游览与整线分享 */
  openStop(i) {
    const ids = this.data.routeIds;
    const packId = ids && ids[i];
    if (!packId) return;
    wx.navigateTo({
      url:
        '/pages/tour/tour?pack=' + packId +
        '&route=' + ids.join(',') +
        '&from=' + i +
        '&routeTitle=' + encodeURIComponent(this.data.routeTitle || '')
    });
  },

  onStartTour() {
    if (this.data.routeIds && this.data.routeIds.length) this.openStop(0);
  },

  /** 地图上的重新规划/调整路线：回输入，已生成路线仍保留可再查看 */
  onReplan() {
    planner.backToInput();
  }
});
