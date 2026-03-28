<img width="1684" height="937" alt="image" src="https://github.com/user-attachments/assets/1843837b-e885-4a29-81bc-09bd2b9eddb1" /># Synced

**Zero-trust peer-to-peer voice, video, text chat, and file sharing.**

No accounts. No servers in the middle. No traces. All communication flows directly between peers over encrypted WebRTC connections. The signaling server only relays connection setup — it never sees your content.

<img width="1684" height="937" alt="image" src="https://github.com/user-attachments/assets/cb11f3e8-8134-40aa-973e-520f8a652bdb" />

---

## Features

- **Voice & video calls** — WebRTC with DTLS-SRTP encryption, noise suppression, echo cancellation
- **Text chat** — Real-time messaging over encrypted data channels with typing indicators, read receipts, emoji reactions, and presence detection
- **File sharing** — Chunked binary transfer with gzip compression, SHA-256 checksums, and resumable transfers on reconnect
- **Screen sharing** — Share your screen with Picture-in-Picture support
- **Desktop app** — Native Tauri window for Windows, macOS, and Linux
- **Browser mode** — Works in any modern browser (Chrome, Firefox, Safari, Edge)
- **7 built-in themes** — Terminal, Phosphor, Amber, Cyberpunk, Arctic, Blood, Snow
- **Connection diagnostics** — Real-time RTT, packet loss, bitrate, and quality monitoring
- **Slash commands** — `/clear`, `/fingerprint`, `/stats`, `/theme`, `/diag`, `/whoami`

## How It Works

```
┌─────────────────────┐     WebSocket      ┌──────────────────────┐
│   Peer A            │◄──── signaling ────►│   Peer B             │
│                     │     relay only      │                      │
│  React SPA          │                     │  React SPA           │
│  ├─ useSignaling    │     WebRTC P2P      │  ├─ useSignaling     │
│  ├─ useWebRTC    ◄──┼─── direct conn ────►┤  ├─ useWebRTC       │
│  ├─ useDataChannel  │  (audio/video/data) │  ├─ useDataChannel   │
│  └─ useFileTransfer │                     │  └─ useFileTransfer  │
└─────────────────────┘                     └──────────────────────┘
              │                                        │
              └────────── FastAPI backend (sidecar) ───┘
                   /ws  — signaling relay
                   /api — LAN IP, ICE config
```

1. **Host** creates a session → backend assigns a WebSocket room → displays `IP:port`
2. **Joiner** enters the host's `IP:port` → connects via WebSocket
3. SDP offer/answer and ICE candidates are exchanged through the signaling server
4. A direct P2P connection is established — **the server is no longer involved**
5. All audio, video, chat, and files flow peer-to-peer with end-to-end encryption

## Quick Start

### Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Python | 3.12+ | Backend server |
| Node.js | 22+ | Frontend build |
| Rust | stable | Tauri desktop app (optional) |

### Development (browser)

```bash
# Clone and install
git clone https://github.com/notd5a-alt/Synced.git
cd Synced
pip install -e ".[dev]"
cd frontend && npm install && cd ..

# Start backend + frontend (two terminals)
python app.py --dev          # Terminal 1: backend on :9876
cd frontend && npm run dev   # Terminal 2: frontend on :5173
```

Open `http://localhost:5173` in two browser tabs. Click **Host a Session** in one, enter the address in the other, and connect.

### Development (Tauri desktop)

```bash
python app.py --dev              # Terminal 1: backend
cd src-tauri && cargo tauri dev  # Terminal 2: native window
```

### Production Build

**Linux / macOS:**
```bash
cd frontend && npm run build       # React → backend/static/
./scripts/build-sidecar.sh        # PyInstaller → src-tauri/binaries/
cd src-tauri && cargo tauri build  # Platform installer
```

**Windows (PowerShell):**
```powershell
.\scripts\build-all.ps1           # Runs all 3 steps, outputs MSI
```

Build artifacts:
- **Windows**: `src-tauri/target/release/bundle/msi/*.msi`
- **macOS**: `src-tauri/target/release/bundle/dmg/*.dmg`
- **Linux**: `src-tauri/target/release/bundle/appimage/*.AppImage`

