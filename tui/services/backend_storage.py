"""Backend-authorized storage. Clients never receive B2 credentials."""
import asyncio
import fcntl
import hashlib
import json
import os
from pathlib import Path
import uuid

import requests

from services.audio_files import content_type_for_audio


class BackendStorageError(RuntimeError):
    def __init__(self, response):
        self.status = response.status_code
        super().__init__(f"Backend storage: {response.status_code} {response.text[:500]}")


class BackendStorage:
    def __init__(self):
        self.base = os.getenv("SECRETARY_BACKEND_URL", "http://localhost:8091").rstrip("/")
        self.token = os.getenv("SECRETARY_API_TOKEN", "")

    def _login(self):
        email = os.getenv("SECRETARY_EMAIL")
        password = os.getenv("SECRETARY_PASSWORD")
        if not email or not password:
            raise RuntimeError("Set SECRETARY_API_TOKEN or SECRETARY_EMAIL/SECRETARY_PASSWORD for backend storage")
        response = requests.post(f"{self.base}/api/login", json={"email": email, "password": password}, timeout=30)
        response.raise_for_status()
        self.token = response.json()["token"]

    def _request(self, method, path, payload=None):
        if not self.token:
            self._login()
        response = requests.request(method, self.base + path, json=payload,
                                    headers={"Authorization": f"Bearer {self.token}"}, timeout=60)
        if response.status_code == 401 and os.getenv("SECRETARY_EMAIL"):
            self._login()
            response = requests.request(method, self.base + path, json=payload,
                                        headers={"Authorization": f"Bearer {self.token}"}, timeout=60)
        if not response.ok:
            raise BackendStorageError(response)
        return response.json()

    async def download_url(self, recording_id):
        result = await asyncio.to_thread(self._request, "GET", f"/api/recordings/{recording_id}/audio")
        return result["url"]

    async def delete_audio(self, recording_id):
        return await asyncio.to_thread(self._request, "DELETE", f"/api/recordings/{recording_id}/audio")

    async def delete_recording(self, recording_id):
        return await asyncio.to_thread(self._request, "POST", "/secretary.v1.RecordingsService/DeleteRecording", {"id": str(recording_id)})

    def _upload(self, recording, path):
        # The journal survives a lost PUT/finalize response and process restarts.
        # Metadata remains frozen until the same upload has been acknowledged.
        with open(path, "rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        journal_key = hashlib.sha256(f"{self.base}:{recording.id}:{digest}".encode()).hexdigest()
        directory = Path(os.getenv("XDG_STATE_HOME", str(Path.home() / ".local/state"))) / "secretary/audio-uploads"
        directory.mkdir(parents=True, exist_ok=True)
        journal = directory / f"{journal_key}.json"
        with journal.with_suffix(".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            return self._upload_locked(recording, path, journal)

    def _upload_locked(self, recording, path, journal):
        if journal.exists():
            payload = json.loads(journal.read_text())
        else:
            payload = {"id": str(uuid.uuid4()), "recording_id": recording.id, "name": recording.name,
                       "duration": recording.duration or 0, "size_bytes": os.path.getsize(path),
                       "content_type": content_type_for_audio(path)}
            temporary = journal.with_suffix(".tmp")
            with temporary.open("w") as stream:
                json.dump(payload, stream)
                stream.flush()
                os.fsync(stream.fileno())
            temporary.replace(journal)
        try:
            ticket = self._request("POST", "/api/audio/uploads", payload)
        except BackendStorageError as error:
            if error.status == 410:
                journal.unlink(missing_ok=True)
                raise RuntimeError("Previous upload was deleted. Retry to start a new upload.") from error
            raise
        if not ticket["complete"]:
            headers = {key: ", ".join(values) for key, values in ticket["headers"].items()}
            with open(path, "rb") as source:
                response = requests.put(ticket["url"], data=source, headers=headers, timeout=(30, 1800))
            response.raise_for_status()
            ticket = self._request("POST", f"/api/audio/uploads/{payload['id']}/complete", {})
        if not ticket.get("complete") or ticket.get("recording_id") != recording.id:
            raise RuntimeError("Unexpected upload receipt; retained for retry")
        journal.unlink(missing_ok=True)
        return {"success": True, "action": "uploaded", "message": "Uploaded to B2"}

    async def upload(self, recording, path):
        return await asyncio.to_thread(self._upload, recording, path)
