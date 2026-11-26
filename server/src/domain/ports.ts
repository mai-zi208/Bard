import type {
  AssembleResult,
  PublishedPack,
  SourceEntry,
  TaskKind,
  TaskRecord,
  TaskStatus
} from './types.ts';

export interface TaskPatch {
  status?: TaskStatus;
  stage?: string;
  progress?: number;
  packId?: string;
  error?: string;
  reused?: boolean;
}

/** 任务状态存储 */
export interface TaskStore {
  create(topic: string, persona: string, kind?: TaskKind, city?: string): TaskRecord;
  find(id: string): TaskRecord | null;
  /** 同主题 + 同讲述人 + 同类型的进行中任务；刷新任务不应被用户提交命中 */
  findActive(topic: string, persona: string, kind?: TaskKind): TaskRecord | null;
  countActive(): number;
  nextQueued(): TaskRecord | null;
  update(id: string, patch: TaskPatch): void;
  requeueInterrupted(): void;
  /** 最近的任务记录，按创建时间倒序，用于统计阶段耗时与失败分布 */
  listRecent(limit: number): TaskRecord[];
}

/** 发布物元数据索引（SQLite） */
export interface PackIndex {
  replaceAll(packs: PublishedPack[]): void;
  list(): PublishedPack[];
}

/** 生成源元数据索引（SQLite） */
export interface SourceIndex {
  replaceAll(sources: SourceEntry[]): void;
  list(): SourceEntry[];
}

/** 刷新失败冷却：冷却期内不重复触发，避免冷门包反复消耗生成额度 */
export interface RefreshCooldownStore {
  get(packId: string): number;
  set(packId: string, retryAfter: number): void;
  clear(packId: string): void;
}

/** 内置资源包：随小程序发布、不在 cdn/ 目录，提交去重时也要认 */
export interface BuiltinPackEntry {
  id: string;
  title: string;
  narratorName: string;
}

export interface BuiltinPackPort {
  list(): BuiltinPackEntry[];
}

/** 发布目录（cdn/）读写 */
export interface PublishedStore {
  scan(): PublishedPack[];
  writeManifest(packs: PublishedPack[]): void;
  packMtime(id: string): number;
}

/** 生成源目录（packs-src/）扫描 */
export interface SourceStorePort {
  scan(): SourceEntry[];
  /** 实时读取 content.json 的 mtime，不能用索引里的旧值判定是否过期 */
  contentMtime(source: SourceEntry): number;
}

/** 装配流水线（content.json → pack.json → 素材转换 → 校验） */
export interface AssemblerPort {
  run(source: SourceEntry, options?: AssembleOptions): Promise<AssembleResult>;
}

export interface AssembleOptions {
  /** 单张分镜体积上限（KB），超出则逐步降质，用于控制整包 3MB */
  sceneMaxKb?: number;
}

/* ---------- 行程规划 ---------- */

export interface PlanStop {
  name: string;
  /** GCJ-02 纬度（小程序地图 gcj02 坐标系） */
  lat: number;
  /** GCJ-02 经度 */
  lng: number;
}

export interface PlanResult {
  /** 2–4 个意图短标签：天数/城市/主题/节奏 */
  tags: string[];
  /** 愿望推断出的城市（裸名，如「洛阳」），供提交任务时检索景点库；未确定为空串 */
  city: string;
  /** 愿望里指定的讲述人（如「武则天」），未指定为空串；生成时按人物音色配音 */
  persona: string;
  /** 3–6 个按顺路顺序排列的景点 */
  stops: PlanStop[];
}

/** 一句话旅行愿望 → 标签与顺路景点坐标；失败抛错，由路由转成 5xx */
export interface RoutePlanner {
  plan(text: string): Promise<PlanResult>;
}

/* ---------- 真实生成编排 ---------- */

export interface GenerationInput {
  topic: string;
  persona: string;
  /** 行程所在城市：命中景点内容库时按「城市+景点」精确检索 */
  city?: string;
  /** 刷新既有包：原地重新生成并保留包 id，版本取 version */
  refresh?: { packId: string; version: number };
  /** 人物变体：复用母本素材与配图，只改写正文 */
  variant?: { masterId: string };
}

