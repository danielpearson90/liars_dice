import test from 'node:test';
import assert from 'node:assert/strict';
import { bidText, bidKey, callKey, CALLS, vocabulary } from '../public/tts-keys.js';

test('bid text uses number words, pluralizes the face, and ends punchy', () => {
  assert.equal(bidText(1, 6), 'one six!');
  assert.equal(bidText(4, 4), 'four fours!');
  assert.equal(bidText(2, 1), 'two ones!');
});

test('keys are stable and filesystem-safe', () => {
  assert.equal(bidKey(4, 4), 'bid-4-4');
  assert.equal(bidKey(1, 6), 'bid-1-6');
  assert.equal(callKey('liar'), 'call-liar');
  assert.equal(callKey('spot-on'), 'call-spot-on');
});

test('calls map to the right spoken text', () => {
  assert.equal(CALLS.liar, 'liar');
  assert.equal(CALLS['spot-on'], 'spot on');
});

test('vocabulary covers every bid up to the cap plus the two calls', () => {
  const v = vocabulary(40);
  assert.equal(v.length, 40 * 6 + 2);
  const keys = new Set(v.map((x) => x.key));
  assert.ok(keys.has('bid-1-1') && keys.has('bid-40-6'));
  assert.ok(keys.has('call-liar') && keys.has('call-spot-on'));
  // No duplicates.
  assert.equal(keys.size, v.length);
});
