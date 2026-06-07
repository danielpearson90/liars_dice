// Pure game engine for Liar's Dice.
//
// Ruleset implemented:
//   - Each player starts with 5 dice.
//   - On a player's turn they may either RAISE the current bid or, if a bid
//     already exists, CHALLENGE it ("liar") or call SPOT-ON ("exact").
//   - A bid is a (quantity, face) pair claiming that AT LEAST `quantity` dice
//     across the whole table show `face`. There are NO wilds: a 1 only counts
//     as a 1.
//   - A raise must strictly out-rank the current bid: a higher quantity, or
//     the same quantity with a higher face.
//   - CHALLENGE: reveal all dice and count the bid face.
//       * actual >= quantity  -> the bid was good, the challenger loses a die.
//       * actual <  quantity  -> the bid was a lie, the bidder loses a die.
//   - SPOT-ON: the caller claims the count is EXACTLY the bid quantity.
//       * actual == quantity  -> caller is right, every OTHER active player
//         loses a die.
//       * actual != quantity  -> caller is wrong, the caller loses a die.
//   - A player with 0 dice is eliminated. Last player standing wins.
//
// The engine is deterministic given an injected RNG, which keeps it testable.

export const STARTING_DICE = 5;
export const DICE_FACES = 6;

const defaultRng = () => Math.random();

function rollDie(rng) {
  return 1 + Math.floor(rng() * DICE_FACES);
}

export class Game {
  /**
   * @param {Array<{id: string, name: string}>} players seating order
   * @param {() => number} [rng] returns a float in [0, 1)
   */
  constructor(players, rng = defaultRng) {
    if (players.length < 2) {
      throw new Error('Need at least 2 players to start.');
    }
    this.rng = rng;
    this.players = players.map((p) => ({
      id: p.id,
      name: p.name,
      dice: [],
      diceCount: STARTING_DICE,
      eliminated: false,
      lastBid: null, // this player's current standing bid, cleared each round
    }));
    this.phase = 'playing'; // 'playing' | 'reveal' | 'gameover'
    this.currentBid = null; // { playerId, quantity, face }
    this.turnId = this.players[0].id;
    this.roundNumber = 0;
    this.lastReveal = null; // populated after a challenge / spot-on
    this.winnerId = null;
    this.startRound(this.players[0].id);
  }

  // --- helpers -------------------------------------------------------------

  activePlayers() {
    return this.players.filter((p) => !p.eliminated);
  }

  getPlayer(playerId) {
    return this.players.find((p) => p.id === playerId) || null;
  }

  totalDiceInPlay() {
    return this.activePlayers().reduce((sum, p) => sum + p.diceCount, 0);
  }

  /** Index into `players` of the next non-eliminated player after `playerId`. */
  nextActiveId(playerId) {
    const n = this.players.length;
    const start = this.players.findIndex((p) => p.id === playerId);
    for (let step = 1; step <= n; step++) {
      const cand = this.players[(start + step) % n];
      if (!cand.eliminated) return cand.id;
    }
    return playerId;
  }

  // --- round lifecycle -----------------------------------------------------

  /** Roll fresh dice for every active player and open a new bidding round. */
  startRound(firstPlayerId) {
    this.roundNumber += 1;
    for (const p of this.players) {
      p.lastBid = null; // a new round wipes everyone's standing bid
      if (p.eliminated) {
        p.dice = [];
        continue;
      }
      p.dice = Array.from({ length: p.diceCount }, () => rollDie(this.rng));
    }
    this.currentBid = null;
    this.phase = 'playing';
    const starter = this.getPlayer(firstPlayerId);
    this.turnId =
      starter && !starter.eliminated ? firstPlayerId : this.nextActiveId(firstPlayerId);
  }

  // --- actions -------------------------------------------------------------

  /**
   * Place or raise a bid. Throws on any illegal move.
   * @returns {object} a small event describing what happened
   */
  bid(playerId, quantity, face) {
    this.assertTurn(playerId);
    quantity = Number(quantity);
    face = Number(face);
    if (!Number.isInteger(quantity) || !Number.isInteger(face)) {
      throw new Error('Bid must use whole numbers.');
    }
    if (face < 1 || face > DICE_FACES) {
      throw new Error(`Face must be between 1 and ${DICE_FACES}.`);
    }
    if (quantity < 1) {
      throw new Error('Quantity must be at least 1.');
    }
    if (quantity > this.totalDiceInPlay()) {
      throw new Error('Quantity exceeds the number of dice in play.');
    }
    if (this.currentBid && !this.outranks(quantity, face, this.currentBid)) {
      throw new Error('Your bid must be higher than the current bid.');
    }

    this.currentBid = { playerId, quantity, face };
    this.getPlayer(playerId).lastBid = { quantity, face }; // overwrite their chip
    this.turnId = this.nextActiveId(playerId);
    return { type: 'bid', playerId, quantity, face };
  }

