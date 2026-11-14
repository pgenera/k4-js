'use strict';
(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const DEFAULT_MIX_OPTS = Object.freeze({
    gainA: 1.0,
    gainB: 1.0,
    subRxEnabled: false,
    muted: false,
    balance: 0.0,
    mixMode: 'A.B',
  });

  function clamp(v, min, max) {
    return v < min ? min : (v > max ? max : v);
  }

  class StereoSample {
    constructor(left, right) {
      this.left = left;
      this.right = right;
    }

    get 0() {
      return this.left;
    }

    get 1() {
      return this.right;
    }

    *[Symbol.iterator]() {
      yield this.left;
      yield this.right;
    }
  }

  /**
   * Mix one stereo [Main, Sub] frame according to Elecraft K4 MX presets,
   * Sub-RX gating, per-receiver gains, stereo balance (-1..+1), and mute.
   * Pass an optional mutable `out` object { left, right } on hot audio paths.
   */
  function mixStereoSample(main, sub, opts, out) {
    const cfg = opts || DEFAULT_MIX_OPTS;
    if (cfg.muted) {
      if (out) {
        out.left = 0;
        out.right = 0;
        return out;
      }
      return new StereoSample(0, 0);
    }

    const gainA = cfg.gainA !== undefined && Number.isFinite(cfg.gainA)
      ? clamp(cfg.gainA, 0, 1)
      : 1.0;
    const gainB = cfg.gainB !== undefined && Number.isFinite(cfg.gainB)
      ? clamp(cfg.gainB, 0, 1)
      : 1.0;
    const subRxEnabled = Boolean(cfg.subRxEnabled);
    const balance = cfg.balance !== undefined && Number.isFinite(cfg.balance)
      ? clamp(cfg.balance, -1, 1)
      : 0.0;
    const mixMode = typeof cfg.mixMode === 'string' && cfg.mixMode.length > 0
      ? cfg.mixMode
      : 'A.B';

    const a = (Number.isFinite(main) ? main : 0) * gainA;
    const b = subRxEnabled ? (Number.isFinite(sub) ? sub : 0) * gainB : 0;
    const ab = subRxEnabled ? 0.5 * (a + b) : a;

    let left = a;
    let right = a;

    switch (mixMode) {
      case 'A.B':
        left = a;
        right = subRxEnabled ? b : a;
        break;
      case 'AB.AB':
        left = ab;
        right = ab;
        break;
      case 'A.-A':
        left = a;
        right = -a;
        break;
      case 'A.AB':
        left = a;
        right = ab;
        break;
      case 'AB.B':
        left = ab;
        right = b;
        break;
      case 'AB.A':
        left = ab;
        right = a;
        break;
      case 'B.AB':
        left = b;
        right = ab;
        break;
      case 'B.B':
        left = b;
        right = b;
        break;
      case 'B.A':
        left = b;
        right = a;
        break;
      case 'A.A':
      default:
        left = a;
        right = a;
        break;
    }

    if (balance < 0) {
      right *= 1.0 + balance;
    } else if (balance > 0) {
      left *= 1.0 - balance;
    }

    left = clamp(left, -1, 1);
    right = clamp(right, -1, 1);

    if (out) {
      out.left = left;
      out.right = right;
      return out;
    }
    return new StereoSample(left, right);
  }

  // Pure 7-bit ASCII source so btoa() always succeeds in every browser and file:// origin.
  const WORKLET_PROCESSOR_SOURCE = [
    "'use strict';",
    'class K4AudioProcessor extends AudioWorkletProcessor {',
    '  constructor() {',
    '    super();',
    '    this.capacity = Math.max(2048, Math.round(sampleRate * 2.0));',
    '    this.ringMain = new Float32Array(this.capacity);',
    '    this.ringSub = new Float32Array(this.capacity);',
    '    this.readIdx = 0;',
    '    this.writeIdx = 0;',
    '    this.buffered = 0;',
    '    this.maxBufferSamples = this.capacity;',
    '    this.trimToSamples = Math.round(sampleRate * 0.15);',
    '    this.underruns = 0;',
    '    this.hasPlayed = false;',
    '    this.inUnderrun = false;',
    '    this.fadeRemaining = 0;',
    '    this.fadeStartL = 0;',
    '    this.fadeStartR = 0;',
    '    this.lastOutL = 0;',
    '    this.lastOutR = 0;',
    '    this.quantaSinceStats = 0;',
    '    this.scratch = { left: 0, right: 0 };',
    '    this.config = {',
    '      gainA: 1.0,',
    '      gainB: 1.0,',
    '      subRxEnabled: false,',
    '      muted: true,',
    '      balance: 0.0,',
    "      mixMode: 'A.B',",
    '    };',
    '    this.port.onmessage = (ev) => {',
    '      const msg = ev.data;',
    '      if (!msg) return;',
    "      if (msg.type === 'audio') {",
    '        this.pushSamples(msg.main, msg.sub);',
    "      } else if (msg.type === 'config') {",
    '        if (typeof msg.gainA === "number") this.config.gainA = msg.gainA;',
    '        if (typeof msg.gainB === "number") this.config.gainB = msg.gainB;',
    '        if (typeof msg.subRxEnabled === "boolean") this.config.subRxEnabled = msg.subRxEnabled;',
    '        if (typeof msg.muted === "boolean") this.config.muted = msg.muted;',
    '        if (typeof msg.balance === "number") this.config.balance = msg.balance;',
    '        if (typeof msg.mixMode === "string") this.config.mixMode = msg.mixMode;',
    '        if (typeof msg.maxBufferSamples === "number" && msg.maxBufferSamples > 0) {',
    '          this.maxBufferSamples = Math.min(this.capacity, Math.round(msg.maxBufferSamples));',
    '        }',
    '        if (typeof msg.trimToSamples === "number" && msg.trimToSamples > 0) {',
    '          this.trimToSamples = Math.min(this.capacity, Math.round(msg.trimToSamples));',
    '        }',
    "      } else if (msg.type === 'clear') {",
    '        this.readIdx = 0;',
    '        this.writeIdx = 0;',
    '        this.buffered = 0;',
    '        this.hasPlayed = false;',
    '        this.inUnderrun = false;',
    '        this.fadeRemaining = 0;',
    '        this.lastOutL = 0;',
    '        this.lastOutR = 0;',
    '      }',
    '    };',
    '  }',
    '',
    '  pushSamples(main, sub) {',
    '    if (!main || !sub) return;',
    '    const total = Math.min(main.length, sub.length);',
    '    if (total <= 0) return;',
    '    let start = 0;',
    '    if (total >= this.capacity) {',
    '      start = total - this.capacity;',
    '      this.readIdx = 0;',
    '      this.writeIdx = 0;',
    '      this.buffered = 0;',
    '    }',
    '    const cap = this.capacity;',
    '    for (let i = start; i < total; i++) {',
    '      if (this.buffered >= cap) {',
    '        this.readIdx = (this.readIdx + 1) % cap;',
    '        this.buffered -= 1;',
    '      }',
    '      this.ringMain[this.writeIdx] = main[i];',
    '      this.ringSub[this.writeIdx] = sub[i];',
    '      this.writeIdx = (this.writeIdx + 1) % cap;',
    '      this.buffered += 1;',
    '    }',
    '    if (this.buffered > this.maxBufferSamples) {',
    '      const drop = this.buffered - this.trimToSamples;',
    '      if (drop > 0) {',
    '        this.readIdx = (this.readIdx + drop) % cap;',
    '        this.buffered -= drop;',
    '      }',
    '    }',
    '  }',
    '',
    '  mixSample(m, s) {',
    '    const cfg = this.config;',
    '    if (cfg.muted) {',
    '      this.scratch.left = 0;',
    '      this.scratch.right = 0;',
    '      return;',
    '    }',
    '    const gainA = cfg.gainA < 0 ? 0 : (cfg.gainA > 1 ? 1 : cfg.gainA);',
    '    const gainB = cfg.gainB < 0 ? 0 : (cfg.gainB > 1 ? 1 : cfg.gainB);',
    '    const subOn = cfg.subRxEnabled;',
    '    const bal = cfg.balance < -1 ? -1 : (cfg.balance > 1 ? 1 : cfg.balance);',
    '    const a = m * gainA;',
    '    const b = subOn ? s * gainB : 0;',
    '    const ab = subOn ? 0.5 * (a + b) : a;',
    '    let l = a;',
    '    let r = a;',
    '    switch (cfg.mixMode) {',
    "      case 'A.B': l = a; r = subOn ? b : a; break;",
    "      case 'AB.AB': l = ab; r = ab; break;",
    "      case 'A.-A': l = a; r = -a; break;",
    "      case 'A.AB': l = a; r = ab; break;",
    "      case 'AB.B': l = ab; r = b; break;",
    "      case 'AB.A': l = ab; r = a; break;",
    "      case 'B.AB': l = b; r = ab; break;",
    "      case 'B.B': l = b; r = b; break;",
    "      case 'B.A': l = b; r = a; break;",
    '      default: l = a; r = a; break;',
    '    }',
    '    if (bal < 0) r *= 1.0 + bal;',
    '    else if (bal > 0) l *= 1.0 - bal;',
    '    if (l < -1) l = -1; else if (l > 1) l = 1;',
    '    if (r < -1) r = -1; else if (r > 1) r = 1;',
    '    this.scratch.left = l;',
    '    this.scratch.right = r;',
    '  }',
    '',
    '  process(inputs, outputs) {',
    '    const out = outputs[0];',
    '    if (!out || out.length === 0) return true;',
    '    const outL = out[0];',
    '    const outR = out.length > 1 ? out[1] : null;',
    '    const len = outL.length;',
    '    const cap = this.capacity;',
    '    for (let i = 0; i < len; i++) {',
    '      if (this.buffered > 0) {',
    '        const m = this.ringMain[this.readIdx];',
    '        const s = this.ringSub[this.readIdx];',
    '        this.readIdx = (this.readIdx + 1) % cap;',
    '        this.buffered -= 1;',
    '        this.mixSample(m, s);',
    '        const l = this.scratch.left;',
    '        const r = this.scratch.right;',
    '        outL[i] = l;',
    '        if (outR) outR[i] = r;',
    '        this.lastOutL = l;',
    '        this.lastOutR = r;',
    '        this.hasPlayed = true;',
    '        this.inUnderrun = false;',
    '        this.fadeRemaining = 0;',
    '      } else {',
    '        if (this.hasPlayed && !this.inUnderrun) {',
    '          this.inUnderrun = true;',
    '          if (!this.config.muted) this.underruns += 1;',
    '          this.fadeRemaining = 16;',
    '          this.fadeStartL = this.lastOutL;',
    '          this.fadeStartR = this.lastOutR;',
    '        }',
    '        if (this.fadeRemaining > 0) {',
    '          const t = (this.fadeRemaining - 1) / 16;',
    '          const l = this.fadeStartL * t;',
    '          const r = this.fadeStartR * t;',
    '          this.fadeRemaining -= 1;',
    '          outL[i] = l;',
    '          if (outR) outR[i] = r;',
    '          this.lastOutL = l;',
    '          this.lastOutR = r;',
    '        } else {',
    '          outL[i] = 0;',
    '          if (outR) outR[i] = 0;',
    '          this.lastOutL = 0;',
    '          this.lastOutR = 0;',
    '        }',
    '      }',
    '    }',
    '    this.quantaSinceStats += 1;',
    '    if (this.quantaSinceStats >= 8) {',
    '      this.quantaSinceStats = 0;',
    '      this.port.postMessage({',
    "        type: 'stats',",
    '        bufferedSamples: this.buffered,',
    '        underruns: this.underruns,',
    '      });',
    '    }',
    '    return true;',
    '  }',
    '}',
    "registerProcessor('k4-audio-processor', K4AudioProcessor);",
  ].join('\n');

  function createWorkletDataUrl() {
    return 'data:text/javascript;base64,' + globalThis.btoa(WORKLET_PROCESSOR_SOURCE);
  }

  K4.WORKLET_PROCESSOR_SOURCE = WORKLET_PROCESSOR_SOURCE;
  K4.createWorkletDataUrl = createWorkletDataUrl;
  K4.mixStereoSample = mixStereoSample;
})();
