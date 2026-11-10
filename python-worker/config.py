from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Dict, Optional


@dataclass
class WorkerConfig:
    data_dir: str
    models_dir: str
    device: str = "auto"
    dtype: str = "auto"
    log_level: str = "info"
    model_paths: Dict[str, str] = field(default_factory=dict)
    idle_unload_seconds: int = 900
    offline: bool = True
    max_duration_minutes: int = 480
    max_file_size_bytes: int = 20 * 1024**3

    @classmethod
    def from_params(cls, params: Dict[str, Any]) -> "WorkerConfig":
        data_dir = os.path.abspath(str(params.get("data_dir") or "."))
        models_dir = os.path.abspath(str(params.get("models_dir") or os.path.join(data_dir, "models")))
        raw_paths = params.get("model_paths") or {}
        model_paths: Dict[str, str] = {}
        if isinstance(raw_paths, dict):
            for key, value in raw_paths.items():
                if isinstance(key, str) and isinstance(value, str):
                    model_paths[key] = os.path.abspath(value)
        return cls(
            data_dir=data_dir,
            models_dir=models_dir,
            device=str(params.get("device") or "auto"),
            dtype=str(params.get("dtype") or "auto"),
            log_level=str(params.get("log_level") or "info"),
            model_paths=model_paths,
            idle_unload_seconds=int(params.get("idle_unload_seconds") or 900),
            offline=bool(params.get("offline", True)),
            max_duration_minutes=int(params.get("max_duration_minutes") or 480),
            max_file_size_bytes=int(params.get("max_file_size_bytes") or 20 * 1024**3),
        )


@dataclass
class VadConfig:
    threshold_db: Optional[float] = None
    min_silence_ms: int = 400
    min_speech_ms: int = 250
    padding_ms: int = 150
    max_gap_ms: int = 300
    frame_ms: int = 20

    @classmethod
    def from_value(cls, value: Any) -> "VadConfig":
        if not isinstance(value, dict):
            return cls()
        threshold = value.get("threshold_db")
        return cls(
            threshold_db=float(threshold) if isinstance(threshold, (int, float)) else None,
            min_silence_ms=int(value.get("min_silence_ms", 400)),
            min_speech_ms=int(value.get("min_speech_ms", 250)),
            padding_ms=int(value.get("padding_ms", 150)),
            max_gap_ms=int(value.get("max_gap_ms", 300)),
            frame_ms=int(value.get("frame_ms", 20)),
        )


@dataclass
class TranscribeConfig:
    task_id: str
    file_path: str
    source_sha256: str
    project_id: str
    transcript_id: str
    transcript_path: str
    task_dir: str
    model: str
    model_path: str
    aligner_model: Optional[str]
    aligner_model_path: Optional[str]
    language: str
    align: bool
    context: str
    device: str
    dtype: str
    max_chunk_seconds: int
    max_new_tokens: int
    vad: VadConfig
    resume: bool
    keep_temp_files: bool

    @classmethod
    def from_params(cls, params: Dict[str, Any]) -> "TranscribeConfig":
        required = [
            "task_id",
            "file_path",
            "source_sha256",
            "project_id",
            "transcript_id",
            "transcript_path",
            "task_dir",
            "model",
            "model_path",
        ]
        for key in required:
            value = params.get(key)
            if not isinstance(value, str) or not value:
                raise ValueError(f"transcribe params.{key} must be a non-empty string")
        return cls(
            task_id=str(params["task_id"]),
            file_path=os.path.abspath(str(params["file_path"])),
            source_sha256=str(params["source_sha256"]),
            project_id=str(params["project_id"]),
            transcript_id=str(params["transcript_id"]),
            transcript_path=os.path.abspath(str(params["transcript_path"])),
            task_dir=os.path.abspath(str(params["task_dir"])),
            model=str(params["model"]),
            model_path=os.path.abspath(str(params["model_path"])),
            aligner_model=str(params["aligner_model"]) if params.get("aligner_model") else None,
            aligner_model_path=(
                os.path.abspath(str(params["aligner_model_path"]))
                if params.get("aligner_model_path")
                else None
            ),
            language=str(params.get("language") or "auto"),
            align=bool(params.get("align", False)),
            context=str(params.get("context") or "")[:2000],
            device=str(params.get("device") or "auto"),
            dtype=str(params.get("dtype") or "auto"),
            max_chunk_seconds=max(5, min(120, int(params.get("max_chunk_seconds") or 30))),
            max_new_tokens=max(64, min(8192, int(params.get("max_new_tokens") or 1024))),
            vad=VadConfig.from_value(params.get("vad")),
            resume=bool(params.get("resume", False)),
            keep_temp_files=bool(params.get("keep_temp_files", False)),
        )
