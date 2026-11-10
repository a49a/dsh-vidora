# Security and Privacy

## Threat model

Vidora handles private lectures, meetings, and course recordings. The main
risks are:

1. Media/transcript/notes leaving the machine through a cloud model.
2. A malicious transcript or document prompt-injecting the note generator.
3. Path traversal or shell injection through tool arguments.
4. Silent model/dependency downloads from untrusted sources.
5. Sensitive text leaking into ordinary logs.
6. A crashed or unloaded plugin leaving a Worker process or partial files.

## Strict local mode

`privacy.strictLocal` defaults to `true`.

- `vidora_get_transcript` and `vidora_get_document` are registered with a
  Cordis `when` condition:
  ```ts
  when: ({ modelSelection }) => privacy.isTrusted(modelSelection)
  ```
  When the current step's provider/model is not explicitly trusted, the tool is
  absent from the model's visible tools and cannot be dispatched. This is a
  runtime access restriction, not a prompt instruction.
- The tool body calls `PrivacyPolicy.assertContentReadAllowed(exec.agent)` as a
  second check against the current session selection.
- `ctx.tools.guard()` installs a monotonic runtime guard for non-Vidora tools.
  Under an untrusted session, `bash`, `read`, `grep`, `edit`, and similar tools
  are denied when their arguments mention the Vidora data directory or known
  data filenames (`transcript.json`, `document.json`, `notes.md`, project/task
  paths) or source media paths recorded by Vidora tasks. The `privacy.untrustedFileToolPolicy` setting can be:
  - `block-data-path` (default): deny file/shell calls that reference Vidora
    data paths.
  - `block-all`: deny all known file/shell tools for untrusted sessions.
  - `off`: disable this guard (not recommended).
  This is defense in depth, not an OS filesystem sandbox. See residual risks.
- `vidora_generate_notes` never uses the conversation model. It uses the
  explicitly configured local LLM adapter. Under an untrusted session, its
  result omits the document title, section names, and detailed warnings.
- `vidora_export` returns only a path and byte count, so it is safe to use from
  a remote session. The user opens the file locally.
- No code path falls back from a local LLM to a cloud LLM. `llm.mode: "off"`
  reports that notes are unavailable; ASR and export remain usable.

### Trust is explicit

`trustedLocalProviders` is empty by default. A provider name alone is not proof
that the endpoint is local; the user must confirm it. `trustedLocalModels` can
narrow the trust to specific model ids. If the user wants the DSH agent to read
transcript text, they must switch the DSH session to a locally hosted provider
and add that provider id to the list.

### Local LLM endpoint checks

For `ollama` and `openai` modes:

- URL scheme must be `http` or `https`.
- The host is resolved with `dns.lookup({all: true})`.
- Every resolved address must be loopback (`127.0.0.0/8`, `::1`, IPv4-mapped
  loopback). `localhost` is treated as loopback.
- Redirects are rejected (`redirect: "error"`).
- Non-loopback endpoints require `llm.allowNonLoopback: true`; the document is
  then marked `llm.local: false`.
- API keys are never logged. HTTP error bodies are truncated and redacted.

`llm.mode: "harness"` cannot inspect the provider's internal base URL. It
requires the provider to be in `trustedLocalProviders` **and** the model to be in
`trustedLocalModels` when that list is non-empty. This is a user assertion, not
a network proof; use Ollama/OpenAI mode when a hard endpoint check is required.

## Path security

- `resolveMediaFile()` expands `~`, resolves relative paths from the current
  working directory, and calls `realpath()` to resolve symlinks.
- It requires a regular file and a supported media extension.
- `paths.mode: "explicit"` treats the user-provided media path as authorization
  but still blocks system directories (`/etc`, `/System`, `/bin`, `/proc`,
  `/dev`, Windows system directories).
- `paths.mode: "roots"` additionally requires the real path to be inside
  `paths.allowedRoots`.
- Output paths are checked the same way; export to system directories is
  refused.
- Project, task, transcript, and document IDs are validated against
  `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$` before being joined into a path.

## Process execution

- FFmpeg and ffprobe are executed with an argv array and `spawn`/`subprocess`
  (never a shell string).
- `-nostdin` prevents FFmpeg from consuming the Worker's protocol input.
- The Worker verifies the source SHA-256 before processing and checks the
  transcript output path is inside the Vidora data directory.
- Media size and duration limits are enforced before decoding.
- Disk space is checked before creating the 16kHz WAV.
- Python model inference never runs in the Harness main process.
- The Worker has no listening socket.

## Prompt injection and output validation

- ASR text is untrusted data. The extraction system prompt says so explicitly
  and delimiters wrap the transcript window.
- The LLM must return structured JSON; the program validates it.
- Segment IDs are checked against the window's real IDs. Invented IDs are
  dropped and counted in `invalid_citations`.
- The LLM never generates timestamps. The renderer derives them from the
  transcript.
- Markdown content is sanitized for active HTML (`<script>`, `<iframe>`, etc.)
  and `javascript:` links. Code blocks are preserved.
- A block without reliable citations is marked `uncertain` and rendered with a
  visible warning.

## Logging

- The Worker logs stage/task id/error codes to stderr and `logs/worker.log`.
- It does not log transcript text, prompts, or model completions.
- LLM prompt/response debugging is opt-in via `VIDORA_DEBUG_LLM=1` and is not
  intended for production.
- Error messages returned to a remote agent are sanitized: under an untrusted
  session, note-generation failures return a generic code/message rather than
  model output that might echo transcript text.

## Model and dependency downloads

- The Worker runs with `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, and
  `local_files_only=True`.
- `scripts/prepare-models.mjs` is the only download path. It prints the source,
  approximate size, target directory, and license, and requires confirmation
  (`--yes` for non-interactive use).
- The default source is `https://huggingface.co`; `--endpoint` can select an
  explicit mirror. No model is downloaded implicitly during transcription.
- `scripts/install-worker.mjs` creates a project-local venv. It does not modify
  the global Python environment.

## Residual risks

- DSH itself may persist tool results into its session log. Under strict local
  mode, content-bearing tools are hidden from remote models, so transcript
  text should not enter that session. Metadata such as file paths and task ids
  may still be persisted.
- A user can mark a remote provider as trusted; that is an explicit override.
- The file-tool guard is string-based. A determined remote agent could try
  obfuscated paths, symlinks, a custom MCP tool, or a subagent with file access.
  For maximum isolation, set `privacy.untrustedFileToolPolicy: "block-all"` and
  use a permission preset that does not grant shell/filesystem tools to the
  remote session. The fundamental boundary is the OS user account: Vidora
  cannot hide files from another process running as the same user.
- A malicious local model server can return arbitrary Markdown. The renderer
  sanitizes active HTML but not every social-engineering payload.
- Local files and the Vidora data directory rely on OS user permissions; Vidora
  does not encrypt data at rest (yet).
