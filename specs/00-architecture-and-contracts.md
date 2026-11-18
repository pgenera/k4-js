# Spec 00: Architecture, Contracts, File Ownership, and `file://` Rules

## 1. Hard Execution & Compatibility Constraints
1. **Zero Node.js**: No `node`, `npm`, `npx`, `package.json`, TypeScript compiler, or bundler anywhere in build, runtime, or tests.
2. **Works Directly on `file://` AND `http(s)://`**:
   - Opening `file:///path/to/k4-js/web/index.html` or `file:///path/to/k4-js/web/test.html` directly in Firefox or Chromium MUST work without CORS errors or SecureContext crashes.
   - **Forbidden syntax**: `<script type="module">`, ES `import`, ES `export`, dynamic `import()`, external `<link>` fonts/icons, `fetch()` of relative files.
   - **Required module pattern**: Every JS file uses `'use strict'; (() => { ... })()` and attaches public symbols to `globalThis.K4 = globalThis.K4 || {}`.
   - `localStorage` and `sessionStorage` MUST be wrapped in `try/catch` with an in-memory `Map` fallback (`K4.storage`).
   - Do not assume `crypto.subtle`, `AudioDecoder`, or `audioContext.audioWorklet` exist on `file://` (Firefox `window.isSecureContext === false`). Provide deterministic fallbacks for every one of them.

## 2. Deterministic `<script defer>` Load Order
Both `web/index.html` and `web/test.html` MUST load scripts in this exact order:
1. `js/util/events.js`
2. `js/util/storage.js`
3. `js/protocol/sha384.js`
4. `js/protocol/framer.js`
5. `js/protocol/cat-codec.js`
6. `js/protocol/binary-packets.js`
7. `js/transport/rx-only-gate.js`
8. `js/state/radio-state.js`
9. `js/transport/k4-client.js`
10. `js/panadapter/band-plan.js`
11. `js/panadapter/color-luts.js`
12. `js/panadapter/dsp.js`
13. `js/panadapter/webgl-renderer.js`
14. `js/panadapter/interaction.js`
15. `js/panadapter/panadapter-view.js`
16. `js/audio/pcm-decoder.js`
17. `js/audio/opus-decoder.js`
18. `js/audio/worklet-source.js`
19. `js/audio/audio-engine.js`
20. `js/ui/vfo-widget.js`
21. `js/ui/smeter-widget.js`
22. `js/ui/omnibar.js`
23. `js/ui/inspector-panels.js`
24. `js/ui/connection-dialog.js`
25. `js/app.js` (omitted in `web/test.html`, which loads `../tests/browser-unit-tests.js` instead)

## 3. Swarm Disjoint Directory & File Ownership
- **`transport-state`**:
  - `web/js/util/events.js`
  - `web/js/util/storage.js`
  - `web/js/protocol/sha384.js`
  - `web/js/protocol/framer.js`
  - `web/js/protocol/cat-codec.js`
  - `web/js/protocol/binary-packets.js`
  - `web/js/transport/rx-only-gate.js`
  - `web/js/state/radio-state.js`
  - `web/js/transport/k4-client.js`
- **`panadapter`**:
  - `web/js/panadapter/band-plan.js`
  - `web/js/panadapter/color-luts.js`
  - `web/js/panadapter/dsp.js`
  - `web/js/panadapter/webgl-renderer.js`
  - `web/js/panadapter/interaction.js`
  - `web/js/panadapter/panadapter-view.js`
- **`audio`**:
  - `web/js/audio/pcm-decoder.js`
  - `web/js/audio/opus-decoder.js`
  - `web/js/audio/worklet-source.js`
  - `web/js/audio/audio-engine.js`
- **`ui`**:
  - `web/index.html`
  - `web/css/tokens.css`
  - `web/css/layout.css`
  - `web/css/components.css`
  - `web/js/ui/vfo-widget.js`
  - `web/js/ui/smeter-widget.js`
  - `web/js/ui/omnibar.js`
  - `web/js/ui/inspector-panels.js`
  - `web/js/ui/connection-dialog.js`
  - `web/js/app.js`
- **`sim-deploy`**:
  - `sim/go.mod`, `sim/protocol.go`, `sim/radio.go`, `sim/dsp_synth.go`, `sim/main.go`, `sim/sim_test.go`
  - `scripts/dev.sh`
  - `deploy/k4-websockify.service`, `deploy/k4-websocat.service`
  - `web/test.html`, `tests/browser-unit-tests.js`, `tests/e2e_verify.py`
  - `README.md`

