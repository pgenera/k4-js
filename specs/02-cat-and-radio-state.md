# Spec 02: CAT Codec & Reactive `RadioState` Store

## 1. Known K4 Protocol Quirks (Mandatory Handling)
1. **`TB` / `TB$` Embedded Semicolons**:
   - Format: `TBtrrs;` or `TB$trrs;` where `t` = 1 digit (TX queued char count `'0'..'9'`), `rr` = 2 ASCII digits (`'00'..'99'`) specifying exact byte/char count of `s`, followed by `s` (which MAY contain literal `;` characters!), followed by terminating `;`.
   - `CatCodec.splitFrames(ascii)` MUST walk sequentially rather than calling `.split(';')`: whenever at command start it matches `/^TB(\$?)([0-9])([0-9]{2})/`, read `len = parseInt(rr, 10)`, slice `5 + len` (or `4 + len`) chars verbatim, consume optional trailing `;`, and emit the full `TB...` token intact.
2. **Longest-Prefix Matching & `$` Sub-RX Routing**:
   - Sub-RX commands insert `$` before arguments (`MD$3;`, `BW$0050;`, `#SPN$24000;`, `SMH$-091;`).
   - Matching MUST check longest prefixes first (`SMH$` -> `SMH` -> `SM$` -> `SM` -> `SB`, `#SPN$` -> `#SPN`, `MD$` -> `MD`, `BW$` -> `BW`, `IS$` -> `IS`, etc.) so `RO$` or `SMH$` never misparses as a shorter command.
3. **`AI4` / `AI5` & `SL` Echo Quirk**:
   - Under `AI4`, K4 does not echo SET commands back to the originating socket; also, `SL<n>;` is NEVER echoed. `K4.Client` sends `AI5;` at init AND applies immediate optimistic updates (for `SL`, tuning/filter/display controls that benefit from zero-lag feedback), while targeted SETs follow up with confirmed state from K4 AI responses.

## 2. Exact Constants & Conversion Tables
- **`K4.MODES`**:
  - `1`: `{ code: 1, key: 'LSB', label: 'LSB', group: 'SSB' }`
  - `2`: `{ code: 2, key: 'USB', label: 'USB', group: 'SSB' }`
  - `3`: `{ code: 3, key: 'CW', label: 'CW', group: 'CW' }`
  - `4`: `{ code: 4, key: 'FM', label: 'FM', group: 'FM' }`
  - `5`: `{ code: 5, key: 'AM', label: 'AM', group: 'AM' }`
  - `6`: `{ code: 6, key: 'DATA', label: 'DATA', group: 'DATA' }`
  - `7`: `{ code: 7, key: 'CW-R', label: 'CW-R', group: 'CW' }`
  - `9`: `{ code: 9, key: 'DATA-R', label: 'DATA-R', group: 'DATA' }`
- **`K4.DATA_SUBMODES`**: `{ 0: 'DATA-A', 1: 'AFSK-A', 2: 'FSK-D', 3: 'PSK-D' }`
- **`K4.STEP_HZ_TABLE`**: `[1, 10, 100, 1000, 2500, 5000, 10000]` (for `VT` index `0..6`)
- **`K4.SL_FRAMES_TABLE`**: `[1, 2, 2, 3, 3, 3, 6, 6]` (corresponding target latency ms: `[35, 60, 75, 95, 115, 140, 180, 240]`)
- **`K4.BANDS`** (ITU/US amateur bands + GEN, id `0..10`):
  - `{ bn: '00', id: '160m', label: '160m', defaultHz: 1840000, startHz: 1800000, endHz: 2000000 }`
  - `{ bn: '01', id: '80m',  label: '80m',  defaultHz: 3573000, startHz: 3500000, endHz: 4000000 }`
  - `{ bn: '02', id: '60m',  label: '60m',  defaultHz: 5357000, startHz: 5330500, endHz: 5405000 }`
  - `{ bn: '03', id: '40m',  label: '40m',  defaultHz: 7074000, startHz: 7000000, endHz: 7300000 }`
  - `{ bn: '04', id: '30m',  label: '30m',  defaultHz: 10136000, startHz: 10100000, endHz: 10150000 }`
  - `{ bn: '05', id: '20m',  label: '20m',  defaultHz: 14074000, startHz: 14000000, endHz: 14350000 }`
  - `{ bn: '06', id: '17m',  label: '17m',  defaultHz: 18100000, startHz: 18068000, endHz: 18168000 }`
  - `{ bn: '07', id: '15m',  label: '15m',  defaultHz: 21074000, startHz: 21000000, endHz: 21450000 }`
  - `{ bn: '08', id: '12m',  label: '12m',  defaultHz: 24915000, startHz: 24890000, endHz: 24990000 }`
  - `{ bn: '09', id: '10m',  label: '10m',  defaultHz: 28074000, startHz: 28000000, endHz: 29700000 }`
  - `{ bn: '10', id: '6m',   label: '6m',   defaultHz: 50313000, startHz: 50000000, endHz: 54000000 }`

