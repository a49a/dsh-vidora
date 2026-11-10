import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from protocol import WorkerError, parse_request


class ProtocolTests(unittest.TestCase):
    def test_parse_request(self):
        request = parse_request(json.dumps({
            "protocol_version": 1,
            "request_id": "req-1",
            "method": "asr.transcribe",
            "params": {"task_id": "task-1"},
        }))
        self.assertEqual(request.request_id, "req-1")
        self.assertEqual(request.method, "asr.transcribe")
        self.assertEqual(request.params["task_id"], "task-1")

    def test_rejects_wrong_protocol(self):
        with self.assertRaises(WorkerError) as context:
            parse_request(json.dumps({
                "protocol_version": 2,
                "request_id": "req-1",
                "method": "worker.get_status",
            }))
        self.assertEqual(context.exception.code, "PROTOCOL_VERSION_MISMATCH")

    def test_rejects_invalid_json(self):
        with self.assertRaises(WorkerError) as context:
            parse_request("{")
        self.assertEqual(context.exception.code, "INVALID_JSON")


if __name__ == "__main__":
    unittest.main()
