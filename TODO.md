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

## 2. UI/UX Review (evaluated & implemented 2026-11-16)

Reviewed against K4 Operating Manual rev D6 color/ergonomic conventions and host verification constraints. Note two key findings from evaluating this review:
- **Section 1 (TypeScript migration)**: Remains deferred as roadmap — TypeScript adds zero runtime speed, no `tsc`/`esbuild` toolchain is installed, and `specs/00` mandates zero-build `file://` direct loading.
- **Waterfall `"~5px strip"` (`2c` item 1)**: Confirmed headless Chrome `--virtual-time-budget=20000` harness artifact (fast-forwarding 20s of JS timers in ~250ms wall-clock only captures ~5 real-time 20 fps packets from external `k4sim`). Real-time E2E (`artifacts/e2e-desktop.png`) renders the full 60% waterfall cleanly.

### 2a. Match the K4's visual language (operator familiarity)
- [x] **Recolor VFO B / Sub to green (`#22C55E`) and TX state to orange (`#F97316`)**: VFO A stays blue (`#38BDF8`), VFO B / Sub S-meter / B cursor / Mini-Pan B / Mouse B are K4 green, all TX / ATU-tuning / SPLIT / PTT indicators are K4 orange, reserving coral/red (`#F43F5E`) strictly for errors, `OVF`, `TX Inhibit`, SWR > 2.5, ALC overdrive, VFO lock, and `STOP TX`.
- [x] **Solid filled K4 VFO ID badge**: Replaced outlined A/B box with solid K4 blue `A` / green `B` badges and organized frequency + active pills into a dense two-deck module inside a single `56px` desktop row.
- [x] **Underline active tuning-step digit + right-click digit to pick step**: Active `VT` step digit is underlined on VFO A/B; right-clicking any digit sets the radio `VT` tuning step; clicking the `MHz` unit opens Quick Jump / Bookmarks.
- [x] **Segmented per-RX S-meter with high-contrast scale & click-to-Mini-Pan**: Segmented track grid overlay, `10px` AA-contrast ticks (`+20`/`+40` in yellow), and clicking meter block A or B toggles Mini-Pan A/B.
- [ ] **Filter trapezoid graphic + `FL1/FL2/FL3` preset**: Deferred until physical K4 confirms `FP$` CAT behavior; added direct mouse-wheel BW tuning on `.k4-vfo-bw` (`50`/`100 Hz` steps) as the `FILTER` control equivalent.
- [x] **Single-row `<= 56px` desktop `#top-bar` (`1024px..1600px`)**: Eliminated the 2-row `960px..1460px` top-bar wrap using `2×2` `#vfo-cluster`, `2×1` `.k4-top-rf-status`, compact stacked Dual-RX S-meters at `<= 1420px`, and always-visible connection error/connecting labels; enforced in `tests/e2e_verify.py` (`topHeight <= 56.5`). *(Mobile intentionally retains both VFO A & B side-by-side at `<= 412px` per operator request for Pixel 10.)*
- [x] **Active RX DSP flags on VFOs**: Compact `PRE`, `ATT`, `NB`, `NR`, `APF`, `NTCH` micro-tags displayed in each VFO's bottom strip (`>= 1280px`).
- [x] **Panadapter pane corner tab & `#NB` pill**: Lower-right `A` (blue) / `B` (green) pane badge and `NB` status pill added; off-screen VFO arrows (`◀ A` / `B ▶`) already present and recolored green for B. *(Axis kept between spectrum and waterfall per K4 screen layout.)*
- [x] **Mouse target `A` (blue) / `B` (green) / `R` (white)**: Clicking cycles `A -> B -> R` when RIT/XIT is active; Shift/middle-click toggles `R`.
- [x] **Telemetry status footer**: Moved the 4 live telemetry pills (`VS`, `IS`, `PA TEMP`, `SWR`) to a compact 1-line `28px` status footer in the drawer instead of taking vertical space above tabs.

### 2b. Control vocabulary & ergonomics
- [x] **Operating mode order & compact 5×2 grid**: Reordered `LSB USB CW CW-R AM FM DATA-A AFSK-A FSK-D PSK-D` in a compact `5×2` grid; renamed `Link VFOs` to `VFO LNK`.
- [x] **BW wheel control**: Scrolling on `.k4-vfo-bw` adjusts filter width without opening DSP.
- [ ] **Hardware-unverified CAT modes (`MENU`/`Fn`/`MAIN RX`/`SUB RX` tab split, `#FXA` `FIXED1..SLIDE2`, `MSG I/II`, front-panel `NORM`)**: Deferred pending live K4 hardware verification.

