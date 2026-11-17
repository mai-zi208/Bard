/** 与小程序 loader 一致的本地化取值：字符串直接用，对象按语言回退 */
export function pickLocalized(value: unknown, locale: string): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const map = value as Record<string, unknown>;
    const hit = map[locale] ?? map[Object.keys(map)[0] ?? ''];
    return typeof hit === 'string' ? hit : '';
  }
  return '';
}
