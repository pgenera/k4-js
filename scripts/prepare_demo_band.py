#!/usr/bin/env python3
"""
Prepare a stereo 16-bit complex I/Q WAV recording for the k4-js static web demo.

Outputs:
  - <out-dir>/band.iq.bin   : DC-removed, peak-normalized, loop-crossfaded int16 LE I/Q pairs
  - <out-dir>/manifest.json : Band metadata, center frequency, sample rate, and detected signal bookmarks

Can also generate a realistic multi-signal synthetic I/Q recording (--synth-test)
for offline development and automated browser verification.

Examples:
  # Convert a KiwiSDR capture (reads companion .json automatically if present):
  python3 scripts/prepare_demo_band.py --wav /tmp/20m_iq.wav --out-dir web/demo --band 20m

  # Generate a synthetic 20m test band (CW + SSB-like + FT8 tones) for local testing:
  python3 scripts/prepare_demo_band.py --synth-test --out-dir web/demo
"""

import argparse
import json
import math
import os
import sys
import wave

import numpy as np


BAND_DEFS = {
    "160m": {"bn": "00", "label": "160m", "defaultMode": "LSB"},
    "80m": {"bn": "01", "label": "80m", "defaultMode": "LSB"},
    "60m": {"bn": "02", "label": "60m", "defaultMode": "USB"},
    "40m": {"bn": "03", "label": "40m", "defaultMode": "LSB"},
    "30m": {"bn": "04", "label": "30m", "defaultMode": "CW"},
    "20m": {"bn": "05", "label": "20m", "defaultMode": "USB"},
    "17m": {"bn": "06", "label": "17m", "defaultMode": "USB"},
    "15m": {"bn": "07", "label": "15m", "defaultMode": "USB"},
    "12m": {"bn": "08", "label": "12m", "defaultMode": "USB"},
    "10m": {"bn": "09", "label": "10m", "defaultMode": "USB"},
    "6m": {"bn": "10", "label": "6m", "defaultMode": "USB"},
}


def infer_band(center_hz: int) -> str:
    mhz = center_hz / 1e6
    if 1.8 <= mhz <= 2.0:
        return "160m"
    if 3.5 <= mhz <= 4.0:
        return "80m"
    if 5.2 <= mhz <= 5.5:
        return "60m"
    if 7.0 <= mhz <= 7.35:
        return "40m"
    if 10.1 <= mhz <= 10.16:
        return "30m"
    if 14.0 <= mhz <= 14.35:
        return "20m"
    if 18.06 <= mhz <= 18.17:
        return "17m"
    if 21.0 <= mhz <= 21.45:
        return "15m"
    if 24.89 <= mhz <= 24.99:
        return "12m"
    if 28.0 <= mhz <= 29.7:
        return "10m"
    if 50.0 <= mhz <= 54.0:
        return "6m"
    return "20m"


def infer_mode_for_freq(freq_hz: int, band: str) -> str:
    # Common HF band plan heuristics
    if band == "20m":
        if freq_hz < 14070000:
            return "CW"
        if 14073000 <= freq_hz <= 14078000:
            return "DATA-A"
        if freq_hz < 14150000:
            return "DATA-A"
        return "USB"
    if band == "40m":
        if freq_hz < 7070000:
            return "CW"
        if 7073000 <= freq_hz <= 7078000:
            return "DATA-A"
        return "LSB"
    return BAND_DEFS.get(band, {}).get("defaultMode", "USB")


def load_iq_wav(wav_path: str):
    with wave.open(wav_path, "rb") as wf:
        ch = wf.getnchannels()
        sw = wf.getsampwidth()
        sr = wf.getframerate()
        nframes = wf.getnframes()
        if ch != 2 or sw != 2:
            raise ValueError(f"Expected stereo 16-bit PCM WAV, got channels={ch} sampwidth={sw}")
        raw = wf.readframes(nframes)
    arr = np.frombuffer(raw, dtype="<i2").astype(np.float32).reshape(-1, 2) / 32768.0
    iq = arr[:, 0] + 1j * arr[:, 1]
    return iq, sr


