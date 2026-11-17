const audioPlayer = require('../../core/audio.js');

Component({
  properties: {
    scene: {
      type: Object,
      value: null
    },
    active: {
      type: Boolean,
      value: false
    },
    near: {
      type: Boolean,
      value: false
    },
    direction: {
      type: String,
      value: 'next'
    },
    /** 低端机降级：关闭背景缩放与错峰入场 */
    lite: {
      type: Boolean,
      value: false
    }
  },

  data: {
    seen: false,
    paras: [],
    /** 本幕讲解音频播放中 */
    playing: false,
    /** 上拉阅读态：文字抬到距顶部 30% */
    raised: false,
    /** 正文可继续上拉时，纵向手势交给 markdown 的窗口，scene 不再抬整块 */
    mdPullable: false,
    /** 正文窗口上沿允许到达的屏幕纵坐标（px） */
    mdTop: 0,
    /** 立绘顶边（与标题顶边对齐）相对文字块顶部的偏移与高度 */
    figureTop: 0,
    figureH: 0,
    /** 立绘底边到正文窗口顶部的距离：正文越过这里后改为通栏 */
    wrapBase: 0,
    lift: 0,
    dragging: false,
    maxLift: 0
  },

  observers: {
    scene(scene) {
      if (!scene) return;
      this.maxLift = undefined;
      // 一幕内的多屏内容合并为一整段，不再分屏
      const pages = Array.isArray(scene.pages) ? scene.pages : [];
      const paras = pages.reduce(
        (list, page) => list.concat(Array.isArray(page) ? page : []),
        []
      );
      this.setData({
        paras: paras.length ? paras : scene.paragraphs || [],
        raised: false,
        mdPullable: false,
        lift: 0,
        dragging: false,
        maxLift: 0,
        figureTop: 0,
        figureH: 0,
        wrapBase: 0
      });
    },

    active(active) {
      if (active) {
        if (!this.data.seen) this.setData({ seen: true });
        // 激活幕接管播放状态回调，并同步当前实际播放态
        audioPlayer.onChange((state) => {
          if (!this.data.active) return;
          if (state === 'error') {
            this.setData({ playing: false });
            wx.showToast({ title: '音频加载失败，请检查网络或服务', icon: 'none' });
            return;
          }
          this.setData({ playing: state === 'playing' });
        });
        this.setData({ playing: false });
        // 布局稳定后量一次：正文窗口顶部界线、立绘位置、文字块抬升距离
        setTimeout(() => {
          if (!this.data.active) return;
          this.measureLayout();
          if (this.maxLift === undefined) {
            this.measureMaxLift(this.data.lift || 0);
          }
        }, 80);
        // 入场动效结束后再量一次，避免位移中的瞬时坐标影响对齐
        setTimeout(() => {
          if (!this.data.active) return;
          this.measureLayout();
        }, 760);
        return;
      }
      audioPlayer.stop();
      if (this.data.playing) this.setData({ playing: false });
      if (this.data.raised || this.data.lift || this.data.dragging) {
        this.setData({ raised: false, lift: 0, dragging: false });
      }
      const md = this.selectComponent('.scene-md');
      if (md) md.reset();
    }
  },

  methods: {
    /** markdown 量出正文是否超出折叠块数 */
    onMdPullable(e) {
      const value = !!(e.detail && e.detail.value);
      if (value !== this.data.mdPullable) this.setData({ mdPullable: value });
    },

    /** markdown 窗口展开/收起：同步遮罩与标题投影 */
    onMdState(e) {
      const open = !!(e.detail && e.detail.open);
      if (open !== this.data.raised) this.setData({ raised: open });
    },

    /** 量正文窗口上沿界线，以及立绘顶边/高度与正文通栏起点 */
    measureLayout() {
      if (!this.data.scene) return;
      const info = wx.getSystemInfoSync();
      const targetTop = info.windowHeight * 0.3;
      // 立绘按 3:4 画面，宽度固定 240rpx
      const figureW = Math.round((240 / 750) * info.windowWidth);
      const figureRatioH = Math.round((figureW * 4) / 3);

      this.createSelectorQuery()
        .select('.scene-body')
        .boundingClientRect()
        .select('.scene-title')
        .boundingClientRect()
        .select('.scene-md')
        .boundingClientRect()
        .exec((res) => {
          const body = res[0];
          const title = res[1];
          const md = res[2];
          if (!body) return;

          const patch = {};
          if (md) {
            const top = Math.round(targetTop + (md.top - body.top));
            if (top !== this.data.mdTop) patch.mdTop = top;
          }

          if (this.data.scene.portraitUrl && title) {
            const figureTop = Math.max(0, Math.round(title.top - body.top));
            // 顶边对齐标题，底边不越过文字块底部
            const figureH = Math.max(0, Math.min(figureRatioH, Math.round(body.bottom - title.top)));
            const wrapBase = Math.max(
              0,
              Math.round(title.top + figureH - (md ? md.top : title.bottom))
            );
            if (figureTop !== this.data.figureTop) patch.figureTop = figureTop;
            if (figureH !== this.data.figureH) patch.figureH = figureH;
            if (wrapBase !== this.data.wrapBase) patch.wrapBase = wrapBase;
          }

          if (Object.keys(patch).length) this.setData(patch);
        });
    },

    /** WXS 手势开始：关掉过渡，进入跟手状态 */
    onDragStart() {
      if (!this.data.dragging) this.setData({ dragging: true });
    },

    /** WXS 手势结束：按是否过阈值吸附到顶部 30% 或回到底部 */
    onDragEnd(payload) {
      if (!payload || payload.changed === false) {
        if (this.data.dragging) this.setData({ dragging: false });
        return;
      }
      if (!payload.raise) {
        this.setData({ dragging: false, raised: false, lift: 0 });
        return;
      }
      if (this.maxLift) {
        this.setData({ dragging: false, raised: true, lift: this.maxLift });
        return;
      }
      this.measureMaxLift(payload.lift || 0, (max) => {
        this.setData({ dragging: false, raised: max > 0, lift: max });
      });
    },

    /** 量出文字块从贴底位置抬到顶部 30% 需要移动的距离 */
    measureMaxLift(currentLift, callback) {
      const info = wx.getSystemInfoSync();
      const targetTop = info.windowHeight * 0.3;
      this.createSelectorQuery()
        .select('.scene-body')
        .boundingClientRect((rect) => {
          const max = rect
            ? Math.max(0, Math.round(rect.top + (currentLift || 0) - targetTop))
            : 0;
          this.maxLift = max;
          this.setData({ maxLift: max });
          if (callback) callback(max);
        })
        .exec();
    },

    onAudioTap() {
      const scene = this.data.scene;
      if (!scene || !scene.audio) {
        wx.showToast({ title: '本幕暂无讲解音频', icon: 'none' });
        return;
      }
      const state = audioPlayer.toggle(scene.audio);
      if (state === 'error') {
        wx.showToast({ title: '音频播放失败', icon: 'none' });
        return;
      }
      this.setData({ playing: state === 'playing' });
    }
  }
});
