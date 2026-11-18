const guide = require('../../core/guide');

Component({
  properties: {
    /** 当前资源包已装饰的幕列表（含正文纯文本） */
    scenes: {
      type: Array,
      value: []
    },
    current: {
      type: Number,
      value: 0
    },
    /** 状态栏高度，入口与左上角返回键同高 */
    top: {
      type: Number,
      value: 20
    },
    narratorName: {
      type: String,
      value: ''
    },
    packTitle: {
      type: String,
      value: ''
    }
  },

  data: {
    open: false,
    draft: '',
    messages: [],
    quick: guide.QUICK,
    anchor: '',
    seq: 0
  },

  methods: {
    onOpen() {
      const messages = this.data.messages.length
        ? this.data.messages
        : [
            {
              id: 1,
              role: 'guide',
              text:
                '我是「' +
                (this.data.packTitle || '这个资源包') +
                '」的向导。可以问我怎么走、周边有什么，或直接问某处景物。',
              action: null
            }
          ];

      this.setData({
        open: true,
        messages: messages,
        seq: messages.length ? this.data.seq : 1,
        anchor: 'm-' + messages[messages.length - 1].id
      });
      this.triggerEvent('toggle', { open: true });
    },

    onClose() {
      if (!this.data.open) return;
      this.setData({ open: false });
      this.triggerEvent('toggle', { open: false });
    },

    onInput(e) {
      this.setData({ draft: e.detail.value });
    },

    onQuick(e) {
      this.ask(e.currentTarget.dataset.q);
    },

    onSend() {
      this.ask(this.data.draft);
    },

    ask(text) {
      const question = String(text || '').trim();
      if (!question) return;

      const reply = guide.answer(question, {
        scenes: this.data.scenes,
        current: this.data.current,
        narratorName: this.data.narratorName,
        packTitle: this.data.packTitle,
        pois: this.data.pois
      });

      const seq = this.data.seq + 1;
      const messages = this.data.messages
        .concat([
          { id: seq, role: 'user', text: question, action: null },
          { id: seq + 1, role: 'guide', text: reply.text, action: reply.action || null }
        ])
        .slice(-16);

      this.setData({
        messages: messages,
        draft: '',
        seq: seq + 1,
        anchor: 'm-' + (seq + 1)
      });
    },

    onJump(e) {
      const index = Number(e.currentTarget.dataset.index);
      if (!(index >= 0)) return;
      this.setData({ open: false });
      this.triggerEvent('toggle', { open: false });
      this.triggerEvent('jump', { index: index });
    },

    noop() {}
  }
});
