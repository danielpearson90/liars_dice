// HTTP + WebSocket server wiring Express (static client) to Socket.IO (realtime
// game events). All game logic lives in src/game.js; this file only translates
// socket messages into engine calls and broadcasts the resulting state.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { RoomManager, MIN_PLAYERS, MAX_PLAYERS } from './src/rooms.js';
import { REACTIONS } from './public/reactions.js';

const REACTION_SET = new Set(REACTIONS);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// All three timers are read at schedule time, so tests can shrink them via env.
// How long a completed trick stays on the table before it's swept.
const trickPauseMs = () => Number(process.env.TRICK_PAUSE_MS) || 2000;
// Round-summary auto-advance backstop, exactly like the dice reveal timeout.
const roundTimeoutMs = () => Number(process.env.ROUND_TIMEOUT_MS) || 15000;
// If it's a *disconnected* player's turn this long, the server acts for them.
const afkMs = () => Number(process.env.AFK_MS) || 25000;

export function createServer() {
const app = express();
// `no-cache` = always revalidate (via ETag), so a client never runs a stale
// index.html/client.js pair after an update.
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-cache');
    },
  })
);
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server);
const rooms = new RoomManager();

// Map each live socket to its room code and seat id, for routing and cleanup.
/** @type {Map<string, {code: string, id: string}>} */
const socketInfo = new Map();

function broadcastRoom(room) {
  for (const member of room.members.values()) {
    if (!member.connected || !member.socketId) continue;
    io.to(member.socketId).emit('state', room.toView(member.id));
  }
}

function broadcastChat(room, msg) {
  for (const member of room.members.values()) {
    if (!member.connected || !member.socketId) continue;
    io.to(member.socketId).emit('chat', msg);
  }
}

function broadcastReaction(room, payload) {
  for (const member of room.members.values()) {
    if (!member.connected || !member.socketId) continue;
    io.to(member.socketId).emit('reaction', payload);
  }
}

function sanitizeName(name) {
  return String(name || '')
    .trim()
    .slice(0, 20)
    .replace(/[<>]/g, '');
}