  /** Does (quantity, face) strictly out-rank the existing bid? */
  outranks(quantity, face, bid) {
    if (quantity > bid.quantity) return true;
    if (quantity === bid.quantity && face > bid.face) return true;
    return false;
  }

  /** Count how many dice across all active players show `face`. No wilds. */
  countFace(face) {
    let count = 0;
    for (const p of this.activePlayers()) {
      for (const d of p.dice) {
        if (d === face) count += 1;
      }
    }
    return count;
  }

  /** Challenge the current bid ("liar!"). */
  challenge(playerId) {
    this.assertTurn(playerId);
    if (!this.currentBid) {
      throw new Error('There is no bid to challenge.');
    }
    const { quantity, face, playerId: bidderId } = this.currentBid;
    const actual = this.countFace(face);
    const bidWasGood = actual >= quantity;
    const loserId = bidWasGood ? playerId : bidderId;
    return this.resolveReveal({
      kind: 'challenge',
      callerId: playerId,
      bidderId,
      quantity,
      face,
      actual,
      losers: [loserId],
    });
  }

  /** Call spot-on / exact on the current bid. */
  spotOn(playerId) {
    this.assertTurn(playerId);
    if (!this.currentBid) {
      throw new Error('There is no bid to call spot-on.');
    }
    const { quantity, face, playerId: bidderId } = this.currentBid;
    const actual = this.countFace(face);
    const exact = actual === quantity;
    // Right: every other active player loses a die. Wrong: caller loses a die.
    const losers = exact
      ? this.activePlayers().filter((p) => p.id !== playerId).map((p) => p.id)
      : [playerId];
    return this.resolveReveal({
      kind: 'spot-on',
      callerId: playerId,
      bidderId,
      quantity,
      face,
      actual,
      exact,
      losers,
    });
  }

  // --- reveal / scoring ----------------------------------------------------

  resolveReveal(reveal) {
    // Snapshot every active player's dice for the reveal display.
    reveal.dice = this.activePlayers().map((p) => ({
      id: p.id,
      name: p.name,
      dice: [...p.dice],
    }));

    // Apply losses.
    for (const loserId of reveal.losers) {
      const loser = this.getPlayer(loserId);
      if (!loser || loser.eliminated) continue;
      loser.diceCount -= 1;
      if (loser.diceCount <= 0) {
        loser.diceCount = 0;
        loser.eliminated = true;
      }
    }

    this.lastReveal = reveal;
    this.phase = 'reveal';

    const remaining = this.activePlayers();
    if (remaining.length <= 1) {
      this.phase = 'gameover';
      this.winnerId = remaining.length === 1 ? remaining[0].id : null;
      reveal.gameOver = true;
      reveal.winnerId = this.winnerId;
    } else {
      // The next round is started explicitly via `nextRound`, so the UI can
      // show the reveal first. Decide who starts: the (first) surviving loser,
      // otherwise the next active player after them.
      const firstLoser = this.getPlayer(reveal.losers[0]);
      reveal.nextStarterId =
        firstLoser && !firstLoser.eliminated
          ? firstLoser.id
          : this.nextActiveId(reveal.losers[0]);
    }
    return { type: 'reveal', ...reveal };
  }

  /** Advance from the reveal phase into a fresh round. */
  nextRound() {
    if (this.phase !== 'reveal') {
      throw new Error('Not waiting to start a new round.');
    }
    this.startRound(this.lastReveal.nextStarterId);
    return { type: 'round-start', roundNumber: this.roundNumber };
  }

  // --- guards --------------------------------------------------------------

  assertTurn(playerId) {
    if (this.phase !== 'playing') {
      throw new Error('No action can be taken right now.');
    }
    const player = this.getPlayer(playerId);
    if (!player || player.eliminated) {
      throw new Error('You are not in this round.');
    }
    if (this.turnId !== playerId) {
      throw new Error('It is not your turn.');
    }
  }

  // --- serialization -------------------------------------------------------

  /**
   * State for a specific viewer. Other players' dice are hidden during play
   * and only revealed during the 'reveal' / 'gameover' phases.
   * @param {string|null} viewerId
   */
  toView(viewerId) {
    const reveal = this.phase === 'reveal' || this.phase === 'gameover';
    return {
      phase: this.phase,
      roundNumber: this.roundNumber,
      currentBid: this.currentBid,
      turnId: this.turnId,
      winnerId: this.winnerId,
      totalDice: this.totalDiceInPlay(),
      lastReveal: this.lastReveal,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        diceCount: p.diceCount,
        eliminated: p.eliminated,
        lastBid: p.lastBid,
        isYou: p.id === viewerId,
        // Reveal your own dice always; everyone else's only at reveal time.
        dice: p.id === viewerId || reveal ? [...p.dice] : null,
      })),
    };
  }
}
