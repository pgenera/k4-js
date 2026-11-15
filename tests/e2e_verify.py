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
    assert results["total"] >= 8, f"Expected >= 8 unit tests, got {results}"
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

    # Right-click tunes VFO B cleanly without moving VFO A
    pan_click_action(client, 0.70, 0.25, button=2, shift=False)
    wait_until(
        lambda: http_get_json(stats_url)["fbHz"] != fb_after_shift,
        "Right-click tunes VFO B (FB)",
    )
    assert http_get_json(stats_url)["faHz"] == fa_before_sub, "Right-click must not change VFO A"

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
    assert stats["authPassed"] >= 1 and stats["authFailed"] == 0, f"Unexpected auth stats: {stats}"

    errs = client.collect_console_errors()
    assert not errs, f"Console errors during file:// E2E: {errs}"
    print("      PASS: file:// auth, hydration, render, click-to-tune, CW -500Hz, Shift/right-click FB, Omnibar, TB$ ';', RxOnlyGate=0")


def run_http_origin_and_screenshots(
    client: MarionetteClient, http_url: str, ws_url_expected: str, password: str, stats_url: str, out_dir: str
):
    print(f"[3/3] Running HTTP E2E & screenshots on {http_url} ...")
    client.set_window_rect(1440, 900)
    client.reset_console_errors()
    client.navigate(http_url)
    client.install_page_error_trap()

    default_ws = client.execute_script("return K4.Client.defaultWsUrl();")
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
    err_toasts = client.execute_script(
        "return Array.from(document.querySelectorAll('.k4-toast[data-level=\"error\"]')).map(e => e.textContent);"
    )
    assert not err_toasts, f"Unexpected error toasts in UI: {err_toasts}"

    # Enable Mini-Pan Loupe briefly for a richer Desktop screenshot too? Let's verify default + clean layout!
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
    print(f"      PASS: HTTP E2E + Desktop ({desktop_png}) + Mobile ({mobile_png}), 0 console errors")


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
            f"http://127.0.0.1:{ws_port}/",
            f"ws://127.0.0.1:{ws_port}/ws",
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
