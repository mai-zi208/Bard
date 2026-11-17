import type { PackIndex, PublishedStore, SourceIndex, SourceStorePort } from '../ports.ts';
import type { PublishedPack, SourceEntry } from '../types.ts';
import { matchPublished, matchSource, matchVariant } from './source-matcher.ts';

/**
 * 目录服务：把发布物与生成源扫进索引，并对外提供查询与复用判定。
 * 索引是缓存，磁盘（cdn/、packs-src/）始终是事实来源。
 */
export class CatalogService {
  private readonly published: PublishedStore;
  private readonly sources: SourceStorePort;
  private readonly packIndex: PackIndex;
  private readonly sourceIndex: SourceIndex;

  constructor(
    published: PublishedStore,
    sources: SourceStorePort,
    packIndex: PackIndex,
    sourceIndex: SourceIndex
  ) {
    this.published = published;
    this.sources = sources;
    this.packIndex = packIndex;
    this.sourceIndex = sourceIndex;
  }

  /** 重扫磁盘、刷新清单并重建索引；装配完成后必须调用 */
  reindex(): { packs: number; sources: number } {
    const packs = this.published.scan();
    this.published.writeManifest(packs);
    this.packIndex.replaceAll(packs);

    const sources = this.sources.scan();
    this.sourceIndex.replaceAll(sources);

    return { packs: packs.length, sources: sources.length };
  }

  listPacks(): PublishedPack[] {
    return this.packIndex.list();
  }

  listSources(): SourceEntry[] {
    return this.sourceIndex.list();
  }

  findSource(topic: string): SourceEntry | null {
    return matchSource(this.sourceIndex.list(), topic);
  }

  /** 人物变体：按母本 id + 讲述人匹配，与母本共用同一份素材 */
  findVariant(masterId: string, persona: string): SourceEntry | null {
    return matchVariant(this.sourceIndex.list(), masterId, persona);
  }

  findPublished(topic: string): PublishedPack | null {
    return matchPublished(this.packIndex.list(), topic);
  }

  findPublishedById(id: string): PublishedPack | null {
    return this.packIndex.list().find((pack) => pack.id === id) ?? null;
  }

  /** 生成源比发布物新，或发布物缺失时，需要重新装配 */
  isSourceStale(source: SourceEntry): boolean {
    const publishedAt = this.published.packMtime(source.id);
    const sourceMtime = this.sources.contentMtime(source) || source.contentMtime;
    return publishedAt === 0 || sourceMtime > publishedAt;
  }

  /** 母本刷新后，变体源比母本旧即视为过期，下次请求按需重建 */
  isVariantStale(variant: SourceEntry, master: SourceEntry): boolean {
    if (this.isSourceStale(variant)) return true;
    const masterMtime = this.sources.contentMtime(master) || master.contentMtime;
    const variantMtime = this.sources.contentMtime(variant) || variant.contentMtime;
    return masterMtime > variantMtime;
  }
}
