# Spec 01: K4 Wire Protocol, SHA-384 Auth, WebSocket Shim, and `RxOnlyGate`

## 1. Transport Topology
The browser connects directly over `ws://` or `wss://` to an off-the-shelf WebSocket-to-TCP bridge (`websockify` or `websocat` in dev/prod) forwarding raw TCP bytes to `<k4-ip>:9205`.
- `K4.Client.defaultWsUrl()`:
  - If `location.protocol === 'file:'`: return `'ws://127.0.0.1:9280'`.
  - If `location.protocol === 'http:'` and (`location.hostname === '127.0.0.1'` or `'localhost'`): return `'ws://' + location.host + '/ws'`.
  - Otherwise: return `(location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'`.
- **Subprotocol Negotiation (`websockify` vs `websocat`)**:
  - `websockify` expects `Sec-WebSocket-Protocol: binary`; `websocat --binary` (without `--websocket-protocol`) closes if a subprotocol is requested.
  - On `connect(opts)`: if `opts.subprotocolMode` is `'binary'`, pass `['binary']`; if `'none'`, omit subprotocols; if `'auto'` (default), first try `new WebSocket(url, ['binary'])` with `ws.binaryType = 'arraybuffer'`. If `onclose`/`onerror` fires *before* `onopen` succeeds, automatically reconnect once with `new WebSocket(url)` (empty subprotocols) before failing.

## 2. Authentication & Session Lifecycle
1. Immediately inside `ws.onopen`:
   - Apply `SL<slTier>` and `EM<emMode>` immediately into `RadioState` (because the K4 does NOT echo `SL<n>;` SET commands, though `SL;` GET returns `SL<n>;`), and transition `connection` to `status: 'authenticating'`, `authStatus: 'authenticating'`.
   - Compute `K4.sha384HexSync(password)` (pure-`BigInt` FIPS 180-4 SHA-384 producing 96 lowercase hex ASCII bytes) and send **ONLY** those **96 raw ASCII bytes** (`Uint8Array(96)`) directly on the WebSocket — **NOT** wrapped in `0xFEFDFCFB` packet framing markers and **WITHOUT** immediately sending bootstrap CAT or `PING` (matching QK4 `src/network/tcpclient.cpp` post-auth ordering).
   - Also expose async `K4.sha384Hex(input)` returning `Promise.resolve(sha384HexSync(input))` so both sync unit tests and async callers always work on `file://` in Firefox and Chrome.
   - Real K4 (`R40.B1`) post-auth packet cadence: after accepting the 96-byte auth hash, the radio immediately begins streaming **`0x01` audio packets (`EM3` by default)** (~37 ms after connect) with **zero `0x02` PAN frames** until CAT / `RDY;` initialization runs.
   - Set `this._bootstrapSent = false` and schedule a **250 ms fallback timer** (`this._bootstrapTimer`) to call `_sendBootstrapAndStartKeepalive(gen, emMode, slTier)` if the socket is still open on the same connection generation and no K4 packet has arrived yet.
2. **Deferred Bootstrap CAT Sequence & 1 Hz `PING` Start** (`_sendBootstrapAndStartKeepalive`):
   - Triggered immediately upon receipt of the **first valid framed K4 packet** (typically `0x01` audio on real K4) in `_handleFrame(payload)` when `!this._bootstrapSent`, OR by the **250 ms fallback timer** if no packet arrived first. Sending `RDY;` + CAT triggers the K4 to emit the full snapshot and begin streaming `0x02` PAN frames.
   - Marks `_bootstrapSent = true`, clears `_bootstrapTimer`, sends the single framed `bootstrapCat` packet, starts the 1 Hz `PING` timer, and attaches the `'pagehide'` teardown handler.
   - Determine `emMode`: if `opts.encodeMode` is `0 | 1 | 2 | 3`, use `Number(encodeMode)`; if `'auto'` (default), pick `3` ONLY when `K4.OpusPacketDecoder && K4.OpusPacketDecoder.isSupported()` is `true`, otherwise pick `1` (S16LE PCM — guaranteed on `file://` in Firefox!).
   - Determine `slTier`: default `2` (40 ms, clamped `0..7`).
   - Send (omitting bare `SP;` because `SP` is SET-only in rev. D4 and triggers `?;`/`ER`, and omitting `#SCL$;`, `#WBS$;`, `#AR$;`, `#FXT$;` because `#SCL`, `#WBS`, `#AR`, and `#FXT` are global-only on real K4 firmware and `$` returns `?;`; also keep `AI5;` after `RDY;` because `RDY;` initializes client mode to `AI4`):
     ```
     RDY;K41;ER1;AI5;EM<emMode>;SL<slTier>;FA;FB;MD;MD$;DT;DT$;BW;BW$;IS;IS$;CW;VT;VT$;LK;LK$;SB;FT;SQ;SQ$;AP;AP$;RT;RT$;RO;RO$;DV;OV;OV$;SMH;SMH$;#SPN;#SPN$;#REF;#REF$;#SCL;#AVG;#WBS;#AR;#DPM;#MP;#MP$;#FRZ;#FPS;#NB;#NB$;#NBL;#NBL$;#DSM;#WFH;MX;#FXT;TD;TD$;SIFP1;SIRF1;SIDA1;
     ```
