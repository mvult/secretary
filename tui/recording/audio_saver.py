# audio_saver.py
import os
import wave
import numpy as np
from typing import Dict, Optional, Tuple, List

Int16Max = 32767
Int16Min = -32768


def _to_frames_array(raw: bytes, channels: int, dtype=np.int16) -> np.ndarray:
    """raw -> (N, C) int16, padding last partial frame if needed."""
    x = np.frombuffer(raw, dtype=dtype)
    if channels <= 0:
        raise ValueError("channels must be >= 1")
    rem = x.size % channels
    if rem:
        x = np.pad(x, (0, channels - rem), mode="constant")
    return x.reshape(-1, channels)


def _rms_per_channel(x_int16: np.ndarray) -> np.ndarray:
    xf = x_int16.astype(np.float32)
    return np.sqrt((xf**2).mean(axis=0) + 1e-12)


def _corr_matrix(x_int16: np.ndarray) -> np.ndarray:
    c = x_int16.shape[1]
    xf = x_int16.astype(np.float32)
    M = np.ones((c, c), dtype=np.float32)
    for i in range(c):
        ai = xf[:, i]
        ai_c = ai - ai.mean()
        denom_i = np.sqrt((ai_c**2).sum() + 1e-12)
        for j in range(i + 1, c):
            bj = xf[:, j]
            bj_c = bj - bj.mean()
            denom_j = np.sqrt((bj_c**2).sum() + 1e-12)
            num = (ai_c * bj_c).sum()
            M[i, j] = M[j, i] = num / (denom_i * denom_j + 1e-12)
    return M


def _write_wav_int16(path: str, data_int16: np.ndarray, rate: int):
    """data_int16 shape: (N, C)."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(data_int16.shape[1])
        wf.setsampwidth(2)  # int16
        wf.setframerate(rate)
        wf.writeframes(data_int16.tobytes())


def _downmix_to_mono_int16(x_int16: np.ndarray) -> np.ndarray:
    """Equal-gain average in float, then clip/cast to int16; returns (N,1)."""
    xf = x_int16.astype(np.float32)
    mono = xf.mean(axis=1)
    mono = np.clip(mono, Int16Min, Int16Max).astype(np.int16)
    return mono[:, None]


def _pick_stereo_pair_by_corr(x_int16: np.ndarray) -> Optional[Tuple[int, int]]:
    """Pick the most correlated pair as 'stereo system'. Returns (i, j) or None."""
    C = x_int16.shape[1]
    if C < 2:
        return None
    M = _corr_matrix(x_int16)
    best, best_val = None, -2.0
    for i in range(C):
        for j in range(i + 1, C):
            if M[i, j] > best_val:
                best_val, best = M[i, j], (i, j)
    return best


def analyze_and_save(
    frames: List[bytes],
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
    """
    Boundary function: give me frames + metadata, I write useful WAVs.
    Returns a dict of written file paths (those requested and detected).

    - If system_pair or mic_index are None, we try to auto-detect.
    - If channels==2, system_pair defaults to (0,1).
    - If channels==1, only mono outputs make sense.
    """
    raw = b"".join(frames)
    x = _to_frames_array(raw, channels)  # (N, C) int16

    results: Dict[str, str] = {}

    # 1) Multichannel ground truth (optional)
    if want_full_multichannel and channels >= 2:
        p = os.path.join(out_dir, f"{basename}_full_{channels}ch.wav")
        _write_wav_int16(p, x, rate)
        results["full_multichannel"] = p

    # 2) Auto-detect layout if needed
    if channels == 2 and system_pair is None:
        system_pair = (0, 1)  # simplest case
    if channels >= 3 and (system_pair is None or mic_index is None):
        # Guess the most-correlated pair as system, leftover as mic (for 3ch).
        guess_pair = _pick_stereo_pair_by_corr(x)
        if system_pair is None:
            system_pair = guess_pair
        if mic_index is None and system_pair and channels == 3:
            mic_index = [k for k in range(channels) if k not in system_pair][0]

    # 3) System-only stereo (optional)
    if want_system_stereo and system_pair is not None:
        i, j = system_pair
        sys_st = x[:, [i, j]]
        p = os.path.join(out_dir, f"{basename}_system_stereo.wav")
        _write_wav_int16(p, sys_st, rate)
        results["system_stereo"] = p

    # 4) Mic-only mono (optional)
    if want_mic_mono and mic_index is not None:
        mic = x[:, [mic_index]]
        p = os.path.join(out_dir, f"{basename}_mic_mono.wav")
        _write_wav_int16(p, mic, rate)
        results["mic_mono"] = p

    # 5) Combined clean mono (optional)
    if want_combined_mono and channels >= 1:
        mono = _downmix_to_mono_int16(x)
        p = os.path.join(out_dir, f"{basename}_combined_mono.wav")
        _write_wav_int16(p, mono, rate)
        results["combined_mono"] = p

    # 6) Diagnostics (optional but handy to print from caller)
    # You can compute and print these in your main if you want:
    #   rms = _rms_per_channel(x); corr = _corr_matrix(x)
    # and then persist decisions about system_pair / mic_index.

    return results


# Optional: helpers you might import in your main for debugging
def compute_channel_diagnostics(frames: List[bytes], *, rate: int, channels: int):
    raw = b"".join(frames)
    x = _to_frames_array(raw, channels)
    return {
        "rms": _rms_per_channel(x).tolist(),
        "corr": np.round(_corr_matrix(x), 3).tolist() if channels >= 2 else [[1.0]],
    }
