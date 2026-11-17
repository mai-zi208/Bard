export type TaskStatus = 'queued' | 'running' | 'validating' | 'done' | 'failed';
export type TaskKind = 'generate' | 'refresh' | 'audio';

/** 已发布资源包的元数据，字段与 cdn/manifest.json 的 packs 项对齐 */
export interface PublishedPack {
  id: string;
  version: number;
  /** 客户端本地版本低于该值时必须更新才能进入；0 或缺省表示不限 */
  minVersion?: number;
  /** 软下架：本地已下载可继续离线使用，不再推荐新用户下载 */
  deprecated?: boolean;
  title: string;
  subtitle: string;
  summary: string;
  tags: string[];
  total: number;
  narratorName: string;
  cover: string;
  bytes: number;
  /** 有讲解音频的幕数；客户端据此判断已下载包是否缺少音频元数据 */
  audioCount: number;
  files: string[];
  publishedAt: number;
  /** 最近一次生成/刷新的时间，用于判断 180 天保鲜期 */
  refreshedAt: number;
  /** 包级保鲜期覆盖值；0 表示使用全局 PACK_TTL_DAYS */
  ttlDays: number;
  /** 人物变体指向的母本 id；母本为空 */
  masterId: string;
  /** 人物变体的讲述人；母本为空 */
  persona: string;
  /** 由生成流水线产出的资源包，客户端展示「AI 生成」标识 */
  aiGenerated: boolean;
}

/** 生成源（packs-src/{id}/content.json）的元数据 */
export interface SourceEntry {
  id: string;
  dir: string;
  title: string;
  titleNorm: string;
  narratorId: string;
  narratorName: string;
  /** 人物变体指向的母本 id；母本为空 */
  masterId: string;
  /** 人物变体的讲述人；母本为空 */
  persona: string;
  contentMtime: number;
}

/** 阶段打点：任务进入某个 stage 的时间，用于计算各阶段耗时 */
export interface StageMark {
  stage: string;
  at: number;
}

export interface TaskRecord {
  id: string;
  topic: string;
  persona: string;
  kind: TaskKind;
  status: TaskStatus;
  stage: string;
  progress: number;
  packId: string;
  error: string;
  reused: boolean;
  stageLog: StageMark[];
  createdAt: number;
  updatedAt: number;
}

/** 返回给客户端的任务视图，字段与 13.6 接口草案一致 */
export interface TaskView {
  status: TaskStatus;
  stage: string;
  progress: number;
  packId: string;
  error: string;
}

export interface AssembleResult {
  ok: boolean;
  log: string;
}
