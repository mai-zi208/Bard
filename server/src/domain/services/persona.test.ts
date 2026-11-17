import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePersona, personaSlug, variantId } from './persona.ts';

test('「导游」「现代导游」与空串都归为母本', () => {
  assert.equal(normalizePersona(''), '');
  assert.equal(normalizePersona('  '), '');
  assert.equal(normalizePersona('导游'), '');
  assert.equal(normalizePersona('现代导游'), '');
  assert.equal(normalizePersona(' 武则天 '), '武则天');
});

test('已收录人物用拼音 slug，变体 id 为「母本--人物」', () => {
  assert.equal(personaSlug('武则天'), 'wuzetian');
  assert.equal(personaSlug('上官婉儿'), 'shangguanwaner');
  assert.equal(variantId('baimasi', '武则天'), 'baimasi--wuzetian');
  assert.equal(variantId('baimasi', '导游'), 'baimasi');
});

test('未收录人物用稳定短哈希，同一人物每次一致', () => {
  const first = personaSlug('杜甫');
  assert.equal(first, 'dufu');
  const unknown = personaSlug('某位人物');
  assert.match(unknown, /^p[0-9a-f]{6}$/);
  assert.equal(personaSlug('某位人物'), unknown);
  assert.notEqual(personaSlug('另一位人物'), unknown);
});