3. **First Packet Confirmation**: Transition `connection.status` to `'connected'` and `connection.authStatus` from `'authenticating'` to `'authenticated'` (clearing `error: null`) as soon as ANY valid framed K4 packet arrives from the socket. If the socket closes cleanly or with error while `authStatus === 'authenticating'`, set `status: 'error'`, `authStatus: 'rejected'` with diagnostic hint.
4. **1 Hz Keepalive & Clean Close**:
   - Every `1000 ms` while open (once `_sendBootstrapAndStartKeepalive` runs), send `PING<Math.floor(Date.now() / 1000)>;` and record `_lastPingSentPerfMs = performance.now()`. On real K4 (`R40.B1`), `PING<ts>;` replies with a bare `PONG;` (no epoch suffix), so the client matches `PONG;` (or `PONG<ts>;`) against `_lastPingSentPerfMs` to compute `rttMs = Math.max(0, Math.round(nowMs() - lastPingSentPerfMs))`.
   - Clear both `_pingTimer` and `_bootstrapTimer` (and reset `_bootstrapSent = false`) cleanly in `_stopKeepalive()`, `disconnect()`, and `ws.onclose`.
   - On `disconnect()` or `window` `'pagehide'`, attempt to send framed `RRN;` before `ws.close(1000)`.

## 3. Binary Stream Framing (`K4.PacketFramer`)
K4 binary packet wire format:
- `[0..3]`: `START_MARKER` = `[0xFE, 0xFD, 0xFC, 0xFB]`
- `[4..7]`: `payloadLength` = `uint32` Big-Endian (`1 .. 262144`)
- `[8..8+payloadLength-1]`: `payload`
- `[8+payloadLength..11+payloadLength]`: `END_MARKER` = `[0xFB, 0xFC, 0xFD, 0xFE]`

Stream parser rules (`framer.push(uint8Chunk)`):
- Maintain an internal contiguous `Uint8Array` accumulator appending incoming chunks.
- Loop while unconsumed bytes `>= 4`:
  1. Search for `[0xFE, 0xFD, 0xFC, 0xFB]` starting at `cursor`.
  2. If not found: retain only the trailing `min(remaining, 3)` bytes in the accumulator (so a `START_MARKER` split across WebSocket/TCP chunks at byte 1, 2, or 3 is never lost) and return.
  3. Advance `cursor` to the matched `START_MARKER` index. If `available < 12`, keep from `cursor` and return.
  4. Read `payloadLength` (big-endian u32 at `cursor + 4`). If `payloadLength === 0 || payloadLength > 262144`: increment `stats.badLengths`, advance `cursor += 4` (skip this false marker!), and continue loop.
  5. Wait until `available >= 12 + payloadLength` (otherwise keep from `cursor` and return).
  6. Verify `[cursor + 8 + payloadLength .. +3]` equals `[0xFB, 0xFC, 0xFD, 0xFE]`. If mismatch: increment `stats.badEndMarkers`, advance `cursor += 4` (step past false start marker), and continue loop.
  7. Slice a fresh copy `payload = buf.slice(cursor + 8, cursor + 8 + payloadLength)`, increment `stats.packetsDecoded`, call `onPacket(payload)`, advance `cursor += 12 + payloadLength`.
