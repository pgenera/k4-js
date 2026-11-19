#!/usr/bin/env python3
"""
Prepare single-slice or multi-tile stereo 16-bit complex I/Q WAV recordings
for the k4-js static web demo.

Outputs:
  - Single-slice: <out-dir>/band.iq.bin + manifest.json
  - Multi-tile:   <out-dir>/tile_00.iq.bin, tile_01.iq.bin, ... + manifest.json (v2)

All tiles in a multi-tile sweep are noise-floor-matched so the wideband
panadapter is flat and seamless across tile boundaries.

Examples:
  # Convert a multi-tile sweep from capture_kiwisdr.py:
  python3 scripts/prepare_demo_band.py \
      --sweep /tmp/20m_sweep/sweep.json \
      --band 20m --title "20m Live SSB Sweep" --out-dir web/demo

  # Convert a single WAV:
  python3 scripts/prepare_demo_band.py --wav /tmp/20m_iq.wav --out-dir web/demo --band 20m

  # Generate a synthetic 20m test bundle:
  python3 scripts/prepare_demo_band.py --synth-test --out-dir web/demo
"""

import argparse
import glob
import json
import math
import os
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

SPAN_STEPS_HZ = [6000, 12000, 24000, 36000, 48000, 72000, 96000, 144000, 192000, 288000, 368000]


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
    if band == "20m":
        if freq_hz < 14070000:
            return "CW"
        if 14073000 <= freq_hz <= 14084000:
            return "DATA-A"
        if freq_hz < 14150000:
            return "DATA-A"
        return "USB"
    if band == "40m":
        if freq_hz < 7070000:
            return "CW"
        if 7073000 <= freq_hz <= 7082000:
            return "DATA-A"
        return "LSB"
    return BAND_DEFS.get(band, {}).get("defaultMode", "USB")


def pick_default_span(total_bw_hz: float) -> int:
    # Pick the largest K4 span step <= total_bw_hz (or closest covering)
    best = 18000
    for s in SPAN_STEPS_HZ:
        if s <= total_bw_hz * 1.05:
            best = s
    return best


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


def crossfade_loop(iq: np.ndarray, sample_rate: int, crossfade_ms: float = 120.0) -> np.ndarray:
    """Remove DC offset and apply cosine crossfade at loop seam (without peak normalizing yet)."""
    iq = iq - np.mean(iq)
    fade_n = int(round(sample_rate * (crossfade_ms / 1000.0)))
    if fade_n > 16 and len(iq) > fade_n * 4:
        t = np.linspace(0.0, math.pi * 0.5, fade_n, dtype=np.float32)
        fade_in = np.sin(t)
        fade_out = np.cos(t)
        head = iq[:fade_n] * fade_in + iq[-fade_n:] * fade_out
        iq = np.concatenate([head, iq[fade_n:-fade_n]])
    return iq


def compute_psd_and_floor(iq: np.ndarray, sample_rate: int):
    nfft = 1024
    hop = 512
    if len(iq) < nfft:
        return np.full(nfft, -120.0), -120.0
    win = np.hanning(nfft).astype(np.float32)
    win_norm = float(np.sum(win))
    acc = np.zeros(nfft, dtype=np.float64)
    count = 0
    for start in range(0, len(iq) - nfft, hop):
        seg = iq[start : start + nfft] * win
        spec = np.fft.fftshift(np.fft.fft(seg))
        acc += (np.abs(spec) / win_norm) ** 2
        count += 1
    psd_db = 10.0 * np.log10(acc / max(1, count) + 1e-12)
    edge = max(32, int(nfft * 0.06))
    noise_floor = float(np.percentile(psd_db[edge : nfft - edge], 35))
    return psd_db, noise_floor


