import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game.js';
import { decideMove } from '../src/bot.js';

// Build a 2-player game, then overwrite hands/bid directly so the bot faces a
// known situation. (decideMove only reads state; it never checks whose turn.)
function situation({ myDice, oppCount = 5, bid = null, ruleset, startingDice = 5 }) {
  const players = [
    { id: 'bot', name: 'Bot' },
    { id: 'opp', name: 'Opp' },
  ];
  const g = new Game(players, () => 0.0001, startingDice, ruleset);
  g.getPlayer('bot').dice = myDice.slice();
  g.getPlayer('bot').diceCount = myDice.length;
  g.getPlayer('opp').dice = Array(oppCount).fill(1);
  g.getPlayer('opp').diceCount = oppCount;
  g.currentBid = bid;
  return g;
}

const rng = () => 0.5; // deterministic, avoids the spot-on / jitter branches

test('opening bid is legal and leads with the strongest face', () => {
  const g = situation({ myDice: [4, 4, 4, 2, 6] }); // strong in 4s
  const move = decideMove(g, 'bot', rng);
  assert.equal(move.type, 'bid');
  assert.equal(move.face, 4);
  assert.ok(move.quantity >= 1 && move.quantity <= g.totalDiceInPlay());
  // Engine accepts it.
  assert.doesNotThrow(() => g.bid('bot', move.quantity, move.face));
});

test('challenges a wildly implausible bid', () => {
  // 10 dice total, bot holds zero sixes; "10 sixes" is essentially impossible.
  const g = situation({ myDice: [2, 3, 4, 5, 1], bid: { playerId: 'opp', quantity: 10, face: 6 } });
  assert.deepEqual(decideMove(g, 'bot', rng), { type: 'challenge' });
});

test('does not challenge a very safe bid — raises legally instead', () => {
  // Bot itself holds four 5s, so "two 5s" is rock solid; it should raise.
  const g = situation({ myDice: [5, 5, 5, 5, 2], bid: { playerId: 'opp', quantity: 2, face: 5 } });
  const move = decideMove(g, 'bot', rng);
  assert.equal(move.type, 'bid');
  // The raise must out-rank the current bid and be accepted by the engine.
  assert.ok(g.outranks(move.quantity, move.face, g.currentBid));
  assert.doesNotThrow(() => g.bid('bot', move.quantity, move.face));
});

test('aces are treated as wild when the ruleset says so', () => {
  // With aces wild, the bot's three 1s back a bid on 5s. "3 fives" should look
  // safe (the 1s count), so the bot raises rather than challenges.
  const g = situation({
    myDice: [1, 1, 1, 5, 5],
    ruleset: 'aces-wild',
    bid: { playerId: 'opp', quantity: 3, face: 5 },
  });
  const move = decideMove(g, 'bot', rng);
  assert.notEqual(move.type, 'challenge');
  if (move.type === 'bid') assert.ok(g.outranks(move.quantity, move.face, g.currentBid));
});

test('every decision the bot makes is a legal engine move', () => {
  // Fuzz a range of bids; whatever the bot returns must be accepted.
  for (let q = 1; q <= 9; q++) {
    for (let f = 1; f <= 6; f++) {
      const g = situation({ myDice: [3, 3, 6, 2, 4], bid: { playerId: 'opp', quantity: q, face: f } });
      g.turnId = 'bot'; // so the engine's turn guard passes when we apply it
      const move = decideMove(g, 'bot', () => 0.5);
      assert.doesNotThrow(() => {
        if (move.type === 'challenge') g.challenge('bot');
        else if (move.type === 'spotOn') g.spotOn('bot');
        else g.bid('bot', move.quantity, move.face);
      }, `illegal move for bid ${q}x${f}: ${JSON.stringify(move)}`);
    }
  }
});
