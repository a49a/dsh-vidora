# Vidora（DSH 插件）

**本地优先的音视频知识文档化工具。** 给 Vidora 一个本地 MP4/MKV/MP3/WAV，它会在本机完成 FFmpeg 解码、VAD 分段、Qwen3-ASR 转写、Qwen3-ForcedAligner 时间戳对齐，并可用本地 LLM 生成可追溯来源的 Markdown 讲义。

DeepSeek Harness（DSH）是 Vidora 的交互入口，不是业务核心。Vidora Core 的 Transcript / Document JSON 不依赖 Harness 私有接口，可供未来的 Chrome 扩展和 GPUI 桌面端复用。

```
本地音视频
  → FFmpeg 解码 / 16kHz 单声道
  → VAD + 静音感知分段（不把完整长音频放进模型内存）
  → Qwen3-ASR-0.6B（可切换 1.7B）
  → Qwen3-ForcedAligner-0.6B（独立对齐阶段）
  → transcript.json（毫秒时间戳 / 稳定 segment id）
  → 本地 LLM 分窗口提取 → 全局合并 → 确定性 Markdown 渲染
  → notes.md + document.json + exports/
```

## 文档索引

- [架构](docs/architecture.md)
- [Worker IPC 协议](docs/protocol.md)
- [Transcript / Document 数据契约](docs/data-format.md)
- [配置参考](docs/configuration.md)
- [安全与隐私](docs/security.md)
- [真实测试报告](docs/test-report.md)

## 当前状态

- Phase 1–5 的最小可运行链路已经实现。
- 已在 macOS Apple Silicon（M1 Pro，32GB，MPS）上完成真实推理测试：
  - 5 分钟中文教学音频：15 段，对齐 15 段，RTF 0.100，峰值内存约 3.4GB。
  - 10 分钟中英混合音频：31 段，RTF 0.096，峰值内存约 3.5GB。
  - 60 分钟中文长音频：157 段，RTF 0.092，峰值内存约 3.3GB。
  - 取消、检查点恢复、缓存命中、本地 LLM 讲义生成均已实际执行。
- 测试音频由 macOS `say`（Tingting）合成；这是真实语音推理，但不是人类课堂录音。CER 是按已知脚本计算的，不代表真实课堂准确率。详见 [docs/test-report.md](docs/test-report.md)。
- Linux / Windows 与 Intel Mac 尚未在本机验证；代码包含 CPU fallback 和跨平台路径处理，但请将它们视为兼容目标而不是已验证结果。

## 能力

| 工具 | 功能 |
|---|---|
| `vidora_transcribe` | 创建本地转写任务；默认等待完成（`wait=true`），也可 `wait=false` 异步轮询 |
| `vidora_task_status` | 查询阶段、真实已处理音频时长、总时长、片段数、错误 |
| `vidora_cancel_task` | 取消任务；检查点保留，可恢复 |
| `vidora_get_transcript` | 分页读取转写正文（仅受信任的本地会话） |
| `vidora_generate_notes` | 用本地 LLM 生成精简/详细/可读转写/复习提纲 |
| `vidora_get_document` | 读取讲义正文（仅受信任的本地会话） |
| `vidora_export` | 导出 Markdown / JSON / TXT / SRT（不返回正文） |
| `vidora_list_models` | 查询模型、设备、FFmpeg、Worker、本地 LLM 和隐私状态 |

支持 MP3、WAV、FLAC、M4A、MP4、MKV、WebM、OGG、Opus、AAC、MOV、AVI、M4B。

## 快速安装（macOS Apple Silicon）

前提：Node.js >= 22、Python >= 3.9、FFmpeg/ffprobe、DSH >= 0.2.2-rc.1 <0.3.0。已在 DSH 0.2.2-rc.1 上实测。

```bash
git clone <this-repo> dsh-vidora
cd dsh-vidora

# 1. 构建 TypeScript 插件
npm install
npm run build

# 2. 安装独立 Python Worker 虚拟环境（不会修改全局 Python）
node scripts/install-worker.mjs --yes

# 3. 显式确认后下载模型权重（默认写入 OS 用户数据目录）
node scripts/prepare-models.mjs --model qwen3-asr-0.6b --yes
node scripts/prepare-models.mjs --model qwen3-forced-aligner-0.6b --yes
```

模型来源、大小和目标目录会在下载前显示；`prepare-models` 也支持 `--endpoint https://hf-mirror.com`、`--dest` 和 `--data-dir`。Worker 自身始终以 `HF_HUB_OFFLINE=1`、`local_files_only=True` 运行，不会在推理时下载权重。

安装到 DSH profile：

```bash
dsh plugin --profile desktop add link:/absolute/path/to/dsh-vidora
```

然后编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，为 `vidora` 行添加配置：

