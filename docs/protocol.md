# Worker IPC Protocol (JSON Lines, version 1)

The Node plugin starts `python-worker/main.py` with `child_process.spawn()`.
There is no TCP/HTTP listener.

- **stdin**: one JSON request per line.
- **stdout**: one JSON message per line. No other output is allowed.
- **stderr**: human-readable logs and diagnostics.

Every message contains `protocol_version: 1`. Requests and responses contain
`request_id`. Events also contain the originating `request_id` and a `task_id`
when they refer to a transcription task.

## Request

```json
{
  "protocol_version": 1,
  "request_id": "req-001",
  "method": "asr.transcribe",
  "params": {}
}
```

## Response

Success:

```json
{
  "protocol_version": 1,
  "request_id": "req-001",
  "result": { "task_id": "task-001", "status": "queued" }
}
```

Failure:

```json
{
  "protocol_version": 1,
  "request_id": "req-001",
  "error": {
    "code": "MODEL_NOT_FOUND",
    "message": "Local ASR model is not installed",
    "stage": "preparing",
    "details": {}
  }
}
```

`details` is optional and may contain structured diagnostics. It must not
contain transcript text.

## Methods

### `worker.initialize`

Must be the first request. Does not load the ASR model; it validates paths,
detects the device, and reports model availability.

```json
{
  "protocol_version": 1,
  "request_id": "req-init",
  "method": "worker.initialize",
  "params": {
    "data_dir": "/Users/me/Library/Application Support/Vidora",
    "models_dir": "/Users/me/Library/Application Support/Vidora/models",
    "device": "auto",
    "dtype": "auto",
    "log_level": "info",
    "model_paths": {
      "qwen3-asr-0.6b": ".../Qwen3-ASR-0.6B",
      "qwen3-forced-aligner-0.6b": ".../Qwen3-ForcedAligner-0.6B"
    },
    "offline": true,
    "idle_unload_seconds": 900,
    "max_duration_minutes": 480,
    "max_file_size_bytes": 21474836480
  }
}
```

Result:

```json
{
  "worker_version": "0.1.0",
  "protocol_version": 1,
  "python_version": "3.10.9",
  "platform": "Darwin arm64",
  "ffmpeg": { "available": true, "version": "ffmpeg version ..." },
  "device": {
    "requested": "auto",
    "selected": "mps",
    "torch": "2.14.1",
    "cuda": false,
    "mps": true,
    "reason": "Auto selected Apple Metal (MPS) on Darwin arm64",
    "dtype": "float16"
  },
  "models": [
    { "id": "qwen3-asr-0.6b", "path": "...", "installed": true, "bytes": 1876091704 }
  ],
  "model_loaded": null
}
```

### `asr.transcribe`

Asynchronous. Returns immediately after enqueueing. Model loading and media
processing happen on the task thread.

```json
{
  "protocol_version": 1,
  "request_id": "req-002",
  "method": "asr.transcribe",
  "params": {
    "task_id": "task-001",
    "file_path": "/Users/me/Videos/lecture.mp4",
    "source_sha256": "…",
    "project_id": "prj-…",
    "transcript_id": "tr-…",
    "transcript_path": "/data/projects/prj-…/transcripts/tr-….json",
    "task_dir": "/data/tasks/task-001",
    "model": "qwen3-asr-0.6b",
    "model_path": "/data/models/Qwen3-ASR-0.6B",
    "aligner_model": "qwen3-forced-aligner-0.6b",
    "aligner_model_path": "/data/models/Qwen3-ForcedAligner-0.6B",
    "language": "auto",
    "align": true,
    "context": "操作系统课程；保留中英文术语",
    "device": "auto",
    "dtype": "auto",
    "max_chunk_seconds": 30,
    "max_new_tokens": 1024,
    "vad": {
      "threshold_db": null,
      "min_silence_ms": 400,
      "min_speech_ms": 250,
      "padding_ms": 150,
      "max_gap_ms": 300,
      "frame_ms": 20
    },
    "resume": false,
    "keep_temp_files": false
  }
}
```

Response:

```json
{ "task_id": "task-001", "status": "queued" }
```

### `asr.cancel`

```json
{ "method": "asr.cancel", "params": { "task_id": "task-001" } }
```

Response: `{ "task_id": "task-001", "status": "cancelling" }`.

The worker checks the cancel event between chunks and during FFmpeg/VAD. A
running model call is allowed to finish; the worker then saves the checkpoint
and emits `task.cancelled`.