- Compact unconsumed tail cleanly after loop.

## 4. Payload Multiplexing (`K4.BinaryPackets`)
- **`0x00` CAT**: `[0]=0x00, [1]=ver (0x00), [2]=reserved`, `[3..]` ASCII/Latin-1 text -> `{ type: 0, text }`. (Encoder writes `[0x00, 0x00, 0x00, ...asciiBytes]`).
- **`0x01` Audio**: 7-byte header (`ver = 0x01` on real K4 `R40.B1`):
  - `[0]=0x01`, `[1]=ver (0x01)`, `[2]=seq (u8)`, `[3]=encodeMode (0..3)`, `[4..5]=frameSamplesPerCh (u16 LE)`, `[6]=sampleRateCode (0 -> 12000)`
  - `[7..]` = `payload.subarray(7)` audio data.
  - Because byte 7 is odd-aligned, also attach `dataView = new DataView(payload.buffer, payload.byteOffset + 7, payload.byteLength - 7)`.
- **`0x02` PAN**: 27-byte header (`ver = 0x00` on real K4 `R40.B1`; `DataView` little-endian):
  - `[0]=0x02`, `[1]=ver (0x00)`, `[2]=seq (u8)`, `[3]=panType (u8)`, `[4]=receiver (0 -> 'A', 1 -> 'B')`
  - `[5..6]=dataLen (u16 LE)`
  - `[7..10]=reserved (u32 LE)`
  - `[11..18]=centerFreqHz` (read 64-bit signed int LE via `Number(dv.getBigInt64(11, true))`, or safe 53-bit combine if needed)
  - `[19..22]=sampleRateKHz (i32 LE)`
  - `[23..26]=noiseFloorRaw (i32 LE)` -> `noiseFloorDbm = noiseFloorRaw / 10.0`
  - `[27..]=bins` (`Uint8Array` view, expected `1024`). Return `{ type: 2, rx: receiver === 1 ? 'B' : 'A', seq, panType, centerFreqHz, sampleRateKHz, noiseFloorDbm, bins }`.
- **`0x03` MiniPAN**: Identical 27-byte header (`ver = 0x00` on real K4 `R40.B1`) except:
  - `[19..22]` is `spanKHz (i32 LE)`: `6` in `CW`/`CW-R`, `12` in `USB`/`LSB`/`DATA-A`/`AM`/`FM`.
  - `[23..26]` (`i32 LE`) carries positive firmware metadata (`~282..327` observed on `R40.B1`, not tenth-dBm noise floor) and MUST be ignored by the display (`noiseFloorDbm = null`).
  - `rx = receiver === 1 ? 'B' : 'A'`, `bins = payload.subarray(27)` (`1024` bytes, `dBm = byte - 118` vs `0x02` PAN `byte - 162`).