def detect_bookmarks_for_tile(iq: np.ndarray, sample_rate: int, center_hz: int, band: str, max_peaks: int = 3):
    psd_db, noise_floor = compute_psd_and_floor(iq, sample_rate)
    nfft = len(psd_db)
    edge = max(32, int(nfft * 0.05))
    inner = psd_db[edge : nfft - edge]
    freqs = (np.arange(nfft) - nfft / 2.0) * (sample_rate / float(nfft)) + center_hz

    peaks = []
    min_sep_hz = 2200.0
    order = np.argsort(inner)[::-1]
    for idx in order:
        bin_idx = int(idx + edge)
        snr = float(psd_db[bin_idx] - noise_floor)
        if snr < 9.0:
            break
        raw_f = float(freqs[bin_idx])
        mode = infer_mode_for_freq(int(raw_f), band)
        if mode == "CW":
            dial_hz = int(round((raw_f - 500.0) / 50.0) * 50)
        elif mode == "USB":
            # Speech energy peaks ~1.1 kHz above suppressed carrier; snap to 500 Hz grid
            dial_hz = int(round((raw_f - 1100.0) / 500.0) * 500)
        elif mode == "LSB":
            dial_hz = int(round((raw_f + 1100.0) / 500.0) * 500)
        else:
            dial_hz = int(round(raw_f / 100.0) * 100)

        if any(abs(dial_hz - p["freqHz"]) < min_sep_hz for p in peaks):
            continue
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
    return peaks


def write_iq_int16(iq: np.ndarray, path: str) -> None:
    interleaved = np.empty(len(iq) * 2, dtype="<i2")
    interleaved[0::2] = np.clip(np.round(iq.real * 32767.0), -32768, 32767).astype("<i2")
    interleaved[1::2] = np.clip(np.round(iq.imag * 32767.0), -32768, 32767).astype("<i2")
    interleaved.tofile(path)


def clean_old_demo_bins(out_dir: str) -> None:
    for p in glob.glob(os.path.join(out_dir, "tile_*.iq.bin")):
        try:
            os.remove(p)
        except OSError:
            pass
    old_single = os.path.join(out_dir, "band.iq.bin")
    if os.path.exists(old_single):
        try:
            os.remove(old_single)
        except OSError:
            pass


