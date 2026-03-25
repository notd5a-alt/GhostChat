"""Synced – zero-trust P2P desktop chat.

Development entry point. Starts the FastAPI backend server.
For production, use Tauri which spawns backend/sidecar_entry.py as a sidecar.
"""
from __future__ import annotations

import argparse
import logging
import threading
import time
import urllib.request

import uvicorn


def _configure_logging(level: str = "INFO"):
    """Set up structured logging for the backend."""
    numeric = getattr(logging, level.upper(), logging.INFO)
    logging.basicConfig(
        level=numeric,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )


def _wait_for_server(url: str, timeout: float = 10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            urllib.request.urlopen(url, timeout=1)
            return
        except Exception:
            time.sleep(0.15)
    raise RuntimeError(f"Server failed to start at {url}")


def main():
    parser = argparse.ArgumentParser(description="Synced")
    parser.add_argument("--port", type=int, default=9876)
    parser.add_argument("--dev", action="store_true", help="Dev mode (default, kept for compat)")
    parser.add_argument("--log-level", default="INFO",
                        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
                        help="Logging level (default: INFO)")
    args = parser.parse_args()

    _configure_logging(args.log_level)

    import backend.main as backend_main
    backend_main.server_port = args.port

    server_thread = threading.Thread(
        target=uvicorn.run,
        args=("backend.main:app",),
        kwargs={"host": "0.0.0.0", "port": args.port, "log_level": args.log_level.lower()},
        daemon=True,
    )
    server_thread.start()

    local_url = f"http://localhost:{args.port}"
    _wait_for_server(local_url)

    print(f"Synced backend running at {local_url}")
    print("Start the Vite dev server: cd frontend && npm run dev")
    print("Or use Tauri dev:          cargo tauri dev")
    try:
        server_thread.join()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