## 5. Client-Side Receive-Only Firewall (`K4.RxOnlyGate`)
Initialized with `policy = 'rx-only'` (extensible enum `'rx-only' | 'tx-enabled'` for v2; default `'rx-only'`).
When `policy === 'rx-only'`:
- `inspectCat(cmdString)` splits individual `;`-terminated commands via `K4.CatCodec.splitFrames` (preserving `TB`/`TB$` embedded semicolons) and checks each trimmed uppercase command (`cmdUpper`) in strict order:
  1. **Explicit exact-match allowlist (GET-only queries & safe off-toggles)**:
     - `RX;`
     - Safe off-toggles: `SP0;`, `FT0;`
     - GET-only queries (SET forms rejected by default-deny): `ID;`, `OM;`, `SN;`, `RV;`, `IF;`, `TQ;`, `IN;`, `BG;`, `PP;`, `PP1;`, `PPnn;` (`/^\s*PP\d{2}\s*$/`), `AN;`, `FT;`
  2. **Spot/sidetone block (`SP*`)**:
     - Block bare `SP;` (SET-only in rev. D4), `SP1;`..`SP3;`, `SP$3;`, and any other `SP*` except `SP0;`.
  3. **Explicit blocked prefixes (`BLOCKED_PREFIXES`, checked longest-first)**:
     - TX / keyer / DVR / power / ATU / TX-test / front-panel switches: `TX`, `TU`, `KY`, `KZ`, `DARM`, `DAPM`, `DAMP`, `DARC`, `PB`, `PC`, `EC`, `EE`, `LB`, `PS`, `SW`, `SWT`, `SWH`, `MOX`, `VOX`, `VX`, `CP`, `MG`, `ML`, `KP`, `KS`, `ES`, `DW`, `DR`, `AT`, `TE`, `TG`, `TM`, `DO`, `XF`, `XT`, `#TX`, `#CAL`, `SP1`, `SP2`, `SP3`.
     - Remote-admin / hardware-config / relay-state prefixes: `ACT`, `KZL`, `KZF`, `RRP`, `RRC`, `RRT`, `TS`, `DM`, `PK`, `PL`, `RP`, `MI`, `MS`, `VG`, `VI`, `SD`, `RS`, `MB` (and `PP` SET/non-GET forms fall through to default-deny).
  4. **Explicit `#` RX / display allowlist (`ALLOWED_HASH_PREFIXES`)**:
     - Instead of permitting arbitrary `#*` commands, after `#TX` and `#CAL` are blocked in step 3, check `#` commands against the explicit RX/panadapter/display allowlist (longest-first with `matchPrefixBoundary`, allowing unrestricted suffix on `#AR`):
       `#SPN`, `#REF`, `#HREF`, `#SCL`, `#AVG`, `#WBS`, `#HWBS`, `#WFC`, `#HWFC`, `#WFH`, `#HWFH`, `#AR`, `#DPM`, `#HDPM`, `#MP`, `#FRZ`, `#FXT`, `#FXA`, `#FSL`, `#PKM`, `#FPS`, `#CWT`, `#VFA`, `#VFB`, `#MKA`, `#MKB`, `#DSM`, `#HDM`, `#HDS`, `#HDSM`, `#UNM`, `#NB`, `#NBL`, `#SFL`, `#SPM`.
     - Unknown `#*` commands (as well as `#TX` and `#CAL`) are rejected by default-deny.
  5. **Safe RX / pan / audio / session prefixes (`ALLOWED_PREFIXES`, checked longest-first with boundary check)**:
     - `PING`, `PONG`, `SMH`, `RDY`, `RRN`, `DNB`, `UPB`, `FA`, `FB`, `MD`, `DT`, `BW`, `IS`, `CW`, `VT`, `LK`, `BN`, `SB`, `LN`, `PA`, `RA`, `AG`, `RG`, `SQ`, `NB`, `NR`, `NM`, `NA`, `GT`, `AP`, `AR`, `MX`, `BL`, `RD`, `RU`, `RC`, `TD`, `TB`, `EM`, `SL`, `K4`, `ER`, `AI`, `SM`, `DV`, `OV`, `FI`, `FC`, `RT`, `RO`, `VC`, `FP`, `MA`, `DN`, `UP`.
      - Hardware telemetry subscriptions (`SI*`): explicitly allow only `/^SI(?:FP|RF|DA|DD|DU|RC)[01]$/` (`SIFP1;`, `SIRF1;`, `SIDA1;`, etc.), while `XT` (XIT) and all TX/relay/admin commands remain blocked.
     - `matchPrefixBoundary` requires exact match or a valid separator (`$`, `+`, `-`, `/`, `\`, space, `~`, `?`, or `'0'..'9'`, plus unrestricted suffix for `MX` / `#AR`).
     - **Rev. D4 `VC$*` guard**: reject `$` immediately after `VC` (`VC$*` is blocked because D4 defines `VCsm;` with no `$` Sub-RX form), while allowing `VC;` and `VCsm;`.
  6. **Default-deny fallback**: any unrecognized command (including SET forms of GET-only commands like `AN1;`, `FT1;`, `IDW6ELE;`, `PP` SET, unknown `#*`, or `VC$12;`) is blocked.
  - Return `{ allowed: string[], blocked: string[], sanitized: string }`. Every blocked command increments `stats.blockedCatCount`, appends to `stats.recentBlocked` (max 25), and emits `'blocked'`.
- `inspectBinary(typeByte)`: in `'rx-only'`, ONLY allow `typeByte === 0x00` (CAT). Block `0x01` (outbound TX audio) and any other non-`0x00` byte, increment `stats.blockedBinaryCount`, record in `stats.recentBlocked`, emit `'blocked'`.
