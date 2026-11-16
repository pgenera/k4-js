# Elecraft K4 Real-Hardware Verification Checklist

Items below are implemented against the **Elecraft K4 Programmer's Reference**, **K4 Operating Manual**, or the local `k4sim` simulator (`sim/radio.go`) and need one session with a real Elecraft K4 to confirm on-air behavior and close Section 4b of `TODO.md`.

## Prerequisites
- Start the proxy pointing at a live K4 on TCP port `9200` (e.g., `websockify --web=web <listen_port> <k4_ip>:9200` or the K4 Web UI server).
- Open DevTools Console / Network WebSocket inspector or tail the CAT log while running through each check below.

---

## 1. Filter Presets (`FP` / `FP$` / `FL1..FL3` vs `BW` / `IS`)
- **CAT / Commands to verify**:
  - Poll `FP;` / `FP$;` and send `FP1;`, `FP2;`, `FP3;` (or tap `FIL` / preset control on the front panel while watching incoming CAT frames).
  - Cross-check whether the K4 echoes `FPn;` (`FL1`/`FL2`/`FL3`) alongside `BWnnnn;` and `ISnnnn;` on mode changes (`LSB`, `USB`, `CW`, `DATA`).
- **Expected UI result**:
  - Main A and Sub B filter trapezoids (`[data-testid="vfo-a-filter-trapezoid"]`, `[data-testid="dsp-filter-trapezoid"]`) match front-panel passband shape and shift; tapping a filter preset pill cycles `FL1 -> FL2 -> FL3 -> FL1` and syncs with the radio LCD.

## 2. `MENU` and `Fn` Parameter Pages
- **CAT / Commands to verify**:
  - Observe which `MENU` and programmable `Fn` actions map to standard K4 CAT commands vs front-panel-only menu entries (e.g. `MN`, `MP`, `ME` or `SW` switch emulation codes if supported by current K4 firmware).
- **Expected UI result**:
  - Document any high-value parameters (`VOX Gain`, `Monitor Level`, `CW Sidetone`, `LCD Color Mode` `#WFC$`, etc.) worth surfacing under `MAIN RX`, `SUB RX`, `DISPLAY`, or `TX`, and confirm whether `#WFC$` toggles day/night or classic/modern palette over TCP CAT.

## 3. `MSG I/II` Bank Indicator & DVR / Message Playback
- **CAT / Commands to verify**:
  - Observe front-panel `MSG` (`MSG I` vs `MSG II` bank indicator) and DVR/CW memory triggers (`DVR`, `KY`, or switch emulation commands).
  - Verify what unsolicited CAT frame (if any) the K4 emits when a stored CW/RTTY/PSK/voice message starts and stops playing (`#center-msg-ind` active orange highlight vs idle).
- **Expected UI result**:
  - Tapping `#center-msg-ind` / `MSG` bank matches physical K4 bank selection (`I` / `II`) and highlights orange only while actively transmitting/playing back a message.

## 4. Front-Panel `NORM` Passband Reset
- **CAT / Commands to verify**:
  - Offset IF shift (`IS 1200;` in `CW`) and narrow `BW`, then press `NORM` on the radio front panel and send `IS 9999;` from the Web UI (`MAIN RX` / `SUB RX` `NORM` button).
- **Expected UI result**:
  - Compare whether real K4 `IS 9999;` resets both shift (`IS`) and width (`BW`) to the mode's default preset, or only centers `IS`, and align `web/js/protocol/cat-codec.js` / `sim/radio.go` if they differ.

## 5. `#FXA0..4` & `#FXC0..1` Fixed-Tune Cursor Modes
- **CAT / Commands to verify**:
  - Send `#FXC0;` (`TRACK`), `#FXC1;` (Fixed Tune), and `#FXA0;` (`FIXED1`), `#FXA1;` (`FIXED2`), `#FXA2;` (`SLIDE1`), `#FXA3;` (`STATIC`), `#FXA4;` (`SLIDE2`) while tuning VFO A across the panadapter edges.
  - Check both query responses (`#FXC;`, `#FXA;`) and front-panel cursor behavior when spinning Main VFO past ~80% or 100% of the visible span.
- **Expected UI result**:
  - `[data-testid="cursor-mode-group"]` reflects live K4 `#FXC` / `#FXA` state on connect/hydration and produces matching pan-center recentering behavior (`FIXED1` half-screen jump vs `FIXED2` recenter vs `SLIDE1`/`SLIDE2` smooth slide vs `STATIC`).

## 6. TX Bar Graph Scaling (`TM` / `PO` / `SW` / `AL` / `CP`)
- **CAT / Commands to verify**:
  - Transmit into a dummy load in `CW` (`TEST` OFF, QRP `5W` and QRO `50W`/`100W`), `USB`/`LSB` (`CMP` on), and `DATA-A`.
  - Compare `TM` / meter stream telemetry (`PO`, `SWR`, `ALC`, `CMP`) reported by the real K4 against `smeter-widget.js` TX bar scaling.
- **Expected UI result**:
  - Power bar (`W`), SWR bar (`1.0–3.0+`), ALC bar, and Compression (`dB`) bars move smoothly under VFO A (`is-tx-main`) or VFO B (`is-tx-split`) and match the K4 front-panel bar graph segments within ±1 segment.

## 7. VFO Digit & Step Behavior in Split (`FT1;`) and VFO Link (`LN1;`)
- **CAT / Commands to verify**:
  - Enable Split (`FT1;`) with `SUB` both off (`SB0;`) and on (`SB1;`), and enable VFO Link (`LN1;`) across different bands (`FA`/`FB` spacing).
  - Verify step changes (`SP` / K4 step index) and digit-click tuning behavior in `vfo-widget.js` against `k4sim` and real radio `FA`/`FB`/`FR`/`FT` replies.
- **Expected UI result**:
  - `TX ►` indicator, orange TX border on VFO B when split, and VFO A/B frequency steps remain synchronized without fighting unsolicited `FA`/`FB` updates from the radio.

## 8. Mini-Pan Toggle on Main A & Sub B S-Meter Tap
- **CAT / Commands to verify**:
  - Tap Main A S-meter and Sub B S-meter (`#MP` / `#MPA` / `#MPB` if emitted, or local Mini-Pan overlay toggle) and check whether real K4 CAT exposes a dedicated Mini-Pan command or purely local UI display state.
- **Expected UI result**:
  - Clicking Main A or Sub B S-meter opens its respective Mini-Pan view with correct zoom and passband width without toggling the opposite receiver.

## 9. Cross-Check Mode & Data Submode Labels (`MD` & `DT`)
- **CAT / Commands to verify**:
  - Cycle every K4 mode on the front panel and log `MDn;` / `MD$n;` and `DTn;` / `DT$n;` responses:
    - Expected `MD` codes in `web/js/protocol/cat-codec.js`: `1=LSB`, `2=USB`, `3=CW`, `4=FM`, `5=AM`, `6=DATA`, `7=CW-R`, `9=DATA-R`.
    - Expected `DT` submodes in `DATA` / `DATA-R`: `0=DATA-A`, `1=AFSK-A`, `2=FSK-D`, `3=PSK-D`.
  - Verify if `8=USER` / `RTTY` or alternate `DT` values exist in newer K4 firmware and whether `DATA-R` submode labels append `-R` or keep `DATA-A`/`AFSK-A`/`FSK-D`/`PSK-D` on the LCD.
- **Expected UI result**:
  - Every `MD`/`DT` code returned by hardware parses cleanly in `K4.CatCodec.parseCommand` and displays the exact label shown on the K4 front panel across VFO badges and the `BAND` inspector tab.
