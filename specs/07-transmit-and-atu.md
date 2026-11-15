# Spec 07: Transmit (TX), Hardware Sensors, KAT4 ATU Tuning & Cert-Free Localhost Dev

## 1. Safety Philosophy & Operating Postures (`txPosture`)

Every session starts **receive-only by default** — zero transmit capability is armed until the operator explicitly arms it for that live tab session.

### 1.1 Three Operating Postures (`state.txPosture`)
- **`'rx-only'` (Mandatory Default)**:
  - Active on initial page load, after reload, before `connect()`, immediately upon `connect()` completion, and upon `disconnect()` / socket close. Never persisted in `localStorage` or `sessionStorage`.
  - `K4.RxOnlyGate` policy is `'rx-only'`, blocking all TX/ATU/power/keyer SET commands and all outbound `0x01` audio frames.
- **`'tx-test'` (Dry-Run Off-Air Mode — K4 `TS1;`)**:
  - `RxOnlyGate` policy becomes `'tx-enabled'`, `txAudioAllowed` enables while held, and client sends `TS1;TM1;PO1;` (`txTestMode: true`).
  - PTT hold (`PTT` button or held `Spacebar`) keys the transmitter in **TX Test Mode**: the K4 (`TS1;`) puts out **0.0 W RF** while still processing mic/tone `0x01` TX audio and driving live **ALC / CMP** metering so audio levels, compressor, and keyer text can be verified safely off-air.
- **`'tx-armed'` (Live RF Transmit — K4 `TS0;`)**:
  - Triggered explicitly by clicking the **Arm TX** control (2-step confirmation popover showing active **TX VFO frequency**, **Mode**, **Power (`PC`)**, and **Selected TX Antenna (`AN` + `ACN` label)**).
  - Sets `RxOnlyGate` policy `'tx-enabled'` and sends `TS0;TM1;PO1;`.

### 1.2 Hold-Only PTT & Emergency Fail-Safes
- **Hold-Only Gesture**:
  - **Pointer Hold**: `pointerdown` on `[data-testid="ptt-btn"]` calls `setPointerCapture`, starts PTT (`TX;` + TX audio stream); `pointerup`, `pointercancel`, or `lostpointercapture` immediately stops PTT (`RX;`).
  - **Spacebar Hold**: Pressing `Space` (`e.code === 'Space'`, ignoring `e.repeat === true`) while `txPosture !== 'rx-only'` starts PTT; releasing `Space` (`keyup`) immediately stops PTT.
  - **Spacebar Guardrails**: `Space` NEVER triggers PTT if `txPosture === 'rx-only'`, if a modal is open (`omnibar-modal` or `connection-dialog` open), or if focus is inside an editable element (`INPUT`, `TEXTAREA`, `SELECT`, or `isContentEditable`).
- **Time-Out Timer (TOT) & Panic Fail-Safes**:
  - Client-side deadman TOT: configurable `txTimeoutSec` (default `180 s`); automatically calls `panicAbortTx('timeout')` (`TU0;KY @;RX;`) and emits a warning toast if PTT stays held continuously past TOT.
  - **Unconditional Panic Key (`Escape`)**: When `txActive || pttHeld || atuTuning || txBufferCount > 0`, `Escape` immediately sends `TU0;KY @;RX;` and stops TX audio capture.
  - **Window / Socket Loss**: `window` `'blur'`, `document` `'visibilitychange'` (`hidden`), `'pagehide'`, and WebSocket `'close'` immediately drop local TX audio capture and send `RX;` (or `TU0;RX;` if tuning) before closing if socket is open.
  - **Hardware Inhibit (`IN1`)**: When `state.txInhibit === true`, UI disables keying with a clear `TX INHIBIT` indicator.

### 1.3 Hardened `K4.RxOnlyGate` (`web/js/transport/rx-only-gate.js`)
- API:
  - `new K4.RxOnlyGate('rx-only' | 'tx-enabled')`
  - `gate.setPolicy('rx-only' | 'tx-enabled')` -> validates against `['rx-only', 'tx-enabled']`, emits `'policy'` with `{ policy }`.
  - `gate.getPolicy()` -> `'rx-only' | 'tx-enabled'`
  - `gate.setTxAudioAllowed(bool)` / `gate.isTxAudioAllowed()` -> controls whether outbound `0x01` audio passes in `'tx-enabled'` (defaults to `false`; `startPtt()`/`startTxCapture()` sets `true`, `stopPtt()`/`stopTxCapture()` sets `false`).
  - `gate.inspectCat(cmdStr)` -> `{ allowed: string[], blocked: string[], sanitized: string }`
  - `gate.inspectBinary(typeByte)` -> `boolean`
- **Permanent Destructive / Factory / Admin Blocklist (blocked in EVERY policy, including `'tx-enabled'`)**:
  - Prefixes: `EE` (EE Init), `LB` (LPA Bias Cal), `WM` (Wattmeter Cal), `#CAL`, `PS` (Power Off/Restart), `RRP`, `RRC`, `RRT`, `RS`, `EC` (RS232 echo), `SW`, `SWT`, `SWH` (arbitrary front-panel switch emulation), `DARM`, `DARS`, `DAPM`, `DAMP`, `DARC` (raw DVR recording/erase aliases; use `PBn;` only).
