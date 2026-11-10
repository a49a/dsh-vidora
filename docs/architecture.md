# Architecture

Vidora is intentionally three layers. The Harness plugin is an adapter, not the
business core.

```
Layer 1  DSH / Cordis plugin (TypeScript)
         tools, config, storage, task lifecycle, privacy, local LLM adapter
              |
              | JSON Lines over stdin/stdout
              v
Layer 2  Python AI Worker (separate OS process)
         FFmpeg, VAD, Qwen3-ASR, Qwen3-ForcedAligner, checkpoints
              |
              v
Layer 3  Local document engine (TypeScript)
         windowing, validated structured extraction, merge, deterministic Markdown
```

## Layer 1: DSH plugin

Entry point: `src/index.ts`

- Exports `name = "vidora"`, `inject = ["tools"]`, `Config`, `apply(ctx, config)`.
- The plugin exports a Standard Schema v1 config validator. It does not require
  `@deepseek-ai/schemastery` at runtime.
- Tool objects are registered through `ctx.tools.register()`. The definitions use
  the documented raw JSON Schema parameter shape and declare an output schema
  plus a pure renderer. This keeps the plugin loadable from an external profile
  without importing a second copy of Cordis or dsh-tools.
- `src/tools/index.ts` attaches a Cordis `when` condition to content-reading
  tools. The condition sees the exact step `modelSelection`; untrusted remote
  models never receive those tools.
- `ctx.inject(["llm"], ...)` is optional and only used by `llm.mode: "harness"`.
  It is not a fallback path.
- `ctx.effect()` owns tool registration, runtime initialization, Worker
  shutdown, and tool disposal.

Key modules:

| Module | Responsibility |
|---|---|
| `src/services/runtime.ts` | Composition root for store, worker, tasks, privacy, LLM |
| `src/services/worker-manager.ts` | spawn, JSONL IPC, request/response, stderr log, exit handling |
| `src/services/task-manager.ts` | task persistence, progress, cache/dedupe, cancel/resume |
| `src/storage/data-store.ts` | OS user-data layout, atomic JSON, project/export indexes |
| `src/services/privacy.ts` | strict-local selection policy |
| `src/services/local-llm.ts` | loopback-only Ollama/OpenAI-compatible/Harness adapters |
| `src/services/notes-engine.ts` | windowing, structured extraction, citation validation, merge |
| `src/services/document-service.ts` | document versions, Markdown rendering, export |

## Layer 2: Python Worker

Entry: `python-worker/main.py`

- Runs as a separate OS process. The Node process never runs PyTorch/ASR.
- stdout is protocol-only; stdout is redirected so accidental `print()` cannot
  corrupt IPC. Diagnostics go to stderr and `logs/worker.log`.
- The main thread handles `worker.initialize`, `worker.get_status`,
  `asr.cancel`, `worker.unload_model`, and `worker.shutdown`.
- A single task thread consumes `asr.transcribe` jobs. Model inference is
  serialized; one Worker can process a queue of tasks.
- The Worker keeps the model loaded between tasks and unloads it after the
  configured idle period.
- `asyncio`/HTTP servers are deliberately not used. There is no listening port.

Pipeline inside a task:

1. `preparing`: probe with ffprobe, duration/size limits, SHA-256 verification.
2. `decoding`: FFmpeg extracts mono 16kHz PCM WAV with `-progress pipe:1`.
3. `segmenting`: streaming energy VAD, adaptive threshold, silence-aware chunks.
4. `transcribing`: extract one chunk at a time, Qwen3-ASR inference, checkpoint.
5. `aligning`: independent Qwen3-ForcedAligner pass, word/character timestamps.
6. `completed`: normalize segments, build Transcript JSON, atomically write it.

Important details:

- The full long media is never loaded into the model. VAD reads the WAV in
  1-second blocks; only one short chunk is materialized for inference.
- Chunks are non-overlapping and capped by `asr.maxChunkSeconds` (default 30s).
  Long speech regions are split at the lowest-energy frame in the last 40% of
  the target window, not at a fixed clock offset.
- VAD fallback: if no speech is detected, fixed chunks cover the whole file
  rather than dropping audio. A warning is recorded.
- Forced alignment is a separate phase. If the aligner is missing or fails for
  a chunk, the segment keeps `timing_status: "chunk"`; the pipeline never
  invents precise times.
- ASR/alignment text is never logged. Checkpoints and transcripts are local
  files; protocol events carry metadata only.

## Layer 3: Local document engine

`src/services/notes-engine.ts`:

1. Split the transcript into character-budget windows.
2. For each window, call the configured local LLM with a strict JSON request.
3. Validate every returned segment id against the window. Unknown ids are
   dropped and counted.
4. Merge sections by normalized title and exact normalized content (this
   collapses repetitive sections), merge key terms, dedupe bullets.
5. Build `DocumentBlock`s. A block without valid citations is marked
   `uncertain: true`.
6. Render Markdown deterministically: the program, not the model, produces
   timestamps and relative source links.

The model never sees a full three-hour transcript in one context. The default
window is 10,000 characters, and a hard window limit prevents runaway input.

## Why no HTTP ASR server?

The user requirement is a local plugin, not a service deployment. `spawn()` +
JSON Lines gives:

- no open port and no network attack surface;
- no CORS/auth problem;
- simple process cleanup;
- easy embedding in the future GPUI app;
- stdout/stderr separation that keeps progress and diagnostics distinct.

The trade-off is that the protocol must be versioned and tested; see
[protocol.md](protocol.md).
