from __future__ import annotations

import hashlib
import json
import os
import re
import resource
import shutil
import sys
import threading
import time
import traceback
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Protocol

from asr.base import ASRError
from asr.qwen3 import language_code
from config import TranscribeConfig, WorkerConfig
from media import ffmpeg
from media import vad as vad_module
from protocol import WorkerError

PIPELINE_VERSION = 1
MODEL_REPOS = {
    "qwen3-asr-0.6b": "Qwen/Qwen3-ASR-0.6B",
    "qwen3-asr-1.7b": "Qwen/Qwen3-ASR-1.7B",
}
ALIGNER_REPOS = {
    "qwen3-forced-aligner-0.6b": "Qwen/Qwen3-ForcedAligner-0.6B",
}


@dataclass
class TaskRecord:
    task_id: str
    request_id: str
    params: TranscribeConfig
    cancel_event: threading.Event = field(default_factory=threading.Event)
    created_at: str = field(default_factory=lambda: utc_now())
    started_at: Optional[str] = None
    status: str = "queued"
    stage: str = "preparing"
    error: Optional[dict] = None


class TaskHooks(Protocol):
    def ensure_asr(self, params: TranscribeConfig): ...
    def ensure_aligner(self, params: TranscribeConfig): ...
    def progress(
        self,
        task: TaskRecord,
        stage: str,
        processed_ms: int,
        total_ms: int,
        completed_chunks: int,
        total_chunks: int,
    ) -> None: ...
    def completed(self, task: TaskRecord, result: Dict[str, Any]) -> None: ...
    def failed(self, task: TaskRecord, code: str, message: str, stage: str, resumable: bool) -> None: ...
    def cancelled(self, task: TaskRecord, resumable: bool) -> None: ...


