'use strict';
(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const TWO_PI = Math.PI * 2;
  const FFT_SIZE = 1024;
  const AUDIO_SR = 12000;
  const AUDIO_FRAME_SAMPLES = 240; // 20 ms @ 12 kHz
  const PAN_BYTE_OFFSET = 162.0;
  const MINIPAN_BYTE_OFFSET = 118.0;
  const K4_EM1_SCALE = 1024.0; // K4 1/32 wire convention: 1024 counts = 1.0 full-scale after *32/32768

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  // Precompute 1024-pt Radix-2 FFT tables + Hann window
  const BIT_REV = new Uint16Array(FFT_SIZE);
  const TWIDDLE_COS = new Float32Array(FFT_SIZE >> 1);
  const TWIDDLE_SIN = new Float32Array(FFT_SIZE >> 1);
  const HANN_WIN = new Float32Array(FFT_SIZE);
  let HANN_SUM = 0;

  (() => {
    const bits = Math.round(Math.log2(FFT_SIZE));
    for (let i = 0; i < FFT_SIZE; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      BIT_REV[i] = r;
      const w = 0.5 * (1.0 - Math.cos((TWO_PI * i) / (FFT_SIZE - 1)));
      HANN_WIN[i] = w;
      HANN_SUM += w;
    }
    for (let k = 0; k < (FFT_SIZE >> 1); k++) {
      const ang = (-TWO_PI * k) / FFT_SIZE;
      TWIDDLE_COS[k] = Math.cos(ang);
      TWIDDLE_SIN[k] = Math.sin(ang);
    }
  })();

  function fft1024(re, im) {
    for (let i = 0; i < FFT_SIZE; i++) {
      const j = BIT_REV[i];
      if (j > i) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }
    for (let len = 2; len <= FFT_SIZE; len <<= 1) {
      const half = len >> 1;
      const step = FFT_SIZE / len;
      for (let i = 0; i < FFT_SIZE; i += len) {
        let tw = 0;
        for (let j = 0; j < half; j++) {
          const wr = TWIDDLE_COS[tw];
          const wi = TWIDDLE_SIN[tw];
          const idx1 = i + j;
          const idx2 = idx1 + half;
          const vr = re[idx2] * wr - im[idx2] * wi;
          const vi = re[idx2] * wi + im[idx2] * wr;
          re[idx2] = re[idx1] - vr;
          im[idx2] = im[idx1] - vi;
          re[idx1] += vr;
          im[idx1] += vi;
          tw += step;
        }
      }
    }
  }

  function makeBiquadLp(fs, fc, q) {
    const safeFc = clamp(fc, 40, fs * 0.45);
    const w0 = (TWO_PI * safeFc) / fs;
    const cosW = Math.cos(w0);
    const sinW = Math.sin(w0);
    const alpha = sinW / (2.0 * q);
    const a0 = 1.0 + alpha;
    const b0 = ((1.0 - cosW) * 0.5) / a0;
    return {
      b0,
      b1: (1.0 - cosW) / a0,
      b2: b0,
      a1: (-2.0 * cosW) / a0,
      a2: (1.0 - alpha) / a0,
    };
  }

  function createRxChannelState() {
    return {
      ncoPhase: 0,
      afPhase: 0,
      // Two cascaded complex biquads (4th-order Butterworth LPF)
      c1: makeBiquadLp(20250, 1400, 0.5411961),
      c2: makeBiquadLp(20250, 1400, 1.306563),
      lastFc: 1400,
      lastFs: 20250,
      // Filter delay states (stage 1 & 2, I & Q)
      i1x1: 0, i1x2: 0, i1y1: 0, i1y2: 0,
      q1x1: 0, q1x2: 0, q1y1: 0, q1y2: 0,
      i2x1: 0, i2x2: 0, i2y1: 0, i2y2: 0,
      q2x1: 0, q2x2: 0, q2y1: 0, q2y2: 0,
      // AM DC blocker / FM prev sample
      amDc: 0,
      fmPrevI: 0,
      fmPrevQ: 0,
      // AGC envelope
      agcEnv: 0.02,
      smeterDbm: -115.0,
    };
  }

  function passbandCenterHz(rx, cwPitchHz) {
    const carrier = Number(rx.freqHz) + (rx.ritOn ? Number(rx.ritOffsetHz || 0) : 0);
    const mode = Number(rx.mode || 2);
    const sub = Number(rx.dataSubMode || 0);
    const bw = clamp(Number(rx.bwHz || 2400), 50, 4800);
    const isVal = Number(rx.ifShiftHz || 0);
    const pitch = clamp(Number(cwPitchHz || 500), 300, 1000);

    switch (mode) {
      case 2: // USB
        return { carrier, center: carrier + (isVal || Math.max(300, bw * 0.5 + 200)), sideband: 1 };
      case 1: // LSB
        return { carrier, center: carrier - (isVal || Math.max(300, bw * 0.5 + 200)), sideband: -1 };
      case 3: // CW
        return { carrier, center: carrier + (isVal || pitch), sideband: 1 };
      case 7: // CW-R
        return { carrier, center: carrier - (isVal || pitch), sideband: -1 };
      case 6: // DATA
        if (sub === 1 || sub === 2) {
          // AFSK-A / FSK-D (LSB convention on K4)
          return { carrier, center: carrier - 85, sideband: -1 };
        }
        return { carrier, center: carrier + (isVal || 1500), sideband: 1 };
      case 9: // DATA-R
        if (sub === 1 || sub === 2) {
          return { carrier, center: carrier + 85, sideband: 1 };
        }
        return { carrier, center: carrier - (isVal || 1500), sideband: -1 };
      case 5: // AM
        return { carrier, center: carrier, sideband: 0 };
      case 4: // FM
        return { carrier, center: carrier, sideband: 2 };
      default:
        return { carrier, center: carrier + 1500, sideband: 1 };
    }
  }

  /**
   * Real-time in-browser SDR DDC + FFT engine backed by a looped complex I/Q buffer.
   */
  class DemoDemodulator {
    /**
     * @param {Object} opts
     * @param {Int16Array} opts.iqInt16 Interleaved [I0, Q0, I1, Q1, ...]
     * @param {number} opts.sampleRateHz Input I/Q sample rate (e.g. 12000, 20250, 48000)
     * @param {number} opts.centerFreqHz RF center frequency of the I/Q recording in Hz
     * @param {number} [opts.noiseFloorOffsetDb=-118] Calibration offset mapping full-scale dBFS to dBm
     */
    constructor(opts = {}) {
      this.iq = opts.iqInt16 instanceof Int16Array ? opts.iqInt16 : new Int16Array(0);
      this.totalFrames = this.iq.length >> 1;
      this.sampleRateHz = Math.max(8000, Number(opts.sampleRateHz || 20250));
      this.centerFreqHz = Number(opts.centerFreqHz || 14074000);
      this.calOffsetDb = Number.isFinite(Number(opts.noiseFloorOffsetDb))
        ? Number(opts.noiseFloorOffsetDb) + 76.0
        : -42.0;

      this._cursor = 0.0; // Fractional sample index in [0, totalFrames)
      this._fftRe = new Float32Array(FFT_SIZE);
      this._fftIm = new Float32Array(FFT_SIZE);
      this._fftDbm = new Float32Array(FFT_SIZE);
      this._avgPanA = new Float32Array(FFT_SIZE);
      this._avgPanB = new Float32Array(FFT_SIZE);
      this._avgInitA = false;
      this._avgInitB = false;

      this._rxA = createRxChannelState();
      this._rxB = createRxChannelState();
      this._rngState = 0x12345678;
    }

    _nextNoise() {
      // Fast xorshift32 in [-1, 1]
      let x = this._rngState | 0;
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      this._rngState = x;
      return ((x & 0xffff) / 32768.0) - 1.0;
    }

    _updateFilterIfNeeded(ch, fc) {
      const clampedFc = clamp(fc, 60, Math.min(4800, this.sampleRateHz * 0.42));
      if (Math.abs(clampedFc - ch.lastFc) > 12 || ch.lastFs !== this.sampleRateHz) {
        ch.c1 = makeBiquadLp(this.sampleRateHz, clampedFc, 0.5411961);
        ch.c2 = makeBiquadLp(this.sampleRateHz, clampedFc, 1.306563);
        ch.lastFc = clampedFc;
        ch.lastFs = this.sampleRateHz;
      }
    }

    _demodChannelBlock(ch, startCursor, rxState, cwPitchHz, outFloat, nOut) {
      if (this.totalFrames < 16) {
        outFloat.fill(0, 0, nOut);
        ch.smeterDbm = -125;
        return;
      }

      const fs = this.sampleRateHz;
      const stepIn = fs / AUDIO_SR;
      const pb = passbandCenterHz(rxState, cwPitchHz);
      const bw = clamp(Number(rxState.bwHz || 2400), 50, 4800);
      const halfBw = Math.max(80, bw * 0.5);
      this._updateFilterIfNeeded(ch, halfBw);

      const mixHz = pb.center - this.centerFreqHz;
      const inBand = Math.abs(mixHz) <= fs * 0.49;
      const ncoStep = (-TWO_PI * mixHz) / fs;

      // Audio pitch offset from passband center back to carrier
      let afHz = Math.abs(pb.center - pb.carrier);
      if (pb.sideband === 0 || pb.sideband === 2) afHz = 0;
      const afStep = (TWO_PI * afHz) / AUDIO_SR;

      const c1 = ch.c1;
      const c2 = ch.c2;
      const iq = this.iq;
      const total = this.totalFrames;
      const inv32768 = 1.0 / 32768.0;

      // Advance input filter across the exact input sample range corresponding to nOut output samples
      const curStartInt = Math.floor(startCursor);
      const curEnd = startCursor + nOut * stepIn;
      const curEndInt = Math.floor(curEnd);
      const totalIn = Math.max(1, curEndInt - curStartInt + 2);

      // Keep a small scratch buffer for filtered I/Q at input sample rate so we can linearly interpolate to 12 kHz
      if (!ch._filtI || ch._filtI.length < totalIn) {
        ch._filtI = new Float32Array(totalIn + 64);
        ch._filtQ = new Float32Array(totalIn + 64);
      }
      const filtI = ch._filtI;
      const filtQ = ch._filtQ;

      let nco = ch.ncoPhase;
      let powerAcc = 0;

      let i1x1 = ch.i1x1, i1x2 = ch.i1x2, i1y1 = ch.i1y1, i1y2 = ch.i1y2;
      let q1x1 = ch.q1x1, q1x2 = ch.q1x2, q1y1 = ch.q1y1, q1y2 = ch.q1y2;
      let i2x1 = ch.i2x1, i2x2 = ch.i2x2, i2y1 = ch.i2y1, i2y2 = ch.i2y2;
      let q2x1 = ch.q2x1, q2x2 = ch.q2x2, q2y1 = ch.q2y1, q2y2 = ch.q2y2;

      for (let k = 0; k < totalIn; k++) {
        let idx = (curStartInt + k) % total;
        if (idx < 0) idx += total;
        let xi, xq;
        if (inBand) {
          const base = idx << 1;
          const rawI = iq[base] * inv32768;
          const rawQ = iq[base + 1] * inv32768;
          const cs = Math.cos(nco);
          const sn = Math.sin(nco);
          xi = rawI * cs - rawQ * sn;
          xq = rawI * sn + rawQ * cs;
        } else {
          // Gentle band noise if tuned outside recorded slice
          xi = this._nextNoise() * 0.0025;
          xq = this._nextNoise() * 0.0025;
        }
        nco += ncoStep;
        if (nco > Math.PI) nco -= TWO_PI;
        else if (nco < -Math.PI) nco += TWO_PI;

        // Stage 1 LPF
        const y1i = c1.b0 * xi + c1.b1 * i1x1 + c1.b2 * i1x2 - c1.a1 * i1y1 - c1.a2 * i1y2;
        i1x2 = i1x1; i1x1 = xi; i1y2 = i1y1; i1y1 = y1i;
        const y1q = c1.b0 * xq + c1.b1 * q1x1 + c1.b2 * q1x2 - c1.a1 * q1y1 - c1.a2 * q1y2;
        q1x2 = q1x1; q1x1 = xq; q1y2 = q1y1; q1y1 = y1q;

        // Stage 2 LPF
        const y2i = c2.b0 * y1i + c2.b1 * i2x1 + c2.b2 * i2x2 - c2.a1 * i2y1 - c2.a2 * i2y2;
        i2x2 = i2x1; i2x1 = y1i; i2y2 = i2y1; i2y1 = y2i;
        const y2q = c2.b0 * y1q + c2.b1 * q2x1 + c2.b2 * q2x2 - c2.a1 * q2y1 - c2.a2 * q2y2;
        q2x2 = q2x1; q2x1 = y1q; q2y2 = q2y1; q2y1 = y2q;

        filtI[k] = y2i;
        filtQ[k] = y2q;
        powerAcc += y2i * y2i + y2q * y2q;
      }

      ch.ncoPhase = nco;
      ch.i1x1 = i1x1; ch.i1x2 = i1x2; ch.i1y1 = i1y1; ch.i1y2 = i1y2;
      ch.q1x1 = q1x1; ch.q1x2 = q1x2; ch.q1y1 = q1y1; ch.q1y2 = q1y2;
      ch.i2x1 = i2x1; ch.i2x2 = i2x2; ch.i2y1 = i2y1; ch.i2y2 = i2y2;
      ch.q2x1 = q2x1; ch.q2x2 = q2x2; ch.q2y1 = q2y1; ch.q2y2 = q2y2;

      // S-meter in dBm (calibrated to K4 noise floor)
      const meanPwr = powerAcc / totalIn;
      const instDbm = clamp(10.0 * Math.log10(meanPwr + 1e-12) + this.calOffsetDb, -127.0, -25.0);
      ch.smeterDbm = ch.smeterDbm * 0.6 + instDbm * 0.4;

      // Resample to 12 kHz + Weaver demodulate + AGC
      const agcMode = Number(rxState.agc !== undefined ? rxState.agc : 2);
      const agcAttack = agcMode === 2 ? 0.12 : 0.05;
      const agcDecay = agcMode === 2 ? 0.0025 : 0.0007;
      const afGainNorm = clamp(Number(rxState.afGain !== undefined ? rxState.afGain : 30) / 45.0, 0.0, 1.5);
      const squelch = Number(rxState.squelch || 0);
      const squelched = squelch > 0 && ch.smeterDbm < (-122 + squelch * 0.8);

      let afPhase = ch.afPhase;
      let agcEnv = ch.agcEnv;
      let amDc = ch.amDc;
      let fmPI = ch.fmPrevI;
      let fmPQ = ch.fmPrevQ;

      for (let n = 0; n < nOut; n++) {
        const pos = (startCursor - curStartInt) + n * stepIn;
        const k0 = Math.floor(pos);
        const frac = pos - k0;
        const k1 = Math.min(totalIn - 1, k0 + 1);
        const bi = filtI[k0] + (filtI[k1] - filtI[k0]) * frac;
        const bq = filtQ[k0] + (filtQ[k1] - filtQ[k0]) * frac;

        let sample = 0;
        if (pb.sideband === 1) {
          // USB / CW / DATA-A
          sample = bi * Math.cos(afPhase) - bq * Math.sin(afPhase);
        } else if (pb.sideband === -1) {
          // LSB / CW-R / DATA-R
          sample = bi * Math.cos(afPhase) + bq * Math.sin(afPhase);
        } else if (pb.sideband === 0) {
          // AM envelope + DC block
          const env = Math.sqrt(bi * bi + bq * bq);
          amDc = amDc * 0.995 + env * 0.005;
          sample = (env - amDc) * 1.4;
        } else {
          // FM quadrature discriminator
          const denom = bi * bi + bq * bq + 1e-6;
          sample = ((fmPI * bq - fmPQ * bi) / denom) * 0.25;
          fmPI = bi;
          fmPQ = bq;
        }

        afPhase += afStep;
        if (afPhase > TWO_PI) afPhase -= TWO_PI;

        const mag = Math.abs(sample);
        if (agcMode > 0) {
          if (mag > agcEnv) {
            agcEnv += (mag - agcEnv) * agcAttack;
          } else {
            agcEnv += (mag - agcEnv) * agcDecay;
          }
          const gain = 0.28 / Math.max(0.012, agcEnv);
          sample *= Math.min(gain, 28.0);
        } else {
          sample *= 4.0;
        }

        sample *= afGainNorm;
        if (squelched) sample = 0;
        outFloat[n] = clamp(sample, -0.95, 0.95);
      }

      ch.afPhase = afPhase;
      ch.agcEnv = agcEnv;
      ch.amDc = amDc;
      ch.fmPrevI = fmPI;
      ch.fmPrevQ = fmPQ;
    }

    /**
     * Render one 20 ms stereo EM1 PCM audio frame (240 samples/ch @ 12 kHz) and advance I/Q cursor.
     * @param {Object} rxA
     * @param {Object} rxB
     * @param {boolean} subRxEnabled
     * @param {number} cwPitchHz
     * @returns {Uint8Array} 960-byte S16LE interleaved stereo payload (L=A, R=B or A)
     */
    renderAudioFrame(rxA, rxB, subRxEnabled, cwPitchHz = 500) {
      if (!this._tmpL) {
        this._tmpL = new Float32Array(AUDIO_FRAME_SAMPLES);
        this._tmpR = new Float32Array(AUDIO_FRAME_SAMPLES);
      }
      const startCursor = this._cursor;
      this._demodChannelBlock(this._rxA, startCursor, rxA, cwPitchHz, this._tmpL, AUDIO_FRAME_SAMPLES);
      if (subRxEnabled && rxB) {
        this._demodChannelBlock(this._rxB, startCursor, rxB, cwPitchHz, this._tmpR, AUDIO_FRAME_SAMPLES);
      } else {
        this._tmpR.set(this._tmpL);
        this._rxB.smeterDbm = -125.0;
      }

      // Advance playback cursor seamlessly across loop boundary
      if (this.totalFrames > 0) {
        this._cursor = (this._cursor + (AUDIO_FRAME_SAMPLES * this.sampleRateHz) / AUDIO_SR) % this.totalFrames;
      }

      const out = new Uint8Array(AUDIO_FRAME_SAMPLES * 4);
      const dv = new DataView(out.buffer);
      for (let i = 0; i < AUDIO_FRAME_SAMPLES; i++) {
        const sL = clamp(Math.round(this._tmpL[i] * K4_EM1_SCALE), -32768, 32767);
        const sR = clamp(Math.round(this._tmpR[i] * K4_EM1_SCALE), -32768, 32767);
        dv.setInt16(i * 4, sL, true);
        dv.setInt16(i * 4 + 2, sR, true);
      }
      return out;
    }

    getSmeterDbm(rx = 'A') {
      return rx === 'B' ? this._rxB.smeterDbm : this._rxA.smeterDbm;
    }

    _computeCurrentFftDbm() {
      if (this.totalFrames < FFT_SIZE) {
        this._fftDbm.fill(-122.0);
        return -122.0;
      }
      const start = Math.floor(this._cursor);
      const total = this.totalFrames;
      const iq = this.iq;
      const re = this._fftRe;
      const im = this._fftIm;
      const inv32768 = 1.0 / 32768.0;

      for (let i = 0; i < FFT_SIZE; i++) {
        const idx = (start + i) % total;
        const base = idx << 1;
        const w = HANN_WIN[i];
        re[i] = iq[base] * inv32768 * w;
        im[i] = iq[base + 1] * inv32768 * w;
      }
      fft1024(re, im);

      const normSq = HANN_SUM * HANN_SUM;
      const half = FFT_SIZE >> 1;
      let floorSum = 0;
      let floorCnt = 0;

      for (let i = 0; i < FFT_SIZE; i++) {
        // fftshift: bin 0 -> center, bin half -> -fs/2
        const src = (i + half) & (FFT_SIZE - 1);
        const magSq = (re[src] * re[src] + im[src] * im[src]) / normSq;
        const dbm = clamp(10.0 * Math.log10(magSq + 1e-13) + this.calOffsetDb, -145.0, -10.0);
        this._fftDbm[i] = dbm;
        if (i >= 64 && i < FFT_SIZE - 64 && (i & 7) === 0) {
          floorSum += dbm;
          floorCnt++;
        }
      }
      return floorCnt > 0 ? floorSum / floorCnt : -118.0;
    }

    /**
     * Compute a 1024-bin K4 PAN (0x02) or MiniPAN (0x03) uint8 spectrum frame.
     * @param {Object} opts
     * @param {string} opts.rx 'A' or 'B'
     * @param {number} opts.panCenterHz Center RF frequency of the PAN window
     * @param {number} opts.spanHz Total span of the 1024 bins in Hz
     * @param {number} [opts.averaging=2] K4 #AVG level (1..20)
     * @param {boolean} [opts.miniPan=false] Use MiniPAN +118 offset instead of PAN +162
     * @returns {{ bins: Uint8Array, noiseFloorDbm: number }}
     */
    computeSpectrumBins(opts = {}) {
      const rx = opts.rx === 'B' ? 'B' : 'A';
      const panCenterHz = Number(opts.panCenterHz || this.centerFreqHz);
      const spanHz = Math.max(1000, Number(opts.spanHz || this.sampleRateHz));
      const avg = clamp(Number(opts.averaging || 2), 1, 20);
      const miniPan = Boolean(opts.miniPan);
      const byteOffset = miniPan ? MINIPAN_BYTE_OFFSET : PAN_BYTE_OFFSET;

      const noiseFloorDbm = this._computeCurrentFftDbm();
      const alpha = miniPan ? 0.55 : clamp(1.2 / Math.max(1, avg), 0.08, 1.0);
      const avgBuf = rx === 'B' ? this._avgPanB : this._avgPanA;
      const isInit = rx === 'B' ? this._avgInitB : this._avgInitA;

      const out = new Uint8Array(FFT_SIZE);
      const halfSpan = spanHz * 0.5;
      const iqFs = this.sampleRateHz;
      const iqCenter = this.centerFreqHz;
      const fftDbm = this._fftDbm;
      const outFloor = noiseFloorDbm - 4.0;

      for (let i = 0; i < FFT_SIZE; i++) {
        const f = panCenterHz - halfSpan + (i / (FFT_SIZE - 1)) * spanHz;
        const rel = (f - iqCenter) / iqFs + 0.5;
        let dbm;
        if (rel >= 0.02 && rel <= 0.98) {
          const pos = rel * (FFT_SIZE - 1);
          const k0 = Math.floor(pos);
          const frac = pos - k0;
          const k1 = Math.min(FFT_SIZE - 1, k0 + 1);
          dbm = fftDbm[k0] + (fftDbm[k1] - fftDbm[k0]) * frac;
        } else {
          // Subtle realistic noise outside the recorded I/Q passband
          dbm = outFloor + this._nextNoise() * 2.2;
        }

        if (!miniPan) {
          const smoothed = isInit ? avgBuf[i] + (dbm - avgBuf[i]) * alpha : dbm;
          avgBuf[i] = smoothed;
          dbm = smoothed;
        }
        out[i] = clamp(Math.round(dbm + byteOffset), 0, 255);
      }

      if (!miniPan) {
        if (rx === 'B') this._avgInitB = true;
        else this._avgInitA = true;
      }
      return { bins: out, noiseFloorDbm };
    }
  }

  K4.DemoDemodulator = DemoDemodulator;
})();
