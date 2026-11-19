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
      c1: makeBiquadLp(20250, 1400, 0.5411961),
      c2: makeBiquadLp(20250, 1400, 1.306563),
      lastFc: 1400,
      lastFs: 20250,
      i1x1: 0, i1x2: 0, i1y1: 0, i1y2: 0,
      q1x1: 0, q1x2: 0, q1y1: 0, q1y2: 0,
      i2x1: 0, i2x2: 0, i2y1: 0, i2y2: 0,
      q2x1: 0, q2x2: 0, q2y1: 0, q2y2: 0,
      amDc: 0,
      fmPrevI: 0,
      fmPrevQ: 0,
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

  function normalizeTile(raw) {
    const iq = raw.iqInt16 instanceof Int16Array ? raw.iqInt16 : new Int16Array(0);
    const sr = Math.max(8000, Number(raw.sampleRateHz || 20250));
    const center = Number(raw.centerFreqHz || 14074000);
    return {
      iq,
      totalFrames: iq.length >> 1,
      sampleRateHz: sr,
      centerFreqHz: center,
      minHz: center - sr * 0.47,
      maxHz: center + sr * 0.47,
      cursor: 0.0,
      fftDbm: new Float32Array(FFT_SIZE),
      noiseFloorDbm: -118.0,
    };
  }

  /**
   * Real-time in-browser multi-tile SDR DDC + stitched FFT engine.
   * Accepts either `tiles: [{ iqInt16, sampleRateHz, centerFreqHz }, ...]`
   * or legacy single-tile `{ iqInt16, sampleRateHz, centerFreqHz }`.
   */
  class DemoDemodulator {
    constructor(opts = {}) {
      const rawTiles = Array.isArray(opts.tiles) && opts.tiles.length > 0
        ? opts.tiles
        : [{
            iqInt16: opts.iqInt16,
            sampleRateHz: opts.sampleRateHz,
            centerFreqHz: opts.centerFreqHz,
          }];

      this.tiles = rawTiles.map(normalizeTile).sort((a, b) => a.centerFreqHz - b.centerFreqHz);
      this.centerFreqHz = Number(
        opts.centerFreqHz ||
          (this.tiles.length > 0
            ? (this.tiles[0].centerFreqHz + this.tiles[this.tiles.length - 1].centerFreqHz) * 0.5
            : 14074000)
      );
      this.calOffsetDb = Number.isFinite(Number(opts.noiseFloorOffsetDb))
        ? Number(opts.noiseFloorOffsetDb) + 76.0
        : -42.0;

      this._fftRe = new Float32Array(FFT_SIZE);
      this._fftIm = new Float32Array(FFT_SIZE);
      this._avgPanA = new Float32Array(FFT_SIZE);
      this._avgPanB = new Float32Array(FFT_SIZE);
      this._avgInitA = false;
      this._avgInitB = false;

      this._rxA = createRxChannelState();
      this._rxB = createRxChannelState();
      this._rngState = 0x12345678;
    }

    _nextNoise() {
      let x = this._rngState | 0;
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      this._rngState = x;
      return ((x & 0xffff) / 32768.0) - 1.0;
    }

    _pickTileForFreq(freqHz) {
      let best = null;
      let bestDist = Infinity;
      for (let i = 0; i < this.tiles.length; i++) {
        const t = this.tiles[i];
        const dist = Math.abs(freqHz - t.centerFreqHz);
        if (dist < bestDist) {
          bestDist = dist;
          best = t;
        }
      }
      return best;
    }

    _updateFilterIfNeeded(ch, fs, fc) {
      const clampedFc = clamp(fc, 60, Math.min(4800, fs * 0.42));
      if (Math.abs(clampedFc - ch.lastFc) > 12 || Math.abs(ch.lastFs - fs) > 1) {
        ch.c1 = makeBiquadLp(fs, clampedFc, 0.5411961);
        ch.c2 = makeBiquadLp(fs, clampedFc, 1.306563);
        ch.lastFc = clampedFc;
        ch.lastFs = fs;
      }
    }

    _demodChannelBlock(ch, rxState, cwPitchHz, outFloat, nOut) {
      const pb = passbandCenterHz(rxState, cwPitchHz);
      const tile = this._pickTileForFreq(pb.center);
      if (!tile || tile.totalFrames < 16) {
        outFloat.fill(0, 0, nOut);
        ch.smeterDbm = -125;
        return;
      }

      const fs = tile.sampleRateHz;
      const stepIn = fs / AUDIO_SR;
      const bw = clamp(Number(rxState.bwHz || 2400), 50, 4800);
      const halfBw = Math.max(80, bw * 0.5);
      this._updateFilterIfNeeded(ch, fs, halfBw);

      const mixHz = pb.center - tile.centerFreqHz;
      const inBand = Math.abs(mixHz) <= fs * 0.49;
      const ncoStep = (-TWO_PI * mixHz) / fs;

      let afHz = Math.abs(pb.center - pb.carrier);
      if (pb.sideband === 0 || pb.sideband === 2) afHz = 0;
      const afStep = (TWO_PI * afHz) / AUDIO_SR;

      const c1 = ch.c1;
      const c2 = ch.c2;
      const iq = tile.iq;
      const total = tile.totalFrames;
      const inv32768 = 1.0 / 32768.0;

      const startCursor = tile.cursor;
      const curStartInt = Math.floor(startCursor);
      const curEnd = startCursor + nOut * stepIn;
      const curEndInt = Math.floor(curEnd);
      const totalIn = Math.max(1, curEndInt - curStartInt + 2);

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
          xi = this._nextNoise() * 0.0025;
          xq = this._nextNoise() * 0.0025;
        }
        nco += ncoStep;
        if (nco > Math.PI) nco -= TWO_PI;
        else if (nco < -Math.PI) nco += TWO_PI;

        const y1i = c1.b0 * xi + c1.b1 * i1x1 + c1.b2 * i1x2 - c1.a1 * i1y1 - c1.a2 * i1y2;
        i1x2 = i1x1; i1x1 = xi; i1y2 = i1y1; i1y1 = y1i;
        const y1q = c1.b0 * xq + c1.b1 * q1x1 + c1.b2 * q1x2 - c1.a1 * q1y1 - c1.a2 * q1y2;
        q1x2 = q1x1; q1x1 = xq; q1y2 = q1y1; q1y1 = y1q;

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

      const meanPwr = powerAcc / totalIn;
      const instDbm = clamp(10.0 * Math.log10(meanPwr + 1e-12) + this.calOffsetDb, -127.0, -25.0);
      ch.smeterDbm = ch.smeterDbm * 0.6 + instDbm * 0.4;

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
          sample = bi * Math.cos(afPhase) - bq * Math.sin(afPhase);
        } else if (pb.sideband === -1) {
          sample = bi * Math.cos(afPhase) + bq * Math.sin(afPhase);
        } else if (pb.sideband === 0) {
          const env = Math.sqrt(bi * bi + bq * bq);
          amDc = amDc * 0.995 + env * 0.005;
          sample = (env - amDc) * 1.4;
        } else {
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

    renderAudioFrame(rxA, rxB, subRxEnabled, cwPitchHz = 500) {
      if (!this._tmpL) {
        this._tmpL = new Float32Array(AUDIO_FRAME_SAMPLES);
        this._tmpR = new Float32Array(AUDIO_FRAME_SAMPLES);
      }
      this._demodChannelBlock(this._rxA, rxA, cwPitchHz, this._tmpL, AUDIO_FRAME_SAMPLES);
      if (subRxEnabled && rxB) {
        this._demodChannelBlock(this._rxB, rxB, cwPitchHz, this._tmpR, AUDIO_FRAME_SAMPLES);
      } else {
        this._tmpR.set(this._tmpL);
        this._rxB.smeterDbm = -125.0;
      }

      // Advance every tile's playback cursor smoothly so the entire wideband waterfall stays alive
      for (let i = 0; i < this.tiles.length; i++) {
        const t = this.tiles[i];
        if (t.totalFrames > 0) {
          t.cursor = (t.cursor + (AUDIO_FRAME_SAMPLES * t.sampleRateHz) / AUDIO_SR) % t.totalFrames;
        }
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

    _computeTileFft(tile) {
      if (tile.totalFrames < FFT_SIZE) {
        tile.fftDbm.fill(-122.0);
        tile.noiseFloorDbm = -122.0;
        return;
      }
      const start = Math.floor(tile.cursor);
      const total = tile.totalFrames;
      const iq = tile.iq;
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
      const outDbm = tile.fftDbm;
      let floorSum = 0;
      let floorCnt = 0;

      for (let i = 0; i < FFT_SIZE; i++) {
        const src = (i + half) & (FFT_SIZE - 1);
        const magSq = (re[src] * re[src] + im[src] * im[src]) / normSq;
        const dbm = clamp(10.0 * Math.log10(magSq + 1e-13) + this.calOffsetDb, -145.0, -10.0);
        outDbm[i] = dbm;
        if (i >= 64 && i < FFT_SIZE - 64 && (i & 7) === 0) {
          floorSum += dbm;
          floorCnt++;
        }
      }
      tile.noiseFloorDbm = floorCnt > 0 ? floorSum / floorCnt : -118.0;
    }

    computeSpectrumBins(opts = {}) {
      const rx = opts.rx === 'B' ? 'B' : 'A';
      const panCenterHz = Number(opts.panCenterHz || this.centerFreqHz);
      const spanHz = Math.max(1000, Number(opts.spanHz || 24000));
      const avg = clamp(Number(opts.averaging || 2), 1, 20);
      const miniPan = Boolean(opts.miniPan);
      const byteOffset = miniPan ? MINIPAN_BYTE_OFFSET : PAN_BYTE_OFFSET;

      const halfSpan = spanHz * 0.5;
      const viewMin = panCenterHz - halfSpan;
      const viewMax = panCenterHz + halfSpan;

      // Compute FFT only for tiles intersecting the current viewport
      const activeTiles = [];
      let floorSum = 0;
      for (let i = 0; i < this.tiles.length; i++) {
        const t = this.tiles[i];
        if (t.maxHz >= viewMin && t.minHz <= viewMax) {
          this._computeTileFft(t);
          activeTiles.push(t);
          floorSum += t.noiseFloorDbm;
        }
      }
      const noiseFloorDbm = activeTiles.length > 0 ? floorSum / activeTiles.length : -118.0;
      const outFloor = noiseFloorDbm - 4.0;

      const alpha = miniPan ? 0.55 : clamp(1.2 / Math.max(1, avg), 0.08, 1.0);
      const avgBuf = rx === 'B' ? this._avgPanB : this._avgPanA;
      const isInit = rx === 'B' ? this._avgInitB : this._avgInitA;
      const out = new Uint8Array(FFT_SIZE);

      const nActive = activeTiles.length;
      for (let i = 0; i < FFT_SIZE; i++) {
        const f = viewMin + (i / (FFT_SIZE - 1)) * spanHz;
        let wSum = 0;
        let dbmSum = 0;

        for (let tIdx = 0; tIdx < nActive; tIdx++) {
          const t = activeTiles[tIdx];
          const rel = (f - t.centerFreqHz) / t.sampleRateHz + 0.5;
          if (rel < 0.03 || rel > 0.97) continue;
          const pos = rel * (FFT_SIZE - 1);
          const k0 = Math.floor(pos);
          const frac = pos - k0;
          const k1 = Math.min(FFT_SIZE - 1, k0 + 1);
          const val = t.fftDbm[k0] + (t.fftDbm[k1] - t.fftDbm[k0]) * frac;
          // Smooth raised edge weight so overlapping tiles blend with zero visible seam
          const edgeDist = Math.min(rel - 0.03, 0.97 - rel);
          const w = Math.min(1.0, edgeDist / 0.08);
          dbmSum += val * w;
          wSum += w;
        }

        let dbm = wSum > 0 ? dbmSum / wSum : outFloor + this._nextNoise() * 2.2;

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
