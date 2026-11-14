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
1. Immediately inside `ws.onopen`, compute `K4.sha384HexSync(password)` (pure-`BigInt` FIPS 180-4 SHA-384 producing 96 lowercase hex ASCII bytes) and send those **96 raw ASCII bytes** (`TextEncoder` -> `Uint8Array(96)`) directly on the WebSocket — **NOT** wrapped in `0xFEFDFCFB` packet framing markers!
   - Also expose async `K4.sha384Hex(input)` which uses `sha384HexSync` (or verifies via `crypto.subtle` if desired) so both sync unit tests and async callers always work on `file://` in Firefox and Chrome.
2. **Bootstrap CAT Sequence** (sent in a single framed CAT packet immediately after the 96-byte auth blob, OR upon first open):
   - Determine `emMode`: if `opts.encodeMode === 0 || 1 || 2 || 3`, use that; if `'auto'` (default), pick `3` ONLY when `K4.OpusPacketDecoder && K4.OpusPacketDecoder.isSupported()` is `true`, otherwise pick `1` (S16LE PCM — guaranteed on `file://` in Firefox!).
   - Determine `slTier`: default `2` (40 ms). **Immediately self-apply `SL<slTier>` into `RadioState`**, because the K4 does NOT echo `SL<n>;`.
   - Send:
     ```
     RDY;K41;ER1;AI5;EM<emMode>;SL<slTier>;FA;FB;MD;MD$;DT;DT$;BW;BW$;IS;IS$;CW;VT;VT$;LK;LK$;SB;SP;FT;SMH;SMH$;#SPN;#SPN$;#REF;#REF$;#SCL;#SCL$;#AVG;#WBS;#WBS$;#AR;#AR$;#DPM;#MP;#MP$;MX;
     ```
3. **First Packet Confirmation**: Transition `connection.authStatus` from `'authenticating'` to `'authenticated'` as soon as ANY valid framed K4 packet arrives from the socket. If the socket closes cleanly or with error during `'authenticating'`, set `authStatus: 'rejected'` (or `'error'`) with diagnostic hint.
4. **1 Hz Keepalive & Clean Close**:
   - Every `1000 ms` while open, send `PING<Math.floor(Date.now() / 1000)>;` and record send timestamp. When `PONG<ts>;` is received, update `rttMs = Math.round(performance.now() - lastPingSentPerfMs)`.
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
- **`0x00` CAT**: `[0]=0x00, [1]=ver, [2]=reserved`, `[3..]` ASCII/Latin-1 text -> `{ type: 0, text }`. (Encoder writes `[0x00, 0x00, 0x00, ...asciiBytes]`).
- **`0x01` Audio**: 7-byte header:
  - `[0]=0x01`, `[1]=ver`, `[2]=seq (u8)`, `[3]=encodeMode (0..3)`, `[4..5]=frameSamplesPerCh (u16 LE)`, `[6]=sampleRateCode (0 -> 12000)`
  - `[7..]` = `payload.subarray(7)` audio data.
  - Because byte 7 is odd-aligned, also attach `dataView = new DataView(payload.buffer, payload.byteOffset + 7, payload.byteLength - 7)`.
- **`0x02` PAN**: 27-byte header (`DataView` little-endian):
  - `[0]=0x02`, `[1]=ver`, `[2]=seq (u8)`, `[3]=panType (u8)`, `[4]=receiver (0 -> 'A', 1 -> 'B')`
  - `[5..6]=dataLen (u16 LE)`
  - `[7..10]=reserved (u32 LE)`
  - `[11..18]=centerFreqHz` (read 64-bit signed int LE via `Number(dv.getBigInt64(11, true))`, or safe 53-bit combine if needed)
  - `[19..22]=sampleRateKHz (i32 LE)`
  - `[23..26]=noiseFloorRaw (i32 LE)` -> `noiseFloorDbm = noiseFloorRaw / 10.0`
  - `[27..]=bins` (`Uint8Array` view, expected `1024`). Return `{ type: 2, rx: receiver === 1 ? 'B' : 'A', seq, panType, centerFreqHz, sampleRateKHz, noiseFloorDbm, bins }`.
- **`0x03` MiniPAN**: Identical 27-byte header except `[19..22]` is `spanKHz (i32 LE)`, `noiseFloorDbm = null`, `rx = receiver === 1 ? 'B' : 'A'`, `bins = payload.subarray(27)`.

## 5. Client-Side Receive-Only Firewall (`K4.RxOnlyGate`)
Initialized with `policy = 'rx-only'` (extensible enum `'rx-only' | 'tx-enabled'` for v2).
When `policy === 'rx-only'`:
- `inspectCat(cmdString)` splits individual `;`-terminated commands and checks each trimmed uppercase command:
  - **Allow**: `RX` explicitly permitted (`RX;`). All RX/pan/display/audio/query commands permitted (`FA`, `FB`, `MD`, `DT`, `BW`, `IS`, `CW`, `VT`, `LK`, `BN`, `SB`, `FT`, `LN`, `PA`, `RA`, `AG`, `RG`, `SQ`, `NB`, `NR`, `NM`, `NA`, `GT`, `AP`, `AR`, `AN`, `MX`, `BL`, `RD`, `RU`, `RC`, `TD`, `TB`, `EM`, `SL`, `RDY`, `K4`, `ER`, `AI`, `PING`, `RRN`, `SM`, `SMH`, `#*`).
  - **Block**: Any command matching prefix `TX`, `TU`, `KY`, `KZ`, `DARM`, `DAPM`, `DAMP`, `DARC`, `PB`, `PC`, `EC`, `EE`, `LB`, `PS`, `SW`, `SWT`, `SWH`, `MOX`, `VOX`, `VX`, `CP`, `MG`, `ML`, `KP`, `KS`, `ES`, `DW`, `DR`, `#TX`, `AT`, `SP1`, `SP2`, `SP3` (allow `SP0;` off).
  - Return `{ allowed: string[], blocked: string[], sanitized: string }`. Every blocked command increments `stats.blockedCatCount`, appends to `stats.recentBlocked` (max 25), and emits `'blocked'`.
- `inspectBinary(typeByte)`: in `'rx-only'`, ONLY allow `typeByte === 0x00` (CAT). Block `0x01` (outbound TX audio), increment `stats.blockedBinaryCount`, emit `'blocked'`.
