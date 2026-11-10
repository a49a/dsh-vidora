from __future__ import annotations

import math
import threading
import wave
from dataclasses import dataclass, field
from typing import Callable, List, Optional

import numpy as np

from config import VadConfig
from media.chunking import Region, plan_chunks, validate_chunks


@dataclass
class VadResult:
    chunks: List[dict]
    threshold_db: Optional[float]
    speech_ms: int
    total_ms: int
    warnings: List[str] = field(default_factory=list)
    frame_db: Optional[np.ndarray] = None


def analyze(
    wav_path: str,
    duration_ms: int,
    vad: VadConfig,
    max_chunk_seconds: int,
    cancel_event: threading.Event,
    progress: Callable[[int], None],
) -> VadResult:
    frame_ms = max(10, min(50, int(vad.frame_ms)))
    frame_db, frame_ms, total_frames = _compute_frame_db(
        wav_path, frame_ms, duration_ms, cancel_event, progress
    )
    if total_frames == 0:
        return VadResult(chunks=[], threshold_db=None, speech_ms=0, total_ms=duration_ms)

    threshold = vad.threshold_db
    if threshold is None:
        threshold = _adaptive_threshold(frame_db)

    regions = _regions_from_mask(frame_db, threshold, frame_ms, vad.min_silence_ms)
    if not regions:
        # Conservative fallback: never drop audio just because the threshold
        # guessed wrong. Fixed chunks still get real timestamps from ASR chunks.
        chunks = _fixed_chunks(duration_ms, max_chunk_seconds)
        return VadResult(
            chunks=chunks,
            threshold_db=threshold,
            speech_ms=sum(chunk["end_ms"] - chunk["start_ms"] for chunk in chunks),
            total_ms=duration_ms,
            warnings=["VAD found no speech; used fixed chunking to avoid losing quiet speech."],
            frame_db=frame_db,
        )

    regions = [region for region in regions if region.end_ms - region.start_ms >= vad.min_speech_ms]
    chunks = plan_chunks(
        regions,
        duration_ms,
        max_chunk_seconds,
        frame_db=frame_db,
        frame_ms=frame_ms,
        padding_ms=vad.padding_ms,
    )
    validate_chunks(chunks, duration_ms)
    warnings: List[str] = []
    if not chunks:
        chunks = _fixed_chunks(duration_ms, max_chunk_seconds)
        warnings.append("VAD regions were too short after filtering; used fixed chunking.")
    return VadResult(
        chunks=chunks,
        threshold_db=threshold,
        speech_ms=sum(chunk["end_ms"] - chunk["start_ms"] for chunk in chunks),
        total_ms=duration_ms,
        warnings=warnings,
        frame_db=frame_db,
    )


def _compute_frame_db(
    wav_path: str,
    frame_ms: int,
    duration_ms: int,
    cancel_event: threading.Event,
    progress: Callable[[int], None],
) -> tuple[np.ndarray, int, int]:
    with wave.open(wav_path, "rb") as handle:
        sample_rate = handle.getframerate()
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        if channels != 1 or width != 2:
            raise ValueError("VAD requires mono 16-bit PCM WAV")
        frame_samples = max(1, int(sample_rate * frame_ms / 1000))
        block_frames = sample_rate  # one second per read
        values: List[np.ndarray] = []
        processed = 0
        while True:
            if cancel_event.is_set():
                raise InterruptedError("cancelled")
            payload = handle.readframes(block_frames)
            if not payload:
                break
            samples = np.frombuffer(payload, dtype="<i2").astype(np.float32) / 32768.0
            usable = (samples.size // frame_samples) * frame_samples
            if usable > 0:
                frames = samples[:usable].reshape(-1, frame_samples)
                rms = np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)
                values.append(20.0 * np.log10(rms + 1e-9))
            processed += int(round(samples.size / sample_rate * 1000))
            progress(min(duration_ms, processed))
        frame_db = np.concatenate(values) if values else np.zeros(0, dtype=np.float32)
    return frame_db, frame_ms, int(frame_db.size)


def _adaptive_threshold(frame_db: np.ndarray) -> float:
    noise = float(np.percentile(frame_db, 10))
    speech = float(np.percentile(frame_db, 90))
    if not math.isfinite(noise):
        noise = -60.0
    if not math.isfinite(speech):
        speech = -20.0
    if speech - noise < 5.0:
        threshold = max(noise + 2.0, -50.0)
    else:
        threshold = noise + max(6.0, 0.35 * (speech - noise))
        threshold = min(threshold, speech - 6.0)
    return float(max(-55.0, min(-18.0, threshold)))


def _regions_from_mask(
    frame_db: np.ndarray,
    threshold: float,
    frame_ms: int,
    min_silence_ms: int,
) -> List[Region]:
    regions: List[Region] = []
    in_speech = False
    start_index = 0
    last_speech_index = 0
    silence_frames = max(1, int(min_silence_ms / frame_ms))
    for index, value in enumerate(frame_db):
        if value >= threshold:
            if not in_speech:
                start_index = index
                in_speech = True
            last_speech_index = index
        elif in_speech and index - last_speech_index >= silence_frames:
            regions.append(Region(start_index * frame_ms, (last_speech_index + 1) * frame_ms))
            in_speech = False
    if in_speech:
        regions.append(Region(start_index * frame_ms, (last_speech_index + 1) * frame_ms))
    return regions


def _fixed_chunks(duration_ms: int, max_chunk_seconds: int) -> List[dict]:
    max_ms = max(5, max_chunk_seconds) * 1000
    chunks: List[dict] = []
    cursor = 0
    while cursor < duration_ms:
        end = min(duration_ms, cursor + max_ms)
        if end - cursor >= 300:
            chunks.append({"index": len(chunks), "start_ms": cursor, "end_ms": end})
        cursor = end
    return chunks
