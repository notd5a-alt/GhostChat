from __future__ import annotations

import asyncio
import logging
import mimetypes
import os
import re
import socket
import time
import traceback
from pathlib import Path

# Fix MIME types on Windows — Python reads from the registry, which may lack
# entries for .js/.mjs/.wasm. Without this, StaticFiles serves JS with the wrong
# content-type and browsers silently reject module scripts.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/json", ".json")

from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from backend.signaling import manager, RoomLimitError, WS_ACCEPT_TIMEOUT

logger = logging.getLogger("synced.server")

# Will be set by app.py at startup
server_port: int = 9876


def get_local_ip() -> str:
    """Best-effort LAN IP detection."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"


# ---------------------------------------------------------------------------
# Security headers middleware
# ---------------------------------------------------------------------------
class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        # Skip CSP for localhost (Tauri webview) — WebView2 on some machines
        # blocks module scripts or WASM under strict CSP even for same-origin.
        host = request.headers.get("host", "")
        if not host.startswith("localhost") and not host.startswith("127.0.0.1"):
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; "
                "script-src 'self' 'wasm-unsafe-eval'; "
                "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
                "font-src 'self' https://fonts.gstatic.com; "
                "connect-src 'self' ws: wss:; "
                "media-src 'self' blob:; "
                "img-src 'self' data: blob:; "
                "object-src 'none'; "
                "base-uri 'self'"
            )
        return response


class AccessLogMiddleware(BaseHTTPMiddleware):
    """Log method, path, status, and duration for every HTTP request."""

    async def dispatch(self, request: Request, call_next):
        start = time.monotonic()
        response = await call_next(request)
        ms = (time.monotonic() - start) * 1000
        logger.info("%s %s %d %.1fms", request.method, request.url.path, response.status_code, ms)
        return response


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    if os.environ.get("SYNCED_DEBUG") == "1":
        logger.warning(
            "SYNCED_DEBUG is enabled — /api/debug endpoint is accessible. "
            "Do NOT use in production."
        )
    cleanup_task = asyncio.create_task(manager.cleanup_loop(60))
    yield
    cleanup_task.cancel()
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass


app = FastAPI(lifespan=lifespan)

# Security headers & access logging
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(AccessLogMiddleware)

# CORS — allow localhost, LAN, and configured external origins
_lan_ip = None
_extra_origins_raw = os.environ.get("SYNCED_ALLOWED_ORIGINS", "").strip()
_allow_all_origins = _extra_origins_raw == "*"

def _get_allowed_origins() -> list[str]:
    global _lan_ip
    if _allow_all_origins:
        return ["*"]
    if _lan_ip is None:
        _lan_ip = get_local_ip()
    origins = [
        "http://localhost:9876",
        "http://127.0.0.1:9876",
        f"http://{_lan_ip}:9876",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        f"http://{_lan_ip}:5173",
        "https://localhost:5173",
        "https://127.0.0.1:5173",
        f"https://{_lan_ip}:5173",
        "tauri://localhost",
    ]
    if _extra_origins_raw:
        for o in _extra_origins_raw.split(","):
            o = o.strip().rstrip("/").lower()
            if o and o not in origins:
                origins.append(o)
    return origins

app.add_middleware(
    CORSMiddleware,
    allow_origins=_get_allowed_origins(),
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Accept"],
)


# ---------------------------------------------------------------------------
# Global exception handler — never leak stack traces
# ---------------------------------------------------------------------------
@app.exception_handler(Exception)
async def _global_exception_handler(request: Request, exc: Exception):
    logger.error("Unhandled exception on %s %s: %s", request.method, request.url.path, exc)
    logger.debug("Traceback:\n%s", traceback.format_exc())
    return JSONResponse(status_code=500, content={"error": "internal server error"})


# ---------------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------------
@app.get("/api/info")
async def info():
    return {"ip": get_local_ip(), "port": server_port}


@app.post("/api/rooms")
async def create_room():
    """Create a new room and return a short room code + token."""
    try:
        code, token = await manager.create_room()
        return {"room_code": code, "token": token}
    except RoomLimitError:
        return JSONResponse(status_code=503, content={"error": "Server at capacity"})


_ROOM_CODE_RE = re.compile(r"^[A-HJKL-NP-Z2-9]{6}$")


@app.get("/api/rooms/{code}")
async def check_room(code: str):
    """Check if a room exists and is joinable. Returns the room token if joinable."""
    upper = code.upper().strip()
    if not _ROOM_CODE_RE.match(upper):
        return {"exists": False, "joinable": False}
    exists, joinable, token = await manager.room_info(upper)
    resp: dict = {"exists": exists, "joinable": joinable}
    if joinable and token:
        resp["token"] = token
    return resp


@app.get("/api/debug")
async def debug(request: Request, room_id: str = "default"):
    """Debug endpoint — only available when SYNCED_DEBUG=1 and from localhost."""
    if os.environ.get("SYNCED_DEBUG") != "1":
        return JSONResponse(status_code=404, content={"detail": "Not Found"})
    client_host = request.client.host if request.client else None
    if client_host not in ("127.0.0.1", "::1", "localhost"):
        return JSONResponse(status_code=404, content={"detail": "Not Found"})
    room = await manager.get_room(room_id)
    if not room:
        return JSONResponse(status_code=404, content={"detail": "Not Found"})
    return {
        "room_id": room_id,
        "peers": list(room._peers.keys()),
        "is_full": room.is_full,
        "peer_count": len(room._peers),
    }


@app.get("/api/ice-config")
async def ice_config():
    servers = [
        {"urls": "stun:stun.l.google.com:19302"},
        {"urls": "stun:stun1.l.google.com:19302"},
    ]
    turn_url = os.environ.get("TURN_URL")
    turn_user = os.environ.get("TURN_USERNAME")
    turn_cred = os.environ.get("TURN_CREDENTIAL")
    if turn_url and turn_user and turn_cred:
        servers.append({
            "urls": turn_url,
            "username": turn_user,
            "credential": turn_cred,
        })
    # No public TURN fallback — for zero-trust, TURN must be self-hosted.
    # Without TURN, peers behind symmetric NAT may fail to connect directly.
    return {"iceServers": servers}


# ---------------------------------------------------------------------------
# WebSocket origin validation
# ---------------------------------------------------------------------------
_ALLOWED_WS_ORIGINS: set[str] | None = None

def _get_allowed_ws_origins() -> set[str]:
    global _ALLOWED_WS_ORIGINS
    if _ALLOWED_WS_ORIGINS is None:
        if _allow_all_origins:
            _ALLOWED_WS_ORIGINS = set()  # empty = skip check (handled below)
            return _ALLOWED_WS_ORIGINS
        lan = get_local_ip()
        _ALLOWED_WS_ORIGINS = {
            f"http://localhost:{server_port}",
            f"http://127.0.0.1:{server_port}",
            f"http://{lan}:{server_port}",
            # Vite dev server
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            f"http://{lan}:5173",
            "https://localhost:5173",
            "https://127.0.0.1:5173",
            f"https://{lan}:5173",
            # Tauri
            "tauri://localhost",
        }
        if _extra_origins_raw:
            for o in _extra_origins_raw.split(","):
                o = o.strip().rstrip("/").lower()
                if o:
                    _ALLOWED_WS_ORIGINS.add(o)
    return _ALLOWED_WS_ORIGINS


@app.websocket("/ws")
@app.websocket("/ws/{room_id}")
async def websocket_endpoint(ws: WebSocket, room_id: str = "default", role: str = "host", token: str | None = None):
    # Validate origin — browsers always send Origin on WS handshakes.
    # Reject missing origins to prevent non-browser clients from bypassing validation.
    origin = (ws.headers.get("origin") or "").rstrip("/").lower()
    if not _allow_all_origins:
        allowed = _get_allowed_ws_origins()
        if not origin or origin not in allowed:
            logger.warning("Rejected WebSocket from origin %r (allowed: %s)", origin, allowed)
            # Must accept before close — Starlette raises RuntimeError on close of unaccepted WS
            # H1: Timeout on accept to prevent Slowloris-style attacks
            try:
                await asyncio.wait_for(ws.accept(), timeout=WS_ACCEPT_TIMEOUT)
                await ws.close(code=4003, reason="Forbidden origin")
            except asyncio.TimeoutError:
                logger.warning("WebSocket accept timeout during origin rejection")
            return

    # Per-IP connection limiting — prevent a single IP from opening many connections
    client_ip = ws.client.host if ws.client else "unknown"
    if not await manager.acquire_ip(client_ip):
        logger.warning("Rejected WebSocket from %s: too many connections", client_ip)
        try:
            await asyncio.wait_for(ws.accept(), timeout=WS_ACCEPT_TIMEOUT)
            await ws.close(code=4006, reason="Too many connections")
        except asyncio.TimeoutError:
            logger.warning("WebSocket accept timeout during IP limit rejection")
        return

    room = await manager.get_room(room_id)
    if not room:
        await manager.release_ip(client_ip)
        logger.warning("WebSocket rejected: room %s does not exist", room_id)
        try:
            await asyncio.wait_for(ws.accept(), timeout=WS_ACCEPT_TIMEOUT)
            await ws.close(code=4005, reason="Room not found")
        except asyncio.TimeoutError:
            logger.warning("WebSocket accept timeout during room rejection")
        return
    try:
        await room.handle(ws, role, token)
    finally:
        await manager.release_ip(client_ip)


# ---------------------------------------------------------------------------
# Static files (catch-all, must be last)
# ---------------------------------------------------------------------------
import sys

static_dir = Path(__file__).parent / "static"
if not static_dir.is_dir() and hasattr(sys, "_MEIPASS"):
    static_dir = Path(sys._MEIPASS) / "backend" / "static"

if static_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")
