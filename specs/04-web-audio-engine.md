# Spec 04: Web Audio Engine (12 kHz Stereo PCM, WebCodecs Opus, and `file://` Safety)

## 1. Wire Audio Packet Format (`0x01`)
Header (7 bytes):
- `[0]`: `0x01`
- `[1]`: `ver`
- `[2]`: `seq` (`uint8`, wraps `0..255`)
- `[3]`: `encodeMode` (`0`=24-bit in S32LE, `1`=S16LE, `2`/`3`=raw Opus)
- `[4..5]`: `frameSamplesPerCh` (`uint16` little-endian)
- `[6]`: `sampleRateCode` (`0` -> `12000` Hz)
- `[7..]`: interleaved `[Main, Sub, Main, Sub, ...]` audio payload at **odd byte offset 7**.

**Mandatory Unaligned Rule**: NEVER construct `new Int16Array(buf, offset)` or `new Int32Array(buf, offset)` directly on offset 7 — that throws `RangeError`! Always read samples with `DataView.prototype.getInt16(pos, true)` and `DataView.prototype.getInt32(pos, true)`.

## 2. Calibrated Normalization (`K4.PcmDecoder`)
K4 streaming audio arrives `32×` (`~30 dB`) below full scale (`K4_GAIN_BOOST = 32.0`):
- **`EM1` (`encodeMode === 1`)**: S16LE interleaved (`4 bytes/stereo frame`). Scale factor = `32.0 / 32768.0`.
- **`EM0` (`encodeMode === 0`)**: 24-bit signed integers stored in S32LE containers (`8 bytes/stereo frame`, 2x 32-bit LE ints). Scale factor = `32.0 / 8388608.0` (`2^23`).
- Soft limiter helper `softClip(x)`:
  - If `|x| <= 0.9`, return `x`.
  - Else return `Math.sign(x) * (0.9 + 0.1 * Math.tanh((Math.abs(x) - 0.9) / 0.1))`.
- Export `K4.PcmDecoder.K4_GAIN_BOOST = 32.0`, `K4.PcmDecoder.softClip(x)`, `K4.PcmDecoder.decode(audioPkt)` -> `{ left: Float32Array, right: Float32Array, sampleRate: 12000 }`.

## 3. Opus Packet Decoder (`K4.OpusPacketDecoder`)
- `isSupported()`: checks `typeof globalThis.AudioDecoder === 'function'`. (Returns `false` on Firefox `file://`, cleanly guiding `K4.Client` to request `EM1;`!).
- When supported, configures `new AudioDecoder({ output, error })` with `{ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 }` (omitting `description` per W3C WebCodecs spec so raw RFC 6716 Opus frames decode cleanly).
- In `output(audioData)`: extract planar/interleaved channels via `audioData.copyTo(...)`, multiply by `32.0` + `softClip`, forward `{ left, right, sampleRate: audioData.sampleRate }` to consumer callback, and ALWAYS call `audioData.close()`.

## 4. `AudioWorklet` & `ScriptProcessorNode` Fallback (`worklet-source.js`, `audio-engine.js`)
- **Zero relative URL loading**: Embed processor source as a string constant `K4.WORKLET_PROCESSOR_SOURCE` in `web/js/audio/worklet-source.js` and expose `K4.createWorkletDataUrl()` returning `'data:text/javascript;base64,' + btoa(K4.WORKLET_PROCESSOR_SOURCE)` so it never fails CORS on `file://`.
- **Fallback**: If `!AudioContext`, return graceful unavailable status; if `typeof ctx.audioWorklet?.addModule !== 'function'` or `addModule(dataUrl)` throws (e.g., Firefox on `file://` disables `audioWorklet`), automatically instantiate `ctx.createScriptProcessor(1024, 0, 2)` reading from the shared JS ring/jitter buffer!
- **Resampling & Adaptive Jitter Buffer**:
  - Ring buffer capacity `2.0` seconds at `ctx.sampleRate`.
  - Source frames (`12000` Hz for PCM or `48000` Hz for Opus) are resampled into the ring buffer with linear interpolation (`ratio = srcRate / dstRate`, nudged by `±0.002` gentle clock drift recovery when buffer fill drifts outside `[0.5 * targetMs, 2.0 * targetMs]`).
  - Latency tier `SL0..SL7` sets target fill: `[35, 60, 75, 95, 115, 140, 180, 240]` ms.
  - Packet loss / underrun protection: track expected `seq = (prevSeq + 1) & 0xFF` and apply 16-sample fade on underrun.
- **Channel Mixing & Controls (`K4.mixStereoSample(main, sub, opts)`)**:
  - `gainA`, `gainB` (`0..1`), `subRxEnabled`, `muted`, `balance` (`-1..+1`), and `mixMode` matching K4 `MX` options (`'A.B'`, `'AB.AB'`, `'A.-A'`, `'A.AB'`, `'AB.B'`, `'AB.A'`, `'B.AB'`, `'B.B'`, `'B.A'`, `'A.A'`). If `!subRxEnabled`, Sub channel contribution is gated to `0` (`main` routed cleanly according to preset or `A.A` stereo dual-mono so single-RX listening fills both ears unless `A.B` binaural with Sub ON is active!).
  - Expose `getDiagnostics()` -> `{ started, muted, sinkType: 'worklet'|'script-processor'|'none', encodeMode, bufferMs, targetMs, underruns, packetsIn, seqGaps }`.
