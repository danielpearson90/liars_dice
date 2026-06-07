import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager, Room } from '../src/rooms.js';

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
  assert.deepEqual(room.settings, { startingDice: 5, showProbability: false });
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

test('toView exposes settings to clients', () => {
  const room = new Room('TEST');
  room.addMember('a', 'Alice');
  room.updateSettings({ startingDice: 6, showProbability: true });
  const view = room.toView('a');
  assert.deepEqual(view.settings, { startingDice: 6, showProbability: true });
});

test('host reassignment when the host leaves the lobby', () => {
  const room = new Room('TEST');
  room.addMember('a', 'Alice');
  room.addMember('b', 'Bob');
  assert.equal(room.hostId, 'a');
  room.removeMember('a');
  assert.equal(room.hostId, 'b');
});
