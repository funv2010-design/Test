# WebChat — real-time chat rooms

A small, self-contained real-time chat server with a no-build browser client.
One runtime dependency (`ws`), no database, no framework, ~400 lines of plain
JavaScript. Ready to push to GitHub and deploy anywhere Node runs.

![Node](https://img.shields.io/badge/node-%E2%89%A518-green)
![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- Multi-room chat — create or switch rooms live, room list shows who is where
- Presence — join/leave notices and an online roster per room
- Typing indicators
- Recent history — the last 50 events are replayed when you enter a room
- Nickname collisions get a `-2` suffix, plus rename-while-connected
- Auto-reconnect with exponential backoff, heartbeat-based dead-socket cleanup
- Message flooding limit (8 per 3s) and payload size caps on the server
- XSS-safe rendering — every string goes to the DOM via `textContent`
- Responsive layout, works on a phone
- Zero build step: static files are served by the same process

## Quick start

```bash
npm install
npm start
# open http://localhost:3000
```

`npm run dev` restarts the server automatically when files change, and
`npm test` boots a throwaway server on port 4124 and drives it with two
WebSocket clients to check the protocol, limits, and edge cases.

To see it work, open two browser windows, join the same room, and talk to
yourself.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP + WebSocket port |
| `HOST` | `0.0.0.0` | Bind address |

Limits (message length, history depth, rate limiting) are grouped in the
`LIMITS` object at the top of [server.js](server.js).

## Layout

```
server.js          HTTP static server + WebSocket hub
public/index.html  markup
public/style.css   styles
public/app.js      client: connection, rendering, composer
test/smoke.mjs     protocol + edge-case checks, run with `npm test`
Dockerfile         container image
```

## The protocol

Everything is JSON over a single WebSocket endpoint, `/ws`.

Client → server:

| Message | Purpose |
| --- | --- |
| `{type:"register", name, room}` | claim a nickname and enter a room (once per connection) |
| `{type:"message", text}` | send to the current room |
| `{type:"join", room}` | switch rooms |
| `{type:"rename", name}` | change display name |
| `{type:"typing"}` | rate-limited ping for the typing indicator |

Server → client:

| Message | Purpose |
| --- | --- |
| `{type:"hello", id}` | connection accepted, `id` is your session id |
| `{type:"state", room, you, users, history, roster}` | full snapshot after (re)joining |
| `{type:"message", id, room, name, text, ts}` | a chat line, echoed to the sender too |
| `{type:"system", room, text, ts}` | join/leave/notice line |
| `{type:"presence", room, users}` | who is in this room |
| `{type:"roster", rooms}` | all populated rooms with counts |
| `{type:"typing", room, name}` | someone is typing |
| `{type:"you", name}` | your resolved nickname |
| `{type:"error", message}` | rate limit or usage error |

`/healthz` returns `ok` for load balancers and container health checks.

## Deploying

**Docker**

```bash
docker build -t webchat .
docker run -p 3000:3000 webchat
```

**Render / Railway / Fly.io** — point the service at this repo; the start
command is `npm start` and the port comes from `PORT`. These platforms bind
WebSocket traffic on the same port as HTTP, which is exactly what this server
does, so no extra configuration is needed. Behind a TLS-terminating proxy the
client automatically uses `wss://`.

**VPS with nginx** — add the upgrade headers to the location block:

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_read_timeout 75s;
}
```

The 75s read timeout must exceed the server's 30s heartbeat ping, otherwise
idle connections are dropped by the proxy.

## Splitting client and server (GitHub Pages + a hosted backend)

GitHub Pages serves static files only — it cannot run `server.js`, so a Pages
deployment alone gives you a chat room that never connects. The client can
still live on Pages while the server runs elsewhere.

1. Deploy the backend on any of the hosts above and note its URL.
2. Repo **Settings → Pages → Source: Deploy from a branch**, branch `main`,
   folder **`/public`**, Save. The site appears at
   `https://<user>.github.io/<repo>/`.
3. Open that site once with the backend appended:
   `https://<user>.github.io/<repo>/?server=https://your-app.onrender.com`

The value is validated (only `http(s)`/`ws(s)` URLs accepted), stored in
`localStorage`, and shown in the header as `· via <host>` so you can always see
where your messages are going. Because Pages is served over HTTPS the socket
upgrades to `wss://` automatically — a plain `http://` backend will not connect.

To go back to same-origin, load `?server=` with nothing after the equals sign.

## Push it to GitHub

```bash
git init
git add .
git commit -m "Real-time multi-room chat"
gh repo create webchat --public --source=. --push   # or create it on github.com and:
git remote add origin git@github.com:USER/webchat.git
git push -u origin main
```

## Things this deliberately does not do

State is in memory, so a restart clears rooms and history, and running more
than one instance requires sticky sessions or a Redis pub/sub adapter. There
are no accounts, passwords, moderation tools, or message retention — anyone
who can reach the URL can talk. That is fine for a demo, a hackathon table, or
a private team board; it is not a product-grade messenger. If you want auth
and persistence, the seams are obvious: replace the `rooms` map with a
publisher/subscriber, and check identity in `handleIncoming`.

## License

MIT — see [LICENSE](LICENSE).
