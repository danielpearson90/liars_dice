// End-to-end test of the socket layer: two real clients connect to a freshly
// launched server, create/join a room, start a game, and play a full round.
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
    close: () =>
      new Promise((resolve) => server.close(resolve)),
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

test('two clients can create, join, start, and play a round', async () => {
  const srv = await launch();
  const host = connect(srv.url);
  const guest = connect(srv.url);

  try {
    // Host creates a room.
    host.emit('create', { name: 'Alice' });
    const [{ code, you: hostId }] = await once(host, 'joined');
    assert.match(code, /^[A-Z0-9]{4}$/);

    // Guest joins it.
    const guestState = waitState(guest, (s) => s.members.length === 2);
    guest.emit('join', { code, name: 'Bob' });
    const [{ you: guestId }] = await once(guest, 'joined');
    await guestState;

    // Host starts the game; both clients should see a playing game.
    const hostPlaying = waitState(host, (s) => s.game && s.game.phase === 'playing');
    host.emit('start');
    const started = await hostPlaying;

    // Host can only see its own dice, not the guest's.
    const hostSelf = started.game.players.find((p) => p.isYou);
    const hostOther = started.game.players.find((p) => !p.isYou);
    assert.equal(hostSelf.dice.length, 5);
    assert.equal(hostOther.dice, null);

    // It's the first player's turn. Figure out who that is and bid.
    const firstId = started.game.turnId;
    const firstSock = firstId === hostId ? host : guest;
    const secondSock = firstId === hostId ? guest : host;

    const afterBid = waitState(secondSock, (s) => s.game.currentBid !== null);
    firstSock.emit('bid', { quantity: 1, face: 2 });
    const bidState = await afterBid;
    assert.equal(bidState.game.currentBid.quantity, 1);
    assert.equal(bidState.game.turnId, firstId === hostId ? guestId : hostId);

    // Second player challenges; both should land in a reveal with all dice shown.
    const afterReveal = waitState(host, (s) => s.game.phase === 'reveal');
    secondSock.emit('challenge');
    const revealState = await afterReveal;
    assert.ok(revealState.game.lastReveal);
    // Every active player's dice are now visible.
    for (const p of revealState.game.players) {
      assert.ok(Array.isArray(p.dice), 'dice revealed for ' + p.name);
    }
    // Exactly one die was lost across the table (10 -> 9).
    assert.equal(revealState.game.totalDice, 9);
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

test('chat: messages broadcast, sanitize, and replay as history on join', async () => {
  const srv = await launch();
  const host = connect(srv.url);
  const guest = connect(srv.url);
  try {
    host.emit('create', { name: 'Alice' });
    const [{ code }] = await once(host, 'joined');
    guest.emit('join', { code, name: 'Bob' });
    await once(guest, 'joined');

    // Host sends a message with an HTML tag; guest should receive it sanitized.
    const recv = once(guest, 'chat');
    host.emit('chat', { text: '  hello <b>world</b>  ' });
    const [msg] = await recv;
    assert.equal(msg.name, 'Alice');
    assert.equal(msg.text, 'hello bworld/b'); // angle brackets stripped, trimmed
    assert.ok(msg.seatId && typeof msg.ts === 'number');

    // A third client joining gets the backlog via chatHistory.
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

test('reveal advances only once every human is ready', async () => {
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

    const started = waitState(host, (s) => s.game && s.game.phase === 'playing');
    host.emit('start');
    const s0 = await started;

    // Drive to a reveal: whoever leads bids, the other challenges.
    const first = s0.game.turnId === hostId ? host : guest;
    const second = s0.game.turnId === hostId ? guest : host;
    const afterBid = waitState(second, (s) => s.game.currentBid !== null);
    first.emit('bid', { quantity: 1, face: 2 });
    await afterBid;
    const revealed = waitState(host, (s) => s.game.phase === 'reveal');
    second.emit('challenge');
    const round = (await revealed).game.roundNumber;

    // One ready: still waiting (2 required), count reflects it.
    const oneReady = waitState(host, (s) => (s.game.readyIds || []).length === 1);
    host.emit('ready', { ready: true });
    assert.equal((await oneReady).game.phase, 'reveal');

    // Second ready: the round advances.
    const advanced = waitState(
      host,
      (s) => s.game.phase === 'playing' && s.game.roundNumber === round + 1
    );
    guest.emit('ready', { ready: true });
    await advanced;
  } finally {
    host.close();
    guest.close();
    await srv.close();
  }
});

test('reveal auto-advances after the timeout even if nobody readies', async () => {
  const prev = process.env.REVEAL_TIMEOUT_MS;
  process.env.REVEAL_TIMEOUT_MS = '250'; // read at schedule time
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

    const started = waitState(host, (s) => s.game && s.game.phase === 'playing');
    host.emit('start');
    const s0 = await started;
    const first = s0.game.turnId === hostId ? host : guest;
    const second = s0.game.turnId === hostId ? guest : host;
    const afterBid = waitState(second, (s) => s.game.currentBid !== null);
    first.emit('bid', { quantity: 1, face: 2 });
    await afterBid;
    const revealed = waitState(host, (s) => s.game.phase === 'reveal');
    second.emit('challenge');
    const round = (await revealed).game.roundNumber;

    // Nobody readies — the timeout alone advances the round.
    await waitState(host, (s) => s.game.phase === 'playing' && s.game.roundNumber === round + 1);
  } finally {
    host.close();
    guest.close();
    await srv.close();
    if (prev === undefined) delete process.env.REVEAL_TIMEOUT_MS;
    else process.env.REVEAL_TIMEOUT_MS = prev;
  }
});