- **In `'rx-only'` Policy (100% Backward Compatible with Spec 01)**:
  - Exact allowed additions beyond Spec 01 (`TQ`, `TQX`, `IN`, `TS`, `AT`, `AN`, `ACT`, `ACN1..5`, `PC`, `PCX`, `FT`, `FT0`, `XT`, `TU0`, `RX`, `TM1`, `PO1`, `MG`, `MI`, `MS`, `CP`, `ML0..2`, `KS`, `KP`, `VXC`, `VXV`, `VXD` GET-only queries + `TU0;` emergency abort + `SIDU1;`/`SIRC1;`).
  - All SET forms (`TX;`, `TU1..4;`, `PC050;`, `PC050H;`, `PC050L;`, `KY ...;`, `AN1..3;`, `AN/;`, `AT0..2;`, `FT1;`, `FT/;`, `XT0..1;`, `TS0..1;`, `PB1..8;`, `SW01;`, `SP1..3;`, `MG020;`, `CP010;`, `KS025;`, etc.) remain **strictly blocked**.
- **In `'tx-enabled'` Policy**:
  - Allows Spec 01 RX/pan/audio/session commands PLUS operational TX/ATU/keyer commands (exact or matched via boundary):
    `TX`, `RX`, `TU`, `AT`, `AN`, `ACT`, `ACN`, `FT`, `XT`, `AB`, `PC`, `PCX`, `TM`, `PO`, `TQ`, `TQX`, `IN`, `TS`, `KY`, `KS`, `KP`, `MG`, `MI`, `MS`, `CP`, `ML`, `VX`, `VG`, `VI`, `SD`, `ES`, `DW`, `TE`, `PB`, `RP`, `PL`.
  - Still rejects the Permanent Destructive Blocklist and unknown/arbitrary SET commands by default-deny.
- **KY Mixed-Case Preservation**:
  - For `KY` frames (`/^KY[ RW]?/i`), `inspectCat` uppercases only the command prefix (`KY` + optional space/`R`/`W`) while preserving exact character case of the payload text (required for `PSK-D`).
- **`inspectBinary(typeByte)`**:
  - `0x00` -> `true` (CAT).
  - `0x01` -> `true` **only** if `policy === 'tx-enabled' && txAudioAllowed === true`; otherwise increments `blockedBinaryCount`, records in `recentBlocked`, emits `'blocked'`, and returns `false`.
  - Any other type -> blocked (`false`).

---

## 2. Outbound `0x01` TX Audio Wire Format (`K4.BinaryPackets`)

Add `K4.BinaryPackets.encodeAudio(opts)`:
- Input `{ seq = 0, encodeMode = 1, frameSamplesPerCh, sampleRateCode = 0, audioBytes }`:
  - Allocates `Uint8Array(7 + audioBytes.byteLength)` with 7-byte header matching K4 `ver = 0x01`:
    - `[0] = 0x01` (`TYPE_AUDIO`)
    - `[1] = 0x01` (`ver`)
    - `[2] = seq & 0xff`
    - `[3] = encodeMode & 0xff` (`1` = 12 kHz S16LE PCM)
    - `[4..5] = frameSamplesPerCh` (`uint16` little-endian, in 12 kHz tick units: `240` for 20 ms or `480` for 40 ms)
    - `[6] = sampleRateCode & 0xff` (`0` = 12000 Hz)
    - `[7..] = audioBytes` (`Uint8Array` interleaved or mono S16LE signed 16-bit LE samples scaled to K4 `1/32` wire convention, i.e., peak nominal `~1024..8192` counts for voice/tones).
- Note on unaligned reads/writes: ALWAYS use `DataView` (never typed array views on odd offset `7`) so roundtrip `BinaryPackets.parseAudio(encodeAudio(...))` is 100% lossless and alignment-safe.

---

## 3. TX, ATU & Sensor CAT Codec (`K4.CatCodec`)

### 3.1 New Parsers (`parseCommand(rawCmd)`)
- **`TX;` / `RX;`**: `{ kind: 'txState', rx: null, txActive: true | false }`
- **`TQ0/1;` / `TQX0/1;`**: `{ kind: 'txState', rx: null, txActive: v === 1 }`
- **`IN0/1;`**: `{ kind: 'txInhibit', rx: null, txInhibit: v === 1 }`
- **`TS0/1;`**: `{ kind: 'txTest', rx: null, txTestMode: v === 1 }`
- **`IF[38 chars];`**:
  - Extracts standard Kenwood/Elecraft K4 `IF` fields when length `>= 36`:
    - `freqHz` (bytes `2..12`)
    - `ritOn` (`IF[23] === '1'`), `xitEnabled` (`IF[24] === '1'`), `txActive` (`IF[25] === '1'`), `modeCode` (`IF[26]`), `splitEnabled` (`IF[28] === '1'`) — returns `{ kind: 'ifInfo', rx: 'A', freqHz, ritOn, xitEnabled, txActive, modeCode, splitEnabled }` (without clobbering more specific fields if invalid).
