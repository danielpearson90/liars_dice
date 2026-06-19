import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, RULESETS, resolveRuleset, DEFAULT_RULESET } from '../src/game.js';

function rngFor(values) {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i += 1;
    return (v - 1) / 6 + 0.0001; // maps back to face `v` via 1 + floor(rng*6)
  };
}

// Build a game with a scripted RNG so dice are deterministic. `values` is the
// flat sequence of die faces dealt out in player order on each roll.
function gameWithDice(playerCount, values) {
  const players = Array.from({ length: playerCount }, (_, n) => ({
    id: `p${n}`,
    name: `P${n}`,
  }));
  return new Game(players, rngFor(values));
}

// Like gameWithDice but lets a test pick the ruleset / starting dice.
function makeGame(playerCount, values, { ruleset, startingDice = 5 } = {}) {
  const players = Array.from({ length: playerCount }, (_, n) => ({
    id: `p${n}`,
    name: `P${n}`,
  }));
  return new Game(players, rngFor(values), startingDice, ruleset);
}

test('rng helper deals the intended faces', () => {
  // 2 players × 5 dice = 10 values.
  const g = gameWithDice(2, [1, 2, 3, 4, 5, 6, 1, 2, 3, 4]);
  assert.deepEqual(g.players[0].dice, [1, 2, 3, 4, 5]);
  assert.deepEqual(g.players[1].dice, [6, 1, 2, 3, 4]);
});

test('starting state', () => {
  const g = gameWithDice(3, [1]);
  assert.equal(g.phase, 'playing');
  assert.equal(g.totalDiceInPlay(), 15);
  assert.equal(g.turnId, 'p0');
  assert.equal(g.currentBid, null);
});

test('bids must strictly out-rank the current bid', () => {
  const g = gameWithDice(2, [1]);
  g.bid('p0', 2, 3);
  assert.throws(() => g.bid('p1', 2, 3), /higher/);
  assert.throws(() => g.bid('p1', 1, 6), /higher/);
  g.bid('p1', 2, 4); // same qty, higher face: ok
  assert.deepEqual(g.currentBid, { playerId: 'p1', quantity: 2, face: 4 });
  g.bid('p0', 3, 1); // higher qty, lower face: ok
  assert.equal(g.currentBid.quantity, 3);
});

test('each player keeps their latest bid, cleared on a new round', () => {
  const g = gameWithDice(2, [2, 2, 3, 4, 5, 6, 1, 2, 3, 4]); // three 2s
  g.bid('p0', 2, 3);
  g.bid('p1', 2, 4);
  assert.deepEqual(g.getPlayer('p0').lastBid, { quantity: 2, face: 3 });
  assert.deepEqual(g.getPlayer('p1').lastBid, { quantity: 2, face: 4 });
  g.bid('p0', 3, 2); // overwrites p0's standing bid
  assert.deepEqual(g.getPlayer('p0').lastBid, { quantity: 3, face: 2 });

  g.challenge('p1');
  g.nextRound();
  assert.equal(g.getPlayer('p0').lastBid, null);
  assert.equal(g.getPlayer('p1').lastBid, null);
});

test('turn order is enforced', () => {
  const g = gameWithDice(2, [1]);
  assert.throws(() => g.bid('p1', 1, 2), /not your turn/);
});

test('bid cannot exceed dice in play', () => {
  const g = gameWithDice(2, [1]); // 10 dice total
  assert.throws(() => g.bid('p0', 11, 2), /exceeds/);
  g.bid('p0', 10, 2); // exactly the total is allowed
  assert.equal(g.currentBid.quantity, 10);
});

test('face must be 1..6', () => {
  const g = gameWithDice(2, [1]);
  assert.throws(() => g.bid('p0', 1, 0), /Face/);
  assert.throws(() => g.bid('p0', 1, 7), /Face/);
});

