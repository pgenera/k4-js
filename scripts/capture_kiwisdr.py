#!/usr/bin/env python3
"""
Zero-dependency KiwiSDR I/Q capture utility for k4-js static band demos.

Supports:
  1. Single-slice capture (--freq-khz)
  2. Multi-tile wideband sweep (--start-khz + --span-khz), stepping across a band
     with automatic overlap and optional multi-host failover/parallelism (--hosts, --parallel).

Examples:
  # Wideband 20m SSB sweep (~145 kHz, 8 contiguous 18 kHz tiles, 12 s each):
  python3 scripts/capture_kiwisdr.py \
      --hosts w7dq.proxy.kiwisdr.com:8073,kb6c.proxy.kiwisdr.com:8073,173.48.189.54:8073 \
      --start-khz 14200 --span-khz 145 --duration 12 \
      --out-dir /tmp/20m_sweep

  # Single-slice capture:
  python3 scripts/capture_kiwisdr.py \
      --host w7dq.proxy.kiwisdr.com --port 8073 \
      --freq-khz 14235 --duration 25 \
      --out /tmp/20m_iq.wav
"""

import argparse
import base64
import concurrent.futures
import hashlib
import json
import math
import os
import select
import socket
import ssl
import struct
import sys
import time
import urllib.parse
import wave

SND_FLAG_ADC_OVFL = 0x02
SND_FLAG_STEREO = 0x08
SND_FLAG_COMPRESSED = 0x10
SND_FLAG_LITTLE_ENDIAN = 0x80


def _open_tcp(host: str, port: int, timeout: float = 10.0) -> socket.socket:
    proxy_url = (
        os.environ.get("HTTP_PROXY")
        or os.environ.get("http_proxy")
        or os.environ.get("HTTPS_PROXY")
        or os.environ.get("https_proxy")
    )
    no_proxy = os.environ.get("NO_PROXY") or os.environ.get("no_proxy") or ""
    bypass = any(
        entry.strip() and (host == entry.strip() or host.endswith("." + entry.strip().lstrip(".")))
        for entry in no_proxy.split(",")
    )

    if proxy_url and not bypass:
        parsed = urllib.parse.urlparse(proxy_url)
        proxy_host = parsed.hostname
        proxy_port = parsed.port or 8080
        sock = socket.create_connection((proxy_host, proxy_port), timeout=timeout)
        connect_req = (
            f"CONNECT {host}:{port} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            f"User-Agent: k4-js-kiwisdr-capture/1.0\r\n"
            f"\r\n"
        )
        sock.sendall(connect_req.encode("ascii"))
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = sock.recv(4096)
            if not chunk:
                sock.close()
                raise RuntimeError("Proxy closed connection during CONNECT")
            resp += chunk
        status_line = resp.split(b"\r\n", 1)[0].decode("latin-1", errors="replace")
        if " 200 " not in status_line:
            sock.close()
            raise RuntimeError(f"Proxy CONNECT failed: {status_line}")
        return sock

    return socket.create_connection((host, port), timeout=timeout)


