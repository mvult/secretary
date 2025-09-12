import pyaudio
import wave
import time
import signal
import sys
import numpy as np
from datetime import datetime

# --- Configuration ---
MAX_RECORD_HOURS = 3  # Maximum recording duration in hours
def generate_filename():
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"recording_{timestamp}.wav"

# Audio recording settings (should match BlackHole's capabilities)
RATE = 44100  # Sample rate (common standard) - BlackHole supports many
CHUNK = 1024  # Buffer size
FORMAT = pyaudio.paInt16  # 16-bit audio
CHANNELS = 2  # Use 2 channels (stereo) as BlackHole 2ch is stereo by default

# --- Helper Function: Find Aggregate Device Index ---
def find_aggregate_device_index():
    p = pyaudio.PyAudio()
    info = p.get_host_api_info_by_index(0)
    numdevices = info.get('deviceCount')
    aggregate_index = -1
    print("Available audio input devices:")
    for i in range(0, numdevices):
        device_info = p.get_device_info_by_host_api_device_index(0, i)
        if device_info.get('maxInputChannels') > 0: # Check if it's an input device
            device_name = device_info.get('name')
            print(f"  {i}: {device_name}")
            if "Aggregate Device" in device_name:
                aggregate_index = i
    p.terminate()
    return aggregate_index

# --- Global variables for signal handling ---
recording = False
stream = None
p = None
frames = []

def signal_handler(signum, frame):
    global recording
    print("\nReceived interrupt signal. Stopping recording...")
    recording = False

def save_recording(frames, filename):
    global p
    
    # Convert stereo to mono
    if CHANNELS == 2:
        # Convert frames to numpy array for processing
        audio_data = b''.join(frames)
        audio_array = np.frombuffer(audio_data, dtype=np.int16)
        
        # Reshape to stereo (2 channels) and convert to mono by averaging
        stereo_array = audio_array.reshape(-1, 2)
        mono_array = np.mean(stereo_array, axis=1, dtype=np.int16)
        
        # Convert back to bytes
        mono_data = mono_array.tobytes()
        
        # Save as mono
        wf = wave.open(filename, 'wb')
        wf.setnchannels(1)  # Save as mono
        wf.setsampwidth(p.get_sample_size(FORMAT))
        wf.setframerate(RATE)
        wf.writeframes(mono_data)
        wf.close()
    else:
        # Already mono, save as-is
        wf = wave.open(filename, 'wb')
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(p.get_sample_size(FORMAT))
        wf.setframerate(RATE)
        wf.writeframes(b''.join(frames))
        wf.close()
    
    print(f"Audio saved to {filename}")

# --- Main Local Recording Logic ---
def record_from_aggregate_device_continuously():
    global recording, stream, p, frames
    
    aggregate_device_index = find_aggregate_device_index()

    if aggregate_device_index == -1:
        print("\nAggregate Device not found.")
        print("Please ensure it's configured correctly in 'Audio MIDI Setup'.")
        print("The Aggregate Device should include your microphone and other audio sources.")
        return

    filename = generate_filename()
    print(f"\nFound Aggregate Device at index: {aggregate_device_index}. Starting continuous recording...")
    print(f"Recording to {filename}...")
    print(f"Maximum recording duration: {MAX_RECORD_HOURS} hours")
    print("Press Ctrl+C to stop recording.")

    p = pyaudio.PyAudio()
    frames = []
    recording = True

    # Set up signal handler
    signal.signal(signal.SIGINT, signal_handler)

    try:
        # Open an audio stream from the Aggregate Device
        stream = p.open(format=FORMAT,
                        channels=CHANNELS,
                        rate=RATE,
                        input=True,
                        frames_per_buffer=CHUNK,
                        input_device_index=aggregate_device_index
                       )
    except Exception as e:
        print(f"Error opening audio stream: {e}")
        print("Common issues: Incorrect device index, Aggregate Device not configured properly, or macOS microphone permissions.")
        p.terminate()
        return

    start_time = time.time()
    max_duration = MAX_RECORD_HOURS * 3600  # Convert hours to seconds

    # Record data continuously until interrupted or time limit reached
    try:
        while recording:
            current_time = time.time()
            if current_time - start_time >= max_duration:
                print(f"\nReached maximum recording duration of {MAX_RECORD_HOURS} hours. Stopping...")
                break
                
            try:
                data = stream.read(CHUNK, exception_on_overflow=False)
                frames.append(data)
            except IOError as e:
                print(f"Audio stream read error: {e}")
                break
            except Exception as e:
                print(f"Unexpected error during recording: {e}")
                break
    except KeyboardInterrupt:
        pass  # Handled by signal handler

    print("Recording finished.")

    # Stop and close the stream
    if stream:
        stream.stop_stream()
        stream.close()
    if p:
        p.terminate()

    # Save the recorded data as a WAV file
    if frames:
        save_recording(frames, filename)
        duration = time.time() - start_time
        print(f"Recording duration: {duration/60:.1f} minutes")
    else:
        print("No audio data recorded.")

if __name__ == "__main__":
    print("--- Continuous Aggregate Device Audio Recorder ---")
    print("Ensure your Aggregate Device is configured in 'Audio MIDI Setup'.")
    print("Make sure the Aggregate Device includes your microphone and any other audio sources you want to capture.")
    print("And your Python environment/IDE has Microphone permissions in macOS 'Privacy & Security'.")
    print(f"\nRecording will automatically stop after {MAX_RECORD_HOURS} hours or when interrupted with Ctrl+C")
    print("Starting in a few seconds...")
    time.sleep(2)
    try:
        record_from_aggregate_device_continuously()
    except Exception as e:
        print(f"An unhandled error occurred: {e}")
        if stream:
            stream.stop_stream()
            stream.close()
        if p:
            p.terminate()