## 4. Exported Namespace Summary (`globalThis.K4`)
Every class and helper signature referenced across boundaries MUST match these exact names:
- `K4.EventEmitter`: `.on(event, fn) -> unsub`, `.off(event, fn)`, `.once(event, fn)`, `.emit(event, payload)`
- `K4.storage`: `.get(key, defaultVal)`, `.set(key, val)`, `.remove(key)`, `.getSession(key, defaultVal)`, `.setSession(key, val)`; `K4.BookmarkStore`: `.list()`, `.add(bm)`, `.remove(id)`, `.resetDefaults()`, `.subscribe(fn)`
- `K4.sha384HexSync(input)` -> 96-char lowercase hex string; `K4.sha384Hex(input)` -> `Promise<string>`
- `K4.PacketConstants`: `{ START_MARKER, END_MARKER, HEADER_SIZE: 4, LENGTH_SIZE: 4, FOOTER_SIZE: 4, OVERHEAD: 12, MAX_PAYLOAD_SIZE: 262144, TYPE_CAT: 0, TYPE_AUDIO: 1, TYPE_PAN: 2, TYPE_MINIPAN: 3 }`
- `K4.PacketFramer`: `.push(uint8Array)`, `.reset()`, `.getStats()`; static `.encodePacket(payloadUint8)`, `.encodeCatPacket(catAscii)`
- `K4.CatCodec`: `{ splitFrames(str), parseCommand(rawCmd), builders }`
- `K4.BinaryPackets`: `{ parse(u8), parseCat(u8), parseAudio(u8), parsePan(u8), parseMiniPan(u8) }`
- `K4.RxOnlyGate`: `.getPolicy()`, `.inspectCat(cmdStr)`, `.inspectBinary(typeByte)`, `.getStats()`, emits `'blocked'`
- `K4.BANDS`, `K4.MODES`, `K4.STEP_HZ_TABLE`, `K4.SL_FRAMES_TABLE`, `K4.RadioState`
- `K4.Client`: static `.defaultWsUrl()`, `.connect(opts)`, `.disconnect()`, `.sendCat(cmdStr)`, `.tune(rx, freqHz, opts)`, `.stepFrequency(rx, steps, stepHzOverride)`, `.setBand(rx, bandIdOrDef)`, `.setMode(rx, modeKey, dataSubMode)`, `.getMetrics()`; emits `'state'`, `'pan'`, `'minipan'`, `'audio'`, `'cat'`, `'connection'`, `'blocked'`, `'error'`
- `K4.BandPlan`, `K4.WaterfallLuts`, `K4.SpectrumScale`, `K4.SpectrumGeometry`, `K4.PowerAverager`, `K4.WaterfallRowMapper`, `K4.createPanRenderer`, `K4.PanadapterInteraction`, `K4.PanadapterView`
- `K4.PcmDecoder`, `K4.OpusPacketDecoder`, `K4.createWorkletDataUrl`, `K4.mixStereoSample`, `K4.AudioEngine`
- `K4.VfoWidget`, `K4.SMeterWidget`, `K4.Omnibar`, `K4.InspectorPanels`, `K4.ConnectionDialog`, `K4.App`, plus `globalThis.k4App` instance.

## 5. Exact Cross-Component APIs & DOM Contracts

### `K4.Client` (`web/js/transport/k4-client.js`)
- `new K4.Client({ state, gate })` (`state` defaults to `new K4.RadioState()`, `gate` defaults to `new K4.RxOnlyGate('rx-only')`).
- `client.connect({ wsUrl, password, subprotocolMode = 'auto', encodeMode = 'auto', latencyTier = 2 })` -> returns Promise resolving once WebSocket opens and auth/init bytes are sent (or rejects if initial socket connect fails across subprotocol attempts).
- `client.disconnect()` -> sends `RRN;` if open, stops keepalive timer, closes WS.
- `client.sendCat(cmdStr)`:
  - Passes `cmdStr` through `gate.inspectCat(cmdStr)`. Any blocked commands trigger `'blocked'` event; if `sanitized` is non-empty and WS is open, wraps in `PacketFramer.encodeCatPacket(sanitized)` and sends. Returns `{ sent: boolean, allowed: string[], blocked: string[] }`.
- `client.tune(rx /* 'A'|'B' */, freqHz, { optimistically = true } = {})`: snaps integer Hz clamped `[100000, 54000000]`, updates state if optimistic, sends `FA...;` or `FB...;`.
- `client.stepFrequency(rx, steps, stepHzOverride)`: reads current `freqHz` & `stepHz`, tunes by `steps * stepHz`.
- `client.setBand(rx, bandIdOrDef)` / `client.setMode(rx, modeKey, dataSubMode)` / `client.setDisplay(rx, patch)` / `client.setAudioMix(mix)` / `client.setEncodeMode(em)` / `client.setLatencyTier(sl)` / `client.setRit(rx, patch)` / `client.clearRit(rx)` / `client.setApf(rx, patch)` / `client.setSquelch(rx, level)` / `client.setDiversity(on)`: build & send validated CAT commands and apply immediate optimistic state where helpful (`SL`, display prefs, `tune`).
- Events emitted by `client`: `'connection'`, `'state'`, `'pan'` (`{ rx, pkt }`), `'minipan'` (`{ rx, pkt }`), `'audio'` (`audioPkt`), `'cat'` (`{ parsed, raw }`), `'blocked'`, `'error'`.