- **`TMaaabbbcccddd;` (12 digits)**:
  - `alcBars = parseInt(0..3, 10)` (`0..9+`)
  - `compDb = parseInt(3..6, 10)` (`0..30` dB)
  - `fwdRaw = parseInt(6..9, 10)` (`watts` in `'H'`, `tenths of W` in `'L'`)
  - `swrTenths = parseInt(9..12, 10)` (`0` when idle, `10` = `1.0:1`, `15` = `1.5:1`, `30` = `3.0:1`)
  - Returns `{ kind: 'txMeters', rx: null, alcBars, compDb, fwdRaw, swrTenths, swr: swrTenths > 0 ? swrTenths / 10 : 0 }`
- **`POnnnn;`**: `{ kind: 'powerOut', rx: null, powerOutWatts: nnnn / 10 }`
- **`PCnnnr;` / `PCnnn;`**:
  - `r = 'L' | 'H' | 'X'` (default `'L'` if omitted per K4 D4 manual).
  - If `r === 'L'`, `powerWatts = nnn / 10` (`0.1..10.0 W`); if `r === 'H'`, `powerWatts = nnn` (`1..110 W`); if `r === 'X'`, `powerWatts = nnn / 10` mW.
  - Returns `{ kind: 'powerControl', rx: null, powerWatts, powerRange: r }`
- **`AT0/1/2;`**: `{ kind: 'atuMode', rx: null, atuMode: 0 | 1 | 2 }` (`0`=NOT INST, `1`=BYPASS, `2`=AUTO)
- **`TU0..4;`**: `{ kind: 'atuTune', rx: null, tuneState: n, tuning: n > 0 }` (`0`=idle/done, `1`=tune, `2`=tune LP, `3`=ATU tune, `4`=ATU extended search)
- **`ANn;`**: `{ kind: 'antenna', rx: null, antenna: n }` (`1..3`)
- **`ACTzabc;`**: `z` (`all`), `a,b,c` (`ANT1..3` enabled flags `0|1`) -> `{ kind: 'txAntennaMask', rx: null, showAll: z === '1', mask: [a === '1', b === '1', c === '1'] }`
- **`ACNnssssss;`**: `n` (`1..5`), `ssssss` (trimmed raw label string or empty for default) -> `{ kind: 'antennaName', rx: null, port: n, name: label }`
- **`XT0/1;`**: `{ kind: 'xit', rx: null, xitEnabled: v === 1 }`
- **`MGxxx;`**: `{ kind: 'micGain', rx: null, micGain: v }` (`0..80`)
- **`CPnnn;`**: `{ kind: 'compLevel', rx: null, compDbSet: v }` (`0..30`)
- **`MLmnnn;`**: `m` (`0`=CW, `1`=AF data, `2`=voice), `nnn` (`0..100`) -> `{ kind: 'txMonitor', rx: null, channel: m, level: nnn }`
- **`MIn;`**: `{ kind: 'micInput', rx: null, micInput: v }` (`0..4`)
- **`MSabcde;`**: 5 digits -> `{ kind: 'micSetup', rx: null, raw }`
- **`ESnbb;`**: `n` (`0|1` ESSB), `bb` (`30..45` in 100 Hz) -> `{ kind: 'essb', rx: null, essb: n === 1, bwHz: bb * 100 }`
- **`VXmn;`**: `m` in `['C','V','D']`, `n` in `0|1` -> `{ kind: 'vox', rx: null, modeChar: m, enabled: n === 1 }`
- **`VGmnnn;`**: `m` in `['V','D']`, `nnn` `0..60` -> `{ kind: 'voxGain', rx: null, modeChar: m, level: nnn }`
- **`VInnn;`**: `{ kind: 'antiVox', rx: null, level: nnn }`
- **`SDxyzzz;`**: `{ kind: 'voxDelay', rx: null, qskFull: x === '1', modeChar: y, delayMs: zzz * 10 }`
- **`KSnnn;`**: `{ kind: 'cwSpeed', rx: null, wpm: clamp(nnn, 8, 100) }`
- **`KP<i:A|B><o:N|R><nnn>;`**: `{ kind: 'keyerPaddle', rx: null, iambic: i, paddleOrder: o, weight: nnn }`
- **`KY0/1;`**: `{ kind: 'keyerStatus', rx: null, bufferFull: v === 1 }`
- **`PB0..8;`**: `{ kind: 'dvrPlayback', rx: null, slot: n, playing: n > 0 }`
- **`OM ...`**: extend existing `optionModule` parser with `hasAtu: t.includes('A')`, `hasKpa4: t.includes('P')`, `hasHdr: t.includes('H')`, `hasLinearAmp: t.includes('L') || t.includes('1')`.
- **`SI*`**: ensure `SIRF` parses `PT` (`paTempC`), `LT` (`lpaTempC`), `PA` (`paAmps`), `V27`/`VH` if present, `SIDU` parses `T` (`ducTempC`), and `SIFP` tracks `VS` (`supplyVolts`), `IS` (`supplyAmps`), `TF` (`fpTempC`).

