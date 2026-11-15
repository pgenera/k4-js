# Spec 06: K4 `:9205` Simulator (`sim/`), `deploy/` Configs, and Test Suites

## 1. Go K4 Simulator (`sim/`)
Must build with **zero third-party Go module dependencies** (`go.mod`: `module github.com/k4-web/sim`, `go 1.27`, stdlib-only Go packages!). For live `EM2`/`EM3` Opus encoding on Linux, CGO builds (`opus_cgo.go`, `//go:build cgo && linux`) dynamically load `libopus.so.0` at runtime via `dlopen`/`dlsym` (`<dlfcn.h>`, no compile-time `-lopus` link required), while `!cgo` or non-Linux builds (`opus_nocgo.go`) cleanly fall back to `EM1` PCM.

### CLI Flags (`sim/main.go`)
- `-listen`: TCP listen address (default `127.0.0.1:19205`)
- `-password`: Optional password string; if non-empty, compute `sha512.Sum384([]byte(password))` hex and reject (close connection) if client's first 96 bytes do not match. If empty, still require 96 valid lowercase hex bytes (`[0-9a-f]{96}`) before starting stream!
- `-fps`: Panadapter frame rate (default `20` or `30`, clamp `1..30`)
- `-control-http`: Optional loopback HTTP control/debug endpoint (default `127.0.0.1:19206`, `""` disables) exposing `GET /debug/stats` -> JSON `{ totalConnections, authPassed, authFailed, txBlockedViolations, lastBlockedTxCmd, faHz, fbHz, modeA, modeB }` so E2E tests can assert `txBlockedViolations === 0`!

### Simulator Wire Behavior (`sim/protocol.go`, `sim/radio.go`, `sim/dsp_synth.go`)
- Frame/unframe `[0xFE 0xFD 0xFC 0xFB][u32 BE len][payload][0xFB 0xFC 0xFD 0xFE]` identically to K4 firmware (`ver = 0x01` on `0x01` audio, `ver = 0x00` on `0x00` CAT, `0x02` PAN, and `0x03` MiniPAN).
- Post-auth stream begins immediately with `0x01` audio packets (`EM3` or active encode mode) while `0x02` PAN frames begin after CAT / `RDY;` initialization.
- Record any forbidden TX command received on TCP (`TX`, `TU`, `KY`, `PC`, `PB`, `SW`, etc.) into atomic `txBlockedViolations` counter and reply with K4 error `?;` (or `ER24:TX BLOCKED IN SIM;`).
- Support all GET & SET CAT commands listed in `specs/02-cat-and-radio-state.md`:
  - `PING<ts>;` -> reply bare `PONG;` (matching real K4 `R40.B1` behavior)
  - `RDY;` -> reply full state snapshot string (`FA...;FB...;MD...;AI4;...`, resetting the session to `AI4` so client SETs are not echoed unless the client sends `AI5;`) plus `IDK4-SIM;` `SN00421;` `OM AP-S----4---;` `RV.R-R40.B1;` `MEDF...;` `RDY;`
  - Default `PanRefDbm` `-115` dBm on `RxA` and `RxB` (bottom-referenced `#REF` near `-120 dBm` sim noise floor); `#ARA`, `#AR9`, and `#AR1` anchor `PanRefDbm = -115` (noise floor), while `#ARM` clears `AutoRef` without altering `PanRefDbm` so subsequent manual `#REF` changes stick instead of snapping back to noise floor on active `#ARA`.
  - Support `SL;` GET (`SL<n>;`), silent `SL<n>;` SET, 4-digit `NB0000;` / `NB$0000;`, `VTnm;` (`VT16;`, `VT$13;`), `RG-00;` / `RG-06;`, `#AR1206-021;`, `#FXT0;`/`#FXT1;`, dynamic `OV`/`OV$` (`Preamp >= 2 && AttenDb == 0 && RfGainDb >= 0`), `SI*` (`SIFP`/`SIRF`/`SIDA`/`SIDD`/`SIDU`/`SIRC` subscriptions + 2.5 s periodic `SIFP`/`SICP`/`SIRF`/`SIDA` telemetry frames), `DV1` VFO A->B sync + `SB1`, `RC`/`RC$` RIT clear, `#FPS` dynamic tick rate, `#FRZ` stream pause, `#NB`/`#NBL`, `#DSM`, `#WFH`, `AN;`, `IF`, `#DPM`/`#MP` parity (`SB0` -> `#MP$-1;`), `TD`/`TD$` (`RxA` default `201` for CW beacon `TB` verification, `RxB` default `020`, returning `ER12:SET command incompatible with target VFO's mode.;` if `TD > 0` in incompatible modes like `DATA-A`), `TB;`/`TB$;` empty-buffer `TB000;` / `TB$000;`, and `#SCL$;`/`#WBS$;`/`#AR$;`/`#FXT$;` returning `?;`
  - Deliberately emit periodic `TB$` CW decoded text frames containing literal semicolons, e.g.:
    `TB020CQ DE W6ELE K ; 73 ;` (count `20` chars!) every few seconds when tuned near a simulated CW beacon (`14025000` or `14074000` / `7025000`), exercising the `TB$` semicolon-slicing parser!
  - Synthesize deterministic, realistic 1024-bin `0x02` PAN (`centerFreqHz == FA`/`FB` across all modes, measured 5-tier `#SPN` hysteresis switch points `<=19 -> 24`, `20..36 -> 48`, `37..82 -> 96`, `83..172 -> 192`, `>=176 -> 384` kHz) and `0x03` MiniPAN (when `#MP1;`/`#MP$1;`, firmware shifts `centerFreqHz` by `±cwPitchHz` in CW/CW-R with `spanKHz = 6` in CW/CW-R and `12` otherwise), containing:
    - Simulated noise floor around `-120 dBm` with gentle variance
    - Distinct synthetic signals at known fixed HF frequencies:
      - `14,074,000`–`14,076,500` Hz: FT8 multi-tone cluster
      - `14,025,000` Hz: strong CW beacon (`-58 dBm`) keyed smoothly
      - `14,085,000` Hz: RTTY twin FSK peaks (`170 Hz` spacing)
      - `14,225,000` Hz: SSB voice carrier/sideband hump (`2.4 kHz` wide)
      - `7,074,000` Hz & `7,025,000` Hz: 40m FT8 & CW signals
    - Dynamic `SMH` / `SMH$` dBm updates computed from simulated signal strength inside the active passband!
  - Synthesize 12 kHz stereo `EM1` S16LE and `EM0` S32LE audio packets at exact K4 `1/32` scaling (`amplitude ~ max 1024` in S16LE -> after browser `32×` boost = comfortable audible tone when tuned onto a simulated CW/FT8 carrier!) and, when `libopus.so.0` is available via `dlopen` (`opus_cgo.go` on `cgo && linux`), `EM2` (~64 kbps) / `EM3` (~96 kbps) 48 kHz Opus packets (4× upsampled with `OpusRepacketizer` multi-frame bundling for `SL >= 1`, falling back cleanly to `EM1` under `!cgo` or missing `libopus.so.0`), always setting header `frameSamplesPerCh` in 12 kHz units (`240 / 480 / 720 / 1440`) and `sampleRateCode = 0`.

