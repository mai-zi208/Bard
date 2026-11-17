/**
 * 人物音色：按讲述人挑豆包「语音合成模型 2.0」音色。
 * 音色 ID 取自官方音色列表，并已在本账号逐条实测可调用。
 * 没有人物、或人物不在表内且看不出性别时返回 undefined，由调用方使用环境配置的默认音色。
 */
const NVLEISHEN = 'zh_female_nvleishen_uranus_bigtts';
const CANCAN = 'zh_female_cancan_uranus_bigtts';
const SOPHIE = 'zh_female_sophie_uranus_bigtts';
const YUNZHOU = 'zh_male_m191_uranus_bigtts';
const XIAOTIAN = 'zh_male_taocheng_uranus_bigtts';

/** 已收录人物：音色贴合身份，女性帝王/贵妃/女官/词人，男性文人/帝王将相 */
const CAST: Record<string, string> = {
  武则天: NVLEISHEN,
  花木兰: NVLEISHEN,
  上官婉儿: CANCAN,
  李清照: CANCAN,
  甄宓: CANCAN,
  杨贵妃: SOPHIE,
  王昭君: SOPHIE,
  李白: YUNZHOU,
  杜甫: YUNZHOU,
  白居易: YUNZHOU,
  苏轼: YUNZHOU,
  玄奘: YUNZHOU,
  老子: YUNZHOU,
  孔子: YUNZHOU,
  周公: YUNZHOU,
  班超: YUNZHOU,
  张衡: YUNZHOU,
  蔡伦: YUNZHOU,
  司马光: YUNZHOU,
  范仲淹: YUNZHOU,
  曹操: XIAOTIAN,
  关羽: XIAOTIAN,
  岳飞: XIAOTIAN,
  汉明帝: XIAOTIAN
};

/** 明显女性称谓；先于男性判断，避免「女帝」被「帝」误判 */
const FEMALE_MARK = /女|妃|太后|皇后|公主|娘娘|夫人|婉儿|姬|母|姑|婆|姐|妹|小姐|女士/;
/** 明显男性称谓 */
const MALE_MARK = /帝|王|侯|将军|元帅|僧|法师|大师|先生|父|郎|公子/;

export function resolvePersonaSpeaker(persona: string): string | undefined {
  const name = persona.trim();
  if (!name) return undefined;

  const cast = CAST[name];
  if (cast) return cast;
  if (FEMALE_MARK.test(name)) return NVLEISHEN;
  if (MALE_MARK.test(name)) return YUNZHOU;
  return undefined;
}