### 3.2 New Builders (`K4.CatCodec.builders`)
- `tx()` -> `'TX;'`, `rx()` -> `'RX;'`, `txQuery(fast = true)` -> `fast ? 'TQX;' : 'TQ;'`
- `txTest(on)` -> `'TS' + (on ? '1' : '0') + ';'`
- `txMeters(on)` -> `'TM' + (on ? '1' : '0') + ';'`
- `powerOutAuto(on)` -> `'PO' + (on ? '1' : '0') + ';'`
- `power(watts, range)`:
  - If `range === 'L'` (or `!range && watts <= 10`), clamp `[0.1, 10.0]` -> `'PC' + String(Math.round(watts * 10)).padStart(3, '0') + 'L;'` (note `PC050L;` = `5.0 W`)
  - If `range === 'X'`, clamp `[0.1, 10.0]` -> `'PC' + ... + 'X;'`
  - Else (`range === 'H'` or `watts > 10`), clamp `[1, 110]` -> `'PC' + String(Math.round(watts)).padStart(3, '0') + 'H;'`
- `txAntenna(port)` -> `'AN' + clamp(port, 1, 3) + ';'`
- `atuMode(mode)` -> `'AT' + clamp(mode, 1, 2) + ';'` (note: never emit `AT0;` per K4 manual!)
- `atuTune(kind)` -> `'TU' + clamp(kind, 0, 4) + ';'` (`0`=abort, `1`=tune, `2`=tune LP, `3`=ATU tune, `4`=ATU extended search)
- `split(on)` -> `'FT' + (on ? '1' : '0') + ';'`
- `vfoCopy(mode = 3)` -> `'AB' + clamp(mode, 0, 5) + ';'` (`AB3;` copies all VFO A params -> B)
- `xit(on)` -> `'XT' + (on ? '1' : '0') + ';'`
- `micGain(v)` -> `'MG' + pad3(clamp(v, 0, 80)) + ';'`
- `compLevel(v)` -> `'CP' + pad3(clamp(v, 0, 30)) + ';'`
- `txMonitor(modeIdx, v)` -> `'ML' + clamp(modeIdx, 0, 2) + pad3(clamp(v, 0, 100)) + ';'`
- `micInput(v)` -> `'MI' + clamp(v, 0, 4) + ';'`
- `vox(modeChar, on)` -> `'VX' + modeChar + (on ? '1' : '0') + ';'`
- `dvrPlay(slot)` -> `'PB' + clamp(slot, 0, 8) + ';'`
- `cwSpeed(wpm)` -> `'KS' + pad3(clamp(wpm, 8, 100)) + ';'`
- `keyerPaddle(iambic, order, weight)` -> `'KP' + (iambic === 'B' ? 'B' : 'A') + (order === 'R' ? 'R' : 'N') + pad3(snapStep5(clamp(weight, 90, 125))) + ';'`
- `keyerText(text, mode = ' ')`: formats `'KY' + modePrefix + sanitizedText.slice(0, 60) + ';'` (stripping `;` to avoid breaking CAT framing!)
- `keyerAbort()` -> `'KY @;'`

---

## 4. `K4.RadioState` & `K4.Client` TX Contracts

### 4.1 `RadioState` Extended Fields
- Top-level defaults:
  - `txPosture: 'rx-only'`
  - `pttHeld: false`, `txActive: false`, `txTestMode: false`, `txInhibit: false`
  - `splitEnabled: false`, `xitEnabled: false`
  - `powerWatts: 10`, `powerRange: 'L'` (matches `PC` updates; QRP `L` tenths vs QRO `H` integer W)
  - `txMeters: { alcBars: 0, compDb: 0, fwdWatts: 0, swr: 0, peakFwdWatts: 0, peakSwr: 0, active: false, updatedAt: null }`
  - `hasAtu: true`, `hasKpa4: true`, `hasHdr: false`, `hasLinearAmp: false`
  - `atuMode: 2`, `atuTuning: false`, `atuTuneKind: null`, `atuMatchedSwr: null`, `atuLastTunedFreqHz: null`, `atuSearchWindowUntil: 0`
  - `txAntenna: 1`, `txAntennaMask: [true, true, true]`, `antennaNames: { 1: 'ANT1', 2: 'ANT2', 3: 'ANT3', 4: 'RX1', 5: 'RX2' }`
  - `micGain: 15`, `micInput: 4`, `compDbSet: 0`, `monCw: 5`, `monData: 5`, `monVoice: 2`
  - `voxCw: true`, `voxVoice: false`, `voxData: false`
  - `cwSpeedWpm: 20`, `keyerIambic: 'A'`, `keyerPaddleOrder: 'N'`, `keyerWeight: 110`, `keyerBufferFull: false`, `txBufferCount: 0`
  - `txTimeoutSec: 180`, `txStartedAt: null`
  - `telemetry`: adds `peakSupplyAmps: null`, `rxBaselineVolts: null`, `txVoltDrop: null`, `paAmps: null`, `ducTempC: null` (computing `rxBaselineVolts` while `!txActive && !atuTuning` and `txVoltDrop = max(0, rxBaselineVolts - supplyVolts)` during active TX; `peakSupplyAmps = max(peakSupplyAmps, supplyAmps)` during TX/ATU tune).
