# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Synced is a zero-trust peer-to-peer desktop app for 1-on-1 voice/video calls, text chat, and file sharing. All media and data flows directly between peers via WebRTC (encrypted with DTLS-SRTP). The signaling server only relays connection setup messages — it never sees user content.

## Commands

### Frontend (from `frontend/`)
- `npm run dev` — Vite dev server on 0.0.0.0 (proxies `/ws` and `/api` to backend on port 9876)
- `npm run build` — builds React app into `backend/static/`
- `npm run lint` — ESLint
- `npm run test` — Vitest (54 frontend tests)
- `npm run storybook` — Storybook on port 6006

### Backend
- `python app.py --port 9876` — runs backend server (use with Vite dev server or Tauri dev)
- `python -m pytest backend/tests/` — run backend tests (19 tests)

### Full dev workflow (browser)
Run in two terminals:
1. `python app.py --dev` — backend on port 9876
2. `cd frontend && npm run dev` — frontend on port 5173, proxies API/WS to backend

### Tauri dev workflow
Run in two terminals:
1. `python app.py --dev` — backend on port 9876
2. `cd src-tauri && cargo tauri dev` — native window pointing at backend

### Tauri production build
```bash
cd frontend && npm run build           # build frontend → backend/static/
./scripts/build-sidecar.sh             # PyInstaller → src-tauri/binaries/
cd src-tauri && cargo tauri build       # produces platform installer
```

### HTTPS for LAN/phone testing
Place `certs/cert.pem` and `certs/key.pem` (e.g., from mkcert) in the project root. Vite auto-detects them and enables HTTPS. Required for `getUserMedia` on non-localhost origins.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Tauri Shell (native window)                                     │
│  └─ spawns Python sidecar → waits for ready → opens webview     │
│     └─ kills sidecar on window close                             │
└─────────────────────────────────────────────────────────────────┘
              │ webview loads http://localhost:9876
              ▼
┌─────────────────────┐     WebSocket      ┌──────────────────────┐
│   Peer A (browser)  │◄──── signaling ────►│   Peer B (browser)   │
│                     │     relay only      │                      │
│  React SPA          │                     │  React SPA           │
│  ├─ useSignaling    │     WebRTC P2P      │  ├─ useSignaling     │
│  ├─ useWebRTC    ◄──┼─── direct conn ────►┤  ├─ useWebRTC       │
│  ├─ useDataChannel  │  (audio/video/data) │  ├─ useDataChannel   │
│  └─ useFileTransfer │                     │  └─ useFileTransfer  │
└─────────────────────┘                     └──────────────────────┘
              │                                        │
              └────────── FastAPI backend (sidecar) ───┘
                   /ws (signaling relay)
                   /api/info (LAN IP)
                   static files (prod)
```

### Connection flow
1. Host creates room → backend assigns WebSocket slot → shows IP:port
2. Joiner connects to that IP:port → backend relays `peer-joined`
3. Host sends SDP offer → backend relays → Joiner sends SDP answer
4. ICE candidates exchanged → direct P2P connection established
5. All subsequent communication is peer-to-peer (no server involvement)

### Backend (`backend/`)
- `signaling.py` — `SignalingRoom` pairs exactly 2 WebSocket peers, relays messages between them. Sends `peer-joined`/`peer-disconnected` lifecycle events.
- `main.py` — FastAPI app: `/ws` endpoint delegates to SignalingRoom, `/api/info` returns LAN IP, mounts `static/` for production.

### Frontend hooks (`frontend/src/hooks/`)
These are the core logic layer — most bugs and features involve these files:
- `useSignaling.ts` — WebSocket wrapper with message buffering (prevents race conditions when messages arrive before handler is registered)
- `useWebRTC.ts` — RTCPeerConnection lifecycle, media tracks, screen sharing, data channels. Uses the "polite peer" negotiation pattern (host=impolite, joiner=polite). All external state accessed via refs to avoid stale closures in callbacks.
- `useDataChannel.ts` — text messaging over the "chat" data channel
- `useFileTransfer.ts` — chunked binary file transfer (16KB chunks) over the "file" data channel with flow control via `bufferedAmountLowThreshold`

### Frontend state machine (`App.tsx`)
Screens: `home` → `lobby` → `session`. Session has three tabs: Chat, Call, Files. Transitions are driven by `webrtc.connectionState` changes.

## Key Patterns

- **Refs over state in WebRTC callbacks**: `signalingRef`, `isHostRef`, `pcRef`, etc. ensure event handlers always read current values without re-registering. This is critical — using state directly in `useCallback` deps caused infinite re-renders and duplicate peer connections in the past.
- **Message buffering in useSignaling**: Messages arriving before `onMessage(handler)` is called are queued and flushed when the handler registers. This prevents the host's offer from being dropped during initialization.
- **`replaceTrack` for screen sharing**: Screen video swaps the camera sender's track (no renegotiation needed). `addTrack` is only used when no video sender exists yet.
- **`screenVideoSenderRef`**: Tracks the video sender used for screen sharing so it can be reused across share/stop cycles (prevents sender accumulation when the sender has a null track).
