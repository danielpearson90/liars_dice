import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Game,
  MIN_PLAYERS,
  MAX_PLAYERS,
  DEFAULT_CYCLES,
  clampCycles,
  maxHandFor,
  handSizeForRound,
  STARTING_HAND,
  cardId,
  trickWinner,
} from '../src/game.js';

// Deterministic PRNG (mulberry32) so a "real" shuffle is still reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGame(playerCount, { cycles, rng, seed = 1 } = {}) {
  const players = Array.from({ length: playerCount }, (_, n) => ({
    id: `p${n}`,
    name: `P${n}`,
  }));
  return new Game(players, rng || mulberry32(seed), cycles);
}

// Drives a round to completion with the least amount of scripted decision
// making: everyone estimates the lowest legal number, and every trick is
// played by always taking the first legal card. Useful for tests that only
// care about *phase transitions* (round -> round -> gameover, dealer
// rotation), not about who wins which trick.
function playOutRound(g) {
  for (const id of g.estimateOrder) {
    const forbidden = g.toView(id).forbiddenEstimate;
    g.estimate(id, forbidden === 0 ? 1 : 0);
  }
  const tricks = g.handSize;
  const n = g.players.length;
  for (let t = 0; t < tricks; t++) {
    for (let i = 0; i < n; i++) {
      const playerId = g.turnId;
      const legal = g.legalCardIdsFor(playerId);
      g.playCard(playerId, legal[0]);
    }
    g.sweepTrick();
  }
}

// --- dealing -----------------------------------------------------------------

test('deal size, no duplicate cards, and dealtOut hold for 2-5 players', () => {
  for (const n of [2, 3, 4, 5]) {
    const g = makeGame(n, { seed: n * 7 + 1 });
    const expectedHandSize = STARTING_HAND; // round 1 always deals 5
    const allIds = [];
    for (const p of g.players) {
      const hand = g.hands.get(p.id);
      assert.equal(hand.length, expectedHandSize, `hand size for ${n} players`);
      allIds.push(...hand.map(cardId));
    }
    assert.equal(new Set(allIds).size, allIds.length, 'no duplicate cards dealt');
    assert.equal(g.dealtOut, 52 - expectedHandSize * n);
  }
});

test('maxHandFor caps at 13 and floors otherwise', () => {
  assert.equal(maxHandFor(2), 13);
  assert.equal(maxHandFor(3), 13);
  assert.equal(maxHandFor(4), 13);
  assert.equal(maxHandFor(5), 10);
});

test('hands start at 5 and grow one card per round, stopping at the deck limit', () => {
  assert.equal(STARTING_HAND, 5);
  // 4 players: 5, 6, 7 ... up to 13, then flat.
  assert.deepEqual(
    [0, 1, 2, 3, 7, 8, 9, 14].map((r) => handSizeForRound(4, r)),
    [5, 6, 7, 8, 12, 13, 13, 13]
  );
  // 5 players can only ever be dealt 10 each, so the growth stops sooner.
  assert.deepEqual(
    [0, 4, 5, 6, 14].map((r) => handSizeForRound(5, r)),
    [5, 9, 10, 10, 10]
  );
});

test('a played-out game deals a bigger hand every round', () => {
  const g = makeGame(4, { cycles: 1 });
  const dealt = [];
  for (let r = 0; r < 5; r++) {
    dealt.push(g.handSize);
    for (const p of g.players) assert.equal(g.hands.get(p.id).length, g.handSize);
    assert.equal(g.dealtOut, 52 - g.handSize * 4);
    playOutRound(g);
    if (g.phase === 'roundEnd') g.nextRound();
  }
  assert.deepEqual(dealt, [5, 6, 7, 8, 9]);
});

test('clampCycles clamps to 1..3 with a default on NaN', () => {
  assert.equal(clampCycles(2), 2);
  assert.equal(clampCycles(0), 1);
  assert.equal(clampCycles(10), 3);
  assert.equal(clampCycles('nonsense'), DEFAULT_CYCLES);
  assert.equal(clampCycles(undefined), DEFAULT_CYCLES);
});

