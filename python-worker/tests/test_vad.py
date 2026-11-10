import math
import os
import sys
import tempfile
import threading
import unittest
import wave

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from config import VadConfig
from media.vad import analyze


def write_tone_wav(path: str, segments):
    sample_rate = 16000
    samples = np.zeros(0, dtype=np.float32)
    for duration, amplitude in segments:
        count = int(sample_rate * duration)
        t = np.arange(count) / sample_rate
        tone = (np.sin(2 * math.pi * 220 * t) * amplitude).astype(np.float32)
        samples = np.concatenate([samples, tone])
    pcm = np.clip(samples * 32767, -32768, 32767).astype("<i2")
    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm.tobytes())
    return len(pcm)


class VadTests(unittest.TestCase):
    def test_two_speech_regions_around_a_long_pause(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "tone.wav")
            frames = write_tone_wav(path, [
                (0.5, 0.0),
                (2.0, 0.25),
                (3.0, 0.0),
                (2.0, 0.25),
                (0.5, 0.0),
            ])
            duration_ms = int(frames / 16000 * 1000)
            result = analyze(
                path,
                duration_ms,
                VadConfig(min_silence_ms=300, min_speech_ms=200, padding_ms=80, frame_ms=20),
                max_chunk_seconds=30,
                cancel_event=threading.Event(),
                progress=lambda _value: None,
            )
            self.assertEqual(len(result.chunks), 2, result.chunks)
            self.assertLess(result.chunks[1]["start_ms"], 6_500)
            self.assertGreater(result.chunks[1]["end_ms"], 7_000)
            self.assertGreater(result.chunks[1]["start_ms"] - result.chunks[0]["end_ms"], 2_000)
            self.assertIsNotNone(result.threshold_db)

    def test_silence_falls_back_to_fixed_chunks(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "silence.wav")
            frames = write_tone_wav(path, [(15.0, 0.0)])
            duration_ms = int(frames / 16000 * 1000)
            result = analyze(
                path,
                duration_ms,
                VadConfig(min_silence_ms=300, min_speech_ms=200, padding_ms=80, frame_ms=20),
                max_chunk_seconds=5,
                cancel_event=threading.Event(),
                progress=lambda _value: None,
            )
            self.assertGreaterEqual(len(result.chunks), 2)
            self.assertTrue(result.warnings)


if __name__ == "__main__":
    unittest.main()
