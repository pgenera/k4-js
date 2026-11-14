# Elecraft K4 Web Observatory (Receive-Only)

A zero-dependency, receive-only web panadapter, waterfall, decoded-text ticker, and 12 kHz stereo Web Audio client for the **Elecraft K4** transceiver over its native TCP `:9205` network protocol.

- **Zero Node.js / Zero build step**: Pure HTML, CSS, and classic deferred ES scripts (`globalThis.K4`).
- **Works on `file://` and `https://`**: Includes pure-`BigInt` FIPS 180-4 SHA-384 auth, `ScriptProcessorNode` audio fallback, and `Canvas2D` waterfall fallback when WebGL2 or SecureContext APIs (`crypto.subtle`, `AudioWorklet`, `AudioDecoder`) are absent.
- **Strict Receive-Only Safety**: Client-side `K4.RxOnlyGate` enforces `'rx-only'` policy by stripping/blocking all TX, tune, keyer, DVR, power, and outbound `0x01` audio frames before socket transmission.

---

## Quickstart (`file://` Dev Mode with Simulator)

1. Start the Go K4 TCP simulator (`127.0.0.1:19205`) and `websockify` (`127.0.0.1:9280`):

```bash
./scripts/dev.sh
```

2. Open directly in Firefox or Chromium:

```text
file:///path/to/k4-js/web/index.html
```

3. Click **Connect** (pre-filled with `ws://127.0.0.1:9280`; leave password empty for unauthenticated sim or pass `--password secret` to `dev.sh`).

### Serving over HTTP (`--serve`)

```bash
./scripts/dev.sh --serve
```

Then open `http://127.0.0.1:9280/` (auto-selects `ws://127.0.0.1:9280/ws`).

---

## Connecting to a Real Elecraft K4

Forward a local WebSocket port to `<k4-ip>:9205` using either `websockify` or `websocat`:

```bash
# Option A: websockify (expects Sec-WebSocket-Protocol: binary)
websockify 127.0.0.1:9280 <k4-ip>:9205

# Option B: websocat with explicit binary subprotocol
websocat -E -b --websocket-protocol binary ws-l:127.0.0.1:9280 tcp:<k4-ip>:9205
```

Then open `web/index.html`, enter your K4 network password (hashed locally via SHA-384 to 96 lowercase hex bytes before leaving the browser), and click **Connect**.

---

## Production Deployment (Envoy + systemd)

1. Copy static assets from `web/` to `/var/www/k4/`.
2. Install either [deploy/k4-websockify.service](deploy/k4-websockify.service) or [deploy/k4-websocat.service](deploy/k4-websocat.service) to `/etc/systemd/system/`, set `K4_HOST` in `/etc/default/k4-bridge`, and enable/start it.
3. Configure Envoy `1.39.1` using [deploy/envoy-k4.yaml](deploy/envoy-k4.yaml) (`file_server` for `/` and WebSocket upgrade route `/ws` -> `127.0.0.1:9280`).

---

## Running Verification Suites

### 1. Go Simulator Unit & Integration Tests (`go test`)

```bash
cd sim && go test -v -race ./...
```

### 2. Browser Unit Tests (Zero Node, works over `file://`)

Open `file:///path/to/k4-js/web/test.html` in Firefox or Chromium. Results render in the page and populate `window.__K4_TEST_RESULTS__`.

### 3. Headless Firefox End-to-End Verification (Python 3 stdlib + Marionette)

```bash
python3 tests/e2e_verify.py
```

Tests both `file:///path/to/k4-js/web/index.html` and `http://127.0.0.1:<port>/`, verifies auth, state hydration, live spectrum/waterfall rendering, click-to-tune (`FA` / CW `-500 Hz` offset / `Shift`+right-click `FB`), `Cmd/Ctrl+K` omnibar, `TB$` semicolon preservation, `RxOnlyGate` (`txBlockedViolations === 0`), zero console errors, and captures Desktop (`1440x900`) and Mobile (`390x844`) PNG screenshots.
