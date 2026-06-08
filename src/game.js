// Pure game engine for Liar's Dice.
//
// Core flow (shared by every ruleset):
//   - Each player starts with the same number of dice (configurable, 1..20).
//   - On a player's turn they may either RAISE the current bid or, if a bid
//     already exists, CHALLENGE it ("liar") or call SPOT-ON ("exact").
//   - A bid is a (quantity, face) pair claiming that AT LEAST `quantity` dice
//     across the whole table satisfy `face`. A raise must strictly out-rank the
//     current bid: a higher quantity, or the same quantity with a higher face.
//   - CHALLENGE: reveal all dice and count the bid face.
//       * actual >= quantity  -> the bid was good, the challenger loses a die.
//       * actual <  quantity  -> the bid was a lie, the bidder loses a die.
//   - A wrong SPOT-ON always costs the caller a die.
//   - A player with 0 dice is eliminated. Last player standing wins.
//
// Rulesets (see RULESETS) vary two things:
//   - wilds:        whether 1s count toward any non-1 face when counting.
//   - spotOnReward: what a correct Spot-on does — every other player loses a
//                   die ('others-lose'), or the caller wins one back
//                   ('caller-regains').
//
// The engine is deterministic given an injected RNG, which keeps it testable.

export const STARTING_DICE = 5;
export const MAX_STARTING_DICE = 20;
export const DICE_FACES = 6;

const defaultRng = () => Math.random();

function rollDie(rng) {
  return 1 + Math.floor(rng() * DICE_FACES);
}

/** Coerce to a whole number of starting dice within the allowed range. */
export function clampStartingDice(n) {
  n = Math.round(Number(n));
  if (!Number.isFinite(n)) return STARTING_DICE;
  return Math.max(1, Math.min(MAX_STARTING_DICE, n));
}

// Selectable rulesets. They vary on two independent dimensions:
//   - wilds: whether 1s count as every face when a bid is counted.
//   - spotOnReward: what a correct Spot-on call does —
//       'others-lose'    -> every other active player loses a die.
//       'caller-regains' -> the caller wins a die back (up to the start count).
// (A wrong Spot-on always costs the caller a die.)
export const RULESETS = {
  'common-hand': {
    id: 'common-hand',
    name: 'Common Hand',
    desc: '1s count only as 1s. Exact Spot-on → everyone else loses a die.',
    wilds: false,
    spotOnReward: 'others-lose',
  },
  'aces-wild': {
    id: 'aces-wild',
    name: 'Aces Wild',
    desc: '1s are wild and count as every face. Exact Spot-on → everyone else loses a die.',
    wilds: true,
    spotOnReward: 'others-lose',
  },
  'spot-regain': {
    id: 'spot-regain',
    name: 'Spot-on regains a die',
    desc: 'No wilds. A correct Spot-on wins the caller a die back instead.',
    wilds: false,
    spotOnReward: 'caller-regains',
  },
};

export const DEFAULT_RULESET = 'common-hand';

/** Resolve a ruleset id to its config, falling back to the default. */
export function resolveRuleset(id) {
  return RULESETS[id] || RULESETS[DEFAULT_RULESET];
}

/** The rulesets a lobby can offer, as lightweight {id, name, desc} entries. */
export function listRulesets() {
  return Object.values(RULESETS).map(({ id, name, desc }) => ({ id, name, desc }));
}

export class Game {
  /**
   * @param {Array<{id: string, name: string}>} players seating order
   * @param {() => number} [rng] returns a float in [0, 1)
   * @param {number} [startingDice] dice each player begins with (1..20)
   * @param {string} [rulesetId] which ruleset to play (see RULESETS)
   */
  constructor(players, rng = defaultRng, startingDice = STARTING_DICE, rulesetId = DEFAULT_RULESET) {
    if (players.length < 2) {
      throw new Error('Need at least 2 players to start.');
    }
    this.rng = rng;
    this.startingDice = clampStartingDice(startingDice);
    this.ruleset = resolveRuleset(rulesetId);
    this.players = players.map((p) => ({
      id: p.id,
      name: p.name,
      dice: [],
      diceCount: this.startingDice,
      eliminated: false,
      lastBid: null, // this player's current standing bid, cleared each round
    }));
    this.phase = 'playing'; // 'playing' | 'reveal' | 'gameover'
    this.currentBid = null; // { playerId, quantity, face }
    this.turnId = this.players[0].id;
    this.roundStarterId = null; // who opened the current round (set in startRound)
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
    this.roundStarterId = this.turnId; // remember the opener for seat rotation
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

  /** Whether 1s count toward a bid on `face` (wild), given the ruleset. */
  wildsApply(face) {
    return this.ruleset.wilds && face !== 1;
  }

  /**
   * Count dice across all active players that satisfy a bid on `face`. With a
   * wilds ruleset, 1s also count toward any non-1 face (a 1 bid counts only 1s).
   */
  countFace(face) {
    const wild = this.wildsApply(face);
    let count = 0;
    for (const p of this.activePlayers()) {
      for (const d of p.dice) {
        if (d === face || (wild && d === 1)) count += 1;
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
      countsWild: this.wildsApply(face),
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

    const reveal = {
      kind: 'spot-on',
      callerId: playerId,
      bidderId,
      quantity,
      face,
      actual,
      exact,
      countsWild: this.wildsApply(face),
      reward: this.ruleset.spotOnReward,
      losers: [],
    };
    if (!exact) {
      // A wrong call always costs the caller a die, regardless of ruleset.
      reveal.losers = [playerId];
    } else if (this.ruleset.spotOnReward === 'caller-regains') {
      // The caller wins a die back (capped at the starting count); nobody loses.
      reveal.gainerId = playerId;
    } else {
      // Default: every other active player loses a die.
      reveal.losers = this.activePlayers().filter((p) => p.id !== playerId).map((p) => p.id);
    }
    return this.resolveReveal(reveal);
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

    // Apply a die gain (Spot-on regains), capped at the starting count.
    if (reveal.gainerId) {
      const gainer = this.getPlayer(reveal.gainerId);
      if (gainer && !gainer.eliminated && gainer.diceCount < this.startingDice) {
        gainer.diceCount += 1;
      } else {
        reveal.gainerCapped = true; // already at max — no die changed hands
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
      // show the reveal first. The opener advances exactly one seat each round:
      // the next active player after whoever opened the round that just ended
      // (independent of who called or who lost a die).
      reveal.nextStarterId = this.nextActiveId(this.roundStarterId);
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
      ruleset: {
        id: this.ruleset.id,
        name: this.ruleset.name,
        wilds: this.ruleset.wilds,
        spotOnReward: this.ruleset.spotOnReward,
      },
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