class SimpleWebSocket:
    """Minimal RFC 6455 client WebSocket over a connected socket (ws:// or wss://)."""

    def __init__(self, host: str, port: int, path: str, tls: bool = False, timeout: float = 10.0):
        raw_sock = _open_tcp(host, port, timeout=timeout)
        raw_sock.settimeout(timeout)
        if tls:
            ctx = ssl.create_default_context()
            self.sock = ctx.wrap_socket(raw_sock, server_hostname=host)
        else:
            self.sock = raw_sock
        self._buf = bytearray()

        default_port = 443 if tls else 80
        scheme = "https" if tls else "http"
        host_hdr = host if port == default_port else f"{host}:{port}"
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host_hdr}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n"
            f"Origin: {scheme}://{host_hdr}\r\n"
            f"User-Agent: Mozilla/5.0 k4-js-demo-capture/1.0\r\n"
            f"\r\n"
        )
        self.sock.sendall(req.encode("ascii"))

        header_end = -1
        while header_end == -1:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("Socket closed during WebSocket handshake")
            self._buf.extend(chunk)
            header_end = self._buf.find(b"\r\n\r\n")

        header_bytes = bytes(self._buf[:header_end])
        del self._buf[: header_end + 4]

        lines = header_bytes.decode("latin-1", errors="replace").split("\r\n")
        if not lines or " 101 " not in lines[0]:
            raise RuntimeError(f"WebSocket upgrade rejected: {lines[0] if lines else 'empty'}")

        expected_accept = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
        ).decode("ascii")
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        if headers.get("sec-websocket-accept") != expected_accept:
            raise RuntimeError("Invalid Sec-WebSocket-Accept from server")

    def _read_exact(self, n: int) -> bytes:
        while len(self._buf) < n:
            chunk = self.sock.recv(max(4096, n - len(self._buf)))
            if not chunk:
                raise EOFError("WebSocket closed")
            self._buf.extend(chunk)
        out = bytes(self._buf[:n])
        del self._buf[:n]
        return out

    def send_text(self, text: str) -> None:
        self._send_frame(0x1, text.encode("utf-8"))

    def send_pong(self, payload: bytes = b"") -> None:
        self._send_frame(0xA, payload)

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        mask = os.urandom(4)
        length = len(payload)
        header = bytearray([0x80 | (opcode & 0x0F)])
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        header.extend(mask)
        masked = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def recv(self, timeout: float = 5.0):
        """Return (opcode, payload_bytes) or None on timeout."""
        if not self._buf:
            r, _, _ = select.select([self.sock], [], [], timeout)
            if not r:
                return None

        while True:
            b1, b2 = self._read_exact(2)
            opcode = b1 & 0x0F
            masked = (b2 & 0x80) != 0
            length = b2 & 0x7F
            if length == 126:
                (length,) = struct.unpack("!H", self._read_exact(2))
            elif length == 127:
                (length,) = struct.unpack("!Q", self._read_exact(8))
            mask_key = self._read_exact(4) if masked else None
            payload = self._read_exact(length)
            if mask_key:
                payload = bytes(b ^ mask_key[i & 3] for i, b in enumerate(payload))

            if opcode == 0x9:  # Ping
                self.send_pong(payload)
                continue
            if opcode == 0x8:  # Close
                raise EOFError("Server sent WebSocket close")
            return opcode, payload

    def close(self) -> None:
        try:
            self._send_frame(0x8, b"")
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


def parse_host_spec(spec: str, default_port: int = 8073, default_tls: bool = False):
    s = spec.strip()
    tls = default_tls
    if s.startswith("https://") or s.startswith("wss://"):
        tls = True
        s = s.split("://", 1)[1]
    elif s.startswith("http://") or s.startswith("ws://"):
        s = s.split("://", 1)[1]
    s = s.split("/", 1)[0]
    if ":" in s:
        h, p = s.rsplit(":", 1)
        port = int(p)
    else:
        h = s
        port = 443 if tls else default_port
    return h, port, bool(tls or port == 443)


