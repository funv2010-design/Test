'use strict';

const el = (id) => document.getElementById(id);

const ui = {
  app: el('app'),
  overlay: el('overlay'),
  joinForm: el('join-form'),
  joinName: el('join-name'),
  joinRoom: el('join-room'),
  rooms: el('rooms'),
  users: el('users'),
  onlineCount: el('online-count'),
  newRoomBtn: el('new-room'),
  newRoomInput: el('new-room-input'),
  roomTitle: el('room-title'),
  roomSub: el('room-sub'),
  status: el('status'),
  statusText: el('status-text'),
  scroller: el('scroller'),
  log: el('log'),
  typing: el('typing'),
  jump: el('jump'),
  composer: el('composer'),
  input: el('input'),
  send: el('send'),
  notice: el('notice'),
  meName: el('me-name'),
  meAvatar: el('me-avatar'),
  editName: el('edit-name'),
};

const store = {
  get name() { return localStorage.getItem('wc.name') || ''; },
  set name(v) { localStorage.setItem('wc.name', v); },
  get room() { return localStorage.getItem('wc.room') || ''; },
  set room(v) { localStorage.setItem('wc.room', v); },
  get server() { return localStorage.getItem('wc.server') || ''; },
  set server(v) {
    if (v) localStorage.setItem('wc.server', v);
    else localStorage.removeItem('wc.server');
  },
};

const state = {
  socket: null,
  server: '',
  me: '',
  room: '',
  users: [],
  unapproved: true,
  attempts: 0,
  reconnectTimer: null,
  typingUsers: new Map(),
  last: null,
  lastDay: '',
  unread: 0,
};

const AVATAR_COLORS = ['#6d5efc', '#e0568a', '#2fb3a4', '#e08b3d', '#5b8def', '#a45edd', '#3fa860'];

const colorFor = (name) => {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
};

const initials = (name) => [...name].filter((c) => /\p{L}|\p{N}/u.test(c)).slice(0, 2).join('').toUpperCase() || '?';

function avatar(name) {
  const node = document.createElement('span');
  node.className = 'avatar';
  node.setAttribute('aria-hidden', 'true');
  node.textContent = initials(name);
  node.style.background = colorFor(name);
  return node;
}

