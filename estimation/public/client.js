/* global io */
// Browser client for Estimation (speed variant). Vanilla JS, no build step —
// mirrors the structure of the liar's dice client (public/client.js) but
// drops themes/sound/TTS/awards per the build spec: one clean dark theme.
import { REACTIONS } from './reactions.js';

const socket = io();
const MIN_CYCLES = 1;
const MAX_CYCLES = 3;

// --- suits / ranks -----------------------------------------------------
const SUIT_GLYPH = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_RED = new Set(['H', 'D']);
const RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
function rankLabel(r) {
  return RANK_LABEL[r] || String(r);
}
function trumpGlyph(t) {
  return t === 'NT' ? null : SUIT_GLYPH[t];
}
function trumpLabel(t) {
  return t === 'NT' ? 'No trump' : SUIT_GLYPH[t];
}
function trumpIsRed(t) {
  return SUIT_RED.has(t);
}

// --- DOM helpers ---------------------------------------------------------
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
function toastOk(msg) {
  const t = $('toast');
  t.style.background = 'var(--good)';
  t.style.color = 'var(--ink-good)';
  toast(msg);
  setTimeout(() => {
    t.style.background = '';
    t.style.color = '';
  }, 3300);
}

function setNetStatus(text) {
  const el = $('netStatus');
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
}

function badge(text, cls = '') {
  const b = document.createElement('span');
  b.className = 'badge ' + cls;
  b.textContent = text;
  return b;
}

// --- local UI state --------------------------------------------------------
let me = null; // our player/seat id once joined
let lastState = null; // most recent room view from the server
let prevPhase = null; // for driving the round-summary progress bar

// --- identity & reconnection ------------------------------------------
// A stable private token identifies this player across reconnects. The server
// keys seats by it, so a refresh or dropped connection reclaims the same seat.
const token = (() => {
  let t = localStorage.getItem('est_pid');
  if (!t) {
    t = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
    localStorage.setItem('est_pid', t);
  }
  return t;
})();
let myName = localStorage.getItem('est_name') || '';
let reconnectTarget = localStorage.getItem('est_room') || null; // room to auto-rejoin
let autoRejoining = false;

function rememberRoom(code) {
  reconnectTarget = code;
  localStorage.setItem('est_room', code);
}
function forgetRoom() {
  reconnectTarget = null;
  autoRejoining = false;
  localStorage.removeItem('est_room');
}

// --- room chat ---------------------------------------------------------
const chatBtn = $('chatBtn');
const chatPanel = $('chatPanel');
const chatLog = $('chatLog');
const chatInput = $('chatInput');
const chatUnread = $('chatUnread');
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
  $('chatClose').onclick = () => openChat(false);
  $('chatForm').onsubmit = (e) => {
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
  if (!chatOpen && msg.seatId !== me) setUnread(unread + 1);
});

// --- emoji reactions -----------------------------------------------------
const reactionBtn = $('reactionBtn');
const reactionPalette = $('reactionPalette');
const reactionLayer = $('reactionLayer');
const reduceMotion =
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function showReactionButton(on) {
  if (!reactionBtn) return;
  reactionBtn.classList.toggle('hidden', !on);
  if (!on) setPalette(false);
}
function setPalette(open) {
  if (reactionPalette) reactionPalette.classList.toggle('hidden', !open);
}
if (reactionPalette) {
  for (const emoji of REACTIONS) {
    const b = document.createElement('button');
    b.className = 'reaction-emoji-btn';
    b.type = 'button';
    b.textContent = emoji;
    b.onclick = () => {
      socket.emit('reaction', { emoji });
      setPalette(false);
    };
    reactionPalette.appendChild(b);
  }
}
if (reactionBtn) {
  reactionBtn.onclick = (e) => {
    e.stopPropagation();
    setPalette(reactionPalette.classList.contains('hidden'));
  };
  document.addEventListener('click', (e) => {
    if (
      reactionPalette &&
      !reactionPalette.classList.contains('hidden') &&
      !reactionPalette.contains(e.target)
    ) {
      setPalette(false);
    }
  });
}

