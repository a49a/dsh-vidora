from __future__ import annotations

import gc
import importlib.metadata
from typing import Optional

import numpy as np

from asr.base import ASRBackend, ASRError, ASRResult
from device import device_map, empty_cache, resolve_dtype_name, torch_dtype

LANGUAGE_ALIASES = {
    "zh": "Chinese",
    "zh-cn": "Chinese",
    "zh_cn": "Chinese",
    "chinese": "Chinese",
    "en": "English",
    "en-us": "English",
    "en_us": "English",
    "english": "English",
    "yue": "Cantonese",
    "cantonese": "Cantonese",
    "ja": "Japanese",
    "japanese": "Japanese",
    "ko": "Korean",
    "korean": "Korean",
    "fr": "French",
    "french": "French",
    "de": "German",
    "german": "German",
    "es": "Spanish",
    "spanish": "Spanish",
}


class Qwen3ASRBackend(ASRBackend):
    def __init__(
        self,
        model_id: str,
        model_path: str,
        repo: Optional[str],
        device: str,
        dtype_name: str,
        max_new_tokens: int,
    ):
        self.model_id = model_id
        self.model_path = model_path
        self.repo = repo
        self.requested_device = device
        self.requested_dtype = dtype_name
        self.max_new_tokens = max_new_tokens
        self.model = None
        self.selected_device = device
        self.selected_dtype = dtype_name
        self.load_warnings: list[str] = []
        self.package_version = _package_version("qwen-asr")

    def load(self) -> None:
        if self.model is not None:
            return
        try:
            from qwen_asr import Qwen3ASRModel
        except Exception as exc:
            raise ASRError(
                "qwen-asr is not installed in the worker virtual environment. "
                "Run: node scripts/install-worker.mjs --yes",
                "ASR_PACKAGE_MISSING",
                details={"error": str(exc)},
            ) from exc

        attempts = []
        if self.selected_device != "cpu":
            attempts.append((self.selected_device, self.selected_dtype))
        attempts.append(("cpu", "float32"))
        last_error: Optional[Exception] = None
        for device, dtype_name in attempts:
            try:
                dtype = torch_dtype(dtype_name)
                self.model = Qwen3ASRModel.from_pretrained(
                    self.model_path,
                    dtype=dtype,
                    device_map=device_map(device),
                    max_inference_batch_size=1,
                    max_new_tokens=self.max_new_tokens,
                    local_files_only=True,
                )
                self.selected_device = device
                self.selected_dtype = dtype_name
                if device != self.requested_device:
                    self.load_warnings.append(
                        f"ASR fell back to {device} after {self.requested_device} load failed."
                    )
                return
            except Exception as exc:
                last_error = exc
                self.model = None
                empty_cache()
        raise ASRError(
            f"Failed to load Qwen3-ASR from {self.model_path}: {last_error}",
            "ASR_MODEL_LOAD_FAILED",
            details={"model_path": self.model_path},
        )

    def transcribe(
        self,
        audio: np.ndarray,
        sample_rate: int,
        language: Optional[str],
        context: str,
    ) -> ASRResult:
        self.load()
        lang = normalize_language(language)
        try:
            results = self.model.transcribe(
                audio=(audio, sample_rate),
                context=context or "",
                language=lang,
                return_time_stamps=False,
            )
        except Exception as exc:
            name = type(exc).__name__
            message = str(exc)
            if "out of memory" in message.lower() or "OutOfMemory" in name:
                raise ASRError(
                    f"ASR ran out of memory on {self.selected_device}. Try device=cpu, a smaller chunk, or the 0.6B model.",
                    "ASR_OUT_OF_MEMORY",
                ) from exc
            raise ASRError(
                f"Qwen3-ASR inference failed on {self.selected_device}: {message[:600]}",
                "ASR_INFERENCE_FAILED",
            ) from exc
        if not results:
            return ASRResult(text="", language="", warnings=["ASR returned no result."])
        result = results[0]
        text = str(getattr(result, "text", "") or "").strip()
        detected = str(getattr(result, "language", "") or "").strip()
        return ASRResult(text=text, language=detected)

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
            "repo": self.repo,
            "backend": "transformers",
            "device": self.selected_device,
            "dtype": self.selected_dtype,
            "package_version": self.package_version,
            "max_new_tokens": self.max_new_tokens,
        }


def normalize_language(language: Optional[str]) -> Optional[str]:
    if not language:
        return None
    value = language.strip()
    if not value or value.lower() in ("auto", "none", "null"):
        return None
    return LANGUAGE_ALIASES.get(value.lower(), value)


def language_code(language: str, forced: Optional[str]) -> str:
    forced_code = (forced or "").strip().lower()
    if forced_code and forced_code not in ("auto", "none", "null"):
        mapping = {"chinese": "zh", "english": "en", "cantonese": "yue", "japanese": "ja", "korean": "ko"}
        return mapping.get(forced_code, forced_code)
    value = (language or "").strip()
    lowered = value.lower()
    if not value:
        return "unknown"
    has_chinese = "chinese" in lowered
    has_english = "english" in lowered
    if has_chinese and has_english:
        return "zh-en"
    if has_chinese:
        return "zh"
    if has_english:
        return "en"
    if "cantonese" in lowered:
        return "yue"
    first = value.split(",")[0].strip()
    mapping = {
        "japanese": "ja",
        "korean": "ko",
        "french": "fr",
        "german": "de",
        "spanish": "es",
        "russian": "ru",
        "italian": "it",
        "portuguese": "pt",
        "arabic": "ar",
    }
    return mapping.get(first.lower(), first.lower())


def resolve_runtime_dtype(requested: str, device: str) -> str:
    return resolve_dtype_name(requested, device, device == "cuda")


def _package_version(name: str) -> Optional[str]:
    try:
        return importlib.metadata.version(name)
    except Exception:
        return None