def make_loopable(iq: np.ndarray, sample_rate: int, crossfade_ms: float = 120.0) -> np.ndarray:
    """Remove DC offset, apply cosine crossfade at loop seam, and normalize to -3 dBFS."""
    iq = iq - np.mean(iq)
    fade_n = int(round(sample_rate * (crossfade_ms / 1000.0)))
    if fade_n > 16 and len(iq) > fade_n * 4:
        t = np.linspace(0.0, math.pi * 0.5, fade_n, dtype=np.float32)
        fade_in = np.sin(t)
        fade_out = np.cos(t)
        head = iq[:fade_n] * fade_in + iq[-fade_n:] * fade_out
        iq = np.concatenate([head, iq[fade_n:-fade_n]])

    peak = float(np.max(np.abs(iq)))
    if peak > 1e-6:
        # Target -3 dBFS (~0.707) so strong signals have clean headroom
        iq = iq * (0.707 / peak)
    return iq


def detect_bookmarks(iq: np.ndarray, sample_rate: int, center_hz: int, band: str, max_peaks: int = 6):
    """Run averaged 1024-pt FFT to find strongest real signals for demo quick-jump bookmarks."""
    nfft = 1024
    hop = 512
    if len(iq) < nfft:
        return []
    win = np.hanning(nfft).astype(np.float32)
    win_norm = float(np.sum(win))
    acc = np.zeros(nfft, dtype=np.float64)
    count = 0
    for start in range(0, len(iq) - nfft, hop):
        seg = iq[start : start + nfft] * win
        spec = np.fft.fftshift(np.fft.fft(seg))
        acc += (np.abs(spec) / win_norm) ** 2
        count += 1
    if count == 0:
        return []
    psd_db = 10.0 * np.log10(acc / count + 1e-12)
    noise_floor = float(np.median(psd_db))

    # Ignore 4% edges where anti-alias rolloff occurs
    edge = max(16, int(nfft * 0.04))
    inner = psd_db[edge : nfft - edge]
    freqs = (np.arange(nfft) - nfft / 2.0) * (sample_rate / float(nfft)) + center_hz

    peaks = []
    min_sep_hz = 1200.0
    order = np.argsort(inner)[::-1]
    for idx in order:
        bin_idx = int(idx + edge)
        snr = float(psd_db[bin_idx] - noise_floor)
        if snr < 8.0:
            break
        f_hz = int(round(freqs[bin_idx] / 50.0) * 50)
        if any(abs(f_hz - p["freqHz"]) < min_sep_hz for p in peaks):
            continue
        mode = infer_mode_for_freq(f_hz, band)
        # For CW, dial freq is carrier - 500 Hz pitch
        dial_hz = f_hz - 500 if mode == "CW" else f_hz
        peaks.append(
            {
                "label": f"{mode} {dial_hz / 1e6:.4f} MHz",
                "freqHz": dial_hz,
                "mode": mode,
                "snrDb": round(snr, 1),
            }
        )
        if len(peaks) >= max_peaks:
            break

    peaks.sort(key=lambda p: p["freqHz"])
    return peaks