// Find the *visible* seat element (game roster or lobby list) for `seatId`.
// Both screens exist in the DOM at once; the inactive one is display:none (so
// its rect is all zeros), hence the offsetParent check to skip it.
function findSeatEl(seatId) {
  if (!seatId) return null;
  for (const el of document.querySelectorAll('.player[data-id], .member-list li[data-id]')) {
    if (el.dataset.id === seatId && el.offsetParent !== null) return el;
  }
  return null;
}

// Rain a shower of `emoji` down from the sender's name.
function spawnReaction(emoji, seatId) {
  if (!reactionLayer || !REACTIONS.includes(emoji)) return;
  const el = findSeatEl(seatId);
  let originX = innerWidth / 2;
  let originY = 48;
  if (el) {
    const r = el.getBoundingClientRect();
    originX = r.left + Math.min(70, r.width / 2);
    originY = r.top + r.height / 2;
  }
  const count = reduceMotion ? 3 : 11;
  for (let i = 0; i < count; i++) {
    const span = document.createElement('span');
    span.className = 'reaction-emoji';
    span.textContent = emoji;
    span.style.left = `${originX}px`;
    span.style.top = `${originY}px`;
    span.style.fontSize = `${20 + Math.random() * 18}px`;
    if (reduceMotion) {
      span.style.animation = 'reactionFade 1.4s ease-out forwards';
    } else {
      span.style.setProperty('--dx', `${(Math.random() - 0.5) * 170}px`);
      span.style.animation = `reactionFall ${(2.2 + Math.random() * 1.4).toFixed(2)}s ease-in forwards`;
      span.style.animationDelay = `${(Math.random() * 0.4).toFixed(2)}s`;
    }
    span.addEventListener('animationend', () => span.remove());
    reactionLayer.appendChild(span);
  }
}
socket.on('reaction', ({ emoji, seatId } = {}) => spawnReaction(emoji, seatId));

// --- home screen ---------------------------------------------------------
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
  localStorage.setItem('est_name', myName);
};

// --- lobby -----------------------------------------------------------------
$('startBtn').onclick = () => socket.emit('start');
$('leaveLobby').onclick = leave;

function currentCycles() {
  return (lastState && lastState.settings && lastState.settings.cycles) || 2;
}
$('cyclesDown').onclick = () =>
  socket.emit('updateSettings', { cycles: Math.max(MIN_CYCLES, currentCycles() - 1) });
$('cyclesUp').onclick = () =>
  socket.emit('updateSettings', { cycles: Math.min(MAX_CYCLES, currentCycles() + 1) });
$('copyCode').onclick = () => {
  const url = `${location.origin}/?room=${lastState.code}`;
  navigator.clipboard?.writeText(url).then(
    () => toastOk('Invite link copied!'),
    () => toastOk(url)
  );
};

// --- game controls ---------------------------------------------------------
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

function leave() {
  socket.emit('leave');
  me = null;
  lastState = null;
  prevPhase = null;
  forgetRoom();
  stopReadyBar();
  showChatButton(false);
  showReactionButton(false);
  history.replaceState(null, '', location.pathname);
  show('home');
}

// --- socket events -----------------------------------------------------
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
  showReactionButton(true);
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
  toast(msg);
});
socket.on('state', (state) => {
  lastState = state;
  render(state);
  const phase = state.game && state.game.phase;
  if (phase === 'roundEnd' && prevPhase !== 'roundEnd') startReadyBar();
  else if (phase !== 'roundEnd' && prevPhase === 'roundEnd') stopReadyBar();
  prevPhase = phase;
});

// --- rendering ---------------------------------------------------------
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
    li.dataset.id = m.id; // origin for emoji reactions
    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = m.name;
    li.appendChild(name);
    const tags = document.createElement('span');
    tags.className = 'tags';
    if (m.isHost) tags.appendChild(badge('Host'));
    if (m.isYou) tags.appendChild(badge('You', 'you'));
    if (!m.connected) tags.appendChild(badge('Away', 'away'));
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

  // Reflect current settings; only the host can change them.
  const cycles = currentCycles();
  $('cyclesVal').firstElementChild.textContent = cycles;
  $('cyclesDown').disabled = !amHost || cycles <= MIN_CYCLES;
  $('cyclesUp').disabled = !amHost || cycles >= MAX_CYCLES;
  $('cyclesDesc').textContent = `${cycles} cycle${cycles === 1 ? '' : 's'} = ${cycles * 5} rounds.`;
  $('settingsHint').textContent = amHost
    ? 'Only you can change these.'
    : 'The host sets these options.';
}

