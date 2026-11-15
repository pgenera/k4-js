# Spec 03: Panadapter DSP, Waterfall Colorization, WebGL2 Renderer, and Click-to-Tune

## 1. Exact DSP Formulas (`web/js/panadapter/dsp.js`)

### 1.1 `K4.SpectrumScale`
- Constants:
  - `PAN_BYTE_OFFSET = 162.0` (`0x02` PAN: `dBm = byte - 162.0`)
  - `MINIPAN_BYTE_OFFSET = 118.0` (`0x03` MiniPAN: `dBm = byte - 118.0`)
- Static helpers:
  - `decodePanBins(binsUint8, outFloat32)` -> converts `0..255` via `byte - 162.0`.
  - `decodeMiniPanBins(binsUint8, outFloat32)` -> converts `0..255` via `byte - 118.0`.
  - `sUnitForDbm(dBm)` -> returns formatted string (`'S5'`, `'S9+15'`, etc.) and numeric `sUnits` (`<= 9` is `(dBm + 127) / 6`).

### 1.2 `K4.SpectrumGeometry`
- **Hysteresis Span Crop & Measured 5-Tier Switch Points**:
  - Real K4 (`R40.B1`) switches `0x02` PAN `sampleRateKHz` across 5 tiers (`24`, `48`, `96`, `192`, `384` kHz) with measured `#SPN` hysteresis switch/hold boundaries:
    - `<= 19 kHz` -> `24 kHz`
    - `20..36 kHz` -> `48 kHz` (`19..20 kHz` hysteresis zone between `24` and `48`)
    - `37..82 kHz` -> `96 kHz` (`36..37 kHz` hysteresis zone between `48` and `96`)
    - `83..172 kHz` -> `192 kHz` (`82..83 kHz` hysteresis zone between `96` and `192`)
    - `>= 176 kHz` -> `384 kHz` (`172..176 kHz` hysteresis zone between `192` and `384`)
  - `computeCrop(userSpanHz, tierKHz)`:
    - `tierSpanHz = Math.max(1000, tierKHz * 1000)` (`24000`, `48000`, `96000`, `192000`, `384000`)
    - `spanRatio = clamp(userSpanHz / tierSpanHz, 0.01, 1.0)`
    - `leftRatio = 0.5 * (1.0 - spanRatio)`
    - Normalized screen coordinate `u` in `[0, 1]` samples source normalized coordinate `tierU = leftRatio + u * spanRatio`.
    - Source bin index (floating) for N bins: `binF = tierU * (N - 1)`.
- **Mode Display Center & Passband Geometry (`0x02` PAN vs `0x03` MiniPAN)**:
  - On `0x02` main/sub PAN, real K4 firmware keeps `centerFreqHz == FA` (or `FB` for Sub) across **all modes** (CW, CW-R, USB, LSB, DATA-A, AM, FM) under both `#FXT0;` and `#FXT1;` (`delta_hz = 0`); the UI places the CW needle/passband at `FA ± cwPitchHz` via `displayMarkerHz` and reverses that offset in `dialFreqFromClick`.
  - On `0x03` MiniPAN, real K4 firmware itself shifts `centerFreqHz` by `±cwPitchHz` (`FA + cwPitchHz` in CW, `FA - cwPitchHz` in CW-R, `FA` otherwise) with `spanKHz = 6` in CW/CW-R and `12` in USB/LSB/DATA-A/AM/FM.
  - `displayMarkerHz(rxState, cwPitchHz)`:
    - `CW` (`mode === 3`): `rxState.freqHz + cwPitchHz`
    - `CW-R` (`mode === 7`): `rxState.freqHz - cwPitchHz`
    - All other modes: `rxState.freqHz`
  - `computePassbandRange(rxState, cwPitchHz)`:
    - Returns `{ carrierHz, centerHz, lowHz, highHz }`
    - `carrierHz = rxState.freqHz`, `bw = rxState.bwHz`
    - `USB` (`2`) or `DATA`/`DATA-A` (`6` with `dataSubMode === 0`): `center = carrier + rxState.ifShiftHz`
    - `LSB` (`1`): `center = carrier - rxState.ifShiftHz`
    - `CW` (`3`): `center = carrier + (rxState.ifShiftHz || cwPitchHz)`
    - `CW-R` (`7`): `center = carrier - (rxState.ifShiftHz || cwPitchHz)`
    - `AFSK-A` / `FSK-D` (`dataSubMode === 1 || 2` in `DATA`/`DATA-R`): `center = (rxState.mode === 9 ? carrier + 85 : carrier - 85)`
    - `PSK-D` (`dataSubMode === 3`), `AM` (`5`), `FM` (`4`): `center = carrier`
    - `lowHz = center - bw / 2`, `highHz = center + bw / 2`.
