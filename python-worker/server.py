from __future__ import annotations

import logging
import os
import platform
import queue
import sys
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from alignment.qwen3_aligner import Qwen3Aligner
from asr.qwen3 import Qwen3ASRBackend
from config import TranscribeConfig, WorkerConfig
from device import detect_device
from media import ffmpeg
from protocol import (
    PROTOCOL_VERSION,
    WORKER_VERSION,
    Request,
    WorkerError,
    emit,
    event,
    respond,
    respond_error,
)
from tasks import TaskExecutor, TaskRecord, peak_memory_mb, sha256_file, utc_now, write_json_atomic

LOGGER = logging.getLogger("vidora.worker")


class WorkerServer:
    def __init__(self, data_dir: str):
        self.data_dir = os.path.abspath(data_dir)
        self.config = WorkerConfig(
            data_dir=self.data_dir,
            models_dir=os.path.join(self.data_dir, "models"),
        )
        self.tasks: Dict[str, TaskRecord] = {}
        self.task_queue: "queue.Queue[TaskRecord]" = queue.Queue()
        self.running_task: Optional[TaskRecord] = None
        self.asr: Optional[Qwen3ASRBackend] = None
        self.aligner: Optional[Qwen3Aligner] = None
        self.model_lock = threading.RLock()
        self.started_at = time.monotonic()
        self.last_used = time.monotonic()
        self.last_error: Optional[str] = None
        self.shutdown_requested = False
        self.unload_requested = False
        self.initialized = False
        self.device_info = detect_device("auto", "auto")
        self.worker_thread = threading.Thread(target=self._task_loop, name="vidora-task-loop", daemon=True)
        self.worker_thread.start()
        self.idle_thread = threading.Thread(target=self._idle_loop, name="vidora-idle-loop", daemon=True)
        self.idle_thread.start()

    # ------------------------------------------------------------------ init

    def initialize(self, params: Dict[str, Any]) -> dict:
        self.config = WorkerConfig.from_params({**params, "data_dir": self.data_dir})
        os.makedirs(self.config.data_dir, exist_ok=True)
        os.makedirs(self.config.models_dir, exist_ok=True)
        os.makedirs(os.path.join(self.config.data_dir, "logs"), exist_ok=True)
        self.device_info = detect_device(self.config.device, self.config.dtype)
        self.initialized = True
        models = self._model_availability()
        return {
            "worker_version": WORKER_VERSION,
            "protocol_version": PROTOCOL_VERSION,
            "python_version": sys.version.split()[0],
            "platform": f"{platform.system()} {platform.machine()}",
            "ffmpeg": {
                "available": bool(ffmpeg.ffmpeg_version()),
                "version": ffmpeg.ffmpeg_version(),
            },
            "device": self.device_info.as_dict(),
            "models": models,
            "model_loaded": self.asr.info()["id"] if self.asr else None,
        }

    # ------------------------------------------------------------------ dispatch

    def handle(self, request: Request) -> bool:
        """Handle one request. Returns False when the process should exit."""
        method = request.method
        if method == "worker.initialize":
            try:
                result = self.initialize(request.params)
                respond(request.request_id, result)
            except WorkerError as exc:
                respond_error(request.request_id, exc.code, exc.message, exc.stage, exc.details)
            except Exception as exc:
                LOGGER.exception("initialize failed")
                respond_error(request.request_id, "INITIALIZE_FAILED", str(exc)[:800])
            return True

        if method == "worker.get_status":
            respond(request.request_id, self.status())
            return True

        if method == "asr.transcribe":
            return self._handle_transcribe(request)

        if method == "asr.cancel":
            return self._handle_cancel(request)

        if method == "worker.unload_model":
            return self._handle_unload(request)

        if method == "worker.shutdown":
            return self._handle_shutdown(request)

        respond_error(
            request.request_id,
            "METHOD_NOT_FOUND",
            f"Unknown method: {method}",
        )
        return True

    def _handle_transcribe(self, request: Request) -> bool:
        try:
            params = TranscribeConfig.from_params(request.params)
        except Exception as exc:
            respond_error(request.request_id, "INVALID_TRANSCRIBE_PARAMS", str(exc)[:800])
            return True
        existing = self.tasks.get(params.task_id)
        if existing and existing.status in ("queued", "running", "cancelling"):
            respond(request.request_id, {"task_id": params.task_id, "status": existing.status})
            return True
        if existing and existing.status == "completed":
            respond(request.request_id, {"task_id": params.task_id, "status": "completed"})
            return True
        if self.task_queue.qsize() > 100:
            respond_error(
                request.request_id,
                "TOO_MANY_TASKS",
                "The Vidora worker queue is full (100 queued tasks).",
            )
            return True
        task = TaskRecord(task_id=params.task_id, request_id=request.request_id, params=params)
        self.tasks[params.task_id] = task
        self.task_queue.put(task)
        LOGGER.info("queued task %s (model=%s, align=%s)", params.task_id, params.model, params.align)
        respond(request.request_id, {"task_id": params.task_id, "status": "queued"})
        return True

    def _handle_cancel(self, request: Request) -> bool:
        task_id = request.params.get("task_id")
        if not isinstance(task_id, str) or not task_id:
            respond_error(request.request_id, "INVALID_TASK_ID", "task_id must be a non-empty string")
            return True
        task = self.tasks.get(task_id)
        if not task:
            respond_error(request.request_id, "TASK_NOT_FOUND", f"Unknown task: {task_id}")
            return True
        if task.status in ("completed", "failed", "cancelled"):
            respond(request.request_id, {"task_id": task_id, "status": task.status})
            return True
        task.cancel_event.set()
        task.status = "cancelling"
        LOGGER.info("cancel requested for %s", task_id)
        respond(request.request_id, {"task_id": task_id, "status": "cancelling"})
        return True

    def _handle_unload(self, request: Request) -> bool:
        if self.running_task is not None:
            self.unload_requested = True
            respond(request.request_id, {
                "unloaded": False,
                "reason": "a task is running; models will unload after it reaches a safe point",
            })
            return True
        self.unload_models()
        respond(request.request_id, {"unloaded": True})
        return True

    def _handle_shutdown(self, request: Request) -> bool:
        wait_ms = int(request.params.get("wait_for_running_ms") or 0)
        cancel_running = bool(request.params.get("cancel_running", False))
        deadline = time.monotonic() + max(0, wait_ms) / 1000
        while self.running_task is not None and time.monotonic() < deadline:
            time.sleep(0.2)
        if self.running_task is not None and cancel_running:
            self.running_task.cancel_event.set()
            self.running_task.status = "cancelling"
            deadline = time.monotonic() + 5
            while self.running_task is not None and time.monotonic() < deadline:
                time.sleep(0.2)
        # Give a cancelled task time to persist its checkpoint before the
        # process exits. The host may SIGKILL after its own timeout.
        wait_until = time.monotonic() + 5
        while self.running_task is not None and time.monotonic() < wait_until:
            time.sleep(0.1)
        self.shutdown_requested = True
        self.unload_models()
        respond(request.request_id, {
            "shutting_down": True,
            "running_task": self.running_task.task_id if self.running_task else None,
        })
        return False

    # ------------------------------------------------------------------ task loop

    def _task_loop(self) -> None:
        while not self.shutdown_requested:
            try:
                task = self.task_queue.get(timeout=0.5)
            except queue.Empty:
                continue
            if task.cancel_event.is_set():
                task.status = "cancelled"
                task.stage = "cancelled"
                self.cancelled(task, True)
                self.task_queue.task_done()
                continue
            self.running_task = task
            self.last_used = time.monotonic()
            task.status = "running"
            task.stage = "preparing"
            LOGGER.info("running task %s", task.task_id)
            try:
                executor = TaskExecutor(self.config, self)
                executor.execute(task)
            except Exception:
                LOGGER.exception("task executor crashed")
                self.last_error = f"task {task.task_id} crashed"
                self.failed(task, "TASK_CRASHED", "The worker task thread crashed; check worker logs.", task.stage or "failed", True)
            finally:
                self.running_task = None
                self.last_used = time.monotonic()
                self.task_queue.task_done()
                if self.unload_requested and self.task_queue.empty():
                    self.unload_requested = False
                    self.unload_models()

    def _idle_loop(self) -> None:
        while not self.shutdown_requested:
            time.sleep(5)
            if self.config.idle_unload_seconds <= 0:
                continue
            if self.running_task is not None or not self.task_queue.empty():
                continue
            idle = time.monotonic() - self.last_used
            if idle >= self.config.idle_unload_seconds and (self.asr or self.aligner):
                LOGGER.info("idle unload after %.0f seconds", idle)
                self.unload_models()

    # ------------------------------------------------------------------ hooks for TaskExecutor

    def ensure_asr(self, params: TranscribeConfig):
        with self.model_lock:
            if self.asr is not None and self.asr.model_id == params.model:
                self.last_used = time.monotonic()
                return self.asr
            if self.asr is not None:
                self.asr.unload()
                self.asr = None
            info = detect_device(params.device or self.config.device, params.dtype or self.config.dtype)
            self.device_info = info
            backend = Qwen3ASRBackend(
                model_id=params.model,
                model_path=params.model_path,
                repo=None,
                device=info.selected,
                dtype_name=info.dtype,
                max_new_tokens=params.max_new_tokens,
            )
            backend.load()
            self.asr = backend
            self.last_used = time.monotonic()
            LOGGER.info("loaded ASR model %s on %s", params.model, backend.selected_device)
            return backend

    def ensure_aligner(self, params: TranscribeConfig):
        if not params.aligner_model_path or not params.aligner_model:
            return None
        with self.model_lock:
            if self.aligner is not None and self.aligner.model_id == params.aligner_model:
                self.last_used = time.monotonic()
                return self.aligner
            if self.aligner is not None:
                self.aligner.unload()
                self.aligner = None
            info = detect_device(params.device or self.config.device, params.dtype or self.config.dtype)
            aligner = Qwen3Aligner(
                model_id=params.aligner_model,
                model_path=params.aligner_model_path,
                device=info.selected,
                dtype_name=info.dtype,
            )
            aligner.load()
            self.aligner = aligner
            self.last_used = time.monotonic()
            LOGGER.info("loaded aligner %s on %s", params.aligner_model, aligner.selected_device)
            return aligner

    def progress(
        self,
        task: TaskRecord,
        stage: str,
        processed_ms: int,
        total_ms: int,
        completed_chunks: int,
        total_chunks: int,
    ) -> None:
        task.stage = stage
        event(
            task.request_id,
            "task.progress",
            task.task_id,
            progress={
                "stage": stage,
                "processed_ms": max(0, int(processed_ms)),
                "total_ms": max(0, int(total_ms)),
                "completed_chunks": max(0, int(completed_chunks)),
                "total_chunks": max(0, int(total_chunks)),
            },
            status=task.status,
        )

    def completed(self, task: TaskRecord, result: Dict[str, Any]) -> None:
        task.status = "completed"
        task.stage = "completed"
        event(task.request_id, "task.completed", task.task_id, status="completed", result=result)
        LOGGER.info("completed task %s", task.task_id)

    def failed(self, task: TaskRecord, code: str, message: str, stage: str, resumable: bool) -> None:
        task.status = "failed"
        task.stage = stage or "failed"
        task.error = {"code": code, "message": message, "stage": task.stage}
        self.last_error = f"{code}: {message[:300]}"
        event(
            task.request_id,
            "task.failed",
            task.task_id,
            status="failed",
            error={"code": code, "message": message, "stage": stage, "resumable": resumable},
        )
        LOGGER.error("task %s failed: %s %s", task.task_id, code, message[:300])

    def cancelled(self, task: TaskRecord, resumable: bool) -> None:
        event(
            task.request_id,
            "task.cancelled",
            task.task_id,
            status="cancelled",
            error={
                "code": "CANCELLED",
                "message": "Task cancelled; checkpoint retained.",
                "stage": task.stage,
                "resumable": resumable,
            },
        )
        LOGGER.info("cancelled task %s", task.task_id)

    # ------------------------------------------------------------------ models/status

    def unload_models(self) -> None:
        with self.model_lock:
            if self.asr is not None:
                self.asr.unload()
                self.asr = None
            if self.aligner is not None:
                self.aligner.unload()
                self.aligner = None
            import gc

            gc.collect()

    def status(self) -> dict:
        return {
            "pid": os.getpid(),
            "uptime_seconds": round(time.monotonic() - self.started_at, 1),
            "device": self.device_info.selected,
            "model_loaded": self.asr.info()["id"] if self.asr else None,
            "aligner_loaded": self.aligner.info()["id"] if self.aligner else None,
            "running_task_id": self.running_task.task_id if self.running_task else None,
            "queued_tasks": self.task_queue.qsize(),
            "peak_memory_mb": peak_memory_mb(),
            "last_error": self.last_error,
        }

    def _model_availability(self) -> List[dict]:
        result = []
        for model_id, path in sorted(self.config.model_paths.items()):
            installed = self._model_installed(path)
            result.append({
                "id": model_id,
                "path": path,
                "installed": installed,
                "bytes": directory_size(path) if installed else 0,
            })
        return result

    @staticmethod
    def _model_installed(path: str) -> bool:
        if not os.path.isfile(os.path.join(path, "config.json")):
            return False
        return (
            os.path.isfile(os.path.join(path, "model.safetensors"))
            or os.path.isfile(os.path.join(path, "model.safetensors.index.json"))
        )

    # ------------------------------------------------------------------ lifecycle

    def close(self) -> None:
        self.shutdown_requested = True
        if self.running_task is not None:
            self.running_task.cancel_event.set()
        deadline = time.monotonic() + 5
        while self.running_task is not None and time.monotonic() < deadline:
            time.sleep(0.1)
        try:
            self.worker_thread.join(timeout=2)
        except Exception:
            pass
        self.unload_models()


def directory_size(path: str) -> int:
    total = 0
    try:
        for root, _dirs, files in os.walk(path):
            for name in files:
                try:
                    total += os.path.getsize(os.path.join(root, name))
                except OSError:
                    pass
    except OSError:
        pass
    return total