class TaskExecutor:
    def __init__(self, config: WorkerConfig, hooks: TaskHooks):
        self.config = config
        self.hooks = hooks

    def execute(self, task: TaskRecord) -> None:
        started = time.monotonic()
        params = task.params
        try:
            self._execute(task, started)
        except InterruptedError:
            task.status = "cancelled"
            task.stage = "cancelled"
            self.hooks.cancelled(task, resumable=True)
        except WorkerError as exc:
            task.status = "failed"
            task.stage = exc.stage or task.stage or "failed"
            task.error = {"code": exc.code, "message": exc.message, "stage": task.stage}
            self.hooks.failed(task, exc.code, exc.message, task.stage, _resumable_for(exc.code))
        except ASRError as exc:
            task.status = "failed"
            task.stage = "transcribing"
            task.error = {"code": exc.code, "message": str(exc), "stage": task.stage}
            self.hooks.failed(task, exc.code, str(exc), task.stage, _resumable_for(exc.code))
        except Exception as exc:  # pragma: no cover - safety net
            traceback.print_exc()
            task.status = "failed"
            task.stage = task.stage or "failed"
            task.error = {"code": "TASK_FAILED", "message": str(exc)[:800], "stage": task.stage}
            self.hooks.failed(task, "TASK_FAILED", str(exc)[:800], task.stage, True)

    def _execute(self, task: TaskRecord, started: float) -> None:
        params = task.params
        setattr(task, "run_started", started)
        _check_paths_within(self.config.data_dir, params.task_dir)
        _check_paths_within(self.config.data_dir, params.transcript_path)
        os.makedirs(params.task_dir, exist_ok=True)
        os.makedirs(os.path.join(params.task_dir, "work"), exist_ok=True)
        os.makedirs(os.path.dirname(params.transcript_path) or ".", exist_ok=True)
        self._raise_if_cancelled(task)
        task.status = "running"
        task.started_at = utc_now()
        self.hooks.progress(task, "preparing", 0, 0, 0, 0)

        file_size = os.path.getsize(params.file_path)
        if file_size > self.config.max_file_size_bytes:
            raise WorkerError(
                f"Input file exceeds max_file_size_bytes ({file_size} > {self.config.max_file_size_bytes})",
                "FILE_TOO_LARGE",
                stage="preparing",
            )
        actual_hash = sha256_file(params.file_path)
        if actual_hash.lower() != params.source_sha256.lower():
            raise WorkerError(
                "Source file changed after the task was created (sha256 mismatch).",
                "SOURCE_HASH_MISMATCH",
                stage="preparing",
            )

        checkpoint = None
        if params.resume:
            checkpoint = self._load_checkpoint(task)
        else:
            self._remove_checkpoint(task)

        if checkpoint:
            signature_ok = self._checkpoint_signature_matches(checkpoint, task)
            if not signature_ok:
                raise WorkerError(
                    "Checkpoint parameters do not match this task.",
                    "CHECKPOINT_MISMATCH",
                    stage="preparing",
                )
            task.stage = str(checkpoint.get("stage") or "transcribing")
            probe = checkpoint.get("probe") or {}
            chunks = [dict(item) for item in (checkpoint.get("chunks") or [])]
            segments = [dict(item) for item in (checkpoint.get("segments") or [])]
            warnings = list(checkpoint.get("warnings") or [])
            next_chunk = int(checkpoint.get("next_chunk") or 0)
            align_next = int(checkpoint.get("align_next") or 0)
            aligner_used = bool(checkpoint.get("aligner_used", False))
            threshold_db = checkpoint.get("threshold_db")
            duration_ms = int(probe.get("duration_ms") or 0)
            asr_info = dict(checkpoint.get("asr_info") or {})
            processing_before = int(checkpoint.get("processing_ms") or 0)
        else:
            probe = ffmpeg.probe_media(params.file_path).as_dict()
            chunks = []
            segments = []
            warnings = []
            next_chunk = 0
            align_next = 0
            aligner_used = False
            threshold_db = None
            duration_ms = int(probe.get("duration_ms") or 0)
            asr_info = {}
            processing_before = 0

        setattr(task, "asr_info", asr_info)
        setattr(task, "processing_before", processing_before)

        if duration_ms <= 0:
            raise WorkerError("Could not determine media duration.", "DURATION_UNKNOWN", stage="preparing")
        if duration_ms > self.config.max_duration_minutes * 60_000:
            raise WorkerError(
                f"Media exceeds max_duration_minutes ({duration_ms} ms > {self.config.max_duration_minutes} minutes).",
                "MEDIA_TOO_LONG",
                stage="preparing",
                details={"duration_ms": duration_ms},
            )

        wav_path = os.path.join(params.task_dir, "work", "audio.wav")
        wav_ready = os.path.isfile(wav_path)

        if not checkpoint:
            self._save_checkpoint(
                task,
                stage="decoding",
                probe=probe,
                wav_path=wav_path,
                duration_ms=duration_ms,
                chunks=chunks,
                segments=segments,
                next_chunk=next_chunk,
                align_next=align_next,
                warnings=warnings,
                threshold_db=threshold_db,
                aligner_used=aligner_used,
            )

        if not wav_ready:
            task.stage = "decoding"
            self._raise_if_cancelled(task)

            def decode_progress(processed: int) -> None:
                self.hooks.progress(task, "decoding", min(processed, duration_ms), duration_ms, 0, 0)

            decoded_ms = ffmpeg.decode_audio(
                params.file_path,
                wav_path,
                duration_ms,
                task.cancel_event,
                decode_progress,
                timeout_seconds=max(300.0, duration_ms / 1000 * 8),
            )
            duration_ms = decoded_ms or duration_ms
            self._save_checkpoint(
                task,
                stage="decoding",
                probe=probe,
                wav_path=wav_path,
                duration_ms=duration_ms,
                chunks=chunks,
                segments=segments,
                next_chunk=next_chunk,
                align_next=align_next,
                warnings=warnings,
                threshold_db=threshold_db,
                aligner_used=aligner_used,
            )
            self.hooks.progress(task, "decoding", duration_ms, duration_ms, 0, 0)

        if not chunks:
            task.stage = "segmenting"
            self._raise_if_cancelled(task)

            def segment_progress(processed: int) -> None:
                self.hooks.progress(task, "segmenting", min(processed, duration_ms), duration_ms, 0, 0)

            try:
                vad_result = vad_module.analyze(
                    wav_path,
                    duration_ms,
                    params.vad,
                    params.max_chunk_seconds,
                    task.cancel_event,
                    segment_progress,
                )
            except InterruptedError:
                raise
            chunks = vad_result.chunks
            warnings.extend(vad_result.warnings)
            threshold_db = vad_result.threshold_db
            self.hooks.progress(task, "segmenting", duration_ms, duration_ms, 0, len(chunks))
            self._save_checkpoint(
                task,
                stage="transcribing",
                probe=probe,
                wav_path=wav_path,
                duration_ms=duration_ms,
                chunks=chunks,
                segments=segments,
                next_chunk=0,
                align_next=0,
                warnings=warnings,
                threshold_db=threshold_db,
                aligner_used=False,
            )

        total_chunks = len(chunks)
        if total_chunks == 0:
            warnings.append("No speech segments were found in the media.")
        task.stage = "transcribing"

        if total_chunks > 0 and next_chunk < total_chunks:
            backend = self.hooks.ensure_asr(params)
            setattr(task, "asr_info", backend.info())
            asr_info = backend.info()
            for index in range(next_chunk, total_chunks):
                self._raise_if_cancelled(task)
                chunk = chunks[index]
                start_ms = int(chunk["start_ms"])
                end_ms = int(chunk["end_ms"])
                try:
                    audio, sample_rate = ffmpeg.extract_chunk(wav_path, start_ms, end_ms)
                except Exception as exc:
                    warnings.append(f"Chunk {index + 1} could not be read: {exc}")
                    next_chunk = index + 1
                    self._save_checkpoint(
                        task, stage="transcribing", probe=probe, wav_path=wav_path,
                        duration_ms=duration_ms, chunks=chunks, segments=segments,
                        next_chunk=next_chunk, align_next=align_next, warnings=warnings,
                        threshold_db=threshold_db, aligner_used=aligner_used,
                    )
                    continue
                if audio.size == 0:
                    warnings.append(f"Chunk {index + 1} was empty and was skipped.")
                    next_chunk = index + 1
                    self._save_checkpoint(
                        task, stage="transcribing", probe=probe, wav_path=wav_path,
                        duration_ms=duration_ms, chunks=chunks, segments=segments,
                        next_chunk=next_chunk, align_next=align_next, warnings=warnings,
                        threshold_db=threshold_db, aligner_used=aligner_used,
                    )
                    continue
                try:
                    asr_result = backend.transcribe(
                        audio,
                        sample_rate,
                        params.language,
                        params.context,
                    )
                except ASRError as exc:
                    if exc.code == "ASR_OUT_OF_MEMORY" and backend.info().get("device") != "cpu":
                        warnings.append("ASR ran out of memory; the task is resumable. Retry with device=cpu.")
                    raise
                text = clean_text(asr_result.text)
                if text:
                    segment = {
                        "id": f"seg-{index + 1:06d}",
                        "start_ms": start_ms,
                        "end_ms": end_ms,
                        "text": text,
                        "speaker_id": None,
                        "timing_status": "chunk",
                        "_language": asr_result.language,
                    }
                    segments.append(segment)
                    warnings.extend(asr_result.warnings)
                next_chunk = index + 1
                self._save_checkpoint(
                    task, stage="transcribing", probe=probe, wav_path=wav_path,
                    duration_ms=duration_ms, chunks=chunks, segments=segments,
                    next_chunk=next_chunk, align_next=align_next, warnings=warnings,
                    threshold_db=threshold_db, aligner_used=aligner_used,
                )
                self.hooks.progress(
                    task, "transcribing", end_ms, duration_ms, next_chunk, total_chunks,
                )

        if next_chunk >= total_chunks:
            self.hooks.progress(task, "transcribing", duration_ms, duration_ms, total_chunks, total_chunks)

        if params.align and params.aligner_model_path and segments:
            task.stage = "aligning"
            self._save_checkpoint(
                task, stage="aligning", probe=probe, wav_path=wav_path,
                duration_ms=duration_ms, chunks=chunks, segments=segments,
                next_chunk=next_chunk, align_next=align_next, warnings=warnings,
                threshold_db=threshold_db, aligner_used=aligner_used,
            )
            self._raise_if_cancelled(task)
            if align_next >= len(segments):
                aligner_used = any(seg.get("timing_status") == "aligned" for seg in segments)
            else:
                aligner = None
                try:
                    aligner = self.hooks.ensure_aligner(params)
                except Exception as exc:
                    warnings.append(f"Forced aligner unavailable; keeping chunk timestamps: {str(exc)[:300]}")
                if aligner is not None:
                    for index in range(align_next, len(segments)):
                        self._raise_if_cancelled(task)
                        segment = segments[index]
                        chunk = _chunk_for_segment(chunks, segment)
                        if chunk is None:
                            align_next = index + 1
                            continue
                        try:
                            audio, sample_rate = ffmpeg.extract_chunk(
                                wav_path, int(chunk["start_ms"]), int(chunk["end_ms"])
                            )
                            words = aligner.align(
                                audio,
                                sample_rate,
                                str(segment.get("text") or ""),
                                str(segment.get("_language") or params.language or "Chinese"),
                            )
                        except Exception as exc:
                            warnings.append(
                                f"Alignment failed for {segment.get('id')}; keeping chunk timestamp: {str(exc)[:300]}"
                            )
                            words = []
                        if words:
                            base = int(chunk["start_ms"])
                            clip_end = int(chunk["end_ms"])
                            mapped = []
                            for word in words:
                                word_start = base + int(word["start_ms"])
                                word_end = base + int(word["end_ms"])
                                word_start = max(base, min(clip_end, word_start))
                                word_end = max(word_start, min(clip_end, word_end))
                                mapped.append({
                                    "text": word["text"],
                                    "start_ms": word_start,
                                    "end_ms": word_end,
                                })
                            if mapped:
                                segment["words"] = mapped
                                segment["start_ms"] = mapped[0]["start_ms"]
                                segment["end_ms"] = max(mapped[-1]["end_ms"], mapped[0]["start_ms"] + 1)
                                segment["timing_status"] = "aligned"
                                aligner_used = True
                        align_next = index + 1
                        self._save_checkpoint(
                            task, stage="aligning", probe=probe, wav_path=wav_path,
                            duration_ms=duration_ms, chunks=chunks, segments=segments,
                            next_chunk=next_chunk, align_next=align_next, warnings=warnings,
                            threshold_db=threshold_db, aligner_used=aligner_used,
                        )
                        self.hooks.progress(
                            task, "aligning", int(segment.get("end_ms") or 0),
                            duration_ms, align_next, total_chunks,
                        )
        elif params.align and not params.aligner_model_path:
            warnings.append("Alignment requested but no aligner model path was provided; chunk timestamps retained.")

        segments = finalize_segments(segments)
        language = aggregate_language(segments, params.language)
        processing_ms = processing_before + int((time.monotonic() - started) * 1000)
        peak_mb = peak_memory_mb()
        transcript = build_transcript(
            task=task,
            probe=probe,
            duration_ms=duration_ms,
            file_size=file_size,
            chunks=chunks,
            segments=segments,
            asr_info=asr_info,
            language=language,
            warnings=unique(warnings),
            processing_ms=processing_ms,
            peak_memory_mb=peak_mb,
            total_chunks=total_chunks,
            aligner_used=aligner_used,
        )
        write_json_atomic(params.transcript_path, transcript)
        self._remove_checkpoint(task)
        if not params.keep_temp_files:
            shutil.rmtree(os.path.join(params.task_dir, "work"), ignore_errors=True)
        task.status = "completed"
        task.stage = "completed"
        result = {
            "transcript_id": params.transcript_id,
            "transcript_path": params.transcript_path,
            "duration_ms": duration_ms,
            "segment_count": len(segments),
            "language": language,
            "model": params.model,
            "processing_ms": processing_ms,
            "peak_memory_mb": peak_mb,
            "warnings": unique(warnings)[:100],
        }
        self.hooks.completed(task, result)

    def _raise_if_cancelled(self, task: TaskRecord) -> None:
        if task.cancel_event.is_set():
            raise InterruptedError("cancelled")

    def _checkpoint_path(self, task: TaskRecord) -> str:
        return os.path.join(task.params.task_dir, "checkpoint.json")

    def _load_checkpoint(self, task: TaskRecord) -> Optional[dict]:
        path = self._checkpoint_path(task)
        if not os.path.isfile(path):
            return None
        try:
            with open(path, "r", encoding="utf-8") as handle:
                value = json.load(handle)
            return value if isinstance(value, dict) else None
        except Exception as exc:
            raise WorkerError(
                f"Checkpoint is unreadable: {exc}",
                "CHECKPOINT_INVALID",
                stage="preparing",
            ) from exc

    def _save_checkpoint(
        self,
        task: TaskRecord,
        *,
        stage: str,
        probe: dict,
        wav_path: str,
        duration_ms: int,
        chunks: List[dict],
        segments: List[dict],
        next_chunk: int,
        align_next: int,
        warnings: List[str],
        threshold_db: Optional[float],
        aligner_used: bool,
    ) -> None:
        value = {
            "version": 1,
            "task_id": task.task_id,
            "stage": stage,
            "updated_at": utc_now(),
            "signature": checkpoint_signature(task),
            "probe": probe,
            "wav_path": wav_path,
            "duration_ms": duration_ms,
            "chunks": chunks,
            "segments": segments,
            "next_chunk": next_chunk,
            "align_next": align_next,
            "warnings": unique(warnings)[:100],
            "threshold_db": threshold_db,
            "aligner_used": aligner_used,
            "asr_info": getattr(task, "asr_info", {}),
            "processing_ms": getattr(task, "processing_before", 0)
            + int((time.monotonic() - getattr(task, "run_started", time.monotonic())) * 1000),
        }
        write_json_atomic(self._checkpoint_path(task), value)

    def _remove_checkpoint(self, task: TaskRecord) -> None:
        path = self._checkpoint_path(task)
        try:
            os.remove(path)
        except FileNotFoundError:
            pass

    def _checkpoint_signature_matches(self, checkpoint: dict, task: TaskRecord) -> bool:
        return checkpoint.get("signature") == checkpoint_signature(task)


