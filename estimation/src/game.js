// Pure game engine for Estimation (speed-round variant).
//
// Core flow:
//   - Hands grow: 5 cards each in round 1, one more every round after, until
//     the deck can't go round again (13 cards, or 10 at a 5-player table).
//     Whatever isn't dealt sits face-down, out of play for that round.
//   - Trump follows a fixed cycle (No-trump, Spades, Hearts, Diamonds, Clubs)
//     — there is no auction. Rounds = cycles * 5.
//   - Each round: every player ESTIMATES how many tricks they'll take, in
//     seat order starting to the dealer's left; the dealer estimates last and
//     may not name the one number that would make all estimates sum to the
//     hand size (the "risk" seat).
//   - Then the hand is PLAYED trick by trick: must follow suit if able,
//     highest trump (or, lacking any trump play, highest of the led suit)
//     wins. Winner leads next. A completed trick sits on the table until the
//     server sweeps it (a deliberate pause so a UI can show it).
//   - Once every hand is empty the round is SCORED: 1 point per trick won,
//     plus a 10-point bonus for an exact estimate. Scores never go down.
//   - After the last round, highest total score wins (ties share the win).
//
// The engine is deterministic given an injected RNG, which keeps it testable.

export const SUITS = ['S', 'H', 'D', 'C']; // ♠ ♥ ♦ ♣
export const TRUMP_CYCLE = ['NT', 'S', 'H', 'D', 'C'];
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 5;
export const MIN_CYCLES = 1;
export const MAX_CYCLES = 3;
export const DEFAULT_CYCLES = 2;

const defaultRng = () => Math.random();

/** Coerce to a whole number of cycles within the allowed range. */
export function clampCycles(n) {
  n = Math.round(Number(n));
  if (!Number.isFinite(n)) return DEFAULT_CYCLES;
  return Math.max(MIN_CYCLES, Math.min(MAX_CYCLES, n));
}

/** Cards each player holds in the first round; hands grow from here. */
export const STARTING_HAND = 5;

/**
 * The largest hand this table can be dealt: a full 13-card hand, or less when
 * the deck can't go round that many times.
 */
export function maxHandFor(playerCount) {
  return Math.min(13, Math.floor(52 / playerCount));
}

/**
 * Hands start at 5 cards and grow by one each round, stopping once the deck
 * runs out — at 5 players that's 10 cards, otherwise 13.
 */
export function handSizeForRound(playerCount, roundIndex) {
  return Math.min(STARTING_HAND + roundIndex, maxHandFor(playerCount));
}

/** Stable string id for a card, e.g. rank 14 of spades -> '14S'. */
export function cardId(card) {
  return `${card.rank}${card.suit}`;
}

function buildDeck() {
  const deck = [];
  for (let rank = 2; rank <= 14; rank++) {
    for (const suit of SUITS) deck.push({ rank, suit });
  }
  return deck;
}

