import mimetypes
import shutil
import subprocess
from pathlib import Path
from typing import Optional


AAC_BITRATE = "64k"
CANONICAL_AUDIO_SUFFIX = ".m4a"


class AudioConversionError(RuntimeError):
    pass


def ffmpeg_path() -> str:
    path = shutil.which("ffmpeg")
    if not path:
        raise AudioConversionError("ffmpeg is required for audio conversion")
    return path


def ffprobe_path() -> str:
    path = shutil.which("ffprobe")
    if not path:
        raise AudioConversionError("ffprobe is required to inspect audio files")
    return path


def canonical_audio_path(path: Path) -> Path:
    return path.with_suffix(CANONICAL_AUDIO_SUFFIX)


def content_type_for_audio(path: str) -> str:
    suffix = Path(path).suffix.lower()
    if suffix == ".wav":
        return "audio/wav"
    if suffix in {".m4a", ".mp4"}:
        return "audio/mp4"

    guessed, _ = mimetypes.guess_type(path)
    return guessed or "application/octet-stream"


def storage_name(recording, source_path: Optional[str] = None) -> str:
    suffix = Path(source_path or "").suffix.lower() or CANONICAL_AUDIO_SUFFIX
    safe_name = "_".join(str(recording.name).split())
    return f"{recording.id}_{safe_name}{suffix}"


def get_audio_duration_seconds(path: Path) -> Optional[int]:
    command = [
        ffprobe_path(),
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    try:
        result = subprocess.run(
            command,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        value = result.stdout.strip()
        if not value:
            return None
        return int(float(value))
    except Exception:
        return None


def convert_audio_file_to_m4a(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    command = [
        ffmpeg_path(),
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-vn",
        "-ac",
        "1",
        "-c:a",
        "aac",
        "-b:a",
        AAC_BITRATE,
        "-movflags",
        "+faststart",
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
        raise AudioConversionError(f"ffmpeg conversion failed: {exc.stderr.decode(errors='ignore')}") from exc