def checkpoint_signature(task: TaskRecord) -> dict:
    params = task.params
    return {
        "source_sha256": params.source_sha256.lower(),
        "model": params.model,
        "aligner_model": params.aligner_model,
        "language": params.language,
        "align": params.align,
        "max_chunk_seconds": params.max_chunk_seconds,
        "vad": {
            "threshold_db": params.vad.threshold_db,
            "min_silence_ms": params.vad.min_silence_ms,
            "min_speech_ms": params.vad.min_speech_ms,
            "padding_ms": params.vad.padding_ms,
            "max_gap_ms": params.vad.max_gap_ms,
            "frame_ms": params.vad.frame_ms,
        },
        "pipeline_version": PIPELINE_VERSION,
    }


def build_transcript(
    *,
    task: TaskRecord,
    probe: dict,
    duration_ms: int,
    file_size: int,
    chunks: List[dict],
    segments: List[dict],
    asr_info: dict,
    language: str,
    warnings: List[str],
    processing_ms: int,
    peak_memory_mb: Optional[float],
    total_chunks: int,
    aligner_used: bool,
) -> dict:
    params = task.params
    clean_segments = []
    for segment in segments:
        clean = {key: value for key, value in segment.items() if not key.startswith("_")}
        clean_segments.append(clean)
    speech_ms = 0
    for chunk in chunks:
        speech_ms += int(chunk.get("end_ms", 0)) - int(chunk.get("start_ms", 0))
    if speech_ms <= 0:
        speech_ms = 0
    runtime_factor = round(processing_ms / duration_ms, 4) if duration_ms > 0 else None
    return {
        "version": 1,
        "id": params.transcript_id,
        "project_id": params.project_id,
        "source": {
            "path": params.file_path,
            "duration_ms": duration_ms,
            "sha256": params.source_sha256,
            "size_bytes": file_size,
            "container": probe.get("container"),
            "audio_codec": probe.get("audio_codec"),
            "sample_rate": probe.get("sample_rate"),
            "channels": probe.get("channels"),
        },
        "model": params.model,
        "model_info": {
            "id": params.model,
            "repo": MODEL_REPOS.get(params.model),
            "backend": "transformers",
            "device": asr_info.get("device") or params.device,
            "dtype": asr_info.get("dtype") or params.dtype,
            "package_version": asr_info.get("package_version"),
            "aligner": params.aligner_model if aligner_used else None,
        },
        "language": language,
        "created_at": utc_now(),
        "params": {
            "language": params.language,
            "align": bool(aligner_used),
            "context": params.context,
            "max_chunk_seconds": params.max_chunk_seconds,
            "vad": {
                "threshold_db": params.vad.threshold_db,
                "min_silence_ms": params.vad.min_silence_ms,
                "min_speech_ms": params.vad.min_speech_ms,
                "padding_ms": params.vad.padding_ms,
                "max_gap_ms": params.vad.max_gap_ms,
                "frame_ms": params.vad.frame_ms,
            },
            "pipeline_version": PIPELINE_VERSION,
        },
        "segments": clean_segments,
        "stats": {
            "segment_count": len(clean_segments),
            "speech_duration_ms": speech_ms,
            "processing_ms": processing_ms,
            "peak_memory_mb": peak_memory_mb,
            "realtime_factor": runtime_factor,
            "completed_chunks": total_chunks,
            "total_chunks": total_chunks,
        },
        "warnings": warnings[:100],
    }


