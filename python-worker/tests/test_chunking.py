import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from media.chunking import Region, plan_chunks, validate_chunks


class ChunkingTests(unittest.TestCase):
    def test_long_region_is_split_without_gaps_or_overlap(self):
        frame_ms = 20
        frame_db = np.full(int(100_000 / frame_ms), -20.0, dtype=np.float32)
        frame_db[::50] = -45.0
        chunks = plan_chunks(
            [Region(0, 100_000)],
            duration_ms=100_000,
            max_chunk_seconds=30,
            frame_db=frame_db,
            frame_ms=frame_ms,
            padding_ms=50,
        )
        self.assertGreaterEqual(len(chunks), 4)
        validate_chunks(chunks, 100_000)
        self.assertEqual(chunks[0]["start_ms"], 0)
        self.assertEqual(chunks[-1]["end_ms"], 100_000)
        for previous, current in zip(chunks, chunks[1:]):
            self.assertLessEqual(previous["end_ms"], current["start_ms"])
        self.assertTrue(all(chunk["end_ms"] - chunk["start_ms"] <= 30_500 for chunk in chunks))

    def test_short_regions_are_preserved_with_padding(self):
        chunks = plan_chunks(
            [Region(1_000, 3_000), Region(5_000, 7_000)],
            duration_ms=10_000,
            max_chunk_seconds=30,
            padding_ms=150,
        )
        self.assertEqual(len(chunks), 2)
        self.assertEqual(chunks[0]["start_ms"], 850)
        self.assertEqual(chunks[1]["start_ms"], 4_850)
        validate_chunks(chunks, 10_000)

    def test_overlapping_padding_is_clamped(self):
        chunks = plan_chunks(
            [Region(1_000, 3_000), Region(3_100, 5_000)],
            duration_ms=10_000,
            max_chunk_seconds=30,
            padding_ms=300,
        )
        validate_chunks(chunks, 10_000)
        self.assertLessEqual(chunks[0]["end_ms"], chunks[1]["start_ms"])


if __name__ == "__main__":
    unittest.main()
