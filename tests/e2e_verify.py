#!/usr/bin/env python3
"""
End-to-end headless Firefox verification suite for Elecraft K4 Web Observatory.
Pure Python 3 stdlib (Marionette TCP protocol + HTTP /debug/stats + subprocesses).
"""

import argparse
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request


REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
WEB_DIR = os.path.join(REPO_ROOT, "web")
SIM_DIR = os.path.join(REPO_ROOT, "sim")


def pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def wait_tcp(host: str, port: int, timeout: float = 15.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.1)
    raise TimeoutError(f"TCP port {host}:{port} did not become ready within {timeout}s")


def wait_until(pred, desc: str, timeout: float = 12.0, interval: float = 0.1):
    deadline = time.monotonic() + timeout
    last_val = None
    last_err = None
    while time.monotonic() < deadline:
        try:
            val = pred()
            last_val = val
            if val:
                return val
        except Exception as exc:
            last_err = exc
        time.sleep(interval)
    raise AssertionError(
        f"Timed out waiting for {desc} after {timeout}s (last_val={last_val!r}, last_err={last_err!r})"
    )


def http_get_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=3.0) as resp:
        if resp.status != 200:
            raise AssertionError(f"GET {url} returned HTTP {resp.status}")
        return json.loads(resp.read().decode("utf-8"))


class MarionetteClient:
    """Minimal pure-stdlib Firefox Marionette v3 TCP JSON client."""

    def __init__(self, host: str, port: int, timeout: float = 15.0):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.settimeout(timeout)
        self._buf = b""
        self._msg_id = 0
        self.hello = self._recv_packet()
        if "marionetteProtocol" not in self.hello:
            raise RuntimeError(f"Unexpected Marionette greeting: {self.hello}")

    def _recv_packet(self):
        while b":" not in self._buf:
            chunk = self.sock.recv(8192)
            if not chunk:
                raise ConnectionError("Marionette socket closed while reading header")
            self._buf += chunk
        len_bytes, rest = self._buf.split(b":", 1)
        length = int(len_bytes)
        while len(rest) < length:
            chunk = self.sock.recv(8192)
            if not chunk:
                raise ConnectionError("Marionette socket closed while reading payload")
            rest += chunk
        payload = rest[:length]
        self._buf = rest[length:]
        return json.loads(payload.decode("utf-8"))

    def command(self, name: str, params: dict | None = None):
        self._msg_id += 1
        req_id = self._msg_id
        encoded = json.dumps([0, req_id, name, params or {}]).encode("utf-8")
        frame = f"{len(encoded)}:".encode("ascii") + encoded
        self.sock.sendall(frame)
        while True:
            msg = self._recv_packet()
            if isinstance(msg, list) and len(msg) == 4 and msg[0] == 1 and msg[1] == req_id:
                if msg[2] is not None:
                    raise RuntimeError(f"Marionette {name} error: {msg[2]}")
                return msg[3]

    def new_session(self):
        return self.command("WebDriver:NewSession", {"capabilities": {}})

    def delete_session(self):
        try:
            self.command("WebDriver:DeleteSession", {})
        except Exception:
            pass

    def navigate(self, url: str):
        self.command("WebDriver:Navigate", {"url": url})

    def execute_script(self, script: str, args: list | None = None):
        res = self.command(
            "WebDriver:ExecuteScript",
            {"script": script, "args": args or []},
        )
        return res.get("value")

    def set_window_rect(self, width: int, height: int):
        return self.command(
            "WebDriver:SetWindowRect",
            {"width": int(width), "height": int(height)},
        )

    def find_element(self, css: str):
        res = self.command(
            "WebDriver:FindElement",
            {"using": "css selector", "value": css},
        )
        return res["value"]

    def click_element(self, elem_ref: dict):
        el_id = next(iter(elem_ref.values()))
        return self.command("WebDriver:ElementClick", {"id": el_id})

    def send_keys(self, elem_ref: dict, text: str):
        el_id = next(iter(elem_ref.values()))
        return self.command("WebDriver:ElementSendKeys", {"id": el_id, "text": text})

    def clear_and_type(self, css: str, text: str):
        el = self.find_element(css)
        el_id = next(iter(el.values()))
        self.command("WebDriver:ElementClear", {"id": el_id})
        self.command("WebDriver:ElementSendKeys", {"id": el_id, "text": text})

    def perform_actions(self, actions: list[dict]):
        return self.command("WebDriver:PerformActions", {"actions": actions})

    def release_actions(self):
        return self.command("WebDriver:ReleaseActions", {})

    def take_screenshot(self, out_path: str):
        res = self.command("WebDriver:TakeScreenshot", {"full": False})
        raw_png = base64.b64decode(res["value"])
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "wb") as f:
            f.write(raw_png)

    def reset_console_errors(self):
        self.command("Marionette:SetContext", {"value": "chrome"})
        try:
            self.execute_script("Services.console.reset();")
        finally:
            self.command("Marionette:SetContext", {"value": "content"})

    def collect_console_errors(self) -> list[dict]:
        page_errors = self.execute_script("return window.__k4E2ePageErrors || [];") or []
        self.command("Marionette:SetContext", {"value": "chrome"})
        try:
            gecko_errors = (
                self.execute_script(
                    """
                    const arr = Services.console.getMessageArray();
                    const errs = [];
                    for (const m of arr) {
                      if (m instanceof Ci.nsIScriptError && (m.flags & Ci.nsIScriptError.errorFlag)) {
                        const src = m.sourceName || '';
                        if (src.startsWith('file://') || src.startsWith('http://')) {
                          errs.push({
                            source: 'gecko',
                            message: m.errorMessage,
                            file: src,
                            line: m.lineNumber,
                          });
                        }
                      }
                    }
                    return errs;
                    """
                )
                or []
            )
        finally:
            self.command("Marionette:SetContext", {"value": "content"})
        return list(gecko_errors) + list(page_errors)

    def install_page_error_trap(self):
        self.execute_script(
            """
            if (!window.__k4E2eTrapInstalled) {
              window.__k4E2eTrapInstalled = true;
              window.__k4E2ePageErrors = [];
              window.addEventListener('error', (e) => {
                window.__k4E2ePageErrors.push({
                  source: 'window.error',
                  message: e.message || String(e.error || 'Error'),
                });
              });
              window.addEventListener('unhandledrejection', (e) => {
                window.__k4E2ePageErrors.push({
                  source: 'unhandledrejection',
                  message: String(e.reason),
                });
              });
              const origErr = console.error.bind(console);
              console.error = function(...args) {
                window.__k4E2ePageErrors.push({
                  source: 'console.error',
                  message: args.map(String).join(' '),
                });
                return origErr(...args);
              };
            }
            """
        )

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


