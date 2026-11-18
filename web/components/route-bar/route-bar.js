function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

Component({
  properties: {
    index: {
      type: Number,
      value: 0
    },
    total: {
      type: Number,
      value: 0
    }
  },

  data: {
    ticks: [],
    currentLabel: '01',
    totalLabel: '00',
    fill: 0
  },

  observers: {
    'index, total': function (index, total) {
      const ticks = [];
      for (let i = 0; i < total; i += 1) ticks.push(i);
      const ratio = total > 1 ? index / (total - 1) : 1;
      this.setData({
        ticks: ticks,
        currentLabel: pad(index + 1),
        totalLabel: pad(total),
        fill: Math.round(ratio * 1000) / 1000
      });
    }
  },

  methods: {
    onTap(e) {
      const index = Number(e.currentTarget.dataset.index);
      this.triggerEvent('select', { index: index });
    }
  }
});
