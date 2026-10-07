import asyncio
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch, Mock

import requests

from services.backend_storage import BackendStorage
from services.audio_files import storage_name
from services.storage_manager import StorageManager


class UploadRecoveryTests(unittest.TestCase):
    def test_lost_finalize_response_survives_restart_without_second_put(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"XDG_STATE_HOME": root}):
            file = Path(root) / "audio.m4a"
            file.write_bytes(b"audio")
            recording = SimpleNamespace(id=42, name="Original", duration=7)
            completed = False
            requests_seen = []

            def request(method, path, payload=None):
                nonlocal completed
                if path == "/api/audio/uploads":
                    requests_seen.append(payload.copy())
                    if completed:
                        return {"complete": True, "recording_id": 42}
                    return {"complete": False, "url": "https://objects.example/audio", "headers": {"Content-Type": ["audio/mp4"]}}
                completed = True
                raise requests.ConnectionError("response lost after commit")

            with patch.object(BackendStorage, "_request", side_effect=request), patch("services.backend_storage.requests.put") as put:
                put.return_value = Mock()
                with self.assertRaises(requests.ConnectionError):
                    BackendStorage()._upload(recording, file)
                journals = list((Path(root) / "secretary/audio-uploads").glob("*.json"))
                self.assertEqual(len(journals), 1)
                retained = json.loads(journals[0].read_text())
                recording.name = "Renamed while retrying"
                self.assertTrue(BackendStorage()._upload(recording, file)["success"])
                self.assertEqual(requests_seen, [retained, retained])
                self.assertEqual(put.call_count, 1)
                self.assertTrue(file.exists())
                self.assertFalse(journals[0].exists())

    def test_failed_cloud_delete_keeps_local_audio(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / "recording.m4a"
            file.write_bytes(b"audio")
            recording = SimpleNamespace(id=42, local_audio=str(file), nas_audio=None)
            manager = StorageManager()

            async def denied(_):
                raise RuntimeError("permission denied")

            manager.cloud.delete_audio = denied
            result = asyncio.run(manager.delete_from_all_storage(recording))
            self.assertFalse(result["success"])
            self.assertTrue(file.exists())

    def test_signed_query_does_not_become_local_filename(self):
        name = storage_name(SimpleNamespace(id=42, name="Meeting"), "https://b2.example/audio.m4a?X-Amz-Credential=abc/20261002")
        self.assertEqual(name, "42_Meeting.m4a")


if __name__ == "__main__":
    unittest.main()