test('challenge: bid was a lie -> bidder loses a die', () => {
  // p0: 2,2,3,4,5 ; p1: 6,1,2,3,4  -> there are three 2s.
  const g = gameWithDice(2, [2, 2, 3, 4, 5, 6, 1, 2, 3, 4]);
  g.bid('p0', 4, 2); // claim four 2s; only three exist -> lie
  const ev = g.challenge('p1');
  assert.equal(ev.actual, 3);
  assert.deepEqual(ev.losers, ['p0']);
  assert.equal(g.getPlayer('p0').diceCount, 4);
  assert.equal(g.getPlayer('p1').diceCount, 5);
  assert.equal(g.phase, 'reveal');
});

test('challenge: bid was good -> challenger loses a die', () => {
  const g = gameWithDice(2, [2, 2, 3, 4, 5, 6, 1, 2, 3, 4]); // three 2s
  g.bid('p0', 3, 2); // exactly true, so the bid holds (actual >= qty)
  const ev = g.challenge('p1');
  assert.equal(ev.actual, 3);
  assert.deepEqual(ev.losers, ['p1']);
  assert.equal(g.getPlayer('p1').diceCount, 4);
});

test('spot-on: exact -> all others lose a die', () => {
  const g = gameWithDice(3, [2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]); // exactly two 2s
  g.bid('p0', 2, 2); // exactly two 2s
  const ev = g.spotOn('p1');
  assert.equal(ev.actual, 2);
  assert.equal(ev.exact, true);
  assert.deepEqual(ev.losers.sort(), ['p0', 'p2']);
  assert.equal(g.getPlayer('p0').diceCount, 4);
  assert.equal(g.getPlayer('p1').diceCount, 5); // caller untouched
  assert.equal(g.getPlayer('p2').diceCount, 4);
});

test('spot-on: wrong -> caller loses a die', () => {
  const g = gameWithDice(2, [2, 2, 3, 4, 5, 6, 1, 2, 3, 4]); // three 2s
  g.bid('p0', 2, 2);
  const ev = g.spotOn('p1');
  assert.equal(ev.exact, false);
  assert.deepEqual(ev.losers, ['p1']);
  assert.equal(g.getPlayer('p1').diceCount, 4);
});

test('losing the last die eliminates a player and ends a 2-player game', () => {
  const g = gameWithDice(2, [1]); // everyone rolls all 1s, so there are zero 2s
  g.getPlayer('p0').diceCount = 1; // p0 is down to its final die
  g.startRound('p0'); // re-deal with p0 opening
  g.bid('p0', 1, 2); // claim a 2 exists; none do -> lie
  const ev = g.challenge('p1'); // p0 (bidder) loses its last die
  assert.equal(ev.gameOver, true);
  assert.equal(ev.winnerId, 'p1');
  assert.equal(g.phase, 'gameover');
  assert.equal(g.getPlayer('p0').eliminated, true);
});

test('eliminated player is skipped in turn order', () => {
  const g = gameWithDice(3, [1]);
  g.getPlayer('p1').eliminated = true;
  assert.equal(g.nextActiveId('p0'), 'p2');
  assert.equal(g.nextActiveId('p2'), 'p0');
});

test('the round opener advances one seat each round, regardless of the caller', () => {
  const g = gameWithDice(2, [2, 2, 3, 4, 5, 6, 1, 2, 3, 4]); // three 2s
  assert.equal(g.roundStarterId, 'p0'); // round 1 opens with the first seat
  g.bid('p0', 4, 2); // lie -> p0 loses a die
  const ev = g.challenge('p1'); // p1 made the call
  // Opener for round 2 is the seat after the previous opener (p0) -> p1,
  // not chosen by who called or who lost.
  assert.equal(ev.nextStarterId, 'p1');
  g.nextRound();
  assert.equal(g.turnId, 'p1');
  assert.equal(g.roundStarterId, 'p1');
  assert.equal(g.currentBid, null);
  assert.equal(g.roundNumber, 2);
});

test('opener rotation ignores who called the showdown (3 players)', () => {
  const g = gameWithDice(3, [1]); // everyone rolls 1s -> zero 2s
  assert.equal(g.roundStarterId, 'p0');
  g.bid('p0', 1, 2);
  g.bid('p1', 2, 2);
  g.challenge('p2'); // p2 calls; the previous opener was p0
  const ev = g.lastReveal;
  // Opener advances from p0 to the next seat, p1 (independent of caller p2).
  assert.equal(ev.nextStarterId, 'p1');
  g.nextRound();
  assert.equal(g.turnId, 'p1');
});

