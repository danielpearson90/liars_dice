// HTTP + WebSocket server wiring Express (static client) to Socket.IO (realtime
// game events). All game logic lives in src/game.js; this file only translates
// socket messages into engine calls and broadcasts the resulting state.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { RoomManager, MAX_PLAYERS } from './src/rooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

export function createServer() {
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
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

function sanitizeName(name) {
  return String(name || '')
    .trim()
    .slice(0, 20)
    .replace(/[<>]/g, '');
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
    rooms.deleteRoom(room.code);
  } else {
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
    broadcastRoom(room);
  };

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

  socket.on('start', () => {
    const s = seat();
    if (!s) return;
    if (s.room.hostId !== s.id) return reply('errorMsg', 'Only the host can start.');
    if (s.room.size < 2) return reply('errorMsg', 'Need at least 2 players.');
    if (s.room.game) return;
    try {
      s.room.startGame();
      broadcastRoom(s.room);
    } catch (err) {
      reply('errorMsg', err.message);
    }
  });

  socket.on('bid', ({ quantity, face }) =>
    withGame((room, id) => room.game.bid(id, quantity, face))()
  );
  socket.on('challenge', withGame((room, id) => room.game.challenge(id)));
  socket.on('spotOn', withGame((room, id) => room.game.spotOn(id)));

  // Anyone may advance past the reveal screen once it is showing.
  socket.on('nextRound', () => {
    const s = seat();
    if (!s || !s.room.game) return;
    try {
      if (s.room.game.phase === 'reveal') {
        s.room.game.nextRound();
        broadcastRoom(s.room);
      }
    } catch (err) {
      reply('errorMsg', err.message);
    }
  });

  // Host can start a brand-new game with the same lobby after game over.
  socket.on('rematch', () => {
    const s = seat();
    if (!s || s.room.hostId !== s.id) return;
    if (s.room.game && s.room.game.phase !== 'gameover') return;
    if (s.room.size < 2) return reply('errorMsg', 'Need at least 2 players.');
    s.room.startGame();
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
    console.log(`Liar's Dice server listening on http://localhost:${PORT}`);
  });
}
