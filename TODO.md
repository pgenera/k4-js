# K4 Web Client — Future Work & TODOs

## 1. TypeScript Migration Plan

### Why Plain JS IIFEs (`globalThis.K4`) Are Currently Used
- **`file://` zero-server compatibility**: Opening `web/index.html` or `web/test.html` directly over `file://` must work without running an HTTP dev server. Native ES modules (`<script type="module">`) are blocked by browser CORS policies on `file://` origins, so every module in `web/js/` is currently written as an IIFE attaching symbols onto `globalThis.K4` and loaded in deterministic dependency order via classic `<script defer>` / `<script>` tags.
- **Zero external build/npm dependencies on host**: Currently the host environment has `node v24.22.2` installed (which supports native TypeScript type stripping for standalone Node scripts/tests), while `npm`, `tsc`, and `esbuild` are not installed.

### Target Toolchain & Build Architecture
- **Type checker**: Install standalone `tsgo` (`@typescript/native-preview`) or `tsc` (`typescript`) in strict mode (`strict: true`, `noUncheckedIndexedAccess: true`) for full compile-time verification with zero runtime overhead.
- **Bundler**: Use `esbuild --bundle --format=iife --global-name=K4` (or preserving the `globalThis.K4` public namespace + classic script output) emitting `web/dist/k4.js` (and keeping `web/dist/k4.js` checked in or built cleanly in <20 ms) so `file://` zero-server execution in `web/index.html` and `web/test.html` continues to work without `<script type="module">`.
- **Test runner compatibility**: Keep Node unit tests runnable either via `node --experimental-strip-types` / native `node v24.22.2` type stripping or against the bundled `K4` namespace in headless Firefox (`web/test.html`).

### Priority Type Definitions to Introduce
1. **`ParsedCatCommand` discriminated union** (`web/js/protocol/cat-codec.js` -> `.ts`): Exhaustive tagged union over command prefixes (`FA`, `FB`, `MD`, `FT`, `SB`, `AB`, `PC`, `TU`, `AN`, `SP`, `PA`, `RA`, `AG`, `RG`, `BW`, `IS`, `DT`, `SM`/`SMH`, `SI*`, `TB`, `#REF`, `#SPN`, `#AVG`, `#DPM`, `#MP`, etc.) plus `.sub` / `.tx` / `.rx` fields so invalid CAT payloads or unhandled tags fail at compile time.
2. **`RadioStateSnapshot` & dirty-key types** (`web/js/state/radio-state.js` -> `.ts`): Strongly typed `RxSlice`, `ConnectionState`, `AudioConfig`, `PanMeta`, `TelemetryMetrics`, and a typed `ChangedKey` union matching `METER_ONLY_KEYS` vs full-render keys.
3. **`K4.Client` & binary wire packets** (`web/js/transport/k4-client.js` -> `.ts`): Typed `0x01` (Audio), `0x02` (Panadapter spectrum/waterfall), and `0x03` (CAT) framing/unframing structs, typed event emitter map (`'cat'`, `'pan'`, `'audio'`, `'connection'`, `'txBlocked'`), and `RxOnlyGate` policy interface (`'rx-only' | 'tx-enabled'`).
4. **AudioWorklet & MediaSession messages** (`web/js/audio/audio-engine.js` -> `.ts`): Typed `MessagePort` payloads between main thread and `K4RxPlayer` / `K4TxCapture` AudioWorklet processors, latency breakdown structs (`getLatencyBreakdown`), and `MediaSession` metadata bindings.

