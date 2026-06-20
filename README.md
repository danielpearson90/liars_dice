# 🎲 Liar's Dice (online)

Real-time, browser-based [Liar's Dice](https://en.wikipedia.org/wiki/Liar%27s_dice)
for **2–11 players** (you + up to 10 friends). One person creates a room, shares
the 4-letter code (or an invite link), and everyone plays from their phone or
laptop — no installs, no accounts.

## Rules in this version

- Everyone starts with the same number of dice (the host picks **1–20**,
  default 5), hidden from the others.
- On your turn you either **raise the bid** or, if a bid exists, call it.
- A **bid** is `quantity × face`, e.g. "four 3s" — a claim that *at least* that
  many of that face are showing across **all** dice on the table.
- **No wilds:** a 1 only counts as a 1.
- A raise must be strictly higher: more dice, or the same count of a higher face.
- **Liar! (challenge):** all dice are revealed and the face is counted.
  - Count ≥ the bid → the bid held, the **challenger** loses a die.
  - Count < the bid → it was a lie, the **bidder** loses a die.
- **Spot on! (exact):** you claim the count is *exactly* the bid quantity.
  - Wrong → **you** lose a die.
  - Exactly right → depends on the ruleset (see below).
- Lose your last die and you're out. **Last player standing wins.**
- The player who **opens** the bidding rotates one seat each round.
- After each reveal, the next round starts once **every player hits Ready**
  (with an "X / Y ready" indicator and a countdown). Bots are auto-ready, and a
  **5-second timer auto-advances** the reveal regardless, so an away player can't
  stall the table.

### Rulesets (chosen by the host)

The host picks one of these in the lobby; it's applied when the game starts:

- **Common Hand** (default) — no wilds (a 1 is only a 1); a correct Spot-on
  makes **every other player** lose a die.
- **Aces Wild** — 1s are **wild** and count as every face when dice are counted
  (a bid *on* 1s still counts only literal 1s); Spot-on as above. The popular
  video-game version.
- **Spot-on regains a die** — no wilds, but a correct Spot-on wins the **caller**
  a die back (up to the starting count) instead of others losing one.
- **Reverse (lose to win)** — a misère variant: the **first player to lose all
  their dice wins**. Whoever is *right* in a Liar call **sheds** a die (toward
  winning); a correct Spot-on **gives every other player** a die (a wrong one
  gives the caller one). Gains are capped at the starting count.

### Lobby options (set by the host)

- **Bots** — add 🤖 computer players to fill out the table (up to the 11-player
  cap), so you can play solo or with odd numbers. They take their turns
  automatically and play a reasonable bluff-and-challenge game. Each bot gets a
  hidden, random skill level, so some play sharper than others — but none are
  pushovers.
- **Starting dice per player** — anywhere from 1 to 20.
- **Show bid probabilities** — when on, the central bid placard shows the odds
  the bid is true, e.g. `23% chance · 20 dice`. It's the *global* chance (every
  die treated as unknown, and adjusted for wilds), the same for everyone.

Sound effects (dice rolls, bids, challenges, wins/losses) are synthesized in the
browser with the Web Audio API — no files to download. Toggle them with the
🔊 button in the top-right corner.

An optional voice (🗣️ button) reads bids and calls aloud — "4 fours", "liar",
"spot on". By default it uses the browser's built-in speech synthesis. Both
toggles are independent and remembered between visits.

A **room text chat** (💬 button, bottom-right) lets everyone talk in the lobby
and during the game, with an unread badge and recent history that loads when you
(re)join.

**Emoji reactions** (😀 button) — pick from a small set and a shower of that
emoji rains down from your name in the roster, on everyone's screen.

At **game over** each player gets a recap: headline awards (🎯 Sharpshooter,
🎲 Spot On King, 🛡️ Stonewall, 🤥 Caught Out) plus a full per-player stat table
(bids, Liar/Spot-on hits & misses, times caught, bids held, dice lost to others'
Spot-ons). Per match — it resets when the host sends everyone **back to the
lobby** to start another game (where ruleset, dice, and bots can be changed).

The sort button next to **Your dice** arranges your hand in ascending order (a
local display preference, remembered between visits).

#### Higher-quality voice (optional)

For consistent, natural voices on every device you can pre-generate clips — a
one-time step that needs an API key only while generating (the server then just
serves static audio files: fast, offline, no per-game API calls). The client
plays a clip when one exists and falls back to the browser voice otherwise.
Clips are git-ignored, so commit them or copy `public/tts/` to your server to
deploy them.

**Google Cloud Text-to-Speech** (MP3, stable, generous free tier):

```bash
# Enable the "Cloud Text-to-Speech API", make an API key, then:
GOOGLE_TTS_API_KEY=xxxx npm run gen-tts
# Tunable: TTS_VOICE (en-US-Neural2-D), TTS_LANG, TTS_RATE, TTS_MAX_QUANTITY
```

**Gemini TTS** (WAV, expressive + prompt-steerable) — e.g. a boomy fighting-game
announcer:

