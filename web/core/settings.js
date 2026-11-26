/**
 * 模型密钥设置：用户在右上角设置面板填写，仅存本机 storage。
 * 提交 /plan 与 /tasks 请求时以 x-llm-key / x-image-key / x-tts-key 头带上，
 * 服务端优先用自带密钥，未填的项回退服务端 .env 配置。
 */
const KEYS_STORAGE = 'model_keys_v1';

function getKeys() {
  let saved = null;
  try {
    saved = wx.getStorageSync(KEYS_STORAGE);
  } catch (err) {
    saved = null;
  }
  const keys = saved && typeof saved === 'object' ? saved : {};
  return {
    llm: String(keys.llm || '').trim(),
    image: String(keys.image || '').trim(),
    tts: String(keys.tts || '').trim()
  };
}

function setKeys(keys) {
  try {
    wx.setStorageSync(KEYS_STORAGE, {
      llm: String((keys && keys.llm) || '').trim(),
      image: String((keys && keys.image) || '').trim(),
      tts: String((keys && keys.tts) || '').trim()
    });
  } catch (err) {
    /* 存储失败不影响本次使用 */
  }
}

/** 已填密钥对应的请求头；全空时返回 {} */
function keyHeaders() {
  const keys = getKeys();
  const headers = {};
  if (keys.llm) headers['x-llm-key'] = keys.llm;
  if (keys.image) headers['x-image-key'] = keys.image;
  if (keys.tts) headers['x-tts-key'] = keys.tts;
  return headers;
}

module.exports = {
  getKeys: getKeys,
  setKeys: setKeys,
  keyHeaders: keyHeaders
};