```yaml
- id: vidora
  config:
    dataDir: /Users/you/Library/Application Support/Vidora
    worker:
      pythonPath: /absolute/path/to/dsh-vidora/python-worker/.venv/bin/python
    asr:
      modelsDir: /Users/you/Library/Application Support/Vidora/models
      device: auto
      align: true
    llm:
      mode: openai            # off | ollama | openai | harness
      baseUrl: http://127.0.0.1:8090/v1
      model: qwen2.5-3b-instruct
    privacy:
      strictLocal: true
      trustedLocalProviders: []   # 仅在确认 Harness 主模型是本地模型后填写
```

重启 DSH（或让 profile HMR 重新加载）。在对话中输入：

> 请把 `/Users/you/Videos/os-lecture.mp4` 转换成文字，并整理成一份精简的 Markdown 教学讲义。

也可以只转写：

> 只转文字，不需要总结。

或者复用已有转写生成详细讲义：

> 使用刚才的 Transcript 重新生成一份详细讲义。

## 本地 LLM

Vidora 不自动回退到云端模型。

- `llm.mode: "ollama"`：调用 `http://127.0.0.1:11434` 的 Ollama。
- `llm.mode: "openai"`：调用显式配置的 OpenAI 兼容本地端点（llama.cpp、LM Studio、vLLM 等）。
- `llm.mode: "harness"`：复用 DSH 当前注册的本地 provider。必须同时把 provider 写入 `privacy.trustedLocalProviders`，否则拒绝发送正文。
- `llm.mode: "off"`：ASR、缓存、导出仍然可用；AI 讲义不可用，并会给出明确提示。

端点默认必须是回环地址。DNS 名称会解析并检查所有地址；重定向被禁止。只有显式设置 `llm.allowNonLoopback=true` 才允许局域网/远程端点，并会在文档中标记 `llm.local=false`。

## 严格本地模式（重要）

DSH 主模型可能是云端模型。**ASR 本地不等于整个工作流本地。** 如果工具把转写正文返回给云端模型，正文就会离开本机。

Vidora 的运行时保护：

1. `privacy.strictLocal` 默认开启。
2. `vidora_get_transcript` 和 `vidora_get_document` 通过 Cordis 的 `when` 条件注册：当前 step 的 `modelSelection.provider` 不在 `privacy.trustedLocalProviders` 中时，工具根本不会出现在模型可见工具列表中。
3. 工具内部再次检查 `exec.agent.model.current()`，作为第二道运行时检查。
4. 通过 `ctx.tools.guard()` 拦截其他文件/Shell 工具对 Vidora 数据目录、转写/讲义文件以及已登记源媒体路径的访问。默认策略 `block-data-path`；可选 `block-all`（不可信会话禁用所有文件工具）或 `off`。这不是文件系统沙箱，但能阻止最常见的 `bash/read/grep` 绕过。
5. `vidora_generate_notes` 使用独立的本地 LLM 端点；即使当前会话是云端模型，正文也只发送给本地 LLM 端点。返回给会话的只有文档 id、路径、计数；标题、章节名和警告在不可信会话中会被隐藏。
6. `vidora_export` 只返回文件路径/大小，不返回正文，因此可以被云端会话安全调用。
7. 不记录完整字幕到普通日志；Worker 日志只记录阶段、任务 id 和错误。
8. 没有“自动降级到云端”的代码路径。

如果需要在 DSH 对话中直接阅读转写正文，请把 DSH 主模型切换为已确认在本地运行的 provider，并把它的 provider id 加入 `trustedLocalProviders`。否则请通过 `vidora_export` 导出文件，在本机查看。

## 数据目录

默认使用操作系统用户数据目录：

| 平台 | 默认位置 |
|---|---|
| macOS | `~/Library/Application Support/Vidora` |
| Linux | `$XDG_DATA_HOME/vidora` 或 `~/.local/share/vidora` |
| Windows | `%APPDATA%\Vidora` |

可用 `dataDir` 或环境变量 `VIDORA_DATA_DIR` 覆盖。

```text
Vidora/
├── meta.json
├── models/
├── projects/
│   └── prj-<source-hash>/
│       ├── source.json
│       ├── transcript.json          # 最近一次转写的便捷副本
│       ├── transcripts/<id>.json    # 规范转写文件
│       ├── document.json            # 最近一次讲义
│       ├── documents/<id>.json
│       ├── notes/<id>.md
│       └── exports/
├── tasks/<task-id>/
│   ├── task.json
│   ├── checkpoint.json              # 中断/取消后可恢复
│   └── work/audio.wav
├── cache/index.json
└── logs/worker.log
```

同一个音视频按 SHA-256 + 模型 + 语言 + 对齐 + VAD 参数判断缓存；命中时不会重新执行 ASR。`vidora cleanup --older-than 7` 可清理旧任务的临时 WAV、检查点和失效缓存项。

## Transcript / Document 契约

见 [docs/data-format.md](docs/data-format.md)。核心约束：