```bash
TTS_PROVIDER=gemini GEMINI_API_KEY=xxxx \
  GEMINI_TTS_MODEL=gemini-3.1-flash-tts-preview GEMINI_VOICE=Algenib \
  npm run gen-tts
# Style comes from GEMINI_STYLE (default: deep, boomy, gravelly, punchy
# announcer — hyped, natural pace, neutral accent). Override to taste.
```

**Audition first** — render just a few sample phrases (it always re-renders
them) to check the voice/style before generating everything:

```bash
TTS_PROVIDER=gemini GEMINI_API_KEY=xxxx TTS_DRY_RUN=1 npm run gen-tts
# Listen to the printed public/tts/*.wav, tweak GEMINI_VOICE / GEMINI_STYLE,
# re-run to compare, then run again without TTS_DRY_RUN for the full set.
```

The manifest records the format (`mp3`/`wav`) so the client loads the right
files automatically. See `scripts/gen-tts.mjs` for all options.

### Reconnecting

Each player gets a private token saved in their browser, so a refresh or a
dropped connection automatically **rejoins the same seat mid-game** — your dice
and turn are right where you left them. Other players see an "Away" tag on a
seat while its player is briefly disconnected. (Seats still live only in server
memory, so a server restart ends the game.)

### Themes

Pick a look from the selector in the top-left corner (remembered between
visits):

- **🍺 Tavern** (default) — a fully immersive candlelit pirate parlor: weathered
  wood planks under pooled, *flickering* candlelight, an edge vignette, drifting
  embers, a gilded engraved title, brass-plate buttons, a wax-sealed brass room
  code, bone dice with drilled pips, and gold-coin life counters. Uses period
  display/body typography (Pirata One, IM Fell English, EB Garamond).
- **🌙 Midnight** — a calm celestial night: a twinkling starfield with the odd
  shooting star, slowly drifting nebula, an edge vignette, frosted moonlit-glass
  panels, and elegant Cormorant Garamond / Jost typography.
- **🌆 Neon** — a synthwave arcade: a receding perspective grid floor, a slatted
  neon sun, CRT scanlines, glassy panels, and a flickering neon-tube title
  (Monoton) over Chakra Petch.
- **🥂 Gilded Deco** — a 1920s speakeasy: black, gold and jade with a slowly
  turning geometric sunburst, a gilded title (Poiret One), thin gold-framed
  panels, and onyx dice with gold pips.
- **🚬 Smoking Gun** — film noir: near-monochrome with venetian-blind shadows,
  shifting film grain, a single blood-red accent, and condensed Oswald over a
  Courier Prime typewriter face. Stark white dice.
- **👾 Press Start** — 8-bit arcade: an NES palette under CRT scanlines, blocky
  hard-shadowed panels, a pixel title (Press Start 2P) over VT323, and
  square-edged pixel dice.

Dice tumble in when a round is dealt, and confetti rains down for the winner.
Everything is pure CSS/canvas (no images), and motion respects
`prefers-reduced-motion`.

> The Tavern fonts load from Google Fonts in the player's browser and fall back
> to system serifs if a client is offline — the **server** never needs them. For
> a fully air-gapped LAN, self-host the three font files and swap the
> `<link>` in `index.html` for a local `@font-face` block.

## Run it locally

Requires Node.js 18+.

```bash
npm install
npm start
# open http://localhost:3000
```

Open the URL in several browser tabs to simulate multiple players, or have
people on the same Wi-Fi visit `http://<your-LAN-IP>:3000`.

Run the game-engine tests with:

```bash
npm test
```

## Play with friends remotely

The game needs a public URL. The quickest options:

> **Self-hosting on a Proxmox home server?** See **[DEPLOY.md](DEPLOY.md)** for a
> full step-by-step (LXC + systemd + Cloudflare Tunnel, no open ports).

### Deploy to Render (free)

1. Push this repo to GitHub.
2. On [render.com](https://render.com): **New → Blueprint**, select the repo.
   Render reads `render.yaml` and provisions a free web service.
   (Or **New → Web Service** with build `npm install` and start `npm start`.)
3. Share the resulting `https://<your-app>.onrender.com` URL.

> Note: Render's free tier sleeps after inactivity, so the first load after a
> while can take ~30s to wake up.

### Deploy to Railway

1. Push to GitHub, then on [railway.app](https://railway.app): **New Project →
   Deploy from GitHub repo**. It auto-detects Node and runs `npm start`.
2. Generate a public domain under the service's **Settings → Networking**.

### Or a quick tunnel (no deploy)

```bash
npm start                 # terminal 1
npx localtunnel --port 3000   # terminal 2 — gives you a shareable URL
```

(`ngrok http 3000` works too.)

## How it's built

- **`src/game.js`** — pure, deterministic game engine (fully unit-tested).
- **`src/rooms.js`** — in-memory room/lobby registry with short room codes.
- **`server.js`** — Express static host + Socket.IO realtime layer.
- **`public/`** — vanilla HTML/CSS/JS client (no build step).

Rooms live in memory, so a server restart clears all games.
