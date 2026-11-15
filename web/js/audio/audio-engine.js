'use strict';
(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const SL_TARGET_MS = Object.freeze([35, 60, 75, 95, 115, 140, 180, 240]);
  const RING_SECONDS = 2.0;
  const DEFAULT_SAMPLE_RATE = 48000;
  const DRIFT_NUDGE = 0.002;
  const UNDERRUN_FADE_SAMPLES = 16;
  const AF_FFT_SIZE = 1024;
  const AF_TAP_SAMPLE_RATE = 12000;
  const MAX_RECORD_SECONDS = 300;
  const TX_SAMPLE_RATE = 12000;
  const TX_FRAME_SAMPLES = 240;
  const TX_CHUNK_MS = 20;
  const TX_CHANNELS = 2; // Interleaved stereo S16LE matching K4 EM1 4-byte frame format
  const TX_S16_SCALE = 32768.0 / 32.0; // K4 1/32 wire convention (1024 counts = 1.0)
  const TX_VALID_SOURCES = new Set(['two-tone', 'tone-1k', 'wav', 'mic']);
  const TX_WORKLET_LOADED_CTXS = typeof WeakSet === 'function' ? new WeakSet() : null;
  const TWO_PI = 2 * Math.PI;

  const VALID_MIX_MODES = new Set([
    'A.B', 'AB.AB', 'A.-A', 'A.AB', 'AB.B', 'AB.A', 'B.AB', 'B.B', 'B.A', 'A.A',
  ]);

  function clamp(v, min, max) {
    return v < min ? min : (v > max ? max : v);
  }

  function clampInt(v, min, max) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return min;
    return n < min ? min : (n > max ? max : n);
  }

  function nowMs() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  // Fallback only when loaded standalone outside web/index.html load order.
  class FallbackEmitter {
    constructor() {
      this._listeners = new Map();
    }
    on(ev, fn) {
      if (!this._listeners.has(ev)) this._listeners.set(ev, new Set());
      this._listeners.get(ev).add(fn);
      return () => this.off(ev, fn);
    }
    off(ev, fn) {
      const set = this._listeners.get(ev);
      if (set) set.delete(fn);
    }
    once(ev, fn) {
      const unsub = this.on(ev, (payload) => {
        unsub();
        fn(payload);
      });
      return unsub;
    }
    emit(ev, payload) {
      const set = this._listeners.get(ev);
      if (!set) return;
      for (const fn of Array.from(set)) fn(payload);
    }
  }

  const BaseEmitter = typeof K4.EventEmitter === 'function' ? K4.EventEmitter : FallbackEmitter;

  function fallbackSoftClip(x) {
    if (!Number.isFinite(x)) return 0;
    const ax = Math.abs(x);
    if (ax <= 0.9) return x;
    const mag = Math.min(0.9999999, 0.9 + 0.1 * Math.tanh((ax - 0.9) / 0.1));
    return Math.sign(x) * mag;
  }

  function softLimitTx(x) {
    if (K4.PcmDecoder && typeof K4.PcmDecoder.softClip === 'function') {
      return K4.PcmDecoder.softClip(x);
    }
    return fallbackSoftClip(x);
  }

  function fallbackEncodeAudio(opts) {
    const cfg = opts || {};
    const seq = Number(cfg.seq || 0) & 0xff;
    const encodeMode = cfg.encodeMode !== undefined ? (Number(cfg.encodeMode) & 0xff) : 1;
    const frameSamplesPerCh = Number(cfg.frameSamplesPerCh || TX_FRAME_SAMPLES) & 0xffff;
    const sampleRateCode = Number(cfg.sampleRateCode || 0) & 0xff;
    const raw = cfg.audioBytes;
    let payloadBytes;
    if (raw instanceof Uint8Array) {
      payloadBytes = raw;
    } else if (ArrayBuffer.isView(raw)) {
      payloadBytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    } else if (raw instanceof ArrayBuffer) {
      payloadBytes = new Uint8Array(raw);
    } else {
      payloadBytes = new Uint8Array(0);
    }

    const out = new Uint8Array(7 + payloadBytes.byteLength);
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    out[0] = 0x01;
    out[1] = 0x01;
    out[2] = seq;
    out[3] = encodeMode;
    dv.setUint16(4, frameSamplesPerCh, true);
    out[6] = sampleRateCode;
    out.set(payloadBytes, 7);
    return out;
  }

  // Pure 7-bit ASCII source so btoa() succeeds in every browser and file:// origin.
  const TX_WORKLET_PROCESSOR_SOURCE = [
    "'use strict';",
    'class K4TxCaptureProcessor extends AudioWorkletProcessor {',
    '  constructor() {',
    '    super();',
    '    this.chunkSize = 256;',
    '    this.buf = new Float32Array(this.chunkSize);',
    '    this.offset = 0;',
    '    this.stopped = false;',
    '    this.port.onmessage = (ev) => {',
    '      if (ev && ev.data && ev.data.type === "stop") {',
    '        this.stopped = true;',
    '      }',
    '    };',
    '  }',
    '  process(inputs) {',
    '    if (this.stopped) return false;',
    '    const input = inputs && inputs[0];',
    '    if (!input || input.length === 0) return true;',
    '    const ch0 = input[0];',
    '    if (!ch0 || ch0.length === 0) return true;',
    '    for (let i = 0; i < ch0.length; i++) {',
    '      this.buf[this.offset++] = ch0[i];',
    '      if (this.offset >= this.chunkSize) {',
    '        const out = this.buf;',
    '        this.port.postMessage({ samples: out }, [out.buffer]);',
    '        this.buf = new Float32Array(this.chunkSize);',
    '        this.offset = 0;',
    '      }',
    '    }',
    '    return true;',
    '  }',
    '}',
    "registerProcessor('k4-tx-capture-processor', K4TxCaptureProcessor);",
  ].join('\n');

  function createTxWorkletDataUrl() {
    return 'data:text/javascript;base64,' + globalThis.btoa(TX_WORKLET_PROCESSOR_SOURCE);
  }

  function computeButterworthLpCoeffs(fs, fc) {
    const cutoff = Math.min(fc, fs * 0.4);
    const w0 = (TWO_PI * cutoff) / fs;
    const cosW0 = Math.cos(w0);
    const sinW0 = Math.sin(w0);
    const alpha = sinW0 / Math.SQRT2;
    const a0 = 1 + alpha;
    const b0 = ((1 - cosW0) * 0.5) / a0;
    return {
      fs,
      b0,
      b1: (1 - cosW0) / a0,
      b2: b0,
      a1: (-2 * cosW0) / a0,
      a2: (1 - alpha) / a0,
    };
  }

  /**
   * Encode Int16 interleaved PCM chunks into a standard 44-byte RIFF WAVE Uint8Array.
   * @param {Int16Array[]} chunks
   * @param {number} totalFrames
   * @param {number} [sampleRate=12000]
   * @param {number} [channels=2]
   * @returns {Uint8Array}
   */
  function encodeWavPcm16(chunks, totalFrames, sampleRate = 12000, channels = 2) {
    const ch = Math.max(1, Math.min(2, Math.round(channels || 2)));
    const sr = Math.max(1000, Math.round(sampleRate || 12000));
    const frames = Math.max(0, Math.round(totalFrames || 0));
    const dataBytes = frames * ch * 2;
    const out = new Uint8Array(44 + dataBytes);
    const view = new DataView(out.buffer);

    const writeAscii = (off, str) => {
      for (let i = 0; i < str.length; i++) {
        out[off + i] = str.charCodeAt(i) & 0xff;
      }
    };

    writeAscii(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true); // PCM fmt chunk size
    view.setUint16(20, 1, true); // Linear PCM
    view.setUint16(22, ch, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * ch * 2, true);
    view.setUint16(32, ch * 2, true);
    view.setUint16(34, 16, true);
    writeAscii(36, 'data');
    view.setUint32(40, dataBytes, true);

    let byteOff = 44;
    const maxSampleByte = 44 + dataBytes;
    for (let ci = 0; ci < chunks.length && byteOff < maxSampleByte; ci++) {
      const c = chunks[ci];
      if (!c) continue;
      for (let i = 0; i < c.length && byteOff + 1 < maxSampleByte; i++) {
        view.setInt16(byteOff, c[i], true);
        byteOff += 2;
      }
    }
    return out;
  }

  function buildBitRevTable(n) {
    const table = new Uint16Array(n);
    const bits = Math.round(Math.log2(n));
    for (let i = 0; i < n; i++) {
      let x = i;
      let rev = 0;
      for (let b = 0; b < bits; b++) {
        rev = (rev << 1) | (x & 1);
        x >>= 1;
      }
      table[i] = rev;
    }
    return table;
  }

  function buildHannWindow(n) {
    const win = new Float32Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
      win[i] = v;
      sum += v;
    }
    return { win, sum };
  }

  const AF_BIT_REV = buildBitRevTable(AF_FFT_SIZE);
  const AF_HANN = buildHannWindow(AF_FFT_SIZE);

  /**
   * Browser Web Audio receiver engine supporting K4 PCM (EM0/EM1) and WebCodecs Opus (EM2/EM3),
   * Data-URL AudioWorklet with automatic ScriptProcessorNode fallback for file://,
   * adaptive SL0..SL7 jitter buffering, linear resampling with +/-0.2% drift recovery,
   * sequence-gap tracking, and 16-sample underrun fades.
   */
  class AudioEngine extends BaseEmitter {
    constructor(opts = {}) {
      super();
      this.state = opts.state || null;

      this._ctx = null;
      this._workletNode = null;
      this._scriptNode = null;
      this._sinkType = 'none';
      this._started = false;
      this._startingPromise = null;

      this._muted = opts.muted !== undefined ? Boolean(opts.muted) : true;
      this._gainA = 1.0;
      this._gainB = 1.0;
      this._balance = 0.0;
      this._subRxEnabled = false;
      this._mixMode = 'A.B';
      this._latencyTier = 2;
      this._encodeMode = 1;

      this._lastStateSubRx = false;
      this._lastStateAudioMix = 'A.B';
      this._lastStateSl = 2;
      this._lastStateEncodeMode = 1;
      this._lastConnStatus = 'disconnected';
      this._unsubState = null;

      if (this.state) {
        this._hydrateInitialState(this.state);
        if (typeof this.state.on === 'function') {
          this._unsubState = this.state.on('change', (snap) => this._onStateChange(snap));
        }
      }

      this._dstSampleRate = DEFAULT_SAMPLE_RATE;
      this._initRingBuffer(this._dstSampleRate);

      // Resampler state across packet boundaries
      this._resampPhase = 0;
      this._resampPrevL = 0;
      this._resampPrevR = 0;
      this._resampLastSrcRate = 0;
      this._resampScratchL = new Float32Array(4096);
      this._resampScratchR = new Float32Array(4096);

      // ScriptProcessor underrun fade state
      this._hasPlayed = false;
      this._inUnderrun = false;
      this._fadeRemaining = 0;
      this._fadeStartL = 0;
      this._fadeStartR = 0;
      this._lastOutL = 0;
      this._lastOutR = 0;
      this._mixScratch = { left: 0, right: 0 };
      this._mixOptsScratch = {
        gainA: this._gainA,
        gainB: this._gainB,
        subRxEnabled: this._subRxEnabled,
        muted: this._muted,
        balance: this._balance,
        mixMode: this._mixMode,
      };

      // Diagnostics and worklet buffer tracking
      this._packetsIn = 0;
      this._seqGaps = 0;
      this._expectedSeq = null;
      this._underruns = 0;
      this._workletBufferedSamples = 0;
      this._workletStatsPerfMs = nowMs();
      this._workletSamplesPushedSinceStats = 0;

      // Lazy Opus decoder instance
      this._opusDecoder = null;
      this._opusUnsupportedWarned = false;

      // AF Passband 0..3.2 kHz FFT tap & stereo PCM16 .wav recorder
      this._fftRing = new Float32Array(AF_FFT_SIZE);
      this._fftWriteIdx = 0;
      this._fftFilled = 0;
      this._fftRe = new Float32Array(AF_FFT_SIZE);
      this._fftIm = new Float32Array(AF_FFT_SIZE);
      this._afBinsDb = new Float32Array(AF_FFT_SIZE >> 1).fill(-110);
      this._afHasComputed = false;
      this._tapMixOpts = {
        gainA: 1,
        gainB: 1,
        subRxEnabled: false,
        muted: false,
        balance: 0,
        mixMode: 'A.B',
      };
      this._tapMixScratch = { left: 0, right: 0 };

      this._recActive = false;
      this._recStartMs = 0;
      this._recMeta = {};
      this._recChunks = [];
      this._recCurChunk = null;
      this._recCurIdx = 0;
      this._recTotalFrames = 0;
      this._lastRecordedClip = null;

      // Outbound TX capture & EM1 12 kHz S16LE encoder state
      this._destroyed = false;
      this._txPacketHandler = null;
      this._txActive = false;
      this._txSource = null;
      this._txInputLevel = 0;
      this._txPacketsOut = 0;
      this._txSessionPackets = 0;
      this._txSeq = 0;
      this._txSessionGen = 0;
      this._txTimer = null;

      this._txPhase1 = 0;
      this._txPhase2 = 0;

      this._txWaveBuffer = null;
      this._txWaveSampleRate = TX_SAMPLE_RATE;
      this._txWavePhase = 0;

      this._txCtx = null;
      this._txOwnsCtx = false;
      this._txMediaStream = null;
      this._txMicSourceNode = null;
      this._txWorkletNode = null;
      this._txScriptNode = null;
      this._txMuteGainNode = null;

      this._txFrameBuf = new Float32Array(TX_FRAME_SAMPLES);
      this._txFrameIdx = 0;
      this._txSynthBuf = new Float32Array(TX_FRAME_SAMPLES);
      this._txPcmBytes = new Uint8Array(TX_FRAME_SAMPLES * TX_CHANNELS * 2);
      this._txPcmView = new DataView(this._txPcmBytes.buffer);

      this._txResampPhase = 0;
      this._txResampPrev = 0;
      this._txResampLastSrcRate = 0;
      this._txLpCoeffs = null;
      this._txLpX1 = 0;
      this._txLpX2 = 0;
      this._txLpY1 = 0;
      this._txLpY2 = 0;
      this._txFilterScratch = null;
    }

    _readSnapshot(stateObj) {
      if (!stateObj) return null;
      if (typeof stateObj.getSnapshot === 'function') return stateObj.getSnapshot();
      return stateObj;
    }

    _hydrateInitialState(stateObj) {
      const snap = this._readSnapshot(stateObj);
      if (!snap) return;
      this._lastStateSubRx = Boolean(snap.subRxEnabled);
      this._subRxEnabled = this._lastStateSubRx;

      const mx = typeof snap.audioMix === 'string' && VALID_MIX_MODES.has(snap.audioMix)
        ? snap.audioMix
        : 'A.B';
      this._lastStateAudioMix = mx;
      this._mixMode = mx;

      const sl = typeof snap.streamingLatency === 'number'
        ? clampInt(snap.streamingLatency, 0, 7)
        : 2;
      this._lastStateSl = sl;
      this._latencyTier = sl;

      const em = typeof snap.encodeMode === 'number'
        ? clampInt(snap.encodeMode, 0, 3)
        : 1;
      this._lastStateEncodeMode = em;
      this._encodeMode = em;

      if (snap.connection && snap.connection.status) {
        this._lastConnStatus = snap.connection.status;
      }
    }

    _onStateChange(snap) {
      if (!snap) return;
      let changed = false;

      const subOn = Boolean(snap.subRxEnabled);
      if (subOn !== this._lastStateSubRx) {
        this._lastStateSubRx = subOn;
        this._subRxEnabled = subOn;
        changed = true;
      }

      if (typeof snap.audioMix === 'string' && VALID_MIX_MODES.has(snap.audioMix) && snap.audioMix !== this._lastStateAudioMix) {
        this._lastStateAudioMix = snap.audioMix;
        this._mixMode = snap.audioMix;
        changed = true;
      }

      if (typeof snap.streamingLatency === 'number') {
        const sl = clampInt(snap.streamingLatency, 0, 7);
        if (sl !== this._lastStateSl) {
          this._lastStateSl = sl;
          this._latencyTier = sl;
          changed = true;
        }
      }

      if (typeof snap.encodeMode === 'number') {
        const em = clampInt(snap.encodeMode, 0, 3);
        if (em !== this._lastStateEncodeMode) {
          this._lastStateEncodeMode = em;
          this._encodeMode = em;
          changed = true;
        }
      }

      const connStatus = snap.connection && snap.connection.status;
      if (connStatus && connStatus !== this._lastConnStatus) {
        this._lastConnStatus = connStatus;
        if (connStatus === 'disconnected' || connStatus === 'connecting') {
          this._expectedSeq = null;
        }
      }

      if (changed) {
        this._syncWorkletConfig();
        this.emit('diagnostics', this.getDiagnostics());
      }
    }

    _initRingBuffer(sampleRate) {
      this._dstSampleRate = sampleRate;
      this._ringCapacity = Math.max(2048, Math.round(RING_SECONDS * sampleRate));
      this._ringMain = new Float32Array(this._ringCapacity);
      this._ringSub = new Float32Array(this._ringCapacity);
      this._ringRead = 0;
      this._ringWrite = 0;
      this._ringCount = 0;
    }

    _createAudioContext() {
      const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (typeof AudioCtx !== 'function') return null;
      try {
        return new AudioCtx({ latencyHint: 'interactive' });
      } catch (_) {
        return new AudioCtx();
      }
    }

    start() {
      if (this._started && this._ctx) {
        if (this._ctx.state === 'suspended' && typeof this._ctx.resume === 'function') {
          try {
            const p = this._ctx.resume();
            if (p && typeof p.catch === 'function') p.catch(() => {});
          } catch (_) {}
        }
        return Promise.resolve({ started: true, sinkType: this._sinkType });
      }
      if (this._startingPromise) return this._startingPromise;

      this._startingPromise = this._startInternal().finally(() => {
        this._startingPromise = null;
      });
      return this._startingPromise;
    }

    async _startInternal() {
      const ctx = this._createAudioContext();
      if (!ctx) {
        this._sinkType = 'none';
        this._started = false;
        return { started: false, sinkType: 'none' };
      }

      // Trigger resume synchronously inside the user-gesture call frame; do not await
      // indefinitely in case headless browsers lack a hardware audio device.
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        try {
          const p = ctx.resume();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (_) {}
      }

      this._ctx = ctx;
      const ctxRate = ctx.sampleRate || DEFAULT_SAMPLE_RATE;
      if (ctxRate !== this._dstSampleRate) {
        this._initRingBuffer(ctxRate);
        this._resampPhase = 0;
        this._resampPrevL = 0;
        this._resampPrevR = 0;
        this._resampLastSrcRate = 0;
      }

      let workletReady = false;
      if (
        ctx.audioWorklet &&
        typeof ctx.audioWorklet.addModule === 'function' &&
        typeof globalThis.AudioWorkletNode === 'function' &&
        typeof K4.createWorkletDataUrl === 'function'
      ) {
        try {
          const dataUrl = K4.createWorkletDataUrl();
          await Promise.race([
            ctx.audioWorklet.addModule(dataUrl),
            new Promise((_, reject) => setTimeout(() => reject(new Error('AudioWorklet timeout')), 1500)),
          ]);
          const node = new globalThis.AudioWorkletNode(ctx, 'k4-audio-processor', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
          });
          node.port.onmessage = (ev) => {
            const msg = ev.data;
            if (msg && msg.type === 'stats') {
              this._workletBufferedSamples = msg.bufferedSamples || 0;
              this._workletStatsPerfMs = nowMs();
              this._workletSamplesPushedSinceStats = 0;
              this._underruns = msg.underruns || 0;
            }
          };
          node.connect(ctx.destination);
          this._workletNode = node;
          this._sinkType = 'worklet';
          this._workletBufferedSamples = 0;
          this._workletStatsPerfMs = nowMs();
          this._workletSamplesPushedSinceStats = 0;
          this._syncWorkletConfig();
          this._flushPrebufferedToWorklet();
          workletReady = true;
        } catch (_) {
          workletReady = false;
        }
      }

      if (!workletReady) {
        if (typeof ctx.createScriptProcessor === 'function') {
          const sp = ctx.createScriptProcessor(1024, 0, 2);
          sp.onaudioprocess = (ev) => this._onScriptAudioProcess(ev);
          sp.connect(ctx.destination);
          this._scriptNode = sp;
          this._sinkType = 'script-processor';
        } else {
          this._sinkType = 'none';
          this._started = false;
          try {
            const p = ctx.close();
            if (p && typeof p.catch === 'function') p.catch(() => {});
          } catch (_) {}
          this._ctx = null;
          return { started: false, sinkType: 'none' };
        }
      }

      this._started = true;
      const diag = this.getDiagnostics();
      this.emit('started', diag);
      this.emit('diagnostics', diag);
      return { started: true, sinkType: this._sinkType };
    }

    _flushPrebufferedToWorklet() {
      if (!this._workletNode || this._ringCount <= 0) return;
      const targetSamples = Math.round((SL_TARGET_MS[this._latencyTier] / 1000) * this._dstSampleRate);
      const keep = Math.min(this._ringCount, Math.max(targetSamples, 512));
      const skip = this._ringCount - keep;
      if (skip > 0) {
        this._ringRead = (this._ringRead + skip) % this._ringCapacity;
        this._ringCount -= skip;
      }
      const main = new Float32Array(keep);
      const sub = new Float32Array(keep);
      for (let i = 0; i < keep; i++) {
        main[i] = this._ringMain[this._ringRead];
        sub[i] = this._ringSub[this._ringRead];
        this._ringRead = (this._ringRead + 1) % this._ringCapacity;
      }
      this._ringCount = 0;
      this._workletNode.port.postMessage({ type: 'audio', main, sub }, [main.buffer, sub.buffer]);
      this._workletSamplesPushedSinceStats += keep;
    }

    _syncWorkletConfig() {
      if (!this._workletNode) return;
      const targetSamples = Math.round((SL_TARGET_MS[this._latencyTier] / 1000) * this._dstSampleRate);
      const maxBufferSamples = Math.max(
        Math.round(0.5 * this._dstSampleRate),
        targetSamples * 4
      );
      this._workletNode.port.postMessage({
        type: 'config',
        gainA: this._gainA,
        gainB: this._gainB,
        subRxEnabled: this._subRxEnabled,
        muted: this._muted,
        balance: this._balance,
        mixMode: this._mixMode,
        maxBufferSamples,
        trimToSamples: Math.max(targetSamples, Math.round(0.05 * this._dstSampleRate)),
      });
    }

    setMuted(muted) {
      const next = Boolean(muted);
      if (this._muted === next) return;
      this._muted = next;
      this._syncWorkletConfig();
      const diag = this.getDiagnostics();
      this.emit('change', diag);
      this.emit('diagnostics', diag);
    }

    isMuted() {
      return this._muted;
    }

    setVolume(rx, gain01) {
      const g = Number.isFinite(Number(gain01)) ? clamp(Number(gain01), 0, 1) : 1.0;
      const target = String(rx).toUpperCase();
      if (target === 'B') {
        this._gainB = g;
      } else {
        this._gainA = g;
      }
      this._syncWorkletConfig();
      const diag = this.getDiagnostics();
      this.emit('change', diag);
      this.emit('diagnostics', diag);
    }

    getVolume(rx) {
      return String(rx).toUpperCase() === 'B' ? this._gainB : this._gainA;
    }

    setBalance(panMinus1To1) {
      const pan = Number.isFinite(Number(panMinus1To1)) ? clamp(Number(panMinus1To1), -1, 1) : 0;
      this._balance = pan;
      this._syncWorkletConfig();
      const diag = this.getDiagnostics();
      this.emit('change', diag);
      this.emit('diagnostics', diag);
    }

    getBalance() {
      return this._balance;
    }

    setMixMode(mxStr) {
      if (typeof mxStr !== 'string' || !VALID_MIX_MODES.has(mxStr)) return;
      this._mixMode = mxStr;
      this._syncWorkletConfig();
      const diag = this.getDiagnostics();
      this.emit('change', diag);
      this.emit('diagnostics', diag);
    }

    getMixMode() {
      return this._mixMode;
    }

    setLatencyTier(sl0to7) {
      this._latencyTier = clampInt(sl0to7, 0, 7);
      this._syncWorkletConfig();
      const diag = this.getDiagnostics();
      this.emit('change', diag);
      this.emit('diagnostics', diag);
    }

    getLatencyTier() {
      return this._latencyTier;
    }

    clearBuffer() {
      this._ringRead = 0;
      this._ringWrite = 0;
      this._ringCount = 0;
      this._resampPhase = 0;
      this._resampPrevL = 0;
      this._resampPrevR = 0;
      this._hasPlayed = false;
      this._inUnderrun = false;
      this._fadeRemaining = 0;
      this._lastOutL = 0;
      this._lastOutR = 0;
      this._workletBufferedSamples = 0;
      this._workletSamplesPushedSinceStats = 0;
      this._workletStatsPerfMs = nowMs();
      if (this._workletNode) {
        this._workletNode.port.postMessage({ type: 'clear' });
      }
    }

    pushPacket(audioPkt) {
      if (!audioPkt) return;
      this._packetsIn += 1;

      const isRawPacket = audioPkt instanceof Uint8Array && audioPkt.byteLength >= 7 && audioPkt[0] === 0x01;
      const pktSeq = typeof audioPkt.seq === 'number'
        ? audioPkt.seq
        : (isRawPacket ? audioPkt[2] : null);
      if (pktSeq !== null) {
        const seq = pktSeq & 0xFF;
        if (this._expectedSeq !== null && seq !== this._expectedSeq) {
          const gap = (seq - this._expectedSeq) & 0xFF;
          this._seqGaps += (gap > 0 && gap < 64) ? gap : 1;
        }
        this._expectedSeq = (seq + 1) & 0xFF;
      }

      const rawEm = typeof audioPkt.encodeMode === 'number'
        ? audioPkt.encodeMode
        : (isRawPacket ? audioPkt[3] : this._encodeMode);
      const em = rawEm;
      if (em >= 0 && em <= 3) {
        this._encodeMode = em;
      }

      if (em === 0 || em === 1) {
        if (!K4.PcmDecoder) return;
        const decoded = K4.PcmDecoder.decode(audioPkt);
        if (decoded && decoded.left && decoded.left.length > 0) {
          const sr = decoded.sampleRate || AF_TAP_SAMPLE_RATE;
          this._tapDecodedStereo(decoded.left, decoded.right, sr);
          this._resampleAndEnqueue(decoded.left, decoded.right, sr);
        }
        return;
      }

      if (em === 2 || em === 3) {
        if (!K4.OpusPacketDecoder || !K4.OpusPacketDecoder.isSupported()) {
          if (!this._opusUnsupportedWarned) {
            this._opusUnsupportedWarned = true;
            this.emit('error', new Error('Opus WebCodecs AudioDecoder unavailable on this origin; switch to PCM (EM1).'));
          }
          return;
        }
        if (!this._opusDecoder) {
          this._opusDecoder = new K4.OpusPacketDecoder({
            onOutput: ({ left, right, sampleRate }) => {
              const sr = sampleRate || 48000;
              this._tapDecodedStereo(left, right, sr);
              this._resampleAndEnqueue(left, right, sr);
            },
            onError: (err) => this.emit('error', err),
          });
        }
        const opusInput = isRawPacket
          ? (K4.BinaryPackets && typeof K4.BinaryPackets.parseAudio === 'function'
            ? K4.BinaryPackets.parseAudio(audioPkt)
            : audioPkt.subarray(7))
          : audioPkt;
        this._opusDecoder.decode(opusInput);
      }
    }

    _getEstimatedBufferSamples() {
      if (this._sinkType === 'worklet') {
        if (!this._ctx || this._ctx.state !== 'running') {
          return Math.min(this._ringCapacity, this._workletBufferedSamples + this._workletSamplesPushedSinceStats);
        }
        const elapsedSec = Math.max(0, (nowMs() - this._workletStatsPerfMs) / 1000);
        const consumed = elapsedSec * this._dstSampleRate;
        return clamp(
          this._workletBufferedSamples + this._workletSamplesPushedSinceStats - consumed,
          0,
          this._ringCapacity
        );
      }
      return this._ringCount;
    }

    getBufferMs() {
      return (this._getEstimatedBufferSamples() / this._dstSampleRate) * 1000;
    }

    _ensureScratchCapacity(minCap, preserveCount = 0) {
      if (this._resampScratchL.length >= minCap) return;
      const nextCap = Math.max(minCap, this._resampScratchL.length * 2);
      const nextL = new Float32Array(nextCap);
      const nextR = new Float32Array(nextCap);
      if (preserveCount > 0) {
        nextL.set(this._resampScratchL.subarray(0, preserveCount));
        nextR.set(this._resampScratchR.subarray(0, preserveCount));
      }
      this._resampScratchL = nextL;
      this._resampScratchR = nextR;
    }

    _enqueueRingSample(l, r) {
      const cap = this._ringCapacity;
      if (this._ringCount >= cap) {
        this._ringRead = (this._ringRead + 1) % cap;
        this._ringCount -= 1;
      }
      this._ringMain[this._ringWrite] = l;
      this._ringSub[this._ringWrite] = r;
      this._ringWrite = (this._ringWrite + 1) % cap;
      this._ringCount += 1;
    }

    _resampleAndEnqueue(leftSrc, rightSrc, srcRate) {
      if (!leftSrc || !rightSrc || !srcRate || srcRate <= 0) return;
      const len = Math.min(leftSrc.length, rightSrc.length);
      if (len <= 0) return;

      if (this._resampLastSrcRate !== srcRate) {
        this._resampPhase = 0;
        this._resampLastSrcRate = srcRate;
      }

      const targetMs = SL_TARGET_MS[this._latencyTier];
      const bufferMs = this.getBufferMs();
      const baseRatio = srcRate / this._dstSampleRate;
      let ratio = baseRatio;
      if (this._started) {
        if (bufferMs < 0.5 * targetMs) {
          ratio = baseRatio * (1.0 - DRIFT_NUDGE);
        } else if (bufferMs > 2.0 * targetMs) {
          ratio = baseRatio * (1.0 + DRIFT_NUDGE);
        }
      }

      let t = this._resampPhase;
      const limit = len - 1;
      const prevL = this._resampPrevL;
      const prevR = this._resampPrevR;
      const useWorklet = this._sinkType === 'worklet' && this._workletNode;

      if (useWorklet) {
        if (t < limit) {
          const maxEst = Math.ceil((limit - t) / ratio) + 4;
          this._ensureScratchCapacity(maxEst, 0);
        }
        let outCount = 0;
        let outL = this._resampScratchL;
        let outR = this._resampScratchR;
        while (t < limit) {
          if (outCount >= outL.length) {
            this._ensureScratchCapacity(outCount + 256, outCount);
            outL = this._resampScratchL;
            outR = this._resampScratchR;
          }
          if (t < 0) {
            const frac = t + 1;
            outL[outCount] = prevL + frac * (leftSrc[0] - prevL);
            outR[outCount] = prevR + frac * (rightSrc[0] - prevR);
          } else {
            const idx = t | 0;
            const frac = t - idx;
            outL[outCount] = leftSrc[idx] + frac * (leftSrc[idx + 1] - leftSrc[idx]);
            outR[outCount] = rightSrc[idx] + frac * (rightSrc[idx + 1] - rightSrc[idx]);
          }
          outCount += 1;
          t += ratio;
        }
        this._resampPhase = t - len;
        this._resampPrevL = leftSrc[len - 1];
        this._resampPrevR = rightSrc[len - 1];

        if (outCount > 0) {
          const main = this._resampScratchL.slice(0, outCount);
          const sub = this._resampScratchR.slice(0, outCount);
          this._workletNode.port.postMessage(
            { type: 'audio', main, sub },
            [main.buffer, sub.buffer]
          );
          this._workletSamplesPushedSinceStats += outCount;
        }
        return;
      }

      while (t < limit) {
        let lVal;
        let rVal;
        if (t < 0) {
          const frac = t + 1;
          lVal = prevL + frac * (leftSrc[0] - prevL);
          rVal = prevR + frac * (rightSrc[0] - prevR);
        } else {
          const idx = t | 0;
          const frac = t - idx;
          lVal = leftSrc[idx] + frac * (leftSrc[idx + 1] - leftSrc[idx]);
          rVal = rightSrc[idx] + frac * (rightSrc[idx + 1] - rightSrc[idx]);
        }
        this._enqueueRingSample(lVal, rVal);
        t += ratio;
      }

      this._resampPhase = t - len;
      this._resampPrevL = leftSrc[len - 1];
      this._resampPrevR = rightSrc[len - 1];

      // Guard against severe browser backgrounding latency accumulation while running.
      if (this._started) {
        const maxAllowedSamples = Math.max(
          Math.round(0.45 * this._dstSampleRate),
          Math.round(((3.5 * targetMs) / 1000) * this._dstSampleRate)
        );
        if (this._ringCount > maxAllowedSamples) {
          const targetSamples = Math.round((targetMs / 1000) * this._dstSampleRate);
          const drop = this._ringCount - targetSamples;
          if (drop > 0) {
            this._ringRead = (this._ringRead + drop) % this._ringCapacity;
            this._ringCount -= drop;
          }
        }
      }
    }

    _onScriptAudioProcess(ev) {
      const outBuf = ev.outputBuffer;
      const outL = outBuf.getChannelData(0);
      const outR = outBuf.numberOfChannels > 1 ? outBuf.getChannelData(1) : outL;
      const len = outL.length;
      const cap = this._ringCapacity;

      const mixOpts = this._mixOptsScratch;
      mixOpts.gainA = this._gainA;
      mixOpts.gainB = this._gainB;
      mixOpts.subRxEnabled = this._subRxEnabled;
      mixOpts.muted = this._muted;
      mixOpts.balance = this._balance;
      mixOpts.mixMode = this._mixMode;

      const mixFn = K4.mixStereoSample;
      const scratch = this._mixScratch;

      for (let i = 0; i < len; i++) {
        if (this._ringCount > 0) {
          const m = this._ringMain[this._ringRead];
          const s = this._ringSub[this._ringRead];
          this._ringRead = (this._ringRead + 1) % cap;
          this._ringCount -= 1;

          if (mixFn) {
            mixFn(m, s, mixOpts, scratch);
            outL[i] = scratch.left;
            if (outR !== outL) outR[i] = scratch.right;
          } else {
            const val = this._muted ? 0 : m * this._gainA;
            outL[i] = val;
            if (outR !== outL) outR[i] = val;
          }

          this._lastOutL = outL[i];
          this._lastOutR = outR[i];
          this._hasPlayed = true;
          this._inUnderrun = false;
          this._fadeRemaining = 0;
        } else {
          if (this._hasPlayed && !this._inUnderrun) {
            this._inUnderrun = true;
            if (!this._muted) this._underruns += 1;
            this._fadeRemaining = UNDERRUN_FADE_SAMPLES;
            this._fadeStartL = this._lastOutL;
            this._fadeStartR = this._lastOutR;
          }
          if (this._fadeRemaining > 0) {
            const t = (this._fadeRemaining - 1) / UNDERRUN_FADE_SAMPLES;
            const l = this._fadeStartL * t;
            const r = this._fadeStartR * t;
            this._fadeRemaining -= 1;
            outL[i] = l;
            if (outR !== outL) outR[i] = r;
            this._lastOutL = l;
            this._lastOutR = r;
          } else {
            outL[i] = 0;
            if (outR !== outL) outR[i] = 0;
            this._lastOutL = 0;
            this._lastOutR = 0;
          }
        }
      }
    }

    getDiagnostics() {
      return {
        started: this._started,
        muted: this._muted,
        sinkType: this._sinkType,
        encodeMode: this._encodeMode,
        bufferMs: Math.round(this.getBufferMs() * 10) / 10,
        targetMs: SL_TARGET_MS[this._latencyTier],
        underruns: this._underruns,
        packetsIn: this._packetsIn,
        seqGaps: this._seqGaps,
        txActive: this._txActive,
        txSource: this._txSource,
        txInputLevel: clamp(this._txInputLevel, 0, 1),
        txPacketsOut: this._txPacketsOut,
        isSecureContext: Boolean(globalThis.isSecureContext),
      };
    }

    /**
     * Register callback receiving outbound 0x01 EM1 packets (encodedPacketUint8, meta).
     * @param {Function|null} fn
     */
    setTxPacketHandler(fn) {
      this._txPacketHandler = typeof fn === 'function' ? fn : null;
    }

    /**
     * Return true when browser Secure Context and getUserMedia mic capture are available.
     * @returns {boolean}
     */
    isMicSecureContextAvailable() {
      return Boolean(
        globalThis.isSecureContext &&
        typeof navigator !== 'undefined' &&
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === 'function'
      );
    }

    /**
     * Enumerate available audio input devices without throwing on restricted origins.
     * @returns {Promise<Array<{ deviceId: string, label: string }>>}
     */
    async listAudioInputs() {
      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.enumerateDevices !== 'function'
      ) {
        return [];
      }
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!Array.isArray(devices)) return [];
        const inputs = [];
        let idx = 1;
        for (let i = 0; i < devices.length; i++) {
          const d = devices[i];
          if (d && d.kind === 'audioinput') {
            inputs.push({
              deviceId: d.deviceId || '',
              label: d.label || `Microphone ${idx}`,
            });
            idx += 1;
          }
        }
        return inputs;
      } catch (_) {
        return [];
      }
    }

    /**
     * Load a mono Float32 PCM buffer for looping TX 'wav' replay.
     * @param {Float32Array|Int16Array|number[]|null} float32Samples
     * @param {number} [sampleRate=12000]
     */
    setTxWaveBuffer(float32Samples, sampleRate = TX_SAMPLE_RATE) {
      const sr = Number(sampleRate);
      this._txWaveSampleRate = Number.isFinite(sr) && sr > 0 ? sr : TX_SAMPLE_RATE;
      this._txWavePhase = 0;

      if (!float32Samples || float32Samples.length === 0) {
        this._txWaveBuffer = null;
        return;
      }

      if (float32Samples instanceof Float32Array) {
        this._txWaveBuffer = new Float32Array(float32Samples);
        return;
      }

      const len = float32Samples.length;
      const buf = new Float32Array(len);
      if (float32Samples instanceof Int16Array) {
        for (let i = 0; i < len; i++) {
          buf[i] = float32Samples[i] / 32768.0;
        }
      } else {
        for (let i = 0; i < len; i++) {
          const v = Number(float32Samples[i]);
          buf[i] = Number.isFinite(v) ? v : 0;
        }
      }
      this._txWaveBuffer = buf;
    }

    /**
     * Return current TX input RMS VU level in [0, 1].
     * @returns {number}
     */
    getTxInputLevel() {
      return clamp(this._txInputLevel, 0, 1);
    }

    /**
     * Start outbound 12 kHz EM1 TX audio capture from 'two-tone', 'tone-1k', 'wav', or 'mic'.
     * @param {Object} [opts]
     * @returns {Promise<{ active: boolean, source: string, sampleRate: number, frameSamplesPerCh: number }>}
     */
    async startTxCapture({ source = 'two-tone', deviceId = '', voiceProcessing = false } = {}) {
      if (this._destroyed) {
        throw new Error('AudioEngine has been destroyed');
      }
      const resolvedSource = source ? String(source) : 'two-tone';
      if (!TX_VALID_SOURCES.has(resolvedSource)) {
        throw new RangeError('Unsupported TX audio source: ' + resolvedSource);
      }

      this.stopTxCapture({ silent: true });
      const gen = ++this._txSessionGen;
      this._txSessionPackets = 0;
      this._txInputLevel = 0;
      this._txFrameIdx = 0;

      if (resolvedSource === 'mic') {
        return this._startMicTxCapture(gen, deviceId, Boolean(voiceProcessing));
      }

      this._txActive = true;
      this._txSource = resolvedSource;
      this._txPhase1 = 0;
      this._txPhase2 = 0;
      this._txWavePhase = 0;

      this._pumpSyntheticTxFrame();
      this._txTimer = setInterval(() => {
        if (gen !== this._txSessionGen || !this._txActive) return;
        this._pumpSyntheticTxFrame();
      }, TX_CHUNK_MS);

      this.emit('diagnostics', this.getDiagnostics());
      return {
        active: true,
        source: resolvedSource,
        sampleRate: TX_SAMPLE_RATE,
        frameSamplesPerCh: TX_FRAME_SAMPLES,
      };
    }

    async _startMicTxCapture(gen, deviceId, voiceProcessing) {
      if (!this.isMicSecureContextAvailable()) {
        this.emit('diagnostics', this.getDiagnostics());
        throw new Error(
          'Microphone capture requires a Secure Context (http://localhost or https://) and navigator.mediaDevices.getUserMedia.'
        );
      }

      const audioConstraints = {
        echoCancellation: voiceProcessing,
        noiseSuppression: voiceProcessing,
        autoGainControl: voiceProcessing,
      };
      const devId = typeof deviceId === 'string' ? deviceId.trim() : '';
      if (devId) {
        audioConstraints.deviceId = devId;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      if (gen !== this._txSessionGen || this._destroyed) {
        this._stopMediaStreamTracks(stream);
        return { active: false, source: 'mic', sampleRate: TX_SAMPLE_RATE, frameSamplesPerCh: TX_FRAME_SAMPLES };
      }

      const reuseRxCtx = Boolean(this._ctx && this._ctx.state !== 'closed');
      const ctx = reuseRxCtx ? this._ctx : this._createAudioContext();
      if (!ctx) {
        this._stopMediaStreamTracks(stream);
        throw new Error('Web Audio API AudioContext unavailable for microphone capture.');
      }

      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        try {
          const p = ctx.resume();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (_) {}
      }

      this._txCtx = ctx;
      this._txOwnsCtx = !reuseRxCtx;
      this._txMediaStream = stream;
      this._resetTxResampler();

      let sourceNode = null;
      let muteGain = null;
      try {
        sourceNode = ctx.createMediaStreamSource(stream);
        muteGain = ctx.createGain();
        muteGain.gain.value = 0;
        muteGain.connect(ctx.destination);
      } catch (err) {
        this._cleanupTxAudioGraph();
        throw err;
      }

      this._txMicSourceNode = sourceNode;
      this._txMuteGainNode = muteGain;

      let workletReady = false;
      if (
        ctx.audioWorklet &&
        typeof ctx.audioWorklet.addModule === 'function' &&
        typeof globalThis.AudioWorkletNode === 'function'
      ) {
        try {
          if (!TX_WORKLET_LOADED_CTXS || !TX_WORKLET_LOADED_CTXS.has(ctx)) {
            const txWorkletUrl = createTxWorkletDataUrl();
            await Promise.race([
              ctx.audioWorklet.addModule(txWorkletUrl),
              new Promise((_, reject) => setTimeout(() => reject(new Error('TX AudioWorklet timeout')), 1500)),
            ]);
            if (TX_WORKLET_LOADED_CTXS) TX_WORKLET_LOADED_CTXS.add(ctx);
          }

          if (gen !== this._txSessionGen || this._destroyed) {
            this._cleanupTxAudioGraph();
            return { active: false, source: 'mic', sampleRate: TX_SAMPLE_RATE, frameSamplesPerCh: TX_FRAME_SAMPLES };
          }

          const workletNode = new globalThis.AudioWorkletNode(ctx, 'k4-tx-capture-processor', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            channelCount: 1,
            outputChannelCount: [1],
          });
          workletNode.port.onmessage = (ev) => {
            if (gen !== this._txSessionGen || !this._txActive) return;
            const payload = ev && ev.data;
            const samples = payload && payload.samples ? payload.samples : payload;
            if (samples && typeof samples.length === 'number') {
              this._processTxInputSamples(samples, ctx.sampleRate || DEFAULT_SAMPLE_RATE);
            }
          };
          this._txActive = true;
          this._txSource = 'mic';
          sourceNode.connect(workletNode);
          workletNode.connect(muteGain);
          this._txWorkletNode = workletNode;
          workletReady = true;
        } catch (_) {
          this._txActive = false;
          this._txSource = null;
          workletReady = false;
        }
      }

      if (gen !== this._txSessionGen || this._destroyed) {
        this._cleanupTxAudioGraph();
        this._txActive = false;
        this._txSource = null;
        return { active: false, source: 'mic', sampleRate: TX_SAMPLE_RATE, frameSamplesPerCh: TX_FRAME_SAMPLES };
      }

      if (!workletReady) {
        if (typeof ctx.createScriptProcessor === 'function') {
          const sp = ctx.createScriptProcessor(512, 1, 1);
          sp.onaudioprocess = (ev) => {
            if (gen !== this._txSessionGen || !this._txActive) return;
            const inBuf = ev && ev.inputBuffer;
            if (!inBuf || inBuf.numberOfChannels < 1) return;
            this._processTxInputSamples(inBuf.getChannelData(0), ctx.sampleRate || DEFAULT_SAMPLE_RATE);
          };
          this._txActive = true;
          this._txSource = 'mic';
          sourceNode.connect(sp);
          sp.connect(muteGain);
          this._txScriptNode = sp;
        } else {
          this._cleanupTxAudioGraph();
          this._txActive = false;
          this._txSource = null;
          this.emit('diagnostics', this.getDiagnostics());
          throw new Error('Browser Web Audio API lacks AudioWorkletNode and ScriptProcessorNode for mic capture.');
        }
      }

      this.emit('diagnostics', this.getDiagnostics());
      return {
        active: true,
        source: 'mic',
        sampleRate: TX_SAMPLE_RATE,
        frameSamplesPerCh: TX_FRAME_SAMPLES,
      };
    }

    /**
     * Stop TX audio capture and clean up TX audio nodes, MediaStream tracks, and timers.
     * @param {{ silent?: boolean }} [opts]
     */
    stopTxCapture(opts = {}) {
      this._txSessionGen += 1;
      if (this._txTimer !== null) {
        clearInterval(this._txTimer);
        this._txTimer = null;
      }
      this._cleanupTxAudioGraph();
      this._resetTxResampler();

      this._txActive = false;
      this._txSource = null;
      this._txInputLevel = 0;
      this._txFrameIdx = 0;
      this._txSessionPackets = 0;

      if (!opts || !opts.silent) {
        this.emit('diagnostics', this.getDiagnostics());
      }
    }

    _stopMediaStreamTracks(stream) {
      if (!stream || typeof stream.getTracks !== 'function') return;
      try {
        const tracks = stream.getTracks();
        for (let i = 0; i < tracks.length; i++) {
          if (tracks[i] && typeof tracks[i].stop === 'function') {
            tracks[i].stop();
          }
        }
      } catch (_) {}
    }

    _cleanupTxAudioGraph() {
      if (this._txWorkletNode) {
        try {
          this._txWorkletNode.port.onmessage = null;
          this._txWorkletNode.port.postMessage({ type: 'stop' });
          this._txWorkletNode.disconnect();
        } catch (_) {}
        this._txWorkletNode = null;
      }
      if (this._txScriptNode) {
        try {
          this._txScriptNode.onaudioprocess = null;
          this._txScriptNode.disconnect();
        } catch (_) {}
        this._txScriptNode = null;
      }
      if (this._txMicSourceNode) {
        try {
          this._txMicSourceNode.disconnect();
        } catch (_) {}
        this._txMicSourceNode = null;
      }
      if (this._txMuteGainNode) {
        try {
          this._txMuteGainNode.disconnect();
        } catch (_) {}
        this._txMuteGainNode = null;
      }
      if (this._txMediaStream) {
        this._stopMediaStreamTracks(this._txMediaStream);
        this._txMediaStream = null;
      }
      if (this._txOwnsCtx && this._txCtx) {
        try {
          const p = this._txCtx.close();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (_) {}
      }
      this._txCtx = null;
      this._txOwnsCtx = false;
    }

    _resetTxResampler() {
      this._txResampPhase = 0;
      this._txResampPrev = 0;
      this._txResampLastSrcRate = 0;
      this._txLpCoeffs = null;
      this._txLpX1 = 0;
      this._txLpX2 = 0;
      this._txLpY1 = 0;
      this._txLpY2 = 0;
    }

    _pumpSyntheticTxFrame() {
      const buf = this._txSynthBuf;
      const src = this._txSource;

      if (src === 'two-tone') {
        const d1 = (TWO_PI * 700) / TX_SAMPLE_RATE;
        const d2 = (TWO_PI * 1900) / TX_SAMPLE_RATE;
        let p1 = this._txPhase1;
        let p2 = this._txPhase2;
        for (let i = 0; i < TX_FRAME_SAMPLES; i++) {
          buf[i] = 0.45 * Math.sin(p1) + 0.45 * Math.sin(p2);
          p1 += d1;
          if (p1 >= TWO_PI) p1 -= TWO_PI;
          p2 += d2;
          if (p2 >= TWO_PI) p2 -= TWO_PI;
        }
        this._txPhase1 = p1;
        this._txPhase2 = p2;
      } else if (src === 'tone-1k') {
        const d1 = (TWO_PI * 1000) / TX_SAMPLE_RATE;
        let p1 = this._txPhase1;
        for (let i = 0; i < TX_FRAME_SAMPLES; i++) {
          buf[i] = 0.85 * Math.sin(p1);
          p1 += d1;
          if (p1 >= TWO_PI) p1 -= TWO_PI;
        }
        this._txPhase1 = p1;
      } else if (src === 'wav') {
        const wav = this._txWaveBuffer;
        if (!wav || wav.length === 0) {
          buf.fill(0);
        } else {
          const len = wav.length;
          const step = this._txWaveSampleRate / TX_SAMPLE_RATE;
          let pos = this._txWavePhase;
          for (let i = 0; i < TX_FRAME_SAMPLES; i++) {
            const idx0 = Math.floor(pos) % len;
            const idx1 = (idx0 + 1) % len;
            const frac = pos - Math.floor(pos);
            buf[i] = wav[idx0] + frac * (wav[idx1] - wav[idx0]);
            pos += step;
            if (pos >= len) pos %= len;
          }
          this._txWavePhase = pos;
        }
      } else {
        return;
      }

      this._emitTxFrame(buf);
    }

    _processTxInputSamples(inputSamples, srcRate) {
      if (!this._txActive || this._txSource !== 'mic') return;
      if (!inputSamples || inputSamples.length === 0) return;

      const rate = Number.isFinite(srcRate) && srcRate > 0 ? srcRate : DEFAULT_SAMPLE_RATE;
      const len = inputSamples.length;

      if (rate === TX_SAMPLE_RATE) {
        for (let i = 0; i < len; i++) {
          this._pushTxSample12k(softLimitTx(inputSamples[i]));
        }
        return;
      }

      if (rate !== this._txResampLastSrcRate) {
        this._txResampPhase = 0;
        this._txResampPrev = 0;
        this._txResampLastSrcRate = rate;
        this._txLpX1 = 0;
        this._txLpX2 = 0;
        this._txLpY1 = 0;
        this._txLpY2 = 0;
        this._txLpCoeffs = rate > 13000 ? computeButterworthLpCoeffs(rate, 5000) : null;
      }

      let src = inputSamples;
      if (this._txLpCoeffs) {
        if (!this._txFilterScratch || this._txFilterScratch.length < len) {
          this._txFilterScratch = new Float32Array(Math.max(len, 1024));
        }
        const out = this._txFilterScratch;
        const { b0, b1, b2, a1, a2 } = this._txLpCoeffs;
        let x1 = this._txLpX1;
        let x2 = this._txLpX2;
        let y1 = this._txLpY1;
        let y2 = this._txLpY2;
        for (let i = 0; i < len; i++) {
          const raw = inputSamples[i];
          const x = Number.isFinite(raw) ? raw : 0;
          const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
          x2 = x1;
          x1 = x;
          y2 = y1;
          y1 = y;
          out[i] = y;
        }
        this._txLpX1 = x1;
        this._txLpX2 = x2;
        this._txLpY1 = y1;
        this._txLpY2 = y2;
        src = out;
      }

      const ratio = rate / TX_SAMPLE_RATE;
      let t = this._txResampPhase;
      const limit = len - 1;
      const prev = this._txResampPrev;
      while (t < limit) {
        let s;
        if (t < 0) {
          const frac = t + 1;
          s = prev + frac * (src[0] - prev);
        } else {
          const idx = t | 0;
          const frac = t - idx;
          s = src[idx] + frac * (src[idx + 1] - src[idx]);
        }
        this._pushTxSample12k(softLimitTx(s));
        t += ratio;
      }
      this._txResampPhase = t - len;
      this._txResampPrev = src[len - 1];
    }

    _pushTxSample12k(sample) {
      this._txFrameBuf[this._txFrameIdx++] = sample;
      if (this._txFrameIdx >= TX_FRAME_SAMPLES) {
        this._txFrameIdx = 0;
        this._emitTxFrame(this._txFrameBuf);
      }
    }

    _emitTxFrame(samples240) {
      let sumSq = 0;
      let peak = 0;
      const view = this._txPcmView;

      for (let i = 0; i < TX_FRAME_SAMPLES; i++) {
        const v = softLimitTx(samples240[i]);
        const av = v < 0 ? -v : v;
        if (av > peak) peak = av;
        sumSq += v * v;
        const s16 = clampInt(v * TX_S16_SCALE, -32768, 32767);
        const off = i * 4;
        view.setInt16(off, s16, true);
        view.setInt16(off + 2, s16, true);
      }

      const rms = Math.sqrt(sumSq / TX_FRAME_SAMPLES);
      const rawLevel = clamp(rms, 0, 1);
      if (this._txSessionPackets === 0 && rawLevel > 0) {
        this._txInputLevel = rawLevel;
      } else {
        const alpha = rawLevel > this._txInputLevel ? 0.8 : 0.35;
        this._txInputLevel = this._txInputLevel * (1 - alpha) + rawLevel * alpha;
      }

      const seq = this._txSeq & 0xff;
      this._txSeq = (this._txSeq + 1) & 0xff;

      const encodeFn =
        K4.BinaryPackets && typeof K4.BinaryPackets.encodeAudio === 'function'
          ? K4.BinaryPackets.encodeAudio
          : fallbackEncodeAudio;

      const packet = encodeFn({
        seq,
        encodeMode: 1,
        frameSamplesPerCh: TX_FRAME_SAMPLES,
        sampleRateCode: 0,
        audioBytes: this._txPcmBytes,
      });

      this._txSessionPackets += 1;
      this._txPacketsOut += 1;

      if (this._txPacketHandler) {
        const meta = {
          seq,
          encodeMode: 1,
          frameSamplesPerCh: TX_FRAME_SAMPLES,
          sampleRate: TX_SAMPLE_RATE,
          sampleRateCode: 0,
          channels: TX_CHANNELS,
          source: this._txSource,
          inputLevel: this._txInputLevel,
          rms,
          peak,
        };
        try {
          this._txPacketHandler(packet, meta);
        } catch (err) {
          this.emit('error', err);
        }
      }
    }

    _tapDecodedStereo(leftSrc, rightSrc, srcRate) {
      if (!leftSrc || !rightSrc) return;
      const len = Math.min(leftSrc.length, rightSrc.length);
      if (len <= 0) return;
      const stride = Math.max(1, Math.round((srcRate || AF_TAP_SAMPLE_RATE) / AF_TAP_SAMPLE_RATE));

      const opts = this._tapMixOpts;
      opts.gainA = this._gainA;
      opts.gainB = this._gainB;
      opts.subRxEnabled = this._subRxEnabled;
      opts.muted = false; // Scope & recorder capture post-mix AF regardless of local mute
      opts.balance = this._balance;
      opts.mixMode = this._mixMode;

      const mixFn = K4.mixStereoSample;
      const sc = this._tapMixScratch;

      for (let i = 0; i < len; i += stride) {
        const m = leftSrc[i];
        const s = rightSrc[i];
        let outL;
        let outR;
        if (mixFn) {
          mixFn(m, s, opts, sc);
          outL = sc.left;
          outR = sc.right;
        } else {
          outL = m * this._gainA;
          outR = this._subRxEnabled ? s * this._gainB : outL;
        }

        const mono = 0.5 * (outL + outR);
        this._fftRing[this._fftWriteIdx] = mono;
        this._fftWriteIdx = (this._fftWriteIdx + 1) % AF_FFT_SIZE;
        if (this._fftFilled < AF_FFT_SIZE) {
          this._fftFilled += 1;
        }

        if (this._recActive) {
          if (this._recTotalFrames >= AF_TAP_SAMPLE_RATE * MAX_RECORD_SECONDS) {
            this.stopRecording();
          } else {
            if (!this._recCurChunk || this._recCurIdx >= this._recCurChunk.length) {
              if (this._recCurChunk && this._recCurIdx > 0) {
                this._recChunks.push(this._recCurChunk.subarray(0, this._recCurIdx));
              }
              this._recCurChunk = new Int16Array(AF_TAP_SAMPLE_RATE * 2);
              this._recCurIdx = 0;
            }
            const lClamped = clamp(outL, -1, 1);
            const rClamped = clamp(outR, -1, 1);
            this._recCurChunk[this._recCurIdx++] = Math.round(lClamped * 32767);
            this._recCurChunk[this._recCurIdx++] = Math.round(rClamped * 32767);
            this._recTotalFrames += 1;
          }
        }
      }
    }

    /**
     * Compute smoothed 0..maxHz AF passband FFT spectrum in dBFS directly from decoded audio.
     * Works identically in live browser sessions and headless tests when AudioContext is suspended.
     * @param {number} [maxHz=3200]
     * @returns {{ binsDb: Float32Array, binHz: number, sampleRate: number, maxHz: number, hasSignal: boolean }}
     */
    getAfSpectrum(maxHz = 3200) {
      const binHz = AF_TAP_SAMPLE_RATE / AF_FFT_SIZE;
      const numBins = Math.max(4, Math.min(AF_FFT_SIZE >> 1, Math.ceil((maxHz || 3200) / binHz) + 1));

      if (this._fftFilled < 64) {
        return {
          binsDb: this._afBinsDb.subarray(0, numBins),
          binHz,
          sampleRate: AF_TAP_SAMPLE_RATE,
          maxHz: maxHz || 3200,
          hasSignal: false,
        };
      }

      const re = this._fftRe;
      const im = this._fftIm;
      const win = AF_HANN.win;
      const ring = this._fftRing;
      const start = (this._fftWriteIdx - AF_FFT_SIZE + AF_FFT_SIZE) % AF_FFT_SIZE;

      for (let i = 0; i < AF_FFT_SIZE; i++) {
        const idx = AF_BIT_REV[i];
        const sample = ring[(start + i) % AF_FFT_SIZE];
        re[idx] = sample * win[i];
        im[idx] = 0;
      }

      for (let size = 2; size <= AF_FFT_SIZE; size <<= 1) {
        const half = size >> 1;
        const angle = (-2 * Math.PI) / size;
        const wStepRe = Math.cos(angle);
        const wStepIm = Math.sin(angle);
        for (let i = 0; i < AF_FFT_SIZE; i += size) {
          let wRe = 1;
          let wIm = 0;
          for (let j = 0; j < half; j++) {
            const k0 = i + j;
            const k1 = k0 + half;
            const tRe = wRe * re[k1] - wIm * im[k1];
            const tIm = wRe * im[k1] + wIm * re[k1];
            re[k1] = re[k0] - tRe;
            im[k1] = im[k0] - tIm;
            re[k0] += tRe;
            im[k0] += tIm;
            const nextWRe = wRe * wStepRe - wIm * wStepIm;
            wIm = wRe * wStepIm + wIm * wStepRe;
            wRe = nextWRe;
          }
        }
      }

      const norm = 2 / AF_HANN.sum;
      for (let k = 0; k < numBins; k++) {
        const mag = Math.hypot(re[k], im[k]) * norm;
        const db = clamp(20 * Math.log10(Math.max(1e-6, mag)), -110, 0);
        if (!this._afHasComputed) {
          this._afBinsDb[k] = db;
        } else {
          const alpha = db > this._afBinsDb[k] ? 0.65 : 0.25;
          this._afBinsDb[k] = this._afBinsDb[k] * (1 - alpha) + db * alpha;
        }
      }
      this._afHasComputed = true;

      return {
        binsDb: this._afBinsDb.subarray(0, numBins),
        binHz,
        sampleRate: AF_TAP_SAMPLE_RATE,
        maxHz: maxHz || 3200,
        hasSignal: true,
      };
    }

    isRecording() {
      return this._recActive;
    }

    getRecordingStatus() {
      return {
        recording: this._recActive,
        durationSec: this._recTotalFrames / AF_TAP_SAMPLE_RATE,
        sampleRate: AF_TAP_SAMPLE_RATE,
        totalFrames: this._recTotalFrames,
        lastClip: this._lastRecordedClip,
      };
    }

    startRecording(meta = {}) {
      this._recActive = true;
      this._recStartMs = Date.now();
      this._recMeta = meta && typeof meta === 'object' ? Object.assign({}, meta) : {};
      this._recChunks = [];
      this._recCurChunk = new Int16Array(AF_TAP_SAMPLE_RATE * 2);
      this._recCurIdx = 0;
      this._recTotalFrames = 0;
      const status = this.getRecordingStatus();
      this.emit('recording', status);
      return status;
    }

    stopRecording() {
      if (!this._recActive) {
        return this._lastRecordedClip;
      }
      this._recActive = false;
      if (this._recCurChunk && this._recCurIdx > 0) {
        this._recChunks.push(this._recCurChunk.subarray(0, this._recCurIdx));
      }
      this._recCurChunk = null;
      this._recCurIdx = 0;

      const wavBytes = encodeWavPcm16(this._recChunks, this._recTotalFrames, AF_TAP_SAMPLE_RATE, 2);
      this._recChunks = [];
      const durationSec = Math.round((this._recTotalFrames / AF_TAP_SAMPLE_RATE) * 100) / 100;
      const blob =
        typeof globalThis.Blob === 'function'
          ? new globalThis.Blob([wavBytes], { type: 'audio/wav' })
          : null;
      const freqMHz = Number.isFinite(this._recMeta.freqHz)
        ? (this._recMeta.freqHz / 1000000).toFixed(3)
        : 'rx';
      const modeTag = String(this._recMeta.modeLabel || 'k4')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '');
      const filename = `k4-${freqMHz}MHz-${modeTag || 'audio'}.wav`;

      this._lastRecordedClip = {
        wavBytes,
        blob,
        durationSec,
        sampleRate: AF_TAP_SAMPLE_RATE,
        channels: 2,
        totalFrames: this._recTotalFrames,
        filename,
      };
      this.emit('recording', this.getRecordingStatus());
      return this._lastRecordedClip;
    }

    stop() {
      if (this._txActive && !this._txOwnsCtx && this._txCtx === this._ctx) {
        this.stopTxCapture({ silent: true });
      }
      if (this._workletNode) {
        try {
          this._workletNode.port.onmessage = null;
          this._workletNode.disconnect();
        } catch (_) {}
        this._workletNode = null;
      }
      if (this._scriptNode) {
        try {
          this._scriptNode.onaudioprocess = null;
          this._scriptNode.disconnect();
        } catch (_) {}
        this._scriptNode = null;
      }
      if (this._opusDecoder) {
        this._opusDecoder.close();
        this._opusDecoder = null;
      }
      if (this._ctx) {
        try {
          const p = this._ctx.close();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (_) {}
        this._ctx = null;
      }
      this._started = false;
      this._sinkType = 'none';
      this.clearBuffer();
      const diag = this.getDiagnostics();
      this.emit('stopped', diag);
      this.emit('diagnostics', diag);
    }

    destroy() {
      this._destroyed = true;
      this.stopTxCapture({ silent: true });
      this.stop();
      this._txPacketHandler = null;
      this._txWaveBuffer = null;
      if (this._unsubState) {
        try { this._unsubState(); } catch (_) {}
        this._unsubState = null;
      }
    }
  }

  K4.AudioEngine = AudioEngine;
  K4.SL_TARGET_MS = SL_TARGET_MS;
  K4.encodeWavPcm16 = encodeWavPcm16;
})();