- Note on `txMeters`:
  - When `TM` arrives: `fwdWatts = (this._state.powerRange === 'L') ? fwdRaw / 10 : fwdRaw`; `swr = swrTenths > 0 ? swrTenths / 10 : 0`; `active = txActive || atuTuning || fwdWatts > 0 || swrTenths > 0 || alcBars > 0`. Update `peakFwdWatts` and `peakSwr` during TX/tune! When `txState` drops back to RX (`txActive === false && atuTuning === false`), reset live instantaneous `alcBars = 0, compDb = 0, fwdWatts = 0, swr = 0, active = false` while keeping `peakFwdWatts` / `peakSwr` from the last transmission (and recording `atuMatchedSwr` when `TU0;` completes a `TU3`/`TU4` tune!).

### 4.2 `K4.Client` TX Methods & Lifecycle
- **On `connect()` AND `disconnect()` AND socket `onclose`**:
  - Unconditionally disarm back to `setTxPosture('rx-only', { silentCat: true })` (plus send `RX;` if disconnecting from active TX), stop TX audio capture, and clear TOT timer!
- **Bootstrap Subscription**: Add `TM1;PO1;SIDU1;SIRC1;` alongside `SIFP1;SIRF1;SIDA1;` (note: `TM1;`, `PO1;`, `SIDU1;`, `SIRC1;` are permitted telemetry/meter subscriptions in `rx-only`!).
- **Methods**:
  - `getTxPosture()` -> `'rx-only' | 'tx-test' | 'tx-armed'`
  - `setTxPosture(posture)`: resets to `'rx-only'` cleanly (`stopPtt()`, `TS0;` if previously test? wait — on `rx-only`, set `gate.setPolicy('rx-only')` BEFORE clearing so no stray TX command leaks; on `'tx-test'`, sets `gate.setPolicy('tx-enabled')` and sends `TS1;TM1;PO1;`; on `'tx-armed'`, sets `gate.setPolicy('tx-enabled')` and sends `TS0;TM1;PO1;`).
  - `startPtt({ maxSeconds } = {})`: refuses if `txPosture === 'rx-only'` or `state.txInhibit` or `!isWsOpen`. Resets peak meters for the new TX keydown, sets `gate.setTxAudioAllowed(true)`, updates `state` (`pttHeld: true, txStartedAt: Date.now()`), starts TOT timer, sends `TX;TM1;PO1;`, notifies attached `AudioEngine` to start streaming TX audio frames if in voice/AF-data mode.
  - `stopPtt()`: clears TOT timer, stops `AudioEngine` TX capture, sets `gate.setTxAudioAllowed(false)`, updates `state` (`pttHeld: false, txStartedAt: null`), sends `RX;`.
  - `sendTxAudioPacket(payloadUint8)`: delegates through `this.sendBinary(0x01, payloadUint8)` so `RxOnlyGate.inspectBinary(0x01)` enforces `tx-enabled && txAudioAllowed`.
  - `panicAbortTx(reason)`: immediately stops `AudioEngine` TX capture, clears TOT timer, sets `gate.setTxAudioAllowed(false)`, updates `state` (`pttHeld: false, txStartedAt: null`), sends `TU0;KY @;RX;`.
  - `setTxAntenna(port)`, `setAtuMode(mode)`, `startAtuTune(kind = 3)` (`TU3;` or `TU4;` or `TU2;` or `TU1;`), `stopAtuTune()` (`TU0;RX;`), `setPowerWatts(watts, range)`, `setSplit(on)`, `setupQuickSplit(offsetHz = 1000)`, `setXit(on, offsetHz)`, `setMicGain(v)`, `setCompression(v)`, `setTxMonitor(channel, v)`, `setMicInput(v)`, `setVox(modeChar, on)`, `playDvr(slot)`, `setCwSpeed(wpm)`, `setKeyerPaddle(opts)`, `sendKeyerText(text, mode = ' ')`, `clearKeyerBuffer()`.

---

## 5. Outbound TX Audio Engine (`K4.AudioEngine`) & Cert-Free Localhost Dev

