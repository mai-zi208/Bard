import { createHash } from 'node:crypto';

/** 已收录人物的拼音 slug，用于稳定生成人物变体 id */
const PERSONA_SLUGS: Record<string, string> = {
  武则天: 'wuzetian',
  杨贵妃: 'yangguifei',
  上官婉儿: 'shangguanwaner',
  李清照: 'liqingzhao',
  李白: 'libai',
  杜甫: 'dufu',
  白居易: 'baijuyi',
  苏轼: 'sushi',
  曹操: 'caocao',
  关羽: 'guanyu',
  玄奘: 'xuanzang',
  汉明帝: 'hanmingdi'
};

/** 「导游」「现代导游」与空串都表示母本，不产出人物变体 */
export function normalizePersona(value: string): string {
  const name = String(value || '').trim();
  if (!name || name === '导游' || name === '现代导游') return '';
  return name;
}

/** 人物名转 id 片段：已收录人物用拼音，其他人物用稳定短哈希 */
export function personaSlug(persona: string): string {
  const name = normalizePersona(persona);
  if (!name) return '';
  const known = PERSONA_SLUGS[name];
  if (known) return known;
  return 'p' + createHash('sha1').update(name).digest('hex').slice(0, 6);
}

/** 人物变体 id：{母本 id}--{人物 slug}，同一人物全用户共享 */
export function variantId(masterId: string, persona: string): string {
  const slug = personaSlug(persona);
  return slug ? `${masterId}--${slug}` : masterId;
}
