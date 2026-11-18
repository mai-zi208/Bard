/**
 * 在线包本地缓存：内置包不走这里。
 * 元数据记录在 storage，文件落在 USER_DATA_PATH/packs/{id}/。
 */
const sha256 = require('./sha256.js');

const KEY = 'packs:local';
/** 用户主动删除的在线包：记录删除时的远端版本，列表不再展示，直到远端版本更高 */
const KEY_HIDDEN = 'packs:hidden';
/** 已下载讲解音频的包：音频在包目录之外（USER_DATA_PATH/audio/{id}/），与包更新互不影响 */
const KEY_AUDIO = 'packs:audio';
/** 本地包缓存总量上限 */
const MAX_BYTES = 120 * 1024 * 1024;

function readMeta() {
  try {
    return wx.getStorageSync(KEY) || {};
  } catch (err) {
    return {};
  }
}

function writeMeta(meta) {
  try {
    wx.setStorageSync(KEY, meta);
  } catch (err) {
    /* 存储写入失败时保持现状 */
  }
}

function readHidden() {
  try {
    return wx.getStorageSync(KEY_HIDDEN) || {};
  } catch (err) {
    return {};
  }
}

/** 记下被用户删除的在线包，避免刷新后又被清单拉回列表 */
function hide(id, version) {
  const hidden = readHidden();
  hidden[id] = version || 0;
  try {
    wx.setStorageSync(KEY_HIDDEN, hidden);
  } catch (err) {
    /* 存储写入失败时保持现状 */
  }
}

/** 远端版本高于删除时的版本才重新出现，便于用户收到更新 */
function isHidden(id, version) {
  const hidden = readHidden();
  return hidden[id] !== undefined && (version || 0) <= hidden[id];
}

function listLocal() {
  const meta = readMeta();
  return Object.keys(meta).map((id) => Object.assign({ id: id }, meta[id]));
}

function isLocal(id) {
  return !!readMeta()[id];
}

function touch(id) {
  const meta = readMeta();
  if (!meta[id]) return;
  meta[id].lastUsedAt = Date.now();
  writeMeta(meta);
}

function markDownloaded(id, version, bytes) {
  const meta = readMeta();
  meta[id] = {
    id: id,
    version: version || 1,
    bytes: bytes || 0,
    lastUsedAt: Date.now()
  };
  writeMeta(meta);
  // 用户主动重新下载即视为要展示：清除删除时留下的隐藏标记，列表立刻恢复
  const hidden = readHidden();
  if (hidden[id] !== undefined) {
    delete hidden[id];
    try {
      wx.setStorageSync(KEY_HIDDEN, hidden);
    } catch (err) {
      /* 存储写入失败时保持现状 */
    }
  }
  // 包换版本后旧音频可能与新文稿不符：版本不同即作废，用户可重新存音频
  const audio = readAudioMeta();
  if (audio[id] && (audio[id].version || 0) !== (version || 1)) {
    delete audio[id];
    writeAudioMeta(audio);
    rmrf(audioDirOf(id));
  }
  evictIfNeeded();
}

function remove(id) {
  const meta = readMeta();
  if (meta[id]) {
    delete meta[id];
    writeMeta(meta);
  }
  // 正式目录与更新残留的临时/备份目录一并清掉；讲解音频随包删除
  rmrf(dirOf(id));
  rmrf(tempDirOf(id));
  rmrf(bakDirOf(id));
  rmrf(audioDirOf(id));
  const audio = readAudioMeta();
  if (audio[id]) {
    delete audio[id];
    writeAudioMeta(audio);
  }
}

function evictIfNeeded(limit) {
  const meta = readMeta();
  const list = Object.keys(meta).map((id) => meta[id]);
  let total = list.reduce((sum, item) => sum + (item.bytes || 0), 0);
  const max = limit || MAX_BYTES;
  if (total <= max) return;

  list.sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));
  list.forEach((item) => {
    if (total <= max) return;
    total -= item.bytes || 0;
    remove(item.id);
  });
}

function rootOf() {
  return wx.env.USER_DATA_PATH + '/packs';
}

function readAudioMeta() {
  try {
    return wx.getStorageSync(KEY_AUDIO) || {};
  } catch (err) {
    return {};
  }
}

