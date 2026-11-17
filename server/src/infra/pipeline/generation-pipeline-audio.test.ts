import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContentGenerationPipeline } from './generation-pipeline.ts';
import type {
  GenerationHooks,
  GenerationInput,
  ImageAsset,
  PackSourceInput,
  SceneAudioMeta
} from '../../domain/ports.ts';

function fakeDeps(root: string, options: {
  assemblerOk?: boolean;
  voiceEnabled?: boolean;
}) {
  const srcRoot = path.join(root, 'packs-src');
  const audioRoot = path.join(root, 'cdn', 'audio');
  fs.mkdirSync(srcRoot, { recursive: true });
  fs.mkdirSync(audioRoot, { recursive: true });

  const writes: PackSourceInput[] = [];
  let removed = '';

  const scenes = ['s1', 's2'].map((id) => ({
    id,
    title: '幕' + id,
    subtitle: '',
    imageAlt: '画面',
    pose: '',
    brief: '简介',
    imageQuery: '查询词'
  }));

  const pipeline = new ContentGenerationPipeline({
    research: {
      collect: async () => ({ passages: [' passage '], references: [] })
    } as never,
    writer: {
      outline: async () => ({ id: 'test-pack', title: '测试景区', subtitle: '', scenes }),
      scripts: async () => ({
        scenes: scenes.map((scene) => ({
          id: scene.id,
          body: '第一块句子。 \n\n 第二块句子。 \n\n 第三块句子。 \n\n 第四块句子。',
          transition: 'fade',
          holdMs: 6000
        }))
      }),
      rewrite: async () => ({ scenes: [] })
    } as never,
    images: {
      fetchScene: async (_id: string, _prompt: string, base: string) => {
        fs.writeFileSync(base + '.jpg', 'image-data');
        return { sceneId: _id, file: base + '.jpg', provider: 'generated', sourceUrl: '', width: 800, height: 1000 };
      },
      fetchPortrait: async () => {
        throw new Error('不应调用');
      }
    } as never,
    sources: {
      createDir: (id: string) => {
        const dir = path.join(srcRoot, id);
        fs.mkdirSync(dir, { recursive: true });
        return { id, dir };
      },
      hasSource: () => false,
      imageFile: (dir: string, name: string, ext: string) => {
        const target = dir + '/' + name + '.' + ext;
        fs.writeFileSync(target, '');
        return target;
      },
      write: (input: PackSourceInput) => {
        writes.push(input);
        fs.writeFileSync(path.join(input.dir, 'content.json'), '{}');
      },
      beginRefresh: () => {
        throw new Error('不应刷新');
      }
    } as never,
    cleanup: {
      remove: (id: string) => {
        removed = id;
      }
    } as never,
    assembler: {
      run: async () =>
        options.assemblerOk === false
          ? { ok: false, log: '[错误] 装配失败示例' }
          : { ok: true, log: 'ok' }
    } as never,
    sceneLimit: 10,
    sceneBudgetKb: 2000,
    voice: {
      enabled: options.voiceEnabled !== false,
      synthesize: async (text: string) => {
        const tag = text.includes('第一块') ? 'a' : 'b';
        const mp3 = Buffer.from('mp3-' + tag);
        return {
          mp3,
          meta: { durSec: 10, bytes: mp3.length, sha256: 'sha-' + tag } as SceneAudioMeta
        };
      }
    },
    audioDir: audioRoot,
    sourceDir: srcRoot,
    eagerAudioScenes: 2
  });

  return { pipeline, writes, srcRoot, audioRoot, removed: () => removed };
}

const input: GenerationInput = { topic: '测试景区', persona: '' };
const hooks: GenerationHooks = { report: () => {} };

test('配音成功：音频换入发布目录，write 收到各幕元数据', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-audio-'));
  const ctx = fakeDeps(root, { assemblerOk: true });

  const result = await ctx.pipeline.run(input, hooks);

  assert.equal(result.packId, 'test-pack');
  const audioDir = path.join(ctx.audioRoot, 'test-pack');
  assert.equal(fs.existsSync(path.join(audioDir, 'scene-s1.mp3')), true);
  assert.equal(fs.readFileSync(path.join(audioDir, 'scene-s1.mp3'), 'utf8'), 'mp3-a');
  assert.equal(fs.existsSync(path.join(ctx.audioRoot, '.tmp-test-pack')), false);

  const written = ctx.writes[0];
  assert.equal(written.sceneAudio?.get('s1')?.sha256, 'sha-a');
  assert.equal(written.sceneAudio?.get('s2')?.sha256, 'sha-a');

  fs.rmSync(root, { recursive: true, force: true });
});

test('装配失败：发布目录不被污染，暂存目录被清理', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-audio-fail-'));
  const ctx = fakeDeps(root, { assemblerOk: false });

  await assert.rejects(() => ctx.pipeline.run(input, hooks), /装配失败/);

  assert.equal(fs.existsSync(path.join(ctx.audioRoot, 'test-pack')), false);
  assert.equal(fs.existsSync(path.join(ctx.audioRoot, '.tmp-test-pack')), false);
  assert.equal(ctx.removed(), 'test-pack');

  fs.rmSync(root, { recursive: true, force: true });
});

test('未启用配音：不创建任何音频目录，流程正常发布', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-audio-off-'));
  const ctx = fakeDeps(root, { assemblerOk: true, voiceEnabled: false });

  const result = await ctx.pipeline.run(input, hooks);

  assert.equal(result.packId, 'test-pack');
  assert.deepEqual(ctx.writes[0].sceneAudio, new Map());
  assert.equal(fs.existsSync(path.join(ctx.audioRoot, 'test-pack')), false);

  fs.rmSync(root, { recursive: true, force: true });
});

test('后台补齐配音：只补缺音频的幕，保留已有音频并把版本 +1', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-audio-topup-'));
  const ctx = fakeDeps(root, { assemblerOk: true });

  const packDir = path.join(ctx.srcRoot, 'test-pack');
  fs.mkdirSync(packDir, { recursive: true });
  const contentPath = path.join(packDir, 'content.json');
  fs.writeFileSync(
    contentPath,
    JSON.stringify({
      id: 'test-pack',
      version: 1,
      title: '测试景区',
      scenes: [
        { id: 's1', body: '第一块句子。', audio: { durSec: 10, bytes: 5, sha256: 'sha-a' } },
        { id: 's2', body: '第二块句子。' }
      ]
    })
  );

  const finalDir = path.join(ctx.audioRoot, 'test-pack');
  fs.mkdirSync(finalDir, { recursive: true });
  fs.writeFileSync(path.join(finalDir, 'scene-s1.mp3'), 'mp3-a');

  const result = await ctx.pipeline.topUpAudio('test-pack', hooks);

  assert.equal(result.filled, 1);
  assert.equal(fs.readFileSync(path.join(finalDir, 'scene-s1.mp3'), 'utf8'), 'mp3-a');
  assert.equal(fs.readFileSync(path.join(finalDir, 'scene-s2.mp3'), 'utf8'), 'mp3-b');
  assert.equal(fs.existsSync(path.join(ctx.audioRoot, '.tmp-test-pack')), false);

  const content = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
  assert.equal(content.version, 2);
  assert.equal(content.scenes[1].audio.sha256, 'sha-b');

  // 补齐后再跑一次：没有缺音频的幕，直接返回 0，不重复发布
  const again = await ctx.pipeline.topUpAudio('test-pack', hooks);
  assert.equal(again.filled, 0);

  fs.rmSync(root, { recursive: true, force: true });
});
