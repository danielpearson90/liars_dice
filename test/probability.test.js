import test from 'node:test';
import assert from 'node:assert/strict';
import { pAtLeast } from '../public/probability.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('edge cases', () => {
  assert.equal(pAtLeast(0, 10), 1); // "at least 0" is certain
  assert.equal(pAtLeast(-3, 10), 1);
  assert.equal(pAtLeast(11, 10), 0); // can't exceed the dice count
});

test('known probabilities (p = 1/6)', () => {
  assert.ok(close(pAtLeast(1, 1), 1 / 6)); // one die showing the face
  assert.ok(close(pAtLeast(2, 2), 1 / 36)); // both dice showing the face
  // At least one success in two dice = 1 - (5/6)^2 = 11/36.
  assert.ok(close(pAtLeast(1, 2), 11 / 36));
});

test('a full set of independent events sums to 1', () => {
  // For n dice, P(>=0) - P(>=1) ... telescopes; here check P(>=1)+P(0)=1.
  const n = 5;
  const pNone = Math.pow(5 / 6, n);
  assert.ok(close(pAtLeast(1, n) + pNone, 1));
});

test('monotonically non-increasing in k', () => {
  const n = 30;
  let prev = pAtLeast(0, n);
  for (let k = 1; k <= n + 1; k++) {
    const cur = pAtLeast(k, n);
    assert.ok(cur <= prev + 1e-12, `p(>=${k}) should be <= p(>=${k - 1})`);
    prev = cur;
  }
});

test('stable and bounded for a large dice pool', () => {
  const p = pAtLeast(40, 220); // ~ the max table size
  assert.ok(p >= 0 && p <= 1);
});
