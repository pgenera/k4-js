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
      };
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
      this.stop();
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
