import fs from 'node:fs';
import path from 'node:path';
import type {
  ImageAsset,
  MasterImage,
  MasterSource,
  PackSourceInput,
  PackSourceWriterPort,
  RefreshWorkspace
} from '../../domain/ports.ts';

const THEME = { bg: '#16130F', text: '#F2EBDD', accent: '#C9A227' };

/**
 * 生成源写入：packs-src/{id}/ 是装配脚本的输入，也是后续复用的依据。
 * 只写静态文件，不涉及数据库与发布目录。
 */
export class PackSourceWriter implements PackSourceWriterPort {
  private readonly srcDir: string;
  private readonly assetsDir: string;

  constructor(srcDir: string, assetsDir: string) {
    this.srcDir = srcDir;
    this.assetsDir = assetsDir;
  }

  createDir(packId: string): { id: string; dir: string } {
    fs.mkdirSync(this.srcDir, { recursive: true });

    let id = packId;
    let suffix = 2;
    while (fs.existsSync(path.join(this.srcDir, id))) {
      id = packId + '-' + suffix;
      suffix += 1;
    }

    const dir = path.join(this.srcDir, id);
    fs.mkdirSync(dir, { recursive: true });
    return { id, dir };
  }

  /** 已有 content.json 才算有效生成源，半成品目录按新建处理 */
  hasSource(packId: string): boolean {
    return fs.existsSync(path.join(this.srcDir, packId, 'content.json'));
  }

  /**
   * 刷新既有源：旧目录先挪到 .refresh-backup，再在原名下重建。
   * 发布成功 commit 删除备份；任一步失败 rollback 恢复旧源，旧发布包不受影响。
   */
  beginRefresh(packId: string): RefreshWorkspace {
    const dir = path.join(this.srcDir, packId);
    const backupRoot = path.join(this.srcDir, '.refresh-backup');
    this.restoreIfMissing(packId, dir, backupRoot);

    if (!fs.existsSync(dir)) {
      throw new Error('刷新失败：生成源不存在 ' + packId);
    }

    fs.mkdirSync(backupRoot, { recursive: true });
    const backup = path.join(backupRoot, packId + '__' + Date.now());
    fs.renameSync(dir, backup);
    fs.mkdirSync(dir, { recursive: true });

    let settled = false;
    return {
      id: packId,
      dir,
      commit: () => {
        if (settled) return;
        settled = true;
        fs.rmSync(backup, { recursive: true, force: true });
      },
      rollback: () => {
        if (settled) return;
        settled = true;
        fs.rmSync(dir, { recursive: true, force: true });
        fs.renameSync(backup, dir);
      }
    };
  }

  /** 上次刷新在换目录阶段中断时，用备份恢复，避免源目录永久丢失 */
  private restoreIfMissing(packId: string, dir: string, backupRoot: string): void {
    if (fs.existsSync(dir) || !fs.existsSync(backupRoot)) return;

    const prefix = packId + '__';
    const backups = fs
      .readdirSync(backupRoot)
      .filter((name) => name.startsWith(prefix))
      .sort();

    const latest = backups[backups.length - 1];
    if (latest) {
      fs.renameSync(path.join(backupRoot, latest), dir);
    }
  }

  imageFile(dir: string, name: string, ext: string): string {
    return path.join(dir, `${name}.${ext}`);
  }

