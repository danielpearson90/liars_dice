// Medium-difficulty bot for Liar's Dice. Pure decision logic: given a game and a
// bot's seat id, it returns the action to take. The server applies it through
// the normal engine methods, so a bot is bound by exactly the same rules as a
// human. Deterministic given an injected rng, which keeps it testable.

import { pAtLeast } from '../public/probability.js';

/** Dice in `hand` that satisfy a bid on `face` (wild 1s count for non-1 faces). */
function countMine(hand, face, wilds) {
  let c = 0;
  for (const d of hand) {
    if (d === face || (wilds && face !== 1 && d === 1)) c += 1;
  }
  return c;
}

/** Per-die chance an unknown die satisfies `face` (1/3 for a wild face, else 1/6). */
function pFace(face, wilds) {
  return wilds && face !== 1 ? 2 / 6 : 1 / 6;
}

/**
 * Decide a move for the bot at `botId`.
 *
 * `skill` (~0.35–1) is a hidden per-bot competence knob: higher skill sharpens
 * lie-detection, tightens which raises it's willing to bluff, and reduces random
 * play. Every bot stays at least competent (there's no "easy" floor below ~0.35).
 *
 * @returns {{type:'bid', quantity:number, face:number} | {type:'challenge'} | {type:'spotOn'}}
 */
export function decideMove(game, botId, rng = Math.random, skill = 0.7) {
  const hand = game.getPlayer(botId).dice;
  const total = game.totalDiceInPlay();
  const unknown = total - hand.length;
  const wilds = game.ruleset.wilds;
  const bid = game.currentBid;

  // Expected total count of `face` across the table from the bot's viewpoint.
  const expected = (face) => countMine(hand, face, wilds) + unknown * pFace(face, wilds);
  // Probability that a bid of (quantity, face) is true, given the bot's hand.
  const belief = (quantity, face) => {
    const need = quantity - countMine(hand, face, wilds);
    if (need <= 0) return 1;
    if (need > unknown) return 0;
    return pAtLeast(need, unknown, pFace(face, wilds));
  };

  // Opening bid: lead with the face the bot expects most of, near that count.
  if (!bid) {
    let best = 1;
    let bestExp = -1;
    for (let f = 1; f <= 6; f++) {
      const e = expected(f);
      if (e > bestExp) {
        bestExp = e;
        best = f;
      }
    }
    const quantity = Math.min(total, Math.max(1, Math.round(bestExp)));
    return { type: 'bid', quantity, face: best };
  }

  // How believable is the standing bid?
  const pTrue = belief(bid.quantity, bid.face);

  // Call "liar" when it looks unlikely. Sharper bots use a higher cutoff (catch
  // more lies) with less random jitter; weaker bots let more bids stand.
  const jitter = (rng() - 0.5) * (0.14 - 0.08 * skill);
  const challengeAt = 0.28 + 0.16 * skill + jitter;
  if (pTrue < challengeAt) return { type: 'challenge' };

  // Occasionally call spot-on when the count looks exactly right.
  if (Math.abs(expected(bid.face) - bid.quantity) < 0.5 && rng() < 0.08 + 0.12 * skill) {
    return { type: 'spotOn' };
  }

  // Otherwise make a believable legal raise. Sharper bots bluff less loosely
  // (higher belief floor) and pick more decisively (smaller candidate pool).
  const believableFloor = 0.4 + 0.12 * skill;
  const topN = skill > 0.7 ? 1 : skill > 0.5 ? 2 : 3;
  const raise = chooseRaise(bid, total, expected, belief, rng, believableFloor, topN);
  if (raise) return { type: 'bid', ...raise };

  // Nothing worth raising to — call it.
  return { type: 'challenge' };
}

/** Pick a legal raise the bot can reasonably stand behind (else null). */
function chooseRaise(bid, total, expected, belief, rng, believableFloor, topN) {
  const candidates = [];
  for (let f = 1; f <= 6; f++) {
    // Lowest legal quantity for this face: match on a higher face, else beat it.
    const minQ = f > bid.face ? bid.quantity : bid.quantity + 1;
    if (minQ < 1 || minQ > total) continue;
    const quantities = new Set([minQ]);
    const expRound = Math.round(expected(f));
    if (expRound >= minQ && expRound <= total) quantities.add(expRound);
    for (const q of quantities) {
      candidates.push({ quantity: q, face: f, belief: belief(q, f) });
    }
  }
  if (!candidates.length) return null;

  // Prefer raises the bot believes; fall back to the least-bad bluff.
  const believable = candidates.filter((c) => c.belief >= believableFloor);
  const pool = (believable.length ? believable : candidates).sort((a, b) => b.belief - a.belief);
  const top = pool.slice(0, Math.min(topN, pool.length));
  const pick = top[Math.floor(rng() * top.length)] || pool[0];
  return { quantity: pick.quantity, face: pick.face };
}
