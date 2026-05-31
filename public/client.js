/* global io */
const socket = io();

// --- DOM helpers -----------------------------------------------------------
const $ = (id) => document.getElementById(id);
const screens = { home: $('home'), lobby: $('lobby'), game: $('game') };

function show(name) {
  for (const [key, el] of Object.entries(screens)) {
    el.classList.toggle('hidden', key !== name);
  }
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

// --- local UI state --------------------------------------------------------
let me = null; // socket id once joined
let lastState = null; // most recent room view
const bid = { quantity: 1, face: 2 };

// Pip layout per die value.
const PIPS = {
  1: ['pc'],
  2: ['p1', 'p6'],
  3: ['p1', 'pc', 'p6'],
  4: ['p1', 'p2', 'p5', 'p6'],
  5: ['p1', 'p2', 'pc', 'p5', 'p6'],
  6: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
};

function dieEl(value, { small = false, highlight = false } = {}) {
  const d = document.createElement('div');
  d.className = 'die' + (small ? ' small' : '') + (highlight ? ' hl' : '');
  for (const cls of PIPS[value] || []) {
    const pip = document.createElement('div');
    pip.className = 'pip ' + cls;
    d.appendChild(pip);
  }
  return d;
}

// --- home screen -----------------------------------------------------------
$('createBtn').onclick = () => socket.emit('create', { name: $('name').value });
$('joinBtn').onclick = () =>
  socket.emit('join', { code: $('code').value, name: $('name').value });

// Prefill room code & name from URL (?room=ABCD) and localStorage.
const params = new URLSearchParams(location.search);
if (params.get('room')) $('code').value = params.get('room').toUpperCase();
$('name').value = localStorage.getItem('ld_name') || '';
$('name').oninput = () => localStorage.setItem('ld_name', $('name').value.trim());

// --- lobby -----------------------------------------------------------------
$('startBtn').onclick = () => socket.emit('start');
$('leaveLobby').onclick = leave;
$('copyCode').onclick = () => {
  const url = `${location.origin}/?room=${lastState.code}`;
  navigator.clipboard?.writeText(url).then(
    () => toastOk('Invite link copied!'),
    () => toastOk(url)
  );
};
function toastOk(msg) {
  const t = $('toast');
  t.style.background = 'var(--good)';
  t.style.color = '#062c1b';
  toast(msg);
  setTimeout(() => {
    t.style.background = '';
    t.style.color = '';
  }, 3300);
}

// --- game controls ---------------------------------------------------------
$('bidBtn').onclick = () => socket.emit('bid', { quantity: bid.quantity, face: bid.face });
$('challengeBtn').onclick = () => socket.emit('challenge');
$('spotBtn').onclick = () => socket.emit('spotOn');
$('nextRoundBtn').onclick = () => socket.emit('nextRound');
$('rematchBtn').onclick = () => socket.emit('rematch');
$('leaveGame').onclick = leave;

document.querySelectorAll('[data-step="qty"]').forEach((btn) => {
  btn.onclick = () => {
    bid.quantity = Math.max(1, bid.quantity + Number(btn.dataset.dir));
    renderControls(lastState.game);
  };
});

function leave() {
  socket.emit('leave');
  me = null;
  lastState = null;
  history.replaceState(null, '', location.pathname);
  show('home');
}

// --- socket events ---------------------------------------------------------
socket.on('joined', ({ code, you }) => {
  me = you;
  history.replaceState(null, '', `/?room=${code}`);
});
socket.on('errorMsg', (msg) => toast(msg));
socket.on('state', (state) => {
  lastState = state;
  render(state);
});

// --- rendering -------------------------------------------------------------
function render(state) {
  if (!state.game) {
    renderLobby(state);
    show('lobby');
  } else {
    renderGame(state);
    show('game');
  }
}

function renderLobby(state) {
  $('lobbyCode').textContent = state.code;
  const list = $('memberList');
  list.innerHTML = '';
  for (const m of state.members) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = m.name;
    li.appendChild(name);
    const tags = document.createElement('span');
    tags.className = 'tags';
    if (m.isHost) tags.appendChild(badge('Host'));
    if (m.isYou) tags.appendChild(badge('You', 'you'));
    li.appendChild(tags);
    list.appendChild(li);
  }
  const amHost = state.hostId === me;
  const enough = state.members.length >= 2;
  $('startBtn').classList.toggle('hidden', !amHost);
  $('startBtn').disabled = !enough;
  $('lobbyHint').textContent = amHost
    ? enough
      ? 'Everyone in? Hit start.'
      : 'Waiting for at least one more player…'
    : 'Waiting for the host to start the game.';
}

function badge(text, cls = '') {
  const b = document.createElement('span');
  b.className = 'badge ' + cls;
  b.textContent = text;
  return b;
}