/** Fisher-Yates shuffle, driven by the injected RNG (does not mutate `deck`). */
function shuffle(deck, rng) {
  const out = deck.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Who wins a completed trick. Highest trump wins if any trump was played;
 * otherwise the highest card of the led suit wins (this also covers No-trump
 * rounds, since `trump` is never a real suit there).
 * @param {Array<{playerId: string, card: {rank: number, suit: string}}>} plays
 * @param {string} leadSuit
 * @param {string} trump 'NT' | 'S' | 'H' | 'D' | 'C'
 * @returns {string} the winning playerId
 */
export function trickWinner(plays, leadSuit, trump) {
  const trumpPlays = trump !== 'NT' ? plays.filter((p) => p.card.suit === trump) : [];
  const pool = trumpPlays.length ? trumpPlays : plays.filter((p) => p.card.suit === leadSuit);
  return pool.reduce((best, p) => (p.card.rank > best.card.rank ? p : best)).playerId;
}

export class Game {
  /**
   * @param {Array<{id: string, name: string}>} players seating order
   * @param {() => number} [rng] returns a float in [0, 1)
   * @param {number} [cycles] how many trump cycles to play (1..3)
   */
  constructor(players, rng = defaultRng, cycles = DEFAULT_CYCLES) {
    if (!players || players.length < MIN_PLAYERS) {
      throw new Error(`Need at least ${MIN_PLAYERS} players to start.`);
    }
    if (players.length > MAX_PLAYERS) {
      throw new Error(`No more than ${MAX_PLAYERS} players.`);
    }
    this.rng = rng;
    this.cycles = clampCycles(cycles);
    this.totalRounds = this.cycles * TRUMP_CYCLE.length;
    this.players = players.map((p) => ({ id: p.id, name: p.name }));
    this.scores = new Map(this.players.map((p) => [p.id, 0]));
    this.history = []; // per-round summaries: { trump, rows: [...] }
    this.standings = null;
    this.startRound(0);
  }

  // --- helpers -------------------------------------------------------------

  getPlayer(playerId) {
    return this.players.find((p) => p.id === playerId) || null;
  }

  /** The seat right after `playerId`, wrapping around (no eliminations here). */
  nextSeatId(playerId) {
    const n = this.players.length;
    const idx = this.players.findIndex((p) => p.id === playerId);
    return this.players[(idx + 1) % n].id;
  }

  // --- round lifecycle -------------------------------------------------------

  /** Deal a fresh round and open estimation. */
  startRound(roundIndex) {
    const n = this.players.length;
    this.roundIndex = roundIndex;
    this.trump = TRUMP_CYCLE[roundIndex % TRUMP_CYCLE.length];
    const dealerIdx = roundIndex % n;
    this.dealerId = this.players[dealerIdx].id;
    this.handSize = handSizeForRound(n, roundIndex);

    const deck = shuffle(buildDeck(), this.rng);
    this.dealtOut = 52 - this.handSize * n;
    this.hands = new Map();
    for (let i = 0; i < n; i++) {
      const hand = deck.slice(i * this.handSize, (i + 1) * this.handSize);
      hand.sort((a, b) =>
        a.suit === b.suit ? a.rank - b.rank : SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit)
      );
      this.hands.set(this.players[i].id, hand);
    }

    this.estimates = new Map(this.players.map((p) => [p.id, null]));
    this.tricksWon = new Map(this.players.map((p) => [p.id, 0]));
    this.trick = { leadSuit: null, plays: [], winnerId: null };

    // Estimation order: seat after the dealer, all the way around, dealer last.
    this.estimateOrder = [];
    for (let step = 1; step <= n; step++) {
      this.estimateOrder.push(this.players[(dealerIdx + step) % n].id);
    }

    this.turnId = this.estimateOrder[0];
    this.phase = 'estimating';
    this.readyIds = new Set();
  }

  // --- actions ---------------------------------------------------------------

  /** Name how many tricks you expect to take this round. Throws on any illegal call. */
  estimate(playerId, n) {
    if (this.phase !== 'estimating') {
      throw new Error('No action can be taken right now.');
    }
    if (this.turnId !== playerId) {
      throw new Error('It is not your turn.');
    }
    n = Number(n);
    if (!Number.isInteger(n) || n < 0 || n > this.handSize) {
      throw new Error(`Estimate must be a whole number between 0 and ${this.handSize}.`);
    }

    const isLastEstimator = playerId === this.estimateOrder[this.estimateOrder.length - 1];
    if (isLastEstimator) {
      const sumOthers = [...this.estimates.values()].reduce((sum, v) => sum + (v || 0), 0);
      if (sumOthers + n === this.handSize) {
        throw new Error(
          `The estimates can't add up to ${this.handSize} — pick another number.`
        );
      }
    }

    this.estimates.set(playerId, n);
    if (isLastEstimator) {
      this.phase = 'playing';
      this.turnId = this.estimateOrder[0]; // dealer's left leads the first trick
    } else {
      const idx = this.estimateOrder.indexOf(playerId);
      this.turnId = this.estimateOrder[idx + 1];
    }
    return { type: 'estimate', playerId, estimate: n };
  }

  /** The cards `playerId` may legally play right now (empty when it isn't their turn). */
  legalCardIdsFor(playerId) {
    if (this.phase !== 'playing' || this.turnId !== playerId || this.trick.winnerId !== null) {
      return [];
    }
    const hand = this.hands.get(playerId) || [];
    if (this.trick.plays.length === 0) return hand.map(cardId); // leading: anything goes
    const holdsLead = hand.filter((c) => c.suit === this.trick.leadSuit);
    return (holdsLead.length ? holdsLead : hand).map(cardId);
  }

  /** Play a card from your hand. Throws on any illegal move. */
  playCard(playerId, id) {
    if (this.phase !== 'playing') {
      throw new Error('No action can be taken right now.');
    }
    if (this.trick.winnerId !== null) {
      throw new Error('Wait for the trick to clear.');
    }
    if (this.turnId !== playerId) {
      throw new Error('It is not your turn.');
    }
    const hand = this.hands.get(playerId) || [];
    const idx = hand.findIndex((c) => cardId(c) === id);
    if (idx === -1) {
      throw new Error('That card is not in your hand.');
    }
    const card = hand[idx];
    if (this.trick.plays.length > 0) {
      const holdsLead = hand.some((c) => c.suit === this.trick.leadSuit);
      if (holdsLead && card.suit !== this.trick.leadSuit) {
        throw new Error('You must follow suit.');
      }
    }

    hand.splice(idx, 1);
    this.trick.plays.push({ playerId, card });
    if (this.trick.plays.length === 1) this.trick.leadSuit = card.suit;

    if (this.trick.plays.length === this.players.length) {
      const winnerId = trickWinner(this.trick.plays, this.trick.leadSuit, this.trump);
      this.trick.winnerId = winnerId;
      this.tricksWon.set(winnerId, (this.tricksWon.get(winnerId) || 0) + 1);
    } else {
      this.turnId = this.nextSeatId(playerId);
    }
    return { type: 'play', playerId, card };
  }

  /** Clear a completed trick and start the next one (or end the round). No-op if nothing is pending. */
  sweepTrick() {
    if (this.trick.winnerId === null) return null;
    const winnerId = this.trick.winnerId;
    this.turnId = winnerId;
    this.trick = { leadSuit: null, plays: [], winnerId: null };

    const handsEmpty = [...this.hands.values()].every((h) => h.length === 0);
    if (handsEmpty) {
      this.scoreRound();
      this.readyIds = new Set();
      this.phase = 'roundEnd';
    }
    return { type: 'sweep', turnId: this.turnId, phase: this.phase };
  }

  scoreRound() {
    const rows = [];
    for (const p of this.players) {
      const estimate = this.estimates.get(p.id) ?? 0;
      const tricksWon = this.tricksWon.get(p.id) || 0;
      const delta = tricksWon + (estimate === tricksWon ? 10 : 0);
      const score = (this.scores.get(p.id) || 0) + delta;
      this.scores.set(p.id, score);
      rows.push({ playerId: p.id, estimate, tricksWon, delta, score });
    }
    this.history.push({ trump: this.trump, rows });
  }

  /** Advance from a round-end summary into the next round, or game over. */
  nextRound() {
    if (this.phase !== 'roundEnd') {
      throw new Error('Not waiting to start a new round.');
    }
    if (this.roundIndex + 1 >= this.totalRounds) {
      this.phase = 'gameover';
      this.standings = this.computeStandings();
      return { type: 'gameover', standings: this.standings };
    }
    this.startRound(this.roundIndex + 1);
    return { type: 'round-start', roundIndex: this.roundIndex };
  }

  /** Sorted final standings, sharing a rank across tied scores. */
  computeStandings() {
    const sorted = this.players
      .map((p) => ({ id: p.id, name: p.name, score: this.scores.get(p.id) || 0 }))
      .sort((a, b) => b.score - a.score);
    let rank = 0;
    let prevScore = null;
    return sorted.map((p, i) => {
      if (p.score !== prevScore) {
        rank = i + 1;
        prevScore = p.score;
      }
      return { ...p, rank };
    });
  }

  /** Record (or clear) a player's "ready to continue" vote during round-end. */
  markReady(playerId, ready) {
    if (this.phase !== 'roundEnd') return;
    if (ready) this.readyIds.add(playerId);
    else this.readyIds.delete(playerId);
  }

  // --- serialization -----------------------------------------------------------

  /**
   * State for a specific viewer. Only the viewer's own hand is ever included;
   * everyone else's hand is always hidden (unlike a reveal-based game, hands
   * are never shown to opponents in Estimation).
   * @param {string|null} viewerId
   */
  toView(viewerId) {
    let forbiddenEstimate = null;
    if (this.phase === 'estimating') {
      const lastEstimatorId = this.estimateOrder[this.estimateOrder.length - 1];
      if (this.turnId === lastEstimatorId) {
        const sumOthers = [...this.estimates.values()].reduce((sum, v) => sum + (v || 0), 0);
        const forbidden = this.handSize - sumOthers;
        if (forbidden >= 0 && forbidden <= this.handSize) forbiddenEstimate = forbidden;
      }
    }

    const hand = this.hands.get(viewerId) || [];
    return {
      phase: this.phase,
      cycles: this.cycles,
      totalRounds: this.totalRounds,
      round: {
        index: this.roundIndex,
        number: this.roundIndex + 1,
        trump: this.trump,
        dealerId: this.dealerId,
        handSize: this.handSize,
        dealtOut: this.dealtOut,
      },
      turnId: this.turnId,
      estimateOrder: [...this.estimateOrder],
      forbiddenEstimate,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        isDealer: p.id === this.dealerId,
        isYou: p.id === viewerId,
        estimate: this.estimates.get(p.id) ?? null,
        tricksWon: this.tricksWon.get(p.id) || 0,
        score: this.scores.get(p.id) || 0,
        handCount: (this.hands.get(p.id) || []).length,
      })),
      hand: hand.map((c) => ({ id: cardId(c), rank: c.rank, suit: c.suit })),
      legalCardIds: this.legalCardIdsFor(viewerId),
      trick: {
        leadSuit: this.trick.leadSuit,
        plays: this.trick.plays.map((pl) => ({
          playerId: pl.playerId,
          card: { id: cardId(pl.card), rank: pl.card.rank, suit: pl.card.suit },
        })),
        winnerId: this.trick.winnerId,
      },
      roundSummary: this.phase === 'roundEnd' ? this.history[this.history.length - 1] : null,
      readyIds: [...this.readyIds],
      standings: this.phase === 'gameover' ? this.standings : null,
    };
  }
}
