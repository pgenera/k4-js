#!/usr/bin/env python3
"""
End-to-end headless Firefox verification suite for Elecraft K4 Web Observatory.
Pure Python 3 stdlib (Marionette TCP protocol + HTTP /debug/stats + subprocesses).
"""

import argparse
import base64
import json
import os
import re
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

    def set_viewport_size(self, width: int, height: int):
        w = int(width)
        h = int(height)
        self.set_window_rect(max(w, 500), max(h + 90, 500))
        self.command("Marionette:SetContext", {"value": "chrome"})
        try:
            self.execute_script(
                """
                const win = Services.wm.getMostRecentWindow("navigator:browser");
                const br = win && win.gBrowser ? win.gBrowser.selectedBrowser : null;
                if (br) {
                  br.style.setProperty("width", arguments[0] + "px", "important");
                  br.style.setProperty("min-width", arguments[0] + "px", "important");
                  br.style.setProperty("max-width", arguments[0] + "px", "important");
                  br.style.setProperty("height", arguments[1] + "px", "important");
                  br.style.setProperty("min-height", arguments[1] + "px", "important");
                  br.style.setProperty("max-height", arguments[1] + "px", "important");
                }
                """,
                [w, h],
            )
        finally:
            self.command("Marionette:SetContext", {"value": "content"})

    def reset_viewport_size(self):
        self.command("Marionette:SetContext", {"value": "chrome"})
        try:
            self.execute_script(
                """
                const win = Services.wm.getMostRecentWindow("navigator:browser");
                const br = win && win.gBrowser ? win.gBrowser.selectedBrowser : null;
                if (br) {
                  for (const prop of ["width", "min-width", "max-width", "height", "min-height", "max-height"]) {
                    br.style.removeProperty(prop);
                  }
                }
                """
            )
        finally:
            self.command("Marionette:SetContext", {"value": "content"})

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


def run_browser_unit_tests(client: MarionetteClient, test_url: str | None = None):
    target_url = test_url or ("file://" + os.path.join(WEB_DIR, "test.html"))
    label = "http://localhost/test.html" if target_url.startswith("http") else "file:///.../web/test.html"
    print(f"[1/3] Running browser unit tests on {label} ...")
    client.reset_console_errors()
    client.navigate(target_url)
    client.install_page_error_trap()

    try:
        results = wait_until(
            lambda: client.execute_script("return window.__K4_TEST_RESULTS__ || null;"),
            "window.__K4_TEST_RESULTS__",
            timeout=15.0,
        )
    except AssertionError as exc:
        diag = client.execute_script(
            """
            const rows = Array.from(document.querySelectorAll('#results .test-row'));
            return {
              href: location.href,
              readyState: document.readyState,
              isSecureContext: window.isSecureContext,
              summary: document.getElementById('summary')?.textContent || null,
              completedCount: rows.length,
              lastRow: rows.length ? rows[rows.length - 1].textContent : null,
              errors: window.__K4_E2E_ERRORS__ || [],
            };
            """
        )
        raise AssertionError(f"{exc} | diag={diag} | console={client.collect_console_errors()}") from None
    assert results["total"] >= 34, f"Expected >= 34 unit tests, got {results}"
    assert results["failed"] == 0, f"Browser unit tests failed: {results}"
    errs = client.collect_console_errors()
    assert not errs, f"Console errors during test.html ({label}): {errs}"
    print(f"      PASS ({label}): {results['passed']}/{results['total']} unit tests passed, 0 console errors")


FORBIDDEN_UI_JARGON_RE = re.compile(r"(?:firewall|live\s+rf|\barm\b|\barmed\b|\bdisarm\b|intercept|policy:|prohibited|tx\s+panic)", re.IGNORECASE)


def assert_no_forbidden_jargon(text: str, location: str) -> None:
    m = FORBIDDEN_UI_JARGON_RE.search(text or "")
    assert not m, f"Forbidden jargon {m.group(0)!r} found in {location}: {text!r}"
    assert not re.search(r"\bSAFE\b", text or ""), f"Forbidden 'SAFE' label found in {location}: {text!r}"


def verify_peak_hold_default_off(client: MarionetteClient) -> None:
    """Note 5: Fresh startup has peak-hold-switch aria-pressed='false' and panadapter._peakHold === false."""
    res = client.execute_script(
        """
        globalThis.k4App.inspector.selectDesktopTab('display');
        const sw = document.querySelector('[data-testid="peak-hold-switch"]');
        return {
          exists: Boolean(sw),
          ariaPressed: sw ? sw.getAttribute('aria-pressed') : null,
          panPeakHold: Boolean(globalThis.k4App.panadapter && globalThis.k4App.panadapter._peakHold),
        };
        """
    )
    assert res["exists"] and res["ariaPressed"] == "false" and res["panPeakHold"] is False, (
        f"Note 5 failed: expected peak-hold OFF on fresh startup, got {res}"
    )