test('view hides opponents dice during play, reveals at showdown', () => {
  const g = gameWithDice(2, [2, 2, 3, 4, 5, 6, 1, 2, 3, 4]);
  const view = g.toView('p0');
  assert.ok(Array.isArray(view.players[0].dice)); // own dice visible
  assert.equal(view.players[1].dice, null); // opponent hidden
  g.bid('p0', 1, 2);
  g.challenge('p1');
  const revealView = g.toView('p0');
  assert.ok(Array.isArray(revealView.players[1].dice)); // visible at reveal
});

test('ready votes are tracked during the reveal and cleared each round', () => {
  const g = gameWithDice(2, [2, 2, 3, 4, 5, 6, 1, 2, 3, 4]);
  g.bid('p0', 4, 2); // a lie -> challengeable
  g.challenge('p1'); // -> reveal
  assert.equal(g.phase, 'reveal');

  g.markReady('p0', true);
  g.markReady('p1', true);
  assert.deepEqual([...g.readyIds].sort(), ['p0', 'p1']);
  assert.deepEqual([...g.toView('p0').readyIds].sort(), ['p0', 'p1']);
  g.markReady('p1', false); // can un-ready
  assert.deepEqual([...g.readyIds], ['p0']);

  g.nextRound();
  assert.equal(g.readyIds.size, 0); // cleared for the new round
  g.markReady('p0', true); // ignored outside a reveal
  assert.equal(g.readyIds.size, 0);
});

test('cannot challenge or call spot-on with no bid', () => {
  const g = gameWithDice(2, [1]);
  assert.throws(() => g.challenge('p0'), /no bid/i);
  assert.throws(() => g.spotOn('p0'), /no bid/i);
});

test('needs at least two players', () => {
  assert.throws(() => new Game([{ id: 'p0', name: 'solo' }]), /at least 2/);
});

test('starting dice are configurable and flow into the deal', () => {
  const players = [
    { id: 'p0', name: 'A' },
    { id: 'p1', name: 'B' },
  ];
  const g = new Game(players, () => 0.0001, 3);
  assert.equal(g.startingDice, 3);
  assert.equal(g.getPlayer('p0').diceCount, 3);
  assert.equal(g.getPlayer('p0').dice.length, 3);
  assert.equal(g.totalDiceInPlay(), 6);
});

test('starting dice are clamped to 1..20', () => {
  const players = [
    { id: 'p0', name: 'A' },
    { id: 'p1', name: 'B' },
  ];
  assert.equal(new Game(players, undefined, 25).startingDice, 20);
  assert.equal(new Game(players, undefined, 0).startingDice, 1);
  assert.equal(new Game(players, undefined, -5).startingDice, 1);
  assert.equal(new Game(players, undefined, 4.6).startingDice, 5); // rounds
  assert.equal(new Game(players, undefined).startingDice, 5); // default
});

// --- rulesets --------------------------------------------------------------

test('default ruleset is Common Hand (no wilds, others-lose)', () => {
  const g = gameWithDice(2, [1]);
  assert.equal(g.ruleset.id, DEFAULT_RULESET);
  assert.equal(g.ruleset.wilds, false);
  assert.equal(g.ruleset.spotOnReward, 'others-lose');
});

test('resolveRuleset falls back to the default for unknown ids', () => {
  assert.equal(resolveRuleset('nonsense'), RULESETS[DEFAULT_RULESET]);
  assert.equal(resolveRuleset('aces-wild').id, 'aces-wild');
});

test('aces wild: 1s count toward a non-1 face but a 1-bid counts only 1s', () => {
  // p0: 1,1,5,2,3 ; p1: 5,1,4,6,2
  const dice = [1, 1, 5, 2, 3, 5, 1, 4, 6, 2];
  const wild = makeGame(2, dice, { ruleset: 'aces-wild' });
  assert.equal(wild.countFace(5), 5); // two literal 5s + three wild 1s
  assert.equal(wild.countFace(1), 3); // a 1-bid counts only the three 1s
  const plain = makeGame(2, dice, { ruleset: 'common-hand' });
  assert.equal(plain.countFace(5), 2); // no wilds
});

