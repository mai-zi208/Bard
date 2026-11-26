import type { AttractionContent, ResearchMaterial, ResearchProvider } from '../../domain/ports.ts';
import type { AttractionRepository } from '../repositories/attraction-repository.ts';
import { originalImageUrl } from '../../scripts/import-attractions.ts';

/** 与在线检索一致的正文上限，防止超长词条撑爆提示词 */
const MAX_CHARS = 12000;

/**
 * 三层递进取材：景点内容库命中（该城市有该景点且介绍充足）直接用库内词条，
 * 未命中/介绍过短/库未导入时委托回退 provider（在线检索）。
 * 库内资料以原文为准，文稿阶段的编排改写由提示词约束。
 */
export class TieredResearchProvider implements ResearchProvider {
  private readonly attractions: AttractionRepository;
  private readonly fallback: ResearchProvider;
  private readonly minIntroChars: number;

  constructor(attractions: AttractionRepository, fallback: ResearchProvider, minIntroChars?: number) {
    this.attractions = attractions;
    this.fallback = fallback;
    const configured = minIntroChars ?? Number(process.env.ATTRACTION_DB_MIN_INTRO ?? 400);
    this.minIntroChars = Number.isFinite(configured) && configured > 0 ? configured : 400;
  }

  async collect(topic: string, city?: string): Promise<ResearchMaterial> {
    const hit = this.attractions.findByCityAndName(city ?? '', topic);
    if (hit && hit.introLen >= this.minIntroChars) {
      console.log(`[生成] 资料命中景点库：${hit.city}·${hit.nameCn}`);
      return toMaterial(topic, hit);
    }
    return this.fallback.collect(topic, city);
  }
}

/** 词条各字段拼成资料正文：介绍在前，实用信息按存在与否追加 */
function toMaterial(topic: string, hit: AttractionContent): ResearchMaterial {
  const sections: string[] = [hit.intro];
  if (hit.address) sections.push(`地址：${hit.address}`);
  if (hit.openTime) sections.push(`开放时间：${hit.openTime}`);
  if (hit.ticket) sections.push(`门票：${hit.ticket}`);
  if (hit.duration) sections.push(hit.duration);
  if (hit.season) sections.push(`建议季节：${hit.season}`);
  if (hit.tips) sections.push(`小贴士：${hit.tips}`);

  const realPhoto = hit.images.length ? originalImageUrl(hit.images[0]) : '';
  return {
    topic,
    text: sections.filter(Boolean).join('\n\n').slice(0, MAX_CHARS),
    references: hit.link ? [hit.link] : [],
    source: 'db',
    realPhoto: realPhoto || undefined
  };
}
