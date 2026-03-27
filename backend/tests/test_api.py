"""Tests for the REST API endpoints."""

import pytest
from httpx import AsyncClient, ASGITransport

from backend.main import app


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.mark.anyio
async def test_info_returns_ip_and_port(client):
    resp = await client.get("/api/info")
    assert resp.status_code == 200
    data = resp.json()
    assert "ip" in data
    assert "port" in data
    assert isinstance(data["port"], int)


@pytest.mark.anyio
async def test_ice_config_returns_stun_servers(client):
    resp = await client.get("/api/ice-config")
    assert resp.status_code == 200
    data = resp.json()
    assert "iceServers" in data
    servers = data["iceServers"]
    assert len(servers) >= 2
    # First server should be Google STUN
    assert "stun:stun.l.google.com:19302" in servers[0]["urls"]


@pytest.mark.anyio
async def test_ice_config_stun_only_without_turn_env(client):
    """Without TURN env vars, only STUN servers are returned (zero-trust)."""
    resp = await client.get("/api/ice-config")
    data = resp.json()
    servers = data["iceServers"]
    # Should have exactly 2 STUN servers, no TURN fallback
    assert len(servers) == 2
    for s in servers:
        assert "username" not in s
        assert "credential" not in s


@pytest.mark.anyio
async def test_debug_endpoint_gated(client):
    """Debug endpoint returns 404 unless SYNCED_DEBUG=1."""
    resp = await client.get("/api/debug")
    assert resp.status_code == 404


@pytest.mark.anyio
async def test_info_ip_is_string(client):
    resp = await client.get("/api/info")
    data = resp.json()
    assert isinstance(data["ip"], str)
    assert "." in data["ip"]


@pytest.mark.anyio
async def test_create_room_returns_code_and_token(client):
    resp = await client.post("/api/rooms")
    assert resp.status_code == 200
    data = resp.json()
    assert "room_code" in data
    assert "token" in data
    assert len(data["room_code"]) == 6
    assert len(data["token"]) > 0


@pytest.mark.anyio
async def test_check_room_exists(client):
    # Create a room first
    create_resp = await client.post("/api/rooms")
    code = create_resp.json()["room_code"]

    resp = await client.get(f"/api/rooms/{code}")
    data = resp.json()
    assert data["exists"] is True
    assert data["joinable"] is True
    assert "token" in data


@pytest.mark.anyio
async def test_check_room_not_found(client):
    resp = await client.get("/api/rooms/ZZZZZ9")
    data = resp.json()
    assert data["exists"] is False
    assert data["joinable"] is False
    assert "token" not in data
