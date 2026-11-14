# Spec 05: "Spectrum Observatory" UI Design System & Responsive Layout

## 1. Visual Design Principles (Anti-Skeuomorphic)
- **Strictly Forbidden**: Circular rotary VFO knobs, brushed aluminum/plastic bezels, 7-segment LED typography, screw heads, dense grids of cryptic 2-letter hardware buttons, external CDN font/icon requests.
- **Design Language**: Dark scientific spectrum instrument inspired by aerospace telemetry and modern audio analyzers:
  - Canvas surface `#090B10` (`--bg-canvas`), HUD glass `rgba(14, 19, 29, 0.84)` with `backdrop-filter: blur(12px)`, crisp hairline borders `rgba(148, 163, 184, 0.14)`, text primary `#F1F5F9`, text muted `#94A3B8`.
  - VFO A accent: Electric Cyan `#38BDF8`. VFO B / Sub accent: Warm Amber `#F59E0B`.
  - RX-Only indicator: Emerald `#10B981` (`RX ONLY` lock badge). Blocked-TX / Error alert: Coral `#F43F5E`.
  - System typography stack: `font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`, and `'SF Mono', ui-monospace, 'Cascadia Mono', 'Roboto Mono', monospace` with `font-variant-numeric: tabular-nums` on all frequencies, dBm, and timer readouts!

## 2. Responsive Layout Architecture

### Desktop (`min-width: 960px`)
CSS Grid `100vh` (`100dvh`), zero page scrollbars (`overflow: hidden`):
1. **Top Telemetry Bar (`56px`, `#top-bar`)**:
   - **Connection Pill** (`data-testid="conn-btn"`): live status dot (`disconnected` / `connecting` / `connected` / `error`), host/endpoint label, `RTT` in ms; click toggles Connection Dialog.
   - **VFO A Telemetry Module** (`data-testid="vfo-a"`): interactive segmented frequency readout (`14.074.000` MHz — hovering/wheeling/clicking individual digit groups steps by `1 MHz / 100 kHz / 10 kHz / 1 kHz / 100 Hz / 10 Hz / 1 Hz`), active band pill (`20m`), mode pill (`DATA-A`), filter BW pill (`2.7 kHz`), lock toggle button.
   - **Linear S-Meter Telemetry** (`data-testid="smeter"`): smooth high-contrast horizontal segmented bar (`S1..S9..+40`) + numeric `-XX dBm` and `S9+X` readout.
   - **VFO B / Sub RX Module** (`data-testid="vfo-b"`): compact interactive readout + Sub RX enable toggle (`SB`) + Split badge (`FT` read-only indicator).
   - **Action Strip**:
     - **`Cmd/Ctrl+K` Quick Jump Button** (`data-testid="omnibar-btn"`): opens Spotlight-style command/frequency omnibar (`14.074`, `7025`, `20m`, `cw`, `lsb`, `span 48k`, `sub on`, `vfo b 14025`).
     - **Audio Unmute / Quick Mix Button** (`data-testid="audio-toggle"`): clear visual speaker state (`Audio Off — Click to Listen` vs live `PCM 12k / Opus` meter), clicking starts `AudioContext` on user gesture and unmutes.
     - **`RX ONLY` Lock Badge** (`data-testid="rx-only-badge"`): shows `RX ONLY` + count if any TX attempt was intercepted, tooltip explaining receive-only mode.
     - **Inspector Drawer Toggle** (`data-testid="drawer-toggle"`): opens/collapses the right inspector (`320px`, open by default on `>= 1200px`, collapsible on narrower laptops).