function renderGame(state) {
  const g = state.game;
  $('roundLabel').textContent = `Round ${g.round.number} / ${g.totalRounds}`;

  const tp = $('trumpPill');
  const glyph = trumpGlyph(g.round.trump);
  tp.textContent = glyph ? glyph : 'No trump';
  tp.classList.toggle('red', !!glyph && trumpIsRed(g.round.trump));

  const dp = $('dealtOutPill');
  dp.classList.toggle('hidden', !g.round.dealtOut);
  if (g.round.dealtOut) dp.textContent = `${g.round.dealtOut} cards out`;

  renderPlayers(state);
  renderTrick(g);
  renderEstimatePanel(g);
  renderHand(g);
  renderRoundSummary(state);
  renderGameOver(state);
}

function name(g, id) {
  const p = g.players.find((x) => x.id === id);
  return p ? (p.isYou ? 'You' : p.name) : 'Someone';
}

function renderPlayers(state) {
  const g = state.game;
  const box = $('players');
  box.innerHTML = '';
  const away = new Set((state.members || []).filter((m) => !m.connected).map((m) => m.id));
  const turnPhase = g.phase === 'playing' || g.phase === 'estimating';
  for (const p of g.players) {
    const row = document.createElement('div');
    row.className = 'player';
    row.dataset.id = p.id; // origin for emoji reactions
    if (turnPhase && g.turnId === p.id) row.classList.add('turn');
    const isAway = away.has(p.id);
    if (isAway) row.classList.add('away');

    const nameEl = document.createElement('span');
    nameEl.className = 'pname';
    nameEl.textContent = p.name + (p.isYou ? ' (you)' : '');
    row.appendChild(nameEl);

    const tags = document.createElement('span');
    tags.className = 'tags';
    if (p.isDealer) tags.appendChild(badge('Dealer'));
    if (isAway) tags.appendChild(badge('Away', 'away'));
    row.appendChild(tags);

    const stat = document.createElement('span');
    stat.className = 'p-stat';
    stat.textContent = p.estimate == null ? `${p.tricksWon} won` : `${p.tricksWon} / ${p.estimate}`;
    row.appendChild(stat);

    const score = document.createElement('span');
    score.className = 'p-score';
    score.textContent = p.score;
    row.appendChild(score);

    box.appendChild(row);
  }
}

// A single playing card, drawn in CSS/HTML — no images.
function cardEl({ id, rank, suit }) {
  const el = document.createElement('div');
  el.className = 'pcard' + (SUIT_RED.has(suit) ? ' red' : ' black');
  el.dataset.id = id;
  const r = document.createElement('span');
  r.className = 'pcard-rank';
  r.textContent = rankLabel(rank);
  const s = document.createElement('span');
  s.className = 'pcard-suit';
  s.textContent = SUIT_GLYPH[suit];
  el.append(r, s);
  return el;
}