def verify_ui_notes_and_cw(client: MarionetteClient, stats_url: str) -> None:
    """Verify Notes 1-4, 6 + CW decode contrast/coalescing/mnemonics + overhaul labels & absent legacy UI."""
    # Item 2 & 12: Direct TX controls present, zero legacy Transmit Lock / Loupe / Send KY / Abort KY / L-H controls
    chrome_texts = client.execute_script(
        """
        const topBar = document.getElementById('top-bar');
        const legacyIds = ['rx-only-badge', 'tx-mode-rx', 'tx-mode-armed', 'tx-arm-confirm', 'atu-full-btn', 'tx-antenna-select', 'tx-power-range'];
        const legacyPresent = legacyIds.filter((id) => Boolean(document.querySelector('[data-testid="' + id + '"]') || document.getElementById(id)));
        globalThis.k4App.inspector.selectDesktopTab('audio');
        const audioText = document.getElementById('inspector-drawer')?.textContent || '';
        globalThis.k4App.inspector.selectDesktopTab('tx');
        const txPane = document.getElementById('inspector-drawer');
        const txText = txPane ? txPane.textContent : '';
        const kySend = document.querySelector('[data-testid="cw-ky-send"]');
        const kyAbort = document.querySelector('[data-testid="cw-ky-abort"]');
        const katBadges = Array.from(txPane ? txPane.querySelectorAll('.k4-card-badge') : []).filter((e) => e.textContent.trim() === 'KAT4');
        const pwrSlider = document.querySelector('[data-testid="tx-power-slider"]');
        const antBtn = document.querySelector('[data-testid="tx-antenna-btn"]');
        const atuTuneBtn = document.querySelector('[data-testid="atu-tune-btn"]');
        const tiles = Array.from(document.querySelectorAll('.k4-sensor-tile')).map((el) => el.textContent || '');
        const hudLoupe = globalThis.k4App._hudLoupeBtn;
        const bodyText = document.body ? document.body.textContent : '';
        return {
          legacyPresent,
          topBarText: topBar ? topBar.textContent : '',
          topAntVisible: Boolean(document.getElementById('top-ant-btn')),
          topAtuVisible: Boolean(document.getElementById('top-atu-btn')),
          testBtnText: document.querySelector('[data-testid="tx-mode-test"]')?.textContent.trim() || '',
          pttBtnText: document.querySelector('[data-testid="ptt-btn"]')?.textContent.trim() || '',
          audioText,
          txText,
          bodyText,
          kySendText: kySend ? kySend.textContent.trim() : '',
          kyAbortText: kyAbort ? kyAbort.textContent.trim() : '',
          atuHeaderCount: (txText.match(/ATU & Antenna/g) || []).length,
          katBadgeCount: katBadges.length,
          pwrSliderMin: pwrSlider ? pwrSlider.min : null,
          pwrSliderMax: pwrSlider ? pwrSlider.max : null,
          hasAntBtn: Boolean(antBtn),
          hasAtuTuneBtn: Boolean(atuTuneBtn),
          tiles,
          hudLoupeText: hudLoupe ? hudLoupe.textContent.trim() : '',
          hudLoupeTitle: hudLoupe ? hudLoupe.title : '',
        };
        """
    )
    assert chrome_texts["legacyPresent"] == [], f"Legacy UI hooks still present: {chrome_texts['legacyPresent']}"
    assert chrome_texts["topAntVisible"] and chrome_texts["topAtuVisible"], chrome_texts
    assert chrome_texts["testBtnText"] == "TEST" and chrome_texts["pttBtnText"] == "PTT", chrome_texts
    assert chrome_texts["kySendText"] == "Send", f"Expected keyer 'Send', got {chrome_texts['kySendText']!r}"
    assert chrome_texts["kyAbortText"] == "Stop", f"Expected keyer 'Stop', got {chrome_texts['kyAbortText']!r}"
    assert chrome_texts["atuHeaderCount"] == 1 and chrome_texts["katBadgeCount"] == 1, chrome_texts
    assert chrome_texts["pwrSliderMin"] == "0.1" and chrome_texts["pwrSliderMax"] == "110", chrome_texts
    assert chrome_texts["hasAntBtn"] and chrome_texts["hasAtuTuneBtn"], chrome_texts
    assert "Mic Input" not in chrome_texts["txText"], "Physical Mic Input selector must be removed"
    for banned in ["Send KY", "Abort KY @", "Loupe", "Transmit Lock", "Arm live RF", "RX-only firewall"]:
        assert banned.lower() not in chrome_texts["bodyText"].lower(), f"Banned UI label {banned!r} found in visible DOM"
    assert_no_forbidden_jargon(chrome_texts["topBarText"], "#top-bar")
    assert_no_forbidden_jargon(chrome_texts["audioText"], "Audio tab")
    assert_no_forbidden_jargon(chrome_texts["txText"], "TX tab")

    # Note 1: Zero 'Graph' text in any .k4-sensor-tile, clicking sensor-tile-pt opens graph modal
    assert len(chrome_texts["tiles"]) == 8, f"Expected 8 sensor tiles, got {chrome_texts['tiles']}"
    for tile_txt in chrome_texts["tiles"]:
        assert "graph" not in tile_txt.lower(), f"Note 1 failed: unexpected 'Graph' text in sensor tile {tile_txt!r}"
    client.execute_script("document.querySelector('[data-testid=\"sensor-tile-pt\"]').click();")
    wait_until(
        lambda: client.execute_script(
            """
            const p = document.querySelector('[data-testid="sensor-graph-panel"]');
            const c = document.querySelector('[data-testid="sensor-graph-canvas"]');
            return p && p.hidden === false && c && c.width > 0 && c.height > 0;
            """
        ),
        "Note 1: sensor-tile-pt opens sensor graph modal",
    )
    client.execute_script("document.querySelector('[data-testid=\"sensor-graph-close\"]')?.click();")
    wait_until(
        lambda: client.execute_script(
            "const p = document.querySelector('[data-testid=\"sensor-graph-panel\"]'); return p && p.hidden === true;"
        ),
        "Sensor graph modal closes",
    )

    # Omnibar Auto Spot + Mini-Pan cards (zero 'loupe' or Transmit Lock jargon)
    client.click_element(client.find_element('[data-testid="omnibar-btn"]'))
    wait_until(
        lambda: client.execute_script("const m = document.querySelector('[data-testid=\"omnibar-modal\"]'); return m && m.dataset.open === 'true';"),
        "Omnibar open for Auto Spot / Mini-Pan checks",
    )
    client.clear_and_type('[data-testid="omnibar-input"]', "auto spot")
    wait_until(
        lambda: client.execute_script(
            "const l = document.querySelector('.k4-omnibar-list'); return l && l.textContent.includes('Auto Spot CW');"
        ),
        "Omnibar displays Auto Spot CW card",
    )
    omni_spot = client.execute_script("return document.querySelector('.k4-omnibar-list')?.textContent || '';")
    assert_no_forbidden_jargon(omni_spot, "Omnibar Auto Spot card")

    # Mini-Pan & CAT cleanup (#114)
    assert chrome_texts["hudLoupeText"].startswith("Mini-Pan") and chrome_texts["hudLoupeTitle"] == "Toggle Mini-Pan", chrome_texts
    client.clear_and_type('[data-testid="omnibar-input"]', "minipan")
    wait_until(
        lambda: client.execute_script(
            "const l = document.querySelector('.k4-omnibar-list'); return l && l.textContent.includes('Mini-Pan');"
        ),
        "Omnibar displays Mini-Pan card",
    )
    omni_mp = client.execute_script("return document.querySelector('.k4-omnibar-list')?.textContent || '';")
    assert "loupe" not in omni_mp.lower() and "MINI-PAN" in omni_mp, f"Unexpected Mini-Pan omnibar text: {omni_mp!r}"
    client.send_keys(client.find_element('[data-testid="omnibar-input"]'), "\uE00C")  # Escape
    wait_until(
        lambda: client.execute_script("const m = document.querySelector('[data-testid=\"omnibar-modal\"]'); return m && m.dataset.open === 'false';"),
        "Omnibar closes after Escape",
    )

    # Check zero 'loupe' and zero parenthesized raw CAT codes across inspector tabs & ticker
    cat_cleanup = client.execute_script(
        """
        const drawer = document.getElementById('inspector-drawer');
        const tabTexts = [];
        for (const tab of ['band-mode', 'dsp', 'display', 'audio', 'tx']) {
          globalThis.k4App.inspector.selectDesktopTab(tab);
          tabTexts.push(drawer ? drawer.textContent : '');
        }
        const badge = document.querySelector('[data-testid="text-ticker"] .k4-ticker-badge');
        const dspSel = document.querySelector('[data-testid="dsp-td-select"]');
        const dspRow = dspSel ? (dspSel.closest('.k4-dsp-row, .k4-card') || dspSel.parentElement) : null;
        return {
          allText: tabTexts.join(' '),
          badgeText: badge ? badge.textContent.trim() : '',
          dspDecodeText: dspRow ? dspRow.textContent : '',
        };
        """
    )
    assert "loupe" not in cat_cleanup["allText"].lower(), "Found leftover 'loupe' in inspector UI"
    for raw_code in ["(TB$)", "(TD)", "(TD / TD$)", "(#MP)", "(#FRZ)", "(PB0)", "(VT)"]:
        assert raw_code not in cat_cleanup["allText"], f"Found raw CAT code {raw_code!r} in inspector UI"
    assert cat_cleanup["badgeText"] == "DECODE", f"Expected DECODE badge, got {cat_cleanup['badgeText']!r}"
    assert "(TD" not in cat_cleanup["dspDecodeText"], f"Found (TD in DSP decode card: {cat_cleanup['dspDecodeText']!r}"

    # CW Select / Option contrast & dark background check
    sel_check = client.execute_script(
        """
        function parseCssColor(str) {
          const m = String(str || '').match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/);
          if (!m) return null;
          return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
        }
        function relLum(c) {
          const f = (v) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
          };
          return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
        }
        function contrast(c1, c2) {
          const l1 = relLum(c1), l2 = relLum(c2);
          return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        }
        globalThis.k4App.inspector.selectDesktopTab('dsp');
        const sels = [
          document.querySelector('[data-testid="ticker-td-select"]'),
          document.querySelector('[data-testid="dsp-td-select"]'),
          ...Array.from(document.querySelectorAll('.k4-select')),
        ].filter(Boolean);
        const out = [];
        for (const s of sels) {
          const cs = getComputedStyle(s);
          const bg = parseCssColor(cs.backgroundColor);
          const fg = parseCssColor(cs.color);
          const opt = s.querySelector('option');
          const ocs = opt ? getComputedStyle(opt) : null;
          const obg = ocs ? parseCssColor(ocs.backgroundColor) : null;
          const ofg = ocs ? parseCssColor(ocs.color) : null;
          out.push({
            id: s.dataset.testid || s.className,
            bg, fg, bgLum: bg ? relLum(bg) : null, ratio: bg && fg ? contrast(bg, fg) : null,
            obg, ofg, obgLum: obg ? relLum(obg) : null, oratio: obg && ofg ? contrast(obg, ofg) : null,
          });
        }
        return out;
        """
    )
    assert len(sel_check) >= 2, f"Expected select elements, got {sel_check}"
    for item in sel_check:
        assert item["bg"] and item["bg"]["a"] == 1 and item["bgLum"] < 0.08, f"Select not opaque dark: {item}"
        assert item["ratio"] >= 7.0, f"Select contrast < 7.0: {item}"
        if item["obg"] and item["obg"]["a"] == 1:
            assert item["obgLum"] < 0.08 and item["oratio"] >= 7.0, f"Option contrast issue: {item}"

    # CW Streaming Coalescing check (inject 1-char packets after newline)
    coalesce_res = client.execute_script(
        """
        const inject = (raw) => {
          for (const tok of K4.CatCodec.splitFrames(raw)) {
            const p = K4.CatCodec.parseCommand(tok);
            if (p) globalThis.k4App.state.applyParsedCat(p);
          }
          globalThis.k4App._render();
        };
        const beforeLines = document.querySelectorAll('[data-testid="text-ticker"] .k4-ticker-line').length;
        inject('TB001\\n;TB001T;TB001E;TB001S;TB001T;TB001 ;TB001C;TB001W;');
        const msgs = Array.from(document.querySelectorAll('[data-testid="text-ticker"] .k4-ticker-msg')).map((e) => e.textContent);
        const testCwMatches = msgs.filter((m) => m.includes('TEST CW'));
        const afterLines = document.querySelectorAll('[data-testid="text-ticker"] .k4-ticker-line').length;
        return { beforeLines, afterLines, testCwCount: testCwMatches.length, lastMsg: msgs[msgs.length - 1] || '' };
        """
    )
    assert coalesce_res["testCwCount"] == 1 and "TEST CW" in coalesce_res["lastMsg"], f"CW coalescing failed: {coalesce_res}"
    assert coalesce_res["afterLines"] <= coalesce_res["beforeLines"] + 1, f"7 single-char packets split across multiple lines: {coalesce_res}"

    # Note 2: NR000;NRS052; baseline -> nr-switch turns ON and STAYS ON; LMS <-> SSNR stays ON; omnibar nr on / ssnr on
    client.execute_script("globalThis.k4App.inspector.selectDesktopTab('dsp');")
    client.execute_script("globalThis.k4App.client.sendCat('NR000;NRS052;NR;NRS;');")
    wait_until(
        lambda: client.execute_script(
            """
            const rxA = globalThis.k4App.state.getSnapshot().rxA;
            const sw = document.querySelector('[data-testid="nr-switch"]');
            return rxA.nrOn === false && rxA.ssnrLastUsed === true && rxA.nrMode === 'ssnr' &&
                   sw && sw.getAttribute('aria-pressed') === 'false';
            """
        ),
        "Note 2 baseline NR000;NRS052; established (nrOn=false, nrMode=ssnr)",
    )
    client.click_element(client.find_element('[data-testid="nr-switch"]'))
    wait_until(
        lambda: client.execute_script(
            "const rxA = globalThis.k4App.state.getSnapshot().rxA; return rxA.nrOn === true && rxA.ssnrOn === true && rxA.nrMode === 'ssnr';"
        ),
        "Note 2: clicking nr-switch from NRS052 turns SSNR ON",
    )
    time.sleep(1.05)
    stays_on_1 = client.execute_script(
        """
        const rxA = globalThis.k4App.state.getSnapshot().rxA;
        const sw = document.querySelector('[data-testid="nr-switch"]');
        return { nrOn: rxA.nrOn, ssnrOn: rxA.ssnrOn, nrMode: rxA.nrMode, pressed: sw?.getAttribute('aria-pressed') };
        """
    )
    assert stays_on_1["nrOn"] is True and stays_on_1["ssnrOn"] is True and stays_on_1["pressed"] == "true", (
        f"Note 2 failed: NR did not stay ON after 1s: {stays_on_1}"
    )

    client.click_element(client.find_element('[data-testid="nr-mode-lms"]'))
    wait_until(
        lambda: client.execute_script(
            "const rxA = globalThis.k4App.state.getSnapshot().rxA; return rxA.nrOn === true && rxA.lmsNrOn === true && rxA.ssnrOn === false && rxA.nrMode === 'lms';"
        ),
        "Note 2: switching nr-mode-ssnr -> nr-mode-lms keeps NR ON in LMS",
    )
    time.sleep(1.05)
    assert client.execute_script("return globalThis.k4App.state.getSnapshot().rxA.lmsNrOn === true;"), "LMS NR bounced off after 1s"

    client.click_element(client.find_element('[data-testid="nr-mode-ssnr"]'))
    wait_until(
        lambda: client.execute_script(
            "const rxA = globalThis.k4App.state.getSnapshot().rxA; return rxA.nrOn === true && rxA.ssnrOn === true && rxA.lmsNrOn === false && rxA.nrMode === 'ssnr';"
        ),
        "Note 2: switching nr-mode-lms -> nr-mode-ssnr keeps NR ON in SSNR",
    )
    time.sleep(1.05)
    assert client.execute_script("return globalThis.k4App.state.getSnapshot().rxA.ssnrOn === true;"), "SSNR bounced off after 1s"

    client.click_element(client.find_element('[data-testid="nr-switch"]'))
    wait_until(
        lambda: client.execute_script("return globalThis.k4App.state.getSnapshot().rxA.nrOn === false;"),
        "nr-switch turns NR OFF",
    )

    for cmd_text, expected_mode in [("nr on", "lms"), ("ssnr on", "ssnr")]:
        client.click_element(client.find_element('[data-testid="omnibar-btn"]'))
        wait_until(
            lambda: client.execute_script("const m = document.querySelector('[data-testid=\"omnibar-modal\"]'); return m && m.dataset.open === 'true';"),
            f"Omnibar open for {cmd_text!r}",
        )
        client.clear_and_type('[data-testid="omnibar-input"]', cmd_text)
        client.send_keys(client.find_element('[data-testid="omnibar-input"]'), "\uE007")
        wait_until(
            lambda em=expected_mode: client.execute_script(
                f"const rxA = globalThis.k4App.state.getSnapshot().rxA; return rxA.nrOn === true && rxA.nrMode === '{em}';"
            ),
            f"Note 2: Omnibar {cmd_text!r} enables {expected_mode}",
        )
    client.execute_script("globalThis.k4App.client.setNr('A', { on: false });")
    wait_until(
        lambda: client.execute_script("return globalThis.k4App.state.getSnapshot().rxA.nrOn === false;"),
        "NR restored OFF after Note 2 checks",
    )

    # Note 3: Zero-jitter S-meter across S3 -> S9+25 -> S9+40 + smooth peak-hold decay
    jitter = client.execute_script(
        """
        const injectAndMeasure = (tok) => {
          const p = K4.CatCodec.parseCommand(tok);
          if (p) globalThis.k4App.state.applyParsedCat(p);
          globalThis.k4App._render();
          const rect = (el) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, width: r.width };
          };
          const dbmEl = document.querySelector('[data-testid="smeter-dbm"]');
          return {
            text: dbmEl ? dbmEl.textContent : '',
            slot: rect(document.querySelector('.k4-smeter-slot')),
            txInd: rect(document.querySelector('[data-testid="k4-tx-vfo-indicator"]')),
            dbm: rect(dbmEl),
            sunit: rect(dbmEl?.querySelector('.k4-smeter-sunit')),
            sep: rect(dbmEl?.querySelector('.k4-smeter-sep')),
            num: rect(dbmEl?.querySelector('.k4-smeter-dbm-num')),
          };
        };
        return [
          injectAndMeasure('SMH-103;'),
          injectAndMeasure('SMH-048;'),
          injectAndMeasure('SMH-033;'),
        ];
        """
    )
    assert (
        "-103 dBm" in jitter[0]["text"]
        and "S9+25" in jitter[1]["text"]
        and "-48 dBm" in jitter[1]["text"]
        and "S9+40" in jitter[2]["text"]
        and "-33 dBm" in jitter[2]["text"]
    ), f"Unexpected S-meter text progression: {jitter}"
    for key in ["slot", "txInd", "dbm", "sunit", "sep", "num"]:
        for edge in ["left", "right", "width"]:
            vals = [sample[key][edge] for sample in jitter]
            delta = max(vals) - min(vals)
            assert delta <= 0.5, f"Note 3 jitter > 0.5px on {key}.{edge}: delta={delta:.3f}px vals={vals}"

    peak_start = client.execute_script(
        """
        globalThis.k4App.state.applyParsedCat(K4.CatCodec.parseCommand('SMH-033;'));
        globalThis.k4App._render();
        globalThis.k4App.state.applyParsedCat(K4.CatCodec.parseCommand('SMH-103;'));
        globalThis.k4App._render();
        const peakEl = document.querySelector('[data-testid="smeter-block-a"] .k4-smeter-peak');
        const fillEl = document.querySelector('[data-testid="smeter-block-a"] .k4-smeter-fill');
        return { peakLeft: parseFloat(peakEl.style.left), fillWidth: parseFloat(fillEl.style.width) };
        """
    )
    assert peak_start["peakLeft"] > 95.0, f"Expected initial peak at S9+40 (>95%), got {peak_start}"
    time.sleep(0.55)
    peak_later = client.execute_script(
        """
        const peakEl = document.querySelector('[data-testid="smeter-block-a"] .k4-smeter-peak');
        const fillEl = document.querySelector('[data-testid="smeter-block-a"] .k4-smeter-fill');
        return { peakLeft: parseFloat(peakEl.style.left), fillWidth: parseFloat(fillEl.style.width) };
        """
    )
    assert peak_later["fillWidth"] < peak_later["peakLeft"] < peak_start["peakLeft"], (
        f"Note 3 peak-hold failed to decay smoothly: start={peak_start}, later={peak_later}"
    )

    # Note 6: SB0 single S-meter vs SB1 Dual RX independent SMH/SMH$ + zero horizontal overflow at 1440x900 & 1024x768
    single_rx = client.execute_script(
        """
        const slot = document.querySelector('.k4-smeter-slot');
        const a = document.querySelector('[data-testid="smeter-block-a"]');
        const b = document.querySelector('[data-testid="smeter-block-b"]');
        return {
          dualCls: slot ? slot.classList.contains('is-dual-rx') : null,
          aVisible: Boolean(a && !a.hidden && a.getBoundingClientRect().width > 0),
          bHidden: Boolean(!b || b.hidden || getComputedStyle(b).display === 'none'),
        };
        """
    )
    assert single_rx["dualCls"] is False and single_rx["aVisible"] is True and single_rx["bHidden"] is True, single_rx

    client.execute_script("globalThis.k4App.client.setSubRx(true);")
    wait_until(
        lambda: client.execute_script(
            """
            const slot = document.querySelector('.k4-smeter-slot');
            const b = document.querySelector('[data-testid="smeter-block-b"]');
            return globalThis.k4App.state.getSnapshot().subRxEnabled === true &&
                   slot && slot.classList.contains('is-dual-rx') &&
                   b && !b.hidden && b.getBoundingClientRect().width > 0;
            """
        ),
        "Note 6: SB1 shows Dual RX S-meter block A + B",
    )
    dual_readings = client.execute_script(
        """
        globalThis.k4App.state.applyParsedCat(K4.CatCodec.parseCommand('SMH-080;'));
        globalThis.k4App.state.applyParsedCat(K4.CatCodec.parseCommand('SMH$-070;'));
        globalThis.k4App._render();
        const da = document.querySelector('[data-testid="smeter-dbm"]');
        const db = document.querySelector('[data-testid="smeter-b-dbm"]');
        const fa = document.querySelector('[data-testid="smeter-block-a"] .k4-smeter-fill');
        const fb = document.querySelector('[data-testid="smeter-block-b"] .k4-smeter-fill');
        return {
          textA: da ? da.textContent : '',
          textB: db ? db.textContent : '',
          widthA: fa ? parseFloat(fa.style.width) : 0,
          widthB: fb ? parseFloat(fb.style.width) : 0,
        };
        """
    )
    assert "-80 dBm" in dual_readings["textA"] and "-70 dBm" in dual_readings["textB"], dual_readings
    assert dual_readings["widthB"] > dual_readings["widthA"] + 5.0, dual_readings

    for vw, vh in [(1440, 900), (1024, 768)]:
        client.set_window_rect(vw, vh)
        overflow = client.execute_script(
            "return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };"
        )
        assert overflow["sw"] <= overflow["cw"], f"Note 6 horizontal overflow at {vw}x{vh} (Dual RX): {overflow}"

    client.set_window_rect(1440, 900)
    client.execute_script("globalThis.k4App.client.setSubRx(false);")
    wait_until(
        lambda: client.execute_script("return globalThis.k4App.state.getSnapshot().subRxEnabled === false;"),
        "Sub-RX restored OFF after Note 6 checks",
    )


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

    verify_peak_hold_default_off(client)

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
            const hasSemi = snap.decodedText.some((d) => d.text.includes('CQ DE W6ELE K ; 73 ;'));
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

    verify_ui_notes_and_cw(client, stats_url)

    # Verify App boots directly in tx-enabled/tx-armed while explicit RxOnlyGate('rx-only') blocks TX cleanly
    gate_res = client.execute_script(
        """
        const appGate = globalThis.k4App.gate;
        const appPosture = globalThis.k4App.client.getTxPosture();
        const strictGate = new K4.RxOnlyGate('rx-only');
        const check = strictGate.inspectCat('TX;TU1;KY CQ;PC050;SW01;SP3;');
        return {
          policy: appGate.getPolicy(),
          posture: appPosture,
          strictBlocked: check.blocked,
          strictAllowed: check.allowed,
        };
        """
    )
    assert gate_res["policy"] == "tx-enabled" and gate_res["posture"] == "tx-armed", f"Unexpected default boot posture: {gate_res}"
    assert gate_res["strictBlocked"] == ["TX;", "TU1;", "KY CQ;", "PC050;", "SW01;"], f"Explicit RxOnlyGate failed: {gate_res}"
    assert gate_res["strictAllowed"] == ["SP3;"], f"Explicit RxOnlyGate must allow SP3;: {gate_res}"
    stats = http_get_json(stats_url)
    assert stats["txBlockedViolations"] == 0, f"TX leaked to simulator! stats={stats}"
    assert stats["txCatCommands"] == 0, f"Unexpected TX CAT command during RX file:// pass! stats={stats}"
    assert stats["authPassed"] >= 1 and stats["authFailed"] == 0, f"Unexpected auth stats: {stats}"

    errs = client.collect_console_errors()
    assert not errs, f"Console errors during file:// E2E: {errs}"
    print("      PASS: file:// auth, hydration, render, click-to-tune, CW -500Hz, Shift/right-click FB, Omnibar, TB$ ';', tx-enabled/tx-armed")