2. **Main Observatory Workspace (`#workspace`)**:
   - **Panadapter + Waterfall Stage (`#pan-stage`)**: fills `1fr` (~85% of viewport!), hosting `K4.PanadapterView`.
   - **Floating Canvas Overlay Controls**:
     - Top-left pill: active Click-to-Tune Target (`Tune: VFO A` / `Tune: VFO B`), current Step (`100 Hz`), Span quick-zoom (`-` / `48 kHz` / `+`), Dual-Pan toggle (`1x` / `2x`), Mini-Pan toggle (`Loupe`).
     - Bottom-left **Decoded Text Ticker (`#text-ticker`)**: translucent expandable drawer showing live `TB$` CW / RTTY / PSK decoded text lines (including `;` characters preserved cleanly!), with Clear button.
   - **Collapsible Right Inspector (`320px`, `#inspector-drawer`)**:
     Clean segmented sections (tabs or compact cards):
     - **Bands & Mode**: 11 band pills (`160m..6m`), Mode selector (`LSB, USB, CW, CW-R, DATA-A, AFSK-A, FSK-D, PSK-D, AM, FM`), Target RX selector (`A` vs `B`).
     - **RF & DSP Filter**: Width (`BW` slider + presets `250 / 500 / 2.4k / 2.8k`), IF Center/Pitch (`IS`), CW Pitch (`CW`), Preamp (`Off / 10dB / 18dB`), Attenuator (`0..21 dB`), AGC (`Slow / Fast / Off`), Noise Blanker (`NB`), Noise Reduction (`NR`), Manual Notch (`NM`).
     - **Spectrum Display**: Span (`6–368 kHz`), Reference (`#REF`), Scale (`#SCL`), Averaging (`#AVG`), Auto-Ref (`#AR`), Waterfall Black (`#WBS`), Palette (`Obsidian / Thermal / Viridis / Cyan`), Peak Hold toggle.
     - **Audio & Diagnostics**: Mute, Main/Sub Volume sliders, Balance slider, Mix (`MX`: `A.B`, `AB.AB`, `A.AB`, `AB.B`, etc.), Latency Tier (`SL0..SL7`), Encode Mode (`Auto / Opus / PCM`), Packet & Buffer telemetry + Phase 2 TX Extension Hook info (locked RX-only).

### Mobile (`max-width: 959px`, `height: 100dvh`)
1. **Compact Header (`52px`)**: Connection dot + active Target VFO (`A`/`B` tap toggles active VFO display) + large tabular frequency + compact S-meter bar + Audio unmute button + `Cmd+K` search icon.
2. **Full-Bleed Touch Spectrum (`1fr`)**: Panadapter + Waterfall fills ~80% of screen height. Floating compact pill lets user toggle `Tune A` / `Tune B` with thumb and switch Step.
3. **Thumb-Zone Bottom Navigation (`60px + env(safe-area-inset-bottom)`)**: 5 buttons with minimum `44×44px` hit targets:
   - `Tune` (keypad + step + lock)
   - `Band/Mode`
   - `DSP` (BW, Preamp, NB/NR, AGC)
   - `Display` (Span, Ref/Scale, Palette, MiniPan)
   - `Audio` (Volume, Sub, Mix, Connection/Text)
   Tapping any tab opens a smooth **Bottom Sheet** (`max-height: 46vh`) over the lower portion so the upper live spectrum trace stays visible while tweaking controls; tapping the active tab again, dragging down, or pressing `Escape` dismisses it.

## 3. Connection Modal & Global Handle
- **Connection Dialog (`#connection-dialog`)**:
  - WebSocket URL input (pre-filled with `K4.Client.defaultWsUrl()`, e.g., `ws://127.0.0.1:9280` on `file://`)
  - K4 Network Password input (type `password`, optional note: hashed client-side with pure-`BigInt` SHA-384; stored only in session memory if "Remember for session" checked, never echoed cleanly)
  - Audio Codec selector (`Auto (PCM on file://)`, `PCM S16LE (EM1)`, `PCM 24-bit (EM0)`, `Opus (EM3)`)
  - Subprotocol mode (`Auto (websockify + websocat)`, `binary (websockify)`, `none (websocat)`)
  - Helpful inline banner when running on `file://` telling the operator the one-liner command: `websockify 127.0.0.1:9280 <k4-ip>:9205`.
  - Auto-open Connection Dialog if not connected on startup, EXCEPT allow inspecting the URL query params `?ws=...&autoconnect=1` or calling `k4App.connect(...)` for seamless automation and bookmarking!
- Expose `globalThis.k4App` with `.client`, `.state`, `.gate`, `.panadapter`, `.audio`, `.toast(msg, level)`, `.openOmnibar()`, `.openConnectionDialog()`, `.closeOverlays()`.
- Support keyboard shortcuts (`Cmd/Ctrl+K` omnibar, `M` mute audio, `Space`? no—don't bind space to TX since RX-only! Bind `?` shortcuts or `ArrowLeft`/`ArrowRight` frequency step when no input focused, `+`/`-` zoom span, `Escape` close overlays).
