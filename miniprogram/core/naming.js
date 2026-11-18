/**
 * 资源包命名与输入解析：从 packs 页抽出，供列表页与路线规划页共用。
 * 归一化规则与服务端保持一致。
 */

/** 同名判定：去空白、行政区前缀与「景区」后缀，与服务端归一化保持一致 */
function normalizeName(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/^(?:河南省|洛阳市|洛阳)+/, '')
    .replace(/(?:风景区|景区)$/, '')
    .toLowerCase();
}

/** 「导游」「现代导游」与空串都表示默认讲述人，与服务端归一化保持一致 */
function normalizePersonaName(value) {
  const name = String(value || '').trim();
  if (!name || name === '导游' || name === '现代导游') return '';
  return name;
}

/** 资源包身份：同标题 + 同讲述人视为同一个包，不再区分内置与在线 */
function packKey(title, narratorName) {
  return normalizeName(title) + '|' + normalizePersonaName(narratorName);
}

/**
 * 资源包显示名：有明确讲述人时拼上「·人物名」，默认讲述人保持景点名。
 */
function displayTitle(title, narratorName) {
  const persona = normalizePersonaName(narratorName);
  return persona ? title + '·' + persona : title;
}

/** 字符级编辑距离：用于识别地名的错别字 */
function editDistance(a, b) {
  if (a === b) return 0;
  const n = b.length;
  let prev = [];
  let curr = [];
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1)
      );
    }
    prev = curr.slice();
  }
  return prev[n];
}

/** 输入约定「景点-人物身份」：最后一个横线前是景物，横线后是人物 */
function parseInput(value) {
  const raw = String(value || '').trim();
  const parts = raw.split(/\s*[-－—–]\s*/);
  if (parts.length < 2) return { topic: raw, persona: '' };

  const persona = parts.pop().trim();
  const topic = parts.join('-').trim();
  if (topic.length < 2 || persona.length < 2) return { topic: raw, persona: '' };
  return { topic: topic, persona: persona };
}

module.exports = {
  normalizeName: normalizeName,
  normalizePersonaName: normalizePersonaName,
  packKey: packKey,
  displayTitle: displayTitle,
  editDistance: editDistance,
  parseInput: parseInput
};
