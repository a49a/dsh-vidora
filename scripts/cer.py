#!/usr/bin/env python3
"""Compute CER against a known reference text, with an explicit normalization.

This is a measurement helper, not a claim of model accuracy. The reference is
the exact text spoken by the TTS fixture; punctuation and section headers are
normalized away.
"""

from __future__ import annotations

import argparse
import json
import re
import unicodedata


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"第[一二三四五六七八九十百零〇\d]+部分", "", text)
    text = re.sub(r"第[一二三四五六七八九十百零〇\d]+章", "", text)
    text = text.lower()
    text = re.sub(r"\[[^\]]*\]", "", text)
    text = re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", text)
    return text


def edit_distance(reference: str, hypothesis: str):
    n = len(reference)
    m = len(hypothesis)
    previous = list(range(m + 1))
    for i in range(1, n + 1):
        current = [i] + [0] * m
        for j in range(1, m + 1):
            cost = 0 if reference[i - 1] == hypothesis[j - 1] else 1
            current[j] = min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + cost,
            )
        previous = current
    return previous[m]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference", required=True)
    parser.add_argument("--transcript", required=True)
    args = parser.parse_args()
    with open(args.reference, "r", encoding="utf-8") as handle:
        reference = normalize(handle.read())
    with open(args.transcript, "r", encoding="utf-8") as handle:
        transcript = json.load(handle)
    hypothesis = normalize("".join(segment.get("text", "") for segment in transcript.get("segments", [])))
    distance = edit_distance(reference, hypothesis)
    cer = distance / len(reference) if reference else 0.0
    print(json.dumps({
        "reference_chars": len(reference),
        "hypothesis_chars": len(hypothesis),
        "edit_distance": distance,
        "cer": round(cer, 6),
        "wer_char_level": round(cer, 6),
        "transcript_id": transcript.get("id"),
        "segment_count": len(transcript.get("segments", [])),
        "model": transcript.get("model"),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
