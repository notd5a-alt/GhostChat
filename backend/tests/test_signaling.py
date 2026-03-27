"""Tests for the WebSocket signaling relay."""

import json

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.main import app
from backend.signaling import SignalingRoom, _TokenBucket


def _create_room(client: TestClient) -> tuple[str, str]:
    """Create a room via the API and return (room_code, token)."""
    resp = client.post("/api/rooms")
    assert resp.status_code == 200
    data = resp.json()
    return data["room_code"], data["token"]


class TestSignalingRoom:
    """Unit tests for SignalingRoom logic."""

    def test_room_starts_empty(self):
        room = SignalingRoom("test")
        assert room.is_full is False
        assert len(room._peers) == 0

    def test_validate_rejects_oversized(self):
        room = SignalingRoom("test")
        huge = json.dumps({"type": "offer", "data": "x" * 70000})
        assert room._validate(huge) is None

    def test_validate_rejects_invalid_json(self):
        room = SignalingRoom("test")
        assert room._validate("not json{{{") is None

    def test_validate_rejects_unknown_type(self):
        room = SignalingRoom("test")
        assert room._validate(json.dumps({"type": "hack"})) is None

    def test_validate_accepts_offer(self):
        room = SignalingRoom("test")
        result = room._validate(json.dumps({"type": "offer", "sdp": "v=0..."}))
        assert result is not None
        assert result["type"] == "offer"

    def test_validate_accepts_answer(self):
        room = SignalingRoom("test")
        result = room._validate(json.dumps({"type": "answer", "sdp": "v=0..."}))
        assert result is not None
        assert result["type"] == "answer"

    def test_validate_accepts_ice_candidate(self):
        room = SignalingRoom("test")
        msg = json.dumps({"type": "ice-candidate", "candidate": "a=candidate:..."})
        result = room._validate(msg)
        assert result is not None
        assert result["type"] == "ice-candidate"


class TestTokenBucket:
    """Unit tests for the rate limiter."""

    def test_allows_up_to_burst(self):
        bucket = _TokenBucket(rate=100, burst=10)
        allowed = sum(1 for _ in range(15) if bucket.consume())
        assert allowed == 10  # burst size

    def test_refills_over_time(self):
        import time
        bucket = _TokenBucket(rate=1000, burst=5)
        # Drain the bucket
        for _ in range(5):
            bucket.consume()
        assert bucket.consume() is False
        # Wait for refill
        time.sleep(0.01)  # 10ms at 1000/s = ~10 tokens
        assert bucket.consume() is True

    def test_rejects_when_empty(self):
        bucket = _TokenBucket(rate=10, burst=2)
        assert bucket.consume() is True
        assert bucket.consume() is True
        assert bucket.consume() is False


