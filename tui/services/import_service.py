import asyncio
import logging
import shutil
import subprocess
import wave
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional

from db.service import RecordingService


class RecordingImporter:
    """Handle importing existing audio files into the local recordings store."""

    def __init__(self, recordings_dir: str = "recordings"):
        self.recordings_dir = Path(recordings_dir)
        self.recordings_dir.mkdir(parents=True, exist_ok=True)

    async def import_file(self, source_path: str) -> Dict[str, object]:
        """Import the given file, converting to wav when needed."""
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
        if extension not in {".wav", ".m4a"}:
            return {"success": False, "error": "Only wav and m4a files are supported"}

        final_name = source.name if extension == ".wav" else f"{source.stem}.wav"
        destination = self.recordings_dir / final_name
        if destination.exists():
            timestamp = datetime.now().strftime("imported_%Y%m%d_%H%M%S")
            destination = self.recordings_dir / f"{timestamp}.wav"

        try:
            if extension == ".wav":
                await asyncio.to_thread(shutil.copy2, source, destination)
            else:
                await asyncio.to_thread(self._convert_m4a_to_wav, source, destination)
        except RuntimeError as exc:
            return {"success": False, "error": str(exc)}
        except Exception as exc:
            logging.error("Failed importing %s: %s", source, exc, exc_info=True)
            return {"success": False, "error": "Failed to copy audio"}

        duration = await asyncio.to_thread(self._get_wav_duration, destination)
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

    def _convert_m4a_to_wav(self, source: Path, destination: Path) -> None:
        ffmpeg_path = shutil.which("ffmpeg")
        if not ffmpeg_path:
            raise RuntimeError("ffmpeg is required to convert m4a files")

        command = [
            ffmpeg_path,
            "-y",
            "-i",
            str(source),
            str(destination),
        ]

        try:
            subprocess.run(
                command,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
        except subprocess.CalledProcessError as exc:
            logging.error("ffmpeg conversion failed for %s: %s", source, exc.stderr)
            raise RuntimeError("Failed converting m4a to wav") from exc

    def _get_wav_duration(self, wav_path: Path) -> Optional[int]:
        try:
            with wave.open(str(wav_path), "rb") as handle:
                frames = handle.getnframes()
                rate = handle.getframerate()
                if rate:
                    return int(frames / float(rate))
        except Exception as exc:
            logging.warning("Unable to read duration for %s: %s", wav_path, exc)
        return None
