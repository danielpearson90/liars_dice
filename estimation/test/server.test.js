// End-to-end test of the socket layer: real clients connect to a freshly
// launched server, create/join a room, start a game, and drive a full round.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { io as ioClient } from 'socket.io-client';
import { createServer } from '../server.js';

// Spin up the server on an ephemeral port and hand back the base URL + a
// teardown function.
async function launch() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return {
    url: `http://localhost:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function connect(url) {
  return ioClient(url, { transports: ['websocket'], forceNew: true });
}

// Wait for the next 'state' that satisfies `predicate`.
function waitState(socket, predicate) {
  return new Promise((resolve) => {
    const handler = (state) => {
      if (predicate(state)) {
        socket.off('state', handler);
        resolve(state);
      }
    };
    socket.on('state', handler);
  });
}

// True when it's genuinely `myId`'s turn to act (an estimate, or a card play
// with at least one legal option — i.e. not while a trick is pending sweep).
function isMyActionableTurn(state, myId) {
  const g = state.game;
  if (!g) return false;
  if (g.phase === 'estimating') return g.turnId === myId;
  if (g.phase === 'playing') return g.turnId === myId && g.legalCardIds.length > 0;
  return false;
}

test('server boots and answers /healthz', async () => {
  const srv = await launch();
  try {
    const res = await fetch(`${srv.url}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    await srv.close();
  }
});

test('two clients can create, join, and start into the estimating phase', async () => {
  const srv = await launch();
  const host = connect(srv.url);
  const guest = connect(srv.url);
  try {
    host.emit('create', { name: 'Alice' });
    const [{ code, you: hostId }] = await once(host, 'joined');
    assert.match(code, /^[A-Z0-9]{4}$/);

    const guestState = waitState(guest, (s) => s.members.length === 2);
    guest.emit('join', { code, name: 'Bob' });
    const [{ you: guestId }] = await once(guest, 'joined');
    await guestState;

    // Host (seat 0) is round-0 dealer, so the guest (dealer's left) estimates first.
    const guestTurn = waitState(guest, (s) => s.game && s.game.phase === 'estimating');
    host.emit('start');
    const started = await guestTurn;

    assert.equal(started.game.phase, 'estimating');
    assert.equal(started.game.round.dealerId, hostId);
    assert.equal(started.game.turnId, guestId);
    assert.equal(started.game.hand.length, 13);
    assert.deepEqual(started.game.estimateOrder, [guestId, hostId]);
  } finally {
    host.close();
    guest.close();
    await srv.close();
  }
});

test('non-host cannot start the game', async () => {
  const srv = await launch();
  const host = connect(srv.url);
  const guest = connect(srv.url);
  try {
    host.emit('create', { name: 'Alice' });
    const [{ code }] = await once(host, 'joined');
    const joined = waitState(host, (s) => s.members.length === 2);
    guest.emit('join', { code, name: 'Bob' });
    await once(guest, 'joined');
    await joined;

    const errP = once(guest, 'errorMsg');
    guest.emit('start');
    const [msg] = await errP;
    assert.match(msg, /host/i);
  } finally {
    host.close();
    guest.close();
    await srv.close();
  }
});

test('an illegal move produces errorMsg and no state change', async () => {
  const srv = await launch();
  const host = connect(srv.url);
  const guest = connect(srv.url);
  try {
    host.emit('create', { name: 'Alice' });
    const [{ code, you: hostId }] = await once(host, 'joined');
    const joined = waitState(host, (s) => s.members.length === 2);
    guest.emit('join', { code, name: 'Bob' });
    await once(guest, 'joined');
    await joined;

    const guestTurn = waitState(guest, (s) => s.game && s.game.phase === 'estimating');
    host.emit('start');
    await guestTurn; // it is the guest's turn, not the host's

    let sawState = false;
    host.once('state', () => {
      sawState = true;
    });
    const errP = once(host, 'errorMsg');
    host.emit('estimate', { n: 3 }); // host tries to act out of turn
    const [msg] = await errP;
    assert.match(msg, /not your turn/i);

    await new Promise((r) => setTimeout(r, 150));
    assert.equal(sawState, false); // the rejected action never triggered a broadcast
  } finally {
    host.close();
    guest.close();
    await srv.close();
  }
});