### `worker.unload_model`

Unloads ASR/aligner weights when no task is running. If a task is running, the
unload is deferred until the task reaches a safe point.

### `worker.get_status`

Returns pid, uptime, device, loaded models, running task, queue length, peak RSS,
and the last error. Contains no transcript text.

### `worker.shutdown`

```json
{
  "method": "worker.shutdown",
  "params": { "wait_for_running_ms": 5000, "cancel_running": false }
}
```

Waits for the current task, optionally cancels it, gives the task a short grace
period to write a checkpoint, then exits. The Node side SIGTERM/SIGKILLs after
its own timeout if the worker does not leave.

## Events

### `task.progress`

```json
{
  "protocol_version": 1,
  "request_id": "req-002",
  "event": "task.progress",
  "task_id": "task-001",
  "status": "running",
  "progress": {
    "stage": "transcribing",
    "processed_ms": 94230,
    "total_ms": 352154,
    "completed_chunks": 4,
    "total_chunks": 15
  }
}
```

`processed_ms` is real work completed in the media timeline, not a timer.
Stages: `preparing`, `decoding`, `segmenting`, `transcribing`, `aligning`.

### `task.completed`

```json
{
  "protocol_version": 1,
  "request_id": "req-002",
  "event": "task.completed",
  "task_id": "task-001",
  "status": "completed",
  "result": {
    "transcript_id": "tr-…",
    "transcript_path": "/data/projects/…/transcripts/tr-….json",
    "duration_ms": 352154,
    "segment_count": 15,
    "language": "zh",
    "model": "qwen3-asr-0.6b",
    "processing_ms": 35344,
    "peak_memory_mb": 3421.2,
    "warnings": []
  }
}
```

The transcript body is never sent over stdout; only its local path.

### `task.failed`

```json
{
  "event": "task.failed",
  "task_id": "task-001",
  "error": {
    "code": "ASR_MODEL_LOAD_FAILED",
    "message": "…",
    "stage": "transcribing",
    "resumable": false
  }
}
```

### `task.cancelled`

```json
{
  "event": "task.cancelled",
  "task_id": "task-001",
  "error": {
    "code": "CANCELLED",
    "message": "Task cancelled; checkpoint retained.",
    "stage": "transcribing",
    "resumable": true
  }
}
```

### `worker.exit`

Emitted by the Node WorkerManager (not by Python stdout) when the child process
exits or fails to spawn. It includes the exited pid in `error.details` so a task
started by a newer worker generation is not incorrectly marked interrupted.

## Checkpoints

`tasks/<task-id>/checkpoint.json` contains:

- task signature (source SHA-256, model, aligner, language, align, chunk size,
  VAD config, pipeline version);
- probe metadata;
- planned chunks;
- completed segments (with internal `_language` for later language aggregation);
- `next_chunk`, `align_next`;
- warnings, threshold, aligner state, ASR device/package info;
- cumulative `processing_ms`.

Resume is accepted only when the signature matches. The worker re-decodes if
the WAV was removed. Completed checkpoints are deleted after the final
transcript is written.

## Error codes (stable prefix)

`WORKER_*`, `PROTOCOL_VERSION_MISMATCH`, `INVALID_JSON`, `METHOD_NOT_FOUND`,
`INVALID_TRANSCRIBE_PARAMS`, `TASK_NOT_FOUND`, `TOO_MANY_TASKS`,
`INPUT_NOT_FOUND`, `FILE_TOO_LARGE`, `SOURCE_HASH_MISMATCH`,
`CHECKPOINT_INVALID`, `CHECKPOINT_MISMATCH`, `FFMPEG_NOT_FOUND`,
`FFPROBE_NOT_FOUND`, `DECODE_FAILED`, `DECODE_TIMEOUT`, `NO_AUDIO_STREAM`,
`DURATION_UNKNOWN`, `MEDIA_TOO_LONG`, `INSUFFICIENT_DISK`,
`ASR_PACKAGE_MISSING`, `ASR_MODEL_LOAD_FAILED`, `ASR_INFERENCE_FAILED`,
`ASR_OUT_OF_MEMORY`, `ALIGNER_MODEL_LOAD_FAILED`,
`ALIGN_LANGUAGE_UNSUPPORTED`, `ALIGNER_PACKAGE_MISSING`, `CANCELLED`,
`TASK_FAILED`, `TASK_CRASHED`.
