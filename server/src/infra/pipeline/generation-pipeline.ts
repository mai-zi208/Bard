import fs from 'node:fs';
import path from 'node:path';
import type {
  AssemblerPort,
  AudioTopUpResult,
  GeneratedPack,
  GenerationHooks,
  GenerationInput,
  GenerationPipeline,
  ImageAsset,
  ImageProvider,
  PackCleanupPort,
  PackOutline,
  PackSourceWriterPort,
  RefreshWorkspace,
  ResearchProvider,
  ScriptResult,
  SceneAudioMeta,
  ScriptWriter,
  VoiceSynthPort
} from '../../domain/ports.ts';
import type { SourceEntry } from '../../domain/types.ts';
import { variantId } from '../../domain/services/persona.ts';
import { resolvePersonaSpeaker } from '../../domain/services/voice-cast.ts';
import { normalizeTopic } from '../../domain/services/source-matcher.ts';

export interface PipelineDeps {
  research: ResearchProvider;
  writer: ScriptWriter;
  images: ImageProvider;
  sources: PackSourceWriterPort;
  cleanup: PackCleanupPort;
  assembler: AssemblerPort;
  /** 生成包的幕数上限；0 表示不限制，由景物清单与校验规则（5–40）约束 */
  sceneLimit: number;
  /** 单包分镜总预算（KB），用于推导每张图的质量上限 */
  sceneBudgetKb: number;
  /** 配音合成端口；未配置时 enabled 为 false，流水线跳过配音阶段 */
  voice: VoiceSynthPort;
  /** 音频发布根目录（cdn/audio），MP3 不进包目录 */
  audioDir: string;
  /** 生成源根目录（packs-src），后台补齐配音时回读 content.json */
  sourceDir: string;
  /** 已发布包当前版本；同景点同讲述人覆盖生成时用于把版本 +1 */
  publishedVersion?: (packId: string) => number;
  /** 主任务同步生成配音的幕数，其余幕交给后台补齐；0 或缺省表示全量同步 */
  eagerAudioScenes?: number;
}

interface Narrator {
  id: string;
  name: string;
  title: string;
}

/** 已知人物的身份标注；未收录的人物不加头衔 */
const PERSONAS: Record<string, string> = {
  武则天: '大周圣神皇帝',
  杨贵妃: '唐玄宗贵妃',
  上官婉儿: '唐代女官',
  李清照: '宋代词人',
  李白: '唐代诗人',
  杜甫: '唐代诗人',
  白居易: '唐代诗人',
  苏轼: '宋代文学家',
  曹操: '魏武帝',
  关羽: '汉寿亭侯',
  玄奘: '唐代高僧',
  汉明帝: '东汉皇帝'
};

function resolveNarrator(persona: string): Narrator | null {
  const name = persona.trim();
  if (!name) return null;
  return {
    id: 'narrator',
    name,
    title: PERSONAS[name] || ''
  };
}

/** 出图并发路数：出图服务单张约 17 秒，6 路可让 5 幕 + 立绘一轮跑完 */
const IMAGE_WORKERS = 6;
/** 单幕出图失败后的重试间隔 */
const IMAGE_RETRY_MS = 2000;

function lastLine(log: string): string {
  const lines = log.trim().split(/\r?\n/).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '未知错误';
}

/** 装配失败时优先暴露具体错误行，而不是「N 个错误」的汇总行 */
function errorLine(log: string): string {
  const line = log
    .trim()
    .split(/\r?\n/)
    .find((item) => item.includes('[错误]'));
  return line ? line.replace(/^.*?\[错误\]\s*/, '').trim() : lastLine(log);
}