### Phased Conversion Order
1. **Phase 1 — `protocol` (`web/js/protocol/cat-codec.ts`, `cat-macros.ts`)**: Pure functions, zero DOM dependencies; establish `tsconfig.json`, `ParsedCatCommand` union, and `node v24.22.2` type-stripped unit tests first.
2. **Phase 2 — `state` & `transport` (`radio-state.ts`, `rx-only-gate.ts`, `k4-client.ts`, `storage.ts`)**: Define `RadioStateSnapshot`, typed `0x01/0x02/0x03` wire decoders, and typed `Client` event contracts.
3. **Phase 3 — `audio` & `panadapter` (`audio-engine.ts`, `webgl-renderer.ts`, `interaction.ts`, `panadapter-view.ts`)**: Type AudioWorklet ring-buffer / frame payloads, WebGL uniform/buffer helpers, and `MiniPanBoxController` geometry/state.
4. **Phase 4 — `ui` & `app` (`vfo-widget.ts`, `smeter-widget.ts`, `inspector-panels.ts`, `omnibar.ts`, `connection-dialog.ts`, `app.ts`)**: Wire `esbuild --bundle --format=iife` outputting `web/dist/k4.js`, update `web/index.html` and `web/test.html` to consume the single IIFE bundle while keeping `file://` direct open and all E2E tests green, then remove `allowJs` fallback.

## 2. UI/UX Review (headless Chrome vs. sim, and K4 on-radio UI)

