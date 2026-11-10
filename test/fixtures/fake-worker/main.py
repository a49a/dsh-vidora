#!/usr/bin/env python3
"""Protocol fixture used only by Node unit tests. It is not a real ASR worker."""
import json
import os
import sys
import time

PROTOCOL = 1
running = {"id": None}


def emit(message):
    sys.stdout.write(json.dumps({"protocol_version": PROTOCOL, **message}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def respond(request_id, result):
    emit({"request_id": request_id, "result": result})


def write_transcript(params):
    value = {
        "version": 1,
        "id": params["transcript_id"],
        "project_id": params["project_id"],
        "source": {
            "path": params["file_path"],
            "duration_ms": 1000,
            "sha256": params["source_sha256"],
            "size_bytes": 123,
            "container": "fake",
            "audio_codec": "fake",
            "sample_rate": 16000,
            "channels": 1,
        },
        "model": params["model"],
        "model_info": {
            "id": params["model"],
            "repo": None,
            "backend": "fake",
            "device": "cpu",
            "dtype": "float32",
            "package_version": "fake",
            "aligner": params.get("aligner_model"),
        },
        "language": "zh",
        "created_at": "2026-01-01T00:00:00.000Z",
        "params": {
            "language": params["language"],
            "align": bool(params["align"]),
            "context": params.get("context", ""),
            "max_chunk_seconds": params["max_chunk_seconds"],
            "vad": params["vad"],
            "pipeline_version": 1,
        },
        "segments": [{
            "id": "seg-000001",
            "start_ms": 0,
            "end_ms": 1000,
            "text": "测试转写。",
            "speaker_id": None,
            "timing_status": "aligned" if params["align"] else "chunk",
        }],
        "stats": {
            "segment_count": 1,
            "speech_duration_ms": 1000,
            "processing_ms": 10,
            "peak_memory_mb": 1.0,
            "realtime_factor": 0.01,
            "completed_chunks": 1,
            "total_chunks": 1,
        },
        "warnings": [],
    }
    os.makedirs(os.path.dirname(params["transcript_path"]) or ".", exist_ok=True)
    with open(params["transcript_path"], "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False)


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        message = json.loads(line)
        request_id = message["request_id"]
        method = message["method"]
        params = message.get("params") or {}
        if method == "worker.initialize":
            respond(request_id, {
                "worker_version": "fake",
                "protocol_version": 1,
                "python_version": "fake",
                "platform": "fake",
                "ffmpeg": {"available": True, "version": "fake"},
                "device": {"requested": "auto", "selected": "cpu", "torch": "fake", "cuda": False, "mps": False, "reason": "fake"},
                "models": [],
                "model_loaded": None,
            })
        elif method == "worker.get_status":
            respond(request_id, {
                "pid": os.getpid(),
                "uptime_seconds": 1,
                "device": "cpu",
                "model_loaded": None,
                "aligner_loaded": None,
                "running_task_id": running["id"],
                "queued_tasks": 0,
                "peak_memory_mb": 1.0,
                "last_error": None,
            })
        elif method == "asr.transcribe":
            running["id"] = params["task_id"]
            respond(request_id, {"task_id": params["task_id"], "status": "queued"})
            emit({
                "request_id": request_id,
                "event": "task.progress",
                "task_id": params["task_id"],
                "status": "running",
                "progress": {
                    "stage": "transcribing",
                    "processed_ms": 1000,
                    "total_ms": 1000,
                    "completed_chunks": 1,
                    "total_chunks": 1,
                },
            })
            if params.get("context") == "crash" and not params.get("resume"):
                time.sleep(0.05)
                os._exit(7)
            write_transcript(params)
            time.sleep(0.02)
            emit({
                "request_id": request_id,
                "event": "task.completed",
                "task_id": params["task_id"],
                "status": "completed",
                "result": {
                    "transcript_id": params["transcript_id"],
                    "transcript_path": params["transcript_path"],
                    "duration_ms": 1000,
                    "segment_count": 1,
                    "language": "zh",
                    "model": params["model"],
                    "processing_ms": 10,
                    "peak_memory_mb": 1.0,
                    "warnings": [],
                },
            })
            running["id"] = None
        elif method == "asr.cancel":
            task_id = params.get("task_id")
            respond(request_id, {"task_id": task_id, "status": "cancelled"})
            emit({
                "request_id": request_id,
                "event": "task.cancelled",
                "task_id": task_id,
                "status": "cancelled",
                "error": {"code": "CANCELLED", "message": "cancelled", "resumable": True},
            })
            running["id"] = None
        elif method == "worker.unload_model":
            respond(request_id, {"unloaded": True})
        elif method == "worker.shutdown":
            respond(request_id, {"shutting_down": True})
            return
        else:
            emit({"request_id": request_id, "error": {"code": "METHOD_NOT_FOUND", "message": method}})


if __name__ == "__main__":
    main()
