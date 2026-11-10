# Transcript and Document Data Format (Vidora Core v1)

These JSON contracts are shared by the DSH plugin, the future Chrome extension,
and a future GPUI desktop shell. They do not import Harness or Cordis types.

## Transcript (`transcript.json`)

```json
{
  "version": 1,
  "id": "tr-3f6f4f7d2b6a1c9e8a2d",
  "project_id": "prj-81b434c8cf8d1963",
  "source": {
    "path": "/Users/me/Videos/os-lecture.mp4",
    "duration_ms": 352154,
    "sha256": "b8ee32fa7f6260c66305b7820a6cf73886617725472a12db8e1f0d7e634fecb4",
    "size_bytes": 4521838,
    "container": "mov,mp4,m4a,3gp,3g2,mj2",
    "audio_codec": "aac",
    "sample_rate": 22050,
    "channels": 1
  },
  "model": "qwen3-asr-0.6b",
  "model_info": {
    "id": "qwen3-asr-0.6b",
    "repo": "Qwen/Qwen3-ASR-0.6B",
    "revision": null,
    "backend": "transformers",
    "device": "mps",
    "dtype": "float16",
    "package_version": "0.0.6",
    "aligner": "qwen3-forced-aligner-0.6b"
  },
  "language": "zh",
  "created_at": "2026-11-10T12:12:03.626Z",
  "params": {
    "language": "auto",
    "align": true,
    "context": "操作系统课程；保留中英文术语",
    "max_chunk_seconds": 30,
    "vad": {
      "threshold_db": null,
      "min_silence_ms": 400,
      "min_speech_ms": 250,
      "padding_ms": 150,
      "max_gap_ms": 300,
      "frame_ms": 20
    },
    "pipeline_version": 1
  },
  "segments": [
    {
      "id": "seg-000001",
      "start_ms": 0,
      "end_ms": 21360,
      "text": "第一部分，同学们好。……",
      "speaker_id": null,
      "timing_status": "aligned",
      "words": [
        { "text": "第", "start_ms": 0, "end_ms": 240 },
        { "text": "一", "start_ms": 240, "end_ms": 320 }
      ]
    }
  ],
  "stats": {
    "segment_count": 15,
    "speech_duration_ms": 352154,
    "processing_ms": 35344,
    "peak_memory_mb": 3421.2,
    "realtime_factor": 0.1004,
    "completed_chunks": 15,
    "total_chunks": 15
  },
  "warnings": []
}
```

### Field rules

- `version` is the transcript schema version. This document is version 1.
- `source.path` is the canonical local path at processing time.
- `source.duration_ms` and all times are milliseconds from the start of the
  original media.
- `source.sha256` is the full-file SHA-256 used for caching and checkpoint
  validation.
- `segments[].id` is stable and unique within the transcript. The worker uses
  the source chunk index (`seg-<6 digits>`); a dropped duplicate does not
  renumber later segments.
- `segments[].speaker_id` is `null` until a diarization backend exists.
- `segments[].timing_status`:
  - `aligned`: word/character aligner produced timestamps and the segment
    start/end come from the first/last aligned token.
  - `chunk`: timestamps are the VAD/chunk range; reliable at segment level.
  - `uncertain`: the backend or a consumer marked the timing as unreliable.
- `segments[].words` is optional. It is an enhancement; consumers must not
  assume it exists.
- `model_info.aligner` is `null` when alignment was not used.
- `params.align` records whether alignment actually succeeded for at least one
  segment, not merely whether the user requested it.
- `warnings` contains non-fatal degradations (aligner missing, VAD fallback,
  boundary dedupe, etc.). It must never contain transcript text.
- The raw transcript is never overwritten by generated notes.

### Segment ID stability

The ID is derived from the chunk index, not from text or time. Re-running ASR
with different parameters creates a new transcript file and a new transcript
id. Consumers should treat `(transcript_id, segment_id)` as the citation key.

## Document (`document.json`)

