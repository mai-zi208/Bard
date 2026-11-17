import test from 'node:test';
import assert from 'node:assert/strict';
import { SubmitLimiter } from './submit-limiter.ts';

test('窗口内超过上限后拒绝，窗口滑过后恢复', () => {
  const limiter = new SubmitLimiter(2, 60000);
  const t0 = 1_000_000;

  assert.equal(limiter.allow('1.1.1.1', t0), true);
  assert.equal(limiter.allow('1.1.1.1', t0 + 1000), true);
  assert.equal(limiter.allow('1.1.1.1', t0 + 2000), false);
  assert.equal(limiter.allow('1.1.1.1', t0 + 61000), true);
});

test('不同来源互不影响', () => {
  const limiter = new SubmitLimiter(1, 60000);
  const t0 = 2_000_000;

  assert.equal(limiter.allow('a', t0), true);
  assert.equal(limiter.allow('b', t0), true);
  assert.equal(limiter.allow('a', t0 + 10), false);
});

test('上限为 0 时不限制', () => {
  const limiter = new SubmitLimiter(0, 60000);
  for (let i = 0; i < 100; i += 1) {
    assert.equal(limiter.allow('c', 3_000_000 + i), true);
  }
});
