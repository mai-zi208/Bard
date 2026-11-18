const app = getApp();
const loader = require('../../core/loader');
const cache = require('../../core/cache');
const preload = require('../../core/preload');
const audioPlayer = require('../../core/audio');

Page({
  data: {
    statusBarHeight: 20,
    pack: null,
    scenes: [],
    total: 0,
    current: 0,
    direction: 'next',
    isLast: false,
    finished: false,
    lite: false,
    /** 连续游览走完最后一站：结束页文案换成「全程游览完成」 */
    routeDone: false,
    /** 整线信息（route 参数长度 >1 时填充），分享与结束页使用 */
    routeTitle: '',
    routeCount: 0,
    routeCover: '',
    /** 浮窗打开态：暂停切幕手势，关闭后恢复 */
    guideOpen: false
  },

  onLoad(options) {
    const id = (options && options.pack) || loader.DEFAULT_PACK;
    this.unloaded = false;
    this.packId = id;

    // 连续游览：route 为逗号分隔的资源包 id 序列，from 为当前包在其中的下标
    this.routeIds = String((options && options.route) || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    let from = Number(options && options.from);
    if (!isFinite(from) || from < 0) from = 0;
    const at = this.routeIds.indexOf(id);
    this.routeIndex = at >= 0 ? at : from;

    // 整线信息：分享与结束页展示用，取第一站的封面
    if (this.routeIds.length > 1) {
      const first = loader.getPack(this.routeIds[0]) || loader.getLocalPack(this.routeIds[0]);
      let routeTitle = '';
      try {
        routeTitle = decodeURIComponent(String((options && options.routeTitle) || ''));
      } catch (err) {
        routeTitle = '';
      }
      this.setData({
        routeTitle: routeTitle || (first && first.title) || '旅行路线',
        routeCount: this.routeIds.length,
        routeCover: (first && first.coverUrl) || ''
      });
    }

    // 内置包都在独立分包里，素材与正文随分包下载，加载完成后再渲染
    const subpackage = loader.subpackageOf(id);
    if (!subpackage || !wx.loadSubpackage) {
      this.renderPack(id);
      return;
    }

    wx.showLoading({ title: '加载中', mask: true });
    wx.loadSubpackage({
      name: subpackage,
      success: () => {
        wx.hideLoading();
        if (!this.unloaded) this.renderPack(id);
      },
      fail: () => {
        wx.hideLoading();
        if (!this.unloaded) this.failPack();
      }
    });
  },

  renderPack(id) {
    let pack = loader.getPack(id);

    if (!pack) {
      pack = loader.getLocalPack(id);
      if (pack) cache.touch(id);
    }

    const statusBarHeight = app.globalData.statusBarHeight;

    if (!pack) {
      this.missingPack();
      return;
    }

    this.setData({
      statusBarHeight: statusBarHeight,
      pack: pack,
      scenes: pack.scenes,
      total: pack.total,
      current: 0,
      direction: 'next',
      isLast: pack.total === 1,
      lite: !!app.globalData.lite
    });

    if (pack.scenes.length > 1) {
      preload.warm([pack.scenes[1].imageUrl]);
    }
  },

  missingPack() {
    wx.showToast({ title: '资源包未下载', icon: 'none' });
    setTimeout(() => {
      this.backToPacks();
    }, 1200);
  },

  failPack() {
    wx.showToast({ title: '资源包加载失败', icon: 'none' });
    setTimeout(() => {
      this.backToPacks();
    }, 1200);
  },

  onUnload() {
    this.unloaded = true;
    wx.hideLoading();
    audioPlayer.stop();
    preload.clear();
  },

  onChange(e) {
    this.jumpTo(e.detail.current);
  },

  onTick(e) {
    this.jumpTo(e.detail.index);
  },

  /** 切到指定幕：统一处理方向、末幕与下一幕预热 */
  jumpTo(next) {
    const total = this.data.total;
    const prev = this.data.current;
    if (next === prev || next < 0 || next >= total) return;

    this.setData({
      current: next,
      direction: next > prev ? 'next' : 'prev',
      isLast: next === total - 1
    });

    const nextScene = this.data.scenes[next + 1];
    if (nextScene) preload.warm([nextScene.imageUrl]);
  },

  onGuideToggle(e) {
    this.setData({ guideOpen: !!(e.detail && e.detail.open) });
  },

  onGuideJump(e) {
    const index = Number(e.detail && e.detail.index);
    if (!Number.isFinite(index)) return;
    this.jumpTo(index);
  },

  onHint() {
    if (this.data.isLast) {
      this.finish();
      return;
    }

    this.jumpTo(this.data.current + 1);
  },

  finish() {
    if (this.data.finished) return;

    // 连续游览：还有下一站就无缝接上，不弹结束页
    const next = this.nextRouteStop();
    if (next) {
      wx.showToast({ title: '下一站：《' + next.title + '》', icon: 'none' });
      setTimeout(() => {
        if (this.unloaded) return;
        wx.redirectTo({
          url:
            '/pages/tour/tour?pack=' +
            next.id +
            '&route=' +
            this.routeIds.join(',') +
            '&from=' +
            (this.routeIndex + 1) +
            '&routeTitle=' +
            encodeURIComponent(this.data.routeTitle || '')
        });
      }, 900);
      return;
    }

    this.setData({
      finished: true,
      routeDone: this.routeIds.length > 1 && this.routeIndex >= this.routeIds.length - 1
    });
  },

  /** 路线里的下一站；不在连续游览中或已是最后一站返回 null */
  nextRouteStop() {
    if (!this.routeIds || this.routeIndex >= this.routeIds.length - 1) return null;
    const id = this.routeIds[this.routeIndex + 1];
    if (!id) return null;
    const pack = loader.getPack(id) || loader.getLocalPack(id);
    return { id: id, title: pack ? pack.title : id };
  },

  back() {
    this.backToPacks();
  },

  backToPacks() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 });
    } else {
      wx.reLaunch({ url: '/pages/packs/packs' });
    }
  },

  onShareAppMessage() {
    // 连续游览中：分享整条路线，好友从第一站开始连着看
    if (this.routeIds && this.routeIds.length > 1) {
      return {
        title: this.data.routeTitle + ' · ' + this.data.routeCount + ' 站完整路线',
        path:
          '/pages/tour/tour?pack=' + this.routeIds[0] +
          '&route=' + this.routeIds.join(',') +
          '&from=0' +
          '&routeTitle=' + encodeURIComponent(this.data.routeTitle || '')
      };
    }

    const pack = this.data.pack;
    if (!pack) {
      return {
        title: '游览向导',
        path: '/pages/launch/launch'
      };
    }

    const title = pack.narratorName
      ? pack.title + ' · ' + pack.narratorName + '讲述'
      : pack.title;

    return {
      title: title,
      path: '/pages/tour/tour?pack=' + pack.id
    };
  }
});