def write_multi_tile_bundle(tile_inputs: list, out_dir: str, band: str, title: str, source: str, max_sec: float = 25.0):
    os.makedirs(out_dir, exist_ok=True)
    clean_old_demo_bins(out_dir)

    # Sort tiles by center frequency ascending
    tile_inputs.sort(key=lambda t: t["centerFreqHz"])

    processed = []
    floors = []
    for t in tile_inputs:
        iq = t["iq"]
        sr = int(t["sampleRateHz"])
        max_frames = int(round(sr * max_sec))
        if len(iq) > max_frames:
            iq = iq[:max_frames]
        iq = crossfade_loop(iq, sr)
        _, floor_db = compute_psd_and_floor(iq, sr)
        floors.append(floor_db)
        processed.append({"iq": iq, "sr": sr, "centerFreqHz": int(t["centerFreqHz"]), "floorDb": floor_db})

    # Align all tiles to a common noise floor so the stitched waterfall is seamless
    target_floor_db = float(np.median(floors))
    global_peak = 0.0
    for p in processed:
        gain_lin = 10.0 ** ((target_floor_db - p["floorDb"]) / 20.0)
        gain_lin = min(max(gain_lin, 0.1), 10.0)
        p["iq"] = p["iq"] * gain_lin
        pk = float(np.max(np.abs(p["iq"])))
        if pk > global_peak:
            global_peak = pk

    # Apply one common peak scale across all tiles so relative signal strengths stay true
    scale = (0.75 / global_peak) if global_peak > 1e-6 else 1.0

    manifest_tiles = []
    all_bookmarks = []
    total_bytes = 0

    for idx, p in enumerate(processed):
        iq = p["iq"] * scale
        fname = "band.iq.bin" if len(processed) == 1 else f"tile_{idx:02d}.iq.bin"
        bin_path = os.path.join(out_dir, fname)
        write_iq_int16(iq, bin_path)
        total_bytes += os.path.getsize(bin_path)

        bms = detect_bookmarks_for_tile(iq, p["sr"], p["centerFreqHz"], band, max_peaks=2 if len(processed) > 2 else 5)
        all_bookmarks.extend(bms)

        manifest_tiles.append(
            {
                "iqFile": fname,
                "centerFreqHz": p["centerFreqHz"],
                "sampleRateHz": p["sr"],
                "frames": int(len(iq)),
                "durationSec": round(len(iq) / float(p["sr"]), 3),
            }
        )

    # Deduplicate bookmarks across overlapping tile edges and keep top 8 by SNR
    all_bookmarks.sort(key=lambda b: b.get("snrDb", 0), reverse=True)
    dedup = []
    for bm in all_bookmarks:
        if any(abs(bm["freqHz"] - d["freqHz"]) < 2000 for d in dedup):
            continue
        dedup.append(bm)
        if len(dedup) >= 8:
            break
    dedup.sort(key=lambda b: b["freqHz"])

    min_f = min(int(t["centerFreqHz"] - t["sampleRateHz"] * 0.46) for t in manifest_tiles)
    max_f = max(int(t["centerFreqHz"] + t["sampleRateHz"] * 0.46) for t in manifest_tiles)
    center_f = int(round((min_f + max_f) * 0.5))
    total_bw = max_f - min_f

    best_bm = max(dedup, key=lambda b: b.get("snrDb", 0)) if dedup else None
    default_freq = best_bm["freqHz"] if best_bm else center_f
    default_mode = best_bm["mode"] if best_bm else infer_mode_for_freq(default_freq, band)
    default_span = pick_default_span(total_bw)

    manifest = {
        "version": 2 if len(manifest_tiles) > 1 else 1,
        "title": title,
        "source": source,
        "band": band,
        "bandNumber": BAND_DEFS.get(band, {}).get("bn", "05"),
        "format": "int16-le-iq",
        "centerFreqHz": center_f,
        "minFreqHz": min_f,
        "maxFreqHz": max_f,
        "defaultFreqHz": int(default_freq),
        "defaultMode": default_mode,
        "defaultSpanHz": int(default_span),
        "noiseFloorOffsetDb": -118.0,
        "tiles": manifest_tiles,
        "bookmarks": dedup,
    }
    if len(manifest_tiles) == 1:
        manifest["iqFile"] = manifest_tiles[0]["iqFile"]
        manifest["sampleRateHz"] = manifest_tiles[0]["sampleRateHz"]
        manifest["frames"] = manifest_tiles[0]["frames"]
        manifest["durationSec"] = manifest_tiles[0]["durationSec"]

    manifest_path = os.path.join(out_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    print(
        f"[demo-prep] Wrote {len(manifest_tiles)} tile(s) ({total_bytes / (1024 * 1024):.2f} MiB total) "
        f"covering {min_f / 1e6:.4f}–{max_f / 1e6:.4f} MHz ({total_bw / 1e3:.1f} kHz span)"
    )
    print(f"[demo-prep] Wrote {manifest_path} (defaultSpan={default_span} Hz, bookmarks={len(dedup)})")
    for bm in dedup:
        print(f"            - {bm['label']} ({bm['mode']}, SNR +{bm['snrDb']} dB)")


def synth_test_tiles():
    """Generate a 3-tile synthetic 20m sweep (54 kHz span) for testing multi-tile stitching."""
    rng = np.random.default_rng(42)
    sr = 20250
    dur = 8.0
    n = int(round(sr * dur))
    t = np.arange(n, dtype=np.float64) / float(sr)
    centers = [14210000, 14228000, 14246000]
    tiles = []
    for idx, c in enumerate(centers):
        iq = (rng.normal(0.0, 0.015, n) + 1j * rng.normal(0.0, 0.015, n)).astype(np.complex128)
        # Put a voice-like multi-formant USB signal in each tile
        base_off = -2500.0 + idx * 1200.0
        for f_harm, amp in [(400, 0.14), (850, 0.18), (1400, 0.12), (2100, 0.07)]:
            mod = 0.5 + 0.5 * np.sin(2.0 * math.pi * (1.8 + 0.4 * idx) * t + f_harm * 0.01)
            iq += amp * mod * np.exp(1j * 2.0 * math.pi * (base_off + f_harm) * t)
        tiles.append({"iq": iq.astype(np.complex64), "sampleRateHz": sr, "centerFreqHz": c})
    return tiles


def main() -> int:
    ap = argparse.ArgumentParser(description="Prepare single-slice or multi-tile static I/Q demo bundle for k4-js")
    ap.add_argument("--wav", help="Single stereo 16-bit I/Q WAV file")
    ap.add_argument("--sweep", help="Path to sweep.json produced by capture_kiwisdr.py --start-khz/--span-khz")
    ap.add_argument("--center-hz", type=int, help="Center frequency in Hz (single-WAV mode)")
    ap.add_argument("--band", help="Band name (e.g. 20m, 40m; auto-inferred if omitted)")
    ap.add_argument("--title", help="Human-readable demo title")
    ap.add_argument("--source", help="Source attribution string")
    ap.add_argument("--max-sec", type=float, default=25.0, help="Trim each slice to at most N seconds (default: 25)")
    ap.add_argument("--out-dir", default="web/demo", help="Output directory (default: web/demo)")
    ap.add_argument("--synth-test", action="store_true", help="Generate a 3-tile synthetic 20m test bundle")
    args = ap.parse_args()

    if args.synth_test:
        tiles = synth_test_tiles()
        write_multi_tile_bundle(
            tile_inputs=tiles,
            out_dir=args.out_dir,
            band="20m",
            title="20m Multi-Tile Demo Test (56 kHz)",
            source="Synthetic 3-tile 20.25 kHz I/Q Test Bundle",
            max_sec=args.max_sec,
        )
        return 0

    if args.sweep:
        with open(args.sweep, "r", encoding="utf-8") as f:
            sw = json.load(f)
        sweep_dir = os.path.dirname(os.path.abspath(args.sweep))
        tile_inputs = []
        sources = set()
        for entry in sw.get("tiles", []):
            wav_path = entry["wavPath"]
            if not os.path.exists(wav_path):
                wav_path = os.path.join(sweep_dir, os.path.basename(wav_path))
            iq, sr = load_iq_wav(wav_path)
            tile_inputs.append({"iq": iq, "sampleRateHz": sr, "centerFreqHz": int(entry["centerFreqHz"])})
            if entry.get("source"):
                sources.add(entry["source"])
        if not tile_inputs:
            ap.error("sweep.json contains no tiles")
        mid_f = tile_inputs[len(tile_inputs) // 2]["centerFreqHz"]
        band = args.band or infer_band(mid_f)
        title = args.title or f"{band} Wideband Live Sweep (Off-The-Air)"
        source = args.source or ", ".join(sorted(sources)) or "KiwiSDR Multi-Tile Sweep"
        write_multi_tile_bundle(tile_inputs, args.out_dir, band, title, source, max_sec=args.max_sec)
        return 0

    if not args.wav:
        ap.error("Provide --sweep <sweep.json>, --wav <path>, or --synth-test")

    sidecar = {}
    sidecar_path = os.path.splitext(args.wav)[0] + ".json"
    if os.path.exists(sidecar_path):
        with open(sidecar_path, "r", encoding="utf-8") as f:
            sidecar = json.load(f)

    center_hz = args.center_hz or sidecar.get("centerFreqHz")
    if not center_hz:
        ap.error("Center frequency required via --center-hz or companion .json sidecar")

    iq, sr = load_iq_wav(args.wav)
    band = args.band or infer_band(int(center_hz))
    title = args.title or f"{band} Live Off-The-Air Recording"
    source = args.source or sidecar.get("source") or os.path.basename(args.wav)
    write_multi_tile_bundle(
        [{"iq": iq, "sampleRateHz": sr, "centerFreqHz": int(center_hz)}],
        args.out_dir,
        band,
        title,
        source,
        max_sec=args.max_sec,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
