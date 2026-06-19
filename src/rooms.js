// In-memory room registry. A room holds a lobby of players and, once started,
// a running Game. Rooms live only in memory, so a server restart clears them.
//
// Each member has a public seat `id` (used by the game, shown to everyone) and
// a private `token` supplied by the client. The token lets a player reclaim
// their seat after a refresh or dropped connection; it is never sent to others.

import { randomUUID } from 'node:crypto';
import {
  Game,
  STARTING_DICE,
  clampStartingDice,
  RULESETS,
  DEFAULT_RULESET,
  listRulesets,
} from './game.js';

export const MAX_PLAYERS = 11; // host + up to 10 others (humans and/or bots)

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no easily-confused chars

// Names handed to bots, in order, skipping any already taken in the room.
const BOT_NAMES = [
  'Botworth',
  'Sir Bluffsalot',
  'Dicey McBotface',
  'The Calculator',
  'Cogsworth',
  'Rusty',
  'Marvin',
  'Clatter',
  'Tincup',
  'Ada',
];

export class RoomManager {
  constructor() {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
  }

  createRoom() {
    let code;
    do {
      code = this.generateCode();
    } while (this.rooms.has(code));
    const room = new Room(code);
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get((code || '').toUpperCase()) || null;
  }

  deleteRoom(code) {
    this.rooms.delete(code);
  }

  generateCode(length = 4) {
    let out = '';
    for (let i = 0; i < length; i++) {
      out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return out;
  }
}

export class Room {
  constructor(code) {
    this.code = code;
    /** @type {Map<string, {id, token, name, connected, isHost, socketId}>} keyed by seat id */
    this.members = new Map();
    this.hostId = null;
    this.game = null;
    this.botTimer = null; // pending scheduled bot move / reveal advance (server-side)
    this.messages = []; // recent chat messages (capped); in-memory, dies with the room
    this._msgId = 0;
    // Host-configurable room options, applied when a game is started.
    this.settings = {
      startingDice: STARTING_DICE,
      showProbability: false,
      ruleset: DEFAULT_RULESET,
    };
  }

  /** Apply a partial settings update from the host, validating each field. */
  updateSettings(partial = {}) {
    if (partial.startingDice !== undefined) {
      this.settings.startingDice = clampStartingDice(partial.startingDice);
    }
    if (partial.showProbability !== undefined) {
      this.settings.showProbability = !!partial.showProbability;
    }
    if (partial.ruleset !== undefined && RULESETS[partial.ruleset]) {
      this.settings.ruleset = partial.ruleset;
    }
    return this.settings;
  }

  get size() {
    return this.members.size;
  }

  // Empty once no *human* is connected — bots alone don't keep a room alive.
  isEmpty() {
    return ![...this.members.values()].some((m) => !m.isBot && m.connected);
  }

  addMember(token, name, socketId) {
    const id = randomUUID(); // public seat id
    const isHost = this.members.size === 0;
    const member = { id, token: token || null, name, connected: true, isHost, isBot: false, socketId };
    this.members.set(id, member);
    if (isHost) this.hostId = id;
    return member;
  }

  /** Add a computer player (a member with no socket). */
  addBot() {
    const taken = new Set([...this.members.values()].map((m) => m.name));
    const name = BOT_NAMES.find((n) => !taken.has(n)) || `Bot ${this.members.size}`;
    const member = {
      id: randomUUID(),
      token: null,
      name,
      connected: true,
      isHost: false,
      isBot: true,
      // Hidden per-bot competence: ~0.35–1, so bots vary but none are pushovers.
      skill: 0.35 + Math.random() * 0.65,
      socketId: null,
    };
    this.members.set(member.id, member);
    return member;
  }

  /** Remove the most recently added bot (used by the host's "remove bot"). */
  removeLastBot() {
    const bots = [...this.members.values()].filter((m) => m.isBot);
    const last = bots[bots.length - 1];
    if (last) this.members.delete(last.id);
    return last || null;
  }

  /** Append a chat message, keeping only the most recent 50. */
  addMessage(name, text, seatId) {
    const msg = { id: ++this._msgId, seatId, name, text, ts: Date.now() };
    this.messages.push(msg);
    if (this.messages.length > 50) this.messages.shift();
    return msg;
  }

  /** Find a member by its private reclaim token (null tokens never match). */
  findByToken(token) {
    if (!token) return null;
    for (const m of this.members.values()) {
      if (m.token === token) return m;
    }
    return null;
  }

  /** Reattach an existing member to a new socket (reconnection). */
  reclaim(member, socketId, name) {
    member.socketId = socketId;
    member.connected = true;
    if (name) member.name = name;
    return member;
  }

  removeMember(id) {
    this.members.delete(id);
    if (id === this.hostId) {
      const next = [...this.members.values()].find((m) => m.connected && !m.isBot);
      this.hostId = next ? next.id : null;
      if (next) next.isHost = true;
    }
  }

  startGame() {
    const seating = [...this.members.values()].map((m) => ({ id: m.id, name: m.name }));
    this.game = new Game(seating, undefined, this.settings.startingDice, this.settings.ruleset);
    return this.game;
  }

  /** Lobby + (optional) per-viewer game state, ready to send to a client. */
  toView(viewerId) {
    return {
      code: this.code,
      hostId: this.hostId,
      settings: this.settings,
      rulesets: listRulesets(),
      members: [...this.members.values()].map((m) => ({
        id: m.id,
        name: m.name,
        connected: m.connected,
        isHost: m.id === this.hostId,
        isBot: !!m.isBot,
        isYou: m.id === viewerId,
      })),
      game: this.game ? this.game.toView(viewerId) : null,
    };
  }
}