def finalize_segments(segments: List[dict]) -> List[dict]:
    output: List[dict] = []
    previous_norm = ""
    previous_end = -1
    for segment in segments:
        text = clean_text(str(segment.get("text") or ""))
        if not text:
            continue
        norm = re.sub(r"\s+", "", text)
        start = int(segment.get("start_ms") or 0)
        end = int(segment.get("end_ms") or start + 1)
        if previous_norm and norm == previous_norm and start - previous_end <= 700:
            continue
        words = segment.get("words")
        if output:
            text, start, words = _trim_boundary_overlap(output[-1], text, start, words)
            if not text:
                continue
            norm = re.sub(r"\s+", "", text)
            previous_end = int(output[-1].get("end_ms") or previous_end)
        if start < previous_end:
            start = previous_end
        if end <= start:
            end = start + 1
        cleaned = dict(segment)
        cleaned["text"] = text
        cleaned["start_ms"] = start
        cleaned["end_ms"] = end
        if "words" in cleaned:
            cleaned["words"] = [
                {
                    "text": str(word.get("text") or ""),
                    "start_ms": int(word.get("start_ms") or start),
                    "end_ms": int(word.get("end_ms") or start + 1),
                }
                for word in (words or [])
                if str(word.get("text") or "").strip()
            ]
        output.append(cleaned)
        previous_norm = norm
        previous_end = end
    return [segment for segment in output if str(segment.get("text") or "").strip()]