/** 配音取词：正文四块拼成连贯朗读段落；v1 旧文稿退回 narration */
function sceneVoiceText(script: { body?: string; narration?: string }): string {
  const raw = String(script.body || script.narration || '');
  return raw
    .split(/\n\n+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join('');
}

/**
 * 真实生成编排：检索 → 大纲 → 文稿 → 三条分支并行（逐幕出图 / 绘制立绘 / 逐幕配音）→ 装配。
 * 出图 6 路并发（单幕失败重试一次），立绘与配音同时进行，各分支产出直接写入包目录，最后统一转换、校验并原子发布。
 * 只依赖领域端口，具体实现（百度百科 / 千问 / 出图服务）由外层注入。
 */
export class ContentGenerationPipeline implements GenerationPipeline {
  private readonly deps: PipelineDeps;

  constructor(deps: PipelineDeps) {
    this.deps = deps;
  }

  /**
   * 出图分支：逐幕生成配图，多路并发；单幕失败隔 2 秒自动重试一次，仍失败即整包失败。
   * 每完成一张就落盘并推进进度，不等其它幕。
   */
  private async generateSceneImages(
    outline: PackOutline,
    dir: string,
    targets: ImageAsset[],
    step: (stage: string) => void,
    isStopped: () => boolean,
    stop: () => void
  ): Promise<void> {
    const total = outline.scenes.length;
    let next = 0;

    const worker = async (): Promise<void> => {
      while (!isStopped()) {
        const index = next;
        next += 1;
        if (index >= total) return;

        const scene = outline.scenes[index];
        try {
          targets[index] = await this.fetchSceneImage(outline, scene, dir);
          step('生成配图');
        } catch (err) {
          stop();
          throw err;
        }
      }
    };

    const results = await Promise.allSettled(
      Array.from({ length: Math.min(IMAGE_WORKERS, total) }, () => worker())
    );
    const failure = results.find((item) => item.status === 'rejected');
    if (failure && failure.status === 'rejected') throw failure.reason;
  }

  /** 单幕出图：失败后隔 2 秒重试一次，两次都失败才抛错 */
  private async fetchSceneImage(
    outline: PackOutline,
    scene: PackOutline['scenes'][number],
    dir: string
  ): Promise<ImageAsset> {
    const prompt = `${outline.title}的${scene.title}，${scene.imageAlt}`;
    const fileBase = path.join(dir, 'scene-' + scene.id);
    try {
      return await this.deps.images.fetchScene(scene.id, prompt, fileBase);
    } catch (err) {
      console.warn(
        `[生成] 第「${scene.title}」幕配图失败，2 秒后重试一次：` +
          (err instanceof Error ? err.message : String(err))
      );
      await new Promise((resolve) => setTimeout(resolve, IMAGE_RETRY_MS));
      return this.deps.images.fetchScene(scene.id, prompt, fileBase);
    }
  }

  /**
   * 配音分支：与出图并行，逐幕合成 MP3 到 cdn/audio/.tmp-{packId}/，
   * 装配成功后再换入正式目录；单幕合成失败仅该幕无音频（按钮置灰），不阻塞整包发布。
   * 主任务只跑前 limit 幕，其余幕由后台补齐任务处理，避免拖慢出包。
   */
  private async generateSceneAudio(
    outline: PackOutline,
    scripts: ScriptResult,
    packId: string,
    audio: Map<string, SceneAudioMeta>,
    step: (stage: string) => void,
    isStopped: () => boolean,
    stop: () => void,
    limit = Number.POSITIVE_INFINITY,
    speaker?: string
  ): Promise<void> {
    if (!this.deps.voice.enabled) return;

    const tmpDir = path.join(this.deps.audioDir, '.tmp-' + packId);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    const scriptById = new Map(scripts.scenes.map((item) => [item.id, item]));

    for (const scene of outline.scenes.slice(0, Math.max(0, limit))) {
      if (isStopped()) return;

      const script = scriptById.get(scene.id);
      const text = script ? sceneVoiceText(script) : '';
      if (text) {
        try {
          const result = await this.deps.voice.synthesize(text, speaker ? { speaker } : undefined);
          if (result) {
            fs.writeFileSync(path.join(tmpDir, 'scene-' + scene.id + '.mp3'), result.mp3);
            audio.set(scene.id, result.meta);
          }
        } catch (err) {
          stop();
          throw err;
        }
      }
      step('生成讲解音频');
    }

    if (!audio.size) fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  /** 立绘分支：整包只画一张；插画接口不可用时降级为无立绘发布，不拖垮其它分支 */
  private async drawPortrait(name: string, title: string, dir: string): Promise<ImageAsset | null> {
    try {
      return await this.deps.images.fetchPortrait(name, { title }, path.join(dir, 'narrator-default'));
    } catch (err) {
      console.warn('[生成] 人物插画生成失败，改用无立绘发布：' + (err instanceof Error ? err.message : String(err)));
      return null;
    }
  }

  /** 换入音频：旧版先挪开再换入新版，换入失败回退旧版；本步骤失败不阻塞发布 */
  private publishAudio(packId: string): void {
    const tmpDir = path.join(this.deps.audioDir, '.tmp-' + packId);
    if (!fs.existsSync(tmpDir)) return;

    const finalDir = path.join(this.deps.audioDir, packId);
    const backupDir = path.join(this.deps.audioDir, '.old-' + packId);
    fs.rmSync(backupDir, { recursive: true, force: true });
    const hadPrevious = fs.existsSync(finalDir);
    if (hadPrevious) fs.renameSync(finalDir, backupDir);

    try {
      fs.renameSync(tmpDir, finalDir);
      if (hadPrevious) fs.rmSync(backupDir, { recursive: true, force: true });
    } catch (err) {
      if (hadPrevious && !fs.existsSync(finalDir)) fs.renameSync(backupDir, finalDir);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      console.warn('[配音] 音频换入失败，本版本不发布音频：' + (err instanceof Error ? err.message : String(err)));
    }
  }

  /** 任务失败时清掉暂存音频，避免脏目录残留 */
  private cleanupAudioTmp(packId: string): void {
    try {
      fs.rmSync(path.join(this.deps.audioDir, '.tmp-' + packId), { recursive: true, force: true });
    } catch (err) {
      console.warn('[配音] 清理暂存音频失败：' + (err instanceof Error ? err.message : String(err)));
    }
  }

  /** 主任务同步配音的幕数：配置 0 或负数表示全量一次生成 */
  private eagerLimit(total: number): number {
    const eager = this.deps.eagerAudioScenes ?? 0;
    return eager > 0 ? Math.min(total, eager) : total;
  }

  /** 覆盖既有包时版本 +1，保证客户端按「版本不等」拉取到新内容 */
  private sourceVersion(packId: string, replacing: boolean): number {
    if (!replacing) return 1;
    return (this.deps.publishedVersion?.(packId) ?? 0) + 1;
  }

  /** 前 eager 幕之后仍有正文未配音的幕，需要后台任务补齐 */
  private hasPendingAudio(
    outline: PackOutline,
    scripts: ScriptResult,
    sceneAudio: Map<string, SceneAudioMeta>,
    eager: number
  ): boolean {
    if (!this.deps.voice.enabled || eager >= outline.scenes.length) return false;

    const scriptById = new Map(scripts.scenes.map((item) => [item.id, item]));
    return outline.scenes.slice(eager).some((scene) => {
      const script = scriptById.get(scene.id);
      return Boolean(script && sceneVoiceText(script)) && !sceneAudio.has(scene.id);
    });
  }

  async run(input: GenerationInput, hooks: GenerationHooks): Promise<GeneratedPack> {
    if (input.variant) return this.runVariant(input, hooks);

    const narrator = resolveNarrator(input.persona);
    // 讲述人决定配音音色；没有人物时用 provider 配置的默认音色
    const voiceSpeaker = narrator ? resolvePersonaSpeaker(narrator.name) : undefined;

    hooks.report(5, '检索资料');
    const material = await this.deps.research.collect(input.topic);

    hooks.report(15, '编排幕大纲');
    const outline = await this.deps.writer.outline(input, material, this.deps.sceneLimit);

    // 文稿先定稿：出图按正文给出的画面描述来画，配图、立绘、配音随后三条分支并行
    hooks.report(20, '撰写文稿');
    const scripts = await this.deps.writer.scripts(input, material, outline);
    const scriptById = new Map(scripts.scenes.map((item) => [item.id, item]));
    outline.scenes.forEach((scene) => {
      const script = scriptById.get(scene.id);
      if (script?.imageAlt) scene.imageAlt = script.imageAlt;
    });

    // 同一景点、同一讲述人只允许存在一个包：已有生成源时在原名下覆盖重建，失败回滚旧源
    const workspace = input.refresh
      ? this.deps.sources.beginRefresh(input.refresh.packId)
      : this.deps.sources.hasSource(outline.id)
        ? this.deps.sources.beginRefresh(outline.id)
        : null;
    const created = workspace
      ? { id: workspace.id, dir: workspace.dir }
      : this.deps.sources.createDir(outline.id);

    try {
      outline.id = created.id;
      const dir = created.dir;
      const total = outline.scenes.length;

      // 三条分支同时开工，谁先产出谁先进包：出图 2 路并发、逐幕配音、单独绘立绘。
      // 任一分支失败即整包失败（立绘除外，失败退化为无立绘），不再等其它分支跑完。
      const images: ImageAsset[] = new Array(total);
      const sceneAudio = new Map<string, SceneAudioMeta>();
      let portrait: ImageAsset | null = null;

      const eagerAudio = this.eagerLimit(total);
      const audioUnits = this.deps.voice.enabled ? eagerAudio : 0;
      const units = total + audioUnits + (narrator ? 1 : 0);
      let done = 0;
      const step = (stage: string): void => {
        done += 1;
        hooks.report(25 + Math.round((50 * done) / Math.max(1, units)), stage);
      };

      let stopped = false;
      const stop = (): void => {
        stopped = true;
      };
      const isStopped = (): boolean => stopped;

      const branches: Promise<void>[] = [
        this.generateSceneImages(outline, dir, images, step, isStopped, stop).catch((err) => {
          stop();
          throw err;
        }),
        this.generateSceneAudio(outline, scripts, created.id, sceneAudio, step, isStopped, stop, eagerAudio, voiceSpeaker).catch((err) => {
          stop();
          throw err;
        })
      ];

      if (narrator) {
        branches.push(
          this.drawPortrait(narrator.name, outline.title, dir).then((asset) => {
            portrait = asset;
            step('绘制人物插画');
          })
        );
      }

      const branchesDone = await Promise.allSettled(branches);
      const failure = branchesDone.find((item) => item.status === 'rejected');
      if (failure && failure.status === 'rejected') throw failure.reason;

      // 封面复用首幕原图，转换脚本会按 3:4 中心裁切
      const first = images[0];
      const coverExt = path.extname(first.file).replace(/^\./, '') || 'jpg';
      const coverFile = this.deps.sources.imageFile(dir, 'cover', coverExt);
      fs.copyFileSync(first.file, coverFile);
      const cover: ImageAsset = { sceneId: 'cover', file: coverFile, provider: first.provider, sourceUrl: first.sourceUrl, width: first.width, height: first.height };

      this.deps.sources.write({
        dir,
        version: input.refresh ? input.refresh.version : this.sourceVersion(created.id, Boolean(workspace)),
        outline,
        scripts,
        narrator,
        images,
        portrait,
        cover,
        references: material.references,
        sceneAudio
      });

      const source: SourceEntry = {
        id: outline.id,
        dir,
        title: outline.title,
        titleNorm: normalizeTopic(outline.title),
        narratorId: narrator ? narrator.id : '',
        narratorName: narrator ? narrator.name : '',
        masterId: '',
        persona: narrator ? narrator.name : '',
        contentMtime: fs.statSync(path.join(dir, 'content.json')).mtimeMs
      };

      // 插画与分镜共享整包预算：只预留一张插画的 90KB，剩余额度推导 sceneMaxKb
      const portraitReserveKb = narrator ? 90 : 0;
      const imageBudgetKb = Math.max(600, this.deps.sceneBudgetKb - portraitReserveKb);
      const sceneMaxKb = Math.max(
        120,
        Math.min(400, Math.floor(imageBudgetKb / Math.max(1, total)))
      );

      hooks.report(80, '装配资源包');
      const assembled = await this.deps.assembler.run(source, { sceneMaxKb });
      if (!assembled.ok) {
        console.error('[生成] 装配日志：\n' + assembled.log);
        throw new Error('装配失败：' + errorLine(assembled.log));
      }

      // 装配成功才把暂存音频换入发布目录，与 pack.json 的 audio 元数据保持一致
      this.publishAudio(outline.id);

      // 新包已通过校验并发布，旧源备份可以删除；后续失败不应回滚已发布内容
      workspace?.commit();

      return { packId: outline.id, title: outline.title, pendingAudio: this.hasPendingAudio(outline, scripts, sceneAudio, eagerAudio) };
    } catch (err) {
      this.cleanupAudioTmp(created.id);
      if (workspace) {
        workspace.rollback();
      } else {
        this.deps.cleanup.remove(created.id);
      }
      throw err;
    }
  }

  /**
   * 人物变体：不重新检索、不重新配景图。
   * 复用母本大纲与分镜图，只按讲述人改写正文，并按人物重绘插画。
   */
  private async runVariant(
    input: GenerationInput,
    hooks: GenerationHooks
  ): Promise<GeneratedPack> {
    const variant = input.variant;
    const narrator = resolveNarrator(input.persona);
    if (!variant) throw new Error('缺少母本信息');
    if (!narrator) throw new Error('人物变体缺少讲述人');
    const voiceSpeaker = resolvePersonaSpeaker(narrator.name);

    const master = this.deps.sources.readMaster(variant.masterId);
    if (!master) throw new Error('母本生成源不存在：' + variant.masterId);
    if (!master.images.length) throw new Error('母本缺少分镜图，无法生成人物变体');
    if (!master.cover) throw new Error('母本缺少封面图，无法生成人物变体');

    hooks.report(12, '生成人物变体');
    const scripts = await this.deps.writer.rewrite(input, master);

    const outline: PackOutline = {
      id: variantId(master.id, narrator.name),
      title: master.title,
      subtitle: master.subtitle,
      summary: master.summary,
      tags: master.tags,
      scenes: master.scenes.map((scene) => ({
        id: scene.id,
        title: scene.title,
        subtitle: scene.subtitle,
        imageAlt: scene.imageAlt,
        pose: scene.pose,
        brief: '',
        imageQuery: ''
      }))
    };

    // 同母本同讲述人也只保留一个包：已有变体源时覆盖重建
    const workspace = input.refresh
      ? this.deps.sources.beginRefresh(input.refresh.packId)
      : this.deps.sources.hasSource(outline.id)
        ? this.deps.sources.beginRefresh(outline.id)
        : null;
    const created = workspace
      ? { id: workspace.id, dir: workspace.dir }
      : this.deps.sources.createDir(outline.id);

    try {
      outline.id = created.id;
      const dir = created.dir;

      // 变体同样只同步生成前 eager 幕配音，其余幕交给后台补齐
      const sceneAudio = new Map<string, SceneAudioMeta>();
      const total = outline.scenes.length;
      const eagerAudio = this.eagerLimit(total);
      let done = 0;
      await this.generateSceneAudio(
        outline,
        scripts,
        created.id,
        sceneAudio,
        () => {
          done += 1;
          hooks.report(16 + Math.round((12 * done) / Math.max(1, eagerAudio)), '生成讲解音频');
        },
        () => false,
        () => {},
        eagerAudio,
        voiceSpeaker
      );

      hooks.report(35, '绘制人物插画');
      // 变体与母本共用分镜，只按新讲述人重绘一张立绘；失败时降级为无立绘发布
      let portrait: ImageAsset | null = null;
      try {
        portrait = await this.deps.images.fetchPortrait(
          narrator.name,
          { title: master.title },
          path.join(dir, 'narrator-default')
        );
      } catch (err) {
        console.warn('[生成] 人物插画生成失败，改用无立绘发布：' + (err instanceof Error ? err.message : String(err)));
      }

      this.deps.sources.write({
        dir,
        version: input.refresh ? input.refresh.version : this.sourceVersion(created.id, Boolean(workspace)),
        outline,
        scripts,
        narrator,
        // 分镜与封面来自母本，写文件时硬链接复用，不再下载
        images: master.images.map((image) => ({
          ...image,
          provider: 'linked' as const,
          sourceUrl: ''
        })),
        portrait,
        cover: { ...master.cover, provider: 'linked' as const, sourceUrl: '' },
        references: [],
        masterId: master.id,
        linkImages: true,
        sceneAudio
      });

      const source: SourceEntry = {
        id: outline.id,
        dir,
        title: outline.title,
        titleNorm: normalizeTopic(outline.title),
        narratorId: narrator.id,
        narratorName: narrator.name,
        masterId: master.id,
        persona: narrator.name,
        contentMtime: fs.statSync(path.join(dir, 'content.json')).mtimeMs
      };

      // 插画与分镜共享整包预算：只预留一张插画的 90KB，避免超 3MB
      const imageBudgetKb = Math.max(600, this.deps.sceneBudgetKb - 90);
      const sceneMaxKb = Math.max(
        120,
        Math.min(400, Math.floor(imageBudgetKb / Math.max(1, outline.scenes.length)))
      );

      hooks.report(80, '装配资源包');
      const assembled = await this.deps.assembler.run(source, { sceneMaxKb });
      if (!assembled.ok) {
        console.error('[生成] 装配日志：\n' + assembled.log);
        throw new Error('装配失败：' + errorLine(assembled.log));
      }

      // 装配成功才把暂存音频换入发布目录，与 pack.json 的 audio 元数据保持一致
      this.publishAudio(outline.id);

      workspace?.commit();

      return { packId: outline.id, title: outline.title, pendingAudio: this.hasPendingAudio(outline, scripts, sceneAudio, eagerAudio) };
    } catch (err) {
      this.cleanupAudioTmp(created.id);
      if (workspace) {
        workspace.rollback();
      } else {
        this.deps.cleanup.remove(created.id);
      }
      throw err;
    }
  }

  /**
   * 后台补齐配音：主任务只同步生成了前 N 幕，这里回读生成源，把剩下有正文没音频的幕补完，
   * 全部补完后一次性重新装配发布（版本 +1），客户端按新版本一次性下载完整音频。
   * 中途失败回滚 content.json 与本次新增的 MP3，已发布内容不受影响。
   */
  async topUpAudio(packId: string, hooks: GenerationHooks): Promise<AudioTopUpResult> {
    const dir = path.join(this.deps.sourceDir, packId);
    const contentPath = path.join(dir, 'content.json');
    if (!fs.existsSync(contentPath)) throw new Error('生成源不存在：' + packId);
    if (!this.deps.voice.enabled) {
      return { packId, title: '', filled: 0 };
    }

    const raw = fs.readFileSync(contentPath, 'utf8');
    const content = JSON.parse(raw) as Record<string, unknown>;
    const scenes = Array.isArray(content.scenes)
      ? (content.scenes as Record<string, unknown>[])
      : [];
    const pending = scenes.filter((scene) => {
      const text = sceneVoiceText({
        body: String(scene.body || ''),
        narration: String(scene.narration || '')
      });
      return Boolean(text) && !scene.audio;
    });
    const title = String(content.title || '');
    if (!pending.length) return { packId, title, filled: 0 };

    const narrator = (content.narrator || null) as Record<string, unknown> | null;
    const narratorName = narrator ? String(narrator.name || '') : '';
    // 后台补齐沿用同一讲述人的音色
    const voiceSpeaker = narratorName ? resolvePersonaSpeaker(narratorName) : undefined;

    hooks.report(5, '生成讲解音频');

    const tmpDir = path.join(this.deps.audioDir, '.tmp-' + packId);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    const metas = new Map<string, SceneAudioMeta>();
    try {
      for (const [index, scene] of pending.entries()) {
        const text = sceneVoiceText({
          body: String(scene.body || ''),
          narration: String(scene.narration || '')
        });
        const result = await this.deps.voice.synthesize(
          text,
          voiceSpeaker ? { speaker: voiceSpeaker } : undefined
        );
        if (result) {
          fs.writeFileSync(path.join(tmpDir, 'scene-' + String(scene.id) + '.mp3'), result.mp3);
          metas.set(String(scene.id), result.meta);
        }
        hooks.report(5 + Math.round((60 * (index + 1)) / pending.length), '生成讲解音频');
      }
    } catch (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw err;
    }

    if (!metas.size) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return { packId, title, filled: 0 };
    }

    // 逐文件并入正式音频目录：已有前几幕的 MP3 必须保留，不能整目录换入
    const finalDir = path.join(this.deps.audioDir, packId);
    fs.mkdirSync(finalDir, { recursive: true });
    const moved: string[] = [];
    for (const name of fs.readdirSync(tmpDir)) {
      fs.renameSync(path.join(tmpDir, name), path.join(finalDir, name));
      moved.push(name);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });

    // 回写音频元数据并把版本推到已发布版本 +1，装配后客户端会整体刷新
    scenes.forEach((scene) => {
      const meta = metas.get(String(scene.id));
      if (meta) scene.audio = meta;
    });
    content.version = (Number(content.version) || 1) + 1;
    fs.writeFileSync(contentPath, JSON.stringify(content, null, 2) + '\n', 'utf8');

    const source: SourceEntry = {
      id: packId,
      dir,
      title,
      titleNorm: normalizeTopic(title),
      narratorId: narrator ? String(narrator.id || '') : '',
      narratorName,
      masterId: String(content.masterId || ''),
      persona: String(content.persona || narratorName),
      contentMtime: fs.statSync(contentPath).mtimeMs
    };

    const portraitReserveKb = narrator ? 90 : 0;
    const imageBudgetKb = Math.max(600, this.deps.sceneBudgetKb - portraitReserveKb);
    const sceneMaxKb = Math.max(
      120,
      Math.min(400, Math.floor(imageBudgetKb / Math.max(1, scenes.length)))
    );

    hooks.report(70, '装配资源包');
    const assembled = await this.deps.assembler.run(source, { sceneMaxKb });
    if (!assembled.ok) {
      console.error('[配音] 补齐后装配日志：\n' + assembled.log);
      fs.writeFileSync(contentPath, raw, 'utf8');
      moved.forEach((name) => fs.rmSync(path.join(finalDir, name), { force: true }));
      throw new Error('补齐配音后装配失败：' + errorLine(assembled.log));
    }

    return { packId, title, filled: metas.size };
  }
}