test('aces wild: a challenge counts the wild 1s', () => {
  const g = makeGame(2, [1, 1, 5, 2, 3, 5, 1, 4, 6, 2], { ruleset: 'aces-wild' });
  g.bid('p0', 5, 5); // five 5s — true only because the three 1s are wild
  const ev = g.challenge('p1');
  assert.equal(ev.actual, 5);
  assert.equal(ev.countsWild, true);
  assert.deepEqual(ev.losers, ['p1']); // bid held, challenger loses
});

test('spot-on regains: a correct call wins the caller a die back', () => {
  const g = makeGame(2, [1], { ruleset: 'spot-regain' });
  g.getPlayer('p0').dice = [5, 5, 1, 1, 1]; // exactly two 5s (no wilds)
  g.getPlayer('p1').dice = [1, 1, 1, 1];
  g.getPlayer('p1').diceCount = 4; // p1 has room to grow
  g.bid('p0', 2, 5);
  const ev = g.spotOn('p1');
  assert.equal(ev.exact, true);
  assert.equal(ev.gainerId, 'p1');
  assert.deepEqual(ev.losers, []);
  assert.equal(g.getPlayer('p1').diceCount, 5); // gained one back
});

test('spot-on regains: caller already at max gains nothing', () => {
  const g = makeGame(2, [1], { ruleset: 'spot-regain' });
  g.getPlayer('p0').dice = [5, 5, 1, 1, 1];
  g.getPlayer('p1').dice = [1, 1, 1, 1, 1]; // p1 still at the 5-die max
  g.bid('p0', 2, 5);
  const ev = g.spotOn('p1');
  assert.equal(ev.exact, true);
  assert.equal(ev.gainerCapped, true);
  assert.equal(g.getPlayer('p1').diceCount, 5);
});

test('spot-on regains: a wrong call still costs the caller a die', () => {
  const g = makeGame(2, [1], { ruleset: 'spot-regain' });
  g.getPlayer('p0').dice = [5, 1, 1, 1, 1]; // only one 5
  g.getPlayer('p1').dice = [1, 1, 1, 1, 1];
  g.bid('p0', 2, 5); // claims two
  const ev = g.spotOn('p1');
  assert.equal(ev.exact, false);
  assert.deepEqual(ev.losers, ['p1']);
  assert.equal(g.getPlayer('p1').diceCount, 4);
});

test('aces wild: spot-on counts 1s as wild', () => {
  // Two literal 5s + three 1s = exactly five 5s when aces are wild.
  const g = makeGame(2, [1], { ruleset: 'aces-wild' });
  g.getPlayer('p0').dice = [5, 5, 1, 2, 3];
  g.getPlayer('p1').dice = [1, 1, 4, 6, 2];
  g.bid('p0', 5, 5);
  const ev = g.spotOn('p1');
  assert.equal(ev.actual, 5);
  assert.equal(ev.exact, true);
  assert.equal(ev.countsWild, true);
});

test('aces wild: spot-on can be exact on wild 1s alone', () => {
  const g = makeGame(2, [1], { ruleset: 'aces-wild' });
  g.getPlayer('p0').dice = [1, 1, 2, 3, 4]; // no literal 5s, two wild 1s...
  g.getPlayer('p1').dice = [1, 6, 6, 6, 6]; // ...plus one more wild 1 = three
  g.bid('p0', 3, 5);
  const ev = g.spotOn('p1');
  assert.equal(ev.actual, 3);
  assert.equal(ev.exact, true);
});

test('aces wild: a bid on aces is not helped by wilds', () => {
  // Bidding face 1 counts only literal 1s — aces are never wild for themselves.
  const g = makeGame(2, [1], { ruleset: 'aces-wild' });
  g.getPlayer('p0').dice = [1, 1, 5, 5, 5];
  g.getPlayer('p1').dice = [1, 2, 3, 4, 6];
  g.bid('p0', 3, 1);
  const ev = g.spotOn('p1');
  assert.equal(ev.actual, 3); // three literal 1s, not more
  assert.equal(ev.exact, true);
  assert.equal(ev.countsWild, false);
});

