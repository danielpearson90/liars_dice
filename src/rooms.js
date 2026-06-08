// In-memory room registry. A room holds a lobby of players and, once started,
// a running Game. Rooms live only in memory, so a server restart clears them.

import {
  Game,
  STARTING_DICE,
  clampStartingDice,
  RULESETS,
  DEFAULT_RULESET,
  listRulesets,
} from './game.js';

export const MAX_PLAYERS = 11; // host + up to 10 friends

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no easily-confused chars

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
    /** @type {Map<string, {id: string, name: string, connected: boolean, isHost: boolean}>} */
    this.members = new Map();
    this.hostId = null;
    this.game = null;
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

  isEmpty() {
    return [...this.members.values()].every((m) => !m.connected);
  }

  addMember(id, name) {
    const isHost = this.members.size === 0;
    const member = { id, name, connected: true, isHost };
    this.members.set(id, member);
    if (isHost) this.hostId = id;
    return member;
  }

  removeMember(id) {
    this.members.delete(id);
    if (id === this.hostId) {
      const next = [...this.members.values()].find((m) => m.connected);
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
        isYou: m.id === viewerId,
      })),
      game: this.game ? this.game.toView(viewerId) : null,
    };
  }
}