  /** 读取母本生成源；变体不能再当母本，缺失或损坏时返回 null */
  readMaster(packId: string): MasterSource | null {
    const dir = path.join(this.srcDir, packId);
    const contentPath = path.join(dir, 'content.json');
    if (!fs.existsSync(contentPath)) return null;

    let content: Record<string, unknown>;
    try {
      content = JSON.parse(fs.readFileSync(contentPath, 'utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (!content || typeof content !== 'object' || content.masterId) return null;

    const rawScenes = Array.isArray(content.scenes) ? content.scenes : [];
    if (!rawScenes.length) return null;

    const images = readImages(dir);
    const scenes = rawScenes.map((item) => {
      const scene = (item || {}) as Record<string, unknown>;
      const paragraphs = Array.isArray(scene.paragraphs) ? scene.paragraphs : [];
      const body =
        String(scene.body || '').trim() ||
        paragraphs.map((part) => String(part || '').trim()).filter(Boolean).join('\n\n');
      return {
        id: String(scene.id || ''),
        title: String(scene.title || ''),
        subtitle: String(scene.subtitle || ''),
        imageAlt: String(scene.imageAlt || ''),
        pose: String(scene.pose || ''),
        body,
        narration: String(scene.narration || '')
      };
    });

    const tags = Array.isArray(content.tags) ? content.tags.map(String) : [];

    return {
      id: String(content.id || packId),
      dir,
      version: Number(content.version) || 1,
      title: String(content.title || ''),
      subtitle: String(content.subtitle || ''),
      summary: String(content.summary || ''),
      tags,
      scenes,
      images: scenes
        .map((scene) => images.sceneFiles.get(scene.id))
        .filter((image): image is MasterImage => Boolean(image)),
      cover: images.cover
    };
  }

  write(input: PackSourceInput): void {
    const { dir, outline, narrator } = input;
    const scripts = new Map(input.scripts.scenes.map((scene) => [scene.id, scene]));

    const content: Record<string, unknown> = {
      id: outline.id,
      version: input.version,
      defaultLocale: 'zh-CN',
      title: outline.title,
      subtitle: outline.subtitle,
      summary: outline.summary,
      author: '行迹',
      generated: true,
      tags: outline.tags,
      theme: THEME,
      scenes: outline.scenes.map((scene) => {
        const script = scripts.get(scene.id);
        if (!script) throw new Error(`缺少「${scene.title}」的文稿`);

        const item: Record<string, unknown> = {
          id: scene.id,
          title: scene.title,
          subtitle: scene.subtitle,
          imageAlt: scene.imageAlt,
          // 人物动作：仅供文稿复用，装配时不写进 pack.json
          pose: scene.pose,
          // 整幕正文：装配脚本把内联 Markdown 落成 body/{序号}-{id}.md，包随之升为 schemaVersion 2
          body: script.body,
          transition: script.transition,
          holdMs: script.holdMs
        };
        // 音频元数据：MP3 发布在 cdn/audio/{packId}/ 下，不进包目录
        const audioMeta = input.sceneAudio?.get(scene.id);
        if (audioMeta) item.audio = audioMeta;
        return item;
      })
    };

    if (narrator) {
      const item: Record<string, unknown> = {
        id: narrator.id,
        name: narrator.name,
        title: narrator.title
      };
      // 整包共用一张人物插画：全局立绘通道，客户端 aspectFit 完整显示并四边羽化
      if (input.portrait) {
        item.portraits = { default: 'narrator/' + narrator.id + '-default.jpg' };
        item.portraitFit = true;
        item.portraitMask = true;
      }
      content.narrator = item;
    }
    // 变体标记：源目录与清单据此区分母本与人物变体
    if (input.masterId) {
      content.masterId = input.masterId;
      if (narrator) content.persona = narrator.name;
    }

    // 变体不重新下载分镜：把母本图片硬链接进变体目录，不重复占空间
    if (input.linkImages) {
      input.images.forEach((image) => linkOrCopy(image.file, path.join(dir, path.basename(image.file))));
      linkOrCopy(input.cover.file, path.join(dir, path.basename(input.cover.file)));
    }

    fs.writeFileSync(
      path.join(dir, 'content.json'),
      JSON.stringify(content, null, 2) + '\n',
      'utf8'
    );

    fs.writeFileSync(path.join(dir, 'images.json'), buildImagesJson(input), 'utf8');
    fs.writeFileSync(path.join(dir, 'sources.md'), buildSources(input), 'utf8');

    // 插画原图按来源扩展名落到生成源，转换脚本按 narrator-default 反查
    if (input.portrait) {
      if (!fs.existsSync(input.portrait.file)) {
        throw new Error('缺少人物插画：' + input.portrait.file);
      }
      const ext = path.extname(input.portrait.file) || '.jpg';
      const target = path.join(dir, 'narrator-default' + ext);
      if (path.resolve(target) !== path.resolve(input.portrait.file)) {
        fs.copyFileSync(input.portrait.file, target);
      }
    }
  }
}

/** 硬链接复用母本图片；跨卷等无法链接时退回复制，保证变体目录自包含 */
function linkOrCopy(src: string, dest: string): void {
  if (path.resolve(src) === path.resolve(dest)) return;
  try {
    fs.linkSync(src, dest);
  } catch {
    fs.copyFileSync(src, dest);
  }
}

interface ImageIndex {
  cover: MasterImage | null;
  sceneFiles: Map<string, MasterImage>;
}

/** 读取母本 images.json；缺失时按 scene-{id}.* 与 cover.* 兜底扫描 */
function readImages(dir: string): ImageIndex {
  const sceneFiles = new Map<string, MasterImage>();
  let cover: MasterImage | null = null;
  const indexPath = path.join(dir, 'images.json');

  if (fs.existsSync(indexPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
        cover?: { file?: string; width?: number; height?: number };
        scenes?: { file?: string; width?: number; height?: number }[];
      };
      if (raw.cover?.file) {
        cover = {
          sceneId: 'cover',
          file: path.join(dir, path.basename(raw.cover.file)),
          width: Number(raw.cover.width) || 0,
          height: Number(raw.cover.height) || 0
        };
      }
      (raw.scenes || []).forEach((item) => {
        const name = path.basename(String(item.file || ''));
        const sceneId = name.replace(/^scene-/, '').replace(/\.[^.]+$/, '');
        if (!sceneId) return;
        sceneFiles.set(sceneId, {
          sceneId,
          file: path.join(dir, name),
          width: Number(item.width) || 0,
          height: Number(item.height) || 0
        });
      });
    } catch {
      // 索引损坏时继续走目录扫描
    }
  }

  const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  names.forEach((name) => {
    if (!/^scene-[^.]+\.(jpg|jpeg|png|webp)$/i.test(name)) return;
    const sceneId = name.replace(/^scene-/, '').replace(/\.[^.]+$/, '');
    if (sceneFiles.has(sceneId)) return;
    sceneFiles.set(sceneId, { sceneId, file: path.join(dir, name), width: 0, height: 0 });
  });

  if (!cover || !fs.existsSync(cover.file)) {
    const name = names.find((item) => /^cover\.(jpg|jpeg|png|webp)$/i.test(item));
    cover = name
      ? { sceneId: 'cover', file: path.join(dir, name), width: 0, height: 0 }
      : null;
  }

  return { cover, sceneFiles };
}

function relative(file: string): string {
  return path.basename(file);
}

function describeImage(asset: ImageAsset): Record<string, unknown> {
  const item: Record<string, unknown> = {
    file: relative(asset.file),
    provider: asset.provider,
    sourceUrl: asset.sourceUrl,
    width: asset.width,
    height: asset.height
  };
  // 记录检索词与来源页标题：配图配错时能直接看出是哪一步跑偏
  if (asset.query) item.query = asset.query;
  if (asset.sourceTitle) item.sourceTitle = asset.sourceTitle;
  return item;
}

function buildImagesJson(input: PackSourceInput): string {
  return (
    JSON.stringify(
      {
        cover: describeImage(input.cover),
        scenes: input.images.map(describeImage)
      },
      null,
      2
    ) + '\n'
  );
}

function buildSources(input: PackSourceInput): string {
  const lines: string[] = [`# ${input.outline.title} 资料与出处`, '', '## 检索资料', ''];

  input.references.forEach((reference) => {
    lines.push(`- ${reference}`);
  });

  input.images.forEach((image) => {
    const label = input.outline.scenes.find((scene) => scene.id === image.sceneId)?.title ?? image.sceneId;
    const source =
      image.provider === 'linked'
        ? `母本复用：${relative(image.file)}`
        : `生成图（示意图）：${image.sourceUrl}`;
    lines.push(`- 配图「${label}」${source}`);
  });

  input.scripts.scenes.forEach((script, index) => {
    const scene = input.outline.scenes[index];
    lines.push('', `## 第 ${index + 1} 幕 ${scene.title}`, '');
    if (script.sources.length) {
      script.sources.forEach((source) => lines.push(`- ${source}`));
    } else {
      lines.push('- 本幕事实依据上述检索资料。');
    }
  });

  return lines.join('\n') + '\n';
}
