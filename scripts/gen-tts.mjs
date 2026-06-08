#!/usr/bin/env node
// One-time generator for high-quality spoken clips via Google Cloud
// Text-to-Speech. Writes public/tts/<key>.mp3 plus a manifest.json that the
// client reads to know which clips exist. After running this once, playback is
// just static files — no API key on the server, no per-game API calls, offline.
//
// Setup (once):
//   1. Create a Google Cloud project and enable the "Cloud Text-to-Speech API".
//   2. Make an API key (APIs & Services → Credentials), ideally restricted to
//      the Text-to-Speech API.
//   3. Run:  GOOGLE_TTS_API_KEY=xxxx npm run gen-tts
//
// Useful env vars:
//   GOOGLE_TTS_API_KEY  (required) your Cloud TTS API key
//   TTS_VOICE           voice name (default en-US-Neural2-D)
//   TTS_LANG            language code (default en-US)
//   TTS_MAX_QUANTITY    highest bid quantity to pre-render (default 40)
//   TTS_RATE            speaking rate 0.25–4.0 (default 1.05)
//   TTS_FORCE           set to 1 to re-render clips that already exist
//
// Quantities above TTS_MAX_QUANTITY simply fall back to the browser voice, so
// 40 comfortably covers normal games; raise it if you play with lots of dice.

import { mkdir, writeFile, access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vocabulary } from '../public/tts-keys.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'public', 'tts');

const API_KEY = process.env.GOOGLE_TTS_API_KEY;
const VOICE = process.env.TTS_VOICE || 'en-US-Neural2-D';
const LANG = process.env.TTS_LANG || 'en-US';
const MAX_QUANTITY = Number(process.env.TTS_MAX_QUANTITY || 40);
const RATE = Number(process.env.TTS_RATE || 1.05);
const FORCE = process.env.TTS_FORCE === '1';

if (!API_KEY) {
  console.error(
    'GOOGLE_TTS_API_KEY is not set.\n' +
      'Get an API key with the Cloud Text-to-Speech API enabled, then run:\n' +
      '  GOOGLE_TTS_API_KEY=xxxx npm run gen-tts'
  );
  process.exit(1);
}

const exists = (p) =>
  access(p).then(
    () => true,
    () => false
  );

async function synthesize(text) {
  const res = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: LANG, name: VOICE },
        audioConfig: { audioEncoding: 'MP3', speakingRate: RATE },
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const { audioContent } = await res.json();
  if (!audioContent) throw new Error('no audioContent in response');
  return Buffer.from(audioContent, 'base64');
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const items = vocabulary(MAX_QUANTITY);
  console.log(
    `Generating ${items.length} clips with ${VOICE} (${LANG}) into public/tts/ …`
  );

  let made = 0;
  let skipped = 0;
  for (let i = 0; i < items.length; i++) {
    const { key, text } = items[i];
    const file = path.join(OUT_DIR, `${key}.mp3`);
    if (!FORCE && (await exists(file))) {
      skipped++;
      continue;
    }
    try {
      const audio = await synthesize(text);
      await writeFile(file, audio);
      made++;
      if (made % 25 === 0) console.log(`  …${made} generated`);
      await new Promise((r) => setTimeout(r, 40)); // be gentle on the API
    } catch (err) {
      console.error(`  ✗ ${key} ("${text}"): ${err.message}`);
      process.exitCode = 1;
    }
  }

  // The manifest lists every clip actually present on disk, so the client only
  // tries clips that exist (and otherwise uses the built-in browser voice).
  const present = (await readdir(OUT_DIR))
    .filter((f) => f.endsWith('.mp3'))
    .map((f) => f.replace(/\.mp3$/, ''));
  await writeFile(
    path.join(OUT_DIR, 'manifest.json'),
    JSON.stringify({ voice: VOICE, lang: LANG, keys: present }, null, 0)
  );

  console.log(
    `Done. ${made} generated, ${skipped} already present, ${present.length} total clips.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