Reviewed 2026-11-16 at 1440×900, 1100×700 and 393×852 against `./scripts/dev.sh --serve`. K4 reference: [K4 Built-In Operating Manual rev D6 (HTML)](https://ftp.elecraft.com/K4/Manuals%20Downloads/K4%20Built-In%20Operating%20Manual%20rev%20D6/K4BuiltInOperatingManualrevD6.html), sections "Front Panel Overview", "LCD Screen and Touch Controls", "Primary Functions" and "Panadapter". The manual has crops of the on-radio screen (VFO display, TX icon area, DISPLAY button row), not a full-screen capture. Verify any layout detail on a real K4 before treating it as fixed.

### 2a. Match the K4's visual language (operator familiarity)
The manual's color code: **orange = TX, blue = main RX / VFO A, green = sub RX / VFO B**. The current UI uses amber for VFO B and coral/red for TX, which conflicts with the K4.
- [ ] **Recolor VFO B / Sub to green** (`--accent-vfo-b`, currently #F59E0B). Make **all TX state orange** (TX pill, TX markers, TX meters, ATU/ANT/VOX/QSK icons). Keep coral/red only for errors and blocked-TX. Apply to the VFO B module, sub S-meter, B cursor, mini-pan B, and the "Tune: VFO B" pill. VFO A stays blue.
- [ ] **VFO ID badge**: the K4 shows a solid filled **A** (blue) or **B** (green) square beside the frequency, with the **mode in large white text beneath it** and the filter graphic below that. Replace the outlined "A" box and the mode/band/BW chips with that stack. Keep the band chip as a secondary label.
- [ ] **Underline the active tuning-step digit** in each VFO readout (the K4 underlines one digit to show the step size, and tapping a digit picks that step). Replace or supplement the "Step: 10 Hz" HUD text. Tapping the MHz digits opens memory store/recall, which is where Frequency Bookmarks belong.
- [ ] **Segmented S-meter per receiver**: K4 S-meter is a row of thin segments, blue for main and green for sub, with a **yellow tick scale `S1 3 5 7 9 +20 +40 +60`**. Give each VFO its own meter instead of one shared center meter. Tapping a meter opens that receiver's mini-pan, as on the K4.
- [ ] **TX bar graphs replace the S-meter** on the transmitting VFO: orange segments for power, SWR, ALC and compression (SSB/ESSB only). They sit under VFO A normally and under VFO B in split, which is the K4's built-in reminder of split state. Do this instead of the current "TX MTR" tag on the shared meter.
- [ ] **Filter graphic + preset**: trapezoid showing passband width and shift next to each S-meter, with `FL1/FL2/FL3` beneath it. Tapping it cycles FL1-3, like the radio. Two "wings" show when the passband is normalized (NORM).
- [ ] **Density constraint for the top-area rebuild**: the whole VFO / meter / icon area must fit in **one ≤56px bar on desktop (≤52px on mobile)**, i.e. denser than today's ~82px two-row bar. Fold A/B, A►B, SPLIT, SUB and the ANT/ATU pills into the center icon area, put mode and filter graphic beside the digits on wide screens, and use one-line 9-10px receive icons. On mobile keep only frequency, A/B badge, compact S-meter and Audio in the bar; move icons and the RIT/XIT box into the Tune sheet. Enforce with an e2e check that fails if `#top-bar` is taller than 56px at 1440×900 or 1100×700 (52px at 393×852).
- [ ] **Center TX icon area** (orange): `TX ◄` or `► TX` arrow pointing at the transmit VFO, `SPLIT ON/OFF`, `MSG: I/II` (flashing `MSG RPT`), and below the RIT/XIT box `VOX`, `ANT n:name`, `ATU`, `QSK`. Today these are scattered pills (ANT/ATU in the top bar, TEST/MIC/PTT as a group). Keep the web-only TEST/MIC/PTT controls but group them separately from the K4-style indicators.
- [ ] **Shared RIT/XIT offset box** between the two S-meters: `RIT` / `XIT` labels with the offset (e.g. `+0.03`); tapping toggles RIT, and a modifier-click toggles XIT. Today RIT shows as a badge on VFO A only.
- [ ] **Receive icons under each S-meter**: `PRE`, `ATTN`, `NB`, `NR`, `APF`, `NTCH`, `AGC`, and RX antenna (`ANT1`/`RXANT1`), plus `DR+` and `K4D` where applicable. These replace most of the RF/DSP state the operator has to open the inspector to read.
- [ ] **Panadapter window details**: frequency markers along the **top** edge and dBm along the left (axis is currently at the bottom; check against the K4's layout before moving it), a gray **A/B letter tab in the lower-right corner** of each pane, blue/green **off-screen cursor triangles** when VFO A/B leave the view, and an `NB` icon when the pan blanker is on. Keep the S-unit scale option (K4 menu: Spectrum Amplitude Units).
- [ ] **Mouse/target icon**: K4 uses A (blue), B (green) or **R** (white, for RIT/XIT) as the wheel-tuning target, and the same icon toggles it. Align the existing "Mouse: A" pill with those colors and add the R target; make the mouse wheel on the panadapter honor it.
- [ ] **Status area** at the lower left (K4: two lines, UTC date/time by default, tap to switch to callsign, or supply V/I/power/SWR, or main/sub levels in dB). Add a small status block, and move the VS/IS/PA TEMP/SWR tiles into it as selectable displays.

### 2b. Use the K4's control vocabulary
- [ ] **Primary function row.** K4: `MENU`, `Fn`, `DISPLAY`, `BAND`, `MAIN RX`, `SUB RX`, `TX`. Rename and re-map inspector tabs and the mobile bottom nav to match: Band/Mode → `BAND` (+ mode on the VFO), DSP → `MAIN RX` / `SUB RX` (with B SET semantics: tapping `SUB RX` retargets controls to VFO B), Display → `DISPLAY`, TX / ATU → `TX`, Audio → fold into `MAIN RX`/`SUB RX` (AF gain, balance, AFX) and `MENU`.
- [ ] **DISPLAY controls use the K4 names**: `PAN` (A / B / A+B), `WTRFALL` (waterfall height %), `WTR CLRS`, `REF LVL` (with AUTO), `SPAN`, `NB`, averaging, and cursor modes `TRACK`, `FIXED1`, `FIXED2`, `SLIDE1`, `SLIDE2`, `STATIC`. The UI currently has "Center on VFO" and "Fixed Tune" which cover only part of this. Add the **LCD / & / EXT** and **A / & / B** target selectors (EXT can be hidden since the web client has one display; A/&/B should apply when dual-pan is on).
- [ ] **Operating mode order and labels**: check the mode list against the radio (`LSB USB CW AM FM DATA CW-R DATA-R` per the Programmer's Reference `MD` command) instead of the current LSB/USB/CW/CW-R/DATA-A/AFSK-A/FSK-D/PSK-D/AM/FM grid, which exposes data sub-modes before the operator needs them.
- [ ] **Tap vs hold**: the K4 uses tap for the common action and hold for the alternate, with white vs yellow labels. Keep this for A/B (tap swap, hold swap-all), A►B, ATU (tap in/out, hold tune), and similar. Show the hold action with the K4's yellow label so it is learnable, instead of putting it only in tooltips.
- [ ] **Multi-function knob equivalents**: the K4 `XMTR`, `FILTER`, `RF/SQL` knobs choose a parameter via soft buttons (e.g. FILTER: BW / SHFT / HICT / LOCT / NORM). Add a compact knob-style control bound to the wheel so an operator can scroll BW/RF gain/squelch without opening a tab.
- [ ] **Terminology**: use `VFO LNK` (not "Link VFOs"), `SPLIT`, `SUB`, `B SET`, `RIT/XIT`, `CLR`, `NORM`, `AUTO`. Keep sentence case for descriptions, but use the K4's uppercase labels where they are the radio's own button names.

### 2c. Defects and layout problems found in the screenshots
- [ ] **Waterfall is a ~5px strip.** Below the trace and frequency axis the waterfall area is blank at all three sizes (still blank after 20s virtual time). Confirm whether this is a headless/SwiftShader artifact or a real sizing/history bug in `panadapter-view.js` / `webgl-renderer.js`. Check this first on a real GPU browser.
- [ ] **Top bar wraps to two rows (~82px) at every width tested**; spec 05 calls for one 56px row. With the HUD row, three bands use ~125px at 1440×900. Moving the VFO cluster (A/B, A►B, SPLIT, SUB) into the center icon area (see 2a) should fix this.
- [ ] **Mobile header is three rows plus the HUD (~150px before the spectrum)**; spec says one 52px row. Keep connection dot, active VFO frequency, compact S-meter and Audio; move the rest into the sheets.
- [ ] **Mobile HUD pill clips** ("Mini-Pan A  Fre…"). Overflow lesser items into a `…` menu or let it scroll with a fade.
- [ ] **Connection pill truncates** ("K4-SIM …") and drops RTT at ≤1100px, so the connecting/error state is easy to miss.
- [ ] **TX marker collides with the VFO flag** on the panadapter. Anchor to the passband edge, and show only when split is on.
- [ ] **Drawer is hidden at ≤1100px** with no replacement, so DSP/Display/Audio are unreachable on laptops. Use an overlay drawer below 1200px.
- [ ] **Band-plan label overlaps axis labels** ("20m FT8" over "14075"). Give band-plan labels their own lane.
- [ ] **Telemetry tiles (VS/IS/PA TEMP/SWR)** show on every tab though they matter mainly in TX; see Status area above.
- [ ] **Decode ticker is always visible** with a disabled "Decode: N/A" in data modes. Hide it or collapse to an icon when the mode has no decoder. `Auto Spot` / `Spot` are shown disabled without explanation; add a tooltip or hide them (the K4 enables AUTO-spot in CW/PSK only).

### 2d. Hierarchy, legibility and polish
- [ ] Make the frequency readout the one dominant element; quiet borders/glass on secondary groups and reserve color for state (blue/green/orange).
- [ ] S-meter tick labels are ~8px in `--text-dim` (#64748B on #090B10, about 3.9:1). Raise to ≥10px and AA contrast.
- [ ] Inspector section titles and telemetry tiles are all uppercase and tracked; use K4 button names for controls, and sentence case for descriptions.
- [ ] Band/Mode inspector tab is ~1.5 screens tall; collapse Mode and Step into compact controls (mode on the VFO, step on the digits) and move Bookmarks behind the MHz digits / omnibar.
- [ ] Self-host one small variable font with tabular figures for the VFO digits (no CDN, per spec 05) so the readout looks the same on every OS.
- [ ] Empty state: show a "Connect to a K4" card with the endpoint field and the websockify one-liner when disconnected.
- [ ] Landscape phone/tablet (e.g. 844×390) is untested.
- [ ] Audit `:focus-visible` rings and `prefers-reduced-motion` in `components.css` (3,505 lines); consider splitting it by area (topbar, hud, inspector, tx, modals, mobile).
- [ ] Extend `tests/e2e_verify.py` with screenshots at 1440×900, 1100×700 and 393×852 and fail on top-bar height above spec or any `scrollWidth > clientWidth` overflow in the header/HUD.

### Suggested order
1. Confirm the waterfall on a GPU browser (blocks judging everything else).
2. Color code (2a, first item): small change, big familiarity gain.
3. Rebuild the top area as the K4's VFO / meter / icon layout (2a), which also fixes the two-row top bar and mobile header.
4. Rename primary functions and DISPLAY controls (2b), then the hierarchy pass (2d).
