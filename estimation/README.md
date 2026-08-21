# 🃏 Estimation (online, speed rounds)

Real-time, browser-based **Estimation** (a.k.a. "Esdaudeh"), the Middle-Eastern
trick-taking card game — restricted to *speed* rounds: no trump auction, trump
follows a fixed rotation, and everyone just estimates. For **2–5 players**. One
person creates a room, shares the 4-letter code (or an invite link), and
everyone plays from their phone or laptop — no installs, no accounts.

## Rules in this version

Canonical Estimation is a 4-player, 13-trick game whose full form adds a trump
auction, dash calls and risk bonuses. This speed variant keeps the individual
scoring, supports 2–5 players, and makes some simplifying calls, spelled out
here:

- **Players:** 2–5 (minimum 2 to start; room cap 5). No bots — everyone at the
  table is a human. Scoring is **individual**, not partnered.
- **Deck & hand size:** hands **grow every round**. Round 1 deals **5 cards**
  each, round 2 deals 6, and so on — so early rounds are quick and tight, and
  later ones are long enough to plan. Growth stops once the deck can't go
  round again: **13 cards** at 2–4 players, **10** at 5. (With 3 cycles the
  last rounds therefore sit at that maximum rather than growing past it.)
  Whatever isn't dealt sits face-down, **out of play** for that round — the UI
  shows "N cards out", which shrinks as the hands grow.
- **Tricks per round** equal that round's hand size.
- **Trump** follows a fixed cycle and is never auctioned: **No-trump, ♠, ♥,
  ♦, ♣**, repeating. The host picks **1, 2, or 3 cycles** = **5, 10, or 15
  rounds** (default **2 cycles / 10 rounds**).
- **Dealer** rotates one seat every round, starting with seat 1 in round 1.
- **Estimating:** starting with the seat to the dealer's left and going
  around, everyone names how many tricks they expect to take (0..hand size).
  The **dealer estimates last** and is the "risk" seat: the total of every
  estimate may **not** equal the hand size, so exactly one number is
  forbidden for the dealer (shown struck through — sometimes no number is
  forbidden, if the running total is already past the hand size).
- **Playing:** the player to the dealer's left leads the first trick. You
  must follow the led suit if you hold it; otherwise play anything (trump can
  be led at any time — there's no "trump must be broken" rule). Highest trump
  wins the trick; if no trump was played (or it's a No-trump round), the
  highest card of the led suit wins. The winner leads the next trick. Aces
  are high, 2s are low.
- **Scoring**, per player, per round: **1 point per trick won**, plus a
  **10-point bonus if your estimate was exactly right**. Missing your estimate
  never costs you anything, so scores only ever climb — but the bonus is worth
  more than most hands of tricks, so calling your hand right is what wins
  games. A made zero scores 10.
- **Game over** after the last round: the highest total wins. Equal totals
  **share** the win.

### Lobby options (set by the host)

- **Trump cycles** — 1, 2, or 3 full passes through No-trump/♠/♥/♦/♣ (5/10/15
  rounds total).

### Staying unstuck

- After a trick finishes, it stays on the table briefly (highlighting the
  winning card) before clearing automatically.
- After a round's summary is shown, the next round starts once **everyone
  hits Ready**, or after a short auto-advance timeout regardless — so an
  away player can't stall the table.
- If it's a **disconnected** player's turn for too long, the server plays for
  them (the safest legal estimate, or their lowest legal card) so the game
  keeps moving. A reconnecting player (same room code + the browser's saved
  token) resumes their seat and hand exactly where they left off.

## Run it locally

Requires Node.js 18+.

```bash
cd estimation
npm install
npm start
# open http://localhost:3000
```

Open the URL in a few browser tabs to simulate multiple players, or have
people on the same Wi-Fi visit `http://<your-LAN-IP>:3000`.

Run the tests with:

```bash
npm test
```

## Play with friends remotely

The game needs a public URL. The quickest options:

### Deploy to Render (free)

1. Push this repo to GitHub.
2. On [render.com](https://render.com): **New → Blueprint**, select the repo.
   Render reads `estimation/render.yaml` (which sets `rootDir: estimation`)
   and provisions a free web service. (Or **New → Web Service** manually,
   with root directory `estimation`, build `npm install`, start `npm start`.)
3. Share the resulting `https://<your-app>.onrender.com` URL.

> Note: Render's free tier sleeps after inactivity, so the first load after a
> while can take ~30s to wake up.

### Or a quick tunnel (no deploy)

```bash
npm start                      # terminal 1, from estimation/
npx localtunnel --port 3000    # terminal 2 — gives you a shareable URL
```

(`ngrok http 3000` works too.)

## How it's built

- **`src/game.js`** — pure, deterministic game engine (fully unit-tested).
- **`src/rooms.js`** — in-memory room/lobby registry with short room codes.
- **`server.js`** — Express static host + Socket.IO realtime layer.
- **`public/`** — vanilla HTML/CSS/JS client (no build step).

Rooms live in memory, so a server restart clears all games.