function renderTrick(g) {
  const box = $('trick');
  box.innerHTML = '';
  const trick = g.trick || { leadSuit: null, plays: [], winnerId: null };
  const plays = trick.plays || [];
  // Only relevant while a hand is actually being played (or a completed trick
  // is paused on the table); stay out of the way during estimating/roundEnd/gameover.
  if (!plays.length && g.phase !== 'playing') {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  if (!plays.length) {
    const p = document.createElement('div');
    p.className = 'trick-empty';
    p.textContent = 'Waiting for the opening lead…';
    box.appendChild(p);
    return;
  }
  if (trick.leadSuit) {
    const lead = document.createElement('div');
    lead.className = 'trick-lead';
    lead.textContent = `Led ${SUIT_GLYPH[trick.leadSuit]}`;
    box.appendChild(lead);
  }
  const row = document.createElement('div');
  row.className = 'trick-row';
  for (const play of plays) {
    const wrap = document.createElement('div');
    wrap.className = 'trick-play';
    if (trick.winnerId && play.playerId === trick.winnerId) wrap.classList.add('winner');
    const c = cardEl(play.card);
    c.classList.add('static');
    const who = document.createElement('div');
    who.className = 'trick-who';
    who.textContent = name(g, play.playerId);
    wrap.append(c, who);
    row.appendChild(wrap);
  }
  box.appendChild(row);
}

function renderEstimatePanel(g) {
  const panel = $('estimatePanel');
  const showPanel = g.phase === 'estimating';
  panel.classList.toggle('hidden', !showPanel);
  if (!showPanel) return;
  panel.innerHTML = '';

  const handSize = g.round.handSize;
  const myTurn = g.turnId === me;

  const status = document.createElement('p');
  status.className = 'hint estimate-status';
  if (myTurn) {
    status.textContent =
      g.forbiddenEstimate != null
        ? `Your estimate — the total can't add up to ${handSize}, so you can't say ${g.forbiddenEstimate}.`
        : 'Your estimate — how many tricks will you win?';
  } else {
    status.textContent = `Waiting for ${name(g, g.turnId)} to estimate…`;
  }
  panel.appendChild(status);

  const row = document.createElement('div');
  row.className = 'estimate-row';
  for (let n = 0; n <= handSize; n++) {
    const forbidden = n === g.forbiddenEstimate;
    const b = document.createElement('button');
    b.className = 'estimate-opt' + (forbidden ? ' forbidden' : '');
    b.textContent = n;
    b.disabled = !myTurn || forbidden;
    if (myTurn && !forbidden) b.onclick = () => socket.emit('estimate', { n });
    row.appendChild(b);
  }
  panel.appendChild(row);

  // Order strip — who has estimated already, and who's up next.
  const order = document.createElement('div');
  order.className = 'estimate-order';
  for (const id of g.estimateOrder || []) {
    const pl = g.players.find((x) => x.id === id);
    const chip = document.createElement('span');
    const done = pl && pl.estimate != null;
    chip.className = 'order-chip' + (id === g.turnId ? ' current' : '') + (done ? ' done' : '');
    chip.textContent = (pl ? (pl.isYou ? 'You' : pl.name) : '?') + (done ? `: ${pl.estimate}` : '');
    order.appendChild(chip);
  }
  panel.appendChild(order);
}

// Fan the hand so a 13-card hand fits at 390px wide without horizontal
// scrolling: overlap cards just enough to keep the row inside its container.
function layoutHand(box) {
  const cards = [...box.children];
  const n = cards.length;
  if (n === 0) return;
  const cardW = cards[0].getBoundingClientRect().width || 58;
  const available = box.clientWidth || window.innerWidth - 24;
  const flatWidth = cardW * n;
  let overlap = 0;
  if (n > 1 && flatWidth > available) {
    overlap = (flatWidth - available) / (n - 1);
    overlap = Math.min(overlap, cardW * 0.85); // keep a sliver of every card visible
  }
  cards.forEach((el, i) => {
    el.style.marginLeft = i === 0 ? '0' : `${-overlap}px`;
    el.style.zIndex = String(i);
  });
}

function renderHand(g) {
  const box = $('hand');
  const cap = $('myHandCap');
  box.innerHTML = '';
  const cards = g.hand || [];
  if (!cards.length) {
    cap.classList.add('hidden');
    box.classList.add('inert');
    return;
  }
  cap.classList.remove('hidden');
  cap.textContent = `Your hand (${cards.length})`;

  const legal = new Set(g.legalCardIds || []);
  const myTurnToPlay = g.phase === 'playing' && g.turnId === me;
  box.classList.toggle('inert', !myTurnToPlay);

  for (const c of cards) {
    const el = cardEl(c);
    if (myTurnToPlay) {
      if (legal.has(c.id)) {
        el.classList.add('playable');
        el.onclick = () => socket.emit('playCard', { id: c.id });
      } else {
        el.classList.add('illegal');
      }
    }
    box.appendChild(el);
  }
  requestAnimationFrame(() => layoutHand(box));
}

function renderRoundSummary(state) {
  const g = state.game;
  const panel = $('roundSummary');
  const showPanel = g.phase === 'roundEnd' && g.roundSummary;
  panel.classList.toggle('hidden', !showPanel);
  if (!showPanel) return;

  $('roundSummaryTitle').textContent = `Round result — ${trumpLabel(g.roundSummary.trump)}`;

  const wrap = $('roundSummaryTable');
  wrap.innerHTML = '';
  const table = document.createElement('table');
  table.className = 'summary-table';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Player', 'Est', 'Won', 'Δ', 'Score'].forEach((t) => {
    const th = document.createElement('th');
    th.textContent = t;
    headRow.appendChild(th);
  });
  head.appendChild(headRow);
  table.appendChild(head);

  const body = document.createElement('tbody');
  for (const row of g.roundSummary.rows) {
    const pl = g.players.find((p) => p.id === row.playerId);
    const tr = document.createElement('tr');
    if (pl && pl.isYou) tr.className = 'mine';
    const nameTd = document.createElement('td');
    nameTd.className = 'stat-name';
    nameTd.textContent = pl ? (pl.isYou ? 'You' : pl.name) : '?';
    tr.appendChild(nameTd);
    [row.estimate, row.tricksWon].forEach((v) => {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    });
    const deltaTd = document.createElement('td');
    // Scores never fall, so sign says nothing — highlight the exact estimates,
    // which are what the 10-point bonus (and the game) actually turns on.
    deltaTd.textContent = (row.delta > 0 ? '+' : '') + row.delta;
    deltaTd.className = row.estimate === row.tricksWon ? 'good' : '';
    tr.appendChild(deltaTd);
    const scoreTd = document.createElement('td');
    scoreTd.textContent = row.score;
    tr.appendChild(scoreTd);
    body.appendChild(tr);
  }
  table.appendChild(body);
  wrap.appendChild(table);

  renderReadyControls(state);
}

