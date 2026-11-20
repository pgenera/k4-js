'use strict';
(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const SL_TARGET_MS = Object.freeze([35, 60, 75, 95, 115, 140, 180, 240]);
  const RING_SECONDS = 2.0;
  const DEFAULT_SAMPLE_RATE = 48000;
  const DRIFT_NUDGE = 0.002;
  const UNDERRUN_FADE_SAMPLES = 16;
  const AF_FFT_SIZE = 1024;
  const AF_FFT_MASK = AF_FFT_SIZE - 1;
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
  // OS MediaSession progress-bar S-meter modulation (S0 = -127 dBm .. S9+40 = -33 dBm).
  // A 10-minute (600 s) virtual track duration ensures 1-pixel movements on external MPRIS
  // progress bars exceed seek thresholds (~1.5 s) while local 1x clock advance between
  // updates stays imperceptible (< 0.1%).
  const MEDIA_SMETER_DURATION_SEC = 600;
  const MEDIA_SMETER_MIN_DBM = -127;
  const MEDIA_SMETER_SPAN_DBM = 94;
  const MEDIA_SMETER_THROTTLE_MS = 100;
  const MEDIA_SMETER_REPIN_MS = 1000;
  const MEDIA_SMETER_MIN_DELTA_SEC = 0.5;

  const VALID_MIX_MODES = new Set([
    'A.B', 'AB.AB', 'A.-A', 'A.AB', 'AB.B', 'AB.A', 'B.AB', 'B.B', 'B.A', 'A.A',
  ]);

  const MODE_LABEL_FALLBACK = Object.freeze({
    1: 'LSB',
    2: 'USB',
    3: 'CW',
    4: 'FM',
    5: 'AM',
    6: 'DATA',
    7: 'CW-R',
    9: 'DATA-R',
  });

  const DATA_SUBMODE_FALLBACK = Object.freeze({
    0: 'DATA-A',
    1: 'AFSK-A',
    2: 'FSK-D',
    3: 'PSK-D',
  });

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

  function buildFftTwiddles(n) {
    const stages = [];
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const wRe = new Float64Array(half);
      const wIm = new Float64Array(half);
      const step = (-2 * Math.PI) / size;
      for (let j = 0; j < half; j++) {
        const angle = step * j;
        wRe[j] = Math.cos(angle);
        wIm[j] = Math.sin(angle);
      }
      stages.push({ size, half, wRe, wIm });
    }
    return stages;
  }

  const AF_BIT_REV = buildBitRevTable(AF_FFT_SIZE);
  const AF_HANN = buildHannWindow(AF_FFT_SIZE);
  const AF_TWIDDLE_STAGES = buildFftTwiddles(AF_FFT_SIZE);

  function getMediaSession() {
    const nav = typeof navigator !== 'undefined' ? navigator : globalThis.navigator;
    if (nav && 'mediaSession' in nav && nav.mediaSession) {
      return nav.mediaSession;
    }
    return null;
  }

  function sMeterDbmToMediaPosition(dBm) {
    if (typeof dBm !== 'number' || !Number.isFinite(dBm)) return 0;
    const frac = clamp((dBm - MEDIA_SMETER_MIN_DBM) / MEDIA_SMETER_SPAN_DBM, 0, 1);
    return Math.round(frac * MEDIA_SMETER_DURATION_SEC * 10) / 10;
  }

  function resolveFreqDisplay(val) {
    if (val === null || val === undefined) return '';
    if (typeof val === 'object') {
      return resolveFreqDisplay(val.freqHz);
    }
    if (typeof val === 'number' && Number.isFinite(val)) {
      return K4.formatFreqMHz(val) + ' MHz';
    }
    if (typeof val === 'string') {
      const s = val.trim();
      if (!s) return '';
      if (/^\d+$/.test(s)) {
        const n = Number(s);
        if (Number.isFinite(n)) return K4.formatFreqMHz(n) + ' MHz';
      }
      return s.endsWith('MHz') || s.endsWith('kHz') ? s : s + ' MHz';
    }
    return '';
  }

  function resolveModeDisplay(modeVal, rxObj) {
    if (modeVal !== undefined && modeVal !== null && modeVal !== '') {
      if (typeof modeVal === 'string') return modeVal.trim();
      if (typeof modeVal === 'number') {
        if ((modeVal === 6 || modeVal === 9) && rxObj && rxObj.dataSubMode !== undefined) {
          const subMap = K4.DATA_SUBMODES || DATA_SUBMODE_FALLBACK;
          const subLabel = subMap[rxObj.dataSubMode] || 'DATA-A';
          return modeVal === 9 ? `${subLabel} R` : subLabel;
        }
        const mInfo = K4.MODES && K4.MODES[modeVal];
        return (mInfo && (mInfo.label || mInfo.key)) || MODE_LABEL_FALLBACK[modeVal] || '';
      }
    }
    if (rxObj && typeof rxObj === 'object') {
      if (typeof rxObj.modeLabel === 'string' && rxObj.modeLabel.trim()) {
        return rxObj.modeLabel.trim();
      }
      if (typeof rxObj.mode === 'number' || typeof rxObj.mode === 'string') {
        return resolveModeDisplay(rxObj.mode, rxObj);
      }
    }
    return '';
  }

  function resolveBandDisplay(freqHzOrObj, rxObj) {
    if (rxObj && rxObj.band && (rxObj.band.label || rxObj.band.id)) {
      return rxObj.band.label || rxObj.band.id;
    }
    const hz = typeof freqHzOrObj === 'number'
      ? freqHzOrObj
      : (rxObj && typeof rxObj.freqHz === 'number' ? rxObj.freqHz : NaN);
    if (Number.isFinite(hz) && Array.isArray(K4.BANDS)) {
      for (let i = 0; i < K4.BANDS.length; i++) {
        const b = K4.BANDS[i];
        if (hz >= b.startHz && hz <= b.endHz) {
          return b.label || b.id || '';
        }
      }
    }
    return '';
  }

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
      this._onMuteChange = typeof opts.onMuteChange === 'function' ? opts.onMuteChange : null;
      this._onMediaAction = typeof opts.onMediaAction === 'function' ? opts.onMediaAction : null;

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
      this._lastRttMs = null;
      this._lastStateRttMs = null;
      this._unsubState = null;

      // OS MediaSession & silent <audio> keep-alive state
      this._keepAliveAudio = null;
      this._keepAliveBlobUrl = null;
      this._mediaMetaKey = '';
      this._mediaHandlersRegistered = false;
      this._lastMetaFreqA = null;
      this._lastMetaModeA = null;
      this._lastMetaDataA = null;
      this._lastMetaFreqB = null;
      this._lastMetaModeB = null;
      this._lastMetaDataB = null;
      this._lastMetaSubRx = null;
      this._lastMetaRadioId = null;
      this._mediaSmeterEnabled = opts.mediaSmeterEnabled !== undefined ? Boolean(opts.mediaSmeterEnabled) : true;
      this._mediaSmeterTargetRx = opts.targetRx === 'B' ? 'B' : 'A';
      this._mediaSmeterLastDbm = null;
      this._mediaSmeterLastPos = null;
      this._mediaSmeterLastSentMs = 0;
      this._mediaSmeterRepinTimer = null;
      this._mediaSmeterTrailingTimer = null;

      // Performance telemetry counters
      this._perf = {
        afFftRuns: 0,
        afFftSkips: 0,
        mediaMetaUpdates: 0,
        mediaMetaSkips: 0,
        mediaPosUpdates: 0,
        mediaPosSkips: 0,
      };

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
      this._workletMsgScratch = { type: 'audio', main: null, sub: null };
      this._workletTransferScratch = [null, null];

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
      this._afWriteGen = 0;
      this._lastAfGen = -1;
      this._lastAfMaxHz = 0;
      this._lastAfResult = null;
      this._tapMixWeights = new Float64Array(4);
      this._tapMixOpts = {
        gainA: 1,
        gainB: 1,
        subRxEnabled: false,
        muted: false,
        balance: 0,
        mixMode: 'A.B',
      };
      this._tapMixScratch = { left: 0, right: 0 };
      this._pcmDecodeScratch = { left: new Float32Array(512), right: new Float32Array(512) };

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

      this._standbyMicStream = null;
      this._standbyMicKey = '';
      this._micState = 'idle'; // 'idle'|'requesting'|'ready'|'capturing'|'denied'|'unavailable'|'insecure'|'error'
      this._micDeviceLabel = '';
      this._micError = null;
      this._micReqGen = 0;
      this._micOpenPromise = null;
    }

    get ctx() {
      return this._ctx;
    }

    get running() {
      return this._started;
    }

    get muted() {
      return this._muted;
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

      if (snap.connection) {
        if (snap.connection.status) {
          this._lastConnStatus = snap.connection.status;
        }
        if (
          typeof snap.connection.rttMs === 'number' &&
          Number.isFinite(snap.connection.rttMs) &&
          snap.connection.rttMs >= 0
        ) {
          this._lastStateRttMs = snap.connection.rttMs;
          this._lastRttMs = snap.connection.rttMs;
        }
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

      const conn = snap.connection;
      const connStatus = conn && conn.status;
      if (connStatus && connStatus !== this._lastConnStatus) {
        this._lastConnStatus = connStatus;
        if (connStatus === 'disconnected' || connStatus === 'connecting') {
          this._expectedSeq = null;
        }
      }

      if (conn) {
        const nextRtt = typeof conn.rttMs === 'number' && Number.isFinite(conn.rttMs) && conn.rttMs >= 0
          ? conn.rttMs
          : null;
        if (nextRtt !== this._lastStateRttMs) {
          this._lastStateRttMs = nextRtt;
          this._lastRttMs = nextRtt;
        }
      }

      if (this._started && getMediaSession()) {
        const rxA = snap.rxA;
        const rxB = snap.rxB;
        const fA = rxA ? rxA.freqHz : 0;
        const mA = rxA ? rxA.mode : 0;
        const dA = rxA ? rxA.dataSubMode : 0;
        const fB = rxB ? rxB.freqHz : 0;
        const mB = rxB ? rxB.mode : 0;
        const dB = rxB ? rxB.dataSubMode : 0;
        const rid = conn ? conn.radioId : '';
        if (
          fA !== this._lastMetaFreqA ||
          mA !== this._lastMetaModeA ||
          dA !== this._lastMetaDataA ||
          fB !== this._lastMetaFreqB ||
          mB !== this._lastMetaModeB ||
          dB !== this._lastMetaDataB ||
          subOn !== this._lastMetaSubRx ||
          rid !== this._lastMetaRadioId
        ) {
          this._lastMetaFreqA = fA;
          this._lastMetaModeA = mA;
          this._lastMetaDataA = dA;
          this._lastMetaFreqB = fB;
          this._lastMetaModeB = mB;
          this._lastMetaDataB = dB;
          this._lastMetaSubRx = subOn;
          this._lastMetaRadioId = rid;
          this.updateMediaMetadata(snap);
        }
        if (this._mediaSmeterEnabled && !this._muted) {
          const activeDbm = this._resolveActiveSmeterDbm(snap);
          if (activeDbm !== null && (activeDbm !== this._mediaSmeterLastDbm || this._mediaSmeterLastPos === null)) {
            this.updateMediaSmeter(snap, false);
          }
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
        this._setupMediaSession();
        return Promise.resolve({ started: true, sinkType: this._sinkType });
      }
      if (this._startingPromise) return this._startingPromise;

      this._startingPromise = this._startInternal().finally(() => {
        this._startingPromise = null;
      });
      return this._startingPromise;
    }

    async _startInternal() {
      if (this._destroyed) {
        return { started: false, sinkType: 'none' };
      }
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
          if (this._destroyed || this._ctx !== ctx) {
            try {
              const p = ctx.close();
              if (p && typeof p.catch === 'function') p.catch(() => {});
            } catch (_) {}
            return { started: false, sinkType: 'none' };
          }
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

      if (this._destroyed || this._ctx !== ctx) {
        return { started: false, sinkType: 'none' };
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
      this._setupMediaSession();
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

    _createSilentKeepAliveWavUrl() {
      if (
        typeof globalThis.Blob !== 'function' ||
        typeof globalThis.URL === 'undefined' ||
        typeof globalThis.URL.createObjectURL !== 'function'
      ) {
        return null;
      }
      try {
        const wavBytes = encodeWavPcm16([], 8000, 8000, 1);
        const blob = new globalThis.Blob([wavBytes], { type: 'audio/wav' });
        return globalThis.URL.createObjectURL(blob);
      } catch (_) {
        return null;
      }
    }

    _ensureKeepAliveAudio() {
      if (this._keepAliveAudio) return this._keepAliveAudio;
      if (typeof document === 'undefined' || !document || typeof document.createElement !== 'function') {
        return null;
      }
      const url = this._createSilentKeepAliveWavUrl();
      if (!url) return null;
      try {
        const audioEl = document.createElement('audio');
        if (!audioEl) {
          try { globalThis.URL.revokeObjectURL(url); } catch (_) {}
          return null;
        }
        audioEl.loop = true;
        audioEl.volume = 1.0;
        audioEl.muted = false;
        audioEl.preload = 'auto';
        audioEl.hidden = true;
        if (audioEl.style) audioEl.style.display = 'none';
        if (typeof audioEl.setAttribute === 'function') {
          audioEl.setAttribute('aria-hidden', 'true');
          audioEl.setAttribute('data-k4-media-keepalive', 'true');
        }
        audioEl.src = url;
        if (document.body && typeof document.body.appendChild === 'function') {
          document.body.appendChild(audioEl);
        }
        this._keepAliveBlobUrl = url;
        this._keepAliveAudio = audioEl;
        return audioEl;
      } catch (_) {
        try { globalThis.URL.revokeObjectURL(url); } catch (_) {}
        return null;
      }
    }

    _setupMediaSession() {
      this._ensureKeepAliveAudio();
      const ms = getMediaSession();
      if (ms && !this._mediaHandlersRegistered && typeof ms.setActionHandler === 'function') {
        const setHandler = (action, fn) => {
          try {
            ms.setActionHandler(action, fn);
          } catch (_) {}
        };
        setHandler('play', () => this._handleMediaSessionAction('play'));
        setHandler('pause', () => this._handleMediaSessionAction('pause'));
        setHandler('stop', () => this._handleMediaSessionAction('stop'));
        this._mediaHandlersRegistered = true;
      }
      if (this.state) {
        this.updateMediaMetadata(this._readSnapshot(this.state));
      }
      this._syncMediaSessionPlayback();
    }

    _teardownMediaSession() {
      this._clearMediaPositionState();
      this._mediaSmeterLastDbm = null;
      if (this._keepAliveAudio) {
        const el = this._keepAliveAudio;
        this._keepAliveAudio = null;
        try {
          if (typeof el.pause === 'function') {
            el.pause();
          }
          if (typeof el.removeAttribute === 'function') {
            el.removeAttribute('src');
          }
          if (el.parentNode && typeof el.parentNode.removeChild === 'function') {
            el.parentNode.removeChild(el);
          }
        } catch (_) {}
      }
      if (this._keepAliveBlobUrl) {
        const url = this._keepAliveBlobUrl;
        this._keepAliveBlobUrl = null;
        try {
          if (typeof globalThis.URL !== 'undefined' && typeof globalThis.URL.revokeObjectURL === 'function') {
            globalThis.URL.revokeObjectURL(url);
          }
        } catch (_) {}
      }
      const ms = getMediaSession();
      if (ms) {
        if (this._mediaHandlersRegistered && typeof ms.setActionHandler === 'function') {
          const actions = ['play', 'pause', 'stop'];
          for (let i = 0; i < actions.length; i++) {
            try {
              ms.setActionHandler(actions[i], null);
            } catch (_) {}
          }
        }
        try {
          ms.playbackState = 'none';
          ms.metadata = null;
        } catch (_) {}
      }
      this._mediaHandlersRegistered = false;
      this._mediaMetaKey = '';
      this._lastMetaFreqA = null;
      this._lastMetaModeA = null;
      this._lastMetaDataA = null;
      this._lastMetaFreqB = null;
      this._lastMetaModeB = null;
      this._lastMetaDataB = null;
      this._lastMetaSubRx = null;
      this._lastMetaRadioId = null;
    }

    _syncMediaSessionPlayback() {
      const ms = getMediaSession();
      if (!this._started) {
        this._clearMediaPositionState();
        if (this._keepAliveAudio && typeof this._keepAliveAudio.pause === 'function') {
          try { this._keepAliveAudio.pause(); } catch (_) {}
        }
        if (ms) {
          try { ms.playbackState = 'none'; } catch (_) {}
        }
        return;
      }
      if (this._muted) {
        this._stopMediaSmeterTimers();
        if (this._keepAliveAudio && typeof this._keepAliveAudio.pause === 'function') {
          try { this._keepAliveAudio.pause(); } catch (_) {}
        }
        if (ms) {
          try { ms.playbackState = 'paused'; } catch (_) {}
        }
      } else {
        if (this._keepAliveAudio && typeof this._keepAliveAudio.play === 'function') {
          try {
            const p = this._keepAliveAudio.play();
            if (p && typeof p.then === 'function') {
              p.then(() => {
                if (this._started && !this._muted && !this._destroyed && this._mediaSmeterEnabled) {
                  this.updateMediaSmeter(null, true);
                }
              }).catch(() => {});
            } else if (p && typeof p.catch === 'function') {
              p.catch(() => {});
            }
          } catch (_) {}
        }
        if (ms) {
          try { ms.playbackState = 'playing'; } catch (_) {}
        }
        if (this._mediaSmeterEnabled) {
          this.updateMediaSmeter(null, true);
          this._syncMediaSmeterTimer();
        } else {
          this._stopMediaSmeterTimers();
        }
      }
    }

    _emitMediaAction(action, muted) {
      const payload = {
        action,
        muted: Boolean(muted),
        diagnostics: this.getDiagnostics(),
      };
      if (this._onMediaAction) {
        try { this._onMediaAction(payload); } catch (_) {}
      }
      this.emit('mediaAction', payload);
    }

    _handleMediaSessionAction(action) {
      if (this._destroyed) return;
      if (action === 'pause') {
        this.setMuted(true);
        this._emitMediaAction('pause', this._muted);
      } else if (action === 'play') {
        if (!this._started) {
          this.start().then((res) => {
            if (res && res.started) {
              this.setMuted(false);
              this._emitMediaAction('play', this._muted);
            }
          }).catch(() => {});
          return;
        }
        if (this._ctx && this._ctx.state === 'suspended' && typeof this._ctx.resume === 'function') {
          try {
            const p = this._ctx.resume();
            if (p && typeof p.catch === 'function') p.catch(() => {});
          } catch (_) {}
        }
        if (this._muted) {
          this.setMuted(false);
        } else {
          this._syncMediaSessionPlayback();
        }
        this._emitMediaAction('play', this._muted);
      } else if (action === 'stop') {
        this.setMuted(true);
        this.stop();
        this._emitMediaAction('stop', true);
      }
    }

    /**
     * Update OS MediaSession metadata from a RadioState snapshot or { vfoA, vfoB, modeA, modeB, subRx }.
     * Dirty-checked: assigns MediaMetadata only when the formatted metadata key changes.
     * @param {Object} [info]
     * @returns {boolean} True when metadata changed and was updated.
     */
    updateMediaMetadata(info) {
      const ms = getMediaSession();
      if (!ms || typeof globalThis.MediaMetadata !== 'function') return false;

      const src = info || (this.state ? this._readSnapshot(this.state) : null);
      if (!src || typeof src !== 'object') return false;

      const rxA = src.rxA && typeof src.rxA === 'object' ? src.rxA : null;
      const rxB = src.rxB && typeof src.rxB === 'object' ? src.rxB : null;
      const subRx = src.subRx !== undefined ? Boolean(src.subRx) : Boolean(src.subRxEnabled);

      const freqA = resolveFreqDisplay(src.vfoA !== undefined ? src.vfoA : (rxA ? rxA.freqHz : null));
      const modeA = resolveModeDisplay(src.modeA, rxA);
      const freqB = subRx ? resolveFreqDisplay(src.vfoB !== undefined ? src.vfoB : (rxB ? rxB.freqHz : null)) : '';
      const modeB = subRx ? resolveModeDisplay(src.modeB, rxB) : '';

      const partA = [freqA, modeA].filter(Boolean).join(' ');
      const partB = subRx ? [freqB, modeB].filter(Boolean).join(' ') : '';
      const title = partB
        ? (partA ? `A ${partA} · B ${partB}` : `B ${partB}`)
        : (partA || 'Elecraft K4 Receiver');

      const artist = 'Elecraft K4';
      const bandLabel = resolveBandDisplay(src.vfoA, rxA);
      const radioId = (src.connection && src.connection.radioId) || src.radioId || '';
      const albumParts = [];
      if (radioId) albumParts.push(String(radioId));
      albumParts.push(subRx ? 'Main + Sub RX' : 'Main RX');
      if (bandLabel) albumParts.push(bandLabel);
      const album = albumParts.join(' · ');

      const key = `${title}|${artist}|${album}`;
      if (key === this._mediaMetaKey) {
        this._perf.mediaMetaSkips += 1;
        return false;
      }
      this._mediaMetaKey = key;
      this._perf.mediaMetaUpdates += 1;

      try {
        ms.metadata = new globalThis.MediaMetadata({ title, artist, album });
      } catch (_) {}
      return true;
    }

    _resolveActiveSmeterDbm(src) {
      if (typeof src === 'number' && Number.isFinite(src)) return src;
      if (!src || typeof src !== 'object') return null;
      if (typeof src.sMeterDbm === 'number' && Number.isFinite(src.sMeterDbm)) {
        return src.sMeterDbm;
      }
      const subOn = src.subRx !== undefined ? Boolean(src.subRx) : Boolean(src.subRxEnabled);
      if (
        this._mediaSmeterTargetRx === 'B' &&
        subOn &&
        src.rxB &&
        typeof src.rxB.sMeterDbm === 'number' &&
        Number.isFinite(src.rxB.sMeterDbm)
      ) {
        return src.rxB.sMeterDbm;
      }
      if (src.rxA && typeof src.rxA.sMeterDbm === 'number' && Number.isFinite(src.rxA.sMeterDbm)) {
        return src.rxA.sMeterDbm;
      }
      return null;
    }

    _stopMediaSmeterTimers() {
      if (this._mediaSmeterRepinTimer) {
        clearInterval(this._mediaSmeterRepinTimer);
        this._mediaSmeterRepinTimer = null;
      }
      if (this._mediaSmeterTrailingTimer) {
        clearTimeout(this._mediaSmeterTrailingTimer);
        this._mediaSmeterTrailingTimer = null;
      }
    }

    _syncMediaSmeterTimer() {
      const ms = getMediaSession();
      const shouldRun = Boolean(
        this._started &&
        !this._muted &&
        !this._destroyed &&
        this._mediaSmeterEnabled &&
        ms &&
        typeof ms.setPositionState === 'function'
      );
      if (!shouldRun) {
        this._stopMediaSmeterTimers();
        return;
      }
      if (!this._mediaSmeterRepinTimer) {
        this._mediaSmeterRepinTimer = setInterval(() => {
          this.updateMediaSmeter(null, false);
        }, MEDIA_SMETER_REPIN_MS);
      }
    }

    _clearMediaPositionState() {
      this._stopMediaSmeterTimers();
      this._mediaSmeterLastPos = null;
      this._mediaSmeterLastSentMs = 0;
      const ms = getMediaSession();
      if (ms && typeof ms.setPositionState === 'function') {
        try {
          ms.setPositionState();
        } catch (_) {
          try {
            ms.setPositionState(null);
          } catch (__) {}
        }
      }
    }

    /**
     * Enable or disable modulating OS MediaSession position state as an RF S-meter.
     * @param {boolean} enabled
     */
    setMediaSmeterEnabled(enabled) {
      const next = Boolean(enabled);
      if (this._mediaSmeterEnabled === next) return;
      this._mediaSmeterEnabled = next;
      if (!next) {
        this._clearMediaPositionState();
      } else if (this._started && !this._muted && !this._destroyed) {
        this.updateMediaSmeter(null, true);
        this._syncMediaSmeterTimer();
      }
    }

    isMediaSmeterEnabled() {
      return this._mediaSmeterEnabled;
    }

    /**
     * Select which VFO ('A' or 'B') drives the MediaSession S-meter (falls back to A when Sub-RX is off).
     * @param {'A'|'B'} rx
     */
    setMediaSmeterTargetRx(rx) {
      const next = rx === 'B' ? 'B' : 'A';
      if (this._mediaSmeterTargetRx === next) return;
      this._mediaSmeterTargetRx = next;
      if (this._started && !this._muted && !this._destroyed && this._mediaSmeterEnabled) {
        this.updateMediaSmeter(null, true);
      }
    }

    /**
     * Modulate OS MediaSession position state (0..600 s) from the active VFO S-meter (S0..S9+40 dB).
     * Throttled to 10 Hz with trailing flush and 1 s drift re-pinning against 1x playbackRate advance.
     * @param {Object|number|null} [info]
     * @param {boolean} [force=false]
     * @returns {boolean} True when setPositionState was invoked.
     */
    updateMediaSmeter(info, force = false) {
      if (!this._mediaSmeterEnabled || !this._started || this._muted || this._destroyed) {
        return false;
      }
      const ms = getMediaSession();
      if (!ms || typeof ms.setPositionState !== 'function') return false;

      const src = info !== undefined && info !== null
        ? info
        : (this.state ? this._readSnapshot(this.state) : null);
      let dBm = this._resolveActiveSmeterDbm(src);
      if (dBm === null) {
        if (this._mediaSmeterLastDbm !== null) {
          dBm = this._mediaSmeterLastDbm;
        } else {
          return false;
        }
      }
      this._mediaSmeterLastDbm = dBm;

      const pos = sMeterDbmToMediaPosition(dBm);
      const now = nowMs();
      const elapsed = this._mediaSmeterLastPos === null ? Infinity : (now - this._mediaSmeterLastSentMs);
      const delta = this._mediaSmeterLastPos === null ? Infinity : Math.abs(pos - this._mediaSmeterLastPos);

      if (!force) {
        if (elapsed < MEDIA_SMETER_THROTTLE_MS) {
          this._perf.mediaPosSkips += 1;
          if (delta >= MEDIA_SMETER_MIN_DELTA_SEC && !this._mediaSmeterTrailingTimer) {
            const delay = Math.max(1, Math.ceil(MEDIA_SMETER_THROTTLE_MS - elapsed));
            this._mediaSmeterTrailingTimer = setTimeout(() => {
              this._mediaSmeterTrailingTimer = null;
              this.updateMediaSmeter(null, false);
            }, delay);
          }
          return false;
        }
        if (delta < MEDIA_SMETER_MIN_DELTA_SEC && elapsed < MEDIA_SMETER_REPIN_MS) {
          this._perf.mediaPosSkips += 1;
          return false;
        }
      }

      if (this._mediaSmeterTrailingTimer) {
        clearTimeout(this._mediaSmeterTrailingTimer);
        this._mediaSmeterTrailingTimer = null;
      }

      try {
        ms.setPositionState({
          duration: MEDIA_SMETER_DURATION_SEC,
          playbackRate: 1,
          position: pos,
        });
      } catch (_) {
        return false;
      }

      this._mediaSmeterLastPos = pos;
      this._mediaSmeterLastSentMs = now;
      this._perf.mediaPosUpdates += 1;
      return true;
    }

    setMuted(muted) {
      const next = Boolean(muted);
      if (this._muted === next) return;
      this._muted = next;
      if (!next && this._started && this._ctx && this._ctx.state === 'suspended' && typeof this._ctx.resume === 'function') {
        try {
          const p = this._ctx.resume();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (_) {}
      }
      this._syncWorkletConfig();
      this._syncMediaSessionPlayback();
      const diag = this.getDiagnostics();
      if (this._onMuteChange) {
        try { this._onMuteChange(next, diag); } catch (_) {}
      }
      this.emit('mute', next, diag);
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
        const decoded = K4.PcmDecoder.decodeInto
          ? K4.PcmDecoder.decodeInto(audioPkt, this._pcmDecodeScratch)
          : K4.PcmDecoder.decode(audioPkt);
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
          const msg = this._workletMsgScratch;
          msg.main = main;
          msg.sub = sub;
          const xfer = this._workletTransferScratch;
          xfer[0] = main.buffer;
          xfer[1] = sub.buffer;
          this._workletNode.port.postMessage(msg, xfer);
          msg.main = null;
          msg.sub = null;
          xfer[0] = null;
          xfer[1] = null;
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

    /**
     * Store latest measured WebSocket RTT (ms) for end-to-end latency breakdown calculations.
     * @param {number|null} rttMs
     * @returns {number|null}
     */
    updateNetworkRtt(rttMs) {
      if (rttMs === null || rttMs === undefined || rttMs === '') {
        this._lastRttMs = null;
      } else {
        const n = Number(rttMs);
        this._lastRttMs = Number.isFinite(n) && n >= 0 ? n : null;
      }
      return this._lastRttMs;
    }

    /**
     * Compute end-to-end RX and TX latency breakdown from network RTT, jitter buffer, and WebAudio latencies.
     * @param {number|null} [rttMs=this._lastRttMs]
     * @returns {Object}
     */
    getLatencyBreakdown(rttMs = this._lastRttMs) {
      const hasRtt =
        rttMs !== null &&
        rttMs !== undefined &&
        rttMs !== '' &&
        Number.isFinite(Number(rttMs)) &&
        Number(rttMs) >= 0;
      const validRtt = hasRtt ? Number(rttMs) : null;
      const bufferMs = this.getBufferMs();
      const ctx = this._ctx;
      const baseLatencySec = ctx && Number.isFinite(ctx.baseLatency) ? Math.max(0, ctx.baseLatency) : 0;
      const outputLatencySec = ctx && Number.isFinite(ctx.outputLatency) ? Math.max(0, ctx.outputLatency) : 0;
      const txCtx = this._txCtx || ctx;
      const txBaseLatencySec = txCtx && Number.isFinite(txCtx.baseLatency) ? Math.max(0, txCtx.baseLatency) : 0;

      const rxNetHalfRttMs = validRtt !== null ? Math.round(validRtt / 2) : null;
      const rxFrameMs = TX_CHUNK_MS; // 20 ms server audio packetization frame
      const rxJitterMs = Math.round(bufferMs);
      const rxAudioOutMs = Math.round((baseLatencySec + outputLatencySec) * 1000);
      const localPipelineMs = Math.round(rxFrameMs + bufferMs + rxAudioOutMs);
      const isRxRunning = Boolean(this._started && !this._muted);
      const e2eRxMs = isRxRunning && validRtt !== null
        ? Math.round(validRtt / 2 + rxFrameMs + bufferMs + rxAudioOutMs)
        : null;
      const e2eTxMs = validRtt !== null
        ? Math.round(validRtt / 2 + TX_CHUNK_MS + txBaseLatencySec * 1000)
        : null;

      return {
        rttMs: validRtt,
        rxNetHalfRttMs,
        rxFrameMs,
        rxJitterMs,
        rxAudioOutMs,
        localPipelineMs,
        e2eRxMs,
        e2eTxMs,
        txChunkMs: TX_CHUNK_MS,
        baseLatency: baseLatencySec,
        outputLatency: outputLatencySec,
        baseLatencyMs: Math.round(baseLatencySec * 1000),
        outputLatencyMs: Math.round(outputLatencySec * 1000),
      };
    }

    getDiagnostics() {
      const latency = this.getLatencyBreakdown();
      return {
        started: this._started,
        running: this._started,
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
        micState: this._micState,
        micDeviceLabel: this._micDeviceLabel,
        micError: this._micError,
        rttMs: latency.rttMs,
        txChunkMs: latency.txChunkMs,
        baseLatency: latency.baseLatency,
        outputLatency: latency.outputLatency,
        baseLatencyMs: latency.baseLatencyMs,
        outputLatencyMs: latency.outputLatencyMs,
        rxNetHalfRttMs: latency.rxNetHalfRttMs,
        rxFrameMs: latency.rxFrameMs,
        rxJitterMs: latency.rxJitterMs,
        rxAudioOutMs: latency.rxAudioOutMs,
        localPipelineMs: latency.localPipelineMs,
        e2eRxMs: latency.e2eRxMs,
        e2eTxMs: latency.e2eTxMs,
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

    _isStandbyMicLive() {
      const s = this._standbyMicStream;
      if (!s || typeof s.getAudioTracks !== 'function') return false;
      try {
        const tracks = s.getAudioTracks();
        return tracks.some((t) => t && t.readyState === 'live');
      } catch (_) {
        return false;
      }
    }

    getMicStatus() {
      return {
        state: this._micState,
        deviceLabel: this._micDeviceLabel,
        error: this._micError,
        secureContext: this.isMicSecureContextAvailable(),
        activeStream: this._isStandbyMicLive(),
      };
    }

    async ensureMicReady({ deviceId = '', voiceProcessing = false } = {}) {
      if (this._destroyed) {
        return this.getMicStatus();
      }
      const devId = typeof deviceId === 'string' ? deviceId.trim() : '';
      const vp = Boolean(voiceProcessing);
      const key = `${devId || 'default'}:${vp}`;

      if (!Boolean(globalThis.isSecureContext)) {
        this._micState = 'insecure';
        this._micError = 'Requires http://localhost or https:// secure context';
        const st = this.getMicStatus();
        this.emit('micStatus', st);
        this.emit('diagnostics', this.getDiagnostics());
        return st;
      }
      const md = globalThis.navigator && globalThis.navigator.mediaDevices;
      if (!md || typeof md.getUserMedia !== 'function') {
        this._micState = 'unavailable';
        this._micError = 'Browser navigator.mediaDevices.getUserMedia unavailable';
        const st = this.getMicStatus();
        this.emit('micStatus', st);
        this.emit('diagnostics', this.getDiagnostics());
        return st;
      }

      if (this._isStandbyMicLive() && this._standbyMicKey === key) {
        this._micState = this._txActive && this._txSource === 'mic' ? 'capturing' : 'ready';
        this._micError = null;
        return this.getMicStatus();
      }

      if (this._micOpenPromise && this._standbyMicKey === key) {
        return this._micOpenPromise;
      }

      if (this._standbyMicStream) {
        this._stopMediaStreamTracks(this._standbyMicStream);
        this._standbyMicStream = null;
      }
      this._standbyMicKey = key;
      this._micError = null;
      this._micState = 'requesting';
      const reqGen = ++this._micReqGen;
      this.emit('micStatus', this.getMicStatus());

      const audioConstraints = {
        echoCancellation: vp,
        noiseSuppression: vp,
        autoGainControl: vp,
      };
      if (devId) {
        audioConstraints.deviceId = devId;
      }

      const promise = (async () => {
        try {
          const stream = await md.getUserMedia({ audio: audioConstraints, video: false });
          if (reqGen !== this._micReqGen || this._destroyed) {
            this._stopMediaStreamTracks(stream);
            return this.getMicStatus();
          }
          this._standbyMicStream = stream;
          const tracks = typeof stream.getAudioTracks === 'function' ? stream.getAudioTracks() : [];
          const primary = tracks[0] || null;
          this._micDeviceLabel =
            primary && typeof primary.label === 'string' && primary.label.trim()
              ? primary.label.trim()
              : 'Microphone';
          if (primary && typeof primary.addEventListener === 'function') {
            primary.addEventListener('ended', () => {
              if (this._standbyMicStream !== stream) return;
              this._standbyMicStream = null;
              this._standbyMicKey = '';
              this._micState = 'idle';
              this._micDeviceLabel = '';
              this.emit('micStatus', this.getMicStatus());
              this.emit('diagnostics', this.getDiagnostics());
            });
          }
          this._micState = this._txActive && this._txSource === 'mic' ? 'capturing' : 'ready';
          this._micError = null;
          const st = this.getMicStatus();
          this.emit('micStatus', st);
          this.emit('diagnostics', this.getDiagnostics());
          return st;
        } catch (err) {
          if (reqGen !== this._micReqGen || this._destroyed) {
            return this.getMicStatus();
          }
          const errName = err && err.name ? String(err.name) : '';
          if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
            this._micState = 'denied';
          } else if (errName === 'NotFoundError' || errName === 'DevicesNotFoundError') {
            this._micState = 'unavailable';
          } else {
            this._micState = 'error';
          }
          this._micError = err && err.message ? err.message : String(err);
          const st = this.getMicStatus();
          this.emit('micStatus', st);
          this.emit('diagnostics', this.getDiagnostics());
          return st;
        } finally {
          if (this._micOpenPromise === promise) {
            this._micOpenPromise = null;
          }
        }
      })();

      this._micOpenPromise = promise;
      return promise;
    }

    releaseMicStandby() {
      this._micReqGen += 1;
      this._micOpenPromise = null;
      if (this._standbyMicStream) {
        const s = this._standbyMicStream;
        this._standbyMicStream = null;
        if (this._txMediaStream !== s) {
          this._stopMediaStreamTracks(s);
        }
      }
      this._standbyMicKey = '';
      this._micState = 'idle';
      this._micDeviceLabel = '';
      this._micError = null;
      const st = this.getMicStatus();
      this.emit('micStatus', st);
      this.emit('diagnostics', this.getDiagnostics());
      return st;
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
        this._micState = Boolean(globalThis.isSecureContext) ? 'unavailable' : 'insecure';
        this.emit('micStatus', this.getMicStatus());
        this.emit('diagnostics', this.getDiagnostics());
        throw new Error(
          'Microphone capture requires a Secure Context (http://localhost or https://) and navigator.mediaDevices.getUserMedia.'
        );
      }

      const status = await this.ensureMicReady({ deviceId, voiceProcessing });
      const stream = this._standbyMicStream;
      if (!stream) {
        throw new Error(status.error || 'Microphone access unavailable or denied.');
      }
      if (gen !== this._txSessionGen || this._destroyed) {
        return { active: false, source: 'mic', sampleRate: TX_SAMPLE_RATE, frameSamplesPerCh: TX_FRAME_SAMPLES };
      }

      const reuseRxCtx = Boolean(this._ctx && this._ctx.state !== 'closed');
      const ctx = reuseRxCtx ? this._ctx : this._createAudioContext();
      if (!ctx) {
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

      this._micState = 'capturing';
      this.emit('micStatus', this.getMicStatus());
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
      this._micState = this._isStandbyMicLive()
        ? 'ready'
        : this._micState === 'capturing'
        ? 'idle'
        : this._micState;

      if (!opts || !opts.silent) {
        this.emit('micStatus', this.getMicStatus());
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
        if (this._txMediaStream !== this._standbyMicStream) {
          this._stopMediaStreamTracks(this._txMediaStream);
        }
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

      const weights = this._tapMixWeights;
      K4.computeLinearMixWeights(
        this._gainA,
        this._gainB,
        this._subRxEnabled,
        this._balance,
        this._mixMode,
        weights
      );
      const wLA = weights[0];
      const wLB = weights[1];
      const wRA = weights[2];
      const wRB = weights[3];

      const fftRing = this._fftRing;
      let writeIdx = this._fftWriteIdx;
      let filled = this._fftFilled;
      const recActive = this._recActive;

      for (let i = 0; i < len; i += stride) {
        const rawM = leftSrc[i];
        const rawS = rightSrc[i];
        const m = Number.isFinite(rawM) ? rawM : 0;
        const s = Number.isFinite(rawS) ? rawS : 0;
        const lRaw = wLA * m + wLB * s;
        const rRaw = wRA * m + wRB * s;
        const outL = lRaw < -1 ? -1 : (lRaw > 1 ? 1 : lRaw);
        const outR = rRaw < -1 ? -1 : (rRaw > 1 ? 1 : rRaw);

        fftRing[writeIdx] = 0.5 * (outL + outR);
        writeIdx = (writeIdx + 1) & AF_FFT_MASK;
        if (filled < AF_FFT_SIZE) {
          filled += 1;
        }

        if (recActive && this._recActive) {
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
            this._recCurChunk[this._recCurIdx++] = Math.round(outL * 32767);
            this._recCurChunk[this._recCurIdx++] = Math.round(outR * 32767);
            this._recTotalFrames += 1;
          }
        }
      }

      this._fftWriteIdx = writeIdx;
      this._fftFilled = filled;
      this._afWriteGen += 1;
    }

    /**
     * Compute smoothed 0..maxHz AF passband FFT spectrum in dBFS directly from decoded audio.
     * Works identically in live browser sessions and headless tests when AudioContext is suspended.
     * @param {number} [maxHz=3200]
     * @returns {{ binsDb: Float32Array, binHz: number, sampleRate: number, maxHz: number, hasSignal: boolean }}
     */
    getAfSpectrum(maxHz = 3200) {
      const resolvedMaxHz = maxHz || 3200;
      if (
        this._lastAfResult &&
        this._lastAfGen === this._afWriteGen &&
        this._lastAfMaxHz === resolvedMaxHz
      ) {
        this._perf.afFftSkips += 1;
        return this._lastAfResult;
      }

      const binHz = AF_TAP_SAMPLE_RATE / AF_FFT_SIZE;
      const numBins = Math.max(4, Math.min(AF_FFT_SIZE >> 1, Math.ceil(resolvedMaxHz / binHz) + 1));

      if (this._fftFilled < 64) {
        const emptyResult = {
          binsDb: this._afBinsDb.subarray(0, numBins),
          binHz,
          sampleRate: AF_TAP_SAMPLE_RATE,
          maxHz: resolvedMaxHz,
          hasSignal: false,
        };
        this._lastAfGen = this._afWriteGen;
        this._lastAfMaxHz = resolvedMaxHz;
        this._lastAfResult = emptyResult;
        return emptyResult;
      }

      const re = this._fftRe;
      const im = this._fftIm;
      const win = AF_HANN.win;
      const ring = this._fftRing;
      const start = (this._fftWriteIdx - AF_FFT_SIZE) & AF_FFT_MASK;

      for (let i = 0; i < AF_FFT_SIZE; i++) {
        const idx = AF_BIT_REV[i];
        const sample = ring[(start + i) & AF_FFT_MASK];
        re[idx] = sample * win[i];
        im[idx] = 0;
      }

      for (let s = 0; s < AF_TWIDDLE_STAGES.length; s++) {
        const stage = AF_TWIDDLE_STAGES[s];
        const size = stage.size;
        const half = stage.half;
        const twRe = stage.wRe;
        const twIm = stage.wIm;
        for (let i = 0; i < AF_FFT_SIZE; i += size) {
          for (let j = 0; j < half; j++) {
            const wRe = twRe[j];
            const wIm = twIm[j];
            const k0 = i + j;
            const k1 = k0 + half;
            const re1 = re[k1];
            const im1 = im[k1];
            const tRe = wRe * re1 - wIm * im1;
            const tIm = wRe * im1 + wIm * re1;
            const re0 = re[k0];
            const im0 = im[k0];
            re[k1] = re0 - tRe;
            im[k1] = im0 - tIm;
            re[k0] = re0 + tRe;
            im[k0] = im0 + tIm;
          }
        }
      }

      const norm = 2 / AF_HANN.sum;
      const binsDb = this._afBinsDb;
      const hasComputed = this._afHasComputed;
      for (let k = 0; k < numBins; k++) {
        const r = re[k];
        const m = im[k];
        const mag = Math.sqrt(r * r + m * m) * norm;
        const db = clamp(20 * Math.log10(Math.max(1e-6, mag)), -110, 0);
        if (!hasComputed) {
          binsDb[k] = db;
        } else {
          const alpha = db > binsDb[k] ? 0.65 : 0.25;
          binsDb[k] = binsDb[k] * (1 - alpha) + db * alpha;
        }
      }
      this._afHasComputed = true;
      this._perf.afFftRuns += 1;

      const result = {
        binsDb: binsDb.subarray(0, numBins),
        binHz,
        sampleRate: AF_TAP_SAMPLE_RATE,
        maxHz: resolvedMaxHz,
        hasSignal: true,
      };
      this._lastAfGen = this._afWriteGen;
      this._lastAfMaxHz = resolvedMaxHz;
      this._lastAfResult = result;
      return result;
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
      this._teardownMediaSession();
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
      this.releaseMicStandby();
      this.stop();
      this._txPacketHandler = null;
      this._txWaveBuffer = null;
      if (this._unsubState) {
        try { this._unsubState(); } catch (_) {}
        this._unsubState = null;
      }
    }
  }

  AudioEngine.MEDIA_SMETER_DURATION_SEC = MEDIA_SMETER_DURATION_SEC;
  AudioEngine.sMeterDbmToMediaPosition = sMeterDbmToMediaPosition;

  K4.AudioEngine = AudioEngine;
  K4.SL_TARGET_MS = SL_TARGET_MS;
  K4.encodeWavPcm16 = encodeWavPcm16;
})();