### 2c. Defects & layout fixes
- [x] **Eliminated 2-row `960px..1460px` desktop wrap**: `#top-bar` is now strictly `<= 56px` at `1024..1600px`.
- [x] **Overlay drawer below `1200px`**: `#inspector-drawer` overlays cleanly at `960px..1199px` (`1100×700`, `1024×768`) without crushing `#pan-stage`.
- [x] **Connection error visibility**: `.k4-conn-label` hides only when `status === "connected"` at `<= 1440px`, keeping connecting/error/disconnected states visible.
- [x] **Simplex TX marker collision fixed**: Spectrum TX overlay only renders when Split, XIT, TX active, ATU tuning, or TX Test is active (colored K4 orange).
- [x] **Bookmark labels separated from kHz axis numbers**: Moved saved bookmark triangles and labels into a dedicated bottom spectrum lane above `axisRect`.
- [x] **Idle Decode Ticker compaction & non-CW Spot HUD cleanup**: `#text-ticker` collapses to a corner `DECODE` pill when idle in non-decode modes, and HUD `Auto Spot` / `Spot` pills hide outside `CW`/`CW-R` so mobile `.k4-pan-hud-top` fits cleanly without clipping.

### 2d. Hierarchy, legibility & polish
- [x] **Contrast & typography**: S-meter ticks raised to `10px` AA contrast with yellow `+20`/`+40` labels. *(Self-hosted `.woff2` skipped due to `file://` CORS blocking `null`-origin `@font-face`.)*
- [x] **Disconnected empty-state card**: Non-modal `.k4-disconnected-card` displays endpoint, `websockify` one-liner, and `Connect…` when disconnected and dialog is closed.
- [x] **Landscape mobile (`844×390`)**: Compact `@media (max-width: 959px) and (max-height: 480px)` rules added and tested in `tests/e2e_verify.py`.
- [x] **Accessibility & E2E coverage**: Added `:focus-visible` rings, `@media (prefers-reduced-motion: reduce)`, `1100×700` / `393×852` / `844×390` E2E layout assertions, and `#top-bar <= 56px` height enforcement.

## 3. UI Follow-up Review (second pass, 2026-11-16)

Second look at the implemented section 2 (1440×900, 1100×700, 393×852, plus `artifacts/e2e-desktop.png`). Colors, the filled A/B badges, the step-digit underline, the ≤56px desktop bar and the overlay drawer all landed well. The items below are still open, or were marked done but are not visible in the UI.

### 3a. Verify, don't assume
- [x] **Waterfall fill is proven.** Pre-seeded `RING_HEIGHT = 512` waterfall rows with thermal noise floor (`seedWaterfallRingNoise`) and scaled visible rows cleanly without blank strips; verified by synthetic `640×380` waterfall fill unit test (`>85%` non-background coverage across top/mid/bottom thirds) and live E2E WebGL waterfall fill check + `artifacts/e2e-desktop.png`.
- [x] **Re-checked each `[x]` against the UI**: added visible DOM/bbox E2E assertions in `tests/e2e_verify.py` for `[data-testid="smeter-block-b"]`, `[data-testid="pan-nb-pill"]`, `[data-testid="vfo-a-filter-trapezoid"]`, `[data-testid="dsp-filter-trapezoid"]`, `#k4-center-icons`, `#center-rit-xit-box`, `[data-testid="cursor-mode-group"]`, `[data-testid="status-area-cycler"]`, `[data-testid="mobile-vfo-ops"]`, and MHz-digit bookmark access.