## Configuration

Copy `.env.example` to `.env` and edit as needed:

```bash
# Self-hosted TURN server (required for peers behind symmetric NAT)
TURN_URL=turn:your-server.example.com:3478
TURN_USERNAME=your-username
TURN_CREDENTIAL=your-credential

# Enable /api/debug endpoint
SYNCED_DEBUG=1

# Logging level: DEBUG, INFO, WARNING, ERROR
LOG_LEVEL=INFO
```

> **Zero-trust note:** No public TURN fallback is included by default. Without configuring a TURN server, peers behind symmetric NAT may fail to connect. For privacy, self-host your own TURN server (e.g., [coturn](https://github.com/coturn/coturn)).

### HTTPS for LAN Testing

Place TLS certificates in the project root for secure LAN access (required for `getUserMedia` on non-localhost origins):

```bash
# Using mkcert
mkcert -install
mkcert -cert-file certs/cert.pem -key-file certs/key.pem localhost 192.168.1.x
```

Vite auto-detects `certs/cert.pem` and enables HTTPS.

## Project Structure

```
Synced/
├── backend/                 # FastAPI signaling server
│   ├── main.py              # API routes, middleware, static serving
│   ├── signaling.py         # WebSocket room manager & relay
│   ├── sidecar_entry.py     # Tauri sidecar entry point
│   └── tests/               # Backend tests (23 tests)
├── frontend/                # React SPA
│   ├── src/
│   │   ├── hooks/           # Core logic (WebRTC, signaling, chat, files)
│   │   ├── components/      # UI components
│   │   ├── utils/           # Compression, auth, sounds, codecs
│   │   └── styles/          # CSS with theme variables
│   └── index.html
├── src-tauri/               # Tauri desktop wrapper
│   ├── src/main.rs          # Sidecar management, window lifecycle
│   └── tauri.conf.json      # App config, CSP, sidecar binding
├── scripts/                 # Build automation
│   ├── build-sidecar.sh     # Linux/macOS PyInstaller build
│   ├── build-sidecar.ps1    # Windows PyInstaller build
│   └── build-all.ps1        # Full Windows build pipeline
├── .github/workflows/       # CI for Windows, Linux, macOS
├── app.py                   # Dev server entry point
└── pyproject.toml           # Python project config
```

## Security

| Layer | Protection |
|-------|-----------|
| **Media & data** | DTLS-SRTP encryption (WebRTC built-in) |
| **Data channels** | HMAC-SHA256 message authentication derived from DTLS fingerprints |
| **File integrity** | SHA-256 checksums verified after decompression |
| **Signaling** | Origin validation, message type whitelist, 64KB size limit |
| **Server** | Security headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy) |
| **Desktop** | Content Security Policy, no devtools in production, shell plugin restricted |
| **Infrastructure** | Room limits (100 max), heartbeat timeout (90s), CORS restricted to localhost/LAN |

The signaling server validates message structure but never inspects content. It sees only message types (`offer`, `answer`, `ice-candidate`) — the actual SDP payloads and media are opaque to it.

## Testing

```bash
# Backend (23 tests)
python -m pytest backend/tests/ -v

# Frontend (54 tests)
cd frontend && npm run test

# Linting
cd frontend && npm run lint

# Type checking
cd frontend && npx tsc --noEmit
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Desktop shell | [Tauri v2](https://tauri.app/) (Rust) |
| Frontend | [React 19](https://react.dev/) + TypeScript |
| Build tool | [Vite 8](https://vite.dev/) |
| Backend | [FastAPI](https://fastapi.tiangolo.com/) + [Uvicorn](https://www.uvicorn.org/) |
| Real-time | WebRTC (RTCPeerConnection, DataChannel) |
| Testing | [Vitest](https://vitest.dev/) + [Pytest](https://pytest.org/) |
| CI/CD | GitHub Actions (Windows, Linux, macOS) |
| Sidecar bundling | [PyInstaller](https://pyinstaller.org/) |

## License

MIT