def verify_non_uniform_canvas(client: MarionetteClient) -> dict:
    info = client.execute_script(
        """
        const stage = document.getElementById('pan-stage');
        const glCanvas = document.querySelector('.k4-pan-gl');
        const ovCanvas = document.querySelector('.k4-pan-overlay');
        if (!glCanvas || !ovCanvas) return { ok: false, reason: 'missing canvases' };

        function inspectCanvas(c) {
          const w = c.width;
          const h = c.height;
          if (w <= 0 || h <= 0) return { w, h, distinct: 0 };
          const probe = document.createElement('canvas');
          const pw = Math.min(w, 240);
          const ph = Math.min(h, 160);
          probe.width = pw;
          probe.height = ph;
          const ctx = probe.getContext('2d');
          ctx.drawImage(c, 0, 0, pw, ph);
          const data = ctx.getImageData(0, 0, pw, ph).data;
          const seen = new Set();
          for (let i = 0; i < data.length; i += 16) {
            const key = (data[i] >> 2) + ',' + (data[i + 1] >> 2) + ',' + (data[i + 2] >> 2);
            seen.add(key);
            if (seen.size > 24) break;
          }
          return { w, h, distinct: seen.size };
        }

        return {
          ok: true,
          renderer: stage ? stage.dataset.renderer : '',
          frames: stage ? parseInt(stage.dataset.frames || '0', 10) : 0,
          gl: inspectCanvas(glCanvas),
          overlay: inspectCanvas(ovCanvas),
        };
        """
    )
    assert info and info.get("ok"), f"Canvas probe failed: {info}"
    assert info["frames"] >= 20, f"Expected >= 20 panadapter frames, got {info['frames']}"
    assert info["gl"]["distinct"] >= 4, f"GL/2D panadapter canvas appears uniform: {info}"
    assert info["overlay"]["distinct"] >= 3, f"Overlay canvas appears uniform: {info}"
    return info


def pan_click_action(client: MarionetteClient, x_frac: float, y_frac: float, button: int = 0, shift: bool = False):
    coords = client.execute_script(
        """
        const el = document.querySelector('[data-testid="pan-canvas"]');
        const r = el.getBoundingClientRect();
        return {
          x: Math.round(r.left + r.width * arguments[0]),
          y: Math.round(r.top + r.height * arguments[1]),
          left: r.left,
          width: r.width,
        };
        """,
        [x_frac, y_frac],
    )
    actions = []
    if shift:
        actions.append(
            {
                "type": "key",
                "id": "keyboard",
                "actions": [
                    {"type": "keyDown", "value": "\uE008"},
                    {"type": "pause", "duration": 40},
                    {"type": "keyUp", "value": "\uE008"},
                ],
            }
        )
        # Hold shift across pointer move/down/up
        actions = [
            {
                "type": "key",
                "id": "keyboard",
                "actions": [
                    {"type": "keyDown", "value": "\uE008"},
                    {"type": "pause", "duration": 20},
                    {"type": "pause", "duration": 20},
                    {"type": "pause", "duration": 20},
                    {"type": "keyUp", "value": "\uE008"},
                ],
            },
            {
                "type": "pointer",
                "id": "mouse",
                "parameters": {"pointerType": "mouse"},
                "actions": [
                    {"type": "pointerMove", "duration": 0, "x": coords["x"], "y": coords["y"], "origin": "viewport"},
                    {"type": "pause", "duration": 10},
                    {"type": "pointerDown", "button": button},
                    {"type": "pointerUp", "button": button},
                    {"type": "pause", "duration": 10},
                ],
            },
        ]
    else:
        actions = [
            {
                "type": "pointer",
                "id": "mouse",
                "parameters": {"pointerType": "mouse"},
                "actions": [
                    {"type": "pointerMove", "duration": 0, "x": coords["x"], "y": coords["y"], "origin": "viewport"},
                    {"type": "pointerDown", "button": button},
                    {"type": "pointerUp", "button": button},
                ],
            }
        ]
    client.perform_actions(actions)
    client.release_actions()
    return coords


def connect_via_ui(client: MarionetteClient, ws_url: str, password: str):
    wait_until(
        lambda: client.execute_script(
            "const d = document.querySelector('[data-testid=\"conn-dialog\"]'); return d && d.dataset.open === 'true';"
        ),
        "connection dialog open",
    )
    client.clear_and_type('[data-testid="ws-url-input"]', ws_url)
    client.clear_and_type('[data-testid="password-input"]', password)
    client.click_element(client.find_element('[data-testid="connect-submit"]'))

    try:
        wait_until(
            lambda: client.execute_script(
                """
                const btn = document.querySelector('[data-testid="conn-btn"]');
                const snap = globalThis.k4App && globalThis.k4App.state.getSnapshot();
                return btn && btn.dataset.status === 'connected' &&
                       snap && snap.connection.authStatus === 'authenticated';
                """
            ),
            "authenticated WebSocket connection",
        )
    except AssertionError as e:
        diag = client.execute_script(
            """
            const snap = globalThis.k4App && globalThis.k4App.state.getSnapshot();
            return {
              wsInput: document.querySelector('[data-testid="ws-url-input"]')?.value,
              btnStatus: document.querySelector('[data-testid="conn-btn"]')?.dataset.status,
              connection: snap ? snap.connection : null,
              metrics: globalThis.k4App && globalThis.k4App.client.getMetrics(),
            };
            """
        )
        errs = client.collect_console_errors()
        raise AssertionError(f"{e} | diag={diag} | console={errs}") from None


