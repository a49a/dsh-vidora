#!/usr/bin/env python3
"""Vidora Python Worker: JSON Lines over stdin/stdout, diagnostics on stderr."""

from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
from typing import Optional

# Keep HF/Transformers offline. The setup script is the only code allowed to
# download model weights, and it runs outside this process.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

from protocol import WorkerError, install_stdout_guard, parse_request  # noqa: E402
from server import WorkerServer  # noqa: E402

LOGGER = logging.getLogger("vidora.worker")


def configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        stream=sys.stderr,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Vidora local ASR worker")
    parser.add_argument("--data-dir", default=os.environ.get("VIDORA_DATA_DIR") or os.getcwd())
    parser.add_argument("--log-level", default="info")
    args = parser.parse_args(argv)

    install_stdout_guard()
    configure_logging(args.log_level)
    LOGGER.info("Vidora worker starting (data_dir=%s)", args.data_dir)
    server = WorkerServer(args.data_dir)

    def handle_signal(signum, _frame):
        LOGGER.info("received signal %s; shutting down", signum)
        server.shutdown_requested = True
        if server.running_task is not None:
            server.running_task.cancel_event.set()
        # Closing stdin makes the blocking readline below return.
        try:
            sys.stdin.close()
        except Exception:
            pass

    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(signum, handle_signal)
        except (ValueError, OSError):
            pass

    try:
        while not server.shutdown_requested:
            line = sys.stdin.readline()
            if line == "":
                break
            line = line.strip()
            if not line:
                continue
            try:
                request = parse_request(line)
            except WorkerError as exc:
                LOGGER.error("invalid request: %s", exc.message)
                continue
            except Exception as exc:  # pragma: no cover - safety net
                LOGGER.exception("request parse failed: %s", exc)
                continue
            try:
                keep_running = server.handle(request)
            except WorkerError as exc:
                from protocol import respond_error

                respond_error(request.request_id, exc.code, exc.message, exc.stage, exc.details)
                keep_running = True
            except Exception as exc:  # pragma: no cover - safety net
                LOGGER.exception("request failed: %s", exc)
                from protocol import respond_error

                respond_error(request.request_id, "WORKER_REQUEST_FAILED", str(exc)[:800])
                keep_running = True
            if not keep_running:
                break
    finally:
        server.close()
        LOGGER.info("Vidora worker stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