function writeAudioMeta(meta) {
  try {
    wx.setStorageSync(KEY_AUDIO, meta);
  } catch (err) {
    /* 存储写入失败时保持现状 */
  }
}

/** 讲解音频本地目录：在包目录之外，包更新换入时不受影响 */
function audioDirOf(id) {
  return wx.env.USER_DATA_PATH + '/audio/' + id;
}

/** 该包音频的下载记录；未下载返回 null */
function audioState(id) {
  return readAudioMeta()[id] || null;
}

/**
 * 下载整包讲解音频到音频目录：串行逐幕下载并校验，任一幕失败整体删除重来。
 * items: [{ rel, url, expected: { size, sha256 } }]
 */
function downloadAudio(id, version, items, onProgress) {
  const dir = audioDirOf(id);
  let bytes = 0;

  return rmrf(dir)
    .then(() => {
      ensureDir(dir);
      const step = (i) => {
        if (i >= items.length) return Promise.resolve();
        const item = items[i];
        const target = dir + '/' + item.rel;
        return downloadFile(item.url, target).then((size) =>
          verifyFile(target, item.rel, item.expected).then(() => {
            bytes += size;
            if (onProgress) onProgress(i + 1, items.length);
            return step(i + 1);
          })
        );
      };
      return step(0);
    })
    .then(() => {
      const meta = readAudioMeta();
      meta[id] = { version: version || 1, bytes: bytes, at: Date.now() };
      writeAudioMeta(meta);
      return bytes;
    })
    .catch((err) =>
      rmrf(dir).then(() => {
        throw err;
      })
    );
}

/** 删除整包音频与记录 */
function removeAudio(id) {
  const meta = readAudioMeta();
  if (meta[id]) {
    delete meta[id];
    writeAudioMeta(meta);
  }
  return rmrf(audioDirOf(id));
}

function dirOf(id) {
  return rootOf() + '/' + id;
}

/** 更新时先写这里，全部校验通过后再整体换入正式目录 */
function tempDirOf(id) {
  return rootOf() + '/.tmp-' + id;
}

/** 换入前暂存旧版本；换入成功后删除，失败则还原 */
function bakDirOf(id) {
  return rootOf() + '/.bak-' + id;
}

function ensureDir(dir) {
  try {
    wx.getFileSystemManager().mkdirSync(dir, true);
  } catch (err) {
    /* 目录已存在 */
  }
}

/** 递归删除目录；目录不存在或删除失败都按已清理处理 */
function rmrf(dir) {
  return new Promise((resolve) => {
    wx.getFileSystemManager().rmdir({
      dirPath: dir,
      recursive: true,
      success() {
        resolve();
      },
      fail() {
        resolve();
      }
    });
  });
}

/** 旧版本里同路径文件与清单一致时为真：可直接复制，省一次网络下载 */
function reusable(oldTarget, expected) {
  if (!expected) return false;
  const fs = wx.getFileSystemManager();
  let size = -1;
  try {
    size = fs.statSync(oldTarget).size || 0;
  } catch (err) {
    return false;
  }
  if (expected.size && size !== expected.size) return false;
  if (!expected.sha256) return true;

  let buffer;
  try {
    buffer = fs.readFileSync(oldTarget);
  } catch (err) {
    return false;
  }
  return sha256.hash(buffer) === expected.sha256;
}

/** 本地复制；返回落盘字节数，失败时由调用方改为下载 */
function copyFile(from, to) {
  const fs = wx.getFileSystemManager();
  try {
    fs.unlinkSync(to);
  } catch (err) {
    /* 目标文件本就不存在 */
  }
  fs.copyFileSync(from, to);
  return fs.statSync(to).size || 0;
}

function downloadFile(url, target) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url: url,
      timeout: 20000,
      success(res) {
        if (res.statusCode !== 200) {
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        const fs = wx.getFileSystemManager();
        try {
          fs.unlinkSync(target);
        } catch (err) {
          /* 目标文件本就不存在 */
        }
        try {
          fs.saveFileSync(res.tempFilePath, target);
          resolve(fs.statSync(target).size || 0);
        } catch (err) {
          reject(err);
        }
      },
      fail(err) {
        reject(err);
      }
    });
  });
}

/**
 * 校验已下载文件：先比大小，再比 sha256。
 * 清单未提供 checksums 时跳过，兼容旧清单。
 */
