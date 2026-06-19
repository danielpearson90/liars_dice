/* global io */
import { pAtLeast } from './probability.js';
import { bidKey, callKey } from './tts-keys.js';

const socket = io();
const MAX_STARTING_DICE = 20;
const MAX_PLAYERS = 11; // mirrors the server cap (for disabling the Add bot button)

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

// --- spoken announcements --------------------------------------------------
// Plays pre-generated Google Cloud TTS clips when available (see
// scripts/gen-tts.mjs), and otherwise falls back to the browser's built-in
// speech synthesis. Either way it stays entirely client-side.
const Speech = (() => {
  const ttsCapable = typeof window !== 'undefined' && 'speechSynthesis' in window;
  let on = localStorage.getItem('ld_speech') === '1';
  let voice = null;
  let clipKeys = null; // Set of available clip keys, once the manifest loads
  let clipExt = 'mp3'; // clip file extension from the manifest (mp3 or wav)
  let readyCb = null; // notified after the clip manifest has been checked
  const clipCache = new Map(); // key -> preloaded Audio

  function pickVoice() {
    if (!ttsCapable) return;
    const voices = window.speechSynthesis.getVoices();
    // Prefer a natural-sounding English voice (Chrome/Android ship good ones).
    voice =
      voices.find((v) => /^en[-_]/i.test(v.lang) && /google|natural|neural/i.test(v.name)) ||
      voices.find((v) => /^en[-_]/i.test(v.lang)) ||
      voices[0] ||
      null;
  }
  if (ttsCapable) {
    pickVoice();
    window.speechSynthesis.onvoiceschanged = pickVoice;
  }

  // Load the clip manifest (if clips were generated). Failure is fine — we just
  // use the browser voice.
  fetch('tts/manifest.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => {
      if (m && Array.isArray(m.keys)) {
        clipKeys = new Set(m.keys);
        if (m.ext) clipExt = m.ext;
      }
    })
    .catch(() => {})
    .finally(() => readyCb && readyCb());

  function speakBrowser(text) {
    if (!ttsCapable) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      if (voice) u.voice = voice;
      u.rate = 1;
      u.pitch = 1;
      window.speechSynthesis.speak(u);
    } catch {
      /* ignore */
    }
  }

  function playClip(key) {
    let audio = clipCache.get(key);
    if (!audio) {
      audio = new Audio(`tts/${key}.${clipExt}`);
      clipCache.set(key, audio);
    }
    audio.currentTime = 0;
    audio.play().catch(() => {}); // ignore autoplay blocks before a gesture
  }

  // Speak `text`, preferring the pre-rendered clip `key` when it exists.
  function say(text, key) {
    if (!on) return;
    if (key && clipKeys && clipKeys.has(key)) playClip(key);
    else speakBrowser(text);
  }

  return {
    // Voice is usable if the browser can synthesize OR clips are available.
    get available() {
      return ttsCapable || (clipKeys && clipKeys.size > 0);
    },
    say,
    isOn: () => on,
    onReady(cb) {
      readyCb = cb;
    },
    toggle() {
      on = !on;
      localStorage.setItem('ld_speech', on ? '1' : '0');
      if (!on && ttsCapable) window.speechSynthesis.cancel();
      return on;
    },
  };
})();

// Phrase a bid the way it's spoken/written, e.g. "4 fours", "1 six".
function spokenBid(quantity, face) {
  return `${quantity} ${faceName(face)}${quantity === 1 ? '' : 's'}`;
}

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

// Voice toggle button. Hidden only if neither browser speech nor clips work;
// it un-hides itself if clips load after first paint.
const speechBtn = document.getElementById('speechBtn');
function paintSpeech() {
  speechBtn.classList.toggle('hidden', !Speech.available);
  speechBtn.classList.toggle('btn-off', !Speech.isOn());
  speechBtn.title = Speech.isOn() ? 'Voice on' : 'Voice off';
}
paintSpeech();
Speech.onReady(paintSpeech); // re-check once the clip manifest resolves
speechBtn.onclick = () => {
  const nowOn = Speech.toggle();
  paintSpeech();
  if (nowOn) Speech.say('spot on', callKey('spot-on')); // confirm it works
};

