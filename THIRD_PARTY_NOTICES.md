# Third-party notices

Vidora's own code is MIT-licensed. It does not ship or relicense third-party
weights, Python packages, FFmpeg, or LLMs. The user installs those separately.
This list records the upstream projects and licenses at the time of
development; always confirm the exact license of the version you install.

## Models (downloaded separately, not included)

| Component | Upstream | License |
|---|---|---|
| Qwen3-ASR-0.6B | https://huggingface.co/Qwen/Qwen3-ASR-0.6B | Apache-2.0 |
| Qwen3-ASR-1.7B | https://huggingface.co/Qwen/Qwen3-ASR-1.7B | Apache-2.0 |
| Qwen3-ForcedAligner-0.6B | https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B | Apache-2.0 |
| Qwen2.5-1.5B-Instruct (test only) | https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct | Apache-2.0 |
| Qwen2.5-3B-Instruct (test only) | https://huggingface.co/Qwen/Qwen2.5-3B-Instruct | Apache-2.0 |

The Qwen3-ASR model card and repository are the source of truth for license
and usage terms. Model weights are downloaded only after explicit confirmation
by `scripts/prepare-models.mjs`.

## Python Worker packages

| Package | License | Notes |
|---|---|---|
| `qwen-asr` | Apache-2.0 | Official Qwen ASR inference package; installed with `--no-deps` to avoid its Gradio demo stack. |
| `torch` | BSD-3-Clause | PyTorch. The MPS backend is part of PyTorch. |
| `transformers` | Apache-2.0 | Hugging Face Transformers. |
| `accelerate` | Apache-2.0 | Device placement/runtime helpers. |
| `huggingface_hub` | Apache-2.0 | Model download client (download script only). |
| `numpy` | BSD-3-Clause | Numerical arrays. |
| `librosa` | ISC | Audio loading/resampling helpers used by `qwen-asr`. |
| `soundfile` | BSD-3-Clause | libsndfile bindings. |
| `nagisa` | MIT | Japanese tokenization for the forced aligner. |
| `soynlp` | Apache-2.0 | Korean tokenization for the forced aligner. |
| `scipy`, `scikit-learn`, `numba`, `llvmlite` | BSD-family | Transitive dependencies of `librosa`/`soynlp`. |
| `DyNet38` | Apache-2.0 | Transitive dependency of `nagisa`. |

Run `python-worker/.venv/bin/python -m pip list` and inspect each package's
`METADATA` for the exact installed license text.

## System tools (not bundled)

| Tool | License | Notes |
|---|---|---|
| FFmpeg / ffprobe | LGPL-2.1-or-later or GPL-2.0-or-later depending on build | Vidora executes the user's FFmpeg as a separate process with argv arrays. Homebrew and many distributions build with GPL components; check `ffmpeg -L`. |
| Python | PSF-2.0 | The user's Python runtime. |

## Test-only tooling

| Tool | License | Notes |
|---|---|---|
| llama.cpp / `llama-server` | MIT | Used to run an OpenAI-compatible local LLM in the real notes test. Not a runtime dependency. |
| macOS `say` | Apple system tool | Used only to synthesize repeatable speech fixtures. Not distributed with Vidora. |

## DeepSeek Harness

The plugin targets the public DSH/Cordis plugin APIs. DSH packages are not
bundled. The plugin does not modify Harness core files. See the DSH repository
for its MIT license and dependency notices.

## No commercial keys

Vidora contains no Manas, DeepSeek account, DashScope, OpenAI, or other
commercial API keys. It does not call a cloud ASR endpoint. A user may configure
a remote LLM endpoint only via the explicit `llm.allowNonLoopback` override;
that is outside the default local-first mode.