// --- reverse (lose-to-win) ruleset ----------------------------------------

test('reverse: a correct Liar call sheds the challenger a die', () => {
  const g = makeGame(2, [1], { ruleset: 'reverse' });
  g.getPlayer('p0').dice = [2, 3, 4, 5, 6]; // no 1s
  g.getPlayer('p1').dice = [2, 3, 4, 5, 6];
  g.bid('p0', 3, 1); // claims three 1s — a lie (there are none)
  const ev = g.challenge('p1'); // p1 is right -> p1 sheds
  assert.deepEqual(ev.losers, ['p1']);
  assert.equal(g.getPlayer('p1').diceCount, 4);
  assert.equal(g.getPlayer('p0').diceCount, 5);
});

test('reverse: a bid that holds sheds the bidder a die', () => {
  const g = makeGame(2, [1], { ruleset: 'reverse' });
  g.getPlayer('p0').dice = [2, 2, 2, 4, 5]; // three 2s
  g.getPlayer('p1').dice = [3, 3, 4, 5, 6];
  g.bid('p0', 2, 2); // true (three 2s ≥ 2)
  const ev = g.challenge('p1'); // bid held -> p0 was right -> p0 sheds
  assert.deepEqual(ev.losers, ['p0']);
  assert.equal(g.getPlayer('p0').diceCount, 4);
});

test('reverse: first to zero dice wins (not eliminated)', () => {
  const g = makeGame(2, [1], { ruleset: 'reverse' });
  g.getPlayer('p0').dice = [2]; // p0 on its last die...
  g.getPlayer('p0').diceCount = 1;
  g.getPlayer('p1').dice = [2, 2, 2, 2, 2];
  g.bid('p0', 1, 2); // true -> holds -> p0 (bidder) sheds its last die
  const ev = g.challenge('p1');
  assert.equal(ev.gameOver, true);
  assert.equal(ev.winnerId, 'p0');
  assert.equal(g.phase, 'gameover');
  assert.equal(g.getPlayer('p0').diceCount, 0);
  assert.equal(g.getPlayer('p0').eliminated, false); // they won, not out
});

test('reverse: a correct spot-on gives everyone else a die (capped at start)', () => {
  const g = makeGame(2, [1], { ruleset: 'reverse' });
  g.getPlayer('p0').dice = [5, 5, 2, 3]; // two 5s
  g.getPlayer('p0').diceCount = 4; // room to be pushed back up
  g.getPlayer('p1').dice = [3, 3, 3, 3, 3];
  g.bid('p0', 2, 5); // exactly two 5s
  const ev = g.spotOn('p1');
  assert.equal(ev.exact, true);
  assert.deepEqual(ev.gainers, ['p0']);
  assert.equal(g.getPlayer('p0').diceCount, 5); // pushed back toward the start
  assert.equal(g.getPlayer('p1').diceCount, 5); // caller unaffected
});

test('reverse: a wrong spot-on gives the caller a die', () => {
  const g = makeGame(2, [1], { ruleset: 'reverse' });
  g.getPlayer('p0').dice = [5, 5, 2, 3];
  g.getPlayer('p1').dice = [3, 3, 3, 3]; // diceCount 4
  g.getPlayer('p1').diceCount = 4;
  g.bid('p0', 3, 5); // claims three 5s; only two exist
  const ev = g.spotOn('p1');
  assert.equal(ev.exact, false);
  assert.deepEqual(ev.gainers, ['p1']);
  assert.equal(g.getPlayer('p1').diceCount, 5);
});

test('toView exposes the active ruleset', () => {
  const g = makeGame(2, [1], { ruleset: 'aces-wild' });
  const view = g.toView('p0');
  assert.equal(view.ruleset.id, 'aces-wild');
  assert.equal(view.ruleset.wilds, true);
});
