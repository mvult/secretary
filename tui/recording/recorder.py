import asyncio
import logging
import os
import time
import wave
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional

import numpy as np
import pyaudio

from db.service import RecordingService

RATE = 48000
CHUNK = 4096
FORMAT = pyaudio.paInt16
CHANNELS = 3
SAMPLE_WIDTH = 2
MAX_RECORD_HOURS = 3
NAS_CHUNK_SIZE = 1024 * 1024


class AudioRecorder:
    def __init__(self, recordings_dir: str = "recordings", nas_dir: str = "/Volumes/s3/sec-recordings"):
        self.recordings_dir_path = Path(recordings_dir)
        self.recordings_dir_path.mkdir(parents=True, exist_ok=True)

        self.nas_dir = nas_dir
        self.recording = False
        self.stream = None
        self.p = None
        self._pcm_path: Optional[Path] = None
        self._pcm_handle = None
        self.recording_id: Optional[int] = None
        self.start_time: Optional[float] = None
        self.filename: Optional[str] = None
        self.finalize_task: Optional[asyncio.Task] = None

    def generate_filename(self) -> str:
        return f"recording_{datetime.now().strftime('%Y%m%d_%H%M%S')}.wav"

    def find_aggregate_device_index(self) -> int:
        p = pyaudio.PyAudio()
        info = p.get_host_api_info_by_index(0)
        numdevices = info.get("deviceCount")
        aggregate_index = -1
        for i in range(numdevices):
            device_info = p.get_device_info_by_host_api_device_index(0, i)
            if device_info.get("maxInputChannels") > 0 and "Aggregate Device" in device_info.get("name", ""):
                aggregate_index = i
                break
        p.terminate()
        return aggregate_index

    def _open_pcm_file(self, basename: str) -> Path:
        spool_dir = self.recordings_dir_path / "__spool__"
        spool_dir.mkdir(parents=True, exist_ok=True)
        pcm_path = spool_dir / f"{basename}.pcm"
        self._pcm_handle = open(pcm_path, "wb")
        return pcm_path

    async def start_recording(self, name: str = None) -> Optional[int]:
        if self.recording:
            return None

        aggregate_device_index = self.find_aggregate_device_index()
        if aggregate_device_index == -1:
            raise Exception("Aggregate Device not found")

        self.filename = self.generate_filename()
        basename = Path(self.filename).stem
        combined_path = str(self.recordings_dir_path / self.filename)

        if not name:
            name = f"Recording {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"

        recording = await RecordingService.create_recording(name=name, local_audio_path=combined_path)
        if not recording:
            raise Exception("Failed to create database entry")

        self.recording_id = recording.id
        self.p = pyaudio.PyAudio()
        self.recording = True
        self.start_time = time.time()
        self.finalize_task = None

        self._pcm_path = self._open_pcm_file(basename)

        try:
            self.stream = self.p.open(
                format=FORMAT,
                channels=CHANNELS,
                rate=RATE,
                input=True,
                frames_per_buffer=CHUNK,
                input_device_index=aggregate_device_index,
            )
        except Exception as e:
            self.cleanup()
            raise Exception(f"Error opening audio stream: {e}") from e

        return self.recording_id

    def record_chunk(self) -> bool:
        if not self.recording or not self.stream:
            return False

        if self.start_time and time.time() - self.start_time >= MAX_RECORD_HOURS * 3600:
            logging.warning("Maximum recording duration reached; stopping.")
            return False

        try:
            data = self.stream.read(CHUNK, exception_on_overflow=True)
        except Exception as exc:
            logging.error("Error recording chunk: %s", exc, exc_info=True)
            return False

        try:
            if self._pcm_handle:
                self._pcm_handle.write(data)
        except Exception as exc:
            logging.error("Error writing audio chunk: %s", exc, exc_info=True)
            return False

        return True

    async def stop_recording(self) -> bool:
        if not self.recording:
            return False

        self.recording = False

        if self.stream:
            try:
                self.stream.stop_stream()
                self.stream.close()
            except Exception:
                logging.debug("Stream cleanup error", exc_info=True)
            self.stream = None

        if self.p:
            try:
                self.p.terminate()
            except Exception:
                logging.debug("PyAudio terminate error", exc_info=True)
            self.p = None

        pcm_path = self._pcm_path
        if pcm_path and self._pcm_handle:
            self._pcm_handle.flush()
            os.fsync(self._pcm_handle.fileno())
            self._pcm_handle.close()
            self._pcm_handle = None
            self._pcm_path = None

        duration_seconds = int(time.time() - self.start_time) if self.start_time else None
        record_id = self.recording_id
        filename = self.filename

        self.cleanup(keep_file=True)

        if not pcm_path or not filename:
            if pcm_path:
                try:
                    pcm_path.unlink()
                except FileNotFoundError:
                    pass
            return False

        self.finalize_task = asyncio.create_task(
            self._finalize_recording(
                pcm_path=pcm_path,
                filename=filename,
                record_id=record_id,
                duration_seconds=duration_seconds,
            )
        )

        return True

    async def _finalize_recording(
        self,
        *,
        pcm_path: Path,
        filename: str,
        record_id: Optional[int],
        duration_seconds: Optional[int],
    ) -> Dict[str, Optional[str]]:
        wav_path = self.recordings_dir_path / filename

        try:
            await asyncio.to_thread(self._convert_pcm_to_wav, pcm_path, wav_path)
        except Exception as exc:
            logging.exception("Error saving recording %s: %s", filename, exc)
            result = {"local": False, "nas": False, "local_path": None, "nas_path": None}
        else:
            result = {"local": True, "nas": False, "local_path": str(wav_path), "nas_path": None}
            if record_id and duration_seconds is not None:
                await RecordingService.update_recording(
                    record_id,
                    duration=duration_seconds,
                    local_audio=str(wav_path),
                )

        try:
            pcm_path.unlink()
        except FileNotFoundError:
            pass
        except OSError as exc:
            logging.warning("Unable to delete temp file %s: %s", pcm_path, exc)

        if result["local_path"]:
            nas_path = await asyncio.to_thread(self._try_copy_to_nas, result["local_path"])
            if nas_path and record_id:
                await RecordingService.update_recording(record_id, nas_audio=nas_path)
                result["nas"] = True
                result["nas_path"] = nas_path

        return result

    def _convert_pcm_to_wav(self, pcm_path: Path, wav_path: Path) -> None:
        frame_stride = CHANNELS * SAMPLE_WIDTH
        buffer_size = CHUNK * frame_stride

        with open(pcm_path, "rb") as pcm_file, wave.open(str(wav_path), "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(SAMPLE_WIDTH)
            wav_file.setframerate(RATE)

            while True:
                raw = pcm_file.read(buffer_size)
                if not raw:
                    break
                samples = np.frombuffer(raw, dtype=np.int16)
                if CHANNELS > 1:
                    usable = (samples.size // CHANNELS) * CHANNELS
                    if usable == 0:
                        continue
                    samples = samples[:usable]
                    samples = samples.reshape(-1, CHANNELS)
                    mono = samples.mean(axis=1)
                else:
                    mono = samples
                mono_clipped = np.clip(mono, np.iinfo(np.int16).min, np.iinfo(np.int16).max).astype(np.int16)
                wav_file.writeframes(mono_clipped.tobytes())

    def _try_copy_to_nas(self, local_path: str) -> Optional[str]:
        if not self.nas_dir:
            return None

        try:
            os.makedirs(self.nas_dir, exist_ok=True)
        except Exception as exc:
            logging.warning("Failed to ensure NAS directory: %s", exc)
            return None

        if not os.path.isdir(self.nas_dir):
            logging.warning("NAS directory not available: %s", self.nas_dir)
            return None

        target_path = os.path.join(self.nas_dir, os.path.basename(local_path))

        try:
            with open(local_path, "rb") as src, open(target_path, "wb") as dst:
                while chunk := src.read(NAS_CHUNK_SIZE):
                    dst.write(chunk)
        except Exception as exc:
            logging.warning("Error copying to NAS: %s", exc)
            return None

        logging.info("Copied recording to NAS: %s", target_path)
        return target_path

    def cleanup(self, *, keep_file: bool = False) -> None:
        if self._pcm_handle:
            try:
                self._pcm_handle.close()
            except Exception:
                logging.debug("PCM handle close error", exc_info=True)
            self._pcm_handle = None

        if self.stream:
            try:
                self.stream.stop_stream()
                self.stream.close()
            except Exception:
                logging.debug("Stream cleanup error", exc_info=True)
            self.stream = None

        if self.p:
            try:
                self.p.terminate()
            except Exception:
                logging.debug("PyAudio terminate error", exc_info=True)
            self.p = None

        self.recording = False
        self.recording_id = None
        self.start_time = None
        self.filename = None

        if not keep_file and self._pcm_path:
            try:
                self._pcm_path.unlink()
            except FileNotFoundError:
                pass
            except OSError as exc:
                logging.warning("Unable to delete temp file %s: %s", self._pcm_path, exc)
            self._pcm_path = None

    def is_recording(self) -> bool:
        return self.recording

    def get_recording_duration(self) -> float:
        if not self.recording or not self.start_time:
            return 0.0
        return time.time() - self.start_time