// The round-summary "everyone ready" gate: a Ready toggle + an "X / Y ready"
// status, mirroring the dice reveal-progress pattern.
function renderReadyControls(state) {
  const g = state.game;
  const ready = new Set(g.readyIds || []);
  const required = (state.members || []).filter((m) => m.connected);
  const readyCount = required.filter((m) => ready.has(m.id)).length;
  const meRequired = required.some((m) => m.id === me);
  const meReady = ready.has(me);
  const btn = $('readyBtn');
  btn.classList.toggle('hidden', !meRequired);
  btn.classList.toggle('active', meReady);
  btn.textContent = meReady ? '✓ Ready — waiting…' : 'Ready';
  $('readyStatus').textContent = required.length
    ? `${readyCount} / ${required.length} ready`
    : 'Next round…';
}

const ROUND_SUMMARY_COUNTDOWN = 15; // seconds — mirrors the server's ROUND_TIMEOUT_MS default
function startReadyBar() {
  const fill = $('readyProgressFill');
  if (!fill) return;
  fill.style.animation = 'none';
  void fill.offsetWidth; // reflow so the animation restarts from full
  fill.style.animation = `readyDrain ${ROUND_SUMMARY_COUNTDOWN}s linear forwards`;
}
function stopReadyBar() {
  const fill = $('readyProgressFill');
  if (fill) fill.style.animation = 'none';
}

function renderGameOver(state) {
  const g = state.game;
  const over = g.phase === 'gameover';
  $('gameOver').classList.toggle('hidden', !over);
  if (!over) return;

  const standings = g.standings || [];
  const winners = standings.filter((s) => s.rank === 1);
  if (winners.length > 1) {
    $('winnerText').textContent = '🏆 Tie game!';
  } else if (winners.length === 1) {
    const w = winners[0];
    $('winnerText').textContent = `🏆 ${w.id === me ? 'You win!' : w.name + ' wins!'}`;
  } else {
    $('winnerText').textContent = 'Game over';
  }

  const box = $('standingsTable');
  box.innerHTML = '';
  const table = document.createElement('table');
  table.className = 'standings-table';
  const body = document.createElement('tbody');
  for (const s of standings) {
    const tr = document.createElement('tr');
    if (s.rank === 1) tr.className = 'winner';
    const rankTd = document.createElement('td');
    rankTd.className = 'rank';
    rankTd.textContent = `#${s.rank}`;
    const nameTd = document.createElement('td');
    nameTd.className = 'stat-name';
    nameTd.textContent = s.id === me ? 'You' : s.name;
    const scoreTd = document.createElement('td');
    scoreTd.className = 'score';
    scoreTd.textContent = s.score;
    tr.append(rankTd, nameTd, scoreTd);
    body.appendChild(tr);
  }
  table.appendChild(body);
  box.appendChild(table);

  $('rematchBtn').classList.toggle('hidden', state.hostId !== me);
}