test('a full round plays out end-to-end with the timers shrunk via env', async () => {
  const prevTrick = process.env.TRICK_PAUSE_MS;
  const prevRound = process.env.ROUND_TIMEOUT_MS;
  process.env.TRICK_PAUSE_MS = '15';
  process.env.ROUND_TIMEOUT_MS = '50';
  const srv = await launch();
  const host = connect(srv.url);
  const guest = connect(srv.url);
  try {
    host.emit('create', { name: 'Alice' });
    const [{ code, you: hostId }] = await once(host, 'joined');
    const joined = waitState(host, (s) => s.members.length === 2);
    guest.emit('join', { code, name: 'Bob' });
    const [{ you: guestId }] = await once(guest, 'joined');
    await joined;

    const guestTurn = waitState(guest, (s) => s.game && s.game.phase === 'estimating');
    host.emit('start');
    let state = await guestTurn;
    let actorId = guestId;
    let steps = 0;

    while (state.game.phase !== 'roundEnd') {
      steps += 1;
      assert.ok(steps < 200, 'round should finish well within 200 actions');
      const actorSock = actorId === hostId ? host : guest;
      const g = state.game;

      const roundEndP = waitState(host, (s) => s.game.phase === 'roundEnd');
      const hostTurnP = waitState(host, (s) => isMyActionableTurn(s, hostId));
      const guestTurnP = waitState(guest, (s) => isMyActionableTurn(s, guestId));

      if (g.phase === 'estimating') {
        actorSock.emit('estimate', { n: g.forbiddenEstimate === 0 ? 1 : 0 });
      } else {
        actorSock.emit('playCard', { id: g.legalCardIds[0] });
      }

      const result = await Promise.race([
        roundEndP.then((s) => ({ who: 'end', s })),
        hostTurnP.then((s) => ({ who: hostId, s })),
        guestTurnP.then((s) => ({ who: guestId, s })),
      ]);
      state = result.s;
      actorId = result.who === 'end' ? actorId : result.who;
    }

    assert.equal(state.game.phase, 'roundEnd');
    assert.equal(state.game.round.number, 1);
    assert.ok(state.game.roundSummary);
    assert.equal(state.game.roundSummary.rows.length, 2);
    // Every card dealt was accounted for across the round's tricks.
    const totalTricks = state.game.roundSummary.rows.reduce((sum, r) => sum + r.tricksWon, 0);
    assert.equal(totalTricks, state.game.round.handSize);
  } finally {
    host.close();
    guest.close();
    await srv.close();
    if (prevTrick === undefined) delete process.env.TRICK_PAUSE_MS;
    else process.env.TRICK_PAUSE_MS = prevTrick;
    if (prevRound === undefined) delete process.env.ROUND_TIMEOUT_MS;
    else process.env.ROUND_TIMEOUT_MS = prevRound;
  }
});

test('reconnect by token mid-game restores the same seat and hand', async () => {
  const srv = await launch();
  const host = connect(srv.url);
  let guest = connect(srv.url);
  const guestToken = 'guest-token-123';
  try {
    host.emit('create', { name: 'Alice' });
    const [{ code, you: hostId }] = await once(host, 'joined');
    const joined = waitState(host, (s) => s.members.length === 2);
    guest.emit('join', { code, name: 'Bob', token: guestToken });
    const [{ you: guestId }] = await once(guest, 'joined');
    await joined;

    const guestTurn = waitState(guest, (s) => s.game && s.game.phase === 'estimating');
    host.emit('start');
    const started = await guestTurn;
    const originalHand = started.game.hand;
    assert.equal(originalHand.length, 13);

    // Guest drops...
    const hostSeesDisconnect = waitState(host, (s) =>
      s.members.find((m) => m.id === guestId && !m.connected)
    );
    guest.close();
    await hostSeesDisconnect;

    // ...and reconnects with a fresh socket but the same token, mid-game.
    guest = connect(srv.url);
    const rejoined = once(guest, 'joined');
    const reclaimedState = waitState(guest, (s) => s.game && s.game.phase === 'estimating');
    guest.emit('join', { code, name: 'Bob', token: guestToken });
    const [{ you: reclaimedId }] = await rejoined;
    const state = await reclaimedState;

    assert.equal(reclaimedId, guestId); // same seat
    assert.deepEqual(state.game.hand, originalHand); // same hand, restored
    assert.equal(state.members.find((m) => m.id === guestId).connected, true);
  } finally {
    host.close();
    guest.close();
    await srv.close();
  }
});

test('chat: messages broadcast, sanitize, and replay as history on join', async () => {
  const srv = await launch();
  const host = connect(srv.url);
  const guest = connect(srv.url);
  try {
    host.emit('create', { name: 'Alice' });
    const [{ code }] = await once(host, 'joined');
    guest.emit('join', { code, name: 'Bob' });
    await once(guest, 'joined');

    const recv = once(guest, 'chat');
    host.emit('chat', { text: '  hello <b>world</b>  ' });
    const [msg] = await recv;
    assert.equal(msg.name, 'Alice');
    assert.equal(msg.text, 'hello bworld/b'); // angle brackets stripped, trimmed
    assert.ok(msg.seatId && typeof msg.ts === 'number');

    const late = connect(srv.url);
    const histP = once(late, 'chatHistory');
    late.emit('join', { code, name: 'Cara' });
    const [history] = await histP;
    assert.ok(Array.isArray(history) && history.length >= 1);
    assert.equal(history[history.length - 1].text, 'hello bworld/b');
    late.close();
  } finally {
    host.close();
    guest.close();
    await srv.close();
  }
});

test('reactions broadcast (with sender id) and reject unlisted emoji', async () => {
  const srv = await launch();
  const host = connect(srv.url);
  const guest = connect(srv.url);
  try {
    host.emit('create', { name: 'Alice' });
    const [{ code, you: hostId }] = await once(host, 'joined');
    guest.emit('join', { code, name: 'Bob' });
    await once(guest, 'joined');

    const recv = once(guest, 'reaction');
    host.emit('reaction', { emoji: '😂' });
    const [r] = await recv;
    assert.equal(r.emoji, '😂');
    assert.equal(r.seatId, hostId);
    assert.equal(r.name, 'Alice');

    let leaked = false;
    guest.on('reaction', () => {
      leaked = true;
    });
    host.emit('reaction', { emoji: '💣' });
    await new Promise((r2) => setTimeout(r2, 150));
    assert.equal(leaked, false);
  } finally {
    host.close();
    guest.close();
    await srv.close();
  }
});
