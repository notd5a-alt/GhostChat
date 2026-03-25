from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Dict

from fastapi import WebSocket, WebSocketDisconnect

logger = logging.getLogger("synced.signaling")

MAX_MESSAGE_SIZE = 65536  # 64 KB
MAX_ROOMS = 100           # Cap total rooms (= 200 max connections)
HEARTBEAT_INTERVAL = 30   # seconds between pings
HEARTBEAT_TIMEOUT = 300   # close if no pong within this many seconds
                          # (Chrome throttles background tabs to ~1 timer/min)
ALLOWED_TYPES = {"offer", "answer", "ice-candidate", "ping", "pong"}
VALID_ROLES = {"host", "join"}

# Rate limiting: token bucket per peer
RATE_LIMIT = 100          # messages per second
RATE_BURST = 200          # max burst size


class _TokenBucket:
    """Simple token bucket rate limiter."""

    __slots__ = ("_rate", "_burst", "_tokens", "_last")

    def __init__(self, rate: float = RATE_LIMIT, burst: int = RATE_BURST):
        self._rate = rate
        self._burst = burst
        self._tokens = float(burst)
        self._last = time.monotonic()

    def consume(self) -> bool:
        """Try to consume one token. Returns True if allowed, False if throttled."""
        now = time.monotonic()
        elapsed = now - self._last
        self._last = now
        self._tokens = min(self._burst, self._tokens + elapsed * self._rate)
        if self._tokens >= 1.0:
            self._tokens -= 1.0
            return True
        return False


