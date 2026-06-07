/* global io */
const socket = io();

// --- sound effects ---------------------------------------------------------
// All effects are synthesized with the Web Audio API, so there are no audio
// files to ship and everything works offline. Browsers require a user gesture
// before audio can start, so the context is (re)started on the first click.
const Sound = (() => {
  let ctx = null;
  let muted = localStorage.getItem('ld_muted') === '1';

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // A single enveloped oscillator note, optionally sliding in pitch.
  function tone(freq, start, dur, { type = 'sine', gain = 0.2, slideTo } = {}) {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime + start;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  // A short filtered noise burst — used for dice rattling.
  function noise(start, dur, gain = 0.25) {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime + start;
    const frames = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, frames, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const src = c.createBufferSource();
    src.buffer = buf;
    const filter = c.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1800 + Math.random() * 1200;
    const g = c.createGain();
    g.gain.value = gain;
    src.connect(filter).connect(g).connect(c.destination);
    src.start(t0);
  }

  const fx = {
    roll() {
      for (let i = 0; i < 6; i++) noise(i * 0.05 + Math.random() * 0.02, 0.06, 0.22);
    },
    bid() {
      tone(620, 0, 0.07, { type: 'triangle', gain: 0.16 });
    },
    turn() {
      tone(880, 0, 0.1, { type: 'sine', gain: 0.14 });
      tone(1175, 0.09, 0.12, { type: 'sine', gain: 0.12 });
    },
    challenge() {
      tone(300, 0, 0.2, { type: 'sawtooth', gain: 0.2, slideTo: 150 });
    },
    spot() {
      tone(520, 0, 0.09, { type: 'square', gain: 0.14 });
      tone(780, 0.09, 0.12, { type: 'square', gain: 0.14 });
    },
    good() {
      tone(660, 0, 0.1, { type: 'triangle', gain: 0.18 });
      tone(990, 0.1, 0.16, { type: 'triangle', gain: 0.18 });
    },
    lose() {
      tone(420, 0, 0.16, { type: 'triangle', gain: 0.2, slideTo: 150 });
    },
    win() {
      [523, 659, 784, 1047].forEach((f, i) =>
        tone(f, i * 0.13, 0.2, { type: 'triangle', gain: 0.22 })
      );
    },
    defeat() {
      tone(330, 0, 0.2, { type: 'sawtooth', gain: 0.2 });
      tone(220, 0.18, 0.3, { type: 'sawtooth', gain: 0.2, slideTo: 120 });
    },
    error() {
      tone(180, 0, 0.12, { type: 'square', gain: 0.14 });
    },
  };

  return {
    play(name) {
      if (muted) return;
      try {
        (fx[name] || (() => {}))();
      } catch {
        /* audio not available — ignore */
      }
    },
    toggleMute() {
      muted = !muted;
      localStorage.setItem('ld_muted', muted ? '1' : '0');
      return muted;
    },
    isMuted() {
      return muted;
    },
    unlock() {
      try {
        ensure();
      } catch {
        /* ignore */
      }
    },
  };
})();

// Start/resume the audio context on the first user interaction.
document.addEventListener('click', () => Sound.unlock());

// Mute toggle button.
const muteBtn = document.getElementById('muteBtn');
function paintMute() {
  muteBtn.textContent = Sound.isMuted() ? '🔇' : '🔊';
}
paintMute();
muteBtn.onclick = () => {
  const nowMuted = Sound.toggleMute();
  paintMute();
  if (!nowMuted) Sound.play('bid'); // little confirmation blip when unmuting
};

// Compare the previous and next game state to decide which effects to play.
function detectSounds(prev, state) {
  const g = state.game;
  if (!g) return;
  const pg = prev && prev.game;

  // Game just started -> roll the dice.
  if (!pg) {
    Sound.play('roll');
    return;
  }

  // A fresh round was dealt.
  if (g.roundNumber > pg.roundNumber && g.phase === 'playing') {
    Sound.play('roll');
    return;
  }

  // Showdown via challenge or spot-on call.
  if ((g.phase === 'reveal' || g.phase === 'gameover') && pg.phase === 'playing' && g.lastReveal) {
    const r = g.lastReveal;
    Sound.play(r.kind === 'spot-on' ? 'spot' : 'challenge');
    const iLost = r.losers.includes(me);
    if (g.phase === 'gameover') {
      setTimeout(() => Sound.play(g.winnerId === me ? 'win' : 'defeat'), 420);
    } else {
      setTimeout(() => Sound.play(iLost ? 'lose' : 'good'), 320);
    }
    return;
  }

  // A bid was placed or raised.
  const b = g.currentBid;
  const pb = pg.currentBid;
  const bidChanged =
    b && (!pb || b.playerId !== pb.playerId || b.quantity !== pb.quantity || b.face !== pb.face);
  if (bidChanged && g.phase === 'playing') Sound.play('bid');

  // It just became your turn.
  if (g.phase === 'playing' && g.turnId === me && pg.turnId !== me) Sound.play('turn');
}

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
socket.on('errorMsg', (msg) => {
  Sound.play('error');
  toast(msg);
});
socket.on('state', (state) => {
  const prev = lastState;
  lastState = state;
  detectSounds(prev, state);
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

    // The player's current standing bid, shown next to their name and
    // overwritten whenever they bid again.
    if (p.lastBid && !p.eliminated) {
      const chip = document.createElement('span');
      chip.className = 'bid-chip';
      const qty = document.createElement('span');
      qty.textContent = `${p.lastBid.quantity} ×`;
      chip.appendChild(qty);
      chip.appendChild(dieEl(p.lastBid.face, { small: true }));
      row.appendChild(chip);
    }

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