- **Click-to-Tune Conversion**:
  - Note `panCenterHz`: on `0x02` PAN, real K4 firmware keeps `panCenterHz === FA` (or `FB` for Sub) across all modes (under both `#FXT0;` and `#FXT1;`), so `rfFreqFromX` yields true RF Hz directly and `dialFreqFromClick` subtracts/adds `cwPitchHz` in CW/CW-R to recover the VFO dial frequency `FA`. (By contrast, on `0x03` MiniPAN, firmware shifts `centerFreqHz` by `±cwPitchHz` with `spanKHz = 6` in CW/CW-R, `12` otherwise.)
  - `rfFreqFromX(xPx, plotLeftPx, plotWidthPx, panCenterHz, userSpanHz)`:
    - `u = clamp((xPx - plotLeftPx) / plotWidthPx, 0, 1)`
    - `return panCenterHz - userSpanHz / 2 + u * userSpanHz`
  - `dialFreqFromClick({ xPx, plotLeftPx, plotWidthPx, panCenterHz, userSpanHz, mode, cwPitchHz, stepHz, fine })`:
    - `rfHz = rfFreqFromX(...)`
    - In `CW` (`mode === 3`): `rawDial = rfHz - cwPitchHz`
    - In `CW-R` (`mode === 7`): `rawDial = rfHz + cwPitchHz`
    - Else: `rawDial = rfHz`
    - `step = fine ? 1 : (stepHz || 100)`
    - `snappedHz = clamp(Math.round(rawDial / step) * step, 100000, 54000000)`
    - Return `snappedHz`.

### 1.3 `K4.PowerAverager`
- Maintains `Float32Array` ring buffer of `depth` frames (sized dynamically when `#AVG` changes, `1..20`), storing linear power `Math.pow(10, dBm / 10)` per bin, running sum per bin, `shownDbm` `Float32Array` for trace smoothing.
- `clear()`: resets ring buffer and `shownDbm` (MUST be called whenever `sampleRateKHz` tier changes or `panCenterHz` jumps `> tierSpanHz / 2`).
- `push(rawDbmBins, avgCount)` -> returns `{ avgDbm: Float32Array, shownDbm: Float32Array, peakDbm: Float32Array }`:
  - `avgDbm[i] = 10 * Math.log10(Math.max(1e-18, sumMw[i] / frameCount))`
  - If `avgCount > 1`: `shownDbm[i] += 0.5 * (avgDbm[i] - shownDbm[i])`; else `shownDbm[i] = avgDbm[i]`.
  - Track decaying peak hold (`peakDbm[i] = Math.max(avgDbm[i], peakDbm[i] - 0.12)`).

