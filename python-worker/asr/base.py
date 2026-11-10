from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

import numpy as np


@dataclass
class ASRResult:
    text: str
    language: str
    warnings: List[str] = field(default_factory=list)


class ASRBackend:
    def load(self) -> None:
        raise NotImplementedError

    def transcribe(
        self,
        audio: np.ndarray,
        sample_rate: int,
        language: Optional[str],
        context: str,
    ) -> ASRResult:
        raise NotImplementedError

    def unload(self) -> None:
        raise NotImplementedError

    def info(self) -> dict:
        raise NotImplementedError


class ASRError(Exception):
    def __init__(self, message: str, code: str = "ASR_FAILED", details=None):
        super().__init__(message)
        self.code = code
        self.details = details