test('needs 2..5 players', () => {
  assert.throws(() => new Game([{ id: 'p0', name: 'solo' }]), /at least 2/);
  const six = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
  assert.throws(() => new Game(six), /no more than 5/i);
  assert.equal(MIN_PLAYERS, 2);
  assert.equal(MAX_PLAYERS, 5);
});

// --- estimation --------------------------------------------------------------

test('estimate range and turn-order guards', () => {
  const g = makeGame(2);
  assert.equal(g.turnId, 'p1'); // dealer (p0) estimates last
  assert.throws(() => g.estimate('p0', 0), /not your turn/i);
  assert.throws(() => g.estimate('p1', -1), /between 0 and/i);
  assert.throws(() => g.estimate('p1', 6), /between 0 and/i); // round 1 deals 5
  assert.throws(() => g.estimate('p1', 1.5), /between 0 and/i);

  g.estimate('p1', 0);
  assert.throws(() => g.estimate('p1', 0), /not your turn/i); // turn moved on to p0

  g.estimate('p0', 4); // 0 + 4 = 4 != 5, legal
  assert.equal(g.phase, 'playing');
  assert.throws(() => g.estimate('p0', 0), /no action/i); // wrong phase now
});

test('the last estimator may not make the total equal the hand size', () => {
  const handSize = STARTING_HAND; // 5 in round 1
  for (let n = 0; n <= handSize; n++) {
    const g = makeGame(2);
    g.estimate('p1', 2); // first estimator, any legal number
    const forbidden = handSize - 2; // = 3
    if (n === forbidden) {
      assert.throws(() => g.estimate('p0', n), /can't add up to 5/);
    } else {
      assert.doesNotThrow(() => g.estimate('p0', n));
    }
  }
});

test('the total-equals-handSize constraint does not apply once the running total already exceeds it', () => {
  const g = makeGame(3);
  // p0 is the round-0 dealer, so estimates last; the other two go first.
  const others = g.estimateOrder.slice(0, 2);
  g.estimate(others[0], 4);
  g.estimate(others[1], 4); // running total 8, already > handSize (5)
  assert.equal(g.toView('p0').forbiddenEstimate, null);
  assert.doesNotThrow(() => g.estimate('p0', 5)); // no number is off-limits
});

test('forbiddenEstimate is only surfaced for the estimator currently on the clock', () => {
  const g = makeGame(2);
  assert.equal(g.toView('p1').forbiddenEstimate, null); // p1 is not the last estimator
  assert.equal(g.toView('p0').forbiddenEstimate, null); // not p0's turn yet
  g.estimate('p1', 2);
  assert.equal(g.toView('p0').forbiddenEstimate, 3); // now p0 is on the clock
});

// --- following suit -----------------------------------------------------------

test('follow-suit is enforced when the player holds the led suit', () => {
  const g = makeGame(2);
  g.estimate(g.turnId, 0);
  g.estimate(g.turnId, 0);
  assert.equal(g.phase, 'playing');
  assert.equal(g.turnId, 'p1');

  g.hands.set('p1', [
    { rank: 3, suit: 'C' },
    { rank: 9, suit: 'C' },
  ]);
  g.hands.set('p0', [
    { rank: 5, suit: 'S' },
    { rank: 7, suit: 'C' },
  ]);

  g.playCard('p1', '3C');
  assert.equal(g.trick.leadSuit, 'C');
  assert.deepEqual(g.legalCardIdsFor('p0'), ['7C']); // must follow the club
  assert.throws(() => g.playCard('p0', '5S'), /follow suit/i);
  g.playCard('p0', '7C'); // legal now
  assert.equal(g.trick.winnerId, 'p0'); // 7 beats the led 3, both clubs
});

test('a player with none of the led suit may play anything', () => {
  const g = makeGame(2);
  g.estimate(g.turnId, 0);
  g.estimate(g.turnId, 0);
  g.hands.set('p1', [{ rank: 3, suit: 'C' }]);
  g.hands.set('p0', [{ rank: 5, suit: 'S' }]); // no clubs at all
  g.playCard('p1', '3C');
  assert.deepEqual(g.legalCardIdsFor('p0'), ['5S']);
  assert.doesNotThrow(() => g.playCard('p0', '5S'));
});

test('a completed trick blocks further plays until it is swept', () => {
  const g = makeGame(2);
  g.estimate(g.turnId, 0);
  g.estimate(g.turnId, 0);
  g.hands.set('p1', [
    { rank: 3, suit: 'C' },
    { rank: 4, suit: 'C' },
  ]);
  g.hands.set('p0', [
    { rank: 5, suit: 'C' },
    { rank: 6, suit: 'C' },
  ]);
  g.playCard('p1', '3C');
  g.playCard('p0', '5C');
  assert.equal(g.trick.winnerId, 'p0'); // 5 beats 3
  assert.throws(() => g.playCard('p1', '4C'), /trick to clear/i);
  g.sweepTrick();
  assert.equal(g.trick.winnerId, null);
  assert.deepEqual(g.trick.plays, []);
  assert.equal(g.turnId, 'p0'); // winner leads next
});

// --- trickWinner ---------------------------------------------------------------

test('trickWinner: a trump play beats a higher card of the led suit', () => {
  const plays = [
    { playerId: 'p0', card: { rank: 14, suit: 'S' } }, // led ace of spades
    { playerId: 'p1', card: { rank: 2, suit: 'H' } }, // trump hearts, low rank
  ];
  assert.equal(trickWinner(plays, 'S', 'H'), 'p1');
});

test('trickWinner: the higher of two trump plays wins', () => {
  const plays = [
    { playerId: 'p0', card: { rank: 5, suit: 'H' } },
    { playerId: 'p1', card: { rank: 10, suit: 'H' } },
    { playerId: 'p2', card: { rank: 3, suit: 'S' } }, // led suit, not trump
  ];
  assert.equal(trickWinner(plays, 'S', 'H'), 'p1');
});

test('trickWinner: a No-trump round is won by the highest card of the led suit', () => {
  const plays = [
    { playerId: 'p0', card: { rank: 4, suit: 'D' } },
    { playerId: 'p1', card: { rank: 14, suit: 'H' } }, // off-suit, irrelevant in NT
    { playerId: 'p2', card: { rank: 9, suit: 'D' } },
  ];
  assert.equal(trickWinner(plays, 'D', 'NT'), 'p2');
});

test('trickWinner: a trump-less trick falls back to the highest of the led suit', () => {
  const plays = [
    { playerId: 'p0', card: { rank: 6, suit: 'C' } },
    { playerId: 'p1', card: { rank: 13, suit: 'C' } },
  ];
  // Trump is Hearts this round, but nobody happened to play one.
  assert.equal(trickWinner(plays, 'C', 'H'), 'p1');
});

// --- full round / scoring -------------------------------------------------------

test('a full round plays out to the right tricksWon totals and exercises both scoring branches', () => {
  const g = makeGame(2);
  // Rig the deal to the round's hand size: p1 holds only hearts (so it wins
  // every trick, p0 never holding one), p0 holds only spades.
  const hearts = [];
  const spades = [];
  for (let rank = 2; rank < 2 + g.handSize; rank++) {
    hearts.push({ rank, suit: 'H' });
    spades.push({ rank, suit: 'S' });
  }
  g.hands.set('p1', hearts);
  g.hands.set('p0', spades);

  assert.deepEqual(g.estimateOrder, ['p1', 'p0']); // p0 is round-0 dealer
  g.estimate('p1', g.handSize); // will be exactly right
  assert.equal(g.toView('p0').forbiddenEstimate, 0); // handSize - handSize
  g.estimate('p0', 2); // will miss (actual will be 0)

  assert.equal(g.phase, 'playing');
  assert.equal(g.turnId, 'p1');

  const tricks = g.handSize;
  for (let i = 0; i < tricks; i++) {
    g.playCard('p1', cardId(g.hands.get('p1')[0]));
    g.playCard('p0', cardId(g.hands.get('p0')[0]));
    assert.equal(g.trick.winnerId, 'p1'); // only p1's card is ever the led suit
    g.sweepTrick();
  }

  assert.equal(g.phase, 'roundEnd');
  assert.equal(g.tricksWon.get('p1'), tricks);
  assert.equal(g.tricksWon.get('p0'), 0);

  const summary = g.history[g.history.length - 1];
  const p1Row = summary.rows.find((r) => r.playerId === 'p1');
  const p0Row = summary.rows.find((r) => r.playerId === 'p0');
  assert.equal(p1Row.delta, tricks + 10); // every trick + the exact-estimate bonus
  assert.equal(p1Row.score, tricks + 10);
  assert.equal(p0Row.delta, 0); // estimated 2, took none: no tricks, no bonus
  assert.equal(p0Row.score, 0);

  const view = g.toView('p1');
  assert.deepEqual(view.roundSummary, summary);
});

// --- round/game lifecycle --------------------------------------------------------

test('dealer rotates one seat each round', () => {
  const g = makeGame(3, { cycles: 1 }); // 5 rounds
  const seenDealers = [];
  for (let round = 0; round < 5; round++) {
    seenDealers.push(g.dealerId);
    if (round < 4) {
      playOutRound(g);
      g.nextRound();
    }
  }
  assert.deepEqual(seenDealers, ['p0', 'p1', 'p2', 'p0', 'p1']);
});

test('the round after the last one ends the game, and tied totals share a rank', () => {
  const g = makeGame(2, { cycles: 1 }); // 5 rounds
  for (let round = 0; round < 4; round++) {
    playOutRound(g);
    assert.equal(g.phase, 'roundEnd');
    g.nextRound();
  }
  playOutRound(g);
  assert.equal(g.phase, 'roundEnd');

  // Force a tie regardless of how the natural play scored, to test standings.
  g.scores.set('p0', 40);
  g.scores.set('p1', 40);
  const ev = g.nextRound();
  assert.equal(ev.type, 'gameover');
  assert.equal(g.phase, 'gameover');
  assert.deepEqual(
    g.standings.map((s) => s.rank),
    [1, 1]
  );
  const view = g.toView('p0');
  assert.deepEqual(
    view.standings.map((s) => s.rank),
    [1, 1]
  );
  assert.throws(() => g.nextRound(), /not waiting/i);
});

test('markReady only counts during roundEnd and clears each round', () => {
  const g = makeGame(2, { cycles: 1 });
  g.markReady('p0', true); // ignored: not roundEnd yet
  assert.equal(g.readyIds.size, 0);
  playOutRound(g);
  assert.equal(g.phase, 'roundEnd');
  g.markReady('p0', true);
  g.markReady('p1', true);
  assert.deepEqual([...g.readyIds].sort(), ['p0', 'p1']);
  g.markReady('p1', false);
  assert.deepEqual([...g.readyIds], ['p0']);
  g.nextRound();
  assert.equal(g.readyIds.size, 0);
});

// --- view / privacy ----------------------------------------------------------

test('toView never leaks another player\'s hand', () => {
  const g = makeGame(2);
  const p0View = g.toView('p0');
  assert.equal(p0View.hand.length, STARTING_HAND);
  const p1CardIds = g.hands.get('p1').map(cardId);
  const json = JSON.stringify(p0View);
  for (const id of p1CardIds) {
    assert.ok(!json.includes(`"${id}"`), `leaked card ${id}`);
  }
  // A viewer with no seat (e.g. a spectator id) gets no hand at all.
  assert.deepEqual(g.toView('nobody').hand, []);
});

test('toView reports player-facing round/turn metadata', () => {
  const g = makeGame(4, { cycles: 3 });
  const view = g.toView('p0');
  assert.equal(view.cycles, 3);
  assert.equal(view.totalRounds, 15);
  assert.equal(view.round.number, 1);
  assert.equal(view.round.trump, 'NT');
  assert.equal(view.round.dealerId, 'p0');
  assert.equal(view.round.handSize, 5); // round 1 always deals 5
  assert.equal(view.round.dealtOut, 52 - 5 * 4);
  assert.ok(view.players.find((p) => p.id === 'p0').isDealer);
  assert.ok(view.players.find((p) => p.id === 'p0').isYou);
  assert.equal(view.players.find((p) => p.id === 'p1').isYou, false);
  assert.equal(view.trick.plays.length, 0);
  assert.equal(view.trick.winnerId, null);
  assert.equal(view.roundSummary, null);
  assert.equal(view.standings, null);
});
