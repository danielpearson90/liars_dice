import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game.js';

// Build a game with a scripted RNG so dice are deterministic. `values` is the
// flat sequence of die faces dealt out in player order on each roll.
function gameWithDice(playerCount, values) {
  let i = 0;
  const rng = () => {
    const v = values[i % values.length];
    i += 1;
    return (v - 1) / 6 + 0.0001; // maps back to face `v` via 1 + floor(rng*6)
  };
  const players = Array.from({ length: playerCount }, (_, n) => ({
    id: `p${n}`,
    name: `P${n}`,
  }));
  return new Game(players, rng);
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
  // p0 bids a 2 (a lie), p1 challenges, the bidder p0 loses — and since the
  // loser leads the next round, p0 keeps leading and losing.
  for (let i = 0; i < 4; i++) {
    g.bid('p0', 1, 2); // claim a 2 exists; none do -> lie
    g.challenge('p1'); // p0 (bidder) loses a die
    g.nextRound();
  }
  assert.equal(g.getPlayer('p0').diceCount, 1);
  // Final loss eliminates p0 and ends the game.
  g.bid('p0', 1, 2);
  const ev = g.challenge('p1');
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

test('new round re-rolls and play continues to the next player, not the loser', () => {
  const g = gameWithDice(2, [2, 2, 3, 4, 5, 6, 1, 2, 3, 4]); // three 2s
  g.bid('p0', 4, 2); // lie -> p0 loses a die
  const ev = g.challenge('p1'); // p1 made the call
  // Next leader is the player after the caller (p1), i.e. p0 — not chosen
  // because p0 lost, but because it is simply the next seat.
  assert.equal(ev.nextStarterId, 'p0');
  g.nextRound();
  assert.equal(g.turnId, 'p0');
  assert.equal(g.currentBid, null);
  assert.equal(g.roundNumber, 2);
});

test('next round leader is the seat after the caller (3 players)', () => {
  const g = gameWithDice(3, [1]); // everyone rolls 1s -> zero 2s
  g.bid('p0', 1, 2);
  g.bid('p1', 2, 2);
  const ev = g.challenge('p2'); // p2 calls; bid was a lie so p1 loses a die
  // Leader continues past the caller p2 -> wraps to p0.
  assert.equal(ev.nextStarterId, 'p0');
  g.nextRound();
  assert.equal(g.turnId, 'p0');
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

test('cannot challenge or call spot-on with no bid', () => {
  const g = gameWithDice(2, [1]);
  assert.throws(() => g.challenge('p0'), /no bid/i);
  assert.throws(() => g.spotOn('p0'), /no bid/i);
});

test('needs at least two players', () => {
  assert.throws(() => new Game([{ id: 'p0', name: 'solo' }]), /at least 2/);
});