function renderGame(state) {
  const g = state.game;
  $('roundLabel').textContent = `Round ${g.roundNumber}`;
  $('bidLabel').textContent = g.currentBid
    ? `Bid: ${g.currentBid.quantity} × ${faceName(g.currentBid.face)}`
    : 'No bid yet';
  $('bidLabel').classList.toggle('hidden', false);

  renderPlayers(state);
  renderMyDice(g);
  renderReveal(g);

  const myTurn = g.phase === 'playing' && g.turnId === me;
  $('controls').classList.toggle('hidden', !myTurn);
  if (myTurn) renderControls(g);

  $('revealActions').classList.toggle('hidden', g.phase !== 'reveal');

  const over = g.phase === 'gameover';
  $('gameOver').classList.toggle('hidden', !over);
  if (over) {
    const winner = g.players.find((p) => p.id === g.winnerId);
    $('winnerText').textContent = winner
      ? `🏆 ${winner.isYou ? 'You win!' : winner.name + ' wins!'}`
      : 'Game over';
    $('rematchBtn').classList.toggle('hidden', state.hostId !== me);
  }
}

function renderPlayers(state) {
  const g = state.game;
  const box = $('players');
  box.innerHTML = '';
  for (const p of g.players) {
    const row = document.createElement('div');
    row.className = 'player';
    if (g.turnId === p.id && g.phase === 'playing') row.classList.add('turn');
    if (p.eliminated) row.classList.add('out');

    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = p.name + (p.isYou ? ' (you)' : '');
    row.appendChild(name);

    const tags = document.createElement('span');
    tags.className = 'tags';
    if (state.hostId === p.id) tags.appendChild(badge('Host'));
    if (p.eliminated) tags.appendChild(badge('Out', 'off'));
    row.appendChild(tags);

    const dots = document.createElement('span');
    dots.className = 'dot-count';
    for (let i = 0; i < p.diceCount; i++) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dots.appendChild(dot);
    }
    const label = document.createElement('span');
    label.style.marginLeft = '6px';
    label.style.color = 'var(--muted)';
    label.textContent = `${p.diceCount}`;
    dots.appendChild(label);
    row.appendChild(dots);

    box.appendChild(row);
  }
}

function renderMyDice(g) {
  const box = $('myDice');
  box.innerHTML = '';
  const you = g.players.find((p) => p.isYou);
  if (!you || !you.dice || you.eliminated) return;
  for (const v of you.dice) box.appendChild(dieEl(v));
}

function renderControls(g) {
  $('qtyVal').textContent = bid.quantity;
  const picker = $('facePicker');
  picker.innerHTML = '';
  for (let f = 1; f <= 6; f++) {
    const opt = document.createElement('div');
    opt.className = 'face-opt' + (bid.face === f ? ' sel' : '');
    opt.appendChild(dieEl(f, { small: true }));
    opt.onclick = () => {
      bid.face = f;
      renderControls(g);
    };
    picker.appendChild(opt);
  }
  // A challenge / spot-on is only possible once a bid exists.
  const hasBid = !!g.currentBid;
  $('challengeBtn').disabled = !hasBid;
  $('spotBtn').disabled = !hasBid;
}

function renderReveal(g) {
  const box = $('reveal');
  const showReveal = (g.phase === 'reveal' || g.phase === 'gameover') && g.lastReveal;
  box.classList.toggle('hidden', !showReveal);
  if (!showReveal) return;

  const r = g.lastReveal;
  box.innerHTML = '';
  const h = document.createElement('h3');
  h.textContent =
    r.kind === 'spot-on' ? 'Spot-on call!' : 'Challenge!';
  box.appendChild(h);

  const caller = name(g, r.callerId);
  const result = document.createElement('div');
  result.className = 'result';
  const bidStr = `${r.quantity} × ${faceName(r.face)}`;
  if (r.kind === 'challenge') {
    const bidGood = r.actual >= r.quantity;
    result.classList.add(bidGood ? 'bad' : 'good');
    result.innerHTML =
      `${caller} challenged <b>${bidStr}</b>.<br>` +
      `There ${r.actual === 1 ? 'was' : 'were'} <b>${r.actual}</b> ` +
      `${faceName(r.face)}${r.actual === 1 ? '' : 's'}. ` +
      (bidGood ? 'The bid held — challenger loses a die.' : 'It was a lie — bidder loses a die.');
  } else {
    result.classList.add(r.exact ? 'good' : 'bad');
    result.innerHTML =
      `${caller} called spot-on for <b>${bidStr}</b>.<br>` +
      `There ${r.actual === 1 ? 'was' : 'were'} <b>${r.actual}</b> ` +
      `${faceName(r.face)}${r.actual === 1 ? '' : 's'}. ` +
      (r.exact ? 'Exactly right — everyone else loses a die!' : 'Not exact — caller loses a die.');
  }
  box.appendChild(result);

  for (const entry of r.dice) {
    const row = document.createElement('div');
    row.className = 'reveal-row';
    const nm = document.createElement('span');
    nm.className = 'pname';
    nm.textContent = entry.name;
    row.appendChild(nm);
    for (const v of entry.dice) {
      row.appendChild(dieEl(v, { small: true, highlight: v === r.face }));
    }
    box.appendChild(row);
  }
}

function name(g, id) {
  const p = g.players.find((x) => x.id === id);
  return p ? (p.isYou ? 'You' : p.name) : 'Someone';
}

function faceName(f) {
  return ['', 'one', 'two', 'three', 'four', 'five', 'six'][f] || f;
}