### 5.1 Why `http://localhost:9280` Works Without Meaningful SSL Certificates
1. **Browser Secure Context Rule**: Under W3C Secure Contexts, `http://localhost:<port>` and `http://127.0.0.1:<port>` are natively **Trustworthy Origins (`window.isSecureContext === true`)** in Chrome, Firefox, Edge, and Safari over plain HTTP — enabling `navigator.mediaDevices.getUserMedia`, `AudioWorklet`, and WebCodecs without any TLS certificate!
2. **No Mixed-Content Blocking**: Serving over plain `http://localhost:9280` lets the app open plain `ws://localhost:9280/ws` to `websockify`. Self-signed `https://` certs break `ws://` via Mixed-Content and silently fail untrusted `wss://` upgrades unless manually accepted per port.
3. **`scripts/dev.sh --serve` Localhost Defaults**: Defaults to `http://localhost:9280/` (printing explicit `http://localhost:9280/` link as recommended TX-capable URL for `getUserMedia` mic capture + `ws://localhost:9280/ws`, while keeping `file://` RX-only + synthetic CW/Tone TX working cleanly). Note: bind `websockify` host flexibly (`127.0.0.1` vs `localhost` — ensure Firefox resolves `localhost` cleanly to `127.0.0.1` since `/etc/hosts` maps `127.0.0.1 localhost`).
4. **Built-in Software TX Sources (Zero-Mic / Offline / Automated E2E)**:
   - Even when no physical microphone is attached (or on `file://` where Firefox sets `window.isSecureContext === false`), `AudioEngine` provides built-in `12 kHz` S16LE (`EM1`) TX generators:
     - `'two-tone'`: precision phase-continuous `700 Hz + 1900 Hz` IMD/SSB test tones at calibrated `1/32` wire level
     - `'tone-1k'`: `1000 Hz` constant-amplitude tune/carrier test tone
     - `'wav'`: custom PCM float buffer loaded via `setTxWaveBuffer(float32, sampleRate)` (e.g., replay a recorded QSO clip!)
     - `'mic'`: live `navigator.mediaDevices.getUserMedia({ audio: { deviceId, echoCancellation: vp, noiseSuppression: vp, autoGainControl: vp } })`, using `AudioWorklet` (inline Data URI) or `ScriptProcessorNode` downsampling cleanly to `12000 Hz`, with soft limiter + real-time TX input RMS VU readout (`getTxInputLevel()`).

### 5.2 `K4.AudioEngine` TX API Additions
- `setTxPacketHandler(fn)`: receives `(encodedPacketUint8, meta)` every `20 ms` (`240` samples @ `12000 Hz`, `EM1` S16LE mono/stereo matching `encodeMode = 1` wire format) while TX capture is active.
- `isMicSecureContextAvailable()`: checks `Boolean(globalThis.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia)`.
- `listAudioInputs()`: returns `Promise<Array<{ deviceId, label }>>` cleanly (returns `[]` if unavailable without throwing).
- `startTxCapture({ source = 'two-tone', deviceId = '', voiceProcessing = false } = {})`
- `stopTxCapture()`
- `setTxWaveBuffer(float32Samples, sampleRate = 12000)`
- Extend `getDiagnostics()`: include `txActive`, `txSource`, `txInputLevel` (`0..1`), `txPacketsOut`, `isSecureContext`.

---

## 6. Panadapter TX Frequency Visualization (`web/js/panadapter/`)

- Add `K4.SpectrumGeometry.computeTxOverlay(snapshot)` in `web/js/panadapter/dsp.js`:
  - Resolves `txVfo = snapshot.splitEnabled ? 'B' : 'A'`, `txState = snapshot['rx' + txVfo]`.
  - Computes `txDialHz = txState.freqHz + (snapshot.xitEnabled ? (txState.ritOffsetHz || 0) : 0)`.
  - Uses `computePassbandRange(Object.assign({}, txState, { freqHz: txDialHz }), snapshot.cwPitchHz)` to compute `{ txVfo, carrierHz, centerHz, lowHz, highHz, isSplitOrXit: Boolean(snapshot.splitEnabled || snapshot.xitEnabled), active: Boolean(snapshot.txActive || snapshot.atuTuning) }`.
- In `web/js/panadapter/webgl-renderer.js`:
  - Render a translucent coral/red **TX Passband & Carrier Pin** (`TX A` / `TX B` / `XIT`) on panes showing that TX frequency whenever `txPosture !== 'rx-only'` OR `isSplitOrXit` OR `active`, pulsing/solid bright coral (`#F43F5E`) during `txActive` / `atuTuning`.
  - Add top-right status pill on the spectrum when `atuTuning` (`ATU TUNE · SWR X.X:1`) or `txTestMode && (txActive || txPosture === 'tx-test')` (`TX TEST · 0W`) or `txInhibit` (`TX INHIBIT`).

---

## 7. UI Design & `data-testid` Contracts (`specs/05-ui-design-system.md` + `ui-tx`)

