from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import time
from typing import Dict

from fastapi import WebSocket, WebSocketDisconnect

logger = logging.getLogger("synced.signaling")

MAX_MESSAGE_SIZE = 65536  # 64 KB
MAX_ROOMS = int(os.environ.get("SYNCED_MAX_ROOMS", 100))           # Cap total rooms (= 200 max connections)
HEARTBEAT_INTERVAL = int(os.environ.get("SYNCED_HEARTBEAT_INTERVAL", 30))   # seconds between pings
HEARTBEAT_TIMEOUT = int(os.environ.get("SYNCED_HEARTBEAT_TIMEOUT", 300))   # close if no pong within this many seconds
                          # (Chrome throttles background tabs to ~1 timer/min)
IDLE_TIMEOUT = int(os.environ.get("SYNCED_IDLE_TIMEOUT", 1800))       # close if no signaling messages in 30 minutes
WS_ACCEPT_TIMEOUT = 10    # H1: seconds to wait for WebSocket handshake
ALLOWED_TYPES = {"offer", "answer", "ice-candidate", "ping", "pong", "screen-sharing"}

ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # 32 chars, no ambiguous 0/O/1/l/I
ROOM_CODE_LENGTH = 6
VALID_ROLES = {"host", "join"}

# Rate limiting: token bucket per peer
RATE_LIMIT = int(os.environ.get("SYNCED_RATE_LIMIT", 100))          # messages per second
RATE_BURST = int(os.environ.get("SYNCED_RATE_BURST", 200))          # max burst size

# Per-IP connection limiting
MAX_CONNECTIONS_PER_IP = int(os.environ.get("SYNCED_MAX_CONNECTIONS_PER_IP", 4))  # at most 4 concurrent WS connections per IP


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
        elapsed = max(0.0, now - self._last)  # clamp negative (defensive)
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
        self._tokens: Dict[str, str] = {}       # role -> per-connection token (legacy)
        self._room_token: str = ""               # shared room token — required for all connections
        self._last_pong: Dict[str, float] = {}   # role -> timestamp
        self._last_activity: float = time.monotonic()  # updated on real signaling messages
        self._lock = asyncio.Lock()

    @property
    def is_full(self) -> bool:
        return "host" in self._peers and "join" in self._peers

    async def connect(self, ws: WebSocket, role: str, token: str | None = None) -> bool:
        """Add a peer by role. Token must match the room token set at creation."""
        if role not in VALID_ROLES:
            logger.warning("[%s] rejected invalid role: %r", self.room_id, role)
            return False

        # Accept WebSocket before acquiring lock to avoid blocking other peers
        # H1: Timeout prevents Slowloris-style attacks on the handshake
        try:
            await asyncio.wait_for(ws.accept(), timeout=WS_ACCEPT_TIMEOUT)
        except asyncio.TimeoutError:
            logger.warning("[%s] WebSocket accept timeout for %s", self.room_id, role)
            return False

        async with self._lock:
            # Enforce room token — every connection must present it
            if self._room_token and token != self._room_token:
                logger.warning("[%s] rejected %s: invalid room token", self.room_id, role)
                try:
                    await ws.close(code=4000, reason="Invalid token")
                except Exception as e:
                    logger.debug("[%s] close after token rejection failed: %s", self.room_id, e)
                return False

            # If this role already has a connection, replace it (reconnect)
            if role in self._peers:
                old = self._peers[role]
                logger.info("[%s] replacing stale %s connection", self.room_id, role)
                try:
                    await old.close(code=4001, reason="Replaced by new connection")
                except Exception as e:
                    logger.debug("[%s] close of replaced %s connection failed: %s", self.room_id, role, e)

            self._peers[role] = ws
            self._last_pong[role] = time.monotonic()

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
                    except Exception as e:
                        logger.debug("[%s] failed to send peer-disconnected: %s", self.room_id, e)

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
        # Collect the target peer inside the lock, send OUTSIDE to prevent deadlock
        # (send_text can block if the peer's buffer is full, holding the lock indefinitely)
        async with self._lock:
            other = None
            for peer in self._peers.values():
                if peer is not ws:
                    other = peer
                    break

        disconnect_peer = None
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

        if disconnect_peer:
            await self.disconnect(disconnect_peer)

    async def handle(self, ws: WebSocket, role: str, token: str | None = None):
        """Full lifecycle: connect, relay messages, handle disconnect."""
        accepted = await self.connect(ws, role, token)
        if not accepted:
            # connect() may have already closed the socket (e.g., token hijack)
            try:
                await ws.close(code=4000, reason="Invalid role")
            except Exception as e:
                logger.debug("[%s] close after rejection failed: %s", self.room_id, e)
            return

        # Start a heartbeat task for this connection
        heartbeat_task = asyncio.create_task(self._heartbeat(ws, role))
        bucket = _TokenBucket()
        throttle_warnings = 0

        try:
            while True:
                # M1: Timeout on receive as safety net — heartbeat should close
                # dead connections first, but this catches edge cases where both
                # the TCP connection and heartbeat are stuck.
                try:
                    data = await asyncio.wait_for(
                        ws.receive_text(),
                        timeout=HEARTBEAT_TIMEOUT + HEARTBEAT_INTERVAL + 10,
                    )
                except asyncio.TimeoutError:
                    logger.warning("[%s] receive timeout for %s, closing", self.room_id, role)
                    await ws.close(code=4009, reason="Receive timeout")
                    return
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
                    if msg_type in {"offer", "answer", "ice-candidate", "screen-sharing"}:
                        self._last_activity = time.monotonic()
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
                    except Exception as e:
                        logger.debug("[%s] close after heartbeat timeout failed: %s", self.room_id, e)
                    return
                # Check for room-level idle timeout (no real signaling messages)
                if time.monotonic() - self._last_activity > IDLE_TIMEOUT:
                    logger.warning("[%s] idle timeout for %s (no signaling activity in %ds), closing",
                                   self.room_id, role, IDLE_TIMEOUT)
                    try:
                        await ws.close(code=4007, reason="Idle timeout")
                    except Exception as e:
                        logger.debug("[%s] close after idle timeout failed: %s", self.room_id, e)
                    return
                # Send ping
                await ws.send_json({"type": "ping"})
        except asyncio.CancelledError:
            raise  # H4: Let cancellation propagate cleanly
        except Exception as e:
            logger.debug("[%s] heartbeat loop ended for %s: %s", self.room_id, role, e)


