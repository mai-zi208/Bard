import test from 'node:test';
import assert from 'node:assert/strict';
import { guardPersona, guardTopic } from './topic-guard.ts';

test('合法景物名通过', () => {
  ['白马寺', '洛阳龙门石窟', 'Luoyang Longmen', '老君山·金顶', '关林-1'].forEach((topic) => {
    assert.equal(guardTopic(topic).ok, true, topic);
  });
});

test('少于 2 个字或超过 30 个字被拒绝', () => {
  assert.equal(guardTopic('寺').ok, false);
  assert.equal(guardTopic('一'.repeat(31)).ok, false);
  assert.equal(guardTopic('一'.repeat(30)).ok, true);
});

test('非法字符被拒绝', () => {
  const result = guardTopic('白马寺<script>');
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /只能包含/);
});

test('敏感词被拒绝', () => {
  const result = guardTopic('洛阳赌博场所');
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /不适宜/);
});

test('人物身份可留空，或为 2–8 个合法字符', () => {
  assert.equal(guardPersona('').ok, true);
  assert.equal(guardPersona('武则天').ok, true);
  assert.equal(guardPersona('唐·玄奘').ok, true);
  assert.equal(guardPersona('一'.repeat(8)).ok, true);

  assert.equal(guardPersona('武').ok, false);
  assert.equal(guardPersona('一'.repeat(9)).ok, false);
  assert.equal(guardPersona('武则天<script>').ok, false);
  assert.equal(guardPersona('武则天赌博').ok, false);
});
