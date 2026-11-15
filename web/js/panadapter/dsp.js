'use strict';

(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  const PAN_BYTE_OFFSET = 162.0;
  const MINIPAN_BYTE_OFFSET = 118.0;
  const SPAN_LADDER_KHZ = [6, 12, 24, 36, 48, 72, 96, 144, 192, 288, 368];

  const SpectrumScale = {
    PAN_BYTE_OFFSET,
    MINIPAN_BYTE_OFFSET,

    decodePanBins(binsUint8, outFloat32) {
      const len = binsUint8 ? binsUint8.length : 0;
      const out =
        outFloat32 && outFloat32.length >= len ? outFloat32 : new Float32Array(len);
      for (let i = 0; i < len; i++) {
        out[i] = binsUint8[i] - PAN_BYTE_OFFSET;
      }
      return out;
    },

    decodeMiniPanBins(binsUint8, outFloat32) {
      const len = binsUint8 ? binsUint8.length : 0;
      const out =
        outFloat32 && outFloat32.length >= len ? outFloat32 : new Float32Array(len);
      for (let i = 0; i < len; i++) {
        out[i] = binsUint8[i] - MINIPAN_BYTE_OFFSET;
      }
      return out;
    },

    sUnitForDbm(dBm) {
      const val = Number.isFinite(dBm) ? dBm : -127;
      if (val <= -73) {
        const sUnits = clamp((val + 127) / 6, 0, 9);
        const sInt = Math.round(sUnits);
        const label = 'S' + sInt;
        return {
          label,
          text: label,
          formatted: label,
          sUnits,
          overDb: 0,
          dBm: val,
        };
      }
      const overDb = Math.max(0, Math.round(val + 73));
      const label = overDb > 0 ? 'S9+' + overDb : 'S9';
      return {
        label,
        text: label,
        formatted: label,
        sUnits: 9,
        overDb,
        dBm: val,
      };
    },
  };

  const SpectrumGeometry = {
    clamp,
    SPAN_LADDER_KHZ,

    computeCrop(userSpanHz, tierKHz) {
      const safeTierKHz = Number.isFinite(tierKHz) && tierKHz > 0 ? tierKHz : 48;
      const tierSpanHz = Math.max(1000, safeTierKHz * 1000);
      const spanHz =
        Number.isFinite(userSpanHz) && userSpanHz > 0 ? userSpanHz : tierSpanHz;
      const spanRatio = clamp(spanHz / tierSpanHz, 0.01, 1.0);
      const leftRatio = 0.5 * (1.0 - spanRatio);
      const rightRatio = leftRatio + spanRatio;
      return {
        tierSpanHz,
        spanRatio,
        leftRatio,
        rightRatio,
      };
    },

    computeViewportCrop(viewCenterHz, viewSpanHz, streamCenterHz, tierKHz) {
      const safeTierKHz = Number.isFinite(tierKHz) && tierKHz > 0 ? tierKHz : 48;
      const tierSpanHz = Math.max(1000, safeTierKHz * 1000);
      const spanHz =
        Number.isFinite(viewSpanHz) && viewSpanHz > 0 ? viewSpanHz : tierSpanHz;
      if (!Number.isFinite(viewCenterHz) || !Number.isFinite(streamCenterHz)) {
        const spanRatio = clamp(spanHz / tierSpanHz, 0.01, 1.0);
        const leftRatio = 0.5 * (1.0 - spanRatio);
        return {
          tierSpanHz,
          spanRatio,
          leftRatio,
          rightRatio: leftRatio + spanRatio,
        };
      }
      const spanRatio = Math.max(0.005, spanHz / tierSpanHz);
      const streamLeftHz = streamCenterHz - tierSpanHz * 0.5;
      const viewLeftHz = viewCenterHz - spanHz * 0.5;
      const leftRatio = (viewLeftHz - streamLeftHz) / tierSpanHz;
      return {
        tierSpanHz,
        spanRatio,
        leftRatio,
        rightRatio: leftRatio + spanRatio,
      };
    },

    displayMarkerHz(rxState, cwPitchHz = 500) {
      const freq = rxState && Number.isFinite(rxState.freqHz) ? rxState.freqHz : 14074000;
      const mode = rxState ? rxState.mode : 2;
      const pitch = Number.isFinite(cwPitchHz) ? cwPitchHz : 500;
      if (mode === 3) return freq + pitch;
      if (mode === 7) return freq - pitch;
      return freq;
    },

    computePassbandRange(rxState, cwPitchHz = 500) {
      const carrierHz =
        rxState && Number.isFinite(rxState.freqHz) ? rxState.freqHz : 14074000;
      const bw = rxState && Number.isFinite(rxState.bwHz) ? rxState.bwHz : 2400;
      const mode = rxState ? rxState.mode : 2;
      const dataSubMode =
        rxState && Number.isFinite(rxState.dataSubMode) ? rxState.dataSubMode : 0;
      const ifShift =
        rxState && Number.isFinite(rxState.ifShiftHz) ? rxState.ifShiftHz : 0;
      const pitch = Number.isFinite(cwPitchHz) ? cwPitchHz : 500;

      let centerHz = carrierHz;
      if (mode === 2) {
        // USB
        centerHz = carrierHz + ifShift;
      } else if (mode === 1) {
        // LSB
        centerHz = carrierHz - ifShift;
      } else if (mode === 3) {
        // CW
        centerHz = carrierHz + (ifShift || pitch);
      } else if (mode === 7) {
        // CW-R
        centerHz = carrierHz - (ifShift || pitch);
      } else if (mode === 6 || mode === 9) {
        // DATA / DATA-R
        if (dataSubMode === 1 || dataSubMode === 2) {
          // AFSK-A / FSK-D
          centerHz = mode === 9 ? carrierHz + 85 : carrierHz - 85;
        } else if (dataSubMode === 3) {
          // PSK-D
          centerHz = carrierHz;
        } else {
          // DATA-A (0)
          centerHz = mode === 9 ? carrierHz - ifShift : carrierHz + ifShift;
        }
      } else {
        // AM (5), FM (4), or fallback
        centerHz = carrierHz;
      }

      return {
        carrierHz,
        centerHz,
        lowHz: centerHz - bw / 2,
        highHz: centerHz + bw / 2,
      };
    },

    computeTxOverlay(snapshot) {
      const snap = snapshot || {};
      const splitEnabled = Boolean(snap.splitEnabled);
      const xitEnabled = Boolean(snap.xitEnabled);
      const txVfo = splitEnabled ? 'B' : 'A';
      const txState = (txVfo === 'B' ? snap.rxB : snap.rxA) || snap.rxA || {};
      const baseFreqHz = Number.isFinite(txState.freqHz) ? txState.freqHz : 14074000;
      const xitOffsetHz =
        xitEnabled && Number.isFinite(txState.ritOffsetHz) ? txState.ritOffsetHz : 0;
      const txDialHz = baseFreqHz + xitOffsetHz;
      const cwPitchHz = Number.isFinite(snap.cwPitchHz) ? snap.cwPitchHz : 500;
      const pb = SpectrumGeometry.computePassbandRange(
        Object.assign({}, txState, { freqHz: txDialHz }),
        cwPitchHz
      );
      return {
        txVfo,
        carrierHz: pb.carrierHz,
        centerHz: pb.centerHz,
        lowHz: pb.lowHz,
        highHz: pb.highHz,
        isSplitOrXit: Boolean(splitEnabled || xitEnabled),
        active: Boolean(snap.txActive || snap.atuTuning),
        txTestMode: Boolean(snap.txTestMode),
      };
    },

    rfFreqFromX(xPx, plotLeftPx, plotWidthPx, panCenterHz, userSpanHz) {
      if (!(plotWidthPx > 0)) return panCenterHz;
      const u = clamp((xPx - plotLeftPx) / plotWidthPx, 0, 1);
      return panCenterHz - userSpanHz / 2 + u * userSpanHz;
    },

    xFromRfFreq(freqHz, plotLeftPx, plotWidthPx, panCenterHz, userSpanHz) {
      if (!(userSpanHz > 0)) return plotLeftPx + plotWidthPx / 2;
      const u = (freqHz - (panCenterHz - userSpanHz / 2)) / userSpanHz;
      return plotLeftPx + u * plotWidthPx;
    },

    dialFreqFromClick({
      xPx,
      plotLeftPx,
      plotWidthPx,
      panCenterHz,
      userSpanHz,
      mode,
      cwPitchHz = 500,
      stepHz = 100,
      fine = false,
    }) {
      const rfHz = SpectrumGeometry.rfFreqFromX(
        xPx,
        plotLeftPx,
        plotWidthPx,
        panCenterHz,
        userSpanHz
      );
      const pitch = Number.isFinite(cwPitchHz) ? cwPitchHz : 500;
      let rawDial = rfHz;
      if (mode === 3) {
        rawDial = rfHz - pitch;
      } else if (mode === 7) {
        rawDial = rfHz + pitch;
      }
      const step = fine ? 1 : stepHz || 100;
      return clamp(Math.round(rawDial / step) * step, 100000, 54000000);
    },
  };

  class PowerAverager {
    constructor(binCountOrOpts = 1024, depth = 1) {
      let bins = 1024;
      let initDepth = depth;
      if (binCountOrOpts && typeof binCountOrOpts === 'object') {
        bins = binCountOrOpts.binCount || 1024;
        initDepth = binCountOrOpts.depth || 1;
      } else if (Number.isFinite(binCountOrOpts)) {
        bins = binCountOrOpts;
      }
      this.binCount = Math.max(1, Math.floor(bins));
      this.depth = clamp(Math.round(initDepth || 1), 1, 20);
      this._allocate(this.binCount, this.depth);
    }

    _allocate(binCount, depth) {
      this.binCount = binCount;
      this.depth = depth;
      this.ring = new Float32Array(depth * binCount);
      this.sumMw = new Float64Array(binCount);
      this.avgDbm = new Float32Array(binCount);
      this.shownDbm = new Float32Array(binCount);
      this.peakDbm = new Float32Array(binCount);
      this.writeIdx = 0;
      this.frameCount = 0;
      this._hasFrame = false;
      this.avgDbm.fill(-140);
      this.shownDbm.fill(-140);
      this.peakDbm.fill(-140);
    }

    clear() {
      this.ring.fill(0);
      this.sumMw.fill(0);
      this.avgDbm.fill(-140);
      this.shownDbm.fill(-140);
      this.peakDbm.fill(-140);
      this.writeIdx = 0;
      this.frameCount = 0;
      this._hasFrame = false;
    }

    resetPeakHold() {
      this.peakDbm.set(this.avgDbm);
    }

    _ensureSize(n, newDepth) {
      if (n !== this.binCount) {
        this._allocate(n, newDepth);
        return;
      }
      if (newDepth === this.depth) return;

      const oldDepth = this.depth;
      const newRing = new Float32Array(newDepth * n);
      const keep = Math.min(this.frameCount, newDepth);
      const startAge = keep;
      const newSum = new Float64Array(n);

      for (let k = 0; k < keep; k++) {
        const oldSlot =
          ((this.writeIdx - startAge + k) % oldDepth + oldDepth) % oldDepth;
        const srcOff = oldSlot * n;
        const dstOff = k * n;
        for (let i = 0; i < n; i++) {
          const val = this.ring[srcOff + i];
          newRing[dstOff + i] = val;
          newSum[i] += val;
        }
      }

      this.ring = newRing;
      this.sumMw = newSum;
      this.depth = newDepth;
      this.frameCount = keep;
      this.writeIdx = keep % newDepth;
    }

    push(rawDbmBins, avgCount) {
      if (!rawDbmBins || rawDbmBins.length === 0) {
        return {
          avgDbm: this.avgDbm,
          shownDbm: this.shownDbm,
          peakDbm: this.peakDbm,
        };
      }

      const n = rawDbmBins.length;
      const targetDepth = clamp(
        Math.round(avgCount === undefined ? this.depth : avgCount || 1),
        1,
        20
      );
      this._ensureSize(n, targetDepth);

      const evicting = this.frameCount >= this.depth;
      const rowOffset = this.writeIdx * n;
      const denom = evicting ? this.depth : this.frameCount + 1;
      const hasFrame = this._hasFrame;
      const smooth = targetDepth > 1;

      for (let i = 0; i < n; i++) {
        const dbm = rawDbmBins[i];
        const mw = Number.isFinite(dbm) ? Math.pow(10, dbm / 10) : 1e-18;
        if (evicting) {
          this.sumMw[i] = Math.max(0, this.sumMw[i] - this.ring[rowOffset + i]) + mw;
        } else {
          this.sumMw[i] += mw;
        }
        this.ring[rowOffset + i] = mw;

        const avg = 10 * Math.log10(Math.max(1e-18, this.sumMw[i] / denom));
        this.avgDbm[i] = avg;

        if (!hasFrame) {
          this.shownDbm[i] = avg;
          this.peakDbm[i] = avg;
        } else {
          this.shownDbm[i] = smooth
            ? this.shownDbm[i] + 0.5 * (avg - this.shownDbm[i])
            : avg;
          this.peakDbm[i] = Math.max(avg, this.peakDbm[i] - 0.12);
        }
      }

      this.writeIdx = (this.writeIdx + 1) % this.depth;
      if (!evicting) {
        this.frameCount++;
      }
      this._hasFrame = true;

      return {
        avgDbm: this.avgDbm,
        shownDbm: this.shownDbm,
        peakDbm: this.peakDbm,
      };
    }
  }

  class WaterfallRowMapper {
    static mapRow(avgDbmBins, opts = {}, outUint8) {
      const n = avgDbmBins ? avgDbmBins.length : 0;
      const out =
        outUint8 && outUint8.length >= n ? outUint8 : new Uint8Array(n);
      if (n === 0) return out;

      const refDbm = Number.isFinite(opts.refDbm) ? opts.refDbm : -110;
      const rawScale =
        Number.isFinite(opts.scaleDb) && opts.scaleDb > 0 ? opts.scaleDb : 80;
      const spanDb = clamp(rawScale, 10, 150);
      const wbs =
        Number.isFinite(opts.wfBlack) && opts.wfBlack >= 5 && opts.wfBlack <= 30
          ? opts.wfBlack
          : 14;
      const lowDbm = refDbm - spanDb * (wbs / 40.0);
      const invRange = 1.0 / Math.max(1.0, spanDb);

      for (let i = 0; i < n; i++) {
        const val = avgDbmBins[i];
        const norm = Number.isFinite(val) ? (val - lowDbm) * invRange : 0;
        const t = norm <= 0 ? 0 : norm >= 1 ? 1 : norm;
        out[i] = 1 + Math.round(t * 254);
      }
      return out;
    }

    mapRow(avgDbmBins, opts, outUint8) {
      return WaterfallRowMapper.mapRow(avgDbmBins, opts, outUint8);
    }
  }

  K4.SpectrumScale = SpectrumScale;
  K4.SpectrumGeometry = SpectrumGeometry;
  K4.PowerAverager = PowerAverager;
  K4.WaterfallRowMapper = WaterfallRowMapper;
})();