// --- room chat -------------------------------------------------------------
const chatBtn = document.getElementById('chatBtn');
const chatPanel = document.getElementById('chatPanel');
const chatLog = document.getElementById('chatLog');
const chatInput = document.getElementById('chatInput');
const chatUnread = document.getElementById('chatUnread');
let chatOpen = false;
let unread = 0;

function showChatButton(on) {
  if (!chatBtn) return;
  chatBtn.classList.toggle('hidden', !on);
  if (!on) {
    chatPanel.classList.add('hidden');
    chatLog.innerHTML = '';
    chatOpen = false;
    setUnread(0);
  }
}
function setUnread(n) {
  if (!chatUnread) return;
  unread = n;
  chatUnread.textContent = n > 9 ? '9+' : String(n);
  chatUnread.classList.toggle('hidden', n === 0);
}
function openChat(open) {
  if (!chatPanel) return;
  chatOpen = open;
  chatPanel.classList.toggle('hidden', !open);
  if (open) {
    setUnread(0);
    chatLog.scrollTop = chatLog.scrollHeight;
    chatInput.focus();
  }
}
function appendChatMessage(msg) {
  if (!chatLog) return;
  const atBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 40;
  const row = document.createElement('div');
  row.className = 'chat-msg' + (msg.seatId === me ? ' mine' : '');
  const who = document.createElement('span');
  who.className = 'chat-who';
  who.textContent = (msg.seatId === me ? 'You' : msg.name) + ': ';
  const body = document.createElement('span');
  body.textContent = msg.text; // textContent → XSS-safe
  row.append(who, body);
  chatLog.appendChild(row);
  if (chatOpen && atBottom) chatLog.scrollTop = chatLog.scrollHeight;
}

if (chatBtn) {
  chatBtn.onclick = () => openChat(!chatOpen);
  document.getElementById('chatClose').onclick = () => openChat(false);
  document.getElementById('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    socket.emit('chat', { text });
    chatInput.value = '';
  };
}

socket.on('chatHistory', (msgs) => {
  chatLog.innerHTML = '';
  (msgs || []).forEach(appendChatMessage);
  chatLog.scrollTop = chatLog.scrollHeight;
});
socket.on('chat', (msg) => {
  appendChatMessage(msg);
  if (!chatOpen && msg.seatId !== me) {
    setUnread(unread + 1);
    Sound.play('bid'); // subtle ping
  }
});

// --- theme switcher --------------------------------------------------------
const THEMES = ['theme-tavern', 'theme-midnight', 'theme-neon', 'theme-deco', 'theme-noir', 'theme-pixel'];
const themeSelect = document.getElementById('themeSelect');
function applyTheme(name) {
  if (!THEMES.includes(name)) name = THEMES[0];
  document.body.classList.remove(...THEMES);
  document.body.classList.add(name);
  themeSelect.value = name;
  localStorage.setItem('ld_theme', name);
}
applyTheme(localStorage.getItem('ld_theme') || 'theme-tavern');
themeSelect.onchange = () => applyTheme(themeSelect.value);

// Populate per-theme atmosphere particles once. CSS shows each set only under
// its own theme, so they cost nothing while another theme is active.
(function seedAtmosphere() {
  const embers = document.querySelector('.embers');
  if (embers) {
    for (let i = 0; i < 16; i++) {
      const e = document.createElement('span');
      const size = 2 + Math.random() * 4;
      e.style.left = `${Math.random() * 100}%`;
      e.style.width = e.style.height = `${size}px`;
      e.style.animationDuration = `${7 + Math.random() * 8}s`;
      e.style.animationDelay = `${-Math.random() * 12}s`;
      embers.appendChild(e);
    }
  }
  const stars = document.querySelector('.stars');
  if (stars) {
    for (let i = 0; i < 80; i++) {
      const s = document.createElement('span');
      const size = 1 + Math.random() * 2;
      s.style.left = `${Math.random() * 100}%`;
      s.style.top = `${Math.random() * 100}%`;
      s.style.width = s.style.height = `${size}px`;
      s.style.animationDuration = `${2.5 + Math.random() * 4}s`;
      s.style.animationDelay = `${-Math.random() * 6}s`;
      stars.appendChild(s);
    }
  }
})();

