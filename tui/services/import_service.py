import asyncio
import logging
import shutil
from datetime import datetime
from pathlib import Path
from typing import Dict

from db.service import RecordingService
from services.audio_files import (
    AudioConversionError,
    canonical_audio_path,
    convert_audio_file_to_m4a,
    get_audio_duration_seconds,
)


class RecordingImporter:
    """Handle importing existing audio files into the local recordings store."""

    def __init__(self, recordings_dir: str = "recordings"):
        self.recordings_dir = Path(recordings_dir)
        self.recordings_dir.mkdir(parents=True, exist_ok=True)

    async def import_file(self, source_path: str) -> Dict[str, object]:
        """Import the given file, keeping recordings in compressed m4a."""
        try:
            source = Path(source_path).expanduser().resolve()
        except FileNotFoundError:
            return {"success": False, "error": "File not found"}
        except Exception as exc:
            logging.error("Invalid import path %s: %s", source_path, exc)
            return {"success": False, "error": "Invalid file path"}

        if not source.exists() or not source.is_file():
            return {"success": False, "error": "File not found"}

        extension = source.suffix.lower()
        if extension not in {".wav", ".m4a", ".mp4"}:
            return {"success": False, "error": "Only wav, m4a, and mp4 files are supported"}

        final_name = source.name if extension == ".m4a" else f"{source.stem}.m4a"
        destination = self.recordings_dir / final_name
        if destination.exists():
            timestamp = datetime.now().strftime("imported_%Y%m%d_%H%M%S")
            destination = self.recordings_dir / f"{timestamp}{destination.suffix.lower()}"

        try:
            if extension == ".m4a":
                await asyncio.to_thread(shutil.copy2, source, destination)
            else:
                await asyncio.to_thread(convert_audio_file_to_m4a, source, canonical_audio_path(destination))
                destination = canonical_audio_path(destination)
        except AudioConversionError as exc:
            return {"success": False, "error": str(exc)}
        except Exception as exc:
            logging.error("Failed importing %s: %s", source, exc, exc_info=True)
            return {"success": False, "error": "Failed to copy audio"}

        duration = await asyncio.to_thread(get_audio_duration_seconds, destination)
        recording_name = destination.stem

        recording = await RecordingService.create_recording(
            name=recording_name,
            local_audio_path=str(destination),
            duration=duration,
        )

        if not recording:
            return {"success": False, "error": "Database insert failed"}

        return {
            "success": True,
            "recording_id": recording.id,
            "path": str(destination),
            "duration": duration,
        }
