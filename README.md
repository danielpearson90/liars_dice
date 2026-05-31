# 🎲 Liar's Dice (online)

Real-time, browser-based [Liar's Dice](https://en.wikipedia.org/wiki/Liar%27s_dice)
for **2–11 players** (you + up to 10 friends). One person creates a room, shares
the 4-letter code (or an invite link), and everyone plays from their phone or
laptop — no installs, no accounts.

## Rules in this version

- Everyone starts with **5 dice**, hidden from the others.
- On your turn you either **raise the bid** or, if a bid exists, call it.
- A **bid** is `quantity × face`, e.g. "four 3s" — a claim that *at least* that
  many of that face are showing across **all** dice on the table.
- **No wilds:** a 1 only counts as a 1.
- A raise must be strictly higher: more dice, or the same count of a higher face.
- **Liar! (challenge):** all dice are revealed and the face is counted.
  - Count ≥ the bid → the bid held, the **challenger** loses a die.
  - Count < the bid → it was a lie, the **bidder** loses a die.
- **Spot on! (exact):** you claim the count is *exactly* the bid quantity.
  - Exactly right → **every other player** loses a die.
  - Wrong → **you** lose a die.
- Lose your last die and you're out. **Last player standing wins.**

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