function verifyFile(target, rel, expected) {
  if (!expected) return Promise.resolve();

  let size = -1;
  try {
    size = wx.getFileSystemManager().statSync(target).size || 0;
  } catch (err) {
    size = -1;
  }
  if (size < 0) return Promise.reject(new Error('文件缺失：' + rel));
  if (expected.size && size !== expected.size) {
    return Promise.reject(new Error('文件大小不符：' + rel));
  }
  if (!expected.sha256) return Promise.resolve();

  let buffer;
  try {
    buffer = wx.getFileSystemManager().readFileSync(target);
  } catch (err) {
    return Promise.reject(new Error('文件读取失败：' + rel));
  }
  if (sha256.hash(buffer) !== expected.sha256) {
    return Promise.reject(new Error('文件校验失败：' + rel));
  }
  return Promise.resolve();
}

/** 包文件按清单转成下载任务表 */
function buildTasks(pack, dir) {
  const checksums = pack.checksums || {};
  return (pack.files || []).map((rel) => ({
    rel: rel,
    url: pack.baseUrl + rel,
    target: dir + '/' + rel,
    expected: checksums[rel]
  }));
}

function parentOf(target) {
  return target.slice(0, target.lastIndexOf('/'));
}

/** 单个任务：旧版本同路径文件校验一致就本地复制，否则下载并按清单校验 */
function fetchOne(item, oldTarget) {
  if (oldTarget && reusable(oldTarget, item.expected)) {
    try {
      return Promise.resolve(copyFile(oldTarget, item.target));
    } catch (err) {
      /* 复制失败回落为下载 */
    }
  }
  return downloadFile(item.url, item.target).then((size) =>
    verifyFile(item.target, item.rel, item.expected).then(() => size)
  );
}

/** 全部文件校验通过后换入：旧目录先改名备份，失败还原，避免更新中断丢掉旧包 */
function swapIn(id, tmpDir, finalDir, bakDir) {
  const fs = wx.getFileSystemManager();
  let hasOld = true;
  try {
    fs.accessSync(finalDir);
  } catch (err) {
    hasOld = false;
  }

  return rmrf(bakDir).then(() => {
    if (hasOld) fs.renameSync(finalDir, bakDir);
    try {
      fs.renameSync(tmpDir, finalDir);
    } catch (err) {
      if (hasOld) {
        try {
          fs.renameSync(bakDir, finalDir);
        } catch (restoreErr) {
          /* 还原失败时保留 .bak，下次下载会重新覆盖 */
        }
      }
      throw err;
    }
    return rmrf(bakDir);
  });
}

/**
 * 按清单顺序下载包文件并逐个校验，全部通过后原子换入正式目录。
 * 旧版本同名且摘要一致的文件直接本地复制，只下载变化的部分；
 * 任一步失败只清理临时目录，旧包保持可用。
 */
function downloadPack(pack, onProgress) {
  const finalDir = dirOf(pack.id);
  const tmpDir = tempDirOf(pack.id);
  const bakDir = bakDirOf(pack.id);
  let bytes = 0;

  return rmrf(tmpDir)
    .then(() => {
      ensureDir(tmpDir);
      const tasks = buildTasks(pack, tmpDir);
      const step = (i) => {
        if (i >= tasks.length) return Promise.resolve();
        const item = tasks[i];
        ensureDir(parentOf(item.target));
        return fetchOne(item, finalDir + '/' + item.rel).then((size) => {
          bytes += size;
          if (onProgress) onProgress(i + 1, tasks.length);
          return step(i + 1);
        });
      };
      return step(0);
    })
    .then(() => swapIn(pack.id, tmpDir, finalDir, bakDir))
    .then(() => {
      markDownloaded(pack.id, pack.version, bytes);
      return bytes;
    })
    .catch((err) => {
      // 失败只清临时目录；旧版本仍在正式目录里，可继续离线使用
      return rmrf(tmpDir).then(() => {
        throw err;
      });
    });
}

module.exports = {
  listLocal: listLocal,
  isLocal: isLocal,
  touch: touch,
  markDownloaded: markDownloaded,
  downloadPack: downloadPack,
  remove: remove,
  hide: hide,
  isHidden: isHidden,
  evictIfNeeded: evictIfNeeded,
  audioState: audioState,
  downloadAudio: downloadAudio,
  removeAudio: removeAudio
};
