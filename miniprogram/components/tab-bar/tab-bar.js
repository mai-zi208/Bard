Component({
  properties: {
    /** 当前高亮段：'plan' | 'packs' */
    active: {
      type: String,
      value: 'plan'
    }
  },

  methods: {
    onTab(e) {
      const key = e.currentTarget.dataset.key;
      if (!key || key === this.data.active) return;
      const url = key === 'plan' ? '/pages/plan/plan' : '/pages/packs/packs';
      wx.redirectTo({ url: url });
    }
  }
});
