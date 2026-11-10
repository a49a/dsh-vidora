# Test Report

Date: 2026-11-10  
Machine: MacBook Pro, Apple M1 Pro, 32 GB RAM, macOS  
Device: Apple Metal (MPS), float16  
DSH: 0.2.2-rc.1  
Python: 3.10.9  
PyTorch: 2.14.1  
Transformers: 4.57.6  
qwen-asr: 0.0.6  
FFmpeg: 9.0.1  
ASR: Qwen3-ASR-0.6B  
Aligner: Qwen3-ForcedAligner-0.6B  
Local document LLM: Qwen2.5-3B-Instruct Q4_K_M via llama.cpp `llama-server` (Metal); 1.5B was also tried.

Artifacts are in `testdata/reports/`. The test audio is produced by
macOS `say` (voice Tingting, zh_CN, 180 wpm). It is **real speech inference**,
but it is synthetic TTS, not a human classroom recording. CER below is measured
against the exact input script and should not be presented as real-world
accuracy.

## Node and Python test suite

```
npm test
  37 tests, 37 passed

python3 -m unittest discover -s python-worker/tests -v
  11 tests, 11 passed
```

The Node suite covers config validation, privacy policy and file-tool guard,
SRT/Markdown rendering, atomic storage, path security, loopback-only local LLM
adapters, structured note extraction/citation validation, Cordis tool
registration, WorkerManager JSONL handshake, TaskManager completion/cache/
dedupe, and a simulated Worker crash + resume. The simulated crash uses a
protocol fixture (`test/fake-worker`), not Qwen ASR; it is labeled as a unit
test. Real ASR results are below.

## Real ASR results

| Fixture | Duration | Segments | Aligned | Processing | RTF | Peak RSS |
|---|---:|---:|---:|---:|---:|---:|
| `lecture-5m-zh.m4a` | 352.2 s | 15 | 15 | 35.3 s | 0.100 | 3421 MB |
| `lecture-10m-mixed.m4a` | 632.2 s | 31 | 31 | 60.8 s | 0.096 | 3486 MB |
| `lecture-60m-zh.m4a` | 3799.3 s | 157 | 157 | 349.2 s | 0.092 | 3297 MB |

All three tasks completed with `timing_status: "aligned"` for every segment and
no warnings. The 60-minute run completed in 5m49s wall clock. Audio is decoded
in a temp WAV; VAD and ASR never load the full hour into the model.

Evidence:

- `testdata/reports/asr-5m-zh.json`
- `testdata/reports/asr-10m-mixed.json`
- `testdata/reports/asr-60m-zh.json`

### CER

CER is character-level Levenshtein distance after removing punctuation, section
numbers and whitespace. The reference is the exact TTS input script.

| Fixture | Reference chars | Edit distance | CER |
|---|---:|---:|---:|
| 5m Chinese | 1432 | 19 | 1.33% |
| 10m Chinese/English mixed | 4791 | 250 | 5.22% |

The mixed fixture is harder because English technical terms and Chinese/English
code switching are produced by a Chinese TTS voice. Observed errors included
`TLB → RTLB`, `页表 → 列表`, and spacing around English words. These are model
limitations, not measured as a general claim.

Evidence:

- `testdata/reports/cer-5m-zh.json`
- `testdata/reports/cer-10m-mixed.json`

### Timestamp checks

- Every 5/10/60-minute transcript segment has `timing_status: "aligned"` and a
  non-empty `words` array from Qwen3-ForcedAligner.
- Segment times are monotonically increasing and non-overlapping (enforced by
  `parseTranscript` on load).
- The aligner is a separate phase; if it is removed, the pipeline retains chunk
  timestamps and marks them `chunk`.
- Boundary-duplicate text was observed at a VAD split (`并。` + `并把它`). The
  finalizer now trims the duplicated prefix/suffix using aligned word overlap;
  the quick regression fixture no longer contains the duplicate.

## Cancellation and resume

`vidora_cancel_task` + checkpoint resume were exercised on the 5-minute fixture:

1. Task reaches `transcribing`, 2 chunks completed.
2. Cancel returns `cancelled`; the Worker keeps `checkpoint.json` and the WAV.
3. `resumeTaskId` is submitted in the same Worker run.
4. Worker resumes at the checkpoint (`next_chunk` 4 in this run, because the
   current chunk finished before cancellation took effect).
5. Task completes all 15 chunks and alignment; transcript is written.

Resumed run: processing 43.1 s, RTF 0.123, peak 3454 MB.
Evidence: `testdata/reports/cancel-resume-5m.json`,
`testdata/reports/worker-crash-resume.json`.

A real Worker crash/resume test was also run: the process was SIGKILLed after
2 completed chunks, TaskManager marked the task `interrupted`/`resumable`, and
`resumeTask` started a new Worker and resumed from the checkpoint. The task
completed all 15 chunks + alignment in 50.2 s (RTF 0.142, peak 2824 MB). A
protocol-fixture crash/resume test is additionally covered by
`test/task-manager.test.mjs`.

## Cache and duplicate submission

- Repeating the same 5m/60m request returned `cached=true` with the same
  transcript id; no new ASR run.
- An identical request while a task is active returns the existing task id
  (`deduplicated=true`).
- The cache key includes source SHA-256, model, language, alignment, VAD/chunk
  parameters and pipeline version.
- The completed status is published only after the cache index is written, so
  an immediate repeat request cannot race the index.

## Offline operation

The quick fixture was transcribed with:

```
HTTP_PROXY=http://127.0.0.1:9
HTTPS_PROXY=http://127.0.0.1:9
ALL_PROXY=http://127.0.0.1:9
NO_PROXY=127.0.0.1,localhost
HF_HUB_OFFLINE=1
TRANSFORMERS_OFFLINE=1
```

