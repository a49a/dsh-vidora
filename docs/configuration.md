# Configuration

The Cordis config is validated with a Standard Schema v1 validator. Unknown
keys are ignored; known keys with wrong types/ranges fail plugin load with a
path-qualified error. Paths support `~`.

```yaml
- id: vidora
  config:
    dataDir: ~/Library/Application Support/Vidora
    worker:
      pythonPath: /path/to/python-worker/.venv/bin/python
      workerDir: /path/to/dsh-vidora/python-worker
      autoStart: true
      startTimeoutMs: 30000
      requestTimeoutMs: 30000
      shutdownTimeoutMs: 15000
      idleUnloadSeconds: 900
      logLevel: info
    asr:
      defaultModel: qwen3-asr-0.6b
      modelsDir: ~/Library/Application Support/Vidora/models
      device: auto
      dtype: auto
      language: auto
      align: true
      alignerModel: qwen3-forced-aligner-0.6b
      maxChunkSeconds: 30
      maxNewTokens: 1024
      vad:
        thresholdDb: null
        minSilenceMs: 400
        minSpeechMs: 250
        paddingMs: 150
        maxGapMs: 300
        frameMs: 20
    llm:
      mode: off
      model: ""
      baseUrl: ""
      apiKey: ""
      timeoutMs: 300000
      maxContextChars: 10000
      maxOutputTokens: 4096
      temperature: 0.1
      allowNonLoopback: false
      harnessProvider: ""
      harnessModel: ""
    privacy:
      strictLocal: true
      trustedLocalProviders: []
      trustedLocalModels: []
      untrustedFileToolPolicy: block-data-path
    tasks:
      autoResume: false
      maxTaskHours: 8
      progressPersistIntervalMs: 1500
      keepTempFiles: false
      cancelGraceMs: 15000
    paths:
      mode: explicit
      allowedRoots: []
      allowedExtensions: [.mp3, .wav, .flac, .m4a, .mp4, .mkv, .webm]
      maxFileSizeBytes: 21474836480
      maxDurationMinutes: 480
    document:
      defaultMode: concise
      maxCharsPerWindow: 10000
      maxWindows: 300
      includeFrontMatter: true
    diagnostics:
      workerLogMaxBytes: 5242880
      recentLogLines: 80
```

## Top-level

| Field | Default | Meaning |
|---|---|---|
| `dataDir` | OS user data directory | Projects, tasks, cache, logs, exports. `VIDORA_DATA_DIR` overrides the default, not an explicit value. |

## `worker`

| Field | Default | Meaning |
|---|---|---|
| `pythonPath` | auto: `python-worker/.venv/bin/python`, then `python3` | Python executable. A bare command is resolved through PATH. |
| `workerDir` | package `python-worker/` | Directory containing `main.py`. |
| `autoStart` | `true` | Start the Worker on first task. Must be true for normal tool use. |
| `startTimeoutMs` | `30000` | Spawn/handshake budget (the initialize request gets an additional 90s). |
| `requestTimeoutMs` | `30000` | Generic control-request budget. |
| `shutdownTimeoutMs` | `15000` | Graceful shutdown budget before SIGKILL. |
| `idleUnloadSeconds` | `900` | Unload ASR/aligner weights after this idle period. `0` disables. |
| `logLevel` | `info` | Worker stderr logging level. |

## `asr`

| Field | Default | Meaning |
|---|---|---|
| `defaultModel` | `qwen3-asr-0.6b` | `qwen3-asr-0.6b` or `qwen3-asr-1.7b`. |
| `modelsDir` | `<dataDir>/models` | Local weight directories. Never downloaded implicitly. |
| `device` | `auto` | `auto`, `cpu`, `mps`, `cuda`. Unavailable acceleration falls back to CPU with a reason. |
| `dtype` | `auto` | `auto`, `float16`, `bfloat16`, `float32`. Auto: CUDA bf16/fp16, MPS fp16, CPU fp32. |
| `language` | `auto` | `auto`, `zh`, `en`, `yue`, or a Qwen-supported language name. |
| `align` | `true` | Request independent forced alignment. Missing aligner ⇒ chunk timestamps + warning. |
| `alignerModel` | `qwen3-forced-aligner-0.6b` | Aligner model id. |
| `maxChunkSeconds` | `30` | VAD chunk upper bound (5–120). |
| `maxNewTokens` | `1024` | ASR output cap per chunk. |
| `vad.thresholdDb` | `null` | `null` = adaptive noise-floor threshold; otherwise a fixed dBFS threshold (−90..−5). |
| `vad.minSilenceMs` | `400` | Minimum silence that closes a speech region. |
| `vad.minSpeechMs` | `250` | Drop shorter speech blips. |
| `vad.paddingMs` | `150` | Extend chunks into surrounding silence. |
| `vad.maxGapMs` | `300` | Reserved for gap merging; the current region logic uses `minSilenceMs` as the split threshold. |
| `vad.frameMs` | `20` | Energy frame size (10–50 ms). |

