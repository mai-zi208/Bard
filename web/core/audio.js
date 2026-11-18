/**
 * 讲解音频播放：全局单例 InnerAudioContext，同一时刻只播一幕。
 * 本地已下载文件优先，否则流播 CDN 地址。
 */
let ctx = null;
/** 当前播放源标识（本地路径或远程 URL），空串表示未播放 */
let currentKey = '';
let listener = null;

function ensure() {
  if (ctx) return ctx;
  ctx = wx.createInnerAudioContext();
  ctx.onEnded(() => {
    currentKey = '';
    notify();
  });
  ctx.onError(() => {
    currentKey = '';
    notify('error');
  });
  return ctx;
}

function notify(state) {
  if (!listener) return;
  listener(state || (currentKey ? 'playing' : 'stopped'));
}

/** 注册播放状态回调（组件切幕时覆盖，最后一个激活者生效） */
function onChange(fn) {
  listener = fn;
}

/**
 * 点按切换：同一幕再点即停止，换幕则停旧播新。
 * 返回 'playing' | 'stopped' | 'error'。
 */
function toggle(audio) {
  if (!audio || !audio.remoteUrl) return 'error';
  const player = ensure();
  const key = audio.localPath || audio.remoteUrl;
  if (currentKey === key) {
    player.stop();
    currentKey = '';
    notify();
    return 'stopped';
  }
  player.stop();
  player.src = key;
  player.play();
  currentKey = key;
  notify();
  return 'playing';
}

/** 切幕或页面离开时停播 */
function stop() {
  if (!currentKey) return;
  if (ctx) ctx.stop();
  currentKey = '';
  notify();
}

module.exports = {
  onChange: onChange,
  toggle: toggle,
  stop: stop
};
