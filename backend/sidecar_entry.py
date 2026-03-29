"""Sidecar entry point for Tauri — starts FastAPI backend only."""
from __future__ import annotations

import argparse
import os
import sys
import threading

import uvicorn


def _watch_parent_stdin():
    """Exit when the parent process (Tauri) dies.

    Tauri pipes stdin to the sidecar. When the parent exits (normally or via
    crash), the pipe breaks and stdin.read() returns. We then force-exit to
    ensure the sidecar never outlives the desktop app.
    """
    try:
        sys.stdin.read()
    except Exception:
        pass
    os._exit(0)


def main():
    parser = argparse.ArgumentParser(description="Synced backend sidecar")
    parser.add_argument("--port", type=int, default=9876)
    parser.add_argument("--log-level", default="info",
                        choices=["debug", "info", "warning", "error"],
                        help="Logging level (default: info)")
    args = parser.parse_args()

    # Start watchdog — if the Tauri parent dies, this thread kills us
    watcher = threading.Thread(target=_watch_parent_stdin, daemon=True)
    watcher.start()

    import backend.main as backend_main

    backend_main.server_port = args.port

    # Use "info" to see signaling room events in Tauri console
    uvicorn.run(
        "backend.main:app",
        host="0.0.0.0",
        port=args.port,
        log_level=args.log_level,
    )


if __name__ == "__main__":
    main()
