import test from 'node:test';
import assert from 'node:assert/strict';
import { pcmToWav } from '../scripts/gen-tts.mjs';

test('pcmToWav writes a valid 44-byte PCM WAV header', () => {
  const pcm = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]); // 8 bytes of fake PCM
  const wav = pcmToWav(pcm, 24000);

  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length);
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wav.readUInt16LE(20), 1); // PCM
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readUInt32LE(24), 24000); // sample rate
  assert.equal(wav.readUInt32LE(28), 24000 * 2); // byte rate (mono, 16-bit)
  assert.equal(wav.readUInt16LE(32), 2); // block align
  assert.equal(wav.readUInt16LE(34), 16); // bits per sample
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm); // payload preserved
});

test('pcmToWav honors a different sample rate', () => {
  const wav = pcmToWav(Buffer.alloc(4), 16000);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(28), 16000 * 2);
});
