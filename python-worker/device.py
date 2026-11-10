from __future__ import annotations

import platform
from dataclasses import dataclass
from typing import Any, Optional


@dataclass
class DeviceInfo:
    requested: str
    selected: str
    torch_version: Optional[str]
    cuda: bool
    mps: bool
    reason: str
    dtype: str

    def as_dict(self) -> dict:
        return {
            "requested": self.requested,
            "selected": self.selected,
            "torch": self.torch_version,
            "cuda": self.cuda,
            "mps": self.mps,
            "reason": self.reason,
            "dtype": self.dtype,
        }


def detect_device(requested: str = "auto", requested_dtype: str = "auto") -> DeviceInfo:
    try:
        import torch  # noqa: F401
    except Exception as exc:  # pragma: no cover - depends on installation
        return DeviceInfo(
            requested=requested,
            selected="cpu",
            torch_version=None,
            cuda=False,
            mps=False,
            reason=f"PyTorch unavailable: {exc}",
            dtype="float32",
        )

    import torch

    version = getattr(torch, "__version__", None)
    cuda = bool(torch.cuda.is_available())
    mps = bool(getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available())

    selected = "cpu"
    reason = "CPU fallback"
    if requested == "cuda":
        if cuda:
            selected = "cuda"
            reason = "Requested CUDA and it is available"
        else:
            reason = "CUDA requested but unavailable; falling back to CPU"
    elif requested == "mps":
        if mps:
            selected = "mps"
            reason = "Requested MPS and it is available"
        else:
            reason = "MPS requested but unavailable; falling back to CPU"
    elif requested == "cpu":
        selected = "cpu"
        reason = "CPU requested"
    else:
        if cuda:
            selected = "cuda"
            reason = "Auto selected CUDA"
        elif mps:
            selected = "mps"
            reason = "Auto selected Apple Metal (MPS)"
        else:
            reason = "Auto selected CPU"

    dtype = resolve_dtype_name(requested_dtype, selected, cuda)
    return DeviceInfo(
        requested=requested,
        selected=selected,
        torch_version=version,
        cuda=cuda,
        mps=mps,
        reason=f"{reason} on {platform.system()} {platform.machine()}",
        dtype=dtype,
    )


def resolve_dtype_name(requested: str, selected: str, cuda: bool) -> str:
    if requested != "auto":
        return requested
    if selected == "cuda":
        try:
            import torch

            if torch.cuda.is_bf16_supported():
                return "bfloat16"
        except Exception:
            pass
        return "float16"
    if selected == "mps":
        return "float16"
    return "float32"


def torch_dtype(name: str) -> Any:
    import torch

    mapping = {
        "float16": torch.float16,
        "bfloat16": torch.bfloat16,
        "float32": torch.float32,
    }
    return mapping.get(name, torch.float32)


def device_map(selected: str) -> str:
    if selected == "cuda":
        return "cuda:0"
    if selected == "mps":
        return "mps"
    return "cpu"


def empty_cache() -> None:
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
            torch.mps.empty_cache()
    except Exception:
        pass
