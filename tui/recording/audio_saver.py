import os
import wave
from typing import Dict, Iterable, List, Optional, Tuple

import numpy as np


def _write_wav(path: str, channels: int, rate: int, data: Iterable[bytes]) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        for chunk in data:
            wf.writeframes(chunk)


def analyze_and_save(
    frames: Iterable[bytes],
    *,
    rate: int,
    channels: int,
    out_dir: str = ".",
    basename: str = "recording",
    want_full_multichannel: bool = True,
    want_system_stereo: bool = True,
    want_mic_mono: bool = True,
    want_combined_mono: bool = True,
    system_pair: Optional[Tuple[int, int]] = None,
    mic_index: Optional[int] = None,
) -> Dict[str, str]:
    frames_list = list(frames)

    if not frames_list:
        return {}

    if system_pair is None and channels >= 2:
        system_pair = (0, 1)
    if mic_index is None and channels >= 1:
        mic_index = 0

    raw = b"".join(frames_list)
    data = np.frombuffer(raw, dtype=np.int16)
    if channels > 1:
        data = data.reshape(-1, channels)
    else:
        data = data.reshape(-1, 1)

    outputs: Dict[str, str] = {}

    if want_full_multichannel and channels >= 2:
        path = os.path.join(out_dir, f"{basename}_full_{channels}ch.wav")
        _write_wav(path, channels, rate, [raw])
        outputs["full_multichannel"] = path

    if want_system_stereo and system_pair is not None:
        i, j = system_pair
        stereo = np.ascontiguousarray(data[:, [i, j]])
        path = os.path.join(out_dir, f"{basename}_system_stereo.wav")
        _write_wav(path, 2, rate, [stereo.tobytes()])
        outputs["system_stereo"] = path

    if want_mic_mono and mic_index is not None:
        mic = np.ascontiguousarray(data[:, [mic_index]])
        path = os.path.join(out_dir, f"{basename}_mic_mono.wav")
        _write_wav(path, 1, rate, [mic.tobytes()])
        outputs["mic_mono"] = path

    if want_combined_mono:
        mono = data.mean(axis=1).astype(np.int16)
        path = os.path.join(out_dir, f"{basename}.wav")
        _write_wav(path, 1, rate, [mono.tobytes()])
        outputs["combined_mono"] = path

    return outputs


# Diagnostics intentionally omitted for now (YAGNI)
def compute_channel_diagnostics(*args, **kwargs):
    raise NotImplementedError("Diagnostics removed for now.")