The Worker loaded local weights and completed ASR + alignment. This demonstrates
that inference does not depend on the network. The model download scripts are a
separate, explicit user action.

Evidence: `testdata/reports/offline-asr.json`.

## Local LLM document generation

### 3B model

With `qwen2.5-3b-instruct` on a loopback llama.cpp server:

- `concise`: 3 sections, 22 portable transcript citations, 35.1 s, no invalid
  citations. Duplicate sections caused by the repetitive fixture were merged
  deterministically into one section.
- `review`: 3 sections, self-test questions and a checklist were present, 37.2 s.
- `detailed`: 3 sections, 22 citations, 26.9 s.
- Repeating the generation hit the document cache (`cached=true`), same document
  id, no LLM call.

The 5-minute fixture intentionally repeats the same paragraph with different
section numbers. This is a stress test for duplicate merging, not a realistic
lecture. A 3B model produced usable review questions and key terms; a 1.5B model
produced weaker, repetitive notes and was rejected as the recommended default.

Evidence: `testdata/reports/notes-3b.json`.

### DSH Harness local provider (`llm.mode=harness`)

The same notes flow was run through DSH's `ctx.llm` service with
`provider: vidora-local`, `model: qwen2.5-3b-instruct`, and the provider listed
in `privacy.trustedLocalProviders`. It generated a 4-section document with 31
distinct cited segments (107 citation occurrences) and returned metadata only
because the conversation model was untrusted. This verifies the Harness local
adapter, not only the direct llama.cpp HTTP adapter.

### Model quality caveat

The local document engine is deterministic and validates citations, but it
cannot make a small model understand a course. Production quality depends on the
user's local model. Recommended starting points: Qwen2.5-7B-Instruct or larger,
or a domain-tuned model. No cloud fallback exists.

## DSH end-to-end

Profile: `vidora-test`, headless DSH 0.2.2-rc.1.  
Main conversation model: `deepseek-account/deepseek-flash` (remote).  
Vidora local notes model: `qwen2.5-3b-instruct` via llama.cpp at
`http://127.0.0.1:8091/v1`.

### Acceptance flow

Prompt: transcribe a 10m32s local mixed-language lecture and generate a concise
Markdown document.

Observed tool sequence:

1. `vidora_transcribe` with `align=true`; the tool waited for the real local
   task (`wait=true` default).
2. Tool returned: `Transcript ID: tr-1ce48c6b7245f7ff25d5`, 31 segments,
   language `zh`, local transcript path.
3. `vidora_generate_notes` with the real ID, `mode=concise`; the local 3B model
   generated `doc-4c08e00e71f4410d2ae8`, 2 sections, 31 distinct cited
   segments, 91 citation occurrences.
4. The remote model received no document title or body; it received the local
   file path and counts.

Evidence: `testdata/reports/dsh-e2e.json` (`acceptance_flow`).

The first remote-session run on the same fixture was a **fresh real ASR run**:
630,232 ms audio, 31 segments, 71.5 s processing, then a local 3B notes document.
The second acceptance run hit the local cache. The first run also revealed that
a remote model could use `bash` to inspect transcript JSON; the runtime file-tool
guard was added and then tested with a denied `bash` read. Evidence includes
`fresh_asr_run` in `testdata/reports/dsh-e2e.json`.

### Privacy checks

1. `vidora_list_models(probe=true)` reported:
   `严格本地：开启；当前会话 deepseek-account/deepseek-flash 不信任（正文工具隐藏）`.
2. `vidora_get_transcript` was absent from the remote model's tool catalog. The
   model listed only six Vidora tools: transcribe, task_status, cancel_task,
   list_models, generate_notes, export. It could not call the content tool.
3. The remote model tried to read `transcript.json` through `bash`. The runtime
   tool guard denied it:
   `Vidora strict-local mode: this untrusted session may not read or write Vidora transcript/document paths.`
4. A separate run with `privacy.trustedLocalProviders: []` showed
   `session_trusted=false`; `vidora_generate_notes` returned metadata only, with
   no title and sanitized warnings.
5. With the main DSH model switched to the trusted local `vidora-local`
   provider, `vidora_get_transcript` and `vidora_get_document` appeared and
   returned the requested segment / bounded Markdown excerpt. This confirms the
   condition is selective, not permanently disabled.

Evidence: `testdata/reports/dsh-e2e.json` (`privacy_guard`,
`hidden_content_tools`).

The guard is string-based defense in depth, not an OS sandbox. See
[security.md](security.md) for the residual risk and the stricter
`block-all` policy.

## Packaged install

The same flow was tested from a packed tarball, not only a source link:

```
npm pack
dsh plugin --profile vidora-pack-test add ./dsh-plugin-vidora-0.1.0.tgz
```

The packaged `dist/` and `python-worker/` loaded from the profile's
`node_modules`; a real quick-fixture ASR run completed with 2 segments and
alignment. The tarball contains the Worker scripts but no `.venv`, model
weights, or test audio. Evidence: `testdata/reports/packaged-install.json`.

## Not tested on this machine

- Linux x86_64, Windows x86_64, Intel Mac.
- CUDA, ROCm, DirectML.
- Qwen3-ASR-1.7B (paths/config exist; weights not downloaded).
- A human-recorded classroom video (the fixtures are TTS).
- Speaker diarization (not implemented).
- Very noisy real-world background music; the VAD has a conservative fallback,
  but only synthetic speech + silence was measured here.
- Real DSH desktop GUI interaction; the headless profile was used.
- 3-hour single file (60-minute file tested; the architecture is streaming and
  uses the same code path).
- Long-term stability across dozens of concurrent/queued tasks.