## 3. Parsed CAT Commands (`CatCodec.parseCommand(rawCmd)`)
Return `{ kind, rx, ... }` (`rx` is `'A'` or `'B'` when receiver-scoped, `null` when global):
- `FA` / `FB`: 11-digit Hz -> `{ kind: 'freq', rx: 'A'|'B', freqHz }`
- `MD` / `MD$`: 1 digit -> `{ kind: 'mode', rx, modeCode }`
- `DT` / `DT$`: 1 digit -> `{ kind: 'dataSubMode', rx, subMode }`
- `BW` / `BW$`: 4 digits (`x10 Hz`) -> `{ kind: 'bw', rx, bwHz: val * 10 }`
- `IS` / `IS$`: optional leading space + 4 digits (`x10 Hz` in K41 mode; if raw >= 1000? Wait: K4 manual p.18: in `K41;` mode `IS$` uses `x10 Hz`, e.g. `IS$0150;` = `1500 Hz`, while legacy K3 is `IS 0500;` -> in `K41;` (`ER1;`), spec `IS`/`IS$` uses `val * 10` Hz when length is 4 digits <= 600, wait: let's follow QK4 & manual explicitly: since we always send `K41;`, `ISnnnn;` and `IS$nnnn;` are `val * 10` Hz! Note: support optional whitespace after `IS` such as `IS 0150;`). `{ kind: 'ifShift', rx, ifShiftHz: val * 10 }`
- `CW`: 2 digits (`x10 Hz`) -> `{ kind: 'cwPitch', rx: null, cwPitchHz: val * 10 }`
- `VT` / `VT$`: `nm` (step index `0..6`, optional mode digit) -> `{ kind: 'step', rx, stepIdx, stepHz: STEP_HZ_TABLE[idx] }`
- `LK` / `LK$`: `0|1` -> `{ kind: 'lock', rx, locked: val === 1 }`
- `PA` / `PA$`: `nm` (`preamp: 0..3`, `on: 0|1`) -> `{ kind: 'preamp', rx, preamp: on ? n : 0, preampOn: on === 1 }`
- `RA` / `RA$`: `nnm` (`attenDb: 0..21`, `on: 0|1`) -> `{ kind: 'atten', rx, attenDb: on ? nn : 0, attenOn: on === 1 }`
- `AG` / `AG$`: `nnn` (`000..060`) -> `{ kind: 'afGain', rx, afGain }`
- `RG` / `RG$`: `-nn` or `nn` (`-60..0`) -> `{ kind: 'rfGain', rx, rfGainDb }`
- `SQ` / `SQ$`: `nnn` (`000..040`) -> `{ kind: 'squelch', rx, squelch }`
- `NB` / `NB$`: `NBnnm` (3 chars: level `0..15`, on `0|1`) or `NBm` (1 char: on `0|1`) -> `{ kind: 'nb', rx, nbLevel, nbOn }`
- `NR` / `NR$`: `NRnnm` (level `0..10`, on `0|1`) -> `{ kind: 'nr', rx, nrLevel, nrOn }`
- `NM` / `NM$`: `NMnnnnm` (`150..5000 Hz`, on `0|1`) or `NMm` -> `{ kind: 'notch', rx, notchHz, notchOn }`
- `GT` / `GT$`: `0|1|2` (`0=OFF, 1=SLOW, 2=FAST`) -> `{ kind: 'agc', rx, agc }`
- `AP` / `AP$`: `mb` (`on: 0|1`, `bwIdx: 0|1|2`) -> `{ kind: 'apf', rx, apfOn, apfBwIdx }`
- `SMH` / `SMH$`: signed dBm string e.g. `SMH-095;` or `SMH+005;` -> `{ kind: 'smeterDbm', rx, dBm }`. Compute S-unit label: if `dBm <= -73`, `S = clamp((dBm + 127) / 6, 0, 9)`; if `dBm > -73`, `overDb = Math.round(dBm + 73)` (`S9+XX`).
- `SM` / `SM$`: `nn` (`00..42` bars in `K41`) -> convert approx `dBm = -127 + (nn * 114) / 42` -> `{ kind: 'smeterBars', rx, bars: nn, dBm }`
- `SB`: `0|1` -> `{ kind: 'subRx', subRxEnabled: val === 1 }`
- `FT`: `0|1` -> `{ kind: 'split', splitEnabled: val === 1 }`
- `LN`: `0|1` -> `{ kind: 'vfoLink', linked: val === 1 }`
- `#SPN` / `#SPN$`: integer (`>= 6000` direct Hz; `< 1000` interpret `* 1000` Hz per K4 manual `#SPN46;`!) -> `{ kind: 'panSpan', rx, spanHz }`
- `#REF` / `#REF$`: signed int `-200..60` -> `{ kind: 'panRef', rx, refDbm }`
- `#SCL` / `#SCL$`: int `10..150` -> `{ kind: 'panScale', rx, scaleDb }`
- `#AVG`: int `1..20` -> `{ kind: 'panAvg', avg }`
- `#WBS` / `#WBS$`: int `5..30` -> `{ kind: 'wfBlack', rx, wfBlack }`
- `#AR` / `#AR$`: either `#ARaadd+oom` (take trailing `m === '1'`) or 1-char -> `{ kind: 'autoRef', rx, autoRef }`
- `#DPM`: `0|1|2` -> `{ kind: 'dualPan', dualPanMode }`
- `#MP` / `#MP$`: `0|1` (ignore `-1` or set `miniPanAvailable: false`) -> `{ kind: 'miniPan', rx, miniPan }`
- `MX`: string in `['A.B','AB.AB','A.-A','A.AB','AB.B','AB.A','B.AB','B.B','B.A','A.A']` -> `{ kind: 'audioMix', mix }`
- `EM`: `0|1|2|3` -> `{ kind: 'encodeMode', encodeMode }`
- `SL`: `0..7` -> `{ kind: 'streamingLatency', streamingLatency }`
- `PONG`: `<epoch>` -> `{ kind: 'pong', epoch }`
- `TB` / `TB$`: `{ kind: 'decodedText', rx, txQueued, text }`
- `ER`: `nn` or `nn:msg` -> `{ kind: 'radioError', code, message }`
- `ID` / `OM` / `SN`: radio identity metadata.

### Builder Functions (`CatCodec.builders`)
- `freq(rx, hz)`: `'F' + (rx === 'B' ? 'B' : 'A') + String(Math.round(clamp(hz, 100000, 54000000))).padStart(11, '0') + ';'`
- `mode(rx, code)`: `'MD' + (rx === 'B' ? '$' : '') + code + ';'`
- `dataSubMode(rx, sub)`: `'DT' + (rx === 'B' ? '$' : '') + sub + ';'`
- `bw(rx, bwHz)`: `'BW' + (rx === 'B' ? '$' : '') + String(Math.round(clamp(bwHz, 50, 5000) / 10)).padStart(4, '0') + ';'`
- `ifShift(rx, hz)`: `'IS' + (rx === 'B' ? '$' : '') + String(Math.round(clamp(hz, 0, 5000) / 10)).padStart(4, '0') + ';'`
- `cwPitch(hz)`: `'CW' + String(Math.round(clamp(hz, 250, 950) / 10)).padStart(2, '0') + ';'`
- `step(rx, idx, modeCode)`: `'VT' + (rx === 'B' ? '$' : '') + clamp(idx, 0, 6) + (modeCode ?? '') + ';'`
- `lock(rx, on)`: `'LK' + (rx === 'B' ? '$' : '') + (on ? '1' : '0') + ';'`
- `subRx(on)`: `'SB' + (on ? '1' : '0') + ';'`
- `preamp(rx, level)`: `'PA' + (rx === 'B' ? '$' : '') + (level > 0 ? `${level}1` : '00') + ';'`
- `atten(rx, db)`: `'RA' + (rx === 'B' ? '$' : '') + String(db > 0 ? clamp(Math.round(db/3)*3, 3, 21) : 0).padStart(2, '0') + (db > 0 ? '1' : '0') + ';'`
- `nb(rx, level, on)`: `'NB' + (rx === 'B' ? '$' : '') + String(clamp(level, 0, 15)).padStart(2, '0') + (on ? '1' : '0') + ';'`
- `nr(rx, level, on)`: `'NR' + (rx === 'B' ? '$' : '') + String(clamp(level, 0, 10)).padStart(2, '0') + (on ? '1' : '0') + ';'`
- `notch(rx, hz, on)`: `'NM' + (rx === 'B' ? '$' : '') + String(clamp(Math.round(hz), 150, 5000)).padStart(4, '0') + (on ? '1' : '0') + ';'`
- `agc(rx, mode)`: `'GT' + (rx === 'B' ? '$' : '') + clamp(mode, 0, 2) + ';'`
- `panSpan(rx, spanHz)`: `'#SPN' + (rx === 'B' ? '$' : '') + Math.round(clamp(spanHz, 6000, 368000)) + ';'`
- `panRef(rx, refDbm)`: `'#REF' + (rx === 'B' ? '$' : '') + Math.round(clamp(refDbm, -160, 20)) + ';'`
- `panScale(rx, scaleDb)`: `'#SCL' + (rx === 'B' ? '$' : '') + Math.round(clamp(scaleDb, 10, 150)) + ';'`
- `panAvg(avg)`: `'#AVG' + String(clamp(Math.round(avg), 1, 20)).padStart(2, '0') + ';'`
- `wfBlack(rx, wbs)`: `'#WBS' + (rx === 'B' ? '$' : '') + Math.round(clamp(wbs, 5, 30)) + ';'`
- `autoRef(rx, on)`: `'#AR' + (rx === 'B' ? '$' : '') + (on ? 'A' : 'M') + ';'`
- `dualPan(mode)`: `'#DPM' + clamp(mode, 0, 2) + ';'`
- `miniPan(rx, on)`: `'#MP' + (rx === 'B' ? '$' : '') + (on ? '1' : '0') + ';'`
- `audioMix(mix)`: `'MX' + mix + ';'`
- `encodeMode(em)`: `'EM' + clamp(em, 0, 3) + ';'`
- `streamingLatency(sl)`: `'SL' + clamp(sl, 0, 7) + ';'`
- `ping(epochSec)`: `'PING' + Math.floor(epochSec) + ';'`

## 4. `K4.RadioState` Default Snapshot & Events
Default RX state (`createDefaultRxState(defaultFreqHz)`):
- `rxA`: `freqHz: 14074000`, `mode: 6` (`DATA`), `dataSubMode: 0` (`DATA-A`), `bwHz: 2700`, `ifShiftHz: 1500`, `stepHz: 100`, `stepIdx: 2`, `locked: false`, `preamp: 0`, `attenDb: 0`, `afGain: 30`, `rfGainDb: 0`, `squelch: 0`, `nbOn: false`, `nbLevel: 5`, `nrOn: false`, `nrLevel: 4`, `notchOn: false`, `notchHz: 750`, `agc: 1`, `apfOn: false`, `apfBwIdx: 0`, `sMeterDbm: -115`, `panSpanHz: 48000`, `panRefDbm: -50`, `panScaleDb: 80`, `wfBlack: 14`, `autoRef: false`, `miniPan: false`, `panCenterHz: 14074000`, `panTierKHz: 48`, `noiseFloorDbm: -120`
- `rxB`: same shape with `freqHz: 14025000`, `mode: 3` (`CW`), `bwHz: 500`, `ifShiftHz: 500`
- Top-level fields:
  - `connection`: `{ status: 'disconnected'|'connecting'|'authenticating'|'connected'|'error', wsUrl: '', subprotocol: '', authStatus: 'none'|'authenticating'|'authenticated'|'rejected', error: null, rttMs: null, radioId: '', serial: '' }`
  - `operatingPolicy: 'rx-only'`
  - `cwPitchHz: 500`, `subRxEnabled: false`, `splitEnabled: false`, `vfoLinked: false`, `activeTxVfo: 'A'`, `panAvg: 4`, `dualPanMode: 0`, `audioMix: 'A.B'`, `encodeMode: 1`, `streamingLatency: 2`
  - `decodedText: []` (array of `{ id, rx, text, timestamp }`, max 200 entries)
  - `band`: derived helper / `K4.BandPlan`
- Emits `'change'` with `(snapshot, changedKey)`. `K4.Client` forwards `'state'` events whenever `RadioState` changes.