def _trim_boundary_overlap(
    previous: dict,
    text: str,
    start: int,
    words: Optional[List[dict]],
) -> tuple[str, int, Optional[List[dict]]]:
    """Remove a repeated prefix at a chunk boundary.

    Qwen occasionally repeats the first character or word when two VAD chunks
    meet exactly at the same timestamp. We only trim a short overlap and only
    when the text still has real content afterwards.
    """
    gap = start - int(previous.get("end_ms") or 0)
    if gap > 800:
        return text, start, words
    previous_words = previous.get("words") or []
    current_words = words or []
    if previous_words and current_words:
        max_overlap = min(6, len(previous_words), len(current_words))
        for count in range(max_overlap, 0, -1):
            left = [str(item.get("text") or "") for item in previous_words[-count:]]
            right = [str(item.get("text") or "") for item in current_words[:count]]
            if left == right and all(left) and sum(len(item) for item in left) >= 1:
                prefix = "".join(right)
                if text.startswith(prefix) and len(text) > len(prefix):
                    _trim_previous_suffix(previous, prefix, count)
                    remaining_words = current_words[count:]
                    new_start = int(remaining_words[0]["start_ms"]) if remaining_words else start
                    return text[len(prefix):].lstrip(), new_start, remaining_words
                break
    max_overlap = min(8, len(previous_text := clean_text(str(previous.get("text") or ""))), len(text))
    for count in range(max_overlap, 1, -1):
        if previous_text[-count:] == text[:count] and len(text) > count:
            return text[count:].lstrip(), start, words
    return text, start, words


