/**
 * 轻量 Markdown 渲染：只支持白名单语法，避免引入 towxml 增大主包。
 * 支持标题（#~###）、段落、图片、引用、无序列表、加粗、分隔线。
 */

const IMAGE_RE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;
const HEADING_RE = /^(#{1,3})\s+(.+)$/;
const LIST_RE = /^[-*]\s+(.+)$/;
const QUOTE_RE = /^>\s?(.*)$/;
const HR_RE = /^-{3,}$/;

/** 行内样式：只解析 **加粗** */
function inline(text, startId) {
  const parts = String(text).split('**');
  const spans = [];
  parts.forEach((part, i) => {
    if (!part) return;
    spans.push({ id: startId + spans.length, text: part, bold: i % 2 === 1 });
  });
  return spans.length ? spans : [{ id: startId, text: '', bold: false }];
}

/** 正文图片使用包内相对路径，按加载时给出的基址重写 */
function asset(src, base) {
  if (/^(https?:)?\/\//.test(src) || /^data:/.test(src) || src.charAt(0) === '/') return src;
  return (base || '') + src;
}

function parseMarkdown(source, base) {
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  let quote = [];

  const push = (block) => {
    block.id = blocks.length;
    blocks.push(block);
  };
  const flushPara = () => {
    if (!para.length) return;
    push({ type: 'p', spans: inline(para.join('\n'), blocks.length * 100) });
    para = [];
  };
  const flushQuote = () => {
    if (!quote.length) return;
    push({ type: 'quote', spans: inline(quote.join('\n'), blocks.length * 100) });
    quote = [];
  };
  const flush = () => {
    flushPara();
    flushQuote();
  };

  lines.forEach((raw) => {
    const line = raw.trim();
    if (!line) {
      flush();
      return;
    }

    const img = line.match(IMAGE_RE);
    if (img) {
      flush();
      push({ type: 'img', src: asset(img[2], base), alt: img[1] });
      return;
    }
    if (HR_RE.test(line)) {
      flush();
      push({ type: 'hr' });
      return;
    }
    const heading = line.match(HEADING_RE);
    if (heading) {
      flush();
      push({ type: 'h', level: heading[1].length, spans: inline(heading[2], blocks.length * 100) });
      return;
    }
    const item = line.match(LIST_RE);
    if (item) {
      flushQuote();
      flushPara();
      push({ type: 'li', spans: inline(item[1], blocks.length * 100) });
      return;
    }
    const quoted = line.match(QUOTE_RE);
    if (quoted) {
      flushPara();
      if (quoted[1]) quote.push(quoted[1]);
      return;
    }
    flushQuote();
    para.push(line);
  });

  flush();
  return blocks;
}

Component({
  properties: {
    source: { type: String, value: '' },
    /** 图片基址：内置包为 /packs/{id}/，在线包为本地目录 */
    base: { type: String, value: '' },
    /** 展开后正文窗口上沿允许到达的屏幕纵坐标（px），由 scene 量得 */
    top: { type: Number, value: 0 },
    /** 立绘底边相对正文顶部的距离（px）：文字越过这里后由窄栏改为通栏 */
    wrap: { type: Number, value: 0 }
  },

  data: {
    blocks: [],
    /** 窗口当前高度：默认等于前 3 块的自然高度 */
    winH: 0,
    /** 正文在窗口内继续上移的距离 */
    offset: 0,
    foldH: 0,
    maxH: 0,
    maxOff: 0,
    contentH: 0,
    /** 正文是否超出折叠块数：决定纵向手势由谁接管 */
    pullable: false,
    /** 窗口底部渐隐：提示下面还有文字 */
    faded: false,
    /** 绕排立绘的浮动占位：起点与当前高度（px） */
    wrapBase: 0,
    wrapH: 0,
    noAnim: true
  },

  observers: {
    'source, base': function (source, base) {
      const blocks = parseMarkdown(source, base);
      this.ready = false;
      this.setData({
        blocks: blocks,
        winH: 0,
        offset: 0,
        foldH: 0,
        maxH: 0,
        maxOff: 0,
        faded: false,
        pullable: false,
        noAnim: true
      });
      wx.nextTick(() => this.layout());
    },

    'top, wrap'() {
      this.wrapPass = 0;
      if (this.data.blocks.length) wx.nextTick(() => this.layout());
    }
  },

  methods: {
    /** 量一次：前 3 块高度、正文总高、窗口最多能长到多高 */
    layout() {
      if (!this.data.blocks.length) return;

      this.createSelectorQuery()
        .select('.md')
        .boundingClientRect()
        .select('.md-win')
        .boundingClientRect()
        .selectAll('.md-block')
        .boundingClientRect()
        .exec((res) => {
          const md = res[0];
          const win = res[1];
          const blocks = res[2] || [];
          if (!md || !win || !blocks.length) return;

          const first = blocks[0];
          const last = blocks[blocks.length - 1];
          const contentH = Math.max(1, Math.round(last.bottom - first.top) + 2);
          const FOLD = 3;
          // 折叠高度要让出底部渐隐，否则第三块最后一行会被渐隐压暗
          const FADE_H = 32;
          const foldH =
            blocks.length > FOLD
              ? Math.min(contentH, Math.round(blocks[FOLD].top - first.top) + FADE_H)
              : contentH;

          // 窗口最多长到 scene 给的顶部界线
          const info = wx.getSystemInfoSync();
          const limit = this.data.top > 0 ? this.data.top : Math.round(info.windowHeight * 0.34);
          const grow = Math.max(0, Math.round(win.top - limit));
          const maxH = Math.max(foldH, Math.min(contentH, foldH + grow));
          const maxOff = Math.max(0, contentH - maxH);

          const ready = this.ready;
          const winH = ready ? Math.min(Math.max(this.data.winH, foldH), maxH) : foldH;
          const offset = ready ? Math.min(this.data.offset, maxOff) : 0;
          const pullable = contentH - foldH > 2;

          // 立绘绕排：占位随正文一起上移同步长高，底边始终对齐立绘底边
          const rawWrap = Math.max(0, Math.round(this.data.wrap));
          const wrapH = rawWrap > 0 ? rawWrap + offset : 0;
          const wrapChanged = Math.abs((this.data.wrapH || 0) - wrapH) > 1;

          this.ready = true;
          this.setData({
            contentH: contentH,
            foldH: foldH,
            maxH: maxH,
            maxOff: maxOff,
            winH: winH,
            offset: offset,
            pullable: pullable,
            faded: contentH - offset > winH + 2,
            wrapBase: rawWrap,
            wrapH: wrapH
          });

          // 占位高度变化会改变换行行数，再量一次让折叠高度与总高收敛
          if (rawWrap > 0 && wrapChanged && (this.wrapPass || 0) < 2) {
            this.wrapPass = (this.wrapPass || 0) + 1;
            wx.nextTick(() => this.layout());
          }

          if (this.data.noAnim) {
            // 首次定位不做高度动画，下一帧再恢复过渡
            wx.nextTick(() => this.setData({ noAnim: false }));
          }

          // 每次都回报一次：父级 scene 切幕时会清零可拉状态
          this.triggerEvent('pullable', { value: pullable });
        });
    },

    /** WXS 跟手结束：窗口与位移已渲染到位，这里只同步数据与渐隐 */
    onPullEnd(e) {
      const detail = (e && e.detail) || {};
      const winH = Math.round(Number(detail.height) || 0);
      const offset = Math.round(Number(detail.offset) || 0);
      const rawWrap = Math.max(0, Math.round(this.data.wrap));
      const wrapH = rawWrap > 0 ? rawWrap + offset : 0;
      this.setData(
        {
          winH: winH,
          offset: offset,
          wrapH: wrapH,
          faded: this.data.contentH - offset > winH + 2
        },
        () => {
          const open = winH > this.data.foldH + 2;
          if (open !== this.openState) {
            this.openState = open;
            this.triggerEvent('state', { open: open });
          }
          // 绕排占位变化会改变行数：重新量一次，让总高与可上拉范围收敛
          this.wrapPass = 0;
          this.layout();
        }
      );
    },

    /** 切幕时由 scene 调用：窗口回到折叠态 */
    reset() {
      this.openState = false;
      if (!this.ready) return;
      const rawWrap = Math.max(0, Math.round(this.data.wrap));
      this.setData(
        {
          winH: this.data.foldH,
          offset: 0,
          wrapH: rawWrap,
          faded: this.data.contentH > this.data.foldH + 2
        }
      );
      this.triggerEvent('state', { open: false });
    },

    /** 内嵌图加载后高度变化，重新量一次 */
    onImgLoad() {
      clearTimeout(this.imgTimer);
      this.imgTimer = setTimeout(() => this.layout(), 80);
    },

    onPreview(e) {
      const src = e.currentTarget.dataset.src;
      if (!src) return;
      const urls = this.data.blocks
        .filter((block) => block.type === 'img')
        .map((block) => block.src);
      wx.previewImage({ current: src, urls: urls });
    }
  }
});
