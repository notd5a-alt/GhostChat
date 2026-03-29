# Deployment Guide

## Prerequisites

- **Python 3.10+** with pip
- **Node.js 18+** with npm
- **Rust toolchain** (only for Tauri desktop builds)

## Quick Start (Browser)

Run in two terminals:

```bash
# Terminal 1 — backend
python app.py --dev

# Terminal 2 — frontend
cd frontend && npm install && npm run dev
```

Open `http://localhost:5173`. The Vite dev server proxies `/ws` and `/api` to the backend on port 9876.

## Production Build (Desktop App)

```bash
cd frontend && npm run build           # React → backend/static/
./scripts/build-sidecar.sh             # PyInstaller → src-tauri/binaries/
cd src-tauri && cargo tauri build       # platform installer
```

The installer is output to `src-tauri/target/release/bundle/`.

## Environment Variables

### Backend Tuning (`SYNCED_*`)

| Variable | Default | Description |
|----------|---------|-------------|
| `SYNCED_DEBUG` | `0` | Set to `1` to enable `/api/debug` endpoint |
| `SYNCED_ALLOWED_ORIGINS` | _(auto)_ | Comma-separated extra CORS/WS origins, or `*` for all |
| `SYNCED_MAX_ROOMS` | `100` | Maximum concurrent rooms (each room = 2 connections) |
| `SYNCED_IDLE_TIMEOUT` | `1800` | Close room after N seconds with no signaling messages |
| `SYNCED_HEARTBEAT_INTERVAL` | `30` | Seconds between WebSocket pings |
| `SYNCED_HEARTBEAT_TIMEOUT` | `300` | Close connection if no pong within N seconds |
| `SYNCED_RATE_LIMIT` | `100` | Max signaling messages per second per connection |
| `SYNCED_RATE_BURST` | `200` | Max burst size for rate limiter |
| `SYNCED_MAX_CONNECTIONS_PER_IP` | `4` | Max concurrent WebSocket connections per IP |

### TURN Server (for NAT traversal)

Required when peers are behind symmetric NAT or restrictive firewalls:

| Variable | Example | Description |
|----------|---------|-------------|
| `TURN_URL` | `turn:your-server.example.com:3478` | TURN server address |
| `TURN_USERNAME` | `myuser` | TURN auth username |
| `TURN_CREDENTIAL` | `mysecret` | TURN auth credential |

See `.env.example` for a template.

## HTTPS for LAN / Phone Testing

WebRTC's `getUserMedia` requires a secure context on non-localhost origins. To test from other devices on your LAN:

```bash
# Install mkcert (one-time)
brew install mkcert   # macOS
mkcert -install

# Generate certs
mkdir -p certs
mkcert -cert-file certs/cert.pem -key-file certs/key.pem localhost $(hostname -I | awk '{print $1}')
```

Vite auto-detects `certs/cert.pem` and `certs/key.pem` and enables HTTPS.

## Sidecar Log Level

The Tauri sidecar accepts a `--log-level` argument:

```bash
python -m backend.sidecar_entry --port 9876 --log-level debug
```

Options: `debug`, `info` (default), `warning`, `error`.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Port 9876 already in use | `lsof -ti :9876 \| xargs -r kill` |
| Black screen on Windows | Update WebView2 runtime, or set `WEBKIT_DISABLE_COMPOSITING_MODE=1` |
| Camera/mic blocked on LAN | Enable HTTPS (see above) — `getUserMedia` requires secure context |
| Connection fails over internet | Configure a TURN server (see env vars above) |
| SmartScreen / Gatekeeper blocks app | Code signing required — see project docs for cert setup |