def _trim_previous_suffix(previous: dict, prefix: str, word_count: int) -> None:
    previous_text = clean_text(str(previous.get("text") or ""))
    pattern = re.compile(re.escape(prefix) + r"[\s。！？，、；：.!?,;:]*$")
    trimmed = pattern.sub("", previous_text).strip()
    if trimmed == previous_text:
        return
    previous["text"] = trimmed
    words = previous.get("words") or []
    if words:
        remaining = words[:-word_count]
        previous["words"] = remaining
        if remaining:
            previous["end_ms"] = int(remaining[-1].get("end_ms") or previous.get("end_ms") or 0)


def aggregate_language(segments: List[dict], forced: str) -> str:
    values = [str(segment.get("_language") or "") for segment in segments]
    values = [value for value in values if value.strip()]
    forced_code = (forced or "").strip().lower()
    if forced_code and forced_code not in ("auto", "none", "null"):
        return language_code(forced, forced)
    if not values:
        return "unknown"
    counter = Counter(values)
    most_common = counter.most_common(1)[0][0]
    combined = language_code(most_common, None)
    if any("chinese" in value.lower() and "english" in value.lower() for value in values):
        return "zh-en"
    return combined


def clean_text(text: str) -> str:
    value = (text or "").replace("\u0000", "").strip()
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def sha256_file(path: str, chunk_size: int = 4 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def peak_memory_mb() -> Optional[float]:
    try:
        value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        if value <= 0:
            return None
        if sys.platform == "darwin":
            return round(value / (1024 * 1024), 1)
        return round(value / 1024, 1)
    except Exception:
        return None


def write_json_atomic(path: str, value: Any) -> None:
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    temp = os.path.join(directory, f".{os.path.basename(path)}.{os.getpid()}.{time.time_ns()}.tmp")
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def unique(values: List[str]) -> List[str]:
    result: List[str] = []
    for value in values:
        if value and value not in result:
            result.append(value)
    return result


def _resumable_for(code: str) -> bool:
    return code not in {
        "FFMPEG_NOT_FOUND",
        "FFPROBE_NOT_FOUND",
        "ASR_PACKAGE_MISSING",
        "ASR_MODEL_LOAD_FAILED",
        "ALIGNER_MODEL_LOAD_FAILED",
        "MODEL_NOT_FOUND",
        "INPUT_NOT_FOUND",
        "SOURCE_HASH_MISMATCH",
        "NO_AUDIO_STREAM",
    }


def _chunk_for_segment(chunks: List[dict], segment: dict) -> Optional[dict]:
    start = int(segment.get("start_ms") or 0)
    end = int(segment.get("end_ms") or 0)
    for chunk in chunks:
        if start >= int(chunk["start_ms"]) and end <= int(chunk["end_ms"]):
            return chunk
    for chunk in chunks:
        mid = (start + end) // 2
        if int(chunk["start_ms"]) <= mid < int(chunk["end_ms"]):
            return chunk
    return None


def _check_paths_within(root: str, target: str) -> None:
    root_real = os.path.realpath(root)
    target_real = os.path.realpath(target)
    if target_real != root_real and not target_real.startswith(root_real + os.sep):
        raise WorkerError(
            f"Refusing to write outside the Vidora data directory: {target}",
            "PATH_OUTSIDE_DATA_DIR",
            stage="preparing",
        )