/** 流水线阶段回报：progress 0–100，stage 为客户端可展示的中文阶段名 */
export interface GenerationHooks {
  report(progress: number, stage: string): void;
}

export interface ResearchMaterial {
  topic: string;
  text: string;
  references: string[];
  /** 资料来源：db=景点内容库词条，web=在线检索；缺省按 web 处理 */
  source?: 'db' | 'web';
  /** 景点库收录的实景原图 URL：命中时首幕配图与封面优先使用 */
  realPhoto?: string;
}

export interface ResearchProvider {
  collect(topic: string, city?: string): Promise<ResearchMaterial>;
}

/** 景点内容库（attractions.db）单条记录 */
export interface AttractionContent {
  name: string;
  nameCn: string;
  city: string;
  address: string;
  intro: string;
  openTime: string;
  ticket: string;
  tips: string;
  duration: string;
  season: string;
  rating: string;
  images: string[];
  link: string;
  introLen: number;
}

export interface SceneOutline {
  id: string;
  title: string;
  subtitle: string;
  /** 配图画面描述；文稿写完后再由正文回写，大纲阶段的初值只作兜底 */
  imageAlt: string;
  /** 人物在这一幕做的动作，与景物相称；用于按幕插画 */
  pose: string;
  brief: string;
  /** 配图检索词；文稿写完后再由正文回写，大纲阶段的初值只作兜底 */
  imageQuery: string;
}

export interface PackOutline {
  id: string;
  title: string;
  subtitle: string;
  summary: string;
  tags: string[];
  scenes: SceneOutline[];
}

export interface SceneScript {
  id: string;
  /** 整幕正文：Markdown 段落，段间空行，装配时落成 body/*.md */
  body: string;
  /** 旧包保留的口播稿文本；新生成不再产出 */
  narration?: string;
  transition: string;
  holdMs: number;
  sources: string[];
  /** 按本幕正文产出的检索词，配图阶段优先使用 */
  imageQuery?: string;
  /** 按本幕正文产出的画面描述，用于 alt 与生成图提示词 */
  imageAlt?: string;
}

export interface ScriptResult {
  scenes: SceneScript[];
}

export interface ScriptWriter {
  outline(
    input: GenerationInput,
    material: ResearchMaterial,
    sceneLimit: number
  ): Promise<PackOutline>;
  scripts(
    input: GenerationInput,
    material: ResearchMaterial,
    outline: PackOutline
  ): Promise<ScriptResult>;
  /** 人物变体：以母本正文为事实底稿，只改口吻与讲述视角 */
  rewrite(input: GenerationInput, master: MasterSource): Promise<ScriptResult>;
}

/** 母本生成源中可复用的一幕 */
export interface MasterScene {
  id: string;
  title: string;
  subtitle: string;
  imageAlt: string;
  pose: string;
  body: string;
  /** 旧母本保留的口播稿文本，仅作正文缺失时的兜底 */
  narration?: string;
}

export interface MasterImage {
  sceneId: string;
  /** 母本目录内的绝对路径 */
  file: string;
  width: number;
  height: number;
}

/** 母本生成源（packs-src/{id}/），供人物变体复用，不再重新检索与配图 */
export interface MasterSource {
  id: string;
  dir: string;
  version: number;
  title: string;
  subtitle: string;
  summary: string;
  tags: string[];
  scenes: MasterScene[];
  images: MasterImage[];
  cover: MasterImage | null;
}

export interface ImageAsset {
  sceneId: string;
  /** 写入生成源目录的绝对路径 */
  file: string;
  provider: 'bing' | 'generated' | 'linked' | 'dataset';
  sourceUrl: string;
  width: number;
  height: number;
  /** 检索时实际使用的关键词，写入 images.json 便于复核配图是否对口 */
  query?: string;
  /** 来源页标题：相关性判断的依据，也是判断配错图的线索 */
  sourceTitle?: string;
}