// --- win confetti ----------------------------------------------------------
// Lightweight canvas burst, themed with the current accent colors. No deps.
function confetti() {
  const canvas = document.getElementById('confetti');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  ctx.scale(dpr, dpr);

  const css = getComputedStyle(document.body);
  const colors = ['--accent', '--accent-2', '--good', '--warn', '--text']
    .map((v) => css.getPropertyValue(v).trim())
    .filter(Boolean);

  const N = 160;
  const parts = Array.from({ length: N }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 120,
    y: innerHeight / 3,
    vx: (Math.random() - 0.5) * 11,
    vy: Math.random() * -11 - 4,
    g: 0.28 + Math.random() * 0.12,
    size: 5 + Math.random() * 6,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    color: colors[(Math.random() * colors.length) | 0] || '#fff',
  }));

  const start = performance.now();
  const DURATION = 2600;
  function frame(now) {
    const t = now - start;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += p.g;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = Math.max(0, 1 - t / DURATION);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    }
    if (t < DURATION) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, innerWidth, innerHeight);
  }
  requestAnimationFrame(frame);
}

// Set when a fresh roll happens, consumed by renderMyDice to animate the dice.
let pendingRoll = false;

// Compare the previous and next game state to decide which effects to play.
function detectSounds(prev, state) {
  const g = state.game;
  if (!g) return;
  const pg = prev && prev.game;

  // Game just started -> roll the dice.
  if (!pg) {
    Sound.play('roll');
    pendingRoll = true;
    return;
  }

  // A fresh round was dealt.
  if (g.roundNumber > pg.roundNumber && g.phase === 'playing') {
    Sound.play('roll');
    pendingRoll = true;
    return;
  }

  // Showdown via challenge or spot-on call.
  if ((g.phase === 'reveal' || g.phase === 'gameover') && pg.phase === 'playing' && g.lastReveal) {
    const r = g.lastReveal;
    Sound.play(r.kind === 'spot-on' ? 'spot' : 'challenge');
    const call = r.kind === 'spot-on' ? 'spot-on' : 'liar';
    Speech.say(call === 'spot-on' ? 'spot on' : 'liar', callKey(call));
    const iLost = r.losers.includes(me);
    if (g.phase === 'gameover') {
      setTimeout(() => Sound.play(g.winnerId === me ? 'win' : 'defeat'), 420);
      confetti(); // celebrate the winner on everyone's screen
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
  if (bidChanged && g.phase === 'playing') {
    Sound.play('bid');
    Speech.say(spokenBid(b.quantity, b.face), bidKey(b.quantity, b.face));
  }

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
// Current bid being built. Both start unselected each turn (see renderGame).
const bid = { quantity: null, face: null };
let activeTurnKey = null; // identifies the turn the current selection belongs to
let sortDice = localStorage.getItem('ld_sortdice') === '1'; // show own dice sorted

// Sort-your-dice toggle (display only — never sent to the server).
const sortDiceBtn = document.getElementById('sortDiceBtn');
function paintSortDice() {
  if (!sortDiceBtn) return;
  sortDiceBtn.classList.toggle('active', sortDice);
  sortDiceBtn.title = sortDice ? 'Showing sorted — tap for roll order' : 'Sort ascending';
}
if (sortDiceBtn) {
  paintSortDice();
  sortDiceBtn.onclick = () => {
    sortDice = !sortDice;
    localStorage.setItem('ld_sortdice', sortDice ? '1' : '0');
    paintSortDice();
    if (lastState && lastState.game) renderMyDice(lastState.game);
  };
}

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

// --- identity & reconnection ----------------------------------------------
// A stable private token identifies this player across reconnects. The server
// keys seats by it, so a refresh or dropped connection reclaims the same seat.
const token = (() => {
  let t = localStorage.getItem('ld_pid');
  if (!t) {
    t = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
    localStorage.setItem('ld_pid', t);
  }
  return t;
})();
let myName = localStorage.getItem('ld_name') || '';
let reconnectTarget = localStorage.getItem('ld_room') || null; // room to auto-rejoin
let autoRejoining = false;

function rememberRoom(code) {
  reconnectTarget = code;
  localStorage.setItem('ld_room', code);
}
function forgetRoom() {
  reconnectTarget = null;
  autoRejoining = false;
  localStorage.removeItem('ld_room');
}

// --- home screen -----------------------------------------------------------
$('createBtn').onclick = () => {
  myName = $('name').value;
  socket.emit('create', { name: myName, token });
};
$('joinBtn').onclick = () => {
  myName = $('name').value;
  socket.emit('join', { code: $('code').value, name: myName, token });
};

// Prefill room code & name from URL (?room=ABCD) and localStorage.
const params = new URLSearchParams(location.search);
if (params.get('room')) $('code').value = params.get('room').toUpperCase();
$('name').value = myName;
$('name').oninput = () => {
  myName = $('name').value.trim();
  localStorage.setItem('ld_name', myName);
};

// --- lobby -----------------------------------------------------------------
$('startBtn').onclick = () => socket.emit('start');
$('leaveLobby').onclick = leave;

// Host-only game settings. Edits are sent to the server, which validates and
// broadcasts them back so every member's lobby stays in sync.
function currentDice() {
  return (lastState && lastState.settings && lastState.settings.startingDice) || 5;
}
$('diceDown').onclick = () =>
  socket.emit('updateSettings', { startingDice: Math.max(1, currentDice() - 1) });
$('diceUp').onclick = () =>
  socket.emit('updateSettings', { startingDice: Math.min(MAX_STARTING_DICE, currentDice() + 1) });
$('probToggle').onchange = (e) =>
  socket.emit('updateSettings', { showProbability: e.target.checked });
$('rulesetSelect').onchange = (e) =>
  socket.emit('updateSettings', { ruleset: e.target.value });
$('addBotBtn').onclick = () => socket.emit('addBot');
$('removeBotBtn').onclick = () => socket.emit('removeBot');
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
$('bidBtn').onclick = () => {
  if (bid.quantity == null || bid.face == null) return;
  socket.emit('bid', { quantity: bid.quantity, face: bid.face });
};
$('challengeBtn').onclick = () => socket.emit('challenge');
$('spotBtn').onclick = () => socket.emit('spotOn');
const readyBtn = $('readyBtn');
if (readyBtn) {
  readyBtn.onclick = () => {
    const g = lastState && lastState.game;
    if (!g) return;
    const amReady = (g.readyIds || []).includes(me);
    socket.emit('ready', { ready: !amReady }); // toggle
  };
}
$('rematchBtn').onclick = () => socket.emit('rematch');
$('leaveGame').onclick = leave;

// The lowest and highest quantity that would be a legal bid for `face`,
// given the current bid on the table. A face is unbiddable when min > max.
function bidRange(g, face) {
  const max = g.totalDice;
  if (!g.currentBid) return { min: 1, max };
  // Same-or-lower face must beat the quantity; a higher face may match it.
  const min = face > g.currentBid.face ? g.currentBid.quantity : g.currentBid.quantity + 1;
  return { min, max };
}

function faceValid(g, face) {
  const { min, max } = bidRange(g, face);
  return min <= max;
}

document.querySelectorAll('[data-step="qty"]').forEach((btn) => {
  btn.onclick = () => {
    const g = lastState && lastState.game;
    if (!g || bid.face == null) return; // pick a face first
    const { min, max } = bidRange(g, bid.face);
    const base = bid.quantity == null ? min : bid.quantity;
    bid.quantity = Math.min(max, Math.max(min, base + Number(btn.dataset.dir)));
    renderControls(g);
  };
});

function leave() {
  socket.emit('leave');
  me = null;
  lastState = null;
  forgetRoom();
  showChatButton(false);
  history.replaceState(null, '', location.pathname);
  show('home');
}

function setNetStatus(text) {
  const el = $('netStatus');
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
}

// --- socket events ---------------------------------------------------------
// On every (re)connection, automatically reclaim our seat if we were in a room.
socket.on('connect', () => {
  setNetStatus('');
  if (reconnectTarget && myName) {
    autoRejoining = true;
    socket.emit('join', { code: reconnectTarget, name: myName, token });
  }
});
socket.on('disconnect', () => {
  if (reconnectTarget) setNetStatus('Connection lost — reconnecting…');
});

socket.on('joined', ({ code, you }) => {
  me = you;
  autoRejoining = false;
  rememberRoom(code);
  showChatButton(true);
  history.replaceState(null, '', `/?room=${code}`);
});
socket.on('errorMsg', (msg) => {
  // If an automatic rejoin fails (e.g. the room is gone after a restart), drop
  // the stale target and fall back to the home screen instead of nagging.
  if (autoRejoining && !lastState) {
    forgetRoom();
    setNetStatus('');
    show('home');
    return;
  }
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
    if (m.isBot) tags.appendChild(badge('🤖 Bot', 'bot'));
    if (m.isYou) tags.appendChild(badge('You', 'you'));
    li.appendChild(tags);
    list.appendChild(li);
  }
  const amHost = state.hostId === me;
  const enough = state.members.length >= 2;
  const botCount = state.members.filter((m) => m.isBot).length;
  $('startBtn').classList.toggle('hidden', !amHost);
  $('startBtn').disabled = !enough;

  // Bot controls (host only).
  $('botControls').classList.toggle('hidden', !amHost);
  $('addBotBtn').disabled = state.members.length >= MAX_PLAYERS;
  $('removeBotBtn').disabled = botCount === 0;
  $('lobbyHint').textContent = amHost
    ? enough
      ? 'Everyone in? Hit start.'
      : 'Waiting for at least one more player…'
    : 'Waiting for the host to start the game.';

  // Reflect current settings; only the host can change them.
  const s = state.settings || { startingDice: 5, showProbability: false, ruleset: '' };

  // Ruleset selector — options come from the server so they can't drift.
  const rs = $('rulesetSelect');
  if (rs.options.length === 0 && state.rulesets) {
    for (const r of state.rulesets) {
      const o = document.createElement('option');
      o.value = r.id;
      o.textContent = r.name;
      rs.appendChild(o);
    }
  }
  rs.value = s.ruleset;
  rs.disabled = !amHost;
  const chosen = (state.rulesets || []).find((r) => r.id === s.ruleset);
  $('rulesetDesc').textContent = chosen ? chosen.desc : '';

  $('diceVal').firstElementChild.textContent = s.startingDice;
  $('probToggle').checked = !!s.showProbability;
  for (const el of [$('diceDown'), $('diceUp'), $('probToggle')]) el.disabled = !amHost;
  $('diceDown').disabled = !amHost || s.startingDice <= 1;
  $('diceUp').disabled = !amHost || s.startingDice >= MAX_STARTING_DICE;
  $('settingsHint').textContent = amHost
    ? 'Only you can change these.'
    : 'The host sets these options.';
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

  renderPlayers(state);
  renderCurrentBid(state);
  renderMyDice(g);
  renderReveal(g);

  const myTurn = g.phase === 'playing' && g.turnId === me;
  // Clear any leftover selection once at the start of each of your turns, so
  // nothing is pre-picked when the controls appear.
  const turnKey = `${g.roundNumber}:${g.turnId}`;
  if (myTurn && turnKey !== activeTurnKey) {
    activeTurnKey = turnKey;
    bid.quantity = null;
    bid.face = null;
  }
  $('controls').classList.toggle('hidden', !myTurn);
  if (myTurn) renderControls(g);

  renderReadyControls(state);

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
  // Seats whose player is currently disconnected (awaiting reconnect).
  const away = new Set((state.members || []).filter((m) => !m.connected).map((m) => m.id));
  const bots = new Set((state.members || []).filter((m) => m.isBot).map((m) => m.id));
  const ready = g.phase === 'reveal' ? new Set(g.readyIds || []) : null;
  for (const p of g.players) {
    const row = document.createElement('div');
    row.className = 'player';
    if (g.turnId === p.id && g.phase === 'playing') row.classList.add('turn');
    if (p.eliminated) row.classList.add('out');
    const isAway = away.has(p.id) && !p.eliminated;
    if (isAway) row.classList.add('away');

    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = p.name + (p.isYou ? ' (you)' : '');
    row.appendChild(name);

    const tags = document.createElement('span');
    tags.className = 'tags';
    if (state.hostId === p.id) tags.appendChild(badge('Host'));
    if (bots.has(p.id)) tags.appendChild(badge('🤖', 'bot'));
    if (p.eliminated) tags.appendChild(badge('Out', 'off'));
    if (isAway) tags.appendChild(badge('Away', 'away'));
    if (ready && ready.has(p.id)) tags.appendChild(badge('✓ Ready', 'you'));
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

let cbKey = null; // identifies the currently displayed bid, to trigger a pop

// The bid to beat, shown as a centerpiece directly above the player's dice.
function renderCurrentBid(state) {
  const g = state.game;
  const box = $('currentBid');
  if (g.phase !== 'playing') {
    box.classList.add('hidden');
    cbKey = null;
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML = '';

  const cap = document.createElement('div');
  cap.className = 'cb-cap';
  cap.textContent = 'Current bid';
  box.appendChild(cap);

  const b = g.currentBid;
  if (!b) {
    const none = document.createElement('div');
    none.className = 'cb-none';
    none.textContent = 'No bid yet';
    box.appendChild(none);
    cbKey = null;
    return;
  }

  const main = document.createElement('div');
  main.className = 'cb-main';
  const qty = document.createElement('span');
  qty.className = 'cb-qty';
  qty.textContent = b.quantity;
  const times = document.createElement('span');
  times.className = 'cb-times';
  times.textContent = '×';
  main.append(qty, times, dieEl(b.face));
  box.appendChild(main);

  // Global odds the bid is true (all dice unknown), if the host enabled it.
  // With a wilds ruleset, any non-1 face is satisfied by that face OR a 1,
  // so each unknown die succeeds with probability 2/6 rather than 1/6.
  if (state.settings && state.settings.showProbability) {
    const n = g.totalDice;
    const wild = g.ruleset && g.ruleset.wilds && b.face !== 1;
    const prob = document.createElement('div');
    prob.className = 'cb-prob';
    prob.textContent = `${formatPct(pAtLeast(b.quantity, n, wild ? 2 / 6 : 1 / 6))}% chance · ${n} dice`;
    box.appendChild(prob);
  }

  const who = g.players.find((p) => p.id === b.playerId);
  if (who) {
    const by = document.createElement('div');
    by.className = 'cb-by';
    by.textContent = who.isYou ? 'your bid' : `${who.name}'s bid`;
    box.appendChild(by);
  }

  // Pop the placard whenever the bid actually changes.
  const key = `${b.quantity}-${b.face}-${b.playerId}`;
  if (key !== cbKey) {
    cbKey = key;
    main.classList.add('cb-pop');
  }
}

function renderMyDice(g) {
  const box = $('myDice');
  const cap = $('myDiceCap');
  box.innerHTML = '';
  const you = g.players.find((p) => p.isYou);
  if (!you || !you.dice || you.eliminated) {
    cap.classList.add('hidden');
    return;
  }
  cap.classList.remove('hidden');
  const animate = pendingRoll; // only tumble right after a fresh deal
  pendingRoll = false;
  // Show in roll order, or sorted ascending if the player prefers it.
  const dice = sortDice ? [...you.dice].sort((a, b) => a - b) : you.dice;
  dice.forEach((v, i) => {
    const die = dieEl(v);
    if (animate) {
      die.classList.add('rolling');
      die.style.animationDelay = `${i * 0.06}s`;
    }
    box.appendChild(die);
  });
}

function renderControls(g) {
  // Quantity reads as "–" until a face (and thus a valid range) is chosen.
  $('qtyVal').textContent = bid.quantity == null ? '–' : bid.quantity;

  const picker = $('facePicker');
  picker.innerHTML = '';
  for (let f = 1; f <= 6; f++) {
    const valid = faceValid(g, f);
    const opt = document.createElement('div');
    opt.className =
      'face-opt' + (bid.face === f ? ' sel' : '') + (valid ? '' : ' disabled');
    opt.appendChild(dieEl(f, { small: true }));
    if (valid) {
      opt.onclick = () => {
        bid.face = f;
        // Snap the quantity into the legal range for the newly chosen face.
        const { min, max } = bidRange(g, f);
        if (bid.quantity == null || bid.quantity < min) bid.quantity = min;
        else if (bid.quantity > max) bid.quantity = max;
        renderControls(g);
      };
    }
    picker.appendChild(opt);
  }

  // Grey out the steppers until a face is picked, and at the range bounds.
  const range = bid.face != null ? bidRange(g, bid.face) : null;
  const dec = document.querySelector('[data-step="qty"][data-dir="-1"]');
  const inc = document.querySelector('[data-step="qty"][data-dir="1"]');
  dec.disabled = !range || bid.quantity == null || bid.quantity <= range.min;
  inc.disabled = !range || bid.quantity == null || bid.quantity >= range.max;

  // A bid needs both a face and a quantity.
  $('bidBtn').disabled = bid.face == null || bid.quantity == null;

  // A challenge / spot-on is only possible once a bid exists.
  const hasBid = !!g.currentBid;
  $('challengeBtn').disabled = !hasBid;
  $('spotBtn').disabled = !hasBid;
}

// The reveal's "everyone ready" gate: a Ready toggle + an "X / Y ready" status.
function renderReadyControls(state) {
  const g = state.game;
  const show = g.phase === 'reveal';
  $('revealActions').classList.toggle('hidden', !show);
  if (!show) return;
  const ready = new Set(g.readyIds || []);
  const playerById = new Map(g.players.map((p) => [p.id, p]));
  // Connected humans still in the game must ready up (bots are auto-ready).
  const required = (state.members || []).filter(
    (m) => m.connected && !m.isBot && !(playerById.get(m.id) || {}).eliminated
  );
  const readyCount = required.filter((m) => ready.has(m.id)).length;
  const meRequired = required.some((m) => m.id === me);
  const meReady = ready.has(me);
  const btn = $('readyBtn');
  btn.classList.toggle('hidden', !meRequired);
  btn.classList.toggle('active', meReady);
  btn.textContent = meReady ? '✓ Ready — waiting…' : 'Ready';
  $('readyStatus').textContent = required.length
    ? `${readyCount} / ${required.length} ready`
    : 'Starting next round…';
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
  const callerYou = caller === 'You';
  const result = document.createElement('div');
  result.className = 'result';
  const bidStr = `${r.quantity} × ${faceName(r.face)}`;
  const countLine =
    `There ${r.actual === 1 ? 'was' : 'were'} <b>${r.actual}</b> ` +
    `${faceName(r.face)}${r.actual === 1 ? '' : 's'}${r.countsWild ? ' (1s wild)' : ''}. `;

  const shedAll = g.ruleset && g.ruleset.goal === 'shed-all';
  if (r.kind === 'challenge') {
    const bidGood = r.actual >= r.quantity;
    let outcome;
    if (shedAll) {
      // The player who was right sheds a die (good — toward winning).
      result.classList.add('good');
      outcome = bidGood
        ? 'The bid held — the bidder sheds a die!'
        : 'It was a lie — the challenger sheds a die!';
    } else {
      result.classList.add(bidGood ? 'bad' : 'good');
      outcome = bidGood ? 'The bid held — challenger loses a die.' : 'It was a lie — bidder loses a die.';
    }
    result.innerHTML = `${caller} challenged <b>${bidStr}</b>.<br>` + countLine + outcome;
  } else {
    result.classList.add(r.exact ? 'good' : 'bad');
    let outcome;
    if (shedAll) {
      outcome = r.exact
        ? 'Exactly right — everyone else gains a die!'
        : `Not exact — ${caller} ${callerYou ? 'gain' : 'gains'} a die.`;
    } else if (!r.exact) {
      outcome = 'Not exact — caller loses a die.';
    } else if (r.gainerId) {
      outcome = r.gainerCapped
        ? `Exactly right — but ${caller} ${callerYou ? 'are' : 'is'} already at full dice.`
        : `Exactly right — ${caller} ${callerYou ? 'win' : 'wins'} a die back!`;
    } else {
      outcome = 'Exactly right — everyone else loses a die!';
    }
    result.innerHTML =
      `${caller} called spot-on for <b>${bidStr}</b>.<br>` + countLine + outcome;
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
      // Highlight dice that count toward the bid: the face itself, plus wild 1s.
      const counts = v === r.face || (r.countsWild && v === 1);
      row.appendChild(dieEl(v, { small: true, highlight: counts }));
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

// Format a probability (0..1) as a percentage string, keeping at least one
// significant figure so small-but-nonzero odds don't collapse to "0".
// e.g. 0.5 -> "50", 0.123 -> "12", 0.004 -> "0.4", 0.00006 -> "0.006".
function formatPct(p) {
  const pct = p * 100;
  if (pct <= 0) return '0';
  if (pct >= 1) return String(Math.round(pct));
  return String(Number(pct.toPrecision(1)));
}