## 2. Dev Launcher & Production Deployment Configs
- **`scripts/dev.sh`**: executable helper (`--serve` option to also pass `--web=web --file-only` to `websockify`, otherwise just `k4sim` + `websockify 127.0.0.1:9280 127.0.0.1:19205` for opening `file:///path/to/k4-js/web/index.html`). Traps `SIGINT`/`SIGTERM` cleanly.
- **`deploy/envoy-k4.yaml`**: Complete, documented Envoy `1.39.1` vhost/route/cluster snippet matching `/etc/envoy.yaml` on `k4.example.com` (`envoy.filters.http.file_server` serving `/var/www/k4` + `/ws` WebSocket upgrade route to `127.0.0.1:9280`).
- **`deploy/k4-websockify.service`** and **`deploy/k4-websocat.service`**: Hardened systemd unit templates documenting exact flags (`websocat -b --websocket-protocol binary ...` vs bare `--binary`).
- **`README.md`**: Concise quickstart covering `file://` dev mode (`websockify`), real K4 connection, production Envoy setup, and test commands.

## 3. Automated Verification Suites (`web/test.html`, `tests/`, Hardware Regression)
- **`web/test.html` + `tests/browser-unit-tests.js`**:
  - Loads all scripts from `specs/00` (using `<script defer src="../web/js/...">` except `app.js`), runs comprehensive deterministic unit tests in the browser (works on `file:///path/to/k4-js/web/test.html`!) and sets `window.__K4_TEST_RESULTS__ = { total, passed, failed, failures: [...] }` plus renders clean pass/fail summary in DOM.
- **`tests/e2e_verify.py`**:
  - Python 3 stdlib (plus `marionette` raw TCP JSON protocol on `127.0.0.1` — `firefox-esr --headless --marionette` speaks port `2828` cleanly with zero external pip installs!).
  - Drives both `file:///path/to/k4-js/web/index.html` (all 20 browser unit tests + full live WebSocket session including RIT/OVF/Freeze/`#DSM`/`SI*` telemetry/AF Scope/WAV capture/Bookmarks/CW click-to-tune/TX firewall `0`) and `http://127.0.0.1:9280/`, captures Desktop (`1440x900`) and Mobile (`390x844`) PNG screenshots to `artifacts/` or specified output path, and exits `0` ONLY if all assertions + zero console/JS errors pass! (Plus 12 Go tests in `sim/sim_test.go`).
- **Offline Sanitized Hardware Regression Verification**:
  - `k4_hw_probe.py --spawn-sim` validates `k4sim` wire parity across `RDY;`, `AI4`/`AI5`, `SL;` GET vs silent `SL<n>;` SET, `PING`/`PONG;`, `NB`/`VT`/`RG`/`#AR`/`#FXT`/`#MP$-1`/`OM`/`RV`/`MEDF`, 5-tier `#SPN` hysteresis, `0x02` PAN `centerFreqHz == FA`, `0x03` MiniPAN `±cwPitchHz` shift, and `EM0`..`EM3` audio streams.
  - Sanitized real-K4 (`R40.B1`) sample replay (`real_k4_samples.json` via headless Firefox Marionette WebSocket loopback) and Wave 2 capture reference (`real_k4_wave2_capture.json`) verify real-hardware `EM2`/`EM3` Opus (`SL0`/`SL2` TOCs `0xbc`/`0xbd`/`0xbe`), `0x02` PAN, bottom-referenced `#REF` & `#ARA`/`#ARM` interaction, continuous `0x03` Mini-PAN emission under `#MP0`, `#DPM0`/`#DPM1`/`#FXT0` behavior, and `TD`/`ER12` mode compatibility offline.