def run_http_origin_and_screenshots(
    client: MarionetteClient, http_url: str, ws_url_expected: str, password: str, stats_url: str, out_dir: str
):
    print(f"[3/3] Running cert-free localhost HTTP + TX/ATU/Mic/Sensor E2E & screenshots on {http_url} ...")
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

    # Verify Base K4 OM hides Diversity RX while keeping Dual-Pan (#DPM) enabled
    k4_cap = wait_until(
        lambda: client.execute_script(
            """
            const snap = globalThis.k4App.state.getSnapshot();
            const divBtn = document.querySelector('[data-testid="diversity-switch"]');
            const hudDual = globalThis.k4App._hudDualBtn;
            if (!snap.radioModel || !divBtn || !hudDual) return null;
            return {
              radioModel: snap.radioModel,
              hasDiversity: snap.hasDiversity,
              hasKrx4: snap.hasKrx4,
              divRowHidden: Boolean(divBtn.closest('[hidden]')),
              hudDualDisabled: Boolean(hudDual.disabled),
            };
            """
        ),
        "Base K4 OM capabilities hydrated",
    )
    verify_peak_hold_default_off(client)
    assert k4_cap["radioModel"] == "K4" and k4_cap["hasDiversity"] is False and k4_cap["hasKrx4"] is False, (
        f"Expected Base K4 model without KRX4/Diversity: {k4_cap}"
    )
    assert k4_cap["divRowHidden"] is True, f"Diversity RX row must be hidden on base K4: {k4_cap}"
    assert k4_cap["hudDualDisabled"] is False, f"Dual-Pan HUD button must remain enabled on base K4: {k4_cap}"

    # Verify click Dual-Pan toggles 0 <-> 2 cleanly on base K4
    client.execute_script("globalThis.k4App._hudDualBtn.click();")
    wait_until(
        lambda: client.execute_script("return globalThis.k4App.state.getSnapshot().dualPanMode === 2;"),
        "Dual Pan (#DPM2) works on base K4",
    )
    client.execute_script("globalThis.k4App._hudDualBtn.click();")
    wait_until(
        lambda: client.execute_script("return globalThis.k4App.state.getSnapshot().dualPanMode === 0;"),
        "Restore Single Pan (#DPM0)",
    )

    # Verify click-and-drag on panadapter pans panadapter centerpoint without detuning VFO A
    fa_pre_drag = http_get_json(stats_url)["faHz"]
    drag_pts = client.execute_script(
        """
        const surf = document.querySelector('.k4-pan-surface');
        const rect = surf.getBoundingClientRect();
        const lay = globalThis.k4App.panadapter._renderer.getLayouts()[0];
        const y = Math.round(rect.top + lay.specRect.y + lay.specRect.h * 0.35);
        const x0 = Math.round(rect.left + lay.specRect.x + lay.specRect.w * 0.78);
        const x1 = Math.round(rect.left + lay.specRect.x + lay.specRect.w * 0.56);
        return { x0, x1, y };
        """
    )
    client.perform_actions(
        [
            {
                "type": "pointer",
                "id": "mouse",
                "parameters": {"pointerType": "mouse"},
                "actions": [
                    {"type": "pointerMove", "duration": 0, "x": drag_pts["x0"], "y": drag_pts["y"], "origin": "viewport"},
                    {"type": "pointerDown", "button": 0},
                    {"type": "pointerMove", "duration": 40, "x": round((drag_pts["x0"] + drag_pts["x1"]) / 2), "y": drag_pts["y"], "origin": "viewport"},
                    {"type": "pointerMove", "duration": 40, "x": drag_pts["x1"], "y": drag_pts["y"], "origin": "viewport"},
                    {"type": "pointerUp", "button": 0},
                ],
            }
        ]
    )
    client.release_actions()
    wait_until(
        lambda: client.execute_script(
            """
            const b = document.querySelector('[data-testid="hud-center-btn"]');
            return globalThis.k4App.panadapter.isViewportOffset('A') === true && b && b.hidden === false;
            """
        ),
        "Panadapter drag moves viewport center and shows Center button",
    )
    assert http_get_json(stats_url)["faHz"] == fa_pre_drag, "Panadapter drag must NOT tune VFO A"
    client.click_element(client.find_element('[data-testid="hud-center-btn"]'))
    wait_until(
        lambda: client.execute_script("return !globalThis.k4App.panadapter.isViewportOffset('A');"),
        "Center button clears viewport pan offset",
    )

    # Item 13: Persistent #top-ant-btn and #top-atu-btn across drawer collapse and all inspector tabs
    ant_atu_persist = client.execute_script(
        """
        const ant = document.getElementById('top-ant-btn');
        const atu = document.getElementById('top-atu-btn');
        const vis = () => Boolean(ant && atu && ant.offsetParent !== null && atu.offsetParent !== null);
        const results = [];
        for (const tab of ['band-mode', 'dsp', 'display', 'audio', 'tx']) {
          globalThis.k4App.inspector.selectDesktopTab(tab);
          results.push({ ctx: 'tab:' + tab, ok: vis() });
        }
        document.getElementById('drawer-toggle')?.click();
        results.push({ ctx: 'drawerClosed', ok: vis() });
        document.getElementById('drawer-toggle')?.click();
        results.push({ ctx: 'drawerReopened', ok: vis() });
        return results;
        """
    )
    assert all(r["ok"] for r in ant_atu_persist), f"Top ANT/ATU pills disappeared: {ant_atu_persist}"

    # Item 5 & 11 & UX Item 4: Live audio + MediaSession + state-only Audio label (no PCM/Opus/12k/48k)
    client.execute_script("globalThis.k4App.inspector.selectDesktopTab('audio');")
    client.click_element(client.find_element('[data-testid="audio-toggle"]'))
    wait_until(
        lambda: client.execute_script(
            """
            const d = globalThis.k4App.audio.getDiagnostics();
            const s = globalThis.k4App.state.getSnapshot();
            const rtt = document.querySelector('#conn-btn .k4-conn-rtt');
            const e2e = document.querySelector('[data-testid="diag-e2eLatency"]');
            const btn = document.getElementById('audio-toggle');
            const lbl = document.querySelector('#audio-toggle .k4-audio-label');
            const txt = (btn ? btn.textContent : '') + ' ' + (lbl ? lbl.textContent : '');
            const hasCodecJargon = /(PCM|Opus|12k|48k)/i.test(txt);
            return d.started && !d.muted && s.encodeMode === 1 && lbl && lbl.textContent === 'Audio' && !hasCodecJargon &&
                   btn && /PCM 12k/i.test(btn.title || '') &&
                   rtt && rtt.textContent.startsWith('E2E ') && e2e && e2e.textContent.startsWith('RX ') && e2e.textContent.includes('ms');
            """
        ),
        "Live audio defaults to EM1, shows clean 'Audio' label without PCM/Opus/12k/48k, and shows E2E XXms",
        timeout=10.0,
    )
    if client.execute_script("return Boolean(K4.OpusPacketDecoder && K4.OpusPacketDecoder.isSupported());"):
        client.execute_script("globalThis.k4App.client.setEncodeMode(3);")
        wait_until(
            lambda: client.execute_script(
                "const s = globalThis.k4App.state.getSnapshot(); const btn = document.getElementById('audio-toggle'); const lbl = document.querySelector('#audio-toggle .k4-audio-label'); return s.encodeMode === 3 && lbl && lbl.textContent === 'Audio' && !/(PCM|Opus|12k|48k)/i.test(btn.textContent || '');"
            ),
            "Explicit setEncodeMode(3) switches cleanly while keeping #audio-toggle text free of Opus/48k",
        )
        client.execute_script("globalThis.k4App.client.setEncodeMode(1);")
        wait_until(
            lambda: client.execute_script(
                "const s = globalThis.k4App.state.getSnapshot(); const btn = document.getElementById('audio-toggle'); const lbl = document.querySelector('#audio-toggle .k4-audio-label'); return s.encodeMode === 1 && lbl && lbl.textContent === 'Audio' && !/(PCM|Opus|12k|48k)/i.test(btn.textContent || '');"
            ),
            "setEncodeMode(1) switches cleanly back while keeping #audio-toggle text clean",
        )
    media_check = client.execute_script(
        """
        const keepAlive = Array.from(document.querySelectorAll('audio')).find((el) => el.loop);
        const ms = navigator.mediaSession;
        const metaTitle = ms && ms.metadata ? ms.metadata.title : '';
        const metaArtist = ms && ms.metadata ? ms.metadata.artist : '';
        const conn = document.getElementById('conn-btn');
        const vfoA = document.getElementById('vfo-a-mount');
        const rBefore = { connL: conn.getBoundingClientRect().left, connW: conn.getBoundingClientRect().width, vfoL: vfoA.getBoundingClientRect().left };
        const e2eText = document.querySelector('#conn-btn .k4-conn-rtt')?.textContent || '';
        return {
          hasKeepAlive: Boolean(keepAlive && keepAlive.loop),
          metaTitle,
          metaArtist,
          e2eText,
          rBefore,
        };
        """
    )
    assert media_check["hasKeepAlive"], f"Silent keep-alive <audio loop> missing: {media_check}"
    assert "Elecraft K4" in media_check["metaArtist"] and media_check["metaTitle"], f"MediaSession metadata not set: {media_check}"

    # Toggle mute via MediaSession pause/play action handler & verify immediate RTT <-> E2E sync with 0.0px layout shift
    client.execute_script("globalThis.k4App.audio._handleMediaSessionAction('pause');")
    wait_until(
        lambda: client.execute_script(
            """
            const btn = document.getElementById('audio-toggle');
            const rtt = document.querySelector('#conn-btn .k4-conn-rtt');
            return btn && btn.dataset.state === 'muted' && rtt && rtt.textContent.startsWith('RTT ');
            """
        ),
        "MediaSession pause mutes audio and updates #conn-btn to RTT XXms",
    )
    shift_check = client.execute_script(
        """
        const conn = document.getElementById('conn-btn');
        const vfoA = document.getElementById('vfo-a-mount');
        const rAfter = { connL: conn.getBoundingClientRect().left, connW: conn.getBoundingClientRect().width, vfoL: vfoA.getBoundingClientRect().left };
        const rttText = document.querySelector('#conn-btn .k4-conn-rtt')?.textContent || '';
        globalThis.k4App.audio._handleMediaSessionAction('play');
        return { rAfter, rttText };
        """
    )
    assert abs(shift_check["rAfter"]["connL"] - media_check["rBefore"]["connL"]) <= 0.5, (media_check, shift_check)
    assert abs(shift_check["rAfter"]["connW"] - media_check["rBefore"]["connW"]) <= 0.5, (media_check, shift_check)
    assert abs(shift_check["rAfter"]["vfoL"] - media_check["rBefore"]["vfoL"]) <= 0.5, (media_check, shift_check)
    wait_until(
        lambda: client.execute_script("return document.getElementById('audio-toggle')?.dataset.state === 'active';"),
        "MediaSession play resumes audio cleanly",
    )

    # Item 3: Auto Spot (SP3;) zero-beat CW carrier (14.025 MHz - pitch in CW, + pitch in CW-R) + Spot tone toggle
    client.execute_script("globalThis.k4App.client.sendCat('MD3;FA00014025800;');")
    wait_until(
        lambda: http_get_json(stats_url)["faHz"] == 14025800 and client.execute_script("return globalThis.k4App.state.getSnapshot().rxA.mode === 3;"),
        "VFO A tuned near CW beacon (14025800 Hz, CW)",
    )
    client.click_element(client.find_element('#pan-stage [data-testid="auto-spot-btn"]'))
    pitch_hz = client.execute_script("return globalThis.k4App.state.getSnapshot().cwPitchHz || 500;")
    wait_until(
        lambda: http_get_json(stats_url)["faHz"] == 14025000 - pitch_hz,
        f"Auto Spot snaps CW dial to zero-beat {14025000 - pitch_hz} Hz",
    )
    client.execute_script("globalThis.k4App.client.sendCat('MD7;FA00014024800;');")
    wait_until(
        lambda: http_get_json(stats_url)["faHz"] == 14024800 and client.execute_script("return globalThis.k4App.state.getSnapshot().rxA.mode === 7;"),
        "VFO A switched to CW-R at 14024800 Hz",
    )
    client.click_element(client.find_element('#pan-stage [data-testid="auto-spot-btn"]'))
    wait_until(
        lambda: http_get_json(stats_url)["faHz"] == 14025000 + pitch_hz,
        f"Auto Spot snaps CW-R dial to zero-beat {14025000 + pitch_hz} Hz",
    )
    client.click_element(client.find_element('#pan-stage [data-testid="cw-spot-btn"]'))
    wait_until(
        lambda: client.execute_script("return globalThis.k4App.state.getSnapshot().spotTone === 1;"),
        "Spot tone button toggles SP1 ON",
    )
    client.click_element(client.find_element('#pan-stage [data-testid="cw-spot-btn"]'))
    wait_until(
        lambda: client.execute_script("return globalThis.k4App.state.getSnapshot().spotTone === 0;"),
        "Spot tone button toggles SP0 OFF",
    )

    # Item 1: Dual draggable Mini-Pan A & B (drag persists, wheel/click isolated from FA/FB, dblclick resets, clamps at 390x844, close)
    client.execute_script(
        "if (K4.storage) { K4.storage.remove('k4.minipan.pos.a'); K4.storage.remove('k4.minipan.pos.b'); }"
        "globalThis.k4App.client.sendCat('SB1;#MP1;#MP$1;');"
    )
    wait_until(
        lambda: client.execute_script(
            """
            const a = document.querySelector('[data-testid="minipan-box-a"]');
            const b = document.querySelector('[data-testid="minipan-box-b"]');
            return a && b && a.style.display !== 'none' && b.style.display !== 'none';
            """
        ),
        "Both Mini-Pan A and Mini-Pan B floating boxes visible",
    )
    pre_mp_stats = http_get_json(stats_url)
    mp_drag = client.execute_script(
        """
        const hdr = document.querySelector('[data-testid="minipan-drag-a"]');
        const r0 = document.querySelector('[data-testid="minipan-box-a"]').getBoundingClientRect();
        const rB0 = document.querySelector('[data-testid="minipan-box-b"]').getBoundingClientRect();
        const hr = hdr.getBoundingClientRect();
        return {
            hx: Math.round(hr.left + hr.width / 2),
            hy: Math.round(hr.top + hr.height / 2),
            r0: { left: r0.left, top: r0.top },
            rB0: { left: rB0.left, top: rB0.top },
            innerW: window.innerWidth,
        };
        """
    )
    assert mp_drag["r0"]["left"] < mp_drag["innerW"] * 0.35, f"Expected Mini-Pan A docked on left near VFO A, got {mp_drag}"
    assert mp_drag["rB0"]["left"] > mp_drag["innerW"] * 0.60 and mp_drag["r0"]["left"] < mp_drag["rB0"]["left"], f"Expected Mini-Pan B docked on right near VFO B, got {mp_drag}"
    client.perform_actions(
        [
            {
                "type": "pointer",
                "id": "mouse",
                "parameters": {"pointerType": "mouse"},
                "actions": [
                    {"type": "pointerMove", "duration": 0, "x": mp_drag["hx"], "y": mp_drag["hy"], "origin": "viewport"},
                    {"type": "pointerDown", "button": 0},
                    {"type": "pointerMove", "duration": 40, "x": mp_drag["hx"] + 80, "y": mp_drag["hy"] + 50, "origin": "viewport"},
                    {"type": "pointerUp", "button": 0},
                ],
            }
        ]
    )
    client.release_actions()
    mp_after_drag = client.execute_script(
        """
        const box = document.querySelector('[data-testid="minipan-box-a"]');
        const r = box.getBoundingClientRect();
        const stored = K4.storage ? K4.storage.get('k4.minipan.pos.a', null) : null;
        box.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
        box.click();
        return { left: r.left, top: r.top, docked: box.dataset.docked, stored };
        """
    )
    assert abs(mp_after_drag["left"] - mp_drag["r0"]["left"]) > 25 and abs(mp_after_drag["top"] - mp_drag["r0"]["top"]) > 25, mp_after_drag
    assert mp_after_drag["docked"] == "false" and isinstance(mp_after_drag["stored"], dict), mp_after_drag
    post_mp_stats = http_get_json(stats_url)
    assert post_mp_stats["faHz"] == pre_mp_stats["faHz"] and post_mp_stats["fbHz"] == pre_mp_stats["fbHz"], (pre_mp_stats, post_mp_stats)

    # Clamp on mobile resize 390x844 and restore 1440x900
    client.set_window_rect(390, 844)
    wait_until(
        lambda: client.execute_script(
            """
            const r = document.querySelector('[data-testid="minipan-box-a"]').getBoundingClientRect();
            return r.width > 0 && r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1;
            """
        ),
        "Mini-Pan A clamps inside 390x844 viewport",
    )
    client.set_window_rect(1440, 900)
    wait_until(lambda: client.execute_script("return window.innerWidth >= 1400;"), "Restore 1440x900 after Mini-Pan clamp test")

    # dblclick header resets position back to left docked side
    client.execute_script(
        "document.querySelector('[data-testid=\"minipan-drag-a\"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));"
    )
    wait_until(
        lambda: client.execute_script(
            f"""
            const box = document.querySelector('[data-testid="minipan-box-a"]');
            const r = box.getBoundingClientRect();
            const stored = K4.storage ? K4.storage.get('k4.minipan.pos.a', null) : null;
            return box && box.dataset.docked === 'true' && stored === null && Math.abs(r.left - {mp_drag["r0"]["left"]}) <= 2;
            """
        ),
        "Double-click Mini-Pan A header snaps back to left docked position",
    )
    client.click_element(client.find_element('[data-testid="minipan-close-a"]'))
    wait_until(
        lambda: client.execute_script(
            """
            const a = document.querySelector('[data-testid="minipan-box-a"]');
            const b = document.querySelector('[data-testid="minipan-box-b"]');
            return a && a.style.display === 'none' && b && b.style.display !== 'none';
            """
        ),
        "Closing Mini-Pan A leaves Mini-Pan B visible",
    )
    client.execute_script("globalThis.k4App.client.sendCat('#MP$0;SB0;');")

    # Item 10: #vfo-cluster controls (A/B AB2/AB5, A>B AB0/AB3, SPLIT FT1/FT0, SUB SB1/SB0) + Split TX indicator
    client.execute_script("globalThis.k4App.client.sendCat('FA00014074000;FB00007074000;MD2;MD$1;FT0;SB0;');")
    wait_until(
        lambda: (st := http_get_json(stats_url))["faHz"] == 14074000 and st["fbHz"] == 7074000,
        "VFO A=14074000 / VFO B=7074000 prepared for VFO cluster checks",
    )
    client.click_element(client.find_element('#vfo-ab-btn'))
    wait_until(
        lambda: (st := http_get_json(stats_url))["faHz"] == 7074000 and st["fbHz"] == 14074000,
        "#vfo-ab-btn swaps VFO A and B (AB2)",
    )
    client.execute_script("document.getElementById('vfo-ab-btn').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));")
    wait_until(
        lambda: (st := http_get_json(stats_url))["faHz"] == 14074000
        and st["fbHz"] == 7074000
        and client.execute_script("const s = globalThis.k4App.state.getSnapshot(); return s.rxA.mode === 1 && s.rxB.mode === 2;"),
        "Shift+click #vfo-ab-btn full-swaps freq + mode A<->B back (AB5)",
    )
    client.click_element(client.find_element('#vfo-a2b-btn'))
    wait_until(
        lambda: http_get_json(stats_url)["fbHz"] == 14074000
        and client.execute_script(
            "const b = document.getElementById('vfo-a2b-btn'); const s = globalThis.k4App.state.getSnapshot(); return b && b.dataset.window === 'full' && s.rxB.mode === 2;"
        ),
        "1st tap #vfo-a2b-btn copies A->B freq (AB0) and opens ALL►B window",
    )
    client.click_element(client.find_element('#vfo-a2b-btn'))
    wait_until(
        lambda: client.execute_script("const s = globalThis.k4App.state.getSnapshot(); return s.rxB.mode === 1 && s.rxB.mode === s.rxA.mode;"),
        "2nd tap #vfo-a2b-btn within 3s copies mode/params A->B (AB3)",
    )
    client.click_element(client.find_element('#vfo-split-btn'))
    wait_until(
        lambda: client.execute_script(
            """
            const s = globalThis.k4App.state.getSnapshot();
            const bTag = document.querySelector('[data-testid="vfo-b-tx-badge"]');
            return s.splitEnabled === true && bTag && !bTag.hidden && bTag.classList.contains('is-split-tx');
            """
        ),
        "#vfo-split-btn toggles Split ON with VFO B is-split-tx badge",
    )
    client.click_element(client.find_element('#vfo-split-btn'))
    wait_until(lambda: client.execute_script("return globalThis.k4App.state.getSnapshot().splitEnabled === false;"), "Split OFF")
    client.click_element(client.find_element('#vfo-sub-btn'))
    wait_until(lambda: client.execute_script("return globalThis.k4App.state.getSnapshot().subRxEnabled === true;"), "#vfo-sub-btn toggles Sub RX ON")
    client.click_element(client.find_element('#vfo-sub-btn'))
    wait_until(lambda: client.execute_script("return globalThis.k4App.state.getSnapshot().subRxEnabled === false;"), "#vfo-sub-btn toggles Sub RX OFF")

    # (b) Item 12: Direct TX posture on connect ('tx-armed' / 'tx-enabled') + continuous power slider + ANT cycle + TEST/PTT
    rx_boot = client.execute_script(
        """
        const snap = globalThis.k4App.state.getSnapshot();
        const bar = document.querySelector('[data-testid="tx-posture-bar"]');
        const ptt = document.querySelector('[data-testid="ptt-btn"]');
        const micBtn = document.querySelector('[data-testid="tx-mic-btn"]');
        return {
          posture: snap.txPosture,
          policy: globalThis.k4App.gate.getPolicy(),
          txActive: snap.txActive,
          barPosture: bar ? bar.dataset.posture : null,
          pttDisabled: ptt ? ptt.disabled : null,
          micBtnExists: Boolean(micBtn),
        };
        """
    )
    assert rx_boot["posture"] == "tx-armed" and rx_boot["policy"] == "tx-enabled", f"Expected tx-armed/tx-enabled on connect: {rx_boot}"
    assert rx_boot["txActive"] is False and rx_boot["barPosture"] == "tx-armed" and rx_boot["pttDisabled"] is False, (
        f"Unexpected direct TX boot UI state: {rx_boot}"
    )

    # Ensure USB mode, open TX / ATU drawer tab, verify continuous slider (0.1..110 L/H), ANT cycle, and default source === 'mic'
    default_src = client.execute_script(
        """
        globalThis.k4App.client.setMode('A', 'USB');
        const btns = Array.from(document.querySelectorAll('.k4-panel-tabs .k4-tab-btn'));
        const txTab = btns.find((b) => b.textContent.includes('TX'));
        if (!txTab) throw new Error('TX / ATU tab button missing');
        txTab.click();
        const srcSel = document.querySelector('[data-testid="tx-audio-source"]');
        if (!srcSel) throw new Error('tx-audio-source select missing');
        return srcSel.value;
        """
    )
    assert default_src == "mic", f"Expected default TX audio source 'mic' on http://localhost, got {default_src!r}"
    wait_until(
        lambda: client.execute_script("return globalThis.k4App.state.getSnapshot().rxA.mode === 2;"),
        "VFO A switched to USB mode for TX audio test",
    )

    # Item 7: Continuous TX power slider (7.5W -> PC075L, 45W -> PC045H)
    client.execute_script(
        """
        const sl = document.querySelector('[data-testid="tx-power-slider"]');
        sl.value = '7.5';
        sl.dispatchEvent(new Event('change', { bubbles: true }));
        """
    )
    wait_until(
        lambda: (st := http_get_json(stats_url))["powerRange"] == "L" and abs(st["powerWatts"] - 7.5) < 0.2,
        "Continuous power slider 7.5W sets L range in simulator",
    )
    client.execute_script(
        """
        const sl = document.querySelector('[data-testid="tx-power-slider"]');
        sl.value = '45';
        sl.dispatchEvent(new Event('change', { bubbles: true }));
        """
    )
    wait_until(
        lambda: (st := http_get_json(stats_url))["powerRange"] == "H" and st["powerWatts"] >= 44,
        "Continuous power slider 45W sets H range in simulator",
    )

    # Item 9: tx-antenna-btn tap-to-cycle ANT 1 -> 2 -> 3 -> 1
    ant_start = http_get_json(stats_url)["txAntenna"]
    for step in range(1, 4):
        expected_ant = ((ant_start - 1 + step) % 3) + 1
        client.click_element(client.find_element('[data-testid="tx-antenna-btn"]'))
        wait_until(
            lambda exp=expected_ant: http_get_json(stats_url)["txAntenna"] == exp
            and client.execute_script(
                "const b = document.querySelector('[data-testid=\"tx-antenna-btn\"]'); return b && b.textContent.includes('ANT ' + arguments[0]);",
                [exp],
            ),
            f"tx-antenna-btn cycles to ANT {expected_ant}",
        )

    # Switch to TX TEST (TS1): warm standby mic opens automatically + steady (non-blinking) TX Test indicators
    client.click_element(client.find_element('[data-testid="tx-mode-test"]'))
    wait_until(
        lambda: client.execute_script(
            """
            const snap = globalThis.k4App.state.getSnapshot();
            const ptt = document.querySelector('[data-testid="ptt-btn"]');
            const bar = document.querySelector('[data-testid="tx-posture-bar"]');
            const ind = document.querySelector('[data-testid="k4-tx-vfo-indicator"]');
            const badge = document.querySelector('[data-testid="vfo-a-tx-badge"]');
            const micBtn = document.querySelector('[data-testid="tx-mic-btn"]');
            const indAnim = ind ? getComputedStyle(ind).animationName : '';
            const badgeAnim = badge ? getComputedStyle(badge).animationName : '';
            return snap.txPosture === 'tx-armed' && snap.txTestMode === true &&
                   bar && bar.dataset.txTest === 'true' &&
                   ptt && ptt.disabled === false &&
                   micBtn && !micBtn.hidden && micBtn.dataset.micState === 'ready' &&
                   ind && ind.textContent === '◀ TX Test' && ind.dataset.state === 'test' &&
                   badge && !badge.classList.contains('is-flashing') &&
                   indAnim === 'none' && badgeAnim === 'none' &&
                   globalThis.k4App.audio._standbyMicStream &&
                   globalThis.k4App.audio._standbyMicStream.getAudioTracks()[0]?.readyState === 'live';
            """
        )
        and http_get_json(stats_url)["txTestMode"] is True,
        "TX TEST (TS1) opens live standby mic stream (MIC RDY) with steady TX Test graphics",
    )

    audio_before = http_get_json(stats_url)["txAudioPacketsIn"]
    ptt_coords = client.execute_script(
        """
        const ptt = document.querySelector('[data-testid="ptt-btn"]');
        const r = ptt.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        """
    )
    # Hold PTT via WebDriver pointerDown using default 'mic' source (Firefox fake mic)
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
                    const micBtn = document.querySelector('[data-testid="tx-mic-btn"]');
                    return snap.txActive === true && snap.txMeters.alcBars > 0 && snap.txMeters.fwdWatts === 0 &&
                           micBtn && micBtn.dataset.micState === 'capturing' &&
                           cl && !cl.hidden && pwr && pwr.textContent.includes('0.0W');
                    """
                )
            ),
            "TX TEST hold-PTT captures live microphone audio with MIC LIVE, ALC > 0 & FWD == 0.0W",
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
            """
            const s = globalThis.k4App.state.getSnapshot();
            const micBtn = document.querySelector('[data-testid="tx-mic-btn"]');
            return s.txActive === false && s.txMeters.fwdWatts === 0 &&
                   micBtn && micBtn.dataset.micState === 'ready' &&
                   globalThis.k4App.audio._standbyMicStream &&
                   globalThis.k4App.audio._standbyMicStream.getAudioTracks()[0]?.readyState === 'live';
            """
        ),
        "PTT release drops TX TEST to RX while keeping standby mic stream live (MIC RDY)",
    )

    # K4 Message Memories (M1-M4 + BANK 1/2 + STOP PB0)
    client.click_element(client.find_element('[data-testid="msg-bank-btn"]'))
    wait_until(
        lambda: client.execute_script(
            "const b = document.querySelector('[data-testid=\"msg-bank-btn\"]'); return b && b.textContent.includes('BANK 2');"
        ),
        "Message Bank toggles to BANK 2",
    )
    client.click_element(client.find_element('[data-testid="msg-m1"]'))
    wait_until(
        lambda: client.execute_script(
            "const s = globalThis.k4App.state.getSnapshot(); return s.dvrPlaying === true && s.dvrSlot === 5;"
        ),
        "Message M1 in Bank 2 triggers PB5",
    )
    client.click_element(client.find_element('[data-testid="msg-stop-btn"]'))
    wait_until(
        lambda: client.execute_script(
            "const s = globalThis.k4App.state.getSnapshot(); return s.dvrPlaying === false && s.dvrSlot === 0;"
        ),
        "Message STOP triggers PB0",
    )
    client.click_element(client.find_element('[data-testid="msg-bank-btn"]'))

    # Clickable 8-sensor grid + top sensor strip graph
    client.execute_script("document.querySelector('[data-testid=\"sensor-tile-pt\"]').click();")
    wait_until(
        lambda: client.execute_script(
            """
            const panel = document.querySelector('[data-testid="sensor-graph-panel"]');
            const canvas = document.querySelector('[data-testid="sensor-graph-canvas"]');
            const tilesOk = ['vs','is','pt','lt','tf','sys','fwd','swr'].every(
              (k) => Boolean(document.querySelector('[data-testid="sensor-tile-' + k + '"]'))
            );
            return tilesOk && panel && panel.hidden === false &&
                   panel.textContent.includes('PA Heatsink') &&
                   canvas && canvas.width > 0 && canvas.height > 0;
            """
        ),
        "Clicking sensor tile pt opens PA Heatsink sensor history graph",
    )
    client.execute_script("document.querySelector('[data-testid=\"strip-sensor-vs\"]').click();")
    wait_until(
        lambda: client.execute_script(
            """
            const panel = document.querySelector('[data-testid="sensor-graph-panel"]');
            return panel && panel.hidden === false && panel.textContent.includes('Supply Voltage');
            """
        ),
        "Clicking top strip VS pill switches graph to Supply Voltage",
    )

    # Toggle TEST off back to normal standby '◀ TX' while remaining tx-armed
    client.click_element(client.find_element('[data-testid="tx-mode-test"]'))
    wait_until(
        lambda: client.execute_script(
            """
            const s = globalThis.k4App.state.getSnapshot();
            const ind = document.querySelector('[data-testid="k4-tx-vfo-indicator"]');
            return s.txPosture === 'tx-armed' && s.txTestMode === false &&
                   ind && ind.textContent === '◀ TX' && ind.dataset.state === 'standby';
            """
        )
        and http_get_json(stats_url)["txTestMode"] is False,
        "TEST switch restores TS0; with ◀ TX indicator while staying tx-armed",
    )

    # Verify Split arrow flips ◀ TX -> TX ▶, then restore VFO A
    client.execute_script("globalThis.k4App.client.setSplit(true);")
    wait_until(
        lambda: client.execute_script(
            "const ind = document.querySelector('[data-testid=\"k4-tx-vfo-indicator\"]'); return ind && ind.textContent === 'TX ▶';"
        ),
        "Split sets K4 indicator to TX ▶",
    )
    client.execute_script("globalThis.k4App.client.setSplit(false);")
    wait_until(
        lambda: client.execute_script(
            "const ind = document.querySelector('[data-testid=\"k4-tx-vfo-indicator\"]'); return ind && ind.textContent === '◀ TX';"
        ),
        "Simplex restores K4 indicator to ◀ TX",
    )

    # Verify independent K4 [TEST] toggle ON and OFF while staying armed
    client.click_element(client.find_element('[data-testid="tx-mode-test"]'))
    wait_until(
        lambda: client.execute_script(
            """
            const s = globalThis.k4App.state.getSnapshot();
            const ind = document.querySelector('[data-testid="k4-tx-vfo-indicator"]');
            return s.txPosture === 'tx-armed' && s.txTestMode === true &&
                   ind && ind.textContent === '◀ TX Test' && ind.dataset.state === 'test';
            """
        )
        and http_get_json(stats_url)["txTestMode"] is True,
        "TEST switch engages TS1; while staying tx-armed",
    )
    client.click_element(client.find_element('[data-testid="tx-mode-test"]'))
    wait_until(
        lambda: client.execute_script(
            """
            const s = globalThis.k4App.state.getSnapshot();
            const ind = document.querySelector('[data-testid="k4-tx-vfo-indicator"]');
            return s.txPosture === 'tx-armed' && s.txTestMode === false &&
                   ind && ind.textContent === '◀ TX' && ind.dataset.state === 'standby';
            """
        )
        and http_get_json(stats_url)["txTestMode"] is False,
        "TEST switch restores TS0; while staying tx-armed",
    )

    # (c) Item 4: Single ATU TUNE (1st tap TU3 -> converges <= 1.3; 2nd tap within 5s -> TU4 Full Search -> Escape keeps tx-armed)
    client.click_element(client.find_element('[data-testid="atu-tune-btn"]'))
    wait_until(
        lambda: http_get_json(stats_url)["atuTuning"] is True
        and client.execute_script(
            """
            const s = globalThis.k4App.state.getSnapshot();
            const badge = document.querySelector('[data-testid="atu-status"]');
            return s.atuTuning === true && s.atuTuneKind === 3 && s.txMeters.swr >= 1.0 && badge && badge.dataset.state === 'tuning';
            """
        ),
        "KAT4 ATU Tune 1st click sends TU3 and starts live SWR tuning",
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

    # 2nd tap on single atu-tune-btn within 5s triggers Full Search (TU4), then Escape aborts while staying tx-armed
    client.click_element(client.find_element('[data-testid="atu-tune-btn"]'))
    wait_until(
        lambda: http_get_json(stats_url)["atuTuning"] is True
        and client.execute_script(
            "const s = globalThis.k4App.state.getSnapshot(); return s.atuTuning === true && s.atuTuneKind === 4;"
        ),
        "2nd ATU TUNE click within 5s upgrades to Full Search (TU4)",
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
            and st["txTestMode"] is False
            and client.execute_script(
                """
                const s = globalThis.k4App.state.getSnapshot();
                const ptt = document.querySelector('[data-testid="ptt-btn"]');
                return s.atuTuning === false && s.txActive === false && s.txPosture === 'tx-armed' &&
                       ptt && ptt.disabled === false;
                """
            )
        ),
        "Escape aborts ATU Full Search cleanly while keeping tx-armed ready",
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
        lambda: http_get_json(stats_url)["txActive"] is False
        and client.execute_script("return globalThis.k4App.state.getSnapshot().txActive === false;"),
        "CW keyer queue drains back to RX cleanly",
        timeout=5.0,
    )

    # Verify STOP TX · RX (Esc) button returns to clean RX while staying tx-armed
    client.click_element(client.find_element('[data-testid="stop-tx-btn"]'))
    wait_until(
        lambda: client.execute_script(
            """
            const s = globalThis.k4App.state.getSnapshot();
            const stopBtn = document.querySelector('[data-testid="stop-tx-btn"]');
            const ptt = document.querySelector('[data-testid="ptt-btn"]');
            return stopBtn && stopBtn.textContent.includes('STOP TX · RX') &&
                   s.txActive === false && s.atuTuning === false &&
                   s.txPosture === 'tx-armed' && ptt && ptt.disabled === false;
            """
        ),
        "STOP TX · RX button aborts cleanly while staying tx-armed",
    )

    # UX Item 6: Subtle ATU Status (#top-atu-btn[data-state="auto"] shows compact 'ATU', not 'ATU AUTO 1.0', and no bright green bg)
    atu_style = client.execute_script(
        """
        const btn = document.getElementById('top-atu-btn');
        const cs = btn ? getComputedStyle(btn) : null;
        return {
          exists: Boolean(btn),
          state: btn ? btn.dataset.state : null,
          text: btn ? btn.textContent.trim() : null,
          bg: cs ? cs.backgroundColor : null,
        };
        """
    )
    assert atu_style["exists"] and atu_style["state"] == "auto" and atu_style["text"] == "ATU", (
        f"Expected #top-atu-btn[data-state=auto] text='ATU', got {atu_style}"
    )
    bg_m = re.match(r"rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)", atu_style["bg"] or "")
    assert bg_m, f"Unexpected ATU backgroundColor: {atu_style['bg']}"
    ar, ag, ab = int(bg_m.group(1)), int(bg_m.group(2)), int(bg_m.group(3))
    aa = float(bg_m.group(4)) if bg_m.group(4) is not None else 1.0
    assert not (aa > 0.08 and ag - ar > 40 and ag > ab), (
        f"Expected subtle non-green ATU background, got {atu_style['bg']}"
    )

    # UX Item 2: Voice Click-to-Tune 1 kHz + Settings Panel ([data-testid="pref-voice-snap-khz"])
    client.execute_script(
        "globalThis.k4App.client.sendCat('MD2;FA00014227000;#FXT0;#SPN48000;#MP0;#MP$0;'); globalThis.k4App.client.setStep('A', 2);"
    )
    wait_until(
        lambda: http_get_json(stats_url)["faHz"] == 14227000
        and client.execute_script(
            """
            const s = globalThis.k4App.state.getSnapshot();
            const m = globalThis.k4App.panadapter.getMetrics();
            return s.rxA.mode === 2 && s.rxA.stepHz === 100 && Math.abs(m.panCenterHz - 14227000) <= 50 && m.userSpanHz === 48000;
            """
        ),
        "VFO A prepared at 14227000 USB (stepHz=100, 48 kHz span) for Voice 1 kHz click-to-tune test",
    )
    step_before_snap = client.execute_script("return globalThis.k4App.state.getSnapshot().rxA.stepHz || 100;")
    assert step_before_snap == 100, f"Expected initial rxA.stepHz == 100, got {step_before_snap}"

    client.click_element(client.find_element('[data-testid="settings-btn"]'))
    wait_until(
        lambda: client.execute_script(
            """
            const m = document.querySelector('[data-testid="settings-modal"]');
            const b = document.querySelector('[data-testid="settings-btn"]');
            const t = document.querySelector('[data-testid="pref-voice-snap-khz"]');
            return m && !m.hidden && m.dataset.open === 'true' && b && b.getAttribute('aria-expanded') === 'true' && t && t.classList.contains('is-on');
            """
        ),
        "#settings-btn opens #settings-modal with pref-voice-snap-khz ON",
    )
    client.click_element(client.find_element('[data-testid="settings-close-btn"]'))
    wait_until(
        lambda: client.execute_script("return document.querySelector('[data-testid=\"settings-modal\"]')?.hidden === true;"),
        "Settings modal closes cleanly",
    )

    def click_pan_offset_hz(offset_hz: int):
        pt = client.execute_script(
            """
            const c = document.querySelector('[data-testid="pan-canvas"]');
            const r = c.getBoundingClientRect();
            const hit = globalThis.k4App.panadapter._interaction._hitTest(r.width * 0.5, r.height * 0.28);
            const spec = hit.layout.specRect;
            const xPx = K4.SpectrumGeometry.xFromRfFreq(
              hit.panCenterHz + arguments[0],
              spec.x,
              spec.w,
              hit.panCenterHz,
              hit.userSpanHz
            );
            return {
              x: Math.round(r.left + xPx),
              y: Math.round(r.top + spec.y + Math.min(spec.h * 0.5, 90)),
            };
            """,
            [offset_hz],
        )
        client.perform_actions(
            [
                {
                    "type": "pointer",
                    "id": "mouse",
                    "parameters": {"pointerType": "mouse"},
                    "actions": [
                        {"type": "pointerMove", "duration": 0, "x": pt["x"], "y": pt["y"], "origin": "viewport"},
                        {"type": "pointerDown", "button": 0},
                        {"type": "pointerUp", "button": 0},
                    ],
                }
            ]
        )
        client.release_actions()

    click_pan_offset_hz(4340)
    wait_until(
        lambda: http_get_json(stats_url)["faHz"] != 14227000,
        "USB panadapter click tuned VFO A with 1 kHz snap ON",
    )
    fa_voice_snapped = http_get_json(stats_url)["faHz"]
    step_after_on = client.execute_script("return globalThis.k4App.state.getSnapshot().rxA.stepHz;")
    assert 14230000 <= fa_voice_snapped <= 14232000 and fa_voice_snapped % 1000 == 0, (
        f"Expected 1 kHz snapped USB click near 14231000, got {fa_voice_snapped}"
    )
    assert step_after_on == step_before_snap, f"Voice click snap altered VFO stepHz: {step_before_snap} -> {step_after_on}"

    # Toggle pref-voice-snap-khz OFF in Settings modal and verify stepHz=100 snapping without altering stepHz
    client.click_element(client.find_element('[data-testid="settings-btn"]'))
    wait_until(
        lambda: client.execute_script("return document.querySelector('[data-testid=\"settings-modal\"]')?.dataset.open === 'true';"),
        "Settings modal reopens",
    )
    client.click_element(client.find_element('[data-testid="pref-voice-snap-khz"]'))
    wait_until(
        lambda: client.execute_script(
            "const t = document.querySelector('[data-testid=\"pref-voice-snap-khz\"]'); return K4.ClientPrefs.get('voiceClickSnapKhz') === false && t && !t.classList.contains('is-on');"
        ),
        "pref-voice-snap-khz toggles OFF cleanly",
    )
    assert client.execute_script("return globalThis.k4App.state.getSnapshot().rxA.stepHz;") == step_before_snap
    client.click_element(client.find_element('[data-testid="settings-close-btn"]'))
    wait_until(
        lambda: client.execute_script("return document.querySelector('[data-testid=\"settings-modal\"]')?.hidden === true;"),
        "Settings modal closes after toggling OFF",
    )

    client.execute_script("globalThis.k4App.client.sendCat('FA00014227000;');")
    wait_until(
        lambda: http_get_json(stats_url)["faHz"] == 14227000
        and client.execute_script("return Math.abs(globalThis.k4App.panadapter.getMetrics().panCenterHz - 14227000) <= 50;"),
        "Reset VFO A to 14227000 before voice snap OFF click test",
    )
    click_pan_offset_hz(4340)
    wait_until(
        lambda: http_get_json(stats_url)["faHz"] != 14227000,
        "USB panadapter click tuned VFO A with 1 kHz snap OFF",
    )
    fa_step_snapped = http_get_json(stats_url)["faHz"]
    assert fa_step_snapped % 100 == 0 and fa_step_snapped % 1000 != 0 and 14231100 <= fa_step_snapped <= 14231600, (
        f"Expected stepHz=100 non-1kHz click near 14231300 when voiceClickSnapKhz=false, got {fa_step_snapped}"
    )

    # Restore pref-voice-snap-khz ON
    client.click_element(client.find_element('[data-testid="settings-btn"]'))
    wait_until(
        lambda: client.execute_script("return document.querySelector('[data-testid=\"settings-modal\"]')?.dataset.open === 'true';"),
        "Settings modal reopens to restore voice snap ON",
    )
    client.click_element(client.find_element('[data-testid="pref-voice-snap-khz"]'))
    wait_until(
        lambda: client.execute_script("return K4.ClientPrefs.get('voiceClickSnapKhz') === true;"),
        "pref-voice-snap-khz toggles back ON cleanly",
    )
    client.perform_actions(
        [{"type": "key", "id": "keyboard", "actions": [{"type": "keyDown", "value": "\uE00C"}, {"type": "keyUp", "value": "\uE00C"}]}]
    )
    client.release_actions()
    wait_until(
        lambda: client.execute_script("return document.querySelector('[data-testid=\"settings-modal\"]')?.hidden === true;"),
        "Escape closes Settings modal",
    )

    # UX Item 3: VFO A/B Swap Panadapter Stability (in-span keeps panCenterHz steady; cross-band cleanly re-centers)
    client.execute_script("globalThis.k4App.client.sendCat('#FXT1;#SPN48000;#SPN$48000;FA00014074000;FB00014084000;');")
    wait_until(
        lambda: http_get_json(stats_url)["faHz"] == 14074000
        and http_get_json(stats_url)["fbHz"] == 14084000
        and client.execute_script(
            "const m = globalThis.k4App.panadapter.getMetrics(); return globalThis.k4App.state.getSnapshot().fixedTune === true && Math.abs(m.panCenterHz - 14074000) <= 50;"
        ),
        "Fixed-Tune in-span VFO A/B prepared at 14074000 / 14084000",
    )
    pan_before_inspan = client.execute_script("return globalThis.k4App.panadapter.getMetrics().panCenterHz;")
    client.click_element(client.find_element('#vfo-ab-btn'))
    wait_until(
        lambda: http_get_json(stats_url)["faHz"] == 14084000 and http_get_json(stats_url)["fbHz"] == 14074000,
        "AB2 swapped in-span VFOs 14074000 <-> 14084000",
    )
    time.sleep(0.15)
    pan_after_inspan = client.execute_script("return globalThis.k4App.panadapter.getMetrics().panCenterHz;")
    assert abs(pan_after_inspan - pan_before_inspan) <= 50, (
        f"In-span AB2 swap jumped panCenterHz: {pan_before_inspan} -> {pan_after_inspan}"
    )

    # Cross-band swap: 14.074 MHz <-> 7.074 MHz cleanly re-centers on 7.074 MHz without stranded offset
    client.execute_script("globalThis.k4App.client.sendCat('FA00014074000;FB00007074000;');")
    wait_until(
        lambda: http_get_json(stats_url)["faHz"] == 14074000
        and http_get_json(stats_url)["fbHz"] == 7074000
        and client.execute_script("return Math.abs(globalThis.k4App.panadapter.getMetrics().panCenterHz - 14074000) <= 50;"),
        "Cross-band VFO A/B prepared at 14074000 / 7074000",
    )
    client.click_element(client.find_element('#vfo-ab-btn'))
    wait_until(
        lambda: http_get_json(stats_url)["faHz"] == 7074000
        and http_get_json(stats_url)["fbHz"] == 14074000
        and client.execute_script("return Math.abs(globalThis.k4App.panadapter.getMetrics().panCenterHz - 7074000) <= 50;"),
        "Cross-band AB2 swap re-centered panCenterHz cleanly on 7074000",
    )

    # UX Item 7: K4 Keyboard Shortcuts (ArrowUp/Down +/-10x step, PageUp/PageDown band, digits 14025+Enter, x swap, F1 CW macro, Escape KY @;)
    client.execute_script(
        "globalThis.k4App.client.sendCat('#FXT0;FA00014074000;FB00014080000;MD3;'); globalThis.k4App.setTargetRx('A'); if (document.activeElement) document.activeElement.blur();"
    )
    wait_until(
        lambda: http_get_json(stats_url)["faHz"] == 14074000 and http_get_json(stats_url)["fbHz"] == 14080000,
        "Prepared VFO A=14074000 / VFO B=14080000 for K4 keyboard shortcuts",
    )

    def send_key(key_val: str):
        client.perform_actions(
            [{"type": "key", "id": "keyboard", "actions": [{"type": "keyDown", "value": key_val}, {"type": "keyUp", "value": key_val}]}]
        )
        client.release_actions()

    send_key("\uE013")  # ArrowUp (+10x 100 Hz = +1000 Hz)
    wait_until(lambda: http_get_json(stats_url)["faHz"] == 14075000, "ArrowUp steps VFO A by +10x step (14075000)")
    send_key("\uE015")  # ArrowDown (-10x 100 Hz = -1000 Hz)
    wait_until(lambda: http_get_json(stats_url)["faHz"] == 14074000, "ArrowDown steps VFO A by -10x step (14074000)")

    send_key("\uE00E")  # PageUp (20m -> 17m = 18100000)
    wait_until(lambda: http_get_json(stats_url)["faHz"] == 18100000, "PageUp changes band up to 17m (18100000)")
    send_key("\uE00F")  # PageDown (17m -> 20m = 14074000)
    wait_until(lambda: http_get_json(stats_url)["faHz"] == 14074000, "PageDown changes band down to 20m (14074000)")

    for digit_ch in ["1", "4", "0", "2", "5"]:
        send_key(digit_ch)
    wait_until(
        lambda: client.execute_script(
            "const m = document.querySelector('[data-testid=\"omnibar-modal\"]'); const i = m ? m.querySelector('input') : null; return m && m.dataset.open === 'true' && i && i.value === '14025';"
        ),
        "Direct digit entry 14025 preserves leading '1' inside Omnibar",
    )
    send_key("\uE007")  # Enter
    wait_until(
        lambda: http_get_json(stats_url)["faHz"] == 14025000
        and client.execute_script("return document.querySelector('[data-testid=\"omnibar-modal\"]')?.hidden === true;"),
        "Enter tunes VFO A to 14025000 (14.025 MHz) and closes Omnibar",
    )

    send_key("x")
    wait_until(
        lambda: http_get_json(stats_url)["faHz"] == 14080000 and http_get_json(stats_url)["fbHz"] == 14025000,
        "'x' swaps VFO A and B",
    )

    tx_cmds_before_f1 = http_get_json(stats_url)["txCatCommands"]
    send_key("\uE031")  # F1 macro
    wait_until(
        lambda: http_get_json(stats_url)["txCatCommands"] > tx_cmds_before_f1 and http_get_json(stats_url)["txActive"] is True,
        "'F1' queues CW macro text and activates keying",
    )
    send_key("\uE00C")  # Escape -> panicAbortTx -> KY @;
    wait_until(
        lambda: http_get_json(stats_url)["txActive"] is False
        and client.execute_script("return globalThis.k4App.state.getSnapshot().txActive === false;"),
        "'Escape' aborts F1 CW macro via KY @; cleanly",
    )

    # Restore default VFO state before layout checks and screenshot
    client.execute_script("globalThis.k4App.client.sendCat('FA00014074000;FB00014025000;MD6;MD$3;');")
    wait_until(
        lambda: http_get_json(stats_url)["faHz"] == 14074000 and http_get_json(stats_url)["fbHz"] == 14025000,
        "Restored clean state before desktop screenshot",
    )

    err_toasts = client.execute_script(
        "return Array.from(document.querySelectorAll('.k4-toast[data-level=\"error\"]')).map(e => e.textContent);"
    )
    assert not err_toasts, f"Unexpected error toasts in UI: {err_toasts}"

    desktop_png = os.path.join(out_dir, "e2e-desktop.png")
    client.take_screenshot(desktop_png)
    assert os.path.getsize(desktop_png) > 5000, f"Desktop screenshot too small: {desktop_png}"

    # UX Item 1 & Item 13: Verify top-bar non-overlap, VFO B selectors visible & unclipped, and Omnibar modal strictly below #vfo-b-mount
    # across 1600x900, 1440x900, 1280x800, 1024x768 (Drawer open & closed, Single & SB1 Dual RX)
    def check_desktop_layout(w: int, h: int, dual_rx: bool, drawer_open: bool):
        ov = client.execute_script(
            """
            const ant = document.getElementById('top-ant-btn');
            const atu = document.getElementById('top-atu-btn');
            const sub = document.getElementById('vfo-sub-btn');
            const top = document.getElementById('top-bar');
            const ctr = document.querySelector('.k4-topbar-center');
            const vfoB = document.getElementById('vfo-b-mount');
            const pills = vfoB ? vfoB.querySelector('.k4-vfo-pills') : null;
            const omniBtn = document.getElementById('omnibar-btn');
            const pillSelectors = ['.k4-vfo-sub-btn', '.k4-vfo-band', '.k4-vfo-mode', '.k4-vfo-bw'];
            const pillMetrics = {};
            for (const sel of pillSelectors) {
              const el = vfoB ? vfoB.querySelector(sel) : null;
              const r = el ? el.getBoundingClientRect() : null;
              const cs = el ? getComputedStyle(el) : null;
              pillMetrics[sel] = {
                ok: Boolean(el && r && r.width > 0 && r.height > 0 && cs && cs.display !== 'none' && cs.visibility !== 'hidden'),
                left: r ? r.left : 0,
                right: r ? r.right : 0,
              };
            }
            const subR = sub ? sub.getBoundingClientRect() : null;
            const hitSub = subR ? document.elementFromPoint(subR.left + subR.width / 2, subR.top + subR.height / 2) : null;
            const antR = ant ? ant.getBoundingClientRect() : null;
            const hitAnt = antR ? document.elementFromPoint(antR.left + antR.width / 2, antR.top + antR.height / 2) : null;
            const ctrR = ctr ? ctr.getBoundingClientRect() : null;
            const vfoBR = vfoB ? vfoB.getBoundingClientRect() : null;
            const pillsR = pills ? pills.getBoundingClientRect() : null;
            const omniR = omniBtn ? omniBtn.getBoundingClientRect() : null;
            const sameRow = Boolean(pillsR && omniR && Math.abs(pillsR.top - omniR.top) < 20);
            return {
              sw: document.documentElement.scrollWidth,
              cw: document.documentElement.clientWidth,
              topSw: top ? top.scrollWidth : 0,
              topCw: top ? top.clientWidth : 0,
              ctrSw: ctr ? ctr.scrollWidth : 0,
              ctrCw: ctr ? ctr.clientWidth : 0,
              antOk: Boolean(ant && ant.offsetParent !== null && (hitAnt === ant || (hitAnt && ant.contains(hitAnt)))),
              atuOk: Boolean(atu && atu.offsetParent !== null),
              subOk: Boolean(sub && sub.offsetParent !== null && (hitSub === sub || (hitSub && sub.contains(hitSub)))),
              vfoBOk: Boolean(vfoB && vfoBR && vfoBR.width > 0 && vfoBR.height > 0 && ctrR && vfoBR.left >= ctrR.left - 1 && vfoBR.right <= ctrR.right + 1),
              pillsUnclipped: Boolean(pillsR && ctrR && pillsR.width > 0 && pillsR.height > 0 && pillsR.left >= ctrR.left - 1 && pillsR.right <= ctrR.right + 1),
              sameRow,
              vfoBPillsRight: pillsR ? pillsR.right : 0,
              omniLeft: omniR ? omniR.left : 0,
              pillMetrics,
            };
            """
        )
        mode_tag = f"{'SB1 Dual RX' if dual_rx else 'Single RX'}, drawer={'open' if drawer_open else 'closed'}"
        assert ov["sw"] <= ov["cw"] and ov["antOk"] and ov["atuOk"] and ov["subOk"], (
            f"Overflow, obscured control, or hidden ANT/ATU at {w}x{h} ({mode_tag}): {ov}"
        )
        assert ov["topSw"] <= ov["topCw"] + 1 and ov["ctrSw"] <= ov["ctrCw"] + 1, (
            f"#top-bar/.k4-topbar-center overflow at {w}x{h} ({mode_tag}): {ov}"
        )
        assert ov["vfoBOk"] and ov["pillsUnclipped"] and all(p["ok"] for p in ov["pillMetrics"].values()), (
            f"VFO B selectors hidden or clipped at {w}x{h} ({mode_tag}): {ov}"
        )
        if ov["sameRow"]:
            assert ov["vfoBPillsRight"] <= ov["omniLeft"] + 1, (
                f"VFO B pills overlap Jump button at {w}x{h} ({mode_tag}): {ov}"
            )

    for w, h in [(1600, 900), (1440, 900), (1280, 800), (1024, 768)]:
        client.set_window_rect(w, h)
        wait_until(lambda tw=w: client.execute_script("return Math.abs(window.innerWidth - arguments[0]) <= 20;", [tw]), f"Resize {w}x{h}")
        for drawer_open in [True, False]:
            cur_open = client.execute_script("return document.getElementById('inspector-drawer')?.dataset.open === 'true';")
            if cur_open != drawer_open:
                client.click_element(client.find_element('#drawer-toggle'))
                wait_until(
                    lambda exp=drawer_open: client.execute_script("return document.getElementById('inspector-drawer')?.dataset.open === arguments[0];", ["true" if exp else "false"]),
                    f"Set drawer open={drawer_open} at {w}x{h}",
                )
            check_desktop_layout(w, h, False, drawer_open)
            client.execute_script("globalThis.k4App.client.setSubRx(true);")
            wait_until(
                lambda: client.execute_script("return globalThis.k4App.state.getSnapshot().subRxEnabled === true;"),
                f"Dual RX enabled at {w}x{h} drawer={drawer_open}",
            )
            check_desktop_layout(w, h, True, drawer_open)
            client.execute_script("globalThis.k4App.client.setSubRx(false);")
            wait_until(
                lambda: client.execute_script("return globalThis.k4App.state.getSnapshot().subRxEnabled === false;"),
                f"SB0 restored at {w}x{h} drawer={drawer_open}",
            )

        # Ensure drawer open and verify Omnibar modal card opens strictly below #vfo-b-mount
        if not client.execute_script("return document.getElementById('inspector-drawer')?.dataset.open === 'true';"):
            client.click_element(client.find_element('#drawer-toggle'))
        client.click_element(client.find_element('#omnibar-btn'))
        wait_until(
            lambda: client.execute_script("return document.querySelector('[data-testid=\"omnibar-modal\"]')?.dataset.open === 'true';"),
            f"Omnibar modal opens at {w}x{h}",
        )
        omni_geom = client.execute_script(
            """
            const vfoB = document.getElementById('vfo-b-mount');
            const card = document.querySelector('#omnibar-modal .k4-omnibar-card');
            const vr = vfoB ? vfoB.getBoundingClientRect() : null;
            const cr = card ? card.getBoundingClientRect() : null;
            const modePill = vfoB ? vfoB.querySelector('.k4-vfo-mode') : null;
            const mpR = modePill ? modePill.getBoundingClientRect() : null;
            const hitMp = mpR ? document.elementFromPoint(mpR.left + mpR.width / 2, mpR.top + mpR.height / 2) : null;
            return {
              vfoBBottom: vr ? vr.bottom : 0,
              cardTop: cr ? cr.top : 0,
              vfoBUnobscured: Boolean(modePill && hitMp && (hitMp === modePill || modePill.contains(hitMp))),
            };
            """
        )
        assert omni_geom["cardTop"] >= omni_geom["vfoBBottom"] - 0.5 and omni_geom["vfoBUnobscured"], (
            f"Omnibar modal overlaps VFO B at {w}x{h}: {omni_geom}"
        )
        send_key("\uE00C")
        wait_until(
            lambda: client.execute_script("return document.querySelector('[data-testid=\"omnibar-modal\"]')?.hidden === true;"),
            f"Omnibar modal closes at {w}x{h}",
        )

    # UX Item 5: Pixel 10 (412x924) Dual-VFO Visibility & tap-to-select without horizontal overflow
    client.set_viewport_size(412, 924)
    wait_until(
        lambda: client.execute_script(
            "const nav = document.querySelector('[data-testid=\"mobile-nav\"]'); return window.innerWidth === 412 && nav && getComputedStyle(nav).display !== 'none';"
        ),
        "mobile nav bar visible at 412x924",
    )
    pixel_check = client.execute_script(
        """
        const va = document.querySelector('[data-testid="vfo-a-freq"]');
        const vb = document.querySelector('[data-testid="vfo-b-freq"]');
        const ra = va ? va.getBoundingClientRect() : null;
        const rb = vb ? vb.getBoundingClientRect() : null;
        return {
          iw: window.innerWidth,
          ih: window.innerHeight,
          sw: document.documentElement.scrollWidth,
          cw: document.documentElement.clientWidth,
          aVis: Boolean(va && ra && ra.width > 0 && ra.height > 0 && getComputedStyle(va).display !== 'none'),
          bVis: Boolean(vb && rb && rb.width > 0 && rb.height > 0 && getComputedStyle(vb).display !== 'none'),
        };
        """
    )
    assert pixel_check["iw"] == 412 and pixel_check["sw"] <= 412 and pixel_check["aVis"] and pixel_check["bVis"], (
        f"Expected both VFO A & B visible with scrollWidth <= 412 at 412x924: {pixel_check}"
    )

    client.click_element(client.find_element('[data-testid="vfo-b-freq"]'))
    wait_until(
        lambda: client.execute_script(
            """
            const va = document.querySelector('[data-testid="vfo-a-freq"]');
            const vb = document.querySelector('[data-testid="vfo-b-freq"]');
            const slotB = document.querySelector('[data-testid="vfo-b"]');
            const ra = va ? va.getBoundingClientRect() : null;
            return slotB && slotB.dataset.target === 'true' && ra && ra.width > 0 && ra.height > 0 && vb && vb.getBoundingClientRect().width > 0;
            """
        ),
        "Tapping VFO B at 412x924 selects B while VFO A remains visible",
    )
    client.click_element(client.find_element('[data-testid="vfo-a-freq"]'))
    wait_until(
        lambda: client.execute_script(
            """
            const va = document.querySelector('[data-testid="vfo-a-freq"]');
            const vb = document.querySelector('[data-testid="vfo-b-freq"]');
            const slotA = document.querySelector('[data-testid="vfo-a"]');
            const rb = vb ? vb.getBoundingClientRect() : null;
            return slotA && slotA.dataset.target === 'true' && rb && rb.width > 0 && rb.height > 0 && va && va.getBoundingClientRect().width > 0;
            """
        ),
        "Tapping VFO A at 412x924 selects A while VFO B remains visible",
    )

    # Switch to Mobile 390x844 and verify mobile nav + bottom sheet + persistent ANT/ATU + 0px horizontal overflow
    client.set_viewport_size(390, 844)
    wait_until(
        lambda: client.execute_script(
            "const nav = document.querySelector('[data-testid=\"mobile-nav\"]'); return window.innerWidth === 390 && nav && getComputedStyle(nav).display !== 'none';"
        ),
        "mobile nav bar visible at 390x844",
    )
    mob_overflow = client.execute_script(
        """
        const ant = document.getElementById('top-ant-btn');
        const atu = document.getElementById('top-atu-btn');
        const ptt = document.getElementById('ptt-btn');
        const top = document.getElementById('top-bar');
        const pttR = ptt ? ptt.getBoundingClientRect() : null;
        return {
          sw: document.documentElement.scrollWidth,
          cw: document.documentElement.clientWidth,
          topSw: top ? top.scrollWidth : 0,
          topCw: top ? top.clientWidth : 0,
          antOk: Boolean(ant && ant.offsetParent !== null),
          atuOk: Boolean(atu && atu.offsetParent !== null),
          pttInView: Boolean(pttR && pttR.width > 0 && pttR.right <= document.documentElement.clientWidth + 1),
        };
        """
    )
    assert mob_overflow["sw"] <= mob_overflow["cw"] and mob_overflow["topSw"] <= mob_overflow["topCw"] + 1 and mob_overflow["antOk"] and mob_overflow["atuOk"] and mob_overflow["pttInView"], (
        f"Horizontal overflow, clipped PTT, or missing ANT/ATU at 390x844 (Single RX): {mob_overflow}"
    )
    # Verify Dual RX at 390x844 also has zero horizontal overflow
    client.execute_script("globalThis.k4App.client.setSubRx(true);")
    wait_until(
        lambda: client.execute_script("return globalThis.k4App.state.getSnapshot().subRxEnabled === true;"),
        "Dual RX enabled at 390x844 overflow check",
    )
    mob_dual_overflow = client.execute_script(
        "return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };"
    )
    assert mob_dual_overflow["sw"] <= mob_dual_overflow["cw"], f"Horizontal overflow at 390x844 (Dual RX): {mob_dual_overflow}"
    client.execute_script("globalThis.k4App.client.setSubRx(false);")
    wait_until(
        lambda: client.execute_script("return globalThis.k4App.state.getSnapshot().subRxEnabled === false;"),
        "Dual RX disabled before mobile screenshot",
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
    client.reset_viewport_size()

    stats = http_get_json(stats_url)
    assert stats["txBlockedViolations"] == 0, f"TX leaked to simulator! stats={stats}"

    errs = client.collect_console_errors()
    assert not errs, f"Console errors during HTTP E2E: {errs}"
    print(f"      PASS: localhost SecureContext, all 13 UI/Sim overhaul checks + Desktop ({desktop_png}) + Mobile ({mobile_png}), 0 console errors")


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
                "-model", "k4",
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
            f.write('user_pref("media.navigator.streams.fake", true);\n')
            f.write('user_pref("media.navigator.permission.disabled", true);\n')

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
