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

# Audio recording settings
RATE = 44100
CHUNK = 4096  # Increased buffer size to reduce potential underruns
FORMAT = pyaudio.paInt16
CHANNELS = 2
MAX_RECORD_HOURS = 3


class AudioRecorder:
    def __init__(self, recordings_dir: str = "recordings"):
        self.recordings_dir = recordings_dir
        self.recording = False
        self.stream = None
        self.p = None
        self.frames = []
        self.recording_id = None
        self.start_time = None
        self.filename = None

        # Ensure recordings directory exists
        os.makedirs(self.recordings_dir, exist_ok=True)

    def generate_filename(self) -> str:
        """Generate a timestamped filename"""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        return f"recording_{timestamp}.wav"

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

    def save_recording(self, frames: list, filename: str) -> bool:
        """Save recorded frames to a WAV file"""
        try:
            filepath = os.path.join(self.recordings_dir, filename)

            # Convert stereo to mono
            if CHANNELS == 2:
                audio_data = b"".join(frames)
                audio_array = np.frombuffer(audio_data, dtype=np.int16)
                stereo_array = audio_array.reshape(-1, 2)
                mono_array = np.mean(stereo_array, axis=1, dtype=np.int16)
                mono_data = mono_array.tobytes()

                # Save as mono
                wf = wave.open(filepath, "wb")
                wf.setnchannels(1)
                wf.setsampwidth(self.p.get_sample_size(FORMAT))
                wf.setframerate(RATE)
                wf.writeframes(mono_data)
                wf.close()
            else:
                # Save as-is
                wf = wave.open(filepath, "wb")
                wf.setnchannels(CHANNELS)
                wf.setsampwidth(self.p.get_sample_size(FORMAT))
                wf.setframerate(RATE)
                wf.writeframes(b"".join(frames))
                wf.close()

            return True
        except Exception as e:
            print(f"Error saving recording: {e}")
            return False

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
            data = self.stream.read(CHUNK)  # Removed exception_on_overflow=False to see errors
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
            success = self.save_recording(self.frames, self.filename)

            if success and self.recording_id:
                # Update database with duration
                duration = (
                    int(time.time() - self.start_time) if self.start_time else None
                )
                await RecordingService.update_recording(
                    self.recording_id, duration=duration
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

