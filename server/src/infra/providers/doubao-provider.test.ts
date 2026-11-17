import test from 'node:test';
import assert from 'node:assert/strict';
import { DoubaoProvider, type DoubaoConfig } from './doubao-provider.ts';

function config(overrides: Partial<DoubaoConfig> = {}): DoubaoConfig {
  return {
    url: 'https://example.test/api/v3/tts/unidirectional',
    apiKey: 'test-key',
    resourceId: 'seed-tts-2.0',
    speaker: 'zh_female_gaolengyujie_uranus_bigtts',
    sampleRate: 44100,
    speechRate: 0,
    timeoutMs: 5000,
    maxSec: 90,
    ...overrides
  };
}

/** 把整段文本切成多个小块，模拟服务端流式返回且 JSON 跨块 */
function streamOf(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const pieces = [text.slice(0, 37), text.slice(37, 91), text.slice(91)].map((piece) =>
    encoder.encode(piece)
  );
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= pieces.length) {
        controller.close();
        return;
      }
      controller.enqueue(pieces[index]);
      index += 1;
    }
  });
}

test('DoubaoProvider 未配置 Key 时 enabled 为 false', () => {
  const provider = new DoubaoProvider(config({ apiKey: '' }));
  assert.equal(provider.enabled, false);
});

test('DoubaoProvider 按流式分片拼 PCM，并按采样率算时长', async () => {
  // 2 秒 44.1kHz 16bit 单声道 PCM
  const pcm = Buffer.alloc(44100 * 2 * 2, 1);
  const first = pcm.subarray(0, pcm.length / 2).toString('base64');
  const second = pcm.subarray(pcm.length / 2).toString('base64');
  const body =
    JSON.stringify({ code: 0, message: '', data: first }) +
    JSON.stringify({ code: 0, message: '', data: second }) +
    JSON.stringify({ code: 20000000, message: 'ok', data: null });

  const provider = new DoubaoProvider(config(), {
    fetchImpl: (async () => new Response(streamOf(body), { status: 200 })) as typeof fetch,
    encodeMp3: async () => Buffer.from('fake-mp3')
  });

  const result = await provider.synthesize('这是一段测试讲解文本。');
  assert.ok(result);
  assert.equal(result.meta.durSec, 2);
  assert.equal(result.meta.bytes, 8);
  assert.equal(result.meta.sha256.length, 64);
  assert.equal(result.mp3.toString(), 'fake-mp3');
});

test('DoubaoProvider 遇到错误码返回 null 不抛错', async () => {
  const body = JSON.stringify({ code: 45000000, message: 'speaker permission denied', data: null });
  const provider = new DoubaoProvider(config(), {
    fetchImpl: (async () => new Response(streamOf(body), { status: 200 })) as typeof fetch,
    encodeMp3: async () => Buffer.from('fake-mp3')
  });

  assert.equal(await provider.synthesize('测试文本'), null);
});

test('人物音色不可用时回退默认音色重试', async () => {
  const pcm = Buffer.alloc(44100 * 2 * 2, 1);
  const okBody =
    JSON.stringify({ code: 0, message: '', data: pcm.toString('base64') }) +
    JSON.stringify({ code: 20000000, message: 'ok', data: null });
  const failBody = JSON.stringify({ code: 45000000, message: 'speaker permission denied', data: null });
  const speakers: string[] = [];

  const provider = new DoubaoProvider(config(), {
    fetchImpl: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { req_params: { speaker: string } };
      speakers.push(body.req_params.speaker);
      const failed = body.req_params.speaker === 'zh_male_m191_uranus_bigtts';
      return new Response(streamOf(failed ? failBody : okBody), { status: 200 });
    }) as typeof fetch,
    encodeMp3: async () => Buffer.from('fake-mp3')
  });

  const result = await provider.synthesize('测试文本', { speaker: 'zh_male_m191_uranus_bigtts' });
  assert.ok(result);
  assert.deepEqual(speakers, ['zh_male_m191_uranus_bigtts', 'zh_female_gaolengyujie_uranus_bigtts']);
});
