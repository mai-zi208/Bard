const loader = require('../../core/loader');

Page({
  /** 欢迎页停留期间预取首个资源包的封面，缩短进入后的等待 */
  onLoad() {
    const app = getApp();
    try {
      const builtin = loader.getPackList();
      app.globalData.builtinPacks = builtin;
      if (builtin[0] && builtin[0].coverUrl && wx.getImageInfo) {
        wx.getImageInfo({ src: builtin[0].coverUrl, fail: () => {} });
      }
    } catch (err) {
      /* 预取失败不影响进入 */
    }
  },

  /** 等用户点击再进入，不自动跳转 */
  skip() {
    this.enterPacks();
  },

  enterPacks() {
    if (this.entered) return;
    this.entered = true;
    // 用 redirectTo 替换当前页，避免 reLaunch 重建页面栈时的白屏
    wx.redirectTo({
      url: '/pages/packs/packs',
      fail: () => {
        this.entered = false;
        wx.reLaunch({ url: '/pages/packs/packs' });
      }
    });
  }
});