```json
{
  "version": 1,
  "id": "doc-1d8f3d7c3d4b6a0f91e2",
  "project_id": "prj-81b434c8cf8d1963",
  "transcript_id": "tr-3f6f4f7d2b6a1c9e8a2d",
  "mode": "concise",
  "title": "操作系统：虚拟内存",
  "language": "zh",
  "created_at": "2026-11-10T12:31:41.380Z",
  "version_number": 1,
  "llm": {
    "provider": "openai-compatible",
    "model": "qwen2.5-3b-instruct",
    "endpoint": "http://127.0.0.1:8090/v1",
    "local": true,
    "prompt_version": "vidora-notes-v1"
  },
  "blocks": [
    {
      "id": "block-001",
      "type": "section",
      "level": 2,
      "title": "虚拟内存与地址转换",
      "content": "虚拟内存通过页表把进程使用的虚拟地址转换为物理地址。TLB 缓存最近使用的页表项。",
      "source_segment_ids": ["seg-000001", "seg-000002"]
    },
    {
      "id": "block-002",
      "type": "key_terms",
      "title": "关键术语",
      "content": "- **TLB**：地址转换缓存",
      "source_segment_ids": ["seg-000001"]
    }
  ],
  "stats": {
    "source_segments": 15,
    "cited_segments": 15,
    "invalid_citations": 0,
    "windows": 1,
    "llm_calls": 1,
    "duration_ms": 34907
  },
  "warnings": []
}
```

### Modes

| Mode | Purpose |
|---|---|
| `concise` | Default. High-density teaching notes; removes filler and repetition. |
| `detailed` | Keeps explanations, derivations, and teaching examples. |
| `transcript` | Faithful readable transcript; only punctuation/spacing/paragraphing is polished. The raw transcript remains unchanged. |
| `review` | Knowledge points, definitions, self-test questions, and a review checklist. |

### Block rules

- `type`: `section`, `paragraph`, `list`, `code`, `formula`, `callout`,
  `key_terms`.
- `source_segment_ids` must reference segments in the cited transcript. The
  engine drops unknown IDs and increments `invalid_citations`.
- `uncertain: true` means the block has no valid source reference or the
  pipeline could not verify it. Markdown renders a visible warning.
- `level` controls the Markdown heading depth for section blocks.
- The model never chooses timestamps. The renderer looks up each segment's
  start time.

### Versioning

- Re-generating notes for the same `(transcript_id, mode, llm provider/model,
  prompt_version)` returns the latest document unless `force` is true.
- `force` creates a new document with `version_number + 1`; older documents are
  retained on disk.
- Re-generating notes never re-runs ASR.

## Markdown source mapping

Canonical transcript files live at `projects/<project>/transcripts/<id>.json`.
Document Markdown lives at `projects/<project>/notes/<doc>.md`. The renderer
emits portable relative links:

```markdown
## 虚拟内存的工作原理

虚拟内存通过地址映射，将进程使用的虚拟地址转换为物理地址。

来源：[12:34](../transcripts/tr-3f6f4f7d2b6a1c9e8a2d.json#seg-000120) · [13:02](../transcripts/tr-3f6f4f7d2b6a1c9e8a2d.json#seg-000121)
```

No custom URL scheme is required. A Chrome extension can resolve the relative
file + fragment to a video seek; a desktop player can do the same from
`document.json`.

## Exports

`vidora_export` supports:

- `md`: rendered document Markdown, or a readable transcript Markdown when no
  document is selected.
- `json`: the exact document or transcript JSON.
- `txt`: timestamped (or plain) text.
- `srt`: standard SRT with `HH:MM:SS,mmm` timestamps.

Exports never include transcript text in the tool result; only the local path
and byte count are returned.

## Compatibility

- New fields may be added; readers must ignore unknown fields.
- Removing or changing the meaning of a field requires a new `version`.
- `Vidora Core` code lives under `src/core/` and has no Harness dependency.
