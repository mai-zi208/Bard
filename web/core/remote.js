/**
 * 远端清单：只负责拉 manifest.json 与拼文件地址。
 * 请求失败静默降级：有缓存用上一次的清单，没有则返回空列表，页面继续用内置包。
 */
const config = require('../config');

const SUPPORTED_SCHEMA = 1;
/** 清单缓存时长：5 分钟内的重复读取不再发请求 */
const CACHE_TTL = 5 * 60 * 1000;

let cached = null;

/** 缓存仍新鲜时返回清单，否则返回 null */
function cachedManifest() {
  if (!cached) return null;
  return Date.now() - cached.at < CACHE_TTL ? cached.packs : null;
}

function fetchManifest(force) {
  const fresh = force ? null : cachedManifest();
  if (fresh) return Promise.resolve(fresh);

  if (!config.CDN_BASE) return Promise.resolve(cached ? cached.packs : []);

  return new Promise((resolve) => {
    wx.request({
      url: config.CDN_BASE + '/manifest.json',
      timeout: config.REQUEST_TIMEOUT || 5000,
      success(res) {
        const data = res.data;
        if (res.statusCode !== 200 || !data || !Array.isArray(data.packs)) {
          resolve(cached ? cached.packs : []);
          return;
        }
        // 清单版本未知时整份忽略，继续用内置包与已下载包
        const version = data.schemaVersion;
        if (version !== undefined && version !== null && version !== SUPPORTED_SCHEMA) {
          resolve(cached ? cached.packs : []);
          return;
        }
        cached = { at: Date.now(), packs: data.packs };
        resolve(data.packs);
      },
      fail() {
        resolve(cached ? cached.packs : []);
      }
    });
  });
}

function packBase(id) {
  return config.CDN_BASE + '/' + id + '/';
}

module.exports = {
  fetchManifest: fetchManifest,
  cachedManifest: cachedManifest,
  packBase: packBase
};
