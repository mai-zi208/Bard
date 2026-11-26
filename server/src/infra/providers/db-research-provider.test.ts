import test from 'node:test';
import assert from 'node:assert/strict';
import type { AttractionContent, ResearchMaterial, ResearchProvider } from '../../domain/ports.ts';
import type { AttractionRepository } from '../repositories/attraction-repository.ts';
import { TieredResearchProvider } from './db-research-provider.ts';

function repoStub(hit: AttractionContent | null): AttractionRepository {
  return {
    findByCityAndName: () => hit,
    count: () => (hit ? 1 : 0)
  } as unknown as AttractionRepository;
}

class FallbackProvider implements ResearchProvider {
  calls: Array<{ topic: string; city?: string }> = [];
  async collect(topic: string, city?: string): Promise<ResearchMaterial> {
    this.calls.push({ topic, city });
    return { topic, text: '在线检索资料'.repeat(300), references: ['https://baike.baidu.com/item/x'], source: 'web' };
  }
}

const richHit: AttractionContent = {
  name: '龙门石窟Longmen Grottoes',
  nameCn: '龙门石窟',
  city: '洛阳',
  address: '河南省洛阳市洛龙区龙门中街13号',
  intro: '龙门石窟位列世界文化遗产名录。'.repeat(30),
  openTime: '08:00-18:00',
  ticket: '成人票：¥90起',
  tips: '门票可作为明信片邮寄。',
  duration: '建议游览时间：3小时 - 5小时',
  season: '',
  rating: '4.7',
  images: ['https://img.qunarzz.com/a.jpg_480x360x95_29932edd.jpg'],
  link: 'http://travel.qunar.com/p-oi710400-longmenshiku',
  introLen: 540
};

test('命中且介绍充足：返回 db 来源资料与实景原图', async () => {
  const fallback = new FallbackProvider();
  const provider = new TieredResearchProvider(repoStub(richHit), fallback);
  const material = await provider.collect('龙门石窟', '洛阳');

  assert.equal(fallback.calls.length, 0);
  assert.equal(material.source, 'db');
  assert.ok(material.text.startsWith('龙门石窟位列世界文化遗产名录'));
  assert.ok(material.text.includes('门票：成人票：¥90起'));
  assert.ok(material.text.includes('开放时间：08:00-18:00'));
  assert.deepEqual(material.references, [richHit.link]);
  assert.equal(material.realPhoto, 'https://img.qunarzz.com/a.jpg');
});

test('命中但介绍短于阈值：回退在线检索', async () => {
  const fallback = new FallbackProvider();
  const provider = new TieredResearchProvider(repoStub({ ...richHit, introLen: 100 }), fallback);
  const material = await provider.collect('龙门石窟', '洛阳');
  assert.equal(material.source, 'web');
  assert.deepEqual(fallback.calls, [{ topic: '龙门石窟', city: '洛阳' }]);
});

test('未命中：透传 topic 与 city 给回退 provider', async () => {
  const fallback = new FallbackProvider();
  const provider = new TieredResearchProvider(repoStub(null), fallback);
  await provider.collect('故宫', '洛阳');
  assert.deepEqual(fallback.calls, [{ topic: '故宫', city: '洛阳' }]);
});

test('阈值可注入：minIntroChars 调高后同一条资料回退', async () => {
  const fallback = new FallbackProvider();
  const provider = new TieredResearchProvider(repoStub(richHit), fallback, 1000);
  const material = await provider.collect('龙门石窟', '洛阳');
  assert.equal(material.source, 'web');
});
