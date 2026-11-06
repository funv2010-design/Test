'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const LIMITS = {
  name: 24,
  room: 32,
  text: 1000,
  history: 50,
  rateMessages: 8,
  rateWindowMs: 3000,
  maxPayloadBytes: 16 * 1024,
};

const DEFAULT_ROOM = 'lobby';
const HEARTBEAT_MS = 30000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clean(raw, max) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u200b-\u200f]/g, '')
    .replace(/[^\S\n]{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizeRoom(raw) {
  const name = clean(raw, LIMITS.room).replace(/\s+/g, ' ').toLowerCase();
  return name === '' ? DEFAULT_ROOM : name;
}

function normalizeName(raw) {
  const name = clean(raw, LIMITS.name).replace(/\s+/g, ' ');
  return name === '' ? 'guest' : name;
}

function send(socket, payload) {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** room -> { name, clients: Map<id, client>, history: [] } */
const rooms = new Map();
const clients = new Map();

function getRoom(name) {
  const key = normalizeRoom(name);
  let room = rooms.get(key);
  if (!room) {
    room = { name: key, clients: new Map(), history: [] };
    rooms.set(key, room);
  }
  return room;
}

function roomMembers(room) {
  return [...room.clients.values()].map((c) => c.name).sort((a, b) => a.localeCompare(b));
}

function roomRoster() {
  return [...rooms.values()]
    .filter((room) => room.clients.size > 0)
    .map((room) => ({ name: room.name, count: room.clients.size }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function broadcast(room, payload, exceptId) {
  for (const client of room.clients.values()) {
    if (client.id !== exceptId) send(client.socket, payload);
  }
}

function announce(room, text) {
  const event = { type: 'system', room: room.name, text, ts: Date.now() };
  broadcast(room, event);
  pushHistory(room, event);
}

function pushHistory(room, event) {
  room.history.push(event);
  if (room.history.length > LIMITS.history) room.history.shift();
}

function publishPresence(room) {
  const members = roomMembers(room);
  broadcast(room, { type: 'presence', room: room.name, users: members });
}

function publishRoster(exceptId) {
  const roster = roomRoster();
  for (const client of clients.values()) {
    if (client.id !== exceptId) send(client.socket, { type: 'roster', rooms: roster });
  }
}

// ---------------------------------------------------------------------------
// Client lifecycle
// ---------------------------------------------------------------------------

function moveToRoom(client, roomName) {
  const next = getRoom(roomName);
  const previous = client.room;

  if (previous === next) {
    send(client.socket, {
      type: 'state',
      room: next.name,
      you: client.name,
      users: roomMembers(next),
      history: next.history,
      roster: roomRoster(),
    });
    return;
  }

  if (previous) {
    previous.clients.delete(client.id);
    announce(previous, `${client.name} left`);
    if (previous.clients.size === 0) {
      rooms.delete(previous.name);
    } else {
      publishPresence(previous);
    }
  }

  client.room = next;
  client.name = uniqueNameIn(next, client.name, client.id);
  next.clients.set(client.id, client);

  send(client.socket, {
    type: 'state',
    room: next.name,
    you: client.name,
    users: roomMembers(next),
    history: next.history,
    roster: roomRoster(),
  });
  announce(next, `${client.name} joined`);
  publishPresence(next);
  publishRoster();
}

function uniqueNameIn(room, desired, exceptId) {
  const taken = new Set(
    [...room.clients.values()].filter((c) => c.id !== exceptId).map((c) => c.name.toLowerCase()),
  );
  if (!taken.has(desired.toLowerCase())) return desired;
  let suffix = 2;
  while (taken.has(`${desired}-${suffix}`.toLowerCase())) suffix += 1;
  return `${desired}-${suffix}`.slice(0, LIMITS.name);
}

function register(client, rawName, rawRoom) {
  const name = normalizeName(rawName);
  const room = getRoom(rawRoom);
  client.name = uniqueNameIn(room, name);
  clients.set(client.id, client);
  moveToRoom(client, room.name);
}

function dropClient(client) {
  clients.delete(client.id);
  const room = client.room;
  if (!room) return;
  room.clients.delete(client.id);
  if (room.clients.size === 0) {
    rooms.delete(room.name);
    publishRoster();
    return;
  }
  announce(room, `${client.name} left`);
  publishPresence(room);
  publishRoster();
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function allowMessage(client) {
  const now = Date.now();
  client.recent = (client.recent || []).filter((t) => now - t < LIMITS.rateWindowMs);
  if (client.recent.length >= LIMITS.rateMessages) return false;
  client.recent.push(now);
  return true;
}

function handleMessage(client, payload) {
  const text = clean(payload.text, LIMITS.text).replace(/^\n+|\n+$/g, '');
  if (text === '') return;

  if (client.room === undefined) {
    send(client.socket, { type: 'error', message: 'Pick a name first.' });
    return;
  }
  if (!allowMessage(client)) {
    send(client.socket, { type: 'error', message: 'Slow down a little.' });
    return;
  }

  client.typingAt = 0;
  const event = {
    type: 'message',
    id: crypto.randomUUID(),
    room: client.room.name,
    name: client.name,
    text,
    ts: Date.now(),
  };
  pushHistory(client.room, event);
  broadcast(client.room, event);
}

function handleTyping(client) {
  if (!client.room) return;
  const now = Date.now();
  if (now - (client.typingAt || 0) < 1500) return;
  client.typingAt = now;
  broadcast(client.room, { type: 'typing', room: client.room.name, name: client.name }, client.id);
}

function handleIncoming(client, raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (!payload || typeof payload !== 'object') return;

  switch (payload.type) {
    case 'register':
      if (client.name === undefined) register(client, payload.name, payload.room);
      break;
    case 'message':
      handleMessage(client, payload);
      break;
    case 'typing':
      handleTyping(client);
      break;
    case 'join':
      if (client.name !== undefined) moveToRoom(client, payload.room);
      break;
    case 'rename':
      if (client.name !== undefined && client.room) {
        const room = client.room;
        const previousName = client.name;
        const nextName = uniqueNameIn(room, normalizeName(payload.name), client.id);
        client.name = nextName;
        if (nextName !== previousName) {
          announce(room, `${previousName} is now ${nextName}`);
          publishPresence(room);
        }
        send(client.socket, { type: 'you', name: client.name });
      }
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// HTTP static files
// ---------------------------------------------------------------------------

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('ok');
    return;
  }
  if (pathname.startsWith('/ws')) {
    res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Upgrade required');
    return;
  }
  serveStatic(req, res);
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: LIMITS.maxPayloadBytes });

wss.on('connection', (socket) => {
  const client = {
    id: crypto.randomUUID(),
    socket,
    name: undefined,
    room: undefined,
    recent: [],
    typingAt: 0,
  };

  socket.on('message', (data, isBinary) => {
    if (isBinary) return;
    handleIncoming(client, data.toString('utf8'));
  });

  socket.on('close', () => dropClient(client));
  socket.on('error', () => socket.close());

  send(socket, { type: 'hello', id: client.id, defaultRoom: DEFAULT_ROOM });
});

const heartbeat = setInterval(() => {
  for (const client of clients.values()) {
    if (client.socket.isAlive === false) {
      client.socket.terminate();
      continue;
    }
    client.socket.isAlive = true;
    client.socket.ping();
  }
}, HEARTBEAT_MS);

function shutdown() {
  clearInterval(heartbeat);
  for (const client of clients.values()) client.socket.close(1001, 'Server shutting down');
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  console.log(`webchat-room listening on http://localhost:${PORT}`);
});
