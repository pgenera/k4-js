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
