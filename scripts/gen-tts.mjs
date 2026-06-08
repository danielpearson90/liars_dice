#!/usr/bin/env node
// One-time generator for high-quality spoken clips. Writes public/tts/<key>.<ext>
// plus a manifest.json the client reads to know which clips (and what format)
// exist. After running once, playback is just static files — no API key on the
// server, no per-game API calls, offline.
//
// Two providers (set TTS_PROVIDER):
//
//   cloud  (default) — Google Cloud Text-to-Speech, outputs MP3.
//     Setup: enable "Cloud Text-to-Speech API", make an API key, then:
//       GOOGLE_TTS_API_KEY=xxxx npm run gen-tts
//     Env: TTS_VOICE (en-US-Neural2-D), TTS_LANG (en-US), TTS_RATE (1.05)
//
//   gemini — Gemini TTS preview, expressive + prompt-steerable, outputs WAV.
//     Setup: get a Gemini API key (AI Studio), then:
//       TTS_PROVIDER=gemini GEMINI_API_KEY=xxxx npm run gen-tts
//     Env: GEMINI_TTS_MODEL (gemini-3.1-flash-tts-preview), GEMINI_VOICE
//          (Algenib), GEMINI_STYLE (a style directive prepended to each phrase)
//
// Shared env: TTS_MAX_QUANTITY (40), TTS_FORCE (1 to re-render), TTS_DELAY (ms).
// Quantities above TTS_MAX_QUANTITY fall back to the browser voice.

import { mkdir, writeFile, access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vocabulary } from '../public/tts-keys.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'public', 'tts');

const PROVIDER = process.env.TTS_PROVIDER || 'cloud';
const MAX_QUANTITY = Number(process.env.TTS_MAX_QUANTITY || 40);
const FORCE = process.env.TTS_FORCE === '1';
const EXT = PROVIDER === 'gemini' ? 'wav' : 'mp3';
const DELAY = Number(process.env.TTS_DELAY || (PROVIDER === 'gemini' ? 150 : 40));

// --- Cloud TTS (MP3) -------------------------------------------------------
const CLOUD_KEY = process.env.GOOGLE_TTS_API_KEY;
const CLOUD_VOICE = process.env.TTS_VOICE || 'en-US-Neural2-D';
const CLOUD_LANG = process.env.TTS_LANG || 'en-US';
const CLOUD_RATE = Number(process.env.TTS_RATE || 1.05);

async function synthCloud(text) {
  const res = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${CLOUD_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: CLOUD_LANG, name: CLOUD_VOICE },
        audioConfig: { audioEncoding: 'MP3', speakingRate: CLOUD_RATE },
      }),
    }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const { audioContent } = await res.json();
  if (!audioContent) throw new Error('no audioContent in response');
  return Buffer.from(audioContent, 'base64');
}

// --- Gemini TTS (PCM -> WAV) ----------------------------------------------
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-tts-preview';
const GEMINI_VOICE = process.env.GEMINI_VOICE || 'Algenib';
const GEMINI_STYLE =
  process.env.GEMINI_STYLE ||
  'Say in a deep, boomy, gravelly fighting-game announcer voice — punchy, ' +
    'hyped and promotional, at a natural pace with a neutral accent';

/** Wrap raw little-endian 16-bit mono PCM in a minimal WAV container. */
export function pcmToWav(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const buf = Buffer.alloc(44 + pcm.length);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + pcm.length, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(pcm.length, 40);
  pcm.copy(buf, 44);
  return buf;
}

async function synthGemini(text) {
  const prompt = `${GEMINI_STYLE}: ${text}`;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_VOICE } },
          },
        },
      }),
    }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const part = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part) throw new Error('no audio in response: ' + JSON.stringify(data).slice(0, 200));
  const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType || '')?.[1]) || 24000;
  return pcmToWav(Buffer.from(part.inlineData.data, 'base64'), rate);
}

const synthesize = PROVIDER === 'gemini' ? synthGemini : synthCloud;

const exists = (p) => access(p).then(() => true, () => false);

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const items = vocabulary(MAX_QUANTITY);
  const voiceLabel = PROVIDER === 'gemini' ? `${GEMINI_MODEL}/${GEMINI_VOICE}` : CLOUD_VOICE;
  console.log(`Generating ${items.length} ${EXT} clips via ${PROVIDER} (${voiceLabel}) …`);

  let made = 0;
  let skipped = 0;
  for (const { key, text } of items) {
    const file = path.join(OUT_DIR, `${key}.${EXT}`);
    if (!FORCE && (await exists(file))) {
      skipped++;
      continue;
    }
    try {
      await writeFile(file, await synthesize(text));
      made++;
      if (made % 25 === 0) console.log(`  …${made} generated`);
      await new Promise((r) => setTimeout(r, DELAY));
    } catch (err) {
      console.error(`  ✗ ${key} ("${text}"): ${err.message}`);
      process.exitCode = 1;
    }
  }

  // Manifest lists only clips of the active format that exist on disk.
  const present = (await readdir(OUT_DIR))
    .filter((f) => f.endsWith(`.${EXT}`))
    .map((f) => f.replace(new RegExp(`\\.${EXT}$`), ''));
  await writeFile(
    path.join(OUT_DIR, 'manifest.json'),
    JSON.stringify({ provider: PROVIDER, voice: voiceLabel, ext: EXT, keys: present }, null, 0)
  );

  console.log(`Done. ${made} generated, ${skipped} already present, ${present.length} total.`);
}

// Only run when invoked directly, so helpers (pcmToWav) stay importable/testable.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const key = PROVIDER === 'gemini' ? GEMINI_KEY : CLOUD_KEY;
  const keyVar = PROVIDER === 'gemini' ? 'GEMINI_API_KEY' : 'GOOGLE_TTS_API_KEY';
  if (!key) {
    console.error(
      `${keyVar} is not set for TTS_PROVIDER=${PROVIDER}.\n` +
        (PROVIDER === 'gemini'
          ? '  TTS_PROVIDER=gemini GEMINI_API_KEY=xxxx npm run gen-tts'
          : '  GOOGLE_TTS_API_KEY=xxxx npm run gen-tts')
    );
    process.exit(1);
  }
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