class TestSignalingWebSocket:
    """Integration tests using Starlette's TestClient WebSocket support."""

    def test_two_peers_get_peer_joined(self):
        client = TestClient(app)
        code, token = _create_room(client)
        with client.websocket_connect(f"/ws/{code}?role=host&token={token}") as ws1:
            with client.websocket_connect(f"/ws/{code}?role=join&token={token}") as ws2:
                msg1 = ws1.receive_json()
                msg2 = ws2.receive_json()
                assert msg1["type"] == "peer-joined"
                assert msg2["type"] == "peer-joined"

    def test_offer_relay(self):
        client = TestClient(app)
        code, token = _create_room(client)
        with client.websocket_connect(f"/ws/{code}?role=host&token={token}") as ws1:
            with client.websocket_connect(f"/ws/{code}?role=join&token={token}") as ws2:
                ws1.receive_json()
                ws2.receive_json()

                offer = json.dumps({"type": "offer", "sdp": "v=0\r\nfake-sdp"})
                ws1.send_text(offer)
                received = ws2.receive_json()
                assert received["type"] == "offer"
                assert received["sdp"] == "v=0\r\nfake-sdp"

    def test_answer_relay(self):
        client = TestClient(app)
        code, token = _create_room(client)
        with client.websocket_connect(f"/ws/{code}?role=host&token={token}") as ws1:
            with client.websocket_connect(f"/ws/{code}?role=join&token={token}") as ws2:
                ws1.receive_json()
                ws2.receive_json()

                answer = json.dumps({"type": "answer", "sdp": "v=0\r\nanswer-sdp"})
                ws2.send_text(answer)
                received = ws1.receive_json()
                assert received["type"] == "answer"

    def test_ice_candidate_relay(self):
        client = TestClient(app)
        code, token = _create_room(client)
        with client.websocket_connect(f"/ws/{code}?role=host&token={token}") as ws1:
            with client.websocket_connect(f"/ws/{code}?role=join&token={token}") as ws2:
                ws1.receive_json()
                ws2.receive_json()

                ice = json.dumps({"type": "ice-candidate", "candidate": "a=candidate:1 1 udp"})
                ws1.send_text(ice)
                received = ws2.receive_json()
                assert received["type"] == "ice-candidate"

    def test_invalid_role_rejected(self):
        client = TestClient(app)
        code, token = _create_room(client)
        with pytest.raises(Exception):
            with client.websocket_connect(f"/ws/{code}?role=invalid&token={token}") as ws:
                pass

    def test_duplicate_role_replaces_old(self):
        client = TestClient(app)
        code, token = _create_room(client)
        with client.websocket_connect(f"/ws/{code}?role=host&token={token}") as ws1:
            with client.websocket_connect(f"/ws/{code}?role=host&token={token}") as ws2:
                with pytest.raises(WebSocketDisconnect):
                    ws1.receive_json()

    def test_invalid_message_silently_dropped(self):
        client = TestClient(app)
        code, token = _create_room(client)
        with client.websocket_connect(f"/ws/{code}?role=host&token={token}") as ws1:
            with client.websocket_connect(f"/ws/{code}?role=join&token={token}") as ws2:
                ws1.receive_json()
                ws2.receive_json()

                ws1.send_text("not valid json")
                ws1.send_text(json.dumps({"type": "offer", "sdp": "real"}))
                received = ws2.receive_json()
                assert received["type"] == "offer"
                assert received["sdp"] == "real"

    def test_unknown_type_dropped(self):
        client = TestClient(app)
        code, token = _create_room(client)
        with client.websocket_connect(f"/ws/{code}?role=host&token={token}") as ws1:
            with client.websocket_connect(f"/ws/{code}?role=join&token={token}") as ws2:
                ws1.receive_json()
                ws2.receive_json()

                ws1.send_text(json.dumps({"type": "hack", "payload": "evil"}))
                ws1.send_text(json.dumps({"type": "answer", "sdp": "ok"}))
                received = ws2.receive_json()
                assert received["type"] == "answer"

    def test_peer_disconnect_notifies_other(self):
        """When one peer disconnects, the other receives peer-disconnected."""
        import time
        client = TestClient(app)
        code, token = _create_room(client)
        with client.websocket_connect(f"/ws/{code}?role=host&token={token}") as ws1:
            with client.websocket_connect(f"/ws/{code}?role=join&token={token}") as ws2:
                ws1.receive_json()  # peer-joined
                ws2.receive_json()  # peer-joined
                ws2.close()
                time.sleep(0.5)

            # Read messages, skipping pings, looking for peer-disconnected
            found = False
            for _ in range(5):
                try:
                    msg = ws1.receive_json()
                except Exception:
                    break
                if msg["type"] == "ping":
                    ws1.send_json({"type": "pong"})
                    continue
                if msg["type"] == "peer-disconnected":
                    found = True
                    break
            assert found, "Expected peer-disconnected notification"

    def test_token_protection(self):
        """Connections with wrong token are rejected."""
        client = TestClient(app)
        code, token = _create_room(client)
        # Host connects with correct token
        with client.websocket_connect(f"/ws/{code}?role=host&token={token}") as ws1:
            # Another host tries with WRONG token — should be rejected
            with client.websocket_connect(f"/ws/{code}?role=host&token=wrong") as ws2:
                with pytest.raises(Exception):
                    ws2.receive_json()

            # Another host with CORRECT token — replaces ws1
            with client.websocket_connect(f"/ws/{code}?role=host&token={token}") as ws3:
                with pytest.raises(WebSocketDisconnect):
                    ws1.receive_json()

    def test_room_not_found_rejected(self):
        """Connecting to a non-existent room is rejected."""
        client = TestClient(app)
        with pytest.raises(Exception):
            with client.websocket_connect("/ws/NONEXIST?role=host&token=x") as ws:
                ws.receive_json()

    def test_room_cleanup(self):
        from backend.signaling import manager
        import asyncio

        client = TestClient(app)
        code, token = _create_room(client)
        with client.websocket_connect(f"/ws/{code}?role=host&token={token}") as ws:
            pass  # Disconnect immediately

        # Room should be in manager initially (empty but exists)
        assert code in manager._rooms

        # Run cleanup manually
        asyncio.run(manager.remove_empty_rooms())

        # Room should be gone
        assert code not in manager._rooms
