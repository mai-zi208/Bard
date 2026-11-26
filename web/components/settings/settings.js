const settings = require('../../core/settings');

Component({
  data: {
    // 齿轮按钮位置：默认值兜底，attached 时按胶囊按钮实测位置对齐
    top: 26,
    right: 100,
    open: false,
    llm: '',
    image: '',
    tts: '',
    hasAny: false,
    // 密钥只存本机，默认明文，避免「输入了却看不到」的困惑
    showKeys: true
  },

  lifetimes: {
    attached() {
      try {
        const rect = wx.getMenuButtonBoundingClientRect();
        const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
        if (rect && win && rect.width) {
          this.setData({ top: rect.top, right: win.windowWidth - rect.left + 8 });
        }
      } catch (err) {
        /* 取不到胶囊位置时用默认值 */
      }
      this.syncFromStorage();
    }
  },

  methods: {
    syncFromStorage() {
      const keys = settings.getKeys();
      this.setData({
        llm: keys.llm,
        image: keys.image,
        tts: keys.tts,
        hasAny: Boolean(keys.llm || keys.image || keys.tts)
      });
    },

    onOpen() {
      this.syncFromStorage();
      this.setData({ open: true });
    },

    onClose() {
      this.setData({ open: false });
    },

    noop() {},

    onToggleShow() {
      this.setData({ showKeys: !this.data.showKeys });
    },

    onInput(e) {
      const field = e.currentTarget.dataset.field;
      const value = e.detail.value;
      if (!field || this.data[field] === value) return;
      const patch = {};
      patch[field] = value;
      this.setData(patch);
    },

    onSave() {
      settings.setKeys({ llm: this.data.llm, image: this.data.image, tts: this.data.tts });
      this.setData({ open: false });
      this.syncFromStorage();
      wx.showToast({ title: '已保存，下次生成生效', icon: 'none' });
    },

    onClear() {
      settings.setKeys({});
      this.setData({ open: false });
      this.syncFromStorage();
      wx.showToast({ title: '已清除，改用服务端默认密钥', icon: 'none' });
    }
  }
});
