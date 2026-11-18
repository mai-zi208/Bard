/**
 * 下一幕素材预热：并发上限 2，重复地址只处理一次。
 */
const MAX = 2;

const seen = {};
let queue = [];
let active = 0;

function drain() {
  while (active < MAX && queue.length) {
    const url = queue.shift();
    active += 1;
    wx.getImageInfo({
      src: url,
      complete() {
        active -= 1;
        drain();
      }
    });
  }
}

function warm(urls) {
  (urls || []).forEach((url) => {
    if (!url || seen[url]) return;
    seen[url] = true;
    queue.push(url);
  });
  drain();
}

function clear() {
  queue = [];
}

module.exports = {
  warm: warm,
  clear: clear
};
