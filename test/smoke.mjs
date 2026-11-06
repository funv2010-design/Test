import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const PORT = 4124;
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ['server.js'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});

async function waitForServer(tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('server did not become healthy');
}

function client(label) {
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws`);
  const inbox = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  const say = (o) => ws.send(JSON.stringify(o));
  return { ws, inbox, say, label };
}

const find = (c, type) => c.inbox.find((m) => m.type === type);
const latest = (c, type) => c.inbox.filter((m) => m.type === type).pop();
const count = (c, type) => c.inbox.filter((m) => m.type === type).length;

const checks = [];
const ok = (name, pass, detail = '') => checks.push({ name, pass, detail });

try {
  await waitForServer();

  const http = await fetch(`${BASE}/`);
  ok('serves the client', http.ok && http.headers.get('content-type').includes('text/html'));

  const hostile = await fetch(`${BASE}/%2e%2e%2fserver.js`);
  ok('blocks path traversal', hostile.status === 403, String(hostile.status));

  const a = client('a');
  await sleep(250);
  ok('greets with a session id', !!find(a, 'hello'));

  a.say({ type: 'register', name: 'Sam', room: 'lobby' });
  await sleep(250);
  a.say({ type: 'register', name: 'Other', room: 'elsewhere' });
  await sleep(250);
  ok('register is idempotent', count(a, 'state') === 1 && a.inbox.filter((m) => m.type === 'state').pop().you === 'Sam');

  const b = client('b');
  await sleep(250);
  b.say({ type: 'register', name: 'sam', room: ' LOBBY ' });
  await sleep(350);
  const bs = latest(b, 'state');
  ok('room key is trimmed and lowercased', bs.room === 'lobby', bs.room);
  ok('nickname collision gets a suffix', bs.you === 'sam-2', bs.you);
  ok('presence lists both members', bs.users.length === 2, JSON.stringify(bs.users));
  ok('join notice is broadcast', !!find(a, 'system'));

  a.say({ type: 'message', text: 'hello <img src=x onerror="alert(1)">' });
  await sleep(250);
  ok('markup is relayed verbatim', latest(b, 'message')?.text.startsWith('hello <img'));

  a.say({ type: 'message', text: 'first\nmany    spaces' });
  await sleep(250);
  ok('newlines kept, space runs collapsed', latest(b, 'message')?.text === 'first\nmany spaces', latest(b, 'message')?.text);

  a.say({ type: 'message', text: 'x'.repeat(2000) });
  await sleep(250);
  ok('message length is capped at 1000', latest(b, 'message')?.text.length === 1000);

  a.say({ type: 'message', text: '   ' });
  await sleep(250);
  ok('blank message is dropped', count(b, 'message') === 3, String(count(b, 'message')));

  for (let i = 0; i < 12; i += 1) a.say({ type: 'message', text: `flood ${i}` });
  await sleep(350);
  const through = b.inbox.filter((m) => m.type === 'message' && m.text.startsWith('flood')).length;
  ok('flooding is rate limited', through > 0 && through <= 8 && !!find(a, 'error'), `${through} through`);

  a.say({ type: 'typing' });
  await sleep(250);
  ok('typing reaches peers only', !!find(b, 'typing') && !find(a, 'typing'));

  b.say({ type: 'join', room: 'random' });
  await sleep(350);
  const moved = latest(b, 'state');
  ok('room switch reseeds the snapshot', moved.room === 'random' && moved.users.length === 1);
  ok('empty rooms leave the roster', latest(a, 'roster').rooms.length === 2, JSON.stringify(latest(a, 'roster').rooms));

  a.say({ type: 'join', room: 'random' });
  await sleep(350);
  ok('history replay is bounded', (latest(b, 'state').history || []).length <= 50);

  a.say({ type: 'rename', name: 'Sam' });
  await sleep(250);
  ok('renaming to your own name is a no-op', latest(a, 'you')?.name === 'Sam', latest(a, 'you')?.name);

  a.say({ type: 'rename', name: 'Zed' });
  await sleep(250);
  ok('rename is confirmed and announced', latest(a, 'you')?.name === 'Zed' && latest(b, 'system').text.includes('is now'));

  a.say(Buffer.from('this is not json'));
  a.say(JSON.stringify({ type: 'unknown-verb' }));
  await sleep(250);
  ok('malformed frames do not kill the socket', a.ws.readyState === WebSocket.OPEN);

  a.ws.close();
  await sleep(350);
  ok('departure is announced', latest(b, 'system').text.includes('left'), latest(b, 'system').text);

  for (const c of [a, b]) { try { c.ws.close(); } catch {} }
} finally {
  server.kill();
}

const failed = checks.filter((c) => !c.pass);
for (const c of checks) console.log(`${c.pass ? 'ok  ' : 'FAIL'}  ${c.name}${c.pass ? '' : `  -> ${c.detail}`}`);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
