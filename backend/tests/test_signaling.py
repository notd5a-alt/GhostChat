"""Tests for the WebSocket signaling relay."""

import json

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.main import app
from backend.signaling import SignalingRoom, _TokenBucket


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
        with client.websocket_connect("/ws?role=host") as ws1:
            with client.websocket_connect("/ws?role=join") as ws2:
                msg1 = ws1.receive_json()
                msg2 = ws2.receive_json()
                assert msg1["type"] == "peer-joined"
                assert msg2["type"] == "peer-joined"

    def test_offer_relay(self):
        client = TestClient(app)
        with client.websocket_connect("/ws?role=host") as ws1:
            with client.websocket_connect("/ws?role=join") as ws2:
                # Consume peer-joined
                ws1.receive_json()
                ws2.receive_json()

                # Host sends offer → Joiner receives it
                offer = json.dumps({"type": "offer", "sdp": "v=0\r\nfake-sdp"})
                ws1.send_text(offer)
                received = ws2.receive_json()
                assert received["type"] == "offer"
                assert received["sdp"] == "v=0\r\nfake-sdp"

    def test_answer_relay(self):
        client = TestClient(app)
        with client.websocket_connect("/ws?role=host") as ws1:
            with client.websocket_connect("/ws?role=join") as ws2:
                ws1.receive_json()
                ws2.receive_json()

                answer = json.dumps({"type": "answer", "sdp": "v=0\r\nanswer-sdp"})
                ws2.send_text(answer)
                received = ws1.receive_json()
                assert received["type"] == "answer"

    def test_ice_candidate_relay(self):
        client = TestClient(app)
        with client.websocket_connect("/ws?role=host") as ws1:
            with client.websocket_connect("/ws?role=join") as ws2:
                ws1.receive_json()
                ws2.receive_json()

                ice = json.dumps({"type": "ice-candidate", "candidate": "a=candidate:1 1 udp"})
                ws1.send_text(ice)
                received = ws2.receive_json()
                assert received["type"] == "ice-candidate"

    def test_invalid_role_rejected(self):
        client = TestClient(app)
        # Invalid role should be rejected with close code 4000
        with pytest.raises(Exception):
            with client.websocket_connect("/ws?role=invalid") as ws:
                pass

    def test_duplicate_role_replaces_old(self):
        client = TestClient(app)
        with client.websocket_connect("/ws?role=host") as ws1:
            # Second host connection replaces the first
            with client.websocket_connect("/ws?role=host") as ws2:
                # ws1 should be closed (replaced)
                with pytest.raises(WebSocketDisconnect):
                    ws1.receive_json()

    def test_invalid_message_silently_dropped(self):
        client = TestClient(app)
        with client.websocket_connect("/ws?role=host") as ws1:
            with client.websocket_connect("/ws?role=join") as ws2:
                ws1.receive_json()
                ws2.receive_json()

                # Send invalid message — should not be relayed
                ws1.send_text("not valid json")
                # Send a valid message after
                ws1.send_text(json.dumps({"type": "offer", "sdp": "real"}))
                received = ws2.receive_json()
                assert received["type"] == "offer"
                assert received["sdp"] == "real"

    def test_unknown_type_dropped(self):
        client = TestClient(app)
        with client.websocket_connect("/ws?role=host") as ws1:
            with client.websocket_connect("/ws?role=join") as ws2:
                ws1.receive_json()
                ws2.receive_json()

                ws1.send_text(json.dumps({"type": "hack", "payload": "evil"}))
                # Follow up with valid message to confirm relay still works
                ws1.send_text(json.dumps({"type": "answer", "sdp": "ok"}))
                received = ws2.receive_json()
                assert received["type"] == "answer"

    def test_peer_disconnect_notifies_other(self):
        """When one peer disconnects, the other receives peer-disconnected."""
        import uuid
        import time
        room_id = f"test-disconnect-{uuid.uuid4().hex[:8]}"
        client = TestClient(app)
        with client.websocket_connect(f"/ws/{room_id}?role=host") as ws1:
            with client.websocket_connect(f"/ws/{room_id}?role=join") as ws2:
                ws1.receive_json()  # peer-joined
                ws2.receive_json()  # peer-joined
                ws2.close()
                # Give the server time to process the disconnect
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
        client = TestClient(app)
        # Host connects with a token
        with client.websocket_connect("/ws?role=host&token=secret") as ws1:
            # Another host tries to connect with WRONG token — socket is accepted then closed
            with client.websocket_connect("/ws?role=host&token=wrong") as ws2:
                # The hijacker should receive a close frame (4000)
                with pytest.raises(Exception):
                    ws2.receive_json()
            
            # Another host tries to connect WITH CORRECT token - should succeed and replace ws1
            with client.websocket_connect("/ws?role=host&token=secret") as ws3:
                with pytest.raises(WebSocketDisconnect):
                    ws1.receive_json()

    def test_room_cleanup(self):
        from backend.signaling import manager
        import asyncio
        
        client = TestClient(app)
        # Connect to a specific room
        with client.websocket_connect("/ws/cleanup-room?role=host") as ws:
            pass # Disconnect immediately
        
        # Room should be in manager initially (empty but exists)
        assert "cleanup-room" in manager._rooms
        
        # Run cleanup manually
        asyncio.run(manager.remove_empty_rooms())
        
        # Room should be gone
        assert "cleanup-room" not in manager._rooms
