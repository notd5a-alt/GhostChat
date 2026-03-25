"""Sidecar entry point for Tauri — starts FastAPI backend only."""
from __future__ import annotations

import argparse

import uvicorn


def main():
    parser = argparse.ArgumentParser(description="Synced backend sidecar")
    parser.add_argument("--port", type=int, default=9876)
    args = parser.parse_args()

    import backend.main as backend_main

    backend_main.server_port = args.port

    # Use "info" to see signaling room events in Tauri console
    uvicorn.run(
        "backend.main:app",
        host="0.0.0.0",
        port=args.port,
        log_level="info",
    )


if __name__ == "__main__":
    main()