class RoomManager:
    """Manages multiple signaling rooms."""

    def __init__(self):
        self._rooms: Dict[str, SignalingRoom] = {}
        self._lock = asyncio.Lock()
        self._ip_connections: Dict[str, int] = {}  # IP -> active connection count
        self._ip_lock = asyncio.Lock()

    async def create_room(self) -> tuple[str, str]:
        """Generate a unique room code, a room token, and pre-create the room.

        Returns (room_code, room_token). The token must be presented by both
        peers when connecting via WebSocket to prevent room hijacking.
        """
        async with self._lock:
            if len(self._rooms) >= MAX_ROOMS:
                raise RoomLimitError(f"Maximum rooms ({MAX_ROOMS}) reached")
            for _ in range(100):  # retry on collision
                code = "".join(secrets.choice(ROOM_CODE_ALPHABET) for _ in range(ROOM_CODE_LENGTH))
                if code not in self._rooms:
                    token = secrets.token_urlsafe(32)
                    room = SignalingRoom(code)
                    room._room_token = token
                    self._rooms[code] = room
                    logger.info("Created room %s (%d total)", code, len(self._rooms))
                    return code, token
            raise RoomLimitError("Could not generate unique room code")

    async def room_exists(self, room_id: str) -> tuple[bool, bool]:
        """Returns (exists, joinable). Joinable = exists and not full."""
        async with self._lock:
            room = self._rooms.get(room_id)
            if not room:
                return False, False
            return True, not room.is_full

    async def room_info(self, room_id: str) -> tuple[bool, bool, str]:
        """Returns (exists, joinable, token). Token is returned only if joinable."""
        async with self._lock:
            room = self._rooms.get(room_id)
            if not room:
                return False, False, ""
            joinable = not room.is_full
            return True, joinable, room._room_token if joinable else ""

    async def get_room(self, room_id: str) -> SignalingRoom | None:
        """Return an existing room, or None if it doesn't exist.

        Rooms must be created via create_room() — the WS endpoint should
        not auto-create rooms, which would allow attackers to fill the room
        cap or enumerate codes.
        """
        async with self._lock:
            return self._rooms.get(room_id)

    async def acquire_ip(self, ip: str) -> bool:
        """Increment connection count for an IP. Returns False if over limit."""
        async with self._ip_lock:
            count = self._ip_connections.get(ip, 0)
            if count >= MAX_CONNECTIONS_PER_IP:
                return False
            self._ip_connections[ip] = count + 1
            return True

    async def release_ip(self, ip: str) -> None:
        """Decrement connection count for an IP."""
        async with self._ip_lock:
            count = self._ip_connections.get(ip, 0)
            if count <= 0:
                # M2: Underflow guard — log and bail if release without acquire
                logger.warning("release_ip called for %s with count=%d, ignoring", ip, count)
                self._ip_connections.pop(ip, None)
                return
            if count <= 1:
                self._ip_connections.pop(ip, None)
            else:
                self._ip_connections[ip] = count - 1

    async def remove_empty_rooms(self):
        """Cleanup task to remove rooms with no peers.

        Holds both manager lock AND room lock when deleting to prevent a race
        where a peer (holding an existing room ref) calls connect() between
        our empty check and the deletion.
        """
        async with self._lock:
            empty_rooms: list[str] = []
            for rid, r in list(self._rooms.items()):
                async with r._lock:
                    if not r._peers:
                        # Delete while still holding room lock so no connect()
                        # can sneak in between check and removal
                        empty_rooms.append(rid)
                        del self._rooms[rid]
            if empty_rooms:
                logger.info("Cleaning up %d empty rooms: %s", len(empty_rooms), empty_rooms)

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
