/**
 * 主题输入安全检测：在进入生成队列前拦住明显不合法或不适宜的景物名。
 * 只做轻量规则校验，不依赖外部内容安全服务。
 */

export interface TopicGuardResult {
  ok: boolean;
  reason?: string;
}

const MIN_LENGTH = 2;
const MAX_LENGTH = 30;
/** 与 pack.json 的 narrator.name 上限一致，避免长身份在装配校验时才失败 */
const PERSONA_MAX_LENGTH = 8;
/** 中文、字母、数字、空格与常见分隔符 */
const VALID_CHARS = /^[\u4e00-\u9fa5a-zA-Z0-9\s·-]+$/;

/** 简短敏感词表：命中即拒绝，避免把违规主题送进生成流水线 */
const BLOCKED_WORDS = [
  '色情',
  '裸体',
  '赌博',
  '毒品',
  '制毒',
  '枪支',
  '弹药',
  '恐怖袭击',
  '邪教',
  '诈骗',
  '洗钱',
  '自杀',
  '杀人',
  '代开发票'
];

export function guardTopic(raw: string): TopicGuardResult {
  const topic = String(raw ?? '').trim();

  if (topic.length < MIN_LENGTH) {
    return { ok: false, reason: '景物名称至少 2 个字' };
  }

  if (topic.length > MAX_LENGTH) {
    return { ok: false, reason: '景物名称不能超过 30 个字' };
  }

  if (!VALID_CHARS.test(topic)) {
    return { ok: false, reason: '景物名称只能包含中文、字母、数字与空格' };
  }

  if (BLOCKED_WORDS.some((word) => topic.includes(word))) {
    return { ok: false, reason: '景物名称包含不适宜的内容' };
  }

  return { ok: true };
}

/** 人物身份可选：为空表示现代导游，非空时同时影响文稿口吻、插画与音色 */
export function guardPersona(raw: string): TopicGuardResult {
  const persona = String(raw ?? '').trim();
  if (!persona) return { ok: true };

  if (persona.length < MIN_LENGTH) {
    return { ok: false, reason: '人物身份至少 2 个字' };
  }

  if (persona.length > PERSONA_MAX_LENGTH) {
    return { ok: false, reason: '人物身份不能超过 8 个字' };
  }

  if (!VALID_CHARS.test(persona)) {
    return { ok: false, reason: '人物身份只能包含中文、字母、数字与空格' };
  }

  if (BLOCKED_WORDS.some((word) => persona.includes(word))) {
    return { ok: false, reason: '人物身份包含不适宜的内容' };
  }

  return { ok: true };
}
