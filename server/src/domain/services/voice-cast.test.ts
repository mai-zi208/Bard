import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePersonaSpeaker } from './voice-cast.ts';

test('已收录人物按身份匹配音色', () => {
  assert.equal(resolvePersonaSpeaker('武则天'), 'zh_female_nvleishen_uranus_bigtts');
  assert.equal(resolvePersonaSpeaker('李清照'), 'zh_female_cancan_uranus_bigtts');
  assert.equal(resolvePersonaSpeaker('杨贵妃'), 'zh_female_sophie_uranus_bigtts');
  assert.equal(resolvePersonaSpeaker('李白'), 'zh_male_m191_uranus_bigtts');
  assert.equal(resolvePersonaSpeaker('关羽'), 'zh_male_taocheng_uranus_bigtts');
});

test('未收录人物按称谓推断性别', () => {
  assert.equal(resolvePersonaSpeaker('孝庄太后'), 'zh_female_nvleishen_uranus_bigtts');
  assert.equal(resolvePersonaSpeaker('霍将军'), 'zh_male_m191_uranus_bigtts');
});

test('没有人物或认不出性别时回退默认音色', () => {
  assert.equal(resolvePersonaSpeaker(''), undefined);
  assert.equal(resolvePersonaSpeaker('   '), undefined);
  assert.equal(resolvePersonaSpeaker('张伟'), undefined);
});