### 1.4 `K4.WaterfallRowMapper`
- Uses Elecraft K4 bottom-referenced `#REF` convention (`[minDbm, maxDbm] = [refDbm, refDbm + scaleDb]`, matching QK4's waterfall black-level formula):
- `mapRow(avgDbmBins, { refDbm, scaleDb, wfBlack }, outUint8)`:
  - `spanDb = clamp(scaleDb || 80, 10, 150)`
  - `wbs = (wfBlack >= 5 && wfBlack <= 30) ? wfBlack : 14`
  - `lowDbm = refDbm - spanDb * (wbs / 40.0)`
  - `highDbm = lowDbm + spanDb`
  - `invRange = 1.0 / Math.max(1.0, spanDb)` (i.e., `range = Math.max(1.0, highDbm - lowDbm) = spanDb`)
  - For each bin: `t = clamp((avgDbmBins[i] - lowDbm) * invRange, 0, 1)`; `outUint8[i] = 1 + Math.round(t * 254)` (`0` reserved strictly for uninitialized rows -> transparent/background `#090B10`).

## 2. Waterfall Color LUTs (`web/js/panadapter/color-luts.js`)
Provide 5 crisp, scientific 256-entry RGBA lookup tables (`Uint8Array(1024)`), index `0 = [9, 11, 16, 255]`:
1. `'obsidian'` (Default signature Observatory theme): deep obsidian `#090B10` -> indigo `#1E3A8A` -> electric cyan `#06B6D4` -> luminous amber `#F59E0B` -> incandescent white `#F8FAFC`.
2. `'k4'` (`K4 Classic` 7-stage hardware waterfall ramp): `#000000` -> `#000041` -> `#0000AA` -> `#00C8C8` -> `#00C800` -> `#FFFF00` -> `#FF5000` -> `#FF0000` (with index `0 = [9, 11, 16, 255]`).
3. `'thermal'`: black -> crimson -> orange -> gold -> white.
4. `'viridis'`: perceptual scientific dark purple -> teal -> emerald -> bright yellow.
5. `'cyan'`: high-contrast monochrome cyan (`#071018` -> `#38BDF8` -> `#E0F2FE`) tailored for CW/digital weak-signal decoding.

## 3. Amateur Band Plan Ribbon (`web/js/panadapter/band-plan.js`)
Expose IARU Region 2 segment metadata (`CW`, `Digital`, `Phone/SSB`, `Beacon`) across HF + 6m (`160m..6m`), rendered as a subtle 6px color-coded track along the frequency axis strip with hover tooltip.

## 4. WebGL2 + Canvas2D Dual Renderer (`web/js/panadapter/webgl-renderer.js`, `panadapter-view.js`)
- `createPanRenderer(container, opts)` attempts `canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: true })` (note `preserveDrawingBuffer: true` helps reliable screenshot capture AND pixel inspection tests!). If WebGL2 is unavailable (e.g., disabled software GL in headless mode), seamlessly instantiate `K4.PanadapterCanvas2D` implementing the identical API (`render(frameState)`, `pushWaterfallRow(uint8Row)`, `clearWaterfall()`, `setPalette(name)`, `resize()`, `destroy()`).
- **Bottom-Referenced Amplitude Window (`[minDbm, maxDbm] = [refDbm, refDbm + scaleDb]`)**:
  - Real K4 (`R40.B1`) treats `#REF` (`refDbm`, default `-110 dBm`) as the **bottom edge** of the spectrum window, and `#SCL` (`scaleDb`, default `80 dB`) as the vertical dynamic span above `refDbm`.
  - ALL 4 renderer coordinate calculations — overlay dBm grid/noise-floor/peak-hold, Mini-Pan dBm Y-axis, WebGL `_drawSpectrumGl`, and Canvas2D `_drawSpectrum2D` — MUST map `minDbm = refDbm` at the bottom and `maxDbm = refDbm + scaleDb` at the top (`norm = clamp((dbm - minDbm) / Math.max(1, scaleDb), 0, 1)`).
- **Mini-Pan `0x03` Continuous Streaming & Strict Visibility Gating**:
  - Real K4 firmware continues streaming `0x03` Mini-PAN frames even when `#MP0;` is OFF (verified 14 frames in ~0.6 s after `#MP0;` in `real_k4_wave2_capture.json`).
  - `PanadapterView` buffers incoming `0x03` Mini-PAN frames per RX (`'A'` and `'B'`), NEVER marks Mini-Pan active purely upon receiving a `0x03` packet, and only schedules a render when that RX's `RadioState.miniPan` is `true`.
  - `webgl-renderer.js` MUST gate Mini-Pan loupe rendering strictly on `rxA.miniPan || (snapshot.subRxEnabled && rxB.miniPan && snapshot.rxB.miniPanAvailable !== false)` so turning Mini-Pan OFF produces **zero flicker**.
- **Canvas Layer Stack**:
  1. WebGL2 (or Canvas2D) pixel layer for GPU ring-buffer waterfall (`WIDTH × 512` `R8`/`RGBA8` `NEAREST` filtering so narrow CW/FT8 traces stay pixel-sharp!) + spectrum filled gradient + trace.
  2. Crisp HiDPI Canvas2D overlay layer (`devicePixelRatio` scaled) drawing:
     - Top Spectrum pane (`#DSM1` split configurable via `#WFH020..080`, default `60%` waterfall, or `100%` spectrum when `#DSM0` Spectrum Only is active with `wfRect.h === 0`): horizontal dBm grid (`minDbm = refDbm` .. `maxDbm = refDbm + scaleDb`) & S-unit ticks, vertical kHz ticks, passband translucent curtain (Main `#38BDF8` 18% fill, Sub `#F59E0B` 14% fill when Sub RX enabled), manual notch vertical marker if `notchOn`, dashed RIT offset marker when `ritOn`, peak-hold hairline, `ADC OVF` + `FROZEN` status pills, VFO A & VFO B frequency needles with pill flags, and interactive hover crosshair (`f`, `dBm`, `delta from VFO`).
     - Middle `26px` Axis & Band-Plan strip: crisp tabular kHz labels, band-plan color segments, and saved `K4.BookmarkStore` markers within the visible span.
     - Bottom Waterfall pane (guarded on `wfRect.h > 0`; `PanadapterView` gates incoming `0x02`/`0x03` frames when `panFrozen` / `#FRZ1` is active): GPU scrolled waterfall, plus `#DPM == 2` dual split (side-by-side when container width `>= 1000px`, stacked if narrower) and optional `#MP`/`#MP$` Mini-Pan (`280×150px` top-right overlay loupe when gated ON in `RadioState`).
- **Canvas DOM Contract**: Assign predictable CSS classes (`k4-pan-surface`, `k4-pan-gl`, `k4-pan-overlay`, `k4-minipan-box`) and update `dataset.frames`, `dataset.renderer` (`'webgl2' | 'canvas2d'`) on the root container for observability and E2E verification.

## 5. Interactive Controls (`web/js/panadapter/interaction.js`)
- **K4 `Mouse L/R Button QSY` Modes (`'lr'` default vs `'pane'` Left Only)**:
  - **`'lr'` (`Left=A, Right=B`, default — matches Elecraft K4 Operating Manual default)**:
    - Left-click (no drag) in either panadapter pane QSYs **VFO A** (`'A'`) and sets the K4 mouse wheel target icon to `A` (`'B'` if `Shift` held).
    - Right-click (with `contextmenu` prevented inside panadapter) in either panadapter pane QSYs **VFO B** (`'B'`) and sets the K4 mouse wheel target icon to `B`.
  - **`'pane'` (`Left Only`)**:
    - Left-click (no drag) QSYs the VFO owning the clicked pane (`'A'` in Pan A, `'B'` in Pan B, or `'B'` if `Shift` held); right-click suppresses the context menu without QSY.
  - Both modes support `Alt` for fine `1 Hz` snap.
  - Note: in Single-Pan (`#DPM0` or `#DPM1`), display controls (Inspector Geometry, HUD Span `−`/`+`, Axis/Center/Fixed-Tune) track the **visible display RX** (`dispRx = snap.dualPanMode === 2 ? targetRx : (snap.dualPanMode === 1 ? 'B' : 'A')`), independent of click-to-tune `targetRx`.
- **K4 Yellow-Bordered Mouse HUD Icon & RIT Wheel Toggle**:
  - Top-left HUD displays the K4 mouse icon (`Mouse: A` cyan, `Mouse: B` amber, `Mouse: RIT A/B` white) with a yellow border; left- or right-clicking the badge toggles `A`/`B` target without QSY, while middle-click (`auxclick`/`pointerdown` button `1`) inside the panadapter or on the badge (or `Shift+click` on the badge) toggles mouse-wheel control between the active VFO and its RIT offset (`-9999..+9999 Hz`).
- **VFO Lock Safety (`LK` / `LK$`)**:
  - When `rxA.locked` or `rxB.locked` is `true`, panadapter click-to-QSY, horizontal drag-pan, and mouse-wheel frequency steps targeting that locked VFO are blocked (matching K4 hardware `[LOCK A]`/`[LOCK B]` behavior), a toast prompts to unlock it, the panadapter VFO flag displays `LOCK`, and the VFO header's red lock button remains visible across breakpoints.
- Horizontal pointer drag (`> 5px` threshold): pan the mouse-button target RX smoothly (accumulate delta Hz, throttle `FA`/`FB` sends at max 20 Hz, sync target RX on release). Also support dragging passband side-edges to adjust `BW`/`IS` when cursor hovers within 6px of a passband edge (`EDGE_HIT_PX = 6`), preserving no-drag left-clicks inside `EDGE_HIT_PX` as VFO tunes.
- Mouse wheel: default scrolls the active K4 mouse-target VFO (`targetRx` or `Shift` -> `'B'`, or RIT offset `±10 Hz` / `±1 Hz` fine when in RIT wheel mode); if `Ctrl`/`Meta` held or hovering over frequency axis/span control (`hit.inAxis`), zooms `#SPN`/`#SPN$` on **`hit.paneRx`** (the pane under cursor, NOT `targetRx`) smoothly across `[6, 12, 24, 36, 48, 72, 96, 144, 192, 288, 368]` kHz steps!
- Touch gestures (`pointerType === 'touch'` / 2 pointers): single tap = click-to-tune (`hit.paneRx` in `#DPM2`, else `targetRx`); 1-finger drag = smooth pan; 2-finger horizontal pinch = adjust `#SPN`/`#SPN$` on the pinched pane (`hit.paneRx`).
