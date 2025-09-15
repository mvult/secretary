import pyaudio
import wave
import time
import signal
import sys
import numpy as np
from datetime import datetime
from typing import Optional, Callable
import os
from db.service import RecordingService
from recording.audio_saver import analyze_and_save, compute_channel_diagnostics

# Audio recording settings
RATE = 48000  # Updated to match device capabilities
CHUNK = 4096  # Increased buffer size to reduce potential underruns
FORMAT = pyaudio.paInt16
CHANNELS = 3  # Updated for 3-channel aggregate device
MAX_RECORD_HOURS = 3


class AudioRecorder:
    def __init__(self, recordings_dir: str = "recordings", nas_dir: str = "/Volumes/s3/sec-recordings"):
        self.recordings_dir = recordings_dir
        self.nas_dir = nas_dir
        self.recording = False
        self.stream = None
        self.p = None
        self.frames = []
        self.recording_id = None
        self.start_time = None
        self.filename = None

        # Ensure recordings directories exist
        os.makedirs(self.recordings_dir, exist_ok=True)
        os.makedirs(self.nas_dir, exist_ok=True)

    def generate_filename(self) -> str:
        """Generate a timestamped filename"""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        return f"recording_{timestamp}.wav"

    def get_device_params(self, idx: int) -> dict:
        """Get device parameters for debugging"""
        p = pyaudio.PyAudio()
        info = p.get_device_info_by_host_api_device_index(0, idx)
        p.terminate()
        return {
            "name": info.get("name"),
            "channels_in": info.get("maxInputChannels"),
            "default_rate": int(info.get("defaultSampleRate")),
        }

    def find_aggregate_device_index(self) -> int:
        """Find the aggregate device index"""
        p = pyaudio.PyAudio()
        info = p.get_host_api_info_by_index(0)
        numdevices = info.get("deviceCount")
        aggregate_index = -1

        for i in range(0, numdevices):
            device_info = p.get_device_info_by_host_api_device_index(0, i)
            if device_info.get("maxInputChannels") > 0:
                device_name = device_info.get("name")
                if "Aggregate Device" in device_name:
                    aggregate_index = i
                    break

        p.terminate()
        return aggregate_index

    def save_recording(self, frames: list, filename: str) -> dict:
        """Save recorded frames using the new audio_saver module"""
        import shutil
        
        result = {"local": False, "nas": False, "local_path": None, "nas_path": None}
        
        try:
            base = filename.rsplit(".", 1)[0]  # drop .wav for bundle of outputs
            
            # (Optional) inspect channels first for debugging
            diags = compute_channel_diagnostics(frames, rate=RATE, channels=CHANNELS)
            print("RMS:", diags["rms"])
            print("Corr:\n", diags["corr"])

            # Save to local directory first
            written = analyze_and_save(
                frames,
                rate=RATE,
                channels=CHANNELS,
                out_dir=self.recordings_dir,
                basename=base,
                want_full_multichannel=False,
                want_system_stereo=False,
                want_mic_mono=False,
                want_combined_mono=True,
                system_pair=(1, 2),  # system channels
                mic_index=0,  # mic channel
            )
            
            result["local"] = True
            result["local_path"] = written.get("combined_mono")
            print(f"Local audio saved: {written}")
            
            # Copy to NAS if available
            if os.path.exists(self.nas_dir) and result["local_path"]:
                try:
                    nas_path = os.path.join(self.nas_dir, os.path.basename(result["local_path"]))
                    shutil.copy2(result["local_path"], nas_path)
                    result["nas"] = True
                    result["nas_path"] = nas_path
                    print(f"Copied to NAS: {nas_path}")
                except Exception as e:
                    print(f"Error copying to NAS: {e}")
            
            return result
        except Exception as e:
            print(f"Error saving recording: {e}")
            return result

    async def start_recording(self, name: str = None) -> Optional[int]:
        """Start recording audio"""
        if self.recording:
            return None

        aggregate_device_index = self.find_aggregate_device_index()
        if aggregate_device_index == -1:
            raise Exception("Aggregate Device not found")

        self.filename = self.generate_filename()
        if not name:
            name = f"Recording {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"

        # Create database entry
        recording = await RecordingService.create_recording(
            name=name, local_audio_path=os.path.join(self.recordings_dir, self.filename)
        )

        if not recording:
            raise Exception("Failed to create database entry")

        self.recording_id = recording.id
        self.p = pyaudio.PyAudio()
        self.frames = []
        self.recording = True
        self.start_time = time.time()

        # Get device parameters for debugging
        params = self.get_device_params(aggregate_device_index)
        print("PARAMS", params)

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
            raise Exception(f"Error opening audio stream: {e}")

        return self.recording_id

    def record_chunk(self) -> bool:
        """Record a single chunk of audio. Returns False if recording should stop."""
        if not self.recording or not self.stream:
            return False

        current_time = time.time()
        if current_time - self.start_time >= MAX_RECORD_HOURS * 3600:
            return False

        try:
            data = self.stream.read(CHUNK, exception_on_overflow=True)  # Show overflow errors
            self.frames.append(data)
            return True
        except Exception as e:
            print(f"Error recording chunk: {e}")
            return False

    async def stop_recording(self) -> bool:
        """Stop recording and save the file"""
        if not self.recording:
            return False

        self.recording = False

        # Stop stream
        if self.stream:
            self.stream.stop_stream()
            self.stream.close()

        if self.p:
            self.p.terminate()

        # Save recording
        success = False
        if self.frames and self.filename:
            result = self.save_recording(self.frames, self.filename)
            success = result["local"]  # Consider successful if local save worked

            if success and self.recording_id:
                # Update database with duration and NAS path
                duration = (
                    int(time.time() - self.start_time) if self.start_time else None
                )
                update_data = {"duration": duration}
                if result["nas_path"]:
                    update_data["nas_audio"] = result["nas_path"]
                
                await RecordingService.update_recording(
                    self.recording_id, **update_data
                )

        self.cleanup()
        return success

    def cleanup(self):
        self.frames = []
        self.recording_id = None
        self.start_time = None
        self.filename = None
        self.stream = None
        self.p = None

    def is_recording(self) -> bool:
        return self.recording

    def get_recording_duration(self) -> float:
        if not self.recording or not self.start_time:
            return 0.0
        return time.time() - self.start_time