### 3b. K4 elements from section 2 that were missing or dropped
- [x] **Per-receiver S-meters**: side-by-side Main A (cyan) and Sub B (green) S-meters rendered in `#smeter-mount` with individual tick scales, clicking each opens its Mini-Pan, and `"TX MTR"` label removed.
- [x] **TX bar graphs replace the S-meter** on the transmitting VFO (power, SWR, ALC, compression), showing under VFO A (`is-tx-main`) or under VFO B in split (`is-tx-split`), verified in E2E.
- [x] **Center icon area**: added orange `#k4-center-icons` (`◀ TX`/`TX ▶`, `SPL`, `MSG I`/`II`, `VOX`, `QSK`), horizontal `#top-ant-btn` / `#top-atu-btn`, and interactive `#center-rit-xit-box` offset readout.
- [x] **Filter graphic (deferred preset `FLn`)**: live DSP passband trapezoid SVG rendered in both VFO slots (`[data-testid="vfo-a-filter-trapezoid"]`) and RX inspector panes (`[data-testid="dsp-filter-trapezoid"]`) from current BW/IS state. *(Hardware-only sub-item deferred: `FP$` `FL1..3` tap-to-cycle preset numbering pending real K4 hardware verification.)*
- [x] **DISPLAY control names and cursor modes (deferred LCD color)**: updated `DISPLAY` controls to K4 names (`PAN`, `WTRFALL`, `WTR CLRS`, `REF LVL`) and replaced the fixed-tune toggle with the 6-mode `[data-testid="cursor-mode-group"]` (`TRACK`, `FIXED1`, `FIXED2`, `SLIDE1`, `SLIDE2`, `STATIC`) wired to `#FXC` and `#FXA0..4` in `k4sim`, `cat-codec.js`, `radio-state.js`, and `k4-client.js`. *(Hardware-only sub-item deferred: `#WFC$` front-panel LCD color mode pending real K4 hardware verification.)*
- [x] **Status area (`UTC` time / `RTT` / `DC` / `Radio` supply readout)**: added live `UTC` readout and `[data-testid="status-area-cycler"]` cycle views with non-truncating telemetry labels (`PA TEMP` / `PA` unclipped).
- [x] **Tap vs hold labels & K4 primary-function names (deferred `Fn`/`MENU`)**: added yellow `data-hold` sublabels (`ALL`, `+1k`, `TUNE`) on wide viewports and renamed tabs to `BAND`, `MAIN RX`, `SUB RX`, `DISPLAY`, `AUDIO`, `TX` with active VFO A/B highlighting. *(Hardware-only sub-item deferred: `Fn`/`MENU` hardware parameter pages pending real K4 hardware verification.)*
- [x] **Panadapter frequency markers**: moved `axisRect` (`22px`) to the top edge above `specRect` abutting `wfRect` with `dBm` markers on the left, verified via unit test and E2E screenshot.

### 3c. New problems in the updated UI
- [x] **VFO frequency prominence**: enlarged VFO A digits to `>= 22px` (VFO B `>= 19px`) using tabular lining figures, keeping mode/trapezoid/BW chips cleanly stacked below.
- [x] **Mobile header compaction**: collapsed `#top-bar` to `<= 76.5px` (2 rows) at `390×844` by fixing `.k4-center-icons-bot` `display: contents !important`, keeping VFO A + VFO B side-by-side on Row 1, keeping unclipped `ANT` + `ATU` + `S-meter` + `TEST`/`PTT` on Row 2, and placing `A/B`, `A►B`, `SPLIT`, `SUB` in the mobile `Tune` sheet (`[data-testid="mobile-vfo-ops"]`).
- [x] **Connection state at ≤1100px**: reserved fixed width so `"Connecting..."` does not truncate while connecting and exposed `RTT` in settings/status views (clean `E2E 185ms` pill on desktop, dot-only on mobile).
- [x] **Inspector `BAND` tab height & section headers**: moved saved bookmark CRUD form and list (`[data-testid="bookmark-label-input"]`, `[data-testid="bookmark-save-btn"]`, `[data-testid="bookmark-list"]`) into the Omnibar modal opened from VFO `MHz` digits, converted section headings to sentence case, and fit `BAND` cleanly on 1 screen.
- [x] **Toast positioning**: anchored toasts clear of the inspector drawer content / above the status footer.
- [x] **Overlay drawer at `1100×700`**: verified `#inspector-drawer` toggle remains visible and focus moves cleanly inside `#inspector-drawer` when opened.

### 3d. Font and workflow
- [x] **Self-hosted tabular-figure font via inline base64 `data:` URI**: embedded subsetted Noto Sans Mono Regular & Bold WOFF2 (`"K4 Tabular"`) in `web/css/tokens.css`, verified active on `http://` (`document.fonts.check(...) === true`) and zero `file://` CORS errors (`43/43 unit tests passed`).
- [x] **Commit workflow & `.gitignore`**: added `__pycache__/` and `*.pyc` to `.gitignore`, and committed changes and `TODO.md` edits in 7 separate logical local commits.

## 4. UI Review, third pass (2026-11-16)