const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const dayLabel = (ts) => {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(today.getTime() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'today';
  if (d.toDateString() === yest.toDateString()) return 'yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
};

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

// A client hosted on GitHub Pages has no backend of its own, so ?server= lets
// it point at a separately hosted one. The resolved host is shown in the header
// so a crafted link cannot quietly redirect someone's messages.
function resolveServer(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return '';
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function wsUrl() {
  if (state.server) return state.server;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
}

function backendLabel() {
  return state.server ? ` · via ${new URL(state.server).host}` : '';
}

function readServerOverride() {
  const fromQuery = new URLSearchParams(location.search).get('server');
  if (fromQuery === null) return store.server;
  if (fromQuery === '') {
    store.server = '';
    return '';
  }
  const resolved = resolveServer(fromQuery);
  if (!resolved) {
    notify('Ignored ?server= — pass a full http(s):// or ws(s):// URL.');
    return store.server;
  }
  store.server = resolved;
  return resolved;
}

function setStatus(kind, text) {
  ui.status.className = `status status-${kind}`;
  ui.statusText.textContent = text;
}

function connect() {
  clearTimeout(state.reconnectTimer);
  if (!store.name) {
    showJoin();
    return;
  }

  setStatus('warn', 'connecting');
  ui.roomSub.textContent = `connecting to ${new URL(wsUrl()).host}`;
  ui.input.disabled = true;
  ui.send.disabled = true;

  let socket;
  try {
    socket = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  state.socket = socket;

  socket.addEventListener('open', () => {
    state.attempts = 0;
    setStatus('on', 'online');
    socket.send(JSON.stringify({ type: 'register', name: store.name, room: store.room || 'lobby' }));
    ui.input.disabled = false;
    ui.input.focus();
  });

  socket.addEventListener('message', (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handle(msg);
  });

  socket.addEventListener('close', scheduleReconnect);
  socket.addEventListener('error', () => socket.close());
}

function scheduleReconnect() {
  state.socket = null;
  state.unapproved = true;
  ui.input.disabled = true;
  ui.send.disabled = true;

  const delay = Math.min(1000 * 2 ** state.attempts, 15000);
  state.attempts += 1;
  setStatus('off', `reconnecting in ${Math.round(delay / 1000)}s`);
  ui.roomSub.textContent = `cannot reach ${new URL(wsUrl()).host}`;
  state.reconnectTimer = setTimeout(connect, delay);
}

function send(payload) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(payload));
  }
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

function handle(msg) {
  switch (msg.type) {
    case 'hello':
      break;

    case 'state':
      state.unapproved = false;
      state.me = msg.you;
      state.room = msg.room;
      state.users = msg.users || [];
      store.room = msg.room;
      store.name = msg.you;
      resetLog();
      (msg.history || []).forEach(render);
      renderRoster(msg.roster || []);
      renderUsers();
      renderMe();
      ui.roomTitle.textContent = `#${msg.room}`;
      ui.overlay.hidden = true;
      scrollToBottom(true);
      break;

    case 'you':
      state.me = msg.name;
      store.name = msg.name;
      renderMe();
      break;

    case 'message':
    case 'system':
      render(msg);
      break;

    case 'presence':
      state.users = msg.users || [];
      renderUsers();
      break;

    case 'roster':
      renderRoster(msg.rooms || []);
      break;

    case 'typing':
      noteTyping(msg.name);
      break;

    case 'error':
      notify(msg.message);
      break;

    default:
      break;
  }
}

function noteTyping(name) {
  if (name === state.me) return;
  state.typingUsers.set(name, Date.now());
  paintTyping();
  setTimeout(() => {
    if (Date.now() - (state.typingUsers.get(name) || 0) >= 3800) {
      state.typingUsers.delete(name);
      paintTyping();
    }
  }, 4000);
}

function paintTyping() {
  const names = [...state.typingUsers.keys()];
  if (names.length === 0) {
    ui.typing.hidden = true;
    ui.typing.textContent = '';
    return;
  }
  const label = names.length === 1 ? `${names[0]} is typing` : `${names.slice(0, 3).join(', ')} are typing`;
  ui.typing.hidden = false;
  ui.typing.textContent = label + '…';
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function resetLog() {
  ui.log.textContent = '';
  state.last = null;
  state.lastDay = '';
  state.unread = 0;
  ui.jump.hidden = true;
  ui.typing.hidden = true;
  state.typingUsers.clear();
}

function dayDivider(ts) {
  const label = dayLabel(ts);
  if (label === state.lastDay) return;
  state.lastDay = label;
  const node = document.createElement('div');
  node.className = 'day';
  node.textContent = label;
  ui.log.append(node);
}

function render(msg) {
  dayDivider(msg.ts || Date.now());

  if (msg.type === 'system') {
    state.last = null;
    const node = document.createElement('div');
    node.className = 'system';
    node.textContent = msg.text;
    ui.log.append(node);
    autoScroll(msg);
    return;
  }

  const isSelf = msg.name === state.me;
  const gap = state.last && state.last.name === msg.name && msg.ts - state.last.ts < 5 * 60_000;
  state.last = msg;

  const row = document.createElement('div');
  row.className = `msg${isSelf ? ' is-self' : ''}${gap ? ' is-gap' : ''}`;

  if (!gap) row.append(avatar(msg.name));

  const body = document.createElement('div');
  body.className = 'msg-body';

  if (!gap) {
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = msg.name;
    const when = document.createElement('span');
    when.textContent = time(msg.ts);
    meta.append(who, when);
    body.append(meta);
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = msg.text;
  body.append(bubble);
  row.append(body);
  ui.log.append(row);

  state.typingUsers.delete(msg.name);
  paintTyping();
  autoScroll(msg);
}

function isNearBottom() {
  return ui.scroller.scrollHeight - ui.scroller.scrollTop - ui.scroller.clientHeight < 130;
}

function scrollToBottom(force) {
  if (force || isNearBottom()) {
    ui.scroller.scrollTop = ui.scroller.scrollHeight;
    state.unread = 0;
    ui.jump.hidden = true;
  }
}

function autoScroll(msg) {
  if (msg.name === state.me) {
    scrollToBottom(true);
    return;
  }
  if (isNearBottom()) {
    scrollToBottom(true);
  } else {
    state.unread += 1;
    ui.jump.hidden = false;
    ui.jump.textContent = `${state.unread} new message${state.unread > 1 ? 's' : ''} ↓`;
  }
}

function renderMe() {
  ui.meName.textContent = state.me || 'connecting…';
  ui.meAvatar.textContent = initials(state.me || '?');
  ui.meAvatar.style.background = colorFor(state.me || '?');
}

function renderUsers() {
  ui.users.textContent = '';
  ui.onlineCount.textContent = state.users.length;
  for (const name of state.users) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot-o';
    const label = document.createElement('span');
    label.textContent = name === state.me ? `${name} (you)` : name;
    li.append(dot, label);
    ui.users.append(li);
  }
  ui.roomSub.textContent = `${state.users.length} online in #${state.room}${backendLabel()}`;
}

function renderRoster(roster) {
  ui.rooms.textContent = '';
  const names = new Set(roster.map((r) => r.name));
  names.add(state.room || 'lobby');

  for (const name of [...names].sort((a, b) => {
    if (a === state.room) return -1;
    if (b === state.room) return 1;
    return a.localeCompare(b);
  })) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = `#${name}`;
    if (name === state.room) btn.setAttribute('aria-current', 'true');

    const count = roster.find((r) => r.name === name)?.count;
    if (count) {
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = count;
      btn.append(pill);
    }

    btn.addEventListener('click', () => {
      if (name !== state.room) send({ type: 'join', room: name });
    });
    li.append(btn);
    ui.rooms.append(li);
  }
}

let noticeTimer;
function notify(text) {
  ui.notice.hidden = false;
  ui.notice.textContent = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { ui.notice.hidden = true; }, 4000);
}

