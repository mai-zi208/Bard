import type { PublishedPack, SourceEntry } from '../types.ts';

/**
 * 主题归一化：去空白、去行政区前缀与「景区」后缀、统一小写。
 * 「洛阳市龙门石窟景区」与「龙门石窟」应视为同一主题。
 */
export function normalizeTopic(value: string): string {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/^(?:河南省|洛阳市|洛阳)+/, '')
    .replace(/(?:风景区|景区)$/, '')
    .toLowerCase();
}

function related(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/** 只匹配母本：人物变体与母本同标题，不能让变体顶替母本 */
export function matchSource(sources: SourceEntry[], topic: string): SourceEntry | null {
  const key = normalizeTopic(topic);
  if (!key) return null;

  const masters = sources.filter((source) => !source.masterId);
  const exact = masters.find(
    (source) => normalizeTopic(source.id) === key || source.titleNorm === key
  );
  if (exact) return exact;

  return masters.find((source) => related(source.titleNorm, key)) ?? null;
}

/** 按母本 id + 讲述人匹配人物变体；同一人物全用户共享 */
export function matchVariant(
  sources: SourceEntry[],
  masterId: string,
  persona: string
): SourceEntry | null {
  if (!masterId || !persona) return null;
  return (
    sources.find(
      (source) => source.masterId === masterId && source.persona === persona
    ) ?? null
  );
}

export function matchPublished(packs: PublishedPack[], topic: string): PublishedPack | null {
  const key = normalizeTopic(topic);
  if (!key) return null;

  const exact = packs.find(
    (pack) => normalizeTopic(pack.id) === key || normalizeTopic(pack.title) === key
  );
  if (exact) return exact;

  return packs.find((pack) => related(normalizeTopic(pack.title), key)) ?? null;
}