### 7.1 Top Bar Posture, Meter & Hold-PTT Strip (`web/index.html`, `web/css/components.css`, `web/js/ui/smeter-widget.js`)
- Replace passive `#rx-only-badge` with a cohesive **TX Safety Posture Pill Group**:
  - Preserves `[data-testid="rx-only-badge"]` (`dataset.blocked="true|false"` when blocked attempts > 0 so existing RX tests remain green!) as the `RX ONLY` posture button `[data-testid="tx-mode-rx"]` (or badge inside the posture selector). Specifically: keep `#rx-only-badge` carrying `data-testid="rx-only-badge"` AND clickable/status-aware, alongside explicit `[data-testid="tx-mode-test"]` (`TEST 0W`) and `[data-testid="tx-mode-armed"]` (`ARM TX`) controls cleanly grouped in `#tx-posture-bar`!
  - **2-Step Arm Confirmation Popover (`[data-testid="tx-arm-confirm"]`)**: Clicking `ARM TX` from RX-Only/Test opens an inline confirmation summary displaying `TX VFO · Freq · Mode · Power · Antenna` + `Confirm Live TX` (`[data-testid="tx-arm-confirm-btn"]`) and `Cancel` (single click directly back to `RX ONLY` requires zero confirm — instant safe disarm!).
  - **Hold-Only PTT Button (`[data-testid="ptt-btn"]`)**: Visible/enabled when `txPosture !== 'rx-only'`; displays `HOLD PTT (SPACE)` when idle, glowing coral (`TX LIVE · 1.2s`) or amber dashed (`TX TEST · 0W`) while held, immediately sending `RX;` on release!
- **Dual-Mode Meter (`K4.SMeterWidget`)**:
  - Keeps `[data-testid="smeter"]`, `[data-testid="smeter-dbm"]`, `[data-testid="smeter-ovf-badge"]` in RX mode.
  - When `txActive || atuTuning || pinTxMeters`, reveals `[data-testid="tx-meter-cluster"]` with 4 crisp horizontal telemetry bars (`PWR` watts, `SWR` ratio `1.0:1..5.0:1` color-coded green/amber/red, `ALC` `0..7` bars with sweet-spot marker `4–5`, `CMP` `0..30 dB`).
- **Compact Hardware Sensor Strip (`[data-testid="sensor-strip"]`)**:
  - Compact tabular pill in the inspector/top area showing `VS` (`13.8V`), `IS` (`1.6A` -> `18.5A` TX + `Peak`), `PT` (`PA 32°C` thermal color-coded), and `SWR` (`1.1:1`). Clicking jumps directly to the `TX / ATU` tab's **Sensors & PA Telemetry** card.

### 7.2 Dedicated `TX / ATU` Inspector Tab (`web/js/ui/inspector-panels.js`)
Add `'tx'` (`TX / ATU`) tab alongside `'band-mode'`, `'dsp'`, `'display'`, `'audio'` on Desktop & Mobile:
1. **Safety & Status Card**: Posture buttons (`RX ONLY` / `TX TEST 0W` / `ARM TX`), active TX VFO summary, `TX INHIBIT` indicator, `TOT` remaining countdown, quick `Split (FT)`, `A►B Split +1kHz`, and `XIT (XT)` toggle + offset nudge.
2. **KAT4 ATU & Antenna Card**:
   - TX Antenna selector (`[data-testid="tx-antenna-select"]` or segmented buttons `ANT1`..`ANT3` filtered by `txAntennaMask` and labeled via `antennaNames`, e.g. `1 · G5RV`, `3 · dummy`).
   - ATU Mode (`BYPASS` / `AUTO`), action buttons: `[data-testid="atu-tune-btn"]` (`ATU TUNE`), `[data-testid="atu-full-btn"]` (`FULL SEARCH`, highlighted for 5s after `TU3`), `TUNE LP`, and red `[data-testid="atu-stop-btn"]` (`STOP`).
   - Live status banner `[data-testid="atu-status"]`: displays idle matched SWR (`AUTO · Last Matched 1.1:1`), or animated live tuning state (`TUNING... 2.6:1 → 1.2:1 @ 18W`).
3. **RF Power & Audio TX Card**:
   - Power slider + quick QRP/QRO range pills (`[data-testid="tx-power-slider"]`, `0.1–10.0 W` in `L`, `1–110 W` in `H`), Mic Gain (`MG`), Compression (`CP`), TX Monitor (`ML`), Mic Input (`MI`), VOX (`VXV`/`VXD`), DVR Memory Playback (`PB1..4` / `PB0` Stop).
   - **TX Audio Input Selector (`[data-testid="tx-audio-source"]`)**: `Browser Mic` (enabled natively on `http://localhost:9280`, auto-explains `!window.isSecureContext` on `file://` without broken UI), `Two-Tone 700/1900 Hz`, `1 kHz Tune Tone`, or `Replay Recorded WAV` + live input level bar!
4. **CW / Direct DATA Keyer Card**:
   - Text input `[data-testid="cw-ky-input"]` + `Send` (`[data-testid="cw-ky-send"]`) + `Abort (@)` (`[data-testid="cw-ky-abort"]`), 6 programmable quick macro buttons (`CQ`, `DE CALL`, `599 TU`, `AGN?`, `BK`, `73`), queued buffer gauge (`TB` `txBufferCount`), WPM slider (`KS`), Weight/Iambic (`KP`), QSK/CW VOX (`VXC`). (Documents Web MIDI paddle -> `KZ` as future v2 extension.)
