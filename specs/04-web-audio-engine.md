# Spec 04: Web Audio Engine (12 kHz Stereo PCM, WebCodecs Opus, and `file://` Safety)

## 1. Wire Audio Packet Format (`0x01`)
Header (7 bytes):
- `[0]`: `0x01`
- `[1]`: `ver` (`0x01` on real K4 `R40.B1`, vs `0x00` on PAN/MiniPAN)
- `[2]`: `seq` (`uint8`, wraps `0..255`)
- `[3]`: `encodeMode` (`0`=24-bit in S32LE @ 12 kHz, `1`=S16LE @ 12 kHz, `2`/`3`=raw RFC 6716 Opus)
- `[4..5]`: `frameSamplesPerCh` (`uint16` little-endian, expressed in **12 kHz tick units** across ALL modes: `240` = 20 ms @ `SL0`, `480` = 40 ms @ `SL2`, `720` = 60 ms @ `SL3`, `1440` = 120 ms @ `SL7`)
- `[6]`: `sampleRateCode` (`0` -> `12000` Hz header nominal clock; note that for `EM2`/`EM3` Opus, `[6]` stays `0` in the header while the Opus bitstream inside decodes at **48000 Hz**, i.e., `4 * frameSamplesPerCh` = `960`/`1920`/`2880`/`5760` samples/ch!)
- `[7..]`: audio payload at **odd byte offset 7** (`EM0`/`EM1` interleaved `[Main, Sub, Main, Sub, ...]`; `EM2`/`EM3` raw RFC 6716 Opus packet, with multi-frame repacketized packets such as TOC `0xbc`/`0xbd`/`0xbe` CELT fullband stereo at `SL >= 1`).

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
- Real-K4 `EM2`/`EM3` Opus wire & timing details:
  - Packets carry `ver = 1`, `sampleRateCode = 0` (`12000` Hz header nominal clock), and `frameSamplesPerCh` in 12 kHz tick units (`240` for `SL0`, `480` for `SL2`, `720` for `SL3`, `1440` for `SL7`).
  - Payloads contain raw RFC 6716 CELT fullband stereo packets (`48000 Hz`, single- or multi-frame repacketized TOCs such as `0xbc`, `0xbd`, `0xbe`), decoding to `4 * frameSamplesPerCh` (`960`, `1920`, `2880`, or `5760`) PCM samples/ch @ `48000 Hz`.
  - **Duration-accurate `EncodedAudioChunk` timestamps**: `decodePacket(opusBytes, meta)` advances `_timestampUs` by `Math.round((frameSamplesPerCh / sampleRate) * 1e6)` (falling back to `20000` us when metadata is omitted — yielding `20000` us @ `SL0` `240/12000`, `40000` us @ `SL2` `480/12000`, `60000` us @ `SL3` `720/12000`). `AudioEngine.pushPacket` MUST pass parsed `frameSamplesPerCh` and `sampleRate` from `K4.BinaryPackets.parseAudio(audioPkt)` so multi-frame `SL` > 0 packets do not accumulate drifting timestamps.
- In `output(audioData)`: extract planar/interleaved channels via `audioData.copyTo(...)`, multiply by `32.0` + `softClip` (gain parity with `EM0`/`EM1` `1/32` wire scaling), forward `{ left, right, sampleRate: audioData.sampleRate }` to consumer callback, and ALWAYS call `audioData.close()`.

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

## 5. AF Passband Scope & Stereo 16-bit PCM `.wav` Clip Recorder
- Decoded 12 kHz stereo PCM frames (from both `EM0`/`EM1` PCM and WebCodecs `EM2`/`EM3` `AudioData` outputs, downsampled/tapped prior to mute attenuation) feed both an internal 1024-sample mono FFT ring buffer and an active stereo `.wav` clip buffer, working identically even when WebAudio `AudioContext` is suspended or muted.
- `getAfSpectrum(maxHz = 3200)` computes a Hann-windowed 1024-point radix-2 FFT and returns `{ binsDb: Float32Array, binHz, sampleRate: 12000, maxHz, hasSignal }`.
- `K4.encodeWavPcm16(chunks, totalFrames, sampleRate = 12000, channels = 2)` writes a standard 44-byte RIFF/WAVE PCM16 buffer; `startRecording(meta)`, `stopRecording()`, `isRecording()`, and `getRecordingStatus()` enforce a 300 s capture safety ceiling and return `{ wavBytes, blob, durationSec, sampleRate, channels, totalFrames, filename }`.

## 6. Outbound TX Audio Capture & Cert-Free Localhost Dev
- See [07-transmit-and-atu.md](./07-transmit-and-atu.md) Section 5 for outbound `EM1` S16LE (`12 kHz`) TX capture (`mic`, `two-tone`, `tone-1k`, `wav`), `setTxPacketHandler`, input VU/soft-limiter, and `http://localhost:9280` zero-cert Secure Context architecture.