### `K4.PanadapterView` (`web/js/panadapter/panadapter-view.js`)
- `new K4.PanadapterView({ container, state, client, renderer = 'auto' })`
- Expects `client` pan packets forwarded via `panView.pushPanPacket(pkt)` and `panView.pushMiniPanPacket(pkt)`, and subscribes to `state.on('change', ...)`.
- `panView.setTargetRx('A'|'B')`, `panView.getTargetRx()`, `panView.setPalette(name)`, `panView.setPeakHold(bool)`, `panView.getMetrics()` -> `{ framesRendered, rendererType, lastClickFreqHz, panCenterHz, userSpanHz, tierKHz }`.
- DOM attributes maintained on `container` (`#pan-stage`): `data-renderer="webgl2|canvas2d"`, `data-frames="<int>"`, `data-target-rx="A|B"`. Inside `container`, main interactive canvas/surface has `.k4-pan-surface` and `data-testid="pan-canvas"`.

### `K4.AudioEngine` (`web/js/audio/audio-engine.js`)
- `new K4.AudioEngine({ state })`
- `audioEngine.start()` (called on user gesture / unmute button click) -> initializes `AudioContext`, tries `audioWorklet` Data URI else falls back cleanly to `ScriptProcessorNode`, returns Promise resolving with `{ started, sinkType }`.
- `audioEngine.setMuted(bool)`, `audioEngine.isMuted()`, `audioEngine.setVolume('A'|'B', gain01)`, `audioEngine.setBalance(panMinus1To1)`, `audioEngine.setMixMode(mxStr)`, `audioEngine.setLatencyTier(sl0to7)`.
- `audioEngine.pushPacket(audioPkt)` -> decodes via `PcmDecoder` (`EM0`/`EM1`) or `OpusPacketDecoder` (`EM2`/`EM3`), applies `32.0` calibrated gain + soft limiter, resamples into stereo ring buffer, and taps 12 kHz PCM into AF FFT & WAV clip recorder.
- `audioEngine.getAfSpectrum(maxHz = 3200)` -> `{ binsDb, binHz, sampleRate, maxHz, hasSignal }`; `startRecording()`, `stopRecording()`, `isRecording()`, `getRecordingStatus()`, and `K4.encodeWavPcm16(...)`.

- **Transmit, Sensors, ATU & Cert-Free Localhost Dev**: See [07-transmit-and-atu.md](./07-transmit-and-atu.md) for the complete TX posture/safety contract (`'rx-only'` default, `'tx-test'` `TS1`, `'tx-armed'` `TS0`, hold-only PTT + Spacebar), `RxOnlyGate` TX allow/deny policy, `K4.BinaryPackets.encodeAudio`, `RadioState` & `K4.Client` TX/ATU/sensor APIs, `AudioEngine` TX sources (`mic` / `two-tone` / `tone-1k` / `wav`), Panadapter TX passband overlay, and UI `data-testid` contracts.

### Stable `data-testid` Attributes for UI & E2E Tests (`ui` & `sim-deploy`)
- `[data-testid="conn-btn"]` (top bar connection status pill)
- `[data-testid="conn-dialog"]`, `[data-testid="ws-url-input"]`, `[data-testid="password-input"]`, `[data-testid="connect-submit"]`, `[data-testid="disconnect-btn"]`
- `[data-testid="vfo-a"]`, `[data-testid="vfo-a-freq"]`, `[data-testid="vfo-a-mode"]`, `[data-testid="vfo-A-rit-badge"]`
- `[data-testid="vfo-b"]`, `[data-testid="vfo-b-freq"]`, `[data-testid="vfo-b-mode"]`, `[data-testid="vfo-B-rit-badge"]`
- `[data-testid="smeter"]`, `[data-testid="smeter-dbm"]`, `[data-testid="smeter-ovf-badge"]`
- `[data-testid="pan-canvas"]`, `[data-testid="hud-freeze-btn"]`
- `[data-testid="af-scope-canvas"]`, `[data-testid="wav-record-btn"]`, `[data-testid="wav-download-link"]`, `[data-testid="diag-supply"]`
- `[data-testid="bookmark-label-input"]`, `[data-testid="bookmark-save-btn"]`, `[data-testid="bookmark-list"]`
- `[data-testid="omnibar-btn"]`, `[data-testid="omnibar-modal"]`, `[data-testid="omnibar-input"]`
- `[data-testid="audio-toggle"]`
- `[data-testid="rx-only-badge"]`
- `[data-testid="drawer-toggle"]`, `[data-testid="inspector-drawer"]`
- `[data-testid="text-ticker"]`
- `[data-testid="mobile-nav"]` (mobile bottom nav bar), `[data-testid="mobile-sheet"]` (mobile bottom sheet)
