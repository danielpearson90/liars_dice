// HTTP + WebSocket server wiring Express (static client) to Socket.IO (realtime
// game events). All game logic lives in src/game.js; this file only translates
// socket messages into engine calls and broadcasts the resulting state.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { RoomManager, MAX_PLAYERS } from './src/rooms.js';
import { decideMove } from './src/bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// How long a bot "thinks" before acting. The minimum is kept comfortably longer
// than a spoken announcer clip (~3s) so back-to-back bot moves don't talk over
// each other.
const BOT_MOVE_MIN = 3200;
const BOT_MOVE_MAX = 4800;
// A reveal auto-advances after this long even if not everyone has readied up (an
// AFK backstop); readying up early advances sooner. Env-overridable for tests.
const revealTimeoutMs = () => Number(process.env.REVEAL_TIMEOUT_MS) || 5000;

export function createServer() {
const app = express();
// `no-cache` = always revalidate (via ETag), so a client never runs a stale
// index.html/client.js pair after an update. Clips are immutable, so let those
// cache hard.
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      res.setHeader('Cache-Control', filePath.includes('/tts/') ? 'max-age=604800' : 'no-cache');
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

function sanitizeName(name) {
  return String(name || '')
    .trim()
    .slice(0, 20)
    .replace(/[<>]/g, '');
}

function sanitizeChat(text) {
  return String(text || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ') // control chars -> space
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

const isBotSeat = (room, id) => !!room.members.get(id)?.isBot;

// Seats that must hit "ready" before a reveal advances: connected humans who are
// still in the game (bots are auto-ready; disconnected/eliminated don't block).
function requiredReadyIds(room) {
  const g = room.game;
  const out = [];
  for (const m of room.members.values()) {
    if (m.isBot || !m.connected) continue;
    const p = g.getPlayer(m.id);
    if (p && p.eliminated) continue;
    out.push(m.id);
  }
  return out;
}

// Advance out of a reveal once every required player is ready. Returns true if
// it advanced. (When nobody needs to ready — e.g. an all-bot table — the timer
// in driveBots handles it instead.)
function maybeAdvanceReveal(room) {
  const g = room.game;
  if (!g || g.phase !== 'reveal') return false;
  const required = requiredReadyIds(room);
  if (required.length === 0) return false;
  if (!required.every((id) => g.readyIds.has(id))) return false;
  try {
    g.nextRound();
  } catch {
    return false;
  }
  broadcastRoom(room);
  driveBots(room);
  return true;
}

// Drive the game forward for bots: take a bot's turn after a brief delay, and
// auto-advance the reveal when bots are present. Re-arms itself after each step.
function driveBots(room) {
  if (room.botTimer) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
  }
  const g = room.game;
  if (!g) return;

  if (g.phase === 'playing' && isBotSeat(room, g.turnId)) {
    const botId = g.turnId;
    const delay = BOT_MOVE_MIN + Math.random() * (BOT_MOVE_MAX - BOT_MOVE_MIN);
    room.botTimer = setTimeout(() => {
      room.botTimer = null;
      // Re-check: the situation may have moved on while we waited.
      if (!room.game || room.game.phase !== 'playing' || room.game.turnId !== botId) return;
      try {
        const skill = room.members.get(botId)?.skill ?? 0.7;
        const move = decideMove(room.game, botId, Math.random, skill);
        if (move.type === 'challenge') room.game.challenge(botId);
        else if (move.type === 'spotOn') room.game.spotOn(botId);
        else room.game.bid(botId, move.quantity, move.face);
      } catch {
        // Shouldn't happen, but never let a bot wedge the game.
        try {
          if (room.game.currentBid) room.game.challenge(botId);
        } catch {
          /* ignore */
        }
      }
      broadcastRoom(room);
      driveBots(room);
    }, delay);
    room.botTimer.unref?.(); // don't keep the process alive (tests)
  } else if (g.phase === 'reveal') {
    // Auto-advance after the timeout even if not everyone has readied — a
    // backstop so an AFK player can't stall the table. (Everyone readying up
    // advances sooner, via maybeAdvanceReveal.)
    room.botTimer = setTimeout(() => {
      room.botTimer = null;
      if (room.game && room.game.phase === 'reveal') {
        try {
          room.game.nextRound();
        } catch {
          /* ignore */
        }
        broadcastRoom(room);
        driveBots(room);
      }
    }, revealTimeoutMs());
    room.botTimer.unref?.(); // don't keep the process alive (tests)
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
    if (room.botTimer) clearTimeout(room.botTimer);
    rooms.deleteRoom(room.code);
  } else {
    // A departure may have removed the last player we were waiting on to ready.
    if (room.game && room.game.phase === 'reveal' && maybeAdvanceReveal(room)) return;
    if (room.game && room.game.phase === 'reveal') driveBots(room); // re-arm timer if needed
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
  };

  let lastChatAt = 0; // light per-socket rate limit

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
      driveBots(s.room);
    } catch (err) {
      reply('errorMsg', err.message);
    }
  };

  // Host adjusts room options in the lobby (starting dice, probability, ruleset).
  socket.on('updateSettings', (partial) => {
    const s = seat();
    if (!s) return;
    if (s.room.hostId !== s.id) return reply('errorMsg', 'Only the host can change settings.');
    if (s.room.game) return reply('errorMsg', 'Settings are locked once the game starts.');
    s.room.updateSettings(partial || {});
    broadcastRoom(s.room);
  });

  // Host adds/removes computer players (lobby only, up to the room cap).
  socket.on('addBot', () => {
    const s = seat();
    if (!s) return;
    if (s.room.hostId !== s.id) return reply('errorMsg', 'Only the host can add bots.');
    if (s.room.game) return reply('errorMsg', 'Add bots before starting.');
    if (s.room.size >= MAX_PLAYERS) return reply('errorMsg', 'The room is full.');
    s.room.addBot();
    broadcastRoom(s.room);
  });

  socket.on('removeBot', () => {
    const s = seat();
    if (!s) return;
    if (s.room.hostId !== s.id) return reply('errorMsg', 'Only the host can remove bots.');
    if (s.room.game) return;
    s.room.removeLastBot();
    broadcastRoom(s.room);
  });

  socket.on('start', () => {
    const s = seat();
    if (!s) return;
    if (s.room.hostId !== s.id) return reply('errorMsg', 'Only the host can start.');
    if (s.room.size < 2) return reply('errorMsg', 'Need at least 2 players.');
    if (s.room.game) return;
    try {
      s.room.startGame();
      broadcastRoom(s.room);
      driveBots(s.room);
    } catch (err) {
      reply('errorMsg', err.message);
    }
  });

  socket.on('bid', ({ quantity, face }) =>
    withGame((room, id) => room.game.bid(id, quantity, face))()
  );
  socket.on('challenge', withGame((room, id) => room.game.challenge(id)));
  socket.on('spotOn', withGame((room, id) => room.game.spotOn(id)));

  // Each player marks ready on the reveal; the round advances once everyone is.
  socket.on('ready', ({ ready } = {}) => {
    const s = seat();
    if (!s || !s.room.game || s.room.game.phase !== 'reveal') return;
    s.room.game.markReady(s.id, ready !== false);
    broadcastRoom(s.room);
    maybeAdvanceReveal(s.room);
  });

  // Host can start a brand-new game with the same lobby after game over.
  socket.on('rematch', () => {
    const s = seat();
    if (!s || s.room.hostId !== s.id) return;
    if (s.room.game && s.room.game.phase !== 'gameover') return;
    if (s.room.size < 2) return reply('errorMsg', 'Need at least 2 players.');
    s.room.startGame();
    broadcastRoom(s.room);
    driveBots(s.room);
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
    console.log(`Liar's Dice server listening on http://localhost:${PORT}`);
  });
}