- 时间戳统一毫秒，对应原始媒体时间轴。
- Segment ID 稳定且唯一。
- `timing_status` 为 `aligned` / `chunk` / `uncertain`。
- 原始 `transcript.json` 不会被 LLM 润色结果覆盖；讲义是独立的 `document.json`。
- DocumentBlock 通过 `source_segment_ids` 关联转写片段；Markdown 渲染时由程序生成时间戳和相对链接，LLM 不能编造时间戳。

## 任务恢复与 Worker 生命周期

- Python Worker 由 Node `child_process.spawn()` 启动，不在 Harness 主进程内做推理。
- Worker 按需启动、复用已加载模型、空闲可卸载（默认 900 秒）。
- 任务状态持久化在 `tasks/<id>/task.json`，Worker 在每个 ASR 片段后写 `checkpoint.json`。
- 插件重启/Worker 崩溃/任务取消后，状态变为 `interrupted` 或 `cancelled`，`resumable=true`；用 `vidora_transcribe` 的 `resumeTaskId` 参数恢复。
- 插件卸载时先标记未完成任务为 interrupted，再发送 `worker.shutdown`；超时后终止子进程。不会因为切换会话而取消转写。
- 重复提交相同任务会返回已有 task 或已完成缓存，不会重复执行。

## 配置

完整字段与默认值见 [docs/configuration.md](docs/configuration.md)。常用字段：

```yaml
- id: vidora
  config:
    dataDir: /path/to/Vidora
    worker:
      pythonPath: /path/to/python-worker/.venv/bin/python
      idleUnloadSeconds: 900
    asr:
      defaultModel: qwen3-asr-0.6b
      modelsDir: /path/to/models
      device: auto              # auto | cpu | mps | cuda
      dtype: auto               # auto | float16 | bfloat16 | float32
      language: auto
      align: true
      alignerModel: qwen3-forced-aligner-0.6b
      maxChunkSeconds: 30
      vad:
        thresholdDb: null       # null = 自适应
        minSilenceMs: 400
        minSpeechMs: 250
        paddingMs: 150
        frameMs: 20
    llm:
      mode: off
      model: ""
      baseUrl: ""
    privacy:
      strictLocal: true
      trustedLocalProviders: []
      trustedLocalModels: []
      untrustedFileToolPolicy: block-data-path   # block-data-path | block-all | off
    tasks:
      autoResume: false
      maxTaskHours: 8
      keepTempFiles: false
    paths:
      mode: explicit            # explicit | roots
      allowedRoots: []
      maxFileSizeBytes: 21474836480
      maxDurationMinutes: 480
    document:
      defaultMode: concise
      maxCharsPerWindow: 10000
      maxWindows: 300
```

## 开发与测试

```bash
npm run build          # TypeScript -> dist
npm test               # Node 单元/集成测试（37 项）
npm run test:python    # Python Worker 单元测试（需先安装 venv）
npm run check          # build + node --check + tests

# 真实推理（需要模型和 venv）
node scripts/real-asr-test.mjs testdata/audio/lecture-5m-zh.m4a --device mps

# 真实本地 LLM 讲义（需要 llama.cpp/Ollama/OpenAI 兼容端点）
node scripts/test-notes.mjs \
  --data-dir testdata/results/run-... \
  --transcript-id tr-... \
  --base-url http://127.0.0.1:8090/v1 \
  --model qwen2.5-3b-instruct \
  --modes concise,review

# 生成真实测试语音（macOS say；仅用于可重复测试）
node scripts/generate-test-audio.mjs --minutes 5 --name lecture-5m-zh
```

详细测试方法、CER 结果、取消/恢复结果见 [docs/test-report.md](docs/test-report.md)。

## 已知限制

- 只支持本地文件；不实现 YouTube/Bilibili 下载或受限媒体 URL。
- 第一版以 **片段级** 时间戳为可靠交付；字符/词级时间戳来自 ForcedAligner，作为增强字段 `words`。对齐失败时标记为 `chunk` 或 `uncertain`，不会伪造精确时间。
- 未实现说话人分离，`speaker_id` 始终为 `null`。
- MPS 已在 M1 Pro 上实测可用；CUDA 未在本机验证；CPU fallback 可用但更慢。
- Linux/Windows 的路径、进程和安装流程未在本机实测。
- 1.7B ASR 模型、真实 GPU、Intel Mac 未实测。
- 本地 LLM 质量取决于用户选择的模型。测试中的 1.5B 模型能完成结构化输出，但章节合并和术语解释质量明显弱于更大的模型；生产建议 7B 以上或经课程领域微调的模型。
- 长音频的 ASR 片段是 VAD 边界；跨边界句子采用静音感知切分 + 边界重复抑制，但不做强制重切/全文重对齐。
- 模型权重下载需要网络和用户显式确认；首次安装不包含权重。

## 许可证

插件代码：MIT。第三方模型、Python 包、FFmpeg 的许可证与来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。Qwen3-ASR / ForcedAligner 权重为 Apache-2.0。