def run_browser_unit_tests(client: MarionetteClient):
    print("[1/3] Running browser unit tests on file:///.../web/test.html ...")
    client.reset_console_errors()
    test_url = "file://" + os.path.join(WEB_DIR, "test.html")
    client.navigate(test_url)
    client.install_page_error_trap()

    results = wait_until(
        lambda: client.execute_script("return window.__K4_TEST_RESULTS__ || null;"),
        "window.__K4_TEST_RESULTS__",
    )
    assert results["total"] >= 28, f"Expected >= 28 unit tests, got {results}"
    assert results["failed"] == 0, f"Browser unit tests failed: {results}"
    errs = client.collect_console_errors()
    assert not errs, f"Console errors during test.html: {errs}"
    print(f"      PASS: {results['passed']}/{results['total']} unit tests passed, 0 console errors")


def run_file_origin_e2e(client: MarionetteClient, ws_url: str, password: str, stats_url: str):
    print("[2/3] Running full E2E verification on file:///.../web/index.html ...")
    client.set_window_rect(1440, 900)
    client.reset_console_errors()
    index_url = "file://" + os.path.join(WEB_DIR, "index.html")
    client.navigate(index_url)
    client.install_page_error_trap()

    proto = client.execute_script("return window.location.protocol;")
    assert proto == "file:", f"Expected file: protocol, got {proto}"
    pure_sha_ok = client.execute_script(
        "return window.K4 && window.K4.sha384HexSync('abc') === 'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7';"
    )
    assert pure_sha_ok, "Expected pure-JS K4.sha384HexSync to work on file://"

    connect_via_ui(client, ws_url, password)

    # Verify initial state hydration & S-meter
    wait_until(
        lambda: client.execute_script(
            """
            const fa = document.querySelector('[data-testid="vfo-a-freq"]');
            const fb = document.querySelector('[data-testid="vfo-b-freq"]');
            const ma = document.querySelector('[data-testid="vfo-a-mode"]');
            const sm = document.querySelector('[data-testid="smeter-dbm"]');
            return fa && fa.dataset.freqHz === '14074000' &&
                   fa.textContent.startsWith('14.074.000') &&
                   fb && fb.dataset.freqHz === '14025000' &&
                   fb.textContent.startsWith('14.025.000') &&
                   ma && ma.textContent === 'DATA-A' &&
                   sm && sm.textContent.includes('dBm');
            """
        ),
        "initial VFO A/B and S-meter hydration",
    )

    # Verify active spectrum/waterfall rendering (>= 20 frames & non-uniform canvas pixels)
    wait_until(
        lambda: client.execute_script(
            "const s = document.getElementById('pan-stage'); return s && parseInt(s.dataset.frames || '0', 10) >= 20;"
        ),
        "framesRendered >= 20",
        timeout=10.0,
    )
    canvas_info = verify_non_uniform_canvas(client)
    print(f"      Spectrum/WF live on file://: renderer={canvas_info['renderer']}, frames={canvas_info['frames']}")

    # Click-to-tune VFO A off-center (75% across 48 kHz span centered at 14074000 -> ~14086000)
    pan_click_action(client, 0.75, 0.25, button=0, shift=False)
    wait_until(
        lambda: http_get_json(stats_url)["faHz"] != 14074000,
        "VFO A click-to-tune FA change in simulator",
    )
    fa_after_click = http_get_json(stats_url)["faHz"]
    assert 14084000 <= fa_after_click <= 14088000, f"Unexpected FA after 0.75 click: {fa_after_click}"

    # Switch VFO A to CW and test CW -500 Hz click-to-tune offset!
    client.execute_script("globalThis.k4App.client.setMode('A', 'CW');")
    wait_until(
        lambda: http_get_json(stats_url)["modeA"] == 3,
        "simulator modeA == 3 (CW)",
    )
    # Wait for 0x02 PAN centerFreqHz == FA in CW mode (real K4 firmware R40.B1 behavior)
    wait_until(
        lambda: client.execute_script(
            """
            const m = globalThis.k4App.panadapter.getMetrics();
            const s = globalThis.k4App.state.getSnapshot();
            return s.rxA.mode === 3 && Math.abs(m.panCenterHz - s.rxA.freqHz) < 10;
            """
        ),
        "CW 0x02 PAN centerFreqHz == freqHz",
    )
    cw_center = client.execute_script("return globalThis.k4App.panadapter.getMetrics().panCenterHz;")
    # Click center of panadapter (0.50): in CW mode with 500 Hz pitch, dial MUST snap to cw_center - 500
    pan_click_action(client, 0.50, 0.25, button=0, shift=False)
    expected_cw_dial = cw_center - 500
    wait_until(
        lambda: abs(http_get_json(stats_url)["faHz"] - expected_cw_dial) <= 100,
        f"CW center click reverses +500 Hz pitch toward {expected_cw_dial}",
    )
    fa_cw_clicked = http_get_json(stats_url)["faHz"]
    assert abs(fa_cw_clicked - expected_cw_dial) <= 100, (
        f"CW click-to-tune expected ~{expected_cw_dial} (-500 Hz offset from {cw_center}), got {fa_cw_clicked}"
    )

    # Shift-click tunes VFO B without moving VFO A
    fa_before_sub = fa_cw_clicked
    pan_click_action(client, 0.30, 0.25, button=0, shift=True)
    wait_until(
        lambda: http_get_json(stats_url)["fbHz"] != 14025000,
        "Shift-click tunes VFO B (FB)",
    )
    fb_after_shift = http_get_json(stats_url)["fbHz"]
    assert http_get_json(stats_url)["faHz"] == fa_before_sub, "Shift-click must not change VFO A"

    # Right-click tunes VFO B cleanly without moving VFO A (and switches mouse target to B)
    pan_click_action(client, 0.70, 0.25, button=2, shift=False)
    wait_until(
        lambda: http_get_json(stats_url)["fbHz"] != fb_after_shift and
        client.execute_script("return globalThis.k4App._targetRx === 'B';"),
        "Right-click tunes VFO B (FB) and selects VFO B mouse target",
    )
    assert http_get_json(stats_url)["faHz"] == fa_before_sub, "Right-click must not change VFO A"
    fb_after_right = http_get_json(stats_url)["fbHz"]

    # Plain left-click MUST tune VFO A (even after VFO B was targeted!) and switch mouse target back to A
    pan_click_action(client, 0.60, 0.25, button=0, shift=False)
    wait_until(
        lambda: http_get_json(stats_url)["faHz"] != fa_before_sub and
        client.execute_script("return globalThis.k4App._targetRx === 'A';"),
        "Left-click tunes VFO A even after VFO B was targeted",
    )
    assert http_get_json(stats_url)["fbHz"] == fb_after_right, "Left-click must not change VFO B"
    fa_before_lock = http_get_json(stats_url)["faHz"]

    # VFO A Lock (LK1) blocks accidental panadapter left-click QSY until unlocked (LK0)
    client.execute_script("globalThis.k4App.client.setLock('A', true);")
    wait_until(
        lambda: client.execute_script("return globalThis.k4App.state.getSnapshot().rxA.locked === true;"),
        "VFO A lock enabled (LK1)",
    )
    pan_click_action(client, 0.40, 0.25, button=0, shift=False)
    time.sleep(0.25)
    assert http_get_json(stats_url)["faHz"] == fa_before_lock, "LK1 must block left-click panadapter QSY on VFO A"
    client.execute_script("globalThis.k4App.client.setLock('A', false);")
    wait_until(
        lambda: client.execute_script("return globalThis.k4App.state.getSnapshot().rxA.locked === false;"),
        "VFO A lock cleared (LK0)",
    )

    # Map-style cursor-anchored Ctrl+wheel zoom + HUD Center button
    pre_zoom = client.execute_script(
        """
        const surf = document.querySelector('.k4-pan-surface');
        const rect = surf.getBoundingClientRect();
        const frame = globalThis.k4App.panadapter.getFrameState().panes.A;
        const layout = globalThis.k4App.panadapter._renderer.getLayouts()[0];
        const xPx = layout.specRect.x + layout.specRect.w * 0.75;
        const anchorRf = K4.SpectrumGeometry.rfFreqFromX(xPx, layout.specRect.x, layout.specRect.w, frame.panCenterHz, frame.userSpanHz);
        surf.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -120,
          clientX: rect.left + xPx,
          clientY: rect.top + layout.specRect.y + 40,
        }));
        const postFrame = globalThis.k4App.panadapter.getFrameState().panes.A;
        const postAnchorRf = K4.SpectrumGeometry.rfFreqFromX(xPx, layout.specRect.x, layout.specRect.w, postFrame.panCenterHz, postFrame.userSpanHz);
        return {
          preSpan: frame.userSpanHz,
          postSpan: postFrame.userSpanHz,
          anchorRf,
          postAnchorRf,
          isOffset: globalThis.k4App.panadapter.isViewportOffset('A'),
        };
        """
    )
    assert pre_zoom["postSpan"] < pre_zoom["preSpan"], f"Ctrl+wheel did not zoom in: {pre_zoom}"
    assert pre_zoom["isOffset"] is True, f"Off-center Ctrl+wheel did not mark viewport offset: {pre_zoom}"
    assert abs(pre_zoom["postAnchorRf"] - pre_zoom["anchorRf"]) <= 50, (
        f"Ctrl+wheel shifted anchor RF: {pre_zoom}"
    )
    assert http_get_json(stats_url)["faHz"] == fa_before_lock, "Ctrl+wheel map zoom must not detune VFO A"
    wait_until(
        lambda: client.execute_script(
            "const b = document.querySelector('[data-testid=\"hud-center-btn\"]'); return b && b.hidden === false;"
        ),
        "HUD Center button becomes visible when zoomed off-center",
    )
    client.click_element(client.find_element('[data-testid="hud-center-btn"]'))
    wait_until(
        lambda: client.execute_script(
            "const b = document.querySelector('[data-testid=\"hud-center-btn\"]'); return !globalThis.k4App.panadapter.isViewportOffset('A') && b && b.hidden === true;"
        ),
        "HUD Center button re-centers viewport and hides",
    )

    # Cmd/Ctrl+K Omnibar jump to 7.074 (7074000 Hz)
    client.click_element(client.find_element('[data-testid="omnibar-btn"]'))
    wait_until(
        lambda: client.execute_script(
            "const m = document.querySelector('[data-testid=\"omnibar-modal\"]'); return m && m.dataset.open === 'true';"
        ),
        "omnibar modal open",
    )
    client.clear_and_type('[data-testid="omnibar-input"]', "7.074")
    client.send_keys(client.find_element('[data-testid="omnibar-input"]'), "\uE007")  # Enter
    wait_until(
        lambda: http_get_json(stats_url)["faHz"] == 7074000 and
        client.execute_script(
            "const f = document.querySelector('[data-testid=\"vfo-a-freq\"]'); return f && f.dataset.freqHz === '7074000' && f.textContent.startsWith('07.074.000');"
        ),
        "Omnibar 7.074 tunes VFO A to 7074000 Hz",
    )

    # Verify TB$ decoded text ticker preserved literal semicolons
    wait_until(
        lambda: client.execute_script(
            """
            const el = document.querySelector('[data-testid="text-ticker"]');
            const snap = globalThis.k4App.state.getSnapshot();
            const hasSemi = snap.decodedText.some((d) => d.text === 'CQ DE W6ELE K ; 73 ;');
            return hasSemi && el && el.textContent.includes('CQ DE W6ELE K ; 73 ;');
            """
        ),
        "TB$ decoded text ticker contains 'CQ DE W6ELE K ; 73 ;'",
    )

    # Item 2 Telemetry (SI*: supplyVolts + paTempC + Observatory diag readout)
    client.execute_script("globalThis.k4App.inspector.selectDesktopTab('audio');")
    wait_until(
        lambda: client.execute_script(
            """
            const snap = globalThis.k4App.state.getSnapshot();
            const supEl = document.querySelector('[data-testid="diag-supply"]');
            return snap.telemetry && snap.telemetry.supplyVolts > 12 &&
                   snap.telemetry.paTempC > 20 &&
                   supEl && supEl.textContent.includes('V');
            """
        ),
        "SI* telemetry hydrated into RadioState and Inspector diag-supply",
    )

    # Item 1 RIT (RT / RO / RC) + VFO Badge
    client.execute_script("globalThis.k4App.client.setRit('A', { on: true, offsetHz: 150 });")
    wait_until(
        lambda: client.execute_script(
            """
            const b = document.querySelector('[data-testid="vfo-A-rit-badge"]');
            return b && !b.hidden && b.textContent.includes('+150');
            """
        ),
        "VFO A RIT badge displays +150 when enabled",
    )
    client.execute_script("globalThis.k4App.client.clearRit('A');")
    wait_until(
        lambda: client.execute_script("return globalThis.k4App.state.getSnapshot().rxA.ritOffsetHz === 0;"),
        "RC clears VFO A RIT offset to 0",
    )
    client.execute_script("globalThis.k4App.client.setRit('A', { on: false });")

    # Item 1 ADC Overflow (PA21;RA000;RG00;OV;) + S-meter OVF badge
    client.execute_script("globalThis.k4App.client.sendCat('PA21;RA000;RG00;OV;');")
    wait_until(
        lambda: client.execute_script(
            """
            const b = document.querySelector('[data-testid="smeter-ovf-badge"]');
            return b && !b.hidden && globalThis.k4App.state.getSnapshot().rxA.adcOverflow === true;
            """
        ),
        "ADC Overflow OVF badge becomes visible on PA21",
    )
    client.execute_script("globalThis.k4App.client.sendCat('PA00;OV;');")
    wait_until(
        lambda: client.execute_script(
            """
            const b = document.querySelector('[data-testid="smeter-ovf-badge"]');
            return b && b.hidden && globalThis.k4App.state.getSnapshot().rxA.adcOverflow === false;
            """
        ),
        "ADC Overflow OVF badge clears on PA00",
    )

    # Item 1 Panadapter Freeze (#FRZ) HUD toggle & Display Mode (#DSM)
    client.click_element(client.find_element('[data-testid="hud-freeze-btn"]'))
    wait_until(
        lambda: client.execute_script(
            """
            const btn = document.querySelector('[data-testid="hud-freeze-btn"]');
            return globalThis.k4App.state.getSnapshot().panFrozen === true && btn && btn.textContent === 'Frozen';
            """
        ),
        "HUD Freeze button freezes panadapter (#FRZ1)",
    )
    client.click_element(client.find_element('[data-testid="hud-freeze-btn"]'))
    wait_until(
        lambda: client.execute_script("return globalThis.k4App.state.getSnapshot().panFrozen === false;"),
        "HUD Freeze button unfreezes panadapter (#FRZ0)",
    )

    client.execute_script("globalThis.k4App.client.setDisplay('A', { displayMode: 0 });")
    wait_until(
        lambda: client.execute_script("return globalThis.k4App.state.getSnapshot().displayMode === 0;"),
        "Display mode switches to Spectrum Only (#DSM0)",
    )
    client.execute_script("globalThis.k4App.client.setDisplay('A', { displayMode: 1 });")
    wait_until(
        lambda: client.execute_script("return globalThis.k4App.state.getSnapshot().displayMode === 1;"),
        "Display mode restores Spec + WF (#DSM1)",
    )

    # Item 2 AF Scope & Stereo 16-bit PCM .wav Clip Recorder
    client.execute_script("globalThis.k4App.audio.startRecording();")
    wait_until(
        lambda: client.execute_script("return globalThis.k4App.audio.getRecordingStatus().totalFrames > 1000;"),
        "AudioEngine records live k4sim PCM frames",
    )
    af_res = client.execute_script(
        """
        const rec = globalThis.k4App.audio.stopRecording();
        const spec = globalThis.k4App.audio.getAfSpectrum(3200);
        const hasCanvas = Boolean(document.querySelector('[data-testid="af-scope-canvas"]'));
        return {
          bytes: rec && rec.wavBytes ? rec.wavBytes.byteLength : 0,
          bins: spec && spec.binsDb ? spec.binsDb.length : 0,
          hasCanvas,
        };
        """
    )
    assert af_res["bytes"] > 4000, f"Expected WAV bytes > 4000, got {af_res}"
    assert af_res["bins"] > 20, f"Expected AF FFT bins > 20, got {af_res}"
    assert af_res["hasCanvas"] is True, f"AF Scope canvas missing: {af_res}"

    # Item 2 Bookmarks CRUD + recall via UI
    client.execute_script("globalThis.k4App.inspector.selectDesktopTab('band-mode');")
    client.clear_and_type('[data-testid="bookmark-label-input"]', "40m E2E")
    client.click_element(client.find_element('[data-testid="bookmark-save-btn"]'))
    wait_until(
        lambda: client.execute_script(
            "const l = document.querySelector('[data-testid=\"bookmark-list\"]'); return l && l.textContent.includes('40m E2E');"
        ),
        "Saved 40m E2E bookmark appears in list",
    )
    client.execute_script("globalThis.k4App.client.tune('A', 14074000);")
    wait_until(lambda: http_get_json(stats_url)["faHz"] == 14074000, "Moved VFO A away before bookmark recall")
    client.execute_script(
        """
        const btns = Array.from(document.querySelectorAll('.k4-bookmark-recall'));
        const target = btns.find((b) => b.textContent.includes('40m E2E'));
        if (!target) throw new Error('40m E2E bookmark button not found');
        target.click();
        """
    )
    wait_until(lambda: http_get_json(stats_url)["faHz"] == 7074000, "Bookmark recall returns VFO A to 7074000 Hz")
    client.execute_script("K4.BookmarkStore.resetDefaults();")

    # Verify RxOnlyGate blocks TX commands locally and simulator sees 0 TX violations
    gate_res = client.execute_script(
        "return globalThis.k4App.client.sendCat('TX;TU1;KY CQ;PC050;SW01;');"
    )
    assert gate_res["sent"] is False and gate_res["blocked"] == [
        "TX;",
        "TU1;",
        "KY CQ;",
        "PC050;",
        "SW01;",
    ], f"RxOnlyGate failed to block all 5 TX commands: {gate_res}"
    wait_until(
        lambda: client.execute_script(
            "const b = document.querySelector('[data-testid=\"rx-only-badge\"]'); return b && b.dataset.blocked === 'true';"
        ),
        "RX ONLY badge reflects intercepted client TX block",
    )
    stats = http_get_json(stats_url)
    assert stats["txBlockedViolations"] == 0, f"TX leaked to simulator! stats={stats}"
    assert stats["txCatCommands"] == 0, f"TX CAT command leaked in rx-only posture! stats={stats}"
    assert stats["authPassed"] >= 1 and stats["authFailed"] == 0, f"Unexpected auth stats: {stats}"

    errs = client.collect_console_errors()
    assert not errs, f"Console errors during file:// E2E: {errs}"
    print("      PASS: file:// auth, hydration, render, click-to-tune, CW -500Hz, Shift/right-click FB, Omnibar, TB$ ';', RxOnlyGate=0")


