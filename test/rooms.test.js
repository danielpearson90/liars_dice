import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager, Room } from '../src/rooms.js';

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
  assert.deepEqual(room.settings, {
    startingDice: 5,
    showProbability: false,
    ruleset: 'common-hand',
  });
});

test('updateSettings clamps dice and coerces the probability flag', () => {
  const room = new Room('TEST');
  room.updateSettings({ startingDice: 99 });
  assert.equal(room.settings.startingDice, 20);
  room.updateSettings({ startingDice: 0 });
  assert.equal(room.settings.startingDice, 1);
  room.updateSettings({ startingDice: 7 });
  assert.equal(room.settings.startingDice, 7);

  room.updateSettings({ showProbability: 1 });
  assert.equal(room.settings.showProbability, true);
  room.updateSettings({ showProbability: '' });
  assert.equal(room.settings.showProbability, false);

  // A partial update leaves other fields untouched.
  room.updateSettings({ showProbability: true });
  assert.equal(room.settings.startingDice, 7);
});

test('startGame applies the configured starting dice', () => {
  const room = new Room('TEST');
  room.addMember('a', 'Alice');
  room.addMember('b', 'Bob');
  room.updateSettings({ startingDice: 8 });
  const game = room.startGame();
  assert.equal(game.startingDice, 8);
  for (const p of game.players) assert.equal(p.diceCount, 8);
});

test('ruleset defaults, validates, and flows into the game', () => {
  const room = new Room('TEST');
  assert.equal(room.settings.ruleset, 'common-hand');
  room.updateSettings({ ruleset: 'not-real' });
  assert.equal(room.settings.ruleset, 'common-hand'); // unknown ignored
  room.updateSettings({ ruleset: 'aces-wild' });
  assert.equal(room.settings.ruleset, 'aces-wild');

  room.addMember('a', 'Alice');
  room.addMember('b', 'Bob');
  const game = room.startGame();
  assert.equal(game.ruleset.id, 'aces-wild');
});

test('toView lists the available rulesets', () => {
  const room = new Room('TEST');
  room.addMember('a', 'Alice');
  const view = room.toView('a');
  assert.ok(Array.isArray(view.rulesets) && view.rulesets.length >= 3);
  const ids = view.rulesets.map((r) => r.id);
  assert.ok(ids.includes('common-hand') && ids.includes('aces-wild'));
  assert.ok(view.rulesets.every((r) => r.name && r.desc));
});

test('toView exposes settings to clients', () => {
  const room = new Room('TEST');
  room.addMember('a', 'Alice');
  room.updateSettings({ startingDice: 6, showProbability: true, ruleset: 'aces-wild' });
  const view = room.toView('a');
  assert.deepEqual(view.settings, {
    startingDice: 6,
    showProbability: true,
    ruleset: 'aces-wild',
  });
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
