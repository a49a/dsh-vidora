from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
import wave
from dataclasses import dataclass
from typing import Callable, List, Optional

from protocol import WorkerError


@dataclass
class MediaProbe:
    duration_ms: int
    container: str
    audio_codec: str
    sample_rate: int
    channels: int
    bit_rate: int

    def as_dict(self) -> dict:
        return {
            "duration_ms": self.duration_ms,
            "container": self.container,
            "audio_codec": self.audio_codec,
            "sample_rate": self.sample_rate,
            "channels": self.channels,
            "bit_rate": self.bit_rate,
        }


def ffmpeg_binary() -> str:
    binary = shutil.which("ffmpeg")
    if not binary:
        raise WorkerError(
            "FFmpeg is not installed or not on PATH. Install FFmpeg and retry.",
            "FFMPEG_NOT_FOUND",
            stage="preparing",
        )
    return binary


def ffprobe_binary() -> str:
    binary = shutil.which("ffprobe")
    if not binary:
        raise WorkerError(
            "ffprobe is not installed or not on PATH. Install FFmpeg (which includes ffprobe).",
            "FFPROBE_NOT_FOUND",
            stage="preparing",
        )
    return binary


def ffmpeg_version() -> Optional[str]:
    binary = shutil.which("ffmpeg")
    if not binary:
        return None
    try:
        result = subprocess.run(
            [binary, "-version"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        return (result.stdout or "").splitlines()[0].strip() if result.stdout else None
    except Exception:
        return None


def probe_media(path: str) -> MediaProbe:
    if not os.path.isfile(path):
        raise WorkerError(f"Input file not found: {path}", "INPUT_NOT_FOUND", stage="preparing")
    binary = ffprobe_binary()
    command = [
        binary,
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        path,
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=60, check=False)
    except subprocess.TimeoutExpired as exc:
        raise WorkerError("ffprobe timed out", "FFPROBE_TIMEOUT", stage="preparing") from exc
    if result.returncode != 0:
        raise WorkerError(
            f"ffprobe rejected the media: {(result.stderr or '').strip()[:800]}",
            "INVALID_MEDIA",
            stage="preparing",
        )
    try:
        data = json.loads(result.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise WorkerError("ffprobe returned invalid JSON", "FFPROBE_INVALID_JSON", stage="preparing") from exc
    streams = data.get("streams") or []
    audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    if not audio:
        raise WorkerError("The media has no audio stream", "NO_AUDIO_STREAM", stage="preparing")
    fmt = data.get("format") or {}
    duration = _float_or_none(fmt.get("duration"))
    if duration is None:
        duration = _float_or_none(audio.get("duration"))
    if not duration or duration <= 0:
        raise WorkerError("Could not determine media duration", "DURATION_UNKNOWN", stage="preparing")
    return MediaProbe(
        duration_ms=int(round(duration * 1000)),
        container=str(fmt.get("format_name") or ""),
        audio_codec=str(audio.get("codec_name") or ""),
        sample_rate=int(audio.get("sample_rate") or 0),
        channels=int(audio.get("channels") or 0),
        bit_rate=int(fmt.get("bit_rate") or 0),
    )


def check_disk_space(target_path: str, needed_bytes: int) -> None:
    directory = os.path.dirname(os.path.abspath(target_path)) or "."
    os.makedirs(directory, exist_ok=True)
    usage = shutil.disk_usage(directory)
    if usage.free < needed_bytes:
        raise WorkerError(
            f"Insufficient disk space: need {needed_bytes} bytes, free {usage.free} bytes at {directory}",
            "INSUFFICIENT_DISK",
            stage="preparing",
            details={"needed_bytes": needed_bytes, "free_bytes": usage.free},
        )


def decode_audio(
    input_path: str,
    output_wav: str,
    duration_ms: int,
    cancel_event: threading.Event,
    progress: Callable[[int], None],
    timeout_seconds: Optional[float] = None,
) -> int:
    binary = ffmpeg_binary()
    os.makedirs(os.path.dirname(os.path.abspath(output_wav)) or ".", exist_ok=True)
    needed = int(duration_ms / 1000 * 16000 * 2) + 512 * 1024 * 1024
    check_disk_space(output_wav, needed)
    command = [
        binary,
        "-hide_banner",
        "-nostdin",
        "-loglevel", "error",
        "-i", input_path,
        "-map", "0:a:0?",
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-c:a", "pcm_s16le",
        "-f", "wav",
        "-y",
        output_wav,
        "-progress", "pipe:1",
        "-nostats",
    ]
    started = time.monotonic()
    process = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    stderr_lines: List[str] = []

    def drain_stderr() -> None:
        assert process.stderr is not None
        for line in process.stderr:
            stderr_lines.append(line.rstrip())
            if len(stderr_lines) > 40:
                del stderr_lines[: len(stderr_lines) - 40]

    stderr_thread = threading.Thread(target=drain_stderr, daemon=True)
    stderr_thread.start()

    last_progress = -1
    try:
        assert process.stdout is not None
        for line in process.stdout:
            if cancel_event.is_set():
                _terminate(process)
                raise WorkerError("Transcription cancelled", "CANCELLED", stage="decoding")
            line = line.strip()
            if not line or "=" not in line:
                continue
            key, value = line.split("=", 1)
            if key in ("out_time_us", "out_time_ms"):
                try:
                    micros = int(value)
                except ValueError:
                    continue
                processed = max(0, min(duration_ms, int(micros / 1000)))
                if processed > last_progress:
                    last_progress = processed
                    progress(processed)
            elif key == "progress" and value == "end":
                progress(duration_ms)
            if timeout_seconds is not None and time.monotonic() - started > timeout_seconds:
                _terminate(process)
                raise WorkerError("FFmpeg decode timed out", "DECODE_TIMEOUT", stage="decoding")
        return_code = process.wait(timeout=30)
    finally:
        if process.poll() is None:
            _terminate(process)
        stderr_thread.join(timeout=2)
        try:
            if process.stdout is not None:
                process.stdout.close()
            if process.stderr is not None:
                process.stderr.close()
        except Exception:
            pass

    if return_code != 0:
        raise WorkerError(
            f"FFmpeg decode failed: {' | '.join(stderr_lines[-6:])[:1000]}",
            "DECODE_FAILED",
            stage="decoding",
        )
    info = wav_info(output_wav)
    return info["duration_ms"]


def wav_info(path: str) -> dict:
    if not os.path.isfile(path):
        raise WorkerError(f"Decoded WAV not found: {path}", "DECODE_OUTPUT_MISSING", stage="decoding")
    with wave.open(path, "rb") as handle:
        channels = handle.getnchannels()
        sample_width = handle.getsampwidth()
        sample_rate = handle.getframerate()
        frames = handle.getnframes()
    if channels != 1 or sample_width != 2 or sample_rate != 16000:
        raise WorkerError(
            f"Unexpected WAV format: channels={channels}, width={sample_width}, rate={sample_rate}",
            "INVALID_WAV",
            stage="decoding",
        )
    return {
        "channels": channels,
        "sample_width": sample_width,
        "sample_rate": sample_rate,
        "frames": frames,
        "duration_ms": int(round(frames / sample_rate * 1000)),
    }


def extract_chunk(wav_path: str, start_ms: int, end_ms: int):
    import numpy as np

    info = wav_info(wav_path)
    sample_rate = info["sample_rate"]
    start_frame = max(0, int(round(start_ms / 1000 * sample_rate)))
    end_frame = min(info["frames"], int(round(end_ms / 1000 * sample_rate)))
    if end_frame <= start_frame:
        return np.zeros(0, dtype=np.float32), sample_rate
    with wave.open(wav_path, "rb") as handle:
        handle.setpos(start_frame)
        payload = handle.readframes(end_frame - start_frame)
    samples = np.frombuffer(payload, dtype="<i2").astype(np.float32) / 32768.0
    return samples, sample_rate


def _terminate(process: subprocess.Popen) -> None:
    try:
        process.terminate()
    except Exception:
        pass
    try:
        process.wait(timeout=3)
    except Exception:
        try:
            process.kill()
        except Exception:
            pass


def _float_or_none(value) -> Optional[float]:
    try:
        result = float(value)
        return result if result > 0 else None
    except (TypeError, ValueError):
        return None