## `llm`

| Field | Default | Meaning |
|---|---|---|
| `mode` | `off` | `off`, `ollama`, `openai`, `harness`. There is no cloud fallback. |
| `model` | `""` | Ollama model name or OpenAI-compatible model id. Required for those modes. |
| `baseUrl` | `http://127.0.0.1:11434` (Ollama) / `http://127.0.0.1:8080/v1` (OpenAI) | Local endpoint. OpenAI mode appends `/v1` if missing. |
| `apiKey` | `""` | Optional bearer token for a local endpoint; never logged. |
| `timeoutMs` | `300000` | Per LLM request timeout. |
| `maxContextChars` | `10000` | Transcript window character budget. |
| `maxOutputTokens` | `4096` | LLM output cap. |
| `temperature` | `0.1` | Deterministic-ish extraction. |
| `allowNonLoopback` | `false` | Explicitly allow a LAN/remote LLM endpoint. Document is marked `llm.local=false`. |
| `harnessProvider` | `""` | Provider route for `mode: harness`. |
| `harnessModel` | `""` | Model id for `mode: harness`. |

For `mode: harness`, config validation requires `harnessProvider` to be present
in `privacy.trustedLocalProviders`, and `harnessModel` to be in
`trustedLocalModels` when that list is non-empty.

## `privacy`

| Field | Default | Meaning |
|---|---|---|
| `strictLocal` | `true` | Hide content-reading tools from untrusted session models and refuse direct content reads. |
| `trustedLocalProviders` | `[]` | Explicit provider ids confirmed to run locally. |
| `trustedLocalModels` | `[]` | Optional model-id allowlist within those providers. Empty = any model on a trusted provider. |
| `untrustedFileToolPolicy` | `block-data-path` | Guard non-Vidora file/shell tools in untrusted sessions: `block-data-path`, `block-all`, or `off`. |

## `tasks`

| Field | Default | Meaning |
|---|---|---|
| `autoResume` | `false` | On plugin startup, resume interrupted tasks automatically. For large jobs, manual `resumeTaskId` is safer. |
| `maxTaskHours` | `8` | Cancel a task after this many hours. |
| `progressPersistIntervalMs` | `1500` | Throttle task.json progress writes. |
| `keepTempFiles` | `false` | Keep the decoded WAV/work directory after completion. Failure/cancel always keeps them for recovery. |
| `cancelGraceMs` | `15000` | How long `vidora_cancel_task` waits for the worker's terminal event. |

## `paths`

| Field | Default | Meaning |
|---|---|---|
| `mode` | `explicit` | `explicit` treats a tool-provided path as authorization; `roots` enforces an allowlist. |
| `allowedRoots` | `[]` | Required in `roots` mode. Real paths must be inside one of these. |
| `allowedExtensions` | media list | Extension allowlist (with leading dot). |
| `maxFileSizeBytes` | 20 GiB | Reject larger files before hashing/decoding. |
| `maxDurationMinutes` | `480` | Reject longer media after probe. |

## `document`

| Field | Default | Meaning |
|---|---|---|
| `defaultMode` | `concise` | Used when the tool omits `mode`. |
| `maxCharsPerWindow` | `10000` | Extraction window size. |
| `maxWindows` | `300` | Hard cap on windows. |
| `includeFrontMatter` | `true` | Include YAML front matter in exported Markdown. |

## `diagnostics`

| Field | Default | Meaning |
|---|---|---|
| `workerLogMaxBytes` | 5 MiB | Rotate `logs/worker.log` at this size. |
| `recentLogLines` | `80` | Ring buffer included in Worker errors for troubleshooting. |

## Environment variables

| Variable | Purpose |
|---|---|
| `VIDORA_DATA_DIR` | Override the default data directory. |
| `VIDORA_PYTHON` | Override the default Python executable. |
| `VIDORA_HF_ENDPOINT` / `HF_ENDPOINT` | Download endpoint used by `prepare-models`. |
| `HF_HUB_DISABLE_XET=1` | Use plain HTTP downloads instead of Xet CAS. |
| `VIDORA_DEBUG_LLM=1` | Print raw local-LLM output to stderr for debugging. Never enable in a shared environment; it can contain transcript-derived text. |