export interface ImageProvider {
  /** 按本幕画面描述生成主图（竖图，9:16 中心裁切后可用） */
  fetchScene(sceneId: string, prompt: string, fileBase: string): Promise<ImageAsset>;
  /** 绘制讲述人插画：整包只此一张，人物立于景物之前 */
  fetchPortrait(
    persona: string,
    site: { title: string },
    fileBase: string
  ): Promise<ImageAsset>;
  /** 景点库实景图：下载指定 URL 并按竖图可用性校验，不合格抛错 */
  fetchSceneFromUrl?(sceneId: string, url: string, fileBase: string, referer?: string): Promise<ImageAsset>;
}

/** 单幕音频元数据：写入 content.json / pack.json 的 scene.audio，供小程序校验离线下载 */
export interface SceneAudioMeta {
  /** 时长（秒） */
  durSec: number;
  /** MP3 字节数 */
  bytes: number;
  /** MP3 的 SHA-256 */
  sha256: string;
}

/** 配音合成端口：调用在线 TTS（豆包）把一幕讲解文本合成 MP3。
 * 单幕失败返回 null，不抛错；未配置时 enabled 为 false，流水线跳过配音阶段。 */
export interface VoiceSynthPort {
  readonly enabled: boolean;
  /** options.speaker 指定本幕音色；缺省用 provider 配置的默认音色 */
  synthesize(
    text: string,
    options?: { speaker?: string }
  ): Promise<{ mp3: Buffer; meta: SceneAudioMeta } | null>;
}

export interface PackSourceInput {
  dir: string;
  version: number;
  outline: PackOutline;
  scripts: ScriptResult;
  narrator: { id: string; name: string; title: string } | null;
  images: ImageAsset[];
  /** 整包共用的人物插画；无讲述人时为 null */
  portrait: ImageAsset | null;
  cover: ImageAsset;
  references: string[];
  /** 人物变体指向的母本 id；母本为空 */
  masterId?: string;
  /** 变体不重新下载分镜，图片以硬链接复用母本 */
  linkImages?: boolean;
  /** 各幕音频元数据；MP3 文件发布在 cdn/audio/{packId}/ 下，不进包目录 */
  sceneAudio?: Map<string, SceneAudioMeta>;
}

export interface RefreshWorkspace {
  id: string;
  dir: string;
  /** 成功发布后删除旧源备份 */
  commit(): void;
  /** 失败时删除半成品并恢复旧源 */
  rollback(): void;
}

export interface PackSourceWriterPort {
  /** 创建 packs-src/{id}/ 并返回最终 id 与绝对目录；id 冲突时自动加后缀 */
  createDir(packId: string): { id: string; dir: string };
  /** 生成源是否已存在（有 content.json）：同景点同讲述人据此原地覆盖 */
  hasSource(packId: string): boolean;
  /** 刷新既有源：先备份旧目录，再在原名下重建，失败可回滚 */
  beginRefresh(packId: string): RefreshWorkspace;
  /** 生成源目录内图片的绝对路径 */
  imageFile(dir: string, name: string, ext: string): string;
  /** 写 content.json、sources.md、images.json 与讲述人立绘 */
  write(input: PackSourceInput): void;
  /** 读取母本生成源，供人物变体复用；变体或缺失时返回 null */
  readMaster(packId: string): MasterSource | null;
}

export interface PackCleanupPort {
  /** 删除生成失败留下的源目录、发布包与音频 */
  remove(packId: string): void;
}

export interface GeneratedPack {
  packId: string;
  title: string;
  /** 主任务只同步生成前 N 幕配音，其余幕待后台补齐 */
  pendingAudio?: boolean;
  /** 人物变体回退标记：人物与景点无历史关联，未产出变体，packId 为现代导游母本 */
  personaMismatch?: boolean;
}

/** 后台补齐配音的结果 */
export interface AudioTopUpResult {
  packId: string;
  title: string;
  /** 本次补齐的幕数；0 表示无需补齐 */
  filled: number;
}

export interface GenerationPipeline {
  run(input: GenerationInput, hooks: GenerationHooks): Promise<GeneratedPack>;
  /** 回读生成源，补齐剩余幕的配音并重新发布（版本 +1）；全部补完只发布一次 */
  topUpAudio?(packId: string, hooks: GenerationHooks): Promise<AudioTopUpResult>;
}