def capture_kiwisdr_iq(
    host: str,
    port: int,
    freq_khz: float,
    duration_sec: float,
    out_wav: str,
    password: str = "#",
    user: str = "k4-js-demo",
    tls: bool = False,
    timeout: float = 12.0,
) -> dict:
    ts = int(time.time())
    path = f"/{ts}/SND"
    proto = "wss" if tls else "ws"
    print(f"[kiwi] Connecting to {proto}://{host}:{port}{path} @ {freq_khz:.3f} kHz ...", flush=True)
    ws = SimpleWebSocket(host, port, path, tls=tls, timeout=timeout)

    sample_rate = None
    ar_sent = False
    iq_chunks = []
    total_frames = 0
    target_frames = None
    last_keepalive = time.monotonic()
    start_wall = time.monotonic()
    overflows = 0
    rssi_sum = 0.0
    rssi_count = 0

    try:
        ws.send_text(f"SET auth t=kiwi p={password}")
        ws.send_text(f"SET ident_user={user}")
        ws.send_text("SET keepalive")

        while True:
            now = time.monotonic()
            if now - last_keepalive >= 4.0:
                ws.send_text("SET keepalive")
                last_keepalive = now

            if not ar_sent and (now - start_wall) > timeout:
                raise RuntimeError("Timed out waiting for KiwiSDR sample_rate handshake")
            if ar_sent and (now - start_wall) > duration_sec + 25.0:
                raise RuntimeError("Timed out waiting for I/Q frames")

            item = ws.recv(timeout=2.0)
            if item is None:
                continue
            _, payload = item
            if len(payload) < 3:
                continue
            tag = payload[:3]
            body = payload[3:]

            if tag == b"MSG":
                text = body.decode("latin-1", errors="replace").strip()
                for pair in text.split(" "):
                    if "=" not in pair:
                        continue
                    k, v = pair.split("=", 1)
                    if k == "too_busy":
                        raise RuntimeError(f"KiwiSDR is busy (too_busy={v} channels in use)")
                    if k == "badp" and v != "0":
                        raise RuntimeError(f"KiwiSDR rejected password (badp={v})")
                    if k == "sample_rate":
                        try:
                            sr = float(v)
                            if sr > 1000:
                                sample_rate = int(round(sr))
                        except ValueError:
                            pass

                if sample_rate and not ar_sent:
                    half_bw = int(sample_rate * 0.48)
                    print(
                        f"[kiwi] {host}:{port} sample_rate={sample_rate} Hz (±{half_bw} Hz), recording {duration_sec:.1f}s @ {freq_khz:.3f} kHz",
                        flush=True,
                    )
                    ws.send_text(f"SET AR OK in={sample_rate} out={sample_rate}")
                    ws.send_text(f"SET mod=iq low_cut={-half_bw} high_cut={half_bw} freq={freq_khz:.3f}")
                    ws.send_text("SET compression=0")
                    ws.send_text("SET agc=0 hang=0 thresh=-100 slope=6 decay=1000 manGain=50")
                    ws.send_text("SET squelch=0 max=0")
                    ws.send_text("SET keepalive")
                    ar_sent = True
                    target_frames = int(round(sample_rate * duration_sec))
                    start_wall = time.monotonic()

            elif tag == b"SND" and ar_sent:
                if len(body) < 17:
                    continue
                flags, _seq = struct.unpack("<BI", body[0:5])
                (smeter,) = struct.unpack(">H", body[5:7])
                rssi = 0.1 * smeter - 127.0
                rssi_sum += rssi
                rssi_count += 1
                if flags & SND_FLAG_ADC_OVFL:
                    overflows += 1
                if not (flags & SND_FLAG_STEREO):
                    continue

                raw_iq = body[17:]
                n_samples = len(raw_iq) // 2
                n_frames = n_samples // 2
                if n_frames <= 0:
                    continue

                if flags & SND_FLAG_LITTLE_ENDIAN:
                    le_bytes = raw_iq[: n_frames * 4]
                else:
                    vals = struct.unpack(f">{n_frames * 2}h", raw_iq[: n_frames * 4])
                    le_bytes = struct.pack(f"<{n_frames * 2}h", *vals)

                iq_chunks.append(le_bytes)
                total_frames += n_frames

                if target_frames and total_frames >= target_frames:
                    break
    finally:
        ws.close()

    if not sample_rate or total_frames == 0:
        raise RuntimeError("No IQ frames captured from KiwiSDR")

    raw_all = b"".join(iq_chunks)
    if target_frames:
        raw_all = raw_all[: target_frames * 4]
        total_frames = len(raw_all) // 4

    os.makedirs(os.path.dirname(os.path.abspath(out_wav)), exist_ok=True)
    with wave.open(out_wav, "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(raw_all)

    meta = {
        "source": f"kiwisdr://{host}:{port}",
        "centerFreqHz": int(round(freq_khz * 1000.0)),
        "sampleRateHz": sample_rate,
        "frames": total_frames,
        "durationSec": round(total_frames / float(sample_rate), 3),
        "avgRssiDbm": round(rssi_sum / max(1, rssi_count), 1),
        "adcOverflows": overflows,
        "capturedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "wavPath": os.path.abspath(out_wav),
    }
    meta_path = os.path.splitext(out_wav)[0] + ".json"
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
        f.write("\n")

    print(
        f"[kiwi] Done {freq_khz:.1f} kHz: {meta['durationSec']}s @ {sample_rate} Hz "
        f"(RSSI {meta['avgRssiDbm']} dBm, OV {overflows}) -> {out_wav}",
        flush=True,
    )
    return meta


def capture_with_failover(
    host_list: list,
    start_idx: int,
    freq_khz: float,
    duration_sec: float,
    out_wav: str,
    password: str,
    timeout: float,
) -> dict:
    last_err = None
    for offset in range(len(host_list)):
        h, p, tls = host_list[(start_idx + offset) % len(host_list)]
        try:
            return capture_kiwisdr_iq(
                host=h,
                port=p,
                freq_khz=freq_khz,
                duration_sec=duration_sec,
                out_wav=out_wav,
                password=password,
                tls=tls,
                timeout=timeout,
            )
        except Exception as exc:
            last_err = exc
            print(f"[kiwi] {h}:{p} failed for {freq_khz:.1f} kHz ({exc}), trying next host...", file=sys.stderr, flush=True)
    raise RuntimeError(f"All hosts failed for {freq_khz:.1f} kHz: {last_err}")


def capture_sweep_on_host(
    host: str,
    port: int,
    tls: bool,
    centers_khz: list,
    start_idx: int,
    duration_sec: float,
    out_dir: str,
    tile_metas: list,
    password: str = "#",
    user: str = "k4-js-demo",
    timeout: float = 12.0,
    settle_sec: float = 0.65,
) -> int:
    """Capture remaining tiles [start_idx..] on a single persistent KiwiSDR connection."""
    ts = int(time.time())
    path = f"/{ts}/SND"
    proto = "wss" if tls else "ws"
    print(f"[kiwi] Opening persistent sweep session to {proto}://{host}:{port}{path} ...", flush=True)
    ws = SimpleWebSocket(host, port, path, tls=tls, timeout=timeout)

    sample_rate = None
    ar_sent = False
    last_keepalive = time.monotonic()
    idx = start_idx

    try:
        ws.send_text(f"SET auth t=kiwi p={password}")
        ws.send_text(f"SET ident_user={user}")
        ws.send_text("SET keepalive")

        handshake_start = time.monotonic()
        while not ar_sent:
            if time.monotonic() - handshake_start > timeout:
                raise RuntimeError("Timed out waiting for KiwiSDR sample_rate handshake")
            item = ws.recv(timeout=2.0)
            if item is None:
                continue
            _, payload = item
            if len(payload) < 3 or payload[:3] != b"MSG":
                continue
            text = payload[3:].decode("latin-1", errors="replace").strip()
            for pair in text.split(" "):
                if "=" not in pair:
                    continue
                k, v = pair.split("=", 1)
                if k == "too_busy":
                    raise RuntimeError(f"KiwiSDR is busy (too_busy={v})")
                if k == "badp" and v != "0":
                    raise RuntimeError(f"KiwiSDR rejected password (badp={v})")
                if k == "sample_rate":
                    try:
                        sr = float(v)
                        if sr > 1000:
                            sample_rate = int(round(sr))
                    except ValueError:
                        pass
            if sample_rate:
                ws.send_text(f"SET AR OK in={sample_rate} out={sample_rate}")
                ws.send_text("SET compression=0")
                ws.send_text("SET agc=0 hang=0 thresh=-100 slope=6 decay=1000 manGain=50")
                ws.send_text("SET squelch=0 max=0")
                ws.send_text("SET keepalive")
                ar_sent = True

        half_bw = int(sample_rate * 0.48)
        settle_frames = int(round(sample_rate * settle_sec))
        target_frames = int(round(sample_rate * duration_sec))
        print(f"[kiwi] Connected to {host}:{port} (sample_rate={sample_rate} Hz, ±{half_bw} Hz)", flush=True)

        while idx < len(centers_khz):
            freq_khz = centers_khz[idx]
            ws.send_text(f"SET mod=iq low_cut={-half_bw} high_cut={half_bw} freq={freq_khz:.3f}")
            ws.send_text("SET keepalive")
            print(
                f"[sweep] Tile {idx + 1}/{len(centers_khz)}: {freq_khz:.1f} kHz ({duration_sec:.1f}s)...",
                flush=True,
            )

            settled = 0
            iq_chunks = []
            total_frames = 0
            overflows = 0
            rssi_sum = 0.0
            rssi_count = 0
            tile_start = time.monotonic()

            while total_frames < target_frames:
                now = time.monotonic()
                if now - last_keepalive >= 3.5:
                    ws.send_text("SET keepalive")
                    last_keepalive = now
                if now - tile_start > duration_sec + 25.0:
                    raise RuntimeError(f"Timed out capturing tile {idx} @ {freq_khz:.1f} kHz")

                item = ws.recv(timeout=2.0)
                if item is None:
                    continue
                _, payload = item
                if len(payload) < 3:
                    continue
                tag = payload[:3]
                body = payload[3:]
                if tag == b"MSG":
                    text = body.decode("latin-1", errors="replace").strip()
                    for pair in text.split(" "):
                        if "=" not in pair:
                            continue
                        k, v = pair.split("=", 1)
                        if k == "too_busy":
                            raise RuntimeError(f"KiwiSDR is busy (too_busy={v})")
                        if k == "inactivity_timeout":
                            raise RuntimeError(f"KiwiSDR inactivity timeout ({v})")
                    continue
                if tag != b"SND" or len(body) < 17:
                    continue

                flags, _seq = struct.unpack("<BI", body[0:5])
                (smeter,) = struct.unpack(">H", body[5:7])
                if not (flags & SND_FLAG_STEREO):
                    continue

                raw_iq = body[17:]
                n_frames = (len(raw_iq) // 2) // 2
                if n_frames <= 0:
                    continue

                # Discard initial retune transient frames
                if settled < settle_frames:
                    settled += n_frames
                    continue

                rssi_sum += 0.1 * smeter - 127.0
                rssi_count += 1
                if flags & SND_FLAG_ADC_OVFL:
                    overflows += 1

                if flags & SND_FLAG_LITTLE_ENDIAN:
                    le_bytes = raw_iq[: n_frames * 4]
                else:
                    vals = struct.unpack(f">{n_frames * 2}h", raw_iq[: n_frames * 4])
                    le_bytes = struct.pack(f"<{n_frames * 2}h", *vals)

                iq_chunks.append(le_bytes)
                total_frames += n_frames

            raw_all = b"".join(iq_chunks)[: target_frames * 4]
            actual_frames = len(raw_all) // 4
            out_wav = os.path.join(out_dir, f"tile_{idx:02d}.wav")
            with wave.open(out_wav, "wb") as wf:
                wf.setnchannels(2)
                wf.setsampwidth(2)
                wf.setframerate(sample_rate)
                wf.writeframes(raw_all)

            meta = {
                "source": f"kiwisdr://{host}:{port}",
                "centerFreqHz": int(round(freq_khz * 1000.0)),
                "sampleRateHz": sample_rate,
                "frames": actual_frames,
                "durationSec": round(actual_frames / float(sample_rate), 3),
                "avgRssiDbm": round(rssi_sum / max(1, rssi_count), 1),
                "adcOverflows": overflows,
                "capturedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "wavPath": os.path.abspath(out_wav),
            }
            with open(os.path.splitext(out_wav)[0] + ".json", "w", encoding="utf-8") as f:
                json.dump(meta, f, indent=2)
                f.write("\n")

            tile_metas[idx] = meta
            print(
                f"[sweep] Saved tile_{idx:02d}.wav ({meta['durationSec']}s @ {sample_rate} Hz, "
                f"RSSI {meta['avgRssiDbm']} dBm)",
                flush=True,
            )
            idx += 1

        return idx
    finally:
        ws.close()


def run_sweep(args, host_list: list) -> int:
    os.makedirs(args.out_dir, exist_ok=True)
    step_khz = args.step_khz if args.step_khz > 0 else 18.0
    n_tiles = max(1, int(math.ceil(args.span_khz / step_khz)))
    first_center_khz = args.start_khz + step_khz * 0.5
    centers_khz = [round(first_center_khz + i * step_khz, 3) for i in range(n_tiles)]

    print(
        f"[sweep] Capturing {n_tiles} tiles across {args.start_khz:.1f}–{args.start_khz + n_tiles * step_khz:.1f} kHz "
        f"(step {step_khz:.1f} kHz, {args.duration:.1f}s/tile, single persistent connection per host)",
        flush=True,
    )

    tile_metas = [None] * n_tiles
    next_idx = 0
    last_err = None

    for h, p, tls in host_list:
        if next_idx >= n_tiles:
            break
        try:
            next_idx = capture_sweep_on_host(
                host=h,
                port=p,
                tls=tls,
                centers_khz=centers_khz,
                start_idx=next_idx,
                duration_sec=args.duration,
                out_dir=args.out_dir,
                tile_metas=tile_metas,
                password=args.password,
                timeout=args.timeout,
            )
        except Exception as exc:
            last_err = exc
            print(
                f"[sweep] {h}:{p} stopped at tile {next_idx}/{n_tiles} ({exc}); trying next host...",
                file=sys.stderr,
                flush=True,
            )

    if next_idx < n_tiles:
        raise RuntimeError(f"Sweep incomplete ({next_idx}/{n_tiles} tiles captured): {last_err}")

    sweep_index = {
        "version": 1,
        "startKhz": args.start_khz,
        "spanKhz": args.span_khz,
        "stepKhz": step_khz,
        "capturedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tiles": tile_metas,
    }
    sweep_path = os.path.join(args.out_dir, "sweep.json")
    with open(sweep_path, "w", encoding="utf-8") as f:
        json.dump(sweep_index, f, indent=2)
        f.write("\n")

    print(f"[sweep] Complete! Wrote {sweep_path} ({n_tiles} tiles)", flush=True)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Capture uncompressed complex I/Q WAV(s) from public KiwiSDR(s)")
    ap.add_argument("--host", help="Single KiwiSDR hostname or IP")
    ap.add_argument("--port", type=int, default=8073, help="KiwiSDR port (default: 8073)")
    ap.add_argument("--hosts", help="Comma-separated list of host[:port] for failover or parallel sweep")
    ap.add_argument("--freq-khz", type=float, help="Center frequency in kHz for single-slice capture")
    ap.add_argument("--start-khz", type=float, help="Start frequency in kHz for multi-tile sweep")
    ap.add_argument("--span-khz", type=float, help="Total span in kHz for multi-tile sweep (e.g. 145)")
    ap.add_argument("--step-khz", type=float, default=18.0, help="Tile spacing in kHz (default: 18.0 for 20.25 kHz Kiwis; use 10.5 for 12 kHz)")
    ap.add_argument("--parallel", type=int, default=1, help="Concurrent tile captures across --hosts (default: 1)")
    ap.add_argument("--duration", type=float, default=15.0, help="Recording duration per slice in seconds (default: 15)")
    ap.add_argument("--out", help="Output stereo 16-bit I/Q WAV path (single-slice mode)")
    ap.add_argument("--out-dir", help="Output directory for multi-tile sweep (sweep mode)")
    ap.add_argument("--password", default="#", help="KiwiSDR password if required (default: #)")
    ap.add_argument("--tls", action="store_true", help="Use wss:// TLS (auto-enabled when port is 443)")
    ap.add_argument("--timeout", type=float, default=12.0, help="Connection/handshake timeout in seconds")
    args = ap.parse_args()

    host_list = []
    if args.hosts:
        for item in args.hosts.split(","):
            if item.strip():
                host_list.append(parse_host_spec(item, default_port=args.port, default_tls=args.tls))
    elif args.host:
        host_list.append(parse_host_spec(args.host, default_port=args.port, default_tls=args.tls))
    else:
        ap.error("Provide --host or --hosts")

    try:
        if args.start_khz is not None and args.span_khz is not None:
            if not args.out_dir:
                ap.error("Sweep mode requires --out-dir")
            return run_sweep(args, host_list)

        if args.freq_khz is None or not args.out:
            ap.error("Provide either (--freq-khz and --out) or (--start-khz, --span-khz, and --out-dir)")

        capture_with_failover(
            host_list=host_list,
            start_idx=0,
            freq_khz=args.freq_khz,
            duration_sec=args.duration,
            out_wav=args.out,
            password=args.password,
            timeout=args.timeout,
        )
        return 0
    except Exception as exc:
        print(f"[kiwi] ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
