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

// Track which room each socket belongs to for clean disconnect handling.
/** @type {Map<string, {code: string, name: string}>} */
const socketInfo = new Map();

function broadcastRoom(room) {
  for (const member of room.members.values()) {
    if (!member.connected) continue;
    io.to(member.id).emit('state', room.toView(member.id));
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

  if (room.game) {
    // Mid-game: keep the seat but mark disconnected so the board still renders.
    const member = room.members.get(socket.id);
    if (member) member.connected = false;
  } else {
    // In the lobby we can drop the seat entirely.
    room.removeMember(socket.id);
  }

  if (room.isEmpty()) {
    rooms.deleteRoom(room.code);
  } else {
    broadcastRoom(room);
  }
}

io.on('connection', (socket) => {
  const reply = (event, payload) => socket.emit(event, payload);

  socket.on('create', ({ name }) => {
    const clean = sanitizeName(name);
    if (!clean) return reply('errorMsg', 'Please enter a name.');
    const room = rooms.createRoom();
    room.addMember(socket.id, clean);
    socket.join(room.code);
    socketInfo.set(socket.id, { code: room.code, name: clean });
    reply('joined', { code: room.code, you: socket.id });
    broadcastRoom(room);
  });

  socket.on('join', ({ code, name }) => {
    const clean = sanitizeName(name);
    if (!clean) return reply('errorMsg', 'Please enter a name.');
    const room = rooms.getRoom(code);
    if (!room) return reply('errorMsg', 'No room with that code.');
    if (room.game) return reply('errorMsg', 'That game has already started.');
    if (room.size >= MAX_PLAYERS) return reply('errorMsg', 'That room is full.');
    room.addMember(socket.id, clean);
    socket.join(room.code);
    socketInfo.set(socket.id, { code: room.code, name: clean });
    reply('joined', { code: room.code, you: socket.id });
    broadcastRoom(room);
  });

  // Wrap an engine action so any thrown rule violation becomes an error toast
  // for just the acting player, and a successful action rebroadcasts state.
  const withGame = (fn) => () => {
    const info = socketInfo.get(socket.id);
    const room = info && rooms.getRoom(info.code);
    if (!room || !room.game) return;
    try {
      fn(room);
      broadcastRoom(room);
    } catch (err) {
      reply('errorMsg', err.message);
    }
  };

  // Host adjusts room options in the lobby (starting dice, probability display).
  socket.on('updateSettings', (partial) => {
    const info = socketInfo.get(socket.id);
    const room = info && rooms.getRoom(info.code);
    if (!room) return;
    if (room.hostId !== socket.id) return reply('errorMsg', 'Only the host can change settings.');
    if (room.game) return reply('errorMsg', 'Settings are locked once the game starts.');
    room.updateSettings(partial || {});
    broadcastRoom(room);
  });

  socket.on('start', () => {
    const info = socketInfo.get(socket.id);
    const room = info && rooms.getRoom(info.code);
    if (!room) return;
    if (room.hostId !== socket.id) return reply('errorMsg', 'Only the host can start.');
    if (room.size < 2) return reply('errorMsg', 'Need at least 2 players.');
    if (room.game) return;
    try {
      room.startGame();
      broadcastRoom(room);
    } catch (err) {
      reply('errorMsg', err.message);
    }
  });

  socket.on('bid', ({ quantity, face }) =>
    withGame((room) => room.game.bid(socket.id, quantity, face))()
  );
  socket.on('challenge', withGame((room) => room.game.challenge(socket.id)));
  socket.on('spotOn', withGame((room) => room.game.spotOn(socket.id)));

  // Anyone may advance past the reveal screen once it is showing.
  socket.on('nextRound', () => {
    const info = socketInfo.get(socket.id);
    const room = info && rooms.getRoom(info.code);
    if (!room || !room.game) return;
    try {
      if (room.game.phase === 'reveal') {
        room.game.nextRound();
        broadcastRoom(room);
      }
    } catch (err) {
      reply('errorMsg', err.message);
    }
  });

  // Host can start a brand-new game with the same lobby after game over.
  socket.on('rematch', () => {
    const info = socketInfo.get(socket.id);
    const room = info && rooms.getRoom(info.code);
    if (!room || room.hostId !== socket.id) return;
    if (room.game && room.game.phase !== 'gameover') return;
    if (room.size < 2) return reply('errorMsg', 'Need at least 2 players.');
    room.startGame();
    broadcastRoom(room);
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