function sanitizeChat(text) {
  return String(text || '')
    .replace(/[\x00-\x1f\x7f]/g, ' ') // control chars -> space
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

// Seats that must hit "ready" before a round-end advances: connected players
// (disconnected seats don't block — the AFK/round timers cover them instead).
function requiredReadyIds(room) {
  const out = [];
  for (const m of room.members.values()) {
    if (m.connected) out.push(m.id);
  }
  return out;
}

// Advance out of round-end once every required player is ready. Returns true
// if it advanced.
function maybeAdvanceRound(room) {
  const g = room.game;
  if (!g || g.phase !== 'roundEnd') return false;
  const required = requiredReadyIds(room);
  if (required.length === 0) return false;
  if (!required.every((id) => g.readyIds.has(id))) return false;
  try {
    g.nextRound();
  } catch {
    return false;
  }
  broadcastRoom(room);
  driveTable(room);
  return true;
}

// Act on behalf of a disconnected player whose turn has gone stale: estimate
// the least risky legal number, or play the lowest legal card.
function actForAfk(room, playerId) {
  const g = room.game;
  try {
    if (g.phase === 'estimating' && g.turnId === playerId) {
      const view = g.toView(playerId);
      const n = view.forbiddenEstimate === 0 ? 1 : 0;
      g.estimate(playerId, n);
    } else if (g.phase === 'playing' && g.turnId === playerId) {
      const view = g.toView(playerId);
      if (!view.legalCardIds.length) return;
      const legal = new Set(view.legalCardIds);
      const lowest = view.hand
        .filter((c) => legal.has(c.id))
        .sort((a, b) => a.rank - b.rank)[0];
      if (lowest) g.playCard(playerId, lowest.id);
    }
  } catch {
    // Never let a stuck AFK seat wedge the table.
  }
}

// Drive the game forward: sweep a settled trick after a pause, auto-advance a
// round-end summary, and act for a disconnected player whose turn has gone
// stale. At most one of these is relevant at a time, so a single timer
// suffices; re-arms itself after each step, mirroring driveBots in the dice
// server.
function driveTable(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
  const g = room.game;
  if (!g) return;

  if (g.phase === 'playing' && g.trick.winnerId !== null) {
    room.timer = setTimeout(() => {
      room.timer = null;
      if (!room.game || room.game.phase !== 'playing') return;
      room.game.sweepTrick();
      broadcastRoom(room);
      driveTable(room);
    }, trickPauseMs());
    room.timer.unref?.(); // don't keep the process alive (tests)
    return;
  }

  if (g.phase === 'roundEnd') {
    room.timer = setTimeout(() => {
      room.timer = null;
      if (!room.game || room.game.phase !== 'roundEnd') return;
      try {
        room.game.nextRound();
      } catch {
        /* ignore */
      }
      broadcastRoom(room);
      driveTable(room);
    }, roundTimeoutMs());
    room.timer.unref?.();
    return;
  }

  if (g.phase === 'estimating' || g.phase === 'playing') {
    const member = room.members.get(g.turnId);
    if (member && !member.connected) {
      const turnId = g.turnId;
      room.timer = setTimeout(() => {
        room.timer = null;
        if (!room.game || room.game.turnId !== turnId) return;
        actForAfk(room, turnId);
        broadcastRoom(room);
        driveTable(room);
      }, afkMs());
      room.timer.unref?.();
    }
  }
}

function handleLeave(socket) {
  const info = socketInfo.get(socket.id);
  socketInfo.delete(socket.id);
  if (!info) return;
  const room = rooms.getRoom(info.code);
  if (!room) return;
  const member = room.members.get(info.id);

  // Ignore a stale disconnect for a seat that has already been reclaimed by a
  // newer socket — only the member's current socket may drop the seat.
  if (member && member.socketId === socket.id) {
    if (room.game) {
      // Mid-game: keep the seat (so it can be reclaimed) but mark disconnected.
      member.connected = false;
      member.socketId = null;
    } else {
      room.removeMember(info.id); // in the lobby, free the seat entirely
    }
  }

  if (room.isEmpty()) {
    if (room.timer) clearTimeout(room.timer);
    rooms.deleteRoom(room.code);
  } else {
    // A departure may have removed the last player we were waiting on to ready.
    if (room.game && room.game.phase === 'roundEnd' && maybeAdvanceRound(room)) return;
    if (room.game) driveTable(room); // re-arm timers (e.g. this seat is now AFK-able)
    broadcastRoom(room);
  }
}

io.on('connection', (socket) => {
  const reply = (event, payload) => socket.emit(event, payload);

  // Register a socket against a (possibly new) member and confirm the join.
  const enter = (room, member) => {
    socket.join(room.code);
    socketInfo.set(socket.id, { code: room.code, id: member.id });
    reply('joined', { code: room.code, you: member.id });
    reply('chatHistory', room.messages); // load the backlog on (re)join
    broadcastRoom(room);
    if (room.game) driveTable(room); // reconnecting may clear an AFK timer
  };

  let lastChatAt = 0; // light per-socket rate limit
  let lastReactionAt = 0;

  socket.on('chat', ({ text } = {}) => {
    const s = seat();
    if (!s) return;
    const member = s.room.members.get(s.id);
    if (!member) return;
    const clean = sanitizeChat(text);
    if (!clean) return;
    const now = Date.now();
    if (now - lastChatAt < 350) return; // drop bursts
    lastChatAt = now;
    broadcastChat(s.room, s.room.addMessage(member.name, clean, member.id));
  });

  // Ephemeral emoji reactions — broadcast (whitelisted), never stored.
  socket.on('reaction', ({ emoji } = {}) => {
    const s = seat();
    if (!s) return;
    const member = s.room.members.get(s.id);
    if (!member || !REACTION_SET.has(emoji)) return;
    const now = Date.now();
    if (now - lastReactionAt < 250) return; // drop bursts
    lastReactionAt = now;
    broadcastReaction(s.room, { emoji, seatId: member.id, name: member.name });
  });

  socket.on('create', ({ name, token }) => {
    const clean = sanitizeName(name);
    if (!clean) return reply('errorMsg', 'Please enter a name.');
    const room = rooms.createRoom();
    enter(room, room.addMember(token, clean, socket.id));
  });

  socket.on('join', ({ code, name, token }) => {
    const clean = sanitizeName(name);
    if (!clean) return reply('errorMsg', 'Please enter a name.');
    const room = rooms.getRoom(code);
    if (!room) return reply('errorMsg', 'No room with that code.');

    // A matching token reclaims an existing seat — works mid-game too, which is
    // how a refreshed or dropped player rejoins where they left off.
    const existing = room.findByToken(token);
    if (existing) {
      return enter(room, room.reclaim(existing, socket.id, clean));
    }
    if (room.game) return reply('errorMsg', 'That game has already started.');
    if (room.size >= MAX_PLAYERS) return reply('errorMsg', 'That room is full.');
    enter(room, room.addMember(token, clean, socket.id));
  });

  // Look up the caller's room + seat id; null if they aren't seated.
  const seat = () => {
    const info = socketInfo.get(socket.id);
    const room = info && rooms.getRoom(info.code);
    return room ? { room, id: info.id } : null;
  };

  // Wrap an engine action so any thrown rule violation becomes an error toast
  // for just the acting player, and a successful action rebroadcasts state.
  const withGame = (fn) => () => {
    const s = seat();
    if (!s || !s.room.game) return;
    try {
      fn(s.room, s.id);
      broadcastRoom(s.room);
      driveTable(s.room);
    } catch (err) {
      reply('errorMsg', err.message);
    }
  };

  // Host adjusts room options in the lobby (trump cycles).
  socket.on('updateSettings', (partial) => {
    const s = seat();
    if (!s) return;
    if (s.room.hostId !== s.id) return reply('errorMsg', 'Only the host can change settings.');
    if (s.room.game) return reply('errorMsg', 'Settings are locked once the game starts.');
    s.room.updateSettings(partial || {});
    broadcastRoom(s.room);
  });

  socket.on('start', () => {
    const s = seat();
    if (!s) return;
    if (s.room.hostId !== s.id) return reply('errorMsg', 'Only the host can start.');
    if (s.room.size < MIN_PLAYERS) return reply('errorMsg', 'Need at least 2 players.');
    if (s.room.game) return;
    try {
      s.room.startGame();
      broadcastRoom(s.room);
      driveTable(s.room);
    } catch (err) {
      reply('errorMsg', err.message);
    }
  });

  socket.on('estimate', ({ n } = {}) => withGame((room, id) => room.game.estimate(id, n))());
  socket.on('playCard', ({ id: cardId } = {}) =>
    withGame((room, id) => room.game.playCard(id, cardId))()
  );

  // Each player marks ready at round-end; the next round starts once everyone is.
  socket.on('ready', ({ ready } = {}) => {
    const s = seat();
    if (!s || !s.room.game || s.room.game.phase !== 'roundEnd') return;
    s.room.game.markReady(s.id, ready !== false);
    broadcastRoom(s.room);
    maybeAdvanceRound(s.room);
  });

  // Host sends everyone back to the lobby after game over, where settings
  // (trump cycles) can be changed before starting another game.
  socket.on('rematch', () => {
    const s = seat();
    if (!s || s.room.hostId !== s.id) return;
    if (!s.room.game || s.room.game.phase !== 'gameover') return;
    if (s.room.timer) {
      clearTimeout(s.room.timer);
      s.room.timer = null;
    }
    s.room.game = null; // -> clients render the lobby; settings unlock
    broadcastRoom(s.room);
  });

  socket.on('leave', () => handleLeave(socket));
  socket.on('disconnect', () => handleLeave(socket));
});

  return server;
}

// Only start listening when run directly (not when imported by tests).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  createServer().listen(PORT, () => {
    console.log(`Estimation server listening on http://localhost:${PORT}`);
  });
}