5. **PA, Electrical & Thermal Sensors Card (`[data-testid="tx-sensors-card"]`)**:
   - `Supply Voltage (VS)` + `Under-Load Drop (ΔV)`, `Supply / PA Current (IS)` + `Peak Hold`, `PA Heatsink (PT)`, `LPA Temp (LT)`, `FP Temp (TF)`, `CPU Temp`, `DAP / DUC Temps`, option module pills (`KAT4`, `KPA4`, `KRX4`, `AMP`), thermal alerts (`>= 60°C` warn, `>= 75°C` critical).

---

## 8. Go Simulator `k4sim` TX & Physics Model (`sim/radio.go`, `sim/main.go`, `sim/sim_test.go`)

- **`Radio` TX Mode**:
  - `NewRadio()` defaults to `AllowTx = true` so interactive `dev.sh` and TX E2E work out of the box (optional CLI `-rx-only` sets `AllowTx = false` and legacy `NewRxOnlyRadio()` helper serves strict RX-only unit assertions in `sim_test.go`!).
  - When `AllowTx == true`, operational TX/ATU/power/keyer commands are executed cleanly and increment `txCatCommands` in `/debug/stats`; permanent destructive commands (`EE`, `LB`, `WM`, `#CAL`, `PS`, `RRP`, `RRC`, `RRT`, `EC`, `SW`) ALWAYS increment `txBlockedViolations` and return `?;`. When `AllowTx == false`, all TX prefixes ALSO increment `txBlockedViolations`.
- **Realistic RF Load & KAT4 ATU Physics Model**:
  - Maintain frequency/antenna load SWR curve (e.g., `ANT3 · dummy` = `1.0:1` across HF; `ANT1 · G5RV` = ~`2.8:1` unmatched on 40m/20m until KAT4 tuned -> stores matched entry `(band, ant) -> 1.1:1`).
  - `TU3;` / `TU4;` enters `AtuTuning = true, TxActive = true`, steps LC convergence over `~1.0–1.4 s` (emitted on 100 ms `TM` tick loop: e.g., `2.8:1 -> 2.1:1 -> 1.5:1 -> 1.1:1` @ `18 W`), then commits the match for `(band, ant)`, clears `AtuTuning = false, TxActive = false`, and pushes `TU0;TQ0;TQX0;TM000000000000;` to clients! `TU0;` / `RX;` aborts tuning immediately (`TU0;TQ0;`).
- **Inbound `0x01` TX Audio Loop (`sim/main.go`)**:
  - Reader loop inspects `TypeAudio` (`0x01`) frames sent by the client: increments `TxAudioPacketsIn`, computes frame peak/RMS envelope (`EM1` S16LE @ 12 kHz unaligned LE), and updates simulated modulator envelope `TxAudioEnv` with natural decay (~250 ms hold).
- **10 Hz Real-Time TX Meter & Thermal/Current Physics**:
  - While `TxActive || AtuTuning`:
    - `FwdWatts = 0` when `TxTestMode` (`TS1;`), else scales from `PowerWatts` and `TxAudioEnv` (voice/DATA-A) or `100%` carrier (CW/FM/Tune).
    - `ALC` reaches sweet spot `004–005` bars with moderate audio/mic drive (`>= 006` if overdriven), `CMP` reflects `CompLevel` + modulation.
    - `SIFP` supply current `IS` rises realistically with `FwdWatts` (`1.66 A` RX idle up to `~18.5 A` @ `100 W`, or `~3.2 A` RX bias in `TS1`), `VS` sags proportionally under current (`13.80 V -> 13.10 V`), `SIRF` `PT` (100W PA) & `LT` (LPA) rise smoothly with TX dissipation (`~25°C -> 48°C+`) and cool down in RX!
    - Also report `PT`, `LT`, `PA` current in `SIRF`, and `T` in `SIDU` every telemetry cycle, and emit `TMaaabbbcccddd;` + `POnnnn;` at `10 Hz` whenever TX/Tune is active (and a final zeroed `TM000000000000;PO0000;TU0;TQ0;` on drop!).
- **`KY` CW Buffer Simulation**:
  - `KY <text>;` queues characters (`@` aborts immediately and drops TX if keying), drains asynchronously at simulated `KS` WPM (`1.2 / wpm` s per dit-char approximation), updating `TB` queued digit (`0..9`), and returns `KY0;` (not full) / `KY1;` (if > 45 chars queued).
- **`/debug/stats` Extended JSON**:
  - Keep all existing fields (`totalConnections`, `authPassed`, `authFailed`, `txBlockedViolations`, `lastBlockedTxCmd`, `faHz`, `fbHz`, `modeA`, `modeB`) and add `txCatCommands`, `txAudioPacketsIn`, `txActive`, `txTestMode`, `atuTuning`, `atuMatched`, `lastFwdTenthsW`, `lastSwrTenths`, `lastAlcBars`, `powerWatts`, `powerRange`, `txAntenna`, `atuMode`.