class SignalingRoom:
    """Pairs exactly two WebSocket peers (host + join) and relays messages between them."""

    def __init__(self, room_id: str):
        self.room_id = room_id
        self._peers: Dict[str, WebSocket] = {}  # role -> WebSocket
        self._tokens: Dict[str, str] = {}       # role -> token
        self._last_pong: Dict[str, float] = {}  # role -> timestamp
        self._lock = asyncio.Lock()

    @property
    def is_full(self) -> bool:
        return "host" in self._peers and "join" in self._peers

    async def connect(self, ws: WebSocket, role: str, token: str | None = None) -> bool:
        """Add a peer by role. Duplicate role replaces the old connection if token matches."""
        if role not in VALID_ROLES:
            logger.warning("[%s] rejected invalid role: %r", self.room_id, role)
            return False

        # Accept WebSocket before acquiring lock to avoid blocking other peers
        await ws.accept()

        async with self._lock:
            # If this role already has a connection, check token if it exists
            if role in self._peers:
                existing_token = self._tokens.get(role)
                if existing_token and token != existing_token:
                    logger.warning("[%s] rejection: %s role hijacking attempt (invalid token)", self.room_id, role)
                    try:
                        await ws.close(code=4000, reason="Invalid token")
                    except Exception:
                        pass
                    return False

                old = self._peers[role]
                logger.info("[%s] replacing stale %s connection", self.room_id, role)
                try:
                    await old.close(code=4001, reason="Replaced by new connection")
                except Exception:
                    pass

            self._peers[role] = ws
            self._last_pong[role] = time.monotonic()
            if token:
                self._tokens[role] = token

            logger.info("[%s] peer connected (%s, %d/2 in room), peers=%s",
                         self.room_id, role, len(self._peers), list(self._peers.keys()))

            # Send peer-joined inside lock to ensure both peers get notified
            # atomically (prevents disconnect race between collect and send)
            if self.is_full:
                logger.info("[%s] room full — sending peer-joined to both", self.room_id)
                for peer in list(self._peers.values()):
                    try:
                        await peer.send_json({"type": "peer-joined"})
                    except Exception as e:
                        logger.warning("[%s] failed to send peer-joined: %s", self.room_id, e)
        return True

    async def disconnect(self, ws: WebSocket):
        async with self._lock:
            role_to_remove = None
            for role, peer in self._peers.items():
                if peer is ws:
                    role_to_remove = role
                    break
            if role_to_remove:
                del self._peers[role_to_remove]
                self._last_pong.pop(role_to_remove, None)
                # We keep the token for a while to allow the SAME user to reconnect
                # but it will be cleared if the room becomes empty and is deleted by RoomManager
                logger.info("[%s] peer disconnected (%s, %d/2 in room)", self.room_id, role_to_remove, len(self._peers))

                # Notify the other peer if they're still connected
                other = next(iter(self._peers.values()), None)
                if other:
                    try:
                        await other.send_json({"type": "peer-disconnected"})
                    except Exception:
                        pass

    def _get_role(self, ws: WebSocket) -> str | None:
        """Return the role for a given WebSocket, or None."""
        for role, peer in self._peers.items():
            if peer is ws:
                return role
        return None

    def _validate(self, data: str) -> dict | None:
        """Check message size and structure. Returns parsed dict or None."""
        if len(data) > MAX_MESSAGE_SIZE:
            logger.warning("[%s] message too large (%d bytes), dropping", self.room_id, len(data))
            return None
        try:
            msg = json.loads(data)
        except (json.JSONDecodeError, TypeError):
            logger.warning("[%s] invalid JSON, dropping", self.room_id)
            return None
        msg_type = msg.get("type")
        if msg_type not in ALLOWED_TYPES:
            logger.warning("[%s] unknown message type %r, dropping", self.room_id, msg_type)
            return None
        return msg

    async def relay(self, ws: WebSocket, data: str, msg_type: str):
        """Forward a validated message from one peer to the other."""
        disconnect_peer = None
        async with self._lock:
            other = None
            for peer in self._peers.values():
                if peer is not ws:
                    other = peer
                    break

            if other:
                try:
                    logger.info("[%s] relaying %s message", self.room_id, msg_type)
                    await other.send_text(data)
                except WebSocketDisconnect:
                    logger.warning("[%s] relay failed, peer disconnected", self.room_id)
                    disconnect_peer = other
                except Exception as e:
                    logger.warning("[%s] relay send failed: %s", self.room_id, e)
            else:
                logger.warning("[%s] relay: no other peer to send to", self.room_id)

        # Disconnect outside the lock (disconnect() acquires its own lock)
        if disconnect_peer:
            await self.disconnect(disconnect_peer)

    async def handle(self, ws: WebSocket, role: str, token: str | None = None):
        """Full lifecycle: connect, relay messages, handle disconnect."""
        accepted = await self.connect(ws, role, token)
        if not accepted:
            # connect() may have already closed the socket (e.g., token hijack)
            try:
                await ws.close(code=4000, reason="Invalid role")
            except Exception:
                pass
            return

        # Start a heartbeat task for this connection
        heartbeat_task = asyncio.create_task(self._heartbeat(ws, role))
        bucket = _TokenBucket()
        throttle_warnings = 0

        try:
            while True:
                data = await ws.receive_text()
                if not bucket.consume():
                    throttle_warnings += 1
                    if throttle_warnings == 1:
                        logger.warning("[%s] rate limiting %s (>%d msg/s)", self.room_id, role, RATE_LIMIT)
                    if throttle_warnings >= 500:
                        logger.warning("[%s] closing %s: sustained rate limit abuse (%d dropped)",
                                       self.room_id, role, throttle_warnings)
                        await ws.close(code=4008, reason="Rate limit exceeded")
                        return
                    continue
                throttle_warnings = 0
                msg = self._validate(data)
                if msg is not None:
                    msg_type = msg.get("type")
                    if msg_type in {"offer", "answer", "ice-candidate"}:
                        await self.relay(ws, data, msg_type)
                    elif msg_type == "pong":
                        # Update pong timestamp for heartbeat timeout detection
                        async with self._lock:
                            r = self._get_role(ws)
                            if r:
                                self._last_pong[r] = time.monotonic()
                    # pings are consumed here, not relayed
        except WebSocketDisconnect:
            pass
        except Exception as e:
            logger.error("[%s] signaling handler error: %s", self.room_id, e)
        finally:
            heartbeat_task.cancel()
            try:
                await heartbeat_task
            except asyncio.CancelledError:
                pass
            try:
                await self.disconnect(ws)
            except Exception as e:
                logger.error("[%s] disconnect cleanup failed: %s", self.room_id, e)

    async def _heartbeat(self, ws: WebSocket, role: str):
        """Periodically send a ping and close connection if no pong received."""
        try:
            while True:
                await asyncio.sleep(HEARTBEAT_INTERVAL)
                # Check for pong timeout entirely under lock to prevent race
                # with pong arriving between read and close
                timed_out = False
                async with self._lock:
                    last = self._last_pong.get(role, 0)
                    if time.monotonic() - last > HEARTBEAT_TIMEOUT:
                        timed_out = True
                if timed_out:
                    logger.warning("[%s] heartbeat timeout for %s (no pong in %ds), closing",
                                   self.room_id, role, HEARTBEAT_TIMEOUT)
                    try:
                        await ws.close(code=4002, reason="Heartbeat timeout")
                    except Exception:
                        pass
                    return
                # Send ping
                await ws.send_json({"type": "ping"})
        except Exception:
            # If sending fails, the main loop will eventually catch it too
            pass


class RoomManager:
    """Manages multiple signaling rooms."""

    def __init__(self):
        self._rooms: Dict[str, SignalingRoom] = {}
        self._lock = asyncio.Lock()

    async def get_room(self, room_id: str) -> SignalingRoom:
        async with self._lock:
            if room_id not in self._rooms:
                if len(self._rooms) >= MAX_ROOMS:
                    raise RoomLimitError(f"Maximum rooms ({MAX_ROOMS}) reached")
                self._rooms[room_id] = SignalingRoom(room_id)
            return self._rooms[room_id]

    async def remove_empty_rooms(self):
        """Cleanup task to remove rooms with no peers."""
        async with self._lock:
            empty_rooms = []
            for rid, r in self._rooms.items():
                # Acquire room lock to prevent race with concurrent connect()
                async with r._lock:
                    if not r._peers:
                        empty_rooms.append(rid)
            if empty_rooms:
                logger.info("Cleaning up %d empty rooms: %s", len(empty_rooms), empty_rooms)
            for rid in empty_rooms:
                del self._rooms[rid]

    async def cleanup_loop(self, interval: int = 60):
        """Infinite loop to periodically remove empty rooms."""
        while True:
            await asyncio.sleep(interval)
            await self.remove_empty_rooms()


class RoomLimitError(Exception):
    """Raised when the maximum number of rooms is reached."""
    pass


# Global room manager
manager = RoomManager()