def synth_test_iq(sample_rate: int = 20250, duration_sec: float = 12.0, center_hz: int = 14074000):
    """Synthesize a realistic 20.25 kHz complex I/Q slice on 20m (CW + FT8 + RTTY) for testing."""
    rng = np.random.default_rng(42)
    n = int(round(sample_rate * duration_sec))
    t = np.arange(n, dtype=np.float64) / float(sample_rate)

    # Complex band noise floor
    iq = (rng.normal(0.0, 0.018, n) + 1j * rng.normal(0.0, 0.018, n)).astype(np.complex128)

    # Helper: Morse pattern envelope
    def morse_env(text_dots: str, wpm: float, offset_sec: float = 0.0):
        dit = 1.2 / wpm
        seq = []
        for ch in text_dots:
            if ch == ".":
                seq.extend([1, 0])
            elif ch == "-":
                seq.extend([1, 1, 1, 0])
            elif ch == " ":
                seq.extend([0, 0])
        seq = np.array(seq, dtype=np.float64)
        idx = np.floor((t + offset_sec) / dit).astype(np.int64) % len(seq)
        env = seq[idx]
        # Soft 5 ms key-click shaping
        k = max(3, int(sample_rate * 0.005))
        kernel = np.hanning(k)
        kernel /= np.sum(kernel)
        return np.convolve(env, kernel, mode="same")

    # 1. Strong CW CQ beacon at center - 6000 Hz (14.0680 MHz carrier -> dial 14.0675 MHz)
    cw1_off = -6000.0
    env1 = morse_env("-.-. --.-  -.-. --.-  -.. .  -.- ....- -.. . -- ---  -.-  ", 22.0)
    iq += 0.32 * env1 * np.exp(1j * 2.0 * math.pi * cw1_off * t)

    # 2. Second CW station at center - 3800 Hz (14.0702 MHz)
    cw2_off = -3800.0
    env2 = morse_env("- . ... -  -.. .  .-- .---- .- .--  -.-   ", 18.0, offset_sec=1.3)
    iq += 0.19 * env2 * np.exp(1j * 2.0 * math.pi * cw2_off * t)

    # 3. 8-FSK FT8-like cluster at 14.0740..14.0765 MHz (center + 300..+2400 Hz)
    ft8_offsets = [420.0, 810.0, 1180.0, 1620.0, 2150.0]
    sym_dur = 0.160
    sym_idx = np.floor(t / sym_dur).astype(np.int64)
    for k_i, base_off in enumerate(ft8_offsets):
        tones = rng.integers(0, 8, size=int(duration_sec / sym_dur) + 4)
        f_inst = base_off + tones[sym_idx] * 6.25
        phase = np.cumsum(2.0 * math.pi * f_inst / sample_rate)
        amp = 0.14 + 0.03 * (k_i % 3)
        iq += amp * np.exp(1j * phase)

    # 4. RTTY 170 Hz shift FSK at center + 5800 Hz (14.0798 MHz)
    baud_idx = np.floor(t * 45.45).astype(np.int64)
    bits = rng.integers(0, 2, size=int(duration_sec * 46) + 4)
    rtty_f = 5800.0 + (bits[baud_idx] * 170.0 - 85.0)
    rtty_phase = np.cumsum(2.0 * math.pi * rtty_f / sample_rate)
    iq += 0.22 * np.exp(1j * rtty_phase)

    bookmarks = [
        {"label": "CW CQ 14.0675 MHz", "freqHz": center_hz - 6500, "mode": "CW", "snrDb": 26.0},
        {"label": "CW W1AW 14.0697 MHz", "freqHz": center_hz - 4300, "mode": "CW", "snrDb": 20.0},
        {"label": "FT8 14.0740 MHz", "freqHz": center_hz, "mode": "DATA-A", "snrDb": 18.0},
        {"label": "RTTY 14.0798 MHz", "freqHz": center_hz + 5800, "mode": "AFSK-A", "snrDb": 22.0},
    ]
    return iq.astype(np.complex64), sample_rate, center_hz, bookmarks