def run_http_origin_and_screenshots(
    client: MarionetteClient, http_url: str, ws_url_expected: str, password: str, stats_url: str, out_dir: str
):
    print(f"[3/3] Running cert-free localhost HTTP + TX/ATU/Sensor E2E & screenshots on {http_url} ...")
    client.set_window_rect(1440, 900)
    client.reset_console_errors()
    client.navigate(http_url)
    client.install_page_error_trap()

    # (a) Cert-free localhost SecureContext & defaultWsUrl
    sec_info = client.execute_script(
        "return { isSecure: window.isSecureContext === true, proto: location.protocol, host: location.hostname, defaultWs: K4.Client.defaultWsUrl() };"
    )
    assert sec_info["isSecure"] is True, f"Expected window.isSecureContext === true on localhost without certs: {sec_info}"
    assert sec_info["proto"] == "http:" and sec_info["host"] == "localhost", f"Unexpected origin: {sec_info}"
    default_ws = sec_info["defaultWs"]
    assert default_ws == ws_url_expected, f"Expected defaultWsUrl={ws_url_expected}, got {default_ws}"

    connect_via_ui(client, default_ws, password)

    wait_until(
        lambda: client.execute_script(
            "const s = document.getElementById('pan-stage'); return s && parseInt(s.dataset.frames || '0', 10) >= 20;"
        ),
        "HTTP framesRendered >= 20",
        timeout=10.0,
    )
    verify_non_uniform_canvas(client)

    # (b) Verify TX resets to rx-only on connect; then TX TEST (TS1) + two-tone PTT hold
    rx_boot = client.execute_script(
        """
        const snap = globalThis.k4App.state.getSnapshot();
        const bar = document.querySelector('[data-testid="tx-posture-bar"]');
        const ptt = document.querySelector('[data-testid="ptt-btn"]');
        return {
          posture: snap.txPosture,
          policy: snap.operatingPolicy,
          txActive: snap.txActive,
          barPosture: bar ? bar.dataset.posture : null,
          pttDisabled: ptt ? ptt.disabled : null,
        };
        """
    )
    assert rx_boot["posture"] == "rx-only" and rx_boot["policy"] == "rx-only", f"TX posture not rx-only on connect: {rx_boot}"
    assert rx_boot["txActive"] is False and rx_boot["barPosture"] == "rx-only" and rx_boot["pttDisabled"] is True, (
        f"Unexpected TX boot UI state: {rx_boot}"
    )

    # Ensure USB mode for voice/AF two-tone TX capture and open TX / ATU drawer tab
    client.execute_script(
        """
        globalThis.k4App.client.setMode('A', 'USB');
        const btns = Array.from(document.querySelectorAll('.k4-panel-tabs .k4-tab-btn'));
        const txTab = btns.find((b) => b.textContent.includes('TX'));
        if (!txTab) throw new Error('TX / ATU tab button missing');
        txTab.click();
        const srcSel = document.querySelector('[data-testid="tx-audio-source"]');
        if (!srcSel) throw new Error('tx-audio-source select missing');
        srcSel.value = 'two-tone';
        srcSel.dispatchEvent(new Event('change', { bubbles: true }));
        """
    )
    wait_until(
        lambda: client.execute_script("return globalThis.k4App.state.getSnapshot().rxA.mode === 2;"),
        "VFO A switched to USB mode for TX audio test",
    )

    # Switch to TX TEST (TS1)
    client.click_element(client.find_element('[data-testid="tx-mode-test"]'))
    wait_until(
        lambda: client.execute_script(
            """
            const snap = globalThis.k4App.state.getSnapshot();
            const ptt = document.querySelector('[data-testid="ptt-btn"]');
            return snap.txPosture === 'tx-test' && snap.txTestMode === true && ptt && ptt.disabled === false;
            """
        )
        and http_get_json(stats_url)["txTestMode"] is True,
        "TX TEST (TS1) posture active",
    )

    audio_before = http_get_json(stats_url)["txAudioPacketsIn"]
    ptt_coords = client.execute_script(
        """
        const ptt = document.querySelector('[data-testid="ptt-btn"]');
        const r = ptt.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        """
    )
    # Hold PTT via WebDriver pointerDown
    client.perform_actions(
        [
            {
                "type": "pointer",
                "id": "mouse",
                "parameters": {"pointerType": "mouse"},
                "actions": [
                    {"type": "pointerMove", "duration": 0, "x": ptt_coords["x"], "y": ptt_coords["y"], "origin": "viewport"},
                    {"type": "pointerDown", "button": 0},
                ],
            }
        ]
    )
    try:
        wait_until(
            lambda: (
                (st := http_get_json(stats_url))["txActive"] is True
                and st["txTestMode"] is True
                and st["txAudioPacketsIn"] > audio_before
                and st["lastAlcBars"] > 0
                and st["lastFwdTenthsW"] == 0
                and client.execute_script(
                    """
                    const snap = globalThis.k4App.state.getSnapshot();
                    const cl = document.querySelector('[data-testid="tx-meter-cluster"]');
                    const pwr = document.querySelector('[data-testid="tx-meter-pwr"]');
                    return snap.txActive === true && snap.txMeters.alcBars > 0 && snap.txMeters.fwdWatts === 0 &&
                           cl && !cl.hidden && pwr && pwr.textContent.includes('0.0W');
                    """
                )
            ),
            "TX TEST hold-PTT transmits two-tone audio with ALC > 0 & FWD == 0.0W",
            timeout=6.0,
        )
    finally:
        client.perform_actions(
            [
                {
                    "type": "pointer",
                    "id": "mouse",
                    "parameters": {"pointerType": "mouse"},
                    "actions": [{"type": "pointerUp", "button": 0}],
                }
            ]
        )
        client.release_actions()

    wait_until(
        lambda: http_get_json(stats_url)["txActive"] is False
        and client.execute_script(
            "const s = globalThis.k4App.state.getSnapshot(); return s.txActive === false && s.txMeters.fwdWatts === 0;"
        ),
        "PTT release drops TX TEST to RX immediately",
    )

    # (c) 2-step Arm live TX popover + KAT4 ATU Tune + Full Search Escape panic abort
    client.click_element(client.find_element('[data-testid="tx-mode-armed"]'))
    wait_until(
        lambda: client.execute_script(
            """
            const pop = document.querySelector('[data-testid="tx-arm-confirm"]');
            const s = globalThis.k4App.state.getSnapshot();
            return pop && pop.hidden === false && s.txPosture !== 'tx-armed';
            """
        ),
        "2-step TX arm confirmation popover opens before arming",
    )
    client.click_element(client.find_element('[data-testid="tx-arm-confirm-btn"]'))
    wait_until(
        lambda: client.execute_script(
            """
            const pop = document.querySelector('[data-testid="tx-arm-confirm"]');
            const s = globalThis.k4App.state.getSnapshot();
            return pop && pop.hidden === true && s.txPosture === 'tx-armed' && s.txTestMode === false;
            """
        )
        and http_get_json(stats_url)["txTestMode"] is False,
        "TX armed via 2-step confirmation",
    )

    # Trigger ATU Tune and wait for live SWR tracking + convergence <= 1.3
    client.click_element(client.find_element('[data-testid="atu-tune-btn"]'))
    wait_until(
        lambda: http_get_json(stats_url)["atuTuning"] is True
        and client.execute_script(
            """
            const s = globalThis.k4App.state.getSnapshot();
            const badge = document.querySelector('[data-testid="atu-status"]');
            return s.atuTuning === true && s.txMeters.swr >= 1.0 && badge && badge.dataset.state === 'tuning';
            """
        ),
        "KAT4 ATU Tune (TU3) starts live SWR tuning",
        timeout=5.0,
    )
    wait_until(
        lambda: (
            (st := http_get_json(stats_url))["atuMatched"] is True
            and st["atuTuning"] is False
            and client.execute_script(
                """
                const s = globalThis.k4App.state.getSnapshot();
                const badge = document.querySelector('[data-testid="atu-status"]');
                return s.atuTuning === false && Number.isFinite(s.atuMatchedSwr) && s.atuMatchedSwr > 0 && s.atuMatchedSwr <= 1.3 &&
                       badge && (badge.dataset.state === 'matched' || badge.dataset.state === 'warn');
                """
            )
        ),
        "KAT4 ATU Tune converges to matched SWR <= 1.3",
        timeout=6.0,
    )

    # Trigger Full Search and abort mid-tune with Escape panic (TU0;RX;)
    client.click_element(client.find_element('[data-testid="atu-full-btn"]'))
    wait_until(
        lambda: http_get_json(stats_url)["atuTuning"] is True
        and client.execute_script("return globalThis.k4App.state.getSnapshot().atuTuning === true;"),
        "ATU Full Search (TU4) active before Escape panic",
    )
    client.perform_actions(
        [
            {
                "type": "key",
                "id": "keyboard",
                "actions": [{"type": "keyDown", "value": "\uE00C"}, {"type": "keyUp", "value": "\uE00C"}],
            }
        ]
    )
    client.release_actions()
    wait_until(
        lambda: (
            (st := http_get_json(stats_url))["atuTuning"] is False
            and st["txActive"] is False
            and client.execute_script(
                "const s = globalThis.k4App.state.getSnapshot(); return s.atuTuning === false && s.txActive === false;"
            )
        ),
        "Escape panic aborts ATU Full Search cleanly to RX (TU0;RX;)",
    )

    # (d) Spacebar PTT hold in tx-armed -> 4-bar TX meter, FWD > 0, SIFP current & PA temp rise -> Spacebar release -> RX
    client.execute_script("globalThis.k4App.client.setPowerWatts(50, 'H'); if (document.activeElement) document.activeElement.blur();")
    wait_until(
        lambda: http_get_json(stats_url)["powerRange"] == "H" and http_get_json(stats_url)["powerWatts"] >= 45,
        "Power set to 50W H before Spacebar TX test",
    )
    baseline = client.execute_script(
        "const t = globalThis.k4App.state.getSnapshot().telemetry; return { amps: t.supplyAmps || 0, paTemp: t.paTempC || 0 };"
    )
    client.perform_actions(
        [
            {
                "type": "key",
                "id": "keyboard",
                "actions": [{"type": "keyDown", "value": " "}],
            }
        ]
    )
    try:
        wait_until(
            lambda: (
                (st := http_get_json(stats_url))["txActive"] is True
                and st["lastFwdTenthsW"] > 0
                and client.execute_script(
                    """
                    const basePa = arguments[0];
                    const s = globalThis.k4App.state.getSnapshot();
                    const cl = document.querySelector('[data-testid="tx-meter-cluster"]');
                    const ids = ['tx-meter-pwr', 'tx-meter-swr', 'tx-meter-alc', 'tx-meter-cmp'];
                    const barsOk = ids.every((id) => Boolean(document.querySelector('[data-testid="' + id + '"]')));
                    return s.txActive === true && s.txMeters.fwdWatts > 0 &&
                           cl && !cl.hidden && barsOk &&
                           s.telemetry.supplyAmps > 2.5 && s.telemetry.paTempC > basePa + 0.05;
                    """,
                    [baseline["paTemp"]],
                )
            ),
            "Spacebar PTT hold drives 4-bar TX meter, FWD > 0, SIFP current & PA temp rise",
            timeout=6.0,
        )
    finally:
        client.perform_actions(
            [
                {
                    "type": "key",
                    "id": "keyboard",
                    "actions": [{"type": "keyUp", "value": " "}],
                }
            ]
        )
        client.release_actions()

    wait_until(
        lambda: http_get_json(stats_url)["txActive"] is False
        and client.execute_script(
            "const s = globalThis.k4App.state.getSnapshot(); return s.txActive === false && s.txMeters.fwdWatts === 0;"
        ),
        "Spacebar release drops TX back to RX immediately",
    )

    # (e) CW keyer text via [data-testid="cw-ky-input"] + [data-testid="cw-ky-send"]
    client.execute_script("globalThis.k4App.client.setMode('A', 'CW');")
    wait_until(
        lambda: client.execute_script("return globalThis.k4App.state.getSnapshot().rxA.mode === 3;"),
        "VFO A switched to CW mode for KY keyer test",
    )
    tx_cmds_before_ky = http_get_json(stats_url)["txCatCommands"]
    client.clear_and_type('[data-testid="cw-ky-input"]', "DE K4 E2E")
    client.click_element(client.find_element('[data-testid="cw-ky-send"]'))
    wait_until(
        lambda: http_get_json(stats_url)["txCatCommands"] > tx_cmds_before_ky,
        "Simulator processed KY CW keyer command",
    )
    wait_until(
        lambda: http_get_json(stats_url)["txActive"] is False,
        "CW keyer queue drains back to RX cleanly",
        timeout=5.0,
    )

    # Return cleanly to rx-only posture via UI button before screenshots
    client.click_element(client.find_element('[data-testid="tx-mode-rx"]'))
    wait_until(
        lambda: client.execute_script(
            "const s = globalThis.k4App.state.getSnapshot(); return s.txPosture === 'rx-only' && document.querySelector('[data-testid=\"ptt-btn\"]').disabled === true;"
        ),
        "Returned to rx-only safety posture",
    )

    err_toasts = client.execute_script(
        "return Array.from(document.querySelectorAll('.k4-toast[data-level=\"error\"]')).map(e => e.textContent);"
    )
    assert not err_toasts, f"Unexpected error toasts in UI: {err_toasts}"

    desktop_png = os.path.join(out_dir, "e2e-desktop.png")
    client.take_screenshot(desktop_png)
    assert os.path.getsize(desktop_png) > 5000, f"Desktop screenshot too small: {desktop_png}"

    # Switch to Mobile 390x844 and verify mobile nav + bottom sheet
    client.set_window_rect(390, 844)
    wait_until(
        lambda: client.execute_script(
            "const nav = document.querySelector('[data-testid=\"mobile-nav\"]'); return nav && getComputedStyle(nav).display !== 'none';"
        ),
        "mobile nav bar visible at 390x844",
    )
    # Open a mobile bottom sheet tab
    client.click_element(client.find_element('[data-testid="mobile-nav"] button'))
    wait_until(
        lambda: client.execute_script(
            "const sh = document.querySelector('[data-testid=\"mobile-sheet\"]'); return sh && sh.dataset.open === 'true';"
        ),
        "mobile bottom sheet opens",
    )
    time.sleep(0.25)
    mobile_png = os.path.join(out_dir, "e2e-mobile.png")
    client.take_screenshot(mobile_png)
    assert os.path.getsize(mobile_png) > 3000, f"Mobile screenshot too small: {mobile_png}"

    stats = http_get_json(stats_url)
    assert stats["txBlockedViolations"] == 0, f"TX leaked to simulator! stats={stats}"

    errs = client.collect_console_errors()
    assert not errs, f"Console errors during HTTP E2E: {errs}"
    print(f"      PASS: localhost SecureContext, TX TEST, ATU Tune+Esc, Spacebar PTT+Sensors, CW KY, Desktop ({desktop_png}) + Mobile ({mobile_png}), 0 console errors")


