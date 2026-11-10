"""JSON Lines protocol helpers for the Vidora Python Worker.

stdout carries protocol messages only. All diagnostics go to stderr.
"""

from __future__ import annotations

import json
import sys
import threading
from dataclasses import dataclass
from typing import Any, Dict, Optional

PROTOCOL_VERSION = 1
WORKER_VERSION = "0.1.0"

_PROTOCOL_OUT = sys.stdout
_PROTOCOL_LOCK = threading.Lock()


class WorkerError(Exception):
    """A stable, user-actionable worker failure."""

    def __init__(self, message: str, code: str, stage: Optional[str] = None, details: Any = None):
        super().__init__(message)
        self.code = code
        self.stage = stage
        self.details = details


@dataclass
class Request:
    request_id: str
    method: str
    params: Dict[str, Any]


def install_stdout_guard() -> None:
    """Send accidental print() output to stderr so it cannot corrupt IPC."""
    sys.stdout = sys.stderr


def emit(message: Dict[str, Any]) -> None:
    payload = {"protocol_version": PROTOCOL_VERSION, **message}
    line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    with _PROTOCOL_LOCK:
        try:
            _PROTOCOL_OUT.write(line + "\n")
            _PROTOCOL_OUT.flush()
        except (BrokenPipeError, OSError):
            # The host closed the pipe. There is nowhere useful to report this.
            pass


def respond(request_id: str, result: Any) -> None:
    emit({"request_id": request_id, "result": result})


def respond_error(
    request_id: str,
    code: str,
    message: str,
    stage: Optional[str] = None,
    details: Any = None,
) -> None:
    error: Dict[str, Any] = {"code": code, "message": message}
    if stage is not None:
        error["stage"] = stage
    if details is not None:
        error["details"] = details
    emit({"request_id": request_id, "error": error})


def event(
    request_id: str,
    name: str,
    task_id: Optional[str] = None,
    **fields: Any,
) -> None:
    payload: Dict[str, Any] = {"request_id": request_id, "event": name}
    if task_id is not None:
        payload["task_id"] = task_id
    payload.update(fields)
    emit(payload)


def parse_request(line: str) -> Request:
    try:
        value = json.loads(line)
    except json.JSONDecodeError as exc:
        raise WorkerError(f"Invalid JSON request: {exc.msg}", "INVALID_JSON") from exc
    if not isinstance(value, dict):
        raise WorkerError("Request must be a JSON object", "INVALID_REQUEST")
    version = value.get("protocol_version")
    if version != PROTOCOL_VERSION:
        raise WorkerError(
            f"Unsupported protocol_version {version!r}; expected {PROTOCOL_VERSION}",
            "PROTOCOL_VERSION_MISMATCH",
        )
    request_id = value.get("request_id")
    if not isinstance(request_id, str) or not request_id:
        raise WorkerError("request_id must be a non-empty string", "INVALID_REQUEST")
    method = value.get("method")
    if not isinstance(method, str) or not method:
        raise WorkerError("method must be a non-empty string", "INVALID_REQUEST")
    params = value.get("params") or {}
    if not isinstance(params, dict):
        raise WorkerError("params must be an object", "INVALID_REQUEST")
    return Request(request_id=request_id, method=method, params=params)