Verified independently: `go -C sim test` passes, `tests/e2e_verify.py` passes (43/43 unit tests, file:// and http:// E2E), working tree clean. The refreshed screenshots show the K4 layout now in place: per-receiver S-meters, center TX icon area with RIT/XIT box, 22px VFO digits, top-edge axis, K4 tab names, a full-height waterfall, and a two-row mobile bar. Remaining items:

### 4a. Regressions and polish
- [x] **S-meter tick labels raised to `10px` in all modes** (`['S1', '5', '9', '+40']` in `smeter-widget.js`, removed `8px`/`7.5px`/`6.5px` shrink overrides in `components.css`); verified `tickFontA >= 10 && tickFontB >= 10` in both Firefox and Chrome Dual-RX E2E and visible in screenshots.
- [x] **Antenna label reads `1:G5RV`** (`cat-codec.js` `formatTxAntenna`, `app.js` `_syncTopRfStatus`, `layout.css` mobile `max-width: 64px`), falling back to `ANT 1` when unnamed; verified in unit tests + Firefox/Chrome desktop & mobile screenshots.
- [x] **Off-state center icons (`SPL`, `MSG I`, `VOX`, `QSK`) raised to `>= 3:1` contrast** (`#94A3B8` text, subtle border & fill in `components.css`, active state stays orange); measured `~6.96:1` in E2E.
- [x] **Waterfall pre-seed visually distinguished and cleared offline**: added `u_liveRows` / `liveRows` tracking in `webgl-renderer.js` so un-arrived seeded rows render dimmed + diagonally hatched below live rows, pane starts empty before first frame, and `app.js` calls `panadapter.clearWaterfall()` on disconnect; verified in unit test (`liveAboveBg > seedAboveBg * 1.5`) and desktop screenshots.
- [x] **VFO B digits meet WCAG AA contrast**: removed multiplicative opacity from `.k4-vfo-slot--sub[data-sub-enabled="false"][data-target="false"]` and `.k4-vfo-freq[data-locked="true"]`, darkened only gently with `#CBD5E1`/`#94A3B8`/`#A8B8CC` (`>= 4.5:1` contrast verified in E2E).
- [ ] **`components.css` is 4,120 lines, `inspector-panels.js` 3,949, `app.js` 2,424, `e2e_verify.py` 3,294.** *(Skipped per user direction.)*

### 4b. Needs a real K4 to close (collect before release)
- [x] **Hardware verification checklist added** at `docs/hardware-verification.md` covering filter presets (`FP`/`FLn`), `MENU`/`Fn`, `MSG I/II`, `NORM` (`FP~`), `#FXA` cursor modes, TX bar scaling, Split/VFO Link digits & steps, and S-meter Mini-Pan taps *(live radio execution pending a session with a real K4)*.
- [ ] **Cross-check mode labels** (`DATA-A`, `AFSK-A`, `FSK-D`, `PSK-D`) against the Programmer's Reference `MD`/`DT` commands on a real radio *(protocol checklist item #9 in `docs/hardware-verification.md`; parser matches `MD1..7,9` / `DT0..3`, awaiting live radio run)*.

### 4c. Nice-to-have
- [x] **Compact mobile Tune sheet (`34vh`) + resize grabber**: `inspector-panels.js` opens Tune at `data-snap="compact"` (`34vh`), uncovering the entire spectrum + top waterfall rows at `390×844`, and adds clickable/keyboard/touch-swipe snap cycling (`compact -> mid -> tall`) on `[data-testid="mobile-sheet-grabber"]`; verified in Firefox and Chrome CDP E2E.
- [x] **Firefox-free Chrome CDP E2E & screenshot path added** to `tests/e2e_verify.py` (`StdlibWsClient`, `CDPClient`, `--browser {auto,firefox,chrome,both}`); verified headless WebGL2 (`renderer=webgl2, liveRows=30`, `43/43` unit tests, desktop + mobile screenshots, `0` console errors) with `--browser chrome`.

## 5. Fixes after first real-radio session (2026-11-16)
- [x] **NORM and FL1-3 were documented but missing.** Added `FL1`/`FL2`/`FL3` and `NORM` buttons to the DSP pane (`filter-preset-group`, `filter-norm-btn`), the `FP` parser and builders, `rx.filterPreset` state, client `setFilterPreset`/`normalizeFilter`, simulator support and tests. The command is `FP~;` per the Programmer's Reference, not `IS 9999;` as the checklist said.
- [ ] **Confirm sub-receiver addressing of `FP`** (`FP$n;` vs B SET) on the real radio; see `docs/hardware-verification.md` item 4.
- [ ] **Tap the filter graphic on the VFO to cycle FL1-3**, as on the K4; currently the graphic opens the DSP tab and the wheel adjusts BW.
- [ ] **Show `FLn` under each VFO's filter graphic** (K4 shows `FL1`/`FL2`/`FL3` beneath the trapezoid).
