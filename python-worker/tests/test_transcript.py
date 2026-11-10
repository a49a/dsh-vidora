import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from config import TranscribeConfig, VadConfig
from tasks import (
    TaskRecord,
    build_transcript,
    checkpoint_signature,
    finalize_segments,
    write_json_atomic,
)


def make_task(work_dir: str) -> TaskRecord:
    params = TranscribeConfig(
        task_id="task-1",
        file_path="/tmp/lecture.mp4",
        source_sha256="a" * 64,
        project_id="prj-1",
        transcript_id="tr-1",
        transcript_path=os.path.join(work_dir, "transcript.json"),
        task_dir=work_dir,
        model="qwen3-asr-0.6b",
        model_path="/models/qwen",
        aligner_model="qwen3-forced-aligner-0.6b",
        aligner_model_path="/models/aligner",
        language="auto",
        align=True,
        context="操作系统课程",
        device="cpu",
        dtype="float32",
        max_chunk_seconds=30,
        max_new_tokens=512,
        vad=VadConfig(),
        resume=False,
        keep_temp_files=False,
    )
    return TaskRecord(task_id="task-1", request_id="req-1", params=params)


class TranscriptBuilderTests(unittest.TestCase):
    def test_build_and_write_transcript(self):
        with tempfile.TemporaryDirectory() as directory:
            task = make_task(directory)
            segments = finalize_segments([
                {
                    "id": "seg-000001",
                    "start_ms": 1000,
                    "end_ms": 3000,
                    "text": "第一段。",
                    "speaker_id": None,
                    "timing_status": "chunk",
                    "_language": "Chinese",
                },
                {
                    "id": "seg-000002",
                    "start_ms": 3000,
                    "end_ms": 5000,
                    "text": "第一段。",
                    "speaker_id": None,
                    "timing_status": "chunk",
                    "_language": "Chinese",
                },
                {
                    "id": "seg-000003",
                    "start_ms": 6000,
                    "end_ms": 8000,
                    "text": "第二段。",
                    "speaker_id": None,
                    "timing_status": "aligned",
                    "_language": "Chinese",
                    "words": [{"text": "第二段", "start_ms": 6000, "end_ms": 8000}],
                },
            ])
            # Exact adjacent duplicate at a chunk boundary is removed.
            self.assertEqual(len(segments), 2)
            transcript = build_transcript(
                task=task,
                probe={"duration_ms": 10_000, "container": "mov,mp4", "audio_codec": "aac", "sample_rate": 44100, "channels": 2},
                duration_ms=10_000,
                file_size=1234,
                chunks=[{"start_ms": 500, "end_ms": 3000}, {"start_ms": 6000, "end_ms": 8000}],
                segments=segments,
                asr_info={"device": "cpu", "dtype": "float32", "package_version": "0.0.6"},
                language="zh",
                warnings=["test warning"],
                processing_ms=5000,
                peak_memory_mb=100.0,
                total_chunks=2,
                aligner_used=True,
            )
            self.assertEqual(transcript["version"], 1)
            self.assertEqual(transcript["language"], "zh")
            self.assertEqual(transcript["stats"]["segment_count"], 2)
            self.assertEqual(transcript["stats"]["speech_duration_ms"], 4500)
            self.assertEqual(transcript["params"]["align"], True)
            self.assertTrue(all(not key.startswith("_") for segment in transcript["segments"] for key in segment))
            path = os.path.join(directory, "transcript.json")
            write_json_atomic(path, transcript)
            with open(path, "r", encoding="utf-8") as handle:
                parsed = json.load(handle)
            self.assertEqual(parsed["id"], "tr-1")

    def test_checkpoint_signature_is_stable(self):
        with tempfile.TemporaryDirectory() as directory:
            task = make_task(directory)
            self.assertEqual(checkpoint_signature(task), checkpoint_signature(task))
            task.params.language = "zh"
            self.assertNotEqual(checkpoint_signature(task)["language"], "auto")


if __name__ == "__main__":
    unittest.main()
