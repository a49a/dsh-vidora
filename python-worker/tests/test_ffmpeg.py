import math
import os
import shutil
import sys
import tempfile
import threading
import unittest
import wave

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from media import ffmpeg


def write_wav(path: str, seconds: float = 1.0):
    sample_rate = 44100
    t = np.arange(int(sample_rate * seconds)) / sample_rate
    samples = (np.sin(2 * math.pi * 440 * t) * 0.2 * 32767).astype("<i2")
    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(samples.tobytes())


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg required")
class FfmpegTests(unittest.TestCase):
    def test_probe_and_decode(self):
        with tempfile.TemporaryDirectory() as directory:
            source = os.path.join(directory, "source.wav")
            target = os.path.join(directory, "decoded.wav")
            write_wav(source)
            probe = ffmpeg.probe_media(source)
            self.assertGreater(probe.duration_ms, 900)
            self.assertGreater(probe.sample_rate, 0)
            progress = []
            decoded = ffmpeg.decode_audio(
                source,
                target,
                probe.duration_ms,
                threading.Event(),
                progress.append,
                timeout_seconds=30,
            )
            self.assertGreater(decoded, 900)
            info = ffmpeg.wav_info(target)
            self.assertEqual(info["sample_rate"], 16000)
            self.assertEqual(info["channels"], 1)
            self.assertTrue(progress)


if __name__ == "__main__":
    unittest.main()
