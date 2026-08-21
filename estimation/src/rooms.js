// In-memory room registry. A room holds a lobby of players and, once started,
// a running Game. Rooms live only in memory, so a server restart clears them.
//
// Each member has a public seat `id` (used by the game, shown to everyone) and
// a private `token` supplied by the client. The token lets a player reclaim
// their seat after a refresh or dropped connection; it is never sent to others.

import { randomUUID } from 'node:crypto';
import { Game, MIN_PLAYERS, MAX_PLAYERS, DEFAULT_CYCLES, clampCycles } from './game.js';

export { MIN_PLAYERS, MAX_PLAYERS };

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
    /** @type {Map<string, {id, token, name, connected, isHost, socketId}>} keyed by seat id */
    this.members = new Map();
    this.hostId = null;
    this.game = null;
    this.timer = null; // pending scheduled trick-sweep / round-advance / AFK move (server-side)
    this.messages = []; // recent chat messages (capped); in-memory, dies with the room
    this._msgId = 0;
    // Host-configurable room options, applied when a game is started.
    this.settings = {
      cycles: DEFAULT_CYCLES,
    };
  }

  /** Apply a partial settings update from the host, validating each field. */
  updateSettings(partial = {}) {
    if (partial.cycles !== undefined) {
      this.settings.cycles = clampCycles(partial.cycles);
    }
    return this.settings;
  }

  get size() {
    return this.members.size;
  }

  // Empty once no human is connected.
  isEmpty() {
    return ![...this.members.values()].some((m) => m.connected);
  }

  addMember(token, name, socketId) {
    const id = randomUUID(); // public seat id
    const isHost = this.members.size === 0;
    const member = { id, token: token || null, name, connected: true, isHost, socketId };
    this.members.set(id, member);
    if (isHost) this.hostId = id;
    return member;
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
      const next = [...this.members.values()].find((m) => m.connected);
      this.hostId = next ? next.id : null;
      if (next) next.isHost = true;
    }
  }

  startGame() {
    const seating = [...this.members.values()].map((m) => ({ id: m.id, name: m.name }));
    this.game = new Game(seating, undefined, this.settings.cycles);
    return this.game;
  }

  /** Lobby + (optional) per-viewer game state, ready to send to a client. */
  toView(viewerId) {
    return {
      code: this.code,
      hostId: this.hostId,
      settings: this.settings,
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