def write_demo_bundle(
    iq: np.ndarray,
    sample_rate: int,
    center_hz: int,
    out_dir: str,
    band: str,
    title: str,
    source: str,
    bookmarks=None,
    default_freq_hz=None,
    default_mode=None,
):
    os.makedirs(out_dir, exist_ok=True)
    iq = make_loopable(iq, sample_rate)

    # Pack as interleaved int16 LE: I0, Q0, I1, Q1, ...
    interleaved = np.empty(len(iq) * 2, dtype="<i2")
    interleaved[0::2] = np.clip(np.round(iq.real * 32767.0), -32768, 32767).astype("<i2")
    interleaved[1::2] = np.clip(np.round(iq.imag * 32767.0), -32768, 32767).astype("<i2")

    bin_path = os.path.join(out_dir, "band.iq.bin")
    interleaved.tofile(bin_path)

    if not bookmarks:
        bookmarks = detect_bookmarks(iq, sample_rate, center_hz, band)

    if default_freq_hz is None:
        if bookmarks:
            default_freq_hz = bookmarks[0]["freqHz"]
        else:
            default_freq_hz = center_hz
    if default_mode is None:
        if bookmarks:
            default_mode = bookmarks[0]["mode"]
        else:
            default_mode = infer_mode_for_freq(default_freq_hz, band)

    span_hz = min(int(sample_rate), 24000)
    if sample_rate <= 12500:
        span_hz = 12000
    elif sample_rate <= 21000:
        span_hz = 18000

    manifest = {
        "version": 1,
        "title": title,
        "source": source,
        "band": band,
        "bandNumber": BAND_DEFS.get(band, {}).get("bn", "05"),
        "iqFile": "band.iq.bin",
        "format": "int16-le-iq",
        "centerFreqHz": int(center_hz),
        "sampleRateHz": int(sample_rate),
        "frames": int(len(iq)),
        "durationSec": round(len(iq) / float(sample_rate), 3),
        "minFreqHz": int(center_hz - sample_rate * 0.48),
        "maxFreqHz": int(center_hz + sample_rate * 0.48),
        "defaultFreqHz": int(default_freq_hz),
        "defaultMode": default_mode,
        "defaultSpanHz": int(span_hz),
        "noiseFloorOffsetDb": -118.0,
        "bookmarks": bookmarks,
    }

    manifest_path = os.path.join(out_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    size_mb = os.path.getsize(bin_path) / (1024.0 * 1024.0)
    print(f"[demo-prep] Wrote {bin_path} ({size_mb:.2f} MiB, {manifest['durationSec']} s @ {sample_rate} Hz)")
    print(f"[demo-prep] Wrote {manifest_path} (band={band}, center={center_hz} Hz, bookmarks={len(bookmarks)})")
    for bm in bookmarks:
        print(f"            - {bm['label']} ({bm['mode']}, {bm['freqHz']} Hz)")


def main() -> int:
    ap = argparse.ArgumentParser(description="Prepare a static I/Q demo bundle for k4-js")
    ap.add_argument("--wav", help="Input stereo 16-bit I/Q WAV file")
    ap.add_argument("--center-hz", type=int, help="Center frequency in Hz (auto-read from WAV sidecar .json if present)")
    ap.add_argument("--band", help="Band name (e.g. 20m, 40m; auto-inferred from center-hz if omitted)")
    ap.add_argument("--title", help="Human-readable demo title (e.g. '20m ARRL Sweepstakes SSB')")
    ap.add_argument("--source", help="Source attribution string (e.g. 'KiwiSDR NA · 20.25 kHz I/Q')")
    ap.add_argument("--max-sec", type=float, default=30.0, help="Trim recording to at most N seconds (default: 30)")
    ap.add_argument("--out-dir", default="web/demo", help="Output directory (default: web/demo)")
    ap.add_argument("--synth-test", action="store_true", help="Generate a synthetic 20m multi-signal I/Q test bundle")
    args = ap.parse_args()

    if args.synth_test:
        iq, sr, center_hz, bookmarks = synth_test_iq()
        write_demo_bundle(
            iq=iq,
            sample_rate=sr,
            center_hz=center_hz,
            out_dir=args.out_dir,
            band="20m",
            title="20m Demo Band (CW + FT8 + RTTY Test I/Q)",
            source="Synthetic 20.25 kHz I/Q Test Bundle (replace with KiwiSDR capture)",
            bookmarks=bookmarks,
        )
        return 0

    if not args.wav:
        ap.error("Provide --wav <path> or --synth-test")

    sidecar = {}
    sidecar_path = os.path.splitext(args.wav)[0] + ".json"
    if os.path.exists(sidecar_path):
        with open(sidecar_path, "r", encoding="utf-8") as f:
            sidecar = json.load(f)

    center_hz = args.center_hz or sidecar.get("centerFreqHz")
    if not center_hz:
        ap.error("Center frequency required via --center-hz or companion .json sidecar")

    iq, sr = load_iq_wav(args.wav)
    max_frames = int(round(sr * args.max_sec))
    if len(iq) > max_frames:
        iq = iq[:max_frames]

    band = args.band or infer_band(int(center_hz))
    title = args.title or f"{band} Live Off-The-Air Recording"
    source = args.source or sidecar.get("source") or os.path.basename(args.wav)

    write_demo_bundle(
        iq=iq,
        sample_rate=sr,
        center_hz=int(center_hz),
        out_dir=args.out_dir,
        band=band,
        title=title,
        source=source,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
