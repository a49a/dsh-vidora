from __future__ import annotations

import gc
import importlib.metadata
from typing import List, Optional

import numpy as np

from asr.qwen3 import LANGUAGE_ALIASES
from device import device_map, empty_cache, torch_dtype

SUPPORTED_ALIGN_LANGUAGES = {
    "Chinese", "English", "Cantonese", "French", "German", "Italian",
    "Japanese", "Korean", "Portuguese", "Russian", "Spanish",
}


class AlignmentError(Exception):
    def __init__(self, message: str, code: str = "ALIGNMENT_FAILED"):
        super().__init__(message)
        self.code = code


class Qwen3Aligner:
    def __init__(
        self,
        model_id: str,
        model_path: str,
        device: str,
        dtype_name: str,
    ):
        self.model_id = model_id
        self.model_path = model_path
        self.requested_device = device
        self.requested_dtype = dtype_name
        self.model = None
        self.selected_device = device
        self.selected_dtype = dtype_name
        self.load_warnings: List[str] = []
        self.package_version = _package_version("qwen-asr")

    def load(self) -> None:
        if self.model is not None:
            return
        try:
            from qwen_asr import Qwen3ForcedAligner
        except Exception as exc:
            raise AlignmentError(
                "qwen-asr is not installed; forced alignment is unavailable",
                "ALIGNER_PACKAGE_MISSING",
            ) from exc

        attempts = []
        if self.selected_device != "cpu":
            attempts.append((self.selected_device, self.selected_dtype))
        attempts.append(("cpu", "float32"))
        last_error: Optional[Exception] = None
        for device, dtype_name in attempts:
            try:
                dtype = torch_dtype(dtype_name)
                self.model = Qwen3ForcedAligner.from_pretrained(
                    self.model_path,
                    dtype=dtype,
                    device_map=device_map(device),
                    local_files_only=True,
                )
                self.selected_device = device
                self.selected_dtype = dtype_name
                if device != self.requested_device:
                    self.load_warnings.append(
                        f"Forced aligner fell back to {device} after {self.requested_device} load failed."
                    )
                return
            except Exception as exc:
                last_error = exc
                self.model = None
                empty_cache()
        raise AlignmentError(
            f"Failed to load Qwen3-ForcedAligner from {self.model_path}: {last_error}",
            "ALIGNER_MODEL_LOAD_FAILED",
        )

    def align(
        self,
        audio: np.ndarray,
        sample_rate: int,
        text: str,
        language: str,
    ) -> List[dict]:
        self.load()
        if not text.strip():
            return []
        lang = LANGUAGE_ALIASES.get(language.strip().lower(), language.strip())
        if lang not in SUPPORTED_ALIGN_LANGUAGES:
            raise AlignmentError(
                f"Aligner does not support language {language!r}",
                "ALIGN_LANGUAGE_UNSUPPORTED",
            )
        try:
            results = self.model.align(
                audio=(audio, sample_rate),
                text=text,
                language=lang,
            )
        except Exception as exc:
            raise AlignmentError(
                f"Forced alignment failed: {str(exc)[:500]}",
                "ALIGNMENT_INFERENCE_FAILED",
            ) from exc
        if not results:
            return []
        items = getattr(results[0], "items", results[0])
        output: List[dict] = []
        for item in items:
            try:
                word = str(getattr(item, "text", "") or "")
                start = float(getattr(item, "start_time", 0.0))
                end = float(getattr(item, "end_time", 0.0))
            except Exception:
                continue
            if not word:
                continue
            output.append({
                "text": word,
                "start_ms": int(round(max(0.0, start) * 1000)),
                "end_ms": int(round(max(0.0, end) * 1000)),
            })
        return output

    def unload(self) -> None:
        if self.model is None:
            return
        try:
            del self.model
        except Exception:
            pass
        self.model = None
        gc.collect()
        empty_cache()

    def info(self) -> dict:
        return {
            "id": self.model_id,
            "path": self.model_path,
            "device": self.selected_device,
            "dtype": self.selected_dtype,
            "package_version": self.package_version,
        }


def _package_version(name: str) -> Optional[str]:
    try:
        return importlib.metadata.version(name)
    except Exception:
        return None
