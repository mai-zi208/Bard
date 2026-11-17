App({
  globalData: {
    statusBarHeight: 20,
    navBarHeight: 44,
    menuButton: null,
    locale: 'zh-CN',
    /** 低端机降级开关：由机型 benchmark 与内存推导 */
    lite: false,
    theme: {
      ink: '#16130F',
      paper: '#F2EBDD',
      gold: '#C9A227',
      goldLt: '#E3C766',
      cinnabar: '#A8402F'
    }
  },

  onLaunch() {
    let windowInfo = {};
    try {
      windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    } catch (err) {
      windowInfo = {};
    }

    const statusBarHeight = windowInfo.statusBarHeight || 20;
    let menuButton = null;
    try {
      menuButton = wx.getMenuButtonBoundingClientRect();
    } catch (err) {
      menuButton = null;
    }

    const navBarHeight =
      menuButton && menuButton.top
        ? (menuButton.top - statusBarHeight) * 2 + menuButton.height
        : 44;

    this.globalData.statusBarHeight = statusBarHeight;
    this.globalData.navBarHeight = navBarHeight;
    this.globalData.menuButton = menuButton;
    this.globalData.lite = this.detectLite();
  },

  /**
   * 低端机判定：安卓且 benchmarkLevel ≤ 15（拿不到 benchmark 时退化为内存 ≤ 2GB）。
   * iOS 的 GPU 合成稳定，不做降级，避免误伤。
   */
  detectLite() {
    let info = {};
    try {
      info = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync();
    } catch (err) {
      return false;
    }

    if (info.platform !== 'android') return false;

    if (typeof info.benchmarkLevel === 'number' && info.benchmarkLevel > 0) {
      return info.benchmarkLevel <= 15;
    }
    return typeof info.memorySize === 'number' && info.memorySize <= 2048;
  }
});