def terminate_proc(proc: subprocess.Popen | None, name: str):
    if proc is None or proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=4)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=3)


def main() -> int:
    parser = argparse.ArgumentParser(description="E2E verification for Elecraft K4 Web Observatory")
    parser.add_argument(
        "--out-dir",
        default=os.path.join(REPO_ROOT, "artifacts"),
        help="Directory to write Desktop/Mobile E2E PNG screenshots",
    )
    args = parser.parse_args()

    sim_tcp_port = pick_free_port()
    sim_http_port = pick_free_port()
    ws_port = pick_free_port()
    marionette_port = pick_free_port()
    password = "k4-e2e-test-password"

    tmp_build_dir = tempfile.mkdtemp(prefix="k4sim_bin_")
    tmp_profile_dir = tempfile.mkdtemp(prefix="k4ff_prof_")
    sim_proc = None
    ws_proc = None
    ff_proc = None
    marionette = None

    try:
        sim_bin = os.path.join(tmp_build_dir, "k4sim")
        subprocess.run(
            ["go", "build", "-o", sim_bin, "."],
            cwd=SIM_DIR,
            check=True,
        )

        sim_proc = subprocess.Popen(
            [
                sim_bin,
                "-listen", f"127.0.0.1:{sim_tcp_port}",
                "-control-http", f"127.0.0.1:{sim_http_port}",
                "-password", password,
                "-fps", "25",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        # Wait on control HTTP port only (probing the K4 TCP port without auth increments authFailed).
        wait_tcp("127.0.0.1", sim_http_port)
        wait_until(lambda: http_get_json(f"http://127.0.0.1:{sim_http_port}/debug/stats")["totalConnections"] == 0, "k4sim ready")

        ws_proc = subprocess.Popen(
            [
                "/usr/bin/websockify",
                f"--web={WEB_DIR}",
                "--file-only",
                f"127.0.0.1:{ws_port}",
                f"127.0.0.1:{sim_tcp_port}",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        wait_tcp("127.0.0.1", ws_port)

        user_js = os.path.join(tmp_profile_dir, "user.js")
        with open(user_js, "w", encoding="utf-8") as f:
            f.write(f'user_pref("marionette.port", {marionette_port});\n')
            f.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
            f.write('user_pref("devtools.console.stdout.content", true);\n')

        ff_env = dict(os.environ)
        ff_env["MOZ_HEADLESS"] = "1"
        ff_proc = subprocess.Popen(
            [
                "firefox-esr",
                "--headless",
                "--marionette",
                "--no-remote",
                "--remote-allow-system-access",
                "--profile", tmp_profile_dir,
            ],
            env=ff_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        wait_tcp("127.0.0.1", marionette_port, timeout=20.0)

        marionette = MarionetteClient("127.0.0.1", marionette_port, timeout=15.0)
        marionette.new_session()

        stats_url = f"http://127.0.0.1:{sim_http_port}/debug/stats"
        run_browser_unit_tests(marionette)
        run_file_origin_e2e(
            marionette,
            f"ws://127.0.0.1:{ws_port}",
            password,
            stats_url,
        )
        run_http_origin_and_screenshots(
            marionette,
            f"http://localhost:{ws_port}/",
            f"ws://localhost:{ws_port}/ws",
            password,
            stats_url,
            args.out_dir,
        )

        print("ALL E2E CHECKS PASSED!")
        return 0
    finally:
        if marionette is not None:
            marionette.delete_session()
            marionette.close()
        terminate_proc(ff_proc, "firefox-esr")
        terminate_proc(ws_proc, "websockify")
        terminate_proc(sim_proc, "k4sim")
        shutil.rmtree(tmp_profile_dir, ignore_errors=True)
        shutil.rmtree(tmp_build_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
