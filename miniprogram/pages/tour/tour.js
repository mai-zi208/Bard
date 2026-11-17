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
    /** 浮窗打开态：暂停切幕手势，关闭后恢复 */
    guideOpen: false
  },

  onLoad(options) {
    const id = (options && options.pack) || loader.DEFAULT_PACK;
    this.unloaded = false;
    this.packId = id;

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
    this.setData({ finished: true });
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
