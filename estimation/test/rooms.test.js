import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager, Room } from '../src/rooms.js';
import { DEFAULT_CYCLES } from '../src/game.js';

test('addMessage stores chat and caps history at 50', () => {
  const room = new Room('TEST');
  const m = room.addMessage('Alice', 'hello', 'seat-1');
  assert.equal(m.name, 'Alice');
  assert.equal(m.text, 'hello');
  assert.equal(m.seatId, 'seat-1');
  assert.ok(typeof m.id === 'number' && typeof m.ts === 'number');

  for (let i = 0; i < 60; i++) room.addMessage('Bob', `msg ${i}`, 'seat-2');
  assert.equal(room.messages.length, 50); // capped
  assert.equal(room.messages[room.messages.length - 1].text, 'msg 59'); // newest kept
  assert.equal(room.messages[0].text, 'msg 10'); // oldest dropped
});

test('rooms get unique short codes and can be looked up case-insensitively', () => {
  const mgr = new RoomManager();
  const a = mgr.createRoom();
  const b = mgr.createRoom();
  assert.notEqual(a.code, b.code);
  assert.equal(mgr.getRoom(a.code.toLowerCase()), a);
  assert.equal(mgr.getRoom('nope'), null);
});

test('default settings', () => {
  const room = new Room('TEST');
  assert.deepEqual(room.settings, { cycles: DEFAULT_CYCLES });
});

test('updateSettings clamps cycles to 1..3', () => {
  const room = new Room('TEST');
  room.updateSettings({ cycles: 99 });
  assert.equal(room.settings.cycles, 3);
  room.updateSettings({ cycles: 0 });
  assert.equal(room.settings.cycles, 1);
  room.updateSettings({ cycles: 2 });
  assert.equal(room.settings.cycles, 2);
  room.updateSettings({ cycles: 'nonsense' });
  assert.equal(room.settings.cycles, DEFAULT_CYCLES); // NaN -> default
  // A partial update with an undefined field leaves the setting untouched.
  room.updateSettings({});
  assert.equal(room.settings.cycles, DEFAULT_CYCLES);
});

test('startGame applies the configured cycles', () => {
  const room = new Room('TEST');
  room.addMember('a', 'Alice');
  room.addMember('b', 'Bob');
  room.updateSettings({ cycles: 3 });
  const game = room.startGame();
  assert.equal(game.cycles, 3);
  assert.equal(game.totalRounds, 15);
});

test('toView exposes settings and per-viewer game state', () => {
  const room = new Room('TEST');
  const a = room.addMember('a', 'Alice');
  room.updateSettings({ cycles: 1 });
  const view = room.toView(a.id);
  assert.deepEqual(view.settings, { cycles: 1 });
  assert.equal(view.game, null);
  assert.equal(view.members[0].isYou, true);
  assert.equal(view.members[0].isHost, true);
});

test('host reassignment when the host leaves the lobby', () => {
  const room = new Room('TEST');
  const a = room.addMember('tokenA', 'Alice', 's1');
  const b = room.addMember('tokenB', 'Bob', 's2');
  assert.equal(room.hostId, a.id);
  room.removeMember(a.id);
  assert.equal(room.hostId, b.id);
});

test('a seat can be reclaimed by its token (reconnect)', () => {
  const room = new Room('TEST');
  const m = room.addMember('tok-1', 'Alice', 's1');
  room.addMember('tok-2', 'Bob', 's2');
  assert.equal(room.findByToken('tok-1'), m);
  assert.equal(room.findByToken('nope'), null);
  assert.equal(room.findByToken(null), null); // null tokens never match

  // Simulate a drop then a reclaim with a new socket.
  m.connected = false;
  m.socketId = null;
  const back = room.reclaim(room.findByToken('tok-1'), 's3', 'Alice');
  assert.equal(back.id, m.id); // same seat
  assert.equal(back.socketId, 's3');
  assert.equal(back.connected, true);
});

test('isEmpty is true once nobody is connected', () => {
  const room = new Room('TEST');
  const a = room.addMember('tok-1', 'Alice', 's1');
  assert.equal(room.isEmpty(), false);
  a.connected = false;
  assert.equal(room.isEmpty(), true);
});
