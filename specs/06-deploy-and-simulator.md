# Spec 06: K4 `:9205` Simulator (`sim/`), `deploy/` Configs, and Test Suites

## 1. Go Standard-Library K4 Simulator (`sim/`)
Must compile cleanly with **Go 1.27 stdlib only** (`go.mod`: `module github.com/k4-web/sim`, `go 1.27`, ZERO third-party dependencies!).

### CLI Flags (`sim/main.go`)
- `-listen`: TCP listen address (default `127.0.0.1:19205`)
- `-password`: Optional password string; if non-empty, compute `sha512.Sum384([]byte(password))` hex and reject (close connection) if client's first 96 bytes do not match. If empty, still require 96 valid lowercase hex bytes (`[0-9a-f]{96}`) before starting stream!
- `-fps`: Panadapter frame rate (default `20` or `30`, clamp `1..30`)
- `-control-http`: Optional loopback HTTP control/debug endpoint (default `127.0.0.1:19206`, `""` disables) exposing `GET /debug/stats` -> JSON `{ totalConnections, authPassed, authFailed, txBlockedViolations, lastBlockedTxCmd, faHz, fbHz, modeA, modeB }` so E2E tests can assert `txBlockedViolations === 0`!

### Simulator Wire Behavior (`sim/protocol.go`, `sim/radio.go`, `sim/dsp_synth.go`)
- Frame/unframe `[0xFE 0xFD 0xFC 0xFB][u32 BE len][payload][0xFB 0xFC 0xFD 0xFE]` identically to K4 firmware.
- Record any forbidden TX command received on TCP (`TX`, `TU`, `KY`, `PC`, `PB`, `SW`, etc.) into atomic `txBlockedViolations` counter and reply with K4 error `?;` (or `ER24:TX BLOCKED IN SIM;`).
- Support all GET & SET CAT commands listed in `specs/02-cat-and-radio-state.md`:
  - `PING<ts>;` -> reply `PONG<ts>;`
  - `RDY;` -> reply full state snapshot string (`FA...;FB...;MD...;...`) plus `IDK4-SIM;` `SN00421;`
  - Deliberately emit periodic `TB$` CW decoded text frames containing literal semicolons, e.g.:
    `TB020CQ DE W6ELE K ; 73 ;` (count `20` chars!) every few seconds when tuned near a simulated CW beacon (`14025000` or `14074000` / `7025000`), exercising the `TB$` semicolon-slicing parser!
  - Synthesize deterministic, realistic 1024-bin PAN (`0x02`) and MiniPAN (`0x03`, when `#MP1;`/`#MP$1;`) spectrum centered on `FA`/`FB` (`+500 Hz` display offset in `CW`!), containing:
    - Simulated noise floor around `-120 dBm` with gentle variance
    - Distinct synthetic signals at known fixed HF frequencies:
      - `14,074,000`–`14,076,500` Hz: FT8 multi-tone cluster
      - `14,025,000` Hz: strong CW beacon (`-58 dBm`) keyed smoothly
      - `14,085,000` Hz: RTTY twin FSK peaks (`170 Hz` spacing)
      - `14,225,000` Hz: SSB voice carrier/sideband hump (`2.4 kHz` wide)
      - `7,074,000` Hz & `7,025,000` Hz: 40m FT8 & CW signals
    - Dynamic `SMH` / `SMH$` dBm updates computed from simulated signal strength inside the active passband!
  - Synthesize 12 kHz stereo `EM1` S16LE (and `EM0` S32LE) audio packets at exact K4 `1/32` scaling (`amplitude ~ max 1024` in S16LE -> after browser `32×` boost = comfortable audible tone when tuned onto a simulated CW/FT8 carrier!) respecting `frameSamplesPerCh` for active `SL` tier (`240 / 480 / 720 / 1440` samples).

## 2. Dev Launcher & Production Deployment Configs
- **`scripts/dev.sh`**: executable helper (`--serve` option to also pass `--web=web --file-only` to `websockify`, otherwise just `k4sim` + `websockify 127.0.0.1:9280 127.0.0.1:19205` for opening `file:///path/to/k4-js/web/index.html`). Traps `SIGINT`/`SIGTERM` cleanly.
- **`deploy/envoy-k4.yaml`**: Complete, documented Envoy `1.39.1` vhost/route/cluster snippet matching `/etc/envoy.yaml` on `k4.example.com` (`envoy.filters.http.file_server` serving `/var/www/k4` + `/ws` WebSocket upgrade route to `127.0.0.1:9280`).
- **`deploy/k4-websockify.service`** and **`deploy/k4-websocat.service`**: Hardened systemd unit templates documenting exact flags (`websocat -b --websocket-protocol binary ...` vs bare `--binary`).
- **`README.md`**: Concise quickstart covering `file://` dev mode (`websockify`), real K4 connection, production Envoy setup, and test commands.

## 3. Automated Verification Suites (`web/test.html`, `tests/`)
- **`web/test.html` + `tests/browser-unit-tests.js`**:
  - Loads all scripts from `specs/00` (using `<script defer src="../web/js/...">` except `app.js`), runs comprehensive deterministic unit tests in the browser (works on `file:///path/to/k4-js/web/test.html`!) and sets `window.__K4_TEST_RESULTS__ = { total, passed, failed, failures: [...] }` plus renders clean pass/fail summary in DOM.
- **`tests/e2e_verify.py`**:
  - Python 3 stdlib (plus `marionette` raw TCP JSON protocol or Firefox Remote Agent WebDriver HTTP/Marionette on `127.0.0.1` — check how `firefox-esr --headless --marionette` speaks port `2828` cleanly with zero external pip installs!).
  - Drives both `file:///path/to/k4-js/web/index.html` and `http://127.0.0.1:9280/`, captures Desktop (`1440x900`) and Mobile (`390x844`) PNG screenshots to `artifacts/` or specified output path, and exits `0` ONLY if all assertions + zero console/JS errors pass!
