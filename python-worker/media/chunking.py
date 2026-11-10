from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List, Optional

import numpy as np


@dataclass
class Region:
    start_ms: int
    end_ms: int


def plan_chunks(
    regions: Iterable[Region],
    duration_ms: int,
    max_chunk_seconds: int,
    frame_db: Optional[np.ndarray] = None,
    frame_ms: int = 20,
    padding_ms: int = 150,
    min_chunk_ms: int = 1500,
) -> List[dict]:
    max_ms = max(5, max_chunk_seconds) * 1000
    raw: List[Region] = []
    for region in regions:
        start = max(0, int(region.start_ms))
        end = min(duration_ms, int(region.end_ms))
        if end - start < min_chunk_ms:
            continue
        cursor = start
        while cursor < end:
            remaining = end - cursor
            if remaining <= max_ms:
                raw.append(Region(cursor, end))
                break
            target = cursor + max_ms
            search_start = cursor + int(max_ms * 0.60)
            split = _lowest_energy_split(frame_db, frame_ms, search_start, target)
            if split is None or split <= cursor + min_chunk_ms or split >= end - min_chunk_ms:
                split = target
            raw.append(Region(cursor, split))
            cursor = split

    padded: List[Region] = []
    for region in raw:
        start = max(0, region.start_ms - padding_ms)
        end = min(duration_ms, region.end_ms + padding_ms)
        padded.append(Region(start, end))

    padded.sort(key=lambda item: (item.start_ms, item.end_ms))
    result: List[Region] = []
    for region in padded:
        if not result:
            result.append(region)
            continue
        previous = result[-1]
        if region.start_ms <= previous.end_ms:
            # Padding may touch; clamp the new start instead of creating overlap.
            region.start_ms = min(previous.end_ms + 1, region.end_ms)
        if region.end_ms - region.start_ms >= min_chunk_ms:
            result.append(region)

    # Trim the previous end when a zero-gap clamp would otherwise overlap.
    for index in range(len(result) - 1):
        if result[index].end_ms > result[index + 1].start_ms:
            result[index].end_ms = result[index + 1].start_ms

    chunks: List[dict] = []
    for index, region in enumerate(result):
        if region.end_ms - region.start_ms < 300:
            continue
        chunks.append({
            "index": len(chunks),
            "start_ms": int(region.start_ms),
            "end_ms": int(region.end_ms),
        })
    return chunks


def validate_chunks(chunks: List[dict], duration_ms: int) -> None:
    previous_end = -1
    for chunk in chunks:
        start = int(chunk["start_ms"])
        end = int(chunk["end_ms"])
        if start < 0 or end > duration_ms or end <= start:
            raise ValueError(f"Invalid chunk range {start}-{end} for duration {duration_ms}")
        if start < previous_end:
            raise ValueError(f"Overlapping chunks at {start} < {previous_end}")
        previous_end = end


def _lowest_energy_split(
    frame_db: Optional[np.ndarray],
    frame_ms: int,
    search_start_ms: int,
    target_ms: int,
) -> Optional[int]:
    if frame_db is None or frame_db.size == 0 or frame_ms <= 0:
        return None
    start_index = max(0, int(search_start_ms / frame_ms))
    end_index = min(frame_db.size, int(target_ms / frame_ms))
    if end_index <= start_index:
        return None
    window = frame_db[start_index:end_index]
    local = int(np.argmin(window))
    return int((start_index + local) * frame_ms)