// ---------------------------------------------------------------------------
// Join overlay
// ---------------------------------------------------------------------------

function showJoin(prefillRoom = '') {
  ui.overlay.hidden = false;
  ui.joinName.value = store.name;
  ui.joinRoom.value = prefillRoom || store.room || 'lobby';
  ui.joinName.focus();
  setStatus('off', 'offline');
}

ui.joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = ui.joinName.value.trim().slice(0, 24);
  if (!name) return;
  store.name = name;
  store.room = ui.joinRoom.value.trim().slice(0, 32) || 'lobby';
  connect();
});

ui.editName.addEventListener('click', () => {
  const name = window.prompt('New display name', state.me);
  if (name && name.trim()) send({ type: 'rename', name: name.trim().slice(0, 24) });
});

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

ui.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = ui.input.value.trim();
  if (!text) return;
  send({ type: 'message', text });
  ui.input.value = '';
  ui.input.style.height = 'auto';
  ui.input.focus();
});

let lastTypingSent = 0;
ui.input.addEventListener('input', () => {
  ui.input.style.height = 'auto';
  ui.input.style.height = `${Math.min(ui.input.scrollHeight, 140)}px`;
  const now = Date.now();
  if (now - lastTypingSent > 1500 && ui.input.value.trim()) {
    lastTypingSent = now;
    send({ type: 'typing' });
  }
});

ui.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    ui.composer.requestSubmit();
  }
});

ui.jump.addEventListener('click', () => scrollToBottom(true));
ui.scroller.addEventListener('scroll', () => {
  if (isNearBottom()) {
    state.unread = 0;
    ui.jump.hidden = true;
  }
});

// ---------------------------------------------------------------------------
// Rooms sidebar
// ---------------------------------------------------------------------------

ui.newRoomBtn.addEventListener('click', () => {
  const open = ui.newRoomInput.classList.toggle('is-open');
  if (open) ui.newRoomInput.focus();
});

ui.newRoomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    ui.newRoomInput.classList.remove('is-open');
    ui.newRoomInput.value = '';
    return;
  }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const room = ui.newRoomInput.value.trim().slice(0, 32);
  if (!room) return;
  send({ type: 'join', room });
  ui.newRoomInput.value = '';
  ui.newRoomInput.classList.remove('is-open');
});

window.addEventListener('beforeunload', () => {
  clearTimeout(state.reconnectTimer);
  state.socket?.close();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

state.server = readServerOverride();

if (store.name) {
  connect();
} else {
  showJoin();
}
