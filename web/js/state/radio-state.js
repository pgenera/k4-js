'use strict';

(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const BANDS = K4.BANDS || [];
  const MAX_DECODED_TEXT = 200;
  const MAX_SENSOR_HISTORY = 240;

  /**
   * Compute next independent LMS NR / SSNR per-RX state and derived nrMode/nrOn/nrLevel fields.
   * @param {Object} rxTarget
   * @param {'lms'|'ssnr'} kind
   * @param {number} modeDigit
   * @param {number|null} rawLevel
   * @returns {Object}
   */
  function computeNrPatch(rxTarget, kind, modeDigit, rawLevel) {
    const state = {
      lmsNrOn: Boolean(rxTarget.lmsNrOn),
      lmsNrLevel: Number.isFinite(rxTarget.lmsNrLevel) ? rxTarget.lmsNrLevel : 4,
      lmsNrLastUsed: Boolean(rxTarget.lmsNrLastUsed),
      ssnrOn: Boolean(rxTarget.ssnrOn),
      ssnrLevel: Number.isFinite(rxTarget.ssnrLevel) ? rxTarget.ssnrLevel : 5,
      ssnrLastUsed: Boolean(rxTarget.ssnrLastUsed),
    };
    const isSsnr = kind === 'ssnr';
    const curPrefix = isSsnr ? 'ssnr' : 'lmsNr';
    const otherPrefix = isSsnr ? 'lmsNr' : 'ssnr';
    const prevLmsLastUsed = state.lmsNrLastUsed;
    const prevSsnrLastUsed = state.ssnrLastUsed;

    if (rawLevel !== null && rawLevel !== undefined) {
      state[`${curPrefix}Level`] = rawLevel;
    }
    if (modeDigit === 1 && state[`${curPrefix}Level`] > 0) {
      state[`${curPrefix}On`] = true;
      state[`${curPrefix}LastUsed`] = false;
      state[`${otherPrefix}On`] = false;
      state[`${otherPrefix}LastUsed`] = false;
    } else {
      state[`${curPrefix}On`] = false;
      state[`${curPrefix}LastUsed`] = modeDigit === 2;
      if (modeDigit === 2) {
        state[`${otherPrefix}LastUsed`] = false;
      }
    }

    let nrMode = rxTarget.nrMode === 'ssnr' ? 'ssnr' : 'lms';
    if (state.lmsNrOn) {
      nrMode = 'lms';
    } else if (state.ssnrOn) {
      nrMode = 'ssnr';
    } else if (state.ssnrLastUsed && !prevSsnrLastUsed) {
      nrMode = 'ssnr';
    } else if (state.lmsNrLastUsed && !prevLmsLastUsed) {
      nrMode = 'lms';
    } else if (state.ssnrLastUsed && !state.lmsNrLastUsed && rxTarget.nrMode !== 'lms') {
      nrMode = 'ssnr';
    } else if (state.lmsNrLastUsed && !state.ssnrLastUsed && rxTarget.nrMode !== 'ssnr') {
      nrMode = 'lms';
    }

    const nrOn = state.lmsNrOn || state.ssnrOn;
    const nrLevel = nrMode === 'ssnr' ? state.ssnrLevel : state.lmsNrLevel;
    return Object.assign(state, { nrMode, nrOn, nrLevel });
  }

  /**
   * Look up the matching amateur band definition for `freqHz`, or null for general coverage.
   * @param {number} freqHz
   * @returns {Object|null}
   */
  function bandForFreq(freqHz) {
    if (!Number.isFinite(freqHz)) return null;
    for (let i = 0; i < BANDS.length; i++) {
      const b = BANDS[i];
      if (freqHz >= b.startHz && freqHz <= b.endHz) {
        return b;
      }
    }
    return null;
  }

  /**
   * Create a default per-receiver state object.
   * @param {number} [defaultFreqHz=14074000]
   * @returns {Object}
   */
  function createDefaultRxState(defaultFreqHz = 14074000) {
    return {
      freqHz: defaultFreqHz,
      mode: 6, // DATA
      dataSubMode: 0, // DATA-A
      bwHz: 2700,
      ifShiftHz: 1500,
      stepHz: 100,
      stepIdx: 2,
      locked: false,
      preamp: 0,
      attenDb: 0,
      afGain: 30,
      rfGainDb: 0,
      squelch: 0,
      nbOn: false,
      nbLevel: 5,
      lmsNrOn: false,
      lmsNrLevel: 4,
      lmsNrLastUsed: false,
      ssnrOn: false,
      ssnrLevel: 5,
      ssnrLastUsed: false,
      nrMode: 'lms',
      nrOn: false,
      nrLevel: 4,
      notchOn: false,
      notchHz: 750,
      agc: 1,
      apfOn: false,
      apfBwIdx: 0,
      sMeterDbm: -115,
      panSpanHz: 48000,
      panRefDbm: -110,
      panScaleDb: 80,
      wfBlack: 14,
      autoRef: false,
      miniPan: false,
      miniPanAvailable: true,
      textDecodeMode: 0,
      textDecodeThreshold: 0,
      textDecodeLines: 1,
      textDecodeEnabled: false,
      panCenterHz: defaultFreqHz,
      panTierKHz: 48,
      noiseFloorDbm: -120,
      adcOverflow: false,
      cor: false,
      panNbMode: 0,
      panNbLevel: 0,
      ifCenterHz: null,
      ritOn: false,
      ritOffsetHz: 0,
      band: bandForFreq(defaultFreqHz),
    };
  }

  function createDefaultTelemetry() {
    return {
      supplyVolts: null,
      supplyAmps: null,
      peakSupplyAmps: null,
      rxBaselineVolts: null,
      txVoltDrop: null,
      paAmps: null,
      fpTempC: null,
      cpuTempC: null,
      paTempC: null,
      lpaTempC: null,
      dapTempC: null,
      ducTempC: null,
      ducDrive: null,
      updatedAt: null,
    };
  }

  function createDefaultTxMeters() {
    return {
      alcBars: 0,
      compDb: 0,
      fwdWatts: 0,
      swr: 0,
      peakFwdWatts: 0,
      peakSwr: 0,
      active: false,
      updatedAt: null,
    };
  }

  function createDefaultAntennaNames() {
    return { 1: 'ANT1', 2: 'ANT2', 3: 'ANT3', 4: 'RX1', 5: 'RX2' };
  }

  function createDefaultState() {
    const rxA = createDefaultRxState(14074000);
    const rxB = Object.assign(createDefaultRxState(14025000), {
      mode: 3, // CW
      bwHz: 500,
      ifShiftHz: 500,
    });
    return {
      rxA,
      rxB,
      connection: {
        status: 'disconnected',
        wsUrl: '',
        subprotocol: '',
        authStatus: 'none',
        error: null,
        rttMs: null,
        radioId: '',
        serial: '',
      },
      operatingPolicy: 'rx-only',
      txPosture: 'rx-only',
      pttHeld: false,
      txActive: false,
      txTestMode: false,
      txInhibit: false,
      cwPitchHz: 500,
      subRxEnabled: false,
      splitEnabled: false,
      xitEnabled: false,
      vfoLinked: false,
      diversityEnabled: false,
      activeTxVfo: 'A',
      powerWatts: 10,
      powerRange: 'L',
      txMeters: createDefaultTxMeters(),
      hasAtu: true,
      hasKpa4: true,
      hasHdr: false,
      hasLinearAmp: false,
      atuMode: 2,
      atuTuning: false,
      atuTuneKind: null,
      atuMatchedSwr: null,
      atuLastTunedFreqHz: null,
      atuSearchWindowUntil: 0,
      txAntenna: 1,
      txAntennaMask: [true, true, true],
      antennaNames: createDefaultAntennaNames(),
      micGain: 15,
      micInput: 4,
      compDbSet: 0,
      monCw: 5,
      monData: 5,
      monVoice: 2,
      voxCw: true,
      voxVoice: false,
      voxData: false,
      cwSpeedWpm: 20,
      keyerIambic: 'A',
      keyerPaddleOrder: 'N',
      keyerWeight: 110,
      keyerBufferFull: false,
      txBufferCount: 0,
      dvrSlot: 0,
      dvrPlaying: false,
      txTimeoutSec: 180,
      txStartedAt: null,
      panAvg: 4,
      dualPanMode: 0,
      panFrozen: false,
      panFps: 20,
      displayMode: 1,
      waterfallHeightPct: 60,
      fixedTune: false,
      hasSubRx: true,
      hasKrx4: true,
      hasDiversity: true,
      radioModel: 'K4D',
      optionModules: '',
      audioMix: 'A.B',
      encodeMode: 1,
      streamingLatency: 2,
      telemetry: createDefaultTelemetry(),
      decodedText: [],
      band: rxA.band,
    };
  }

  /**
   * Reactive store holding K4 receiver, transmitter, ATU, panadapter, audio, and connection telemetry state.
   */
  class RadioState extends K4.EventEmitter {
    constructor(initial = null) {
      super();
      this._state = createDefaultState();
      this._nextTextId = 0;
      this._lastNonZeroTuneSwr = null;
      this._sensorHistory = [];
      if (initial && typeof initial === 'object') {
        if (initial.rxA) Object.assign(this._state.rxA, initial.rxA);
        if (initial.rxB) Object.assign(this._state.rxB, initial.rxB);
        if (initial.connection) Object.assign(this._state.connection, initial.connection);
        if (initial.telemetry) Object.assign(this._state.telemetry, initial.telemetry);
        if (initial.txMeters) Object.assign(this._state.txMeters, initial.txMeters);
        if (Array.isArray(initial.txAntennaMask)) {
          this._state.txAntennaMask = initial.txAntennaMask.slice();
        }
        if (initial.antennaNames && typeof initial.antennaNames === 'object') {
          Object.assign(this._state.antennaNames, initial.antennaNames);
        }
        const nestedKeys = new Set([
          'rxA',
          'rxB',
          'connection',
          'telemetry',
          'txMeters',
          'txAntennaMask',
          'antennaNames',
          'decodedText',
        ]);
        for (const k of Object.keys(initial)) {
          if (!nestedKeys.has(k)) {
            this._state[k] = initial[k];
          }
        }
        this._state.rxA.band = bandForFreq(this._state.rxA.freqHz);
        this._state.rxB.band = bandForFreq(this._state.rxB.freqHz);
        this._state.band = this._state.rxA.band;
      }
    }

    /**
     * Derive band metadata for a frequency in Hz.
     * @param {number} freqHz
     * @returns {Object|null}
     */
    bandForFreq(freqHz) {
      return bandForFreq(freqHz);
    }

    /**
     * Return a cloned snapshot of the full radio state.
     * @returns {Object}
     */
    getSnapshot() {
      return {
        rxA: Object.assign({}, this._state.rxA),
        rxB: Object.assign({}, this._state.rxB),
        connection: Object.assign({}, this._state.connection),
        operatingPolicy: this._state.operatingPolicy,
        txPosture: this._state.txPosture,
        pttHeld: this._state.pttHeld,
        txActive: this._state.txActive,
        txTestMode: this._state.txTestMode,
        txInhibit: this._state.txInhibit,
        cwPitchHz: this._state.cwPitchHz,
        subRxEnabled: this._state.subRxEnabled,
        splitEnabled: this._state.splitEnabled,
        xitEnabled: this._state.xitEnabled,
        vfoLinked: this._state.vfoLinked,
        diversityEnabled: this._state.diversityEnabled,
        activeTxVfo: this._state.activeTxVfo,
        powerWatts: this._state.powerWatts,
        powerRange: this._state.powerRange,
        txMeters: Object.assign({}, this._state.txMeters),
        hasAtu: this._state.hasAtu,
        hasKpa4: this._state.hasKpa4,
        hasHdr: this._state.hasHdr,
        hasLinearAmp: this._state.hasLinearAmp,
        atuMode: this._state.atuMode,
        atuTuning: this._state.atuTuning,
        atuTuneKind: this._state.atuTuneKind,
        atuMatchedSwr: this._state.atuMatchedSwr,
        atuLastTunedFreqHz: this._state.atuLastTunedFreqHz,
        atuSearchWindowUntil: this._state.atuSearchWindowUntil,
        txAntenna: this._state.txAntenna,
        txAntennaMask: this._state.txAntennaMask.slice(),
        antennaNames: Object.assign({}, this._state.antennaNames),
        micGain: this._state.micGain,
        micInput: this._state.micInput,
        compDbSet: this._state.compDbSet,
        monCw: this._state.monCw,
        monData: this._state.monData,
        monVoice: this._state.monVoice,
        voxCw: this._state.voxCw,
        voxVoice: this._state.voxVoice,
        voxData: this._state.voxData,
        cwSpeedWpm: this._state.cwSpeedWpm,
        keyerIambic: this._state.keyerIambic,
        keyerPaddleOrder: this._state.keyerPaddleOrder,
        keyerWeight: this._state.keyerWeight,
        keyerBufferFull: this._state.keyerBufferFull,
        txBufferCount: this._state.txBufferCount,
        dvrSlot: this._state.dvrSlot,
        dvrPlaying: this._state.dvrPlaying,
        txTimeoutSec: this._state.txTimeoutSec,
        txStartedAt: this._state.txStartedAt,
        panAvg: this._state.panAvg,
        dualPanMode: this._state.dualPanMode,
        panFrozen: this._state.panFrozen,
        panFps: this._state.panFps,
        displayMode: this._state.displayMode,
        waterfallHeightPct: this._state.waterfallHeightPct,
        fixedTune: this._state.fixedTune,
        hasSubRx: this._state.hasSubRx,
        hasKrx4: this._state.hasKrx4,
        hasDiversity: this._state.hasDiversity,
        radioModel: this._state.radioModel,
        optionModules: this._state.optionModules,
        audioMix: this._state.audioMix,
        encodeMode: this._state.encodeMode,
        streamingLatency: this._state.streamingLatency,
        telemetry: Object.assign({}, this._state.telemetry),
        decodedText: this._state.decodedText.map((d) => ({ ...d })),
        band: this._state.band,
      };
    }

    /**
     * Alias for getSnapshot().
     * @returns {Object}
     */
    getState() {
      return this.getSnapshot();
    }

    /**
     * Return a cloned snapshot for receiver 'A' or 'B'.
     * @param {'A'|'B'} rx
     * @returns {Object}
     */
    getRx(rx) {
      return Object.assign({}, rx === 'B' ? this._state.rxB : this._state.rxA);
    }

    _emitChange(changedKey) {
      this.emit('change', this.getSnapshot(), changedKey);
    }

    /**
     * Merge a partial update into connection metadata and notify subscribers.
     * @param {Object} patch
     */
    updateConnection(patch) {
      if (!patch || typeof patch !== 'object') return;
      Object.assign(this._state.connection, patch);
      this._emitChange('connection');
    }

    /**
     * Update local TX safety posture, policy, and PTT flags.
     * @param {Object} patch
     * @param {string} [changedKey='txPosture']
     */
    updateTxSafety(patch, changedKey = 'txPosture') {
      if (!patch || typeof patch !== 'object') return;
      Object.assign(this._state, patch);
      this._emitChange(changedKey);
    }

    /**
     * Clear held peak TX meters at the start of a new transmission/tune cycle.
     */
    resetTxMeterPeaks() {
      this._state.txMeters.peakFwdWatts = 0;
      this._state.txMeters.peakSwr = 0;
      this._emitChange('txMeters');
    }

    _resetLiveTxMetersKeepingPeaks() {
      const m = this._state.txMeters;
      m.alcBars = 0;
      m.compDb = 0;
      m.fwdWatts = 0;
      m.swr = 0;
      m.active = false;
      m.updatedAt = Date.now();
      this._state.telemetry.txVoltDrop = this._state.telemetry.rxBaselineVolts !== null ? 0 : null;
    }

    _sampleSensorsNow(ts = Date.now()) {
      const t = this._state.telemetry || {};
      const m = this._state.txMeters || {};
      const txOrTune = Boolean(this._state.txActive || this._state.atuTuning);
      return {
        ts,
        vs: Number.isFinite(t.supplyVolts) ? t.supplyVolts : null,
        is: Number.isFinite(t.supplyAmps) ? t.supplyAmps : null,
        pt: Number.isFinite(t.paTempC) ? t.paTempC : null,
        lt: Number.isFinite(t.lpaTempC) ? t.lpaTempC : null,
        tf: Number.isFinite(t.fpTempC) ? t.fpTempC : null,
        sys: Number.isFinite(t.cpuTempC) ? t.cpuTempC : null,
        fwd: txOrTune && Number.isFinite(m.fwdWatts) ? m.fwdWatts : 0,
        swr: txOrTune && Number.isFinite(m.swr) && m.swr > 0 ? m.swr : 0,
      };
    }

    _recordSensorSample(minIntervalMs = 200) {
      const now = Date.now();
      const sample = this._sampleSensorsNow(now);
      const hasAny =
        sample.vs !== null ||
        sample.is !== null ||
        sample.pt !== null ||
        sample.lt !== null ||
        sample.tf !== null ||
        sample.sys !== null ||
        sample.fwd > 0 ||
        sample.swr > 0;
      if (!hasAny) return false;
      const hist = this._sensorHistory;
      const last = hist.length > 0 ? hist[hist.length - 1] : null;
      if (last && now - last.ts < minIntervalMs) {
        Object.assign(last, sample);
        return true;
      }
      hist.push(sample);
      if (hist.length > MAX_SENSOR_HISTORY) {
        hist.splice(0, hist.length - MAX_SENSOR_HISTORY);
      }
      return true;
    }

    /**
     * Sample current telemetry and TX meters into the rolling history buffer.
     * @returns {boolean}
     */
    recordSensorTick() {
      return this._recordSensorSample(450);
    }

    /**
     * Return time-series points for a given sensor metric over the trailing window.
     * @param {'vs'|'is'|'pt'|'lt'|'tf'|'sys'|'fwd'|'swr'} metricKey
     * @param {number} [windowSec=180]
     * @returns {{ metric: string, windowSec: number, points: Array<{ts: number, value: number}>, min: number|null, max: number|null, current: number|null }}
     */
    getSensorHistory(metricKey, windowSec = 180) {
      const now = Date.now();
      const winSec = Math.max(10, Number(windowSec) || 180);
      const cutoff = now - winSec * 1000;
      const points = [];
      let min = null;
      let max = null;
      for (let i = 0; i < this._sensorHistory.length; i++) {
        const entry = this._sensorHistory[i];
        if (!entry || entry.ts < cutoff) continue;
        const val = entry[metricKey];
        if (!Number.isFinite(val)) continue;
        points.push({ ts: entry.ts, value: val });
        if (min === null || val < min) min = val;
        if (max === null || val > max) max = val;
      }
      const curSample = this._sampleSensorsNow(now);
      const current = Number.isFinite(curSample[metricKey]) ? curSample[metricKey] : null;
      return {
        metric: String(metricKey || ''),
        windowSec: winSec,
        points,
        min,
        max,
        current,
      };
    }

    /**
     * Merge a partial update into receiver A or B state and notify subscribers.
     * @param {'A'|'B'} rx
     * @param {Object} patch
     * @param {string} [changedKey]
     */
    updateRx(rx, patch, changedKey) {
      if (!patch || typeof patch !== 'object') return;
      const key = rx === 'B' ? 'rxB' : 'rxA';
      const target = this._state[key];
      Object.assign(target, patch);
      if (Object.prototype.hasOwnProperty.call(patch, 'freqHz')) {
        target.band = bandForFreq(target.freqHz);
        if (key === 'rxA') {
          this._state.band = target.band;
        }
      }
      this._emitChange(changedKey || key);
    }

    /**
     * Merge top-level radio state fields and notify subscribers.
     * @param {Object} patch
     * @param {string} [changedKey]
     */
    update(patch, changedKey) {
      if (!patch || typeof patch !== 'object') return;
      Object.assign(this._state, patch);
      this._emitChange(changedKey || Object.keys(patch)[0] || 'state');
    }

    /**
     * Update panadapter center/tier/noiseFloor metadata from a 0x02 PAN frame.
     * Emits 'change' only when observable metadata meaningfully changes.
     * @param {Object} panPkt
     */
    applyPanMeta(panPkt) {
      if (!panPkt) return;
      const rxKey = panPkt.rx === 'B' ? 'rxB' : 'rxA';
      const target = this._state[rxKey];
      let changed = false;

      if (Number.isFinite(panPkt.centerFreqHz) && target.panCenterHz !== panPkt.centerFreqHz) {
        target.panCenterHz = panPkt.centerFreqHz;
        changed = true;
      }
      if (Number.isFinite(panPkt.sampleRateKHz) && target.panTierKHz !== panPkt.sampleRateKHz) {
        target.panTierKHz = panPkt.sampleRateKHz;
        changed = true;
      }
      if (
        Number.isFinite(panPkt.noiseFloorDbm) &&
        Math.abs(target.noiseFloorDbm - panPkt.noiseFloorDbm) >= 0.5
      ) {
        target.noiseFloorDbm = panPkt.noiseFloorDbm;
        changed = true;
      }

      if (changed) {
        this._emitChange(`${rxKey}.panMeta`);
      }
    }

    /**
     * Clear the buffered decoded CW/RTTY/PSK text history.
     */
    clearDecodedText() {
      if (this._state.decodedText.length === 0) return;
      this._state.decodedText = [];
      this._emitChange('decodedText');
    }

    /**
     * Apply a parsed CAT command object from K4.CatCodec.parseCommand().
     * @param {Object|null} parsed
     * @returns {boolean} True if state was updated
     */
    applyParsedCat(parsed) {
      if (!parsed || !parsed.kind) return false;

      const rxKey = parsed.rx === 'B' ? 'rxB' : 'rxA';
      const rxTarget = this._state[rxKey];

      switch (parsed.kind) {
        case 'freq':
          this.updateRx(
            parsed.rx,
            { freqHz: parsed.freqHz },
            `${rxKey}.freqHz`
          );
          return true;

        case 'mode':
          this.updateRx(parsed.rx, { mode: parsed.modeCode }, `${rxKey}.mode`);
          return true;

        case 'dataSubMode':
          this.updateRx(parsed.rx, { dataSubMode: parsed.subMode }, `${rxKey}.dataSubMode`);
          return true;

        case 'bw':
          this.updateRx(parsed.rx, { bwHz: parsed.bwHz }, `${rxKey}.bwHz`);
          return true;

        case 'ifShift':
          this.updateRx(parsed.rx, { ifShiftHz: parsed.ifShiftHz }, `${rxKey}.ifShiftHz`);
          return true;

        case 'cwPitch':
          this._state.cwPitchHz = parsed.cwPitchHz;
          this._emitChange('cwPitchHz');
          return true;

        case 'step':
          this.updateRx(
            parsed.rx,
            { stepIdx: parsed.stepIdx, stepHz: parsed.stepHz },
            `${rxKey}.stepHz`
          );
          return true;

        case 'lock':
          this.updateRx(parsed.rx, { locked: parsed.locked }, `${rxKey}.locked`);
          return true;

        case 'preamp':
          this.updateRx(parsed.rx, { preamp: parsed.preamp }, `${rxKey}.preamp`);
          return true;

        case 'atten':
          this.updateRx(parsed.rx, { attenDb: parsed.attenDb }, `${rxKey}.attenDb`);
          return true;

        case 'afGain':
          this.updateRx(parsed.rx, { afGain: parsed.afGain }, `${rxKey}.afGain`);
          return true;

        case 'rfGain':
          this.updateRx(parsed.rx, { rfGainDb: parsed.rfGainDb }, `${rxKey}.rfGainDb`);
          return true;

        case 'squelch':
          this.updateRx(parsed.rx, { squelch: parsed.squelch }, `${rxKey}.squelch`);
          return true;

        case 'nb': {
          const patch = { nbOn: parsed.nbOn };
          if (parsed.nbLevel !== null && parsed.nbLevel !== undefined) {
            patch.nbLevel = parsed.nbLevel;
          }
          this.updateRx(parsed.rx, patch, `${rxKey}.nb`);
          return true;
        }

        case 'nr': {
          const kind = parsed.nrKind === 'ssnr' ? 'ssnr' : 'lms';
          const modeDigit =
            parsed.modeDigit !== undefined && parsed.modeDigit !== null
              ? parsed.modeDigit
              : parsed.nrOn
              ? 1
              : parsed.lastUsed
              ? 2
              : 0;
          const rawLevel =
            parsed.level !== undefined
              ? parsed.level
              : parsed.nrLevel !== undefined
              ? parsed.nrLevel
              : null;
          this.updateRx(parsed.rx, computeNrPatch(rxTarget, kind, modeDigit, rawLevel), `${rxKey}.nr`);
          return true;
        }

        case 'notch': {
          const patch = { notchOn: parsed.notchOn };
          if (parsed.notchHz !== null && parsed.notchHz !== undefined) {
            patch.notchHz = parsed.notchHz;
          }
          this.updateRx(parsed.rx, patch, `${rxKey}.notch`);
          return true;
        }

        case 'agc':
          this.updateRx(parsed.rx, { agc: parsed.agc }, `${rxKey}.agc`);
          return true;

        case 'apf':
          this.updateRx(
            parsed.rx,
            { apfOn: parsed.apfOn, apfBwIdx: parsed.apfBwIdx },
            `${rxKey}.apf`
          );
          return true;

        case 'smeterDbm':
        case 'smeterBars':
          if (Math.abs(rxTarget.sMeterDbm - parsed.dBm) >= 0.05) {
            this.updateRx(parsed.rx, { sMeterDbm: parsed.dBm }, `${rxKey}.sMeterDbm`);
          }
          return true;

        case 'subRx':
          this._state.subRxEnabled = parsed.subRxEnabled;
          this._emitChange('subRxEnabled');
          return true;

        case 'split':
          this._state.splitEnabled = parsed.splitEnabled;
          this._state.activeTxVfo = parsed.splitEnabled ? 'B' : 'A';
          this._emitChange('splitEnabled');
          return true;

        case 'vfoLink':
          this._state.vfoLinked = parsed.linked;
          this._emitChange('vfoLinked');
          return true;

        case 'panSpan':
          this.updateRx(parsed.rx, { panSpanHz: parsed.spanHz }, `${rxKey}.panSpanHz`);
          return true;

        case 'panRef':
          this.updateRx(parsed.rx, { panRefDbm: parsed.refDbm }, `${rxKey}.panRefDbm`);
          return true;

        case 'panScale':
          this._state.rxA.panScaleDb = parsed.scaleDb;
          this._state.rxB.panScaleDb = parsed.scaleDb;
          this._emitChange('panScaleDb');
          return true;

        case 'panAvg':
          this._state.panAvg = parsed.avg;
          this._emitChange('panAvg');
          return true;

        case 'wfBlack':
          this._state.rxA.wfBlack = parsed.wfBlack;
          this._state.rxB.wfBlack = parsed.wfBlack;
          this._emitChange('wfBlack');
          return true;

        case 'autoRef':
          this._state.rxA.autoRef = parsed.autoRef;
          this._state.rxB.autoRef = parsed.autoRef;
          this._emitChange('autoRef');
          return true;

        case 'fixedTune':
          this._state.fixedTune = Boolean(parsed.fixedTune);
          this._emitChange('fixedTune');
          return true;

        case 'optionModule':
          this._state.optionModules = parsed.optionModules || '';
          this._state.hasSubRx = Boolean(parsed.hasSubRx);
          this._state.hasKrx4 =
            typeof parsed.hasKrx4 === 'boolean' ? parsed.hasKrx4 : Boolean(parsed.hasSubRx);
          this._state.hasDiversity =
            typeof parsed.hasDiversity === 'boolean' ? parsed.hasDiversity : this._state.hasKrx4;
          this._state.radioModel =
            parsed.radioModel || (parsed.hasHdr ? 'K4HD' : (this._state.hasKrx4 ? 'K4D' : 'K4'));
          this._state.hasAtu = Boolean(parsed.hasAtu);
          this._state.hasKpa4 = Boolean(parsed.hasKpa4);
          this._state.hasHdr = Boolean(parsed.hasHdr);
          this._state.hasLinearAmp = Boolean(parsed.hasLinearAmp);
          if (!this._state.hasDiversity && this._state.diversityEnabled) {
            this._state.diversityEnabled = false;
          }
          this._emitChange('optionModules');
          return true;

        case 'textDecode':
          this.updateRx(
            parsed.rx,
            {
              textDecodeMode: parsed.mode,
              textDecodeThreshold: parsed.threshold,
              textDecodeLines: parsed.lines,
              textDecodeEnabled: Boolean(parsed.enabled),
            },
            `${rxKey}.textDecode`
          );
          return true;

        case 'dualPan':
          this._state.dualPanMode = parsed.dualPanMode;
          this._emitChange('dualPanMode');
          return true;

        case 'miniPan':
          this.updateRx(
            parsed.rx,
            {
              miniPan: parsed.miniPan,
              miniPanAvailable: parsed.miniPanAvailable !== false,
            },
            `${rxKey}.miniPan`
          );
          return true;

        case 'audioMix':
          this._state.audioMix = parsed.mix;
          this._emitChange('audioMix');
          return true;

        case 'encodeMode':
          this._state.encodeMode = parsed.encodeMode;
          this._emitChange('encodeMode');
          return true;

        case 'streamingLatency':
          this._state.streamingLatency = parsed.streamingLatency;
          this._emitChange('streamingLatency');
          return true;

        case 'band': {
          const matched = BANDS.find((b) => b.bn === parsed.bn) || null;
          if (matched) {
            this.updateRx(parsed.rx, { band: matched }, `${rxKey}.band`);
          }
          return true;
        }

        case 'adcOverflow':
          this.updateRx(
            parsed.rx,
            { adcOverflow: Boolean(parsed.adcOverflow), cor: Boolean(parsed.cor) },
            `${rxKey}.adcOverflow`
          );
          return true;

        case 'panNb':
          this.updateRx(parsed.rx, { panNbMode: parsed.panNbMode }, `${rxKey}.panNbMode`);
          return true;

        case 'panNbLevel':
          this.updateRx(parsed.rx, { panNbLevel: parsed.panNbLevel }, `${rxKey}.panNbLevel`);
          return true;

        case 'ifCenter':
          this.updateRx(parsed.rx, { ifCenterHz: parsed.ifCenterHz }, `${rxKey}.ifCenterHz`);
          return true;

        case 'rit':
          this.updateRx(parsed.rx, { ritOn: parsed.ritOn }, `${rxKey}.ritOn`);
          return true;

        case 'ritOffset':
          this.updateRx(parsed.rx, { ritOffsetHz: parsed.ritOffsetHz }, `${rxKey}.ritOffsetHz`);
          return true;

        case 'diversity':
          this._state.diversityEnabled = parsed.diversityEnabled;
          this._emitChange('diversityEnabled');
          return true;

        case 'panFrozen':
          this._state.panFrozen = parsed.panFrozen;
          this._emitChange('panFrozen');
          return true;

        case 'panFps':
          this._state.panFps = parsed.panFps;
          this._emitChange('panFps');
          return true;

        case 'displayMode':
          this._state.displayMode = parsed.displayMode;
          this._emitChange('displayMode');
          return true;

        case 'waterfallHeight':
          this._state.waterfallHeightPct = parsed.waterfallHeightPct;
          this._emitChange('waterfallHeightPct');
          return true;

        case 'systemInfo': {
          const t = this._state.telemetry;
          const f = parsed.fields || {};
          const activeTxOrTune = Boolean(this._state.txActive || this._state.atuTuning);
          let changed = false;
          if (parsed.module === 'FP') {
            if (Number.isFinite(f.VS)) {
              t.supplyVolts = f.VS;
              if (!activeTxOrTune) {
                t.rxBaselineVolts = f.VS;
                t.txVoltDrop = 0;
              } else if (Number.isFinite(t.rxBaselineVolts)) {
                t.txVoltDrop = Math.max(0, t.rxBaselineVolts - f.VS);
              }
              changed = true;
            }
            if (Number.isFinite(f.IS)) {
              t.supplyAmps = f.IS;
              if (activeTxOrTune) {
                t.peakSupplyAmps = Number.isFinite(t.peakSupplyAmps)
                  ? Math.max(t.peakSupplyAmps, f.IS)
                  : f.IS;
              }
              changed = true;
            }
            if (Number.isFinite(f.TF)) { t.fpTempC = f.TF; changed = true; }
          } else if (parsed.module === 'CP') {
            const temps = [f.T1, f.T2, f.T4].filter((v) => Number.isFinite(v));
            if (temps.length > 0) {
              t.cpuTempC = Math.max(...temps);
              changed = true;
            }
          } else if (parsed.module === 'RF') {
            if (Number.isFinite(f.PT)) { t.paTempC = f.PT; changed = true; }
            if (Number.isFinite(f.LT)) { t.lpaTempC = f.LT; changed = true; }
            if (Number.isFinite(f.PA)) { t.paAmps = f.PA; changed = true; }
          } else if (parsed.module === 'DA') {
            if (Number.isFinite(f.T)) { t.dapTempC = f.T; changed = true; }
          } else if (parsed.module === 'DU' || parsed.module === 'D0') {
            if (Number.isFinite(f.T)) { t.ducTempC = f.T; changed = true; }
            if (Number.isFinite(f.DV)) { t.ducDrive = f.DV; changed = true; }
          }
          if (changed) {
            t.updatedAt = Date.now();
            this._recordSensorSample(200);
            this._emitChange('telemetry');
          }
          return changed;
        }

        case 'txState': {
          this._state.txActive = Boolean(parsed.txActive);
          if (!this._state.txActive && !this._state.atuTuning) {
            this._resetLiveTxMetersKeepingPeaks();
          }
          this._emitChange('txActive');
          return true;
        }

        case 'txInhibit':
          this._state.txInhibit = Boolean(parsed.txInhibit);
          this._emitChange('txInhibit');
          return true;

        case 'txTest':
          this._state.txTestMode = Boolean(parsed.txTestMode);
          this._emitChange('txTestMode');
          return true;

        case 'ifInfo': {
          if (Number.isFinite(parsed.freqHz) && parsed.freqHz > 0) {
            this._state.rxA.freqHz = parsed.freqHz;
            this._state.rxA.band = bandForFreq(parsed.freqHz);
            this._state.band = this._state.rxA.band;
          }
          if (typeof parsed.ritOn === 'boolean') {
            this._state.rxA.ritOn = parsed.ritOn;
          }
          if (typeof parsed.xitEnabled === 'boolean') {
            this._state.xitEnabled = parsed.xitEnabled;
          }
          if (typeof parsed.splitEnabled === 'boolean') {
            this._state.splitEnabled = parsed.splitEnabled;
            this._state.activeTxVfo = parsed.splitEnabled ? 'B' : 'A';
          }
          if (Number.isFinite(parsed.modeCode) && K4.MODES && K4.MODES[parsed.modeCode]) {
            this._state.rxA.mode = parsed.modeCode;
            this._state.rxA.modeLabel = K4.MODES[parsed.modeCode];
          }
          if (typeof parsed.txActive === 'boolean') {
            this._state.txActive = parsed.txActive;
            if (!this._state.txActive && !this._state.atuTuning) {
              this._resetLiveTxMetersKeepingPeaks();
            }
          }
          this._emitChange('ifInfo');
          return true;
        }

        case 'txMeters': {
          const m = this._state.txMeters;
          const fwdWatts = this._state.powerRange === 'L' ? parsed.fwdRaw / 10 : parsed.fwdRaw;
          const swr = parsed.swrTenths > 0 ? parsed.swrTenths / 10 : 0;
          const active = Boolean(
            this._state.txActive ||
              this._state.atuTuning ||
              fwdWatts > 0 ||
              parsed.swrTenths > 0 ||
              parsed.alcBars > 0
          );
          m.alcBars = parsed.alcBars;
          m.compDb = parsed.compDb;
          m.fwdWatts = fwdWatts;
          m.swr = swr;
          m.active = active;
          m.updatedAt = Date.now();
          if (this._state.txActive || this._state.atuTuning || fwdWatts > 0 || swr > 0) {
            if (fwdWatts > (m.peakFwdWatts || 0)) m.peakFwdWatts = fwdWatts;
            if (swr > (m.peakSwr || 0)) m.peakSwr = swr;
          }
          if (
            this._state.atuTuning &&
            (this._state.atuTuneKind === 3 || this._state.atuTuneKind === 4) &&
            swr > 0
          ) {
            this._lastNonZeroTuneSwr = swr;
          }
          this._recordSensorSample(200);
          this._emitChange('txMeters');
          return true;
        }

        case 'powerOut': {
          const m = this._state.txMeters;
          const watts = Number(parsed.powerOutWatts);
          if (!Number.isFinite(watts)) return false;
          m.fwdWatts = watts;
          m.active = Boolean(
            this._state.txActive || this._state.atuTuning || watts > 0 || m.alcBars > 0
          );
          m.updatedAt = Date.now();
          if ((this._state.txActive || this._state.atuTuning || watts > 0) && watts > (m.peakFwdWatts || 0)) {
            m.peakFwdWatts = watts;
          }
          this._recordSensorSample(200);
          this._emitChange('txMeters');
          return true;
        }

        case 'powerControl':
          this._state.powerWatts = parsed.powerWatts;
          this._state.powerRange = parsed.powerRange;
          this._emitChange('powerWatts');
          return true;

        case 'atuMode':
          this._state.atuMode = parsed.atuMode;
          this._emitChange('atuMode');
          return true;

        case 'atuTune': {
          const prevTuning = this._state.atuTuning;
          const prevKind = this._state.atuTuneKind;
          if (parsed.tuning) {
            this._state.atuTuning = true;
            this._state.atuTuneKind = parsed.tuneState;
            if (!prevTuning) {
              this._lastNonZeroTuneSwr = null;
            }
          } else {
            if (prevTuning && (prevKind === 3 || prevKind === 4)) {
              const matched =
                this._state.txMeters.swr > 0
                  ? this._state.txMeters.swr
                  : this._lastNonZeroTuneSwr;
              if (Number.isFinite(matched) && matched > 0) {
                this._state.atuMatchedSwr = matched;
              }
              const txVfoKey = this._state.splitEnabled ? 'rxB' : 'rxA';
              this._state.atuLastTunedFreqHz = this._state[txVfoKey].freqHz;
              if (prevKind === 3) {
                this._state.atuSearchWindowUntil = Date.now() + 5000;
              }
            }
            this._state.atuTuning = false;
            this._state.atuTuneKind = null;
            this._lastNonZeroTuneSwr = null;
            if (!this._state.txActive) {
              this._resetLiveTxMetersKeepingPeaks();
            }
          }
          this._emitChange('atuTuning');
          return true;
        }

        case 'antenna':
          this._state.txAntenna = parsed.antenna;
          this._emitChange('txAntenna');
          return true;

        case 'txAntennaMask':
          this._state.txAntennaMask = parsed.mask.slice();
          this._emitChange('txAntennaMask');
          return true;

        case 'antennaName': {
          const defaults = createDefaultAntennaNames();
          this._state.antennaNames[parsed.port] = parsed.name || defaults[parsed.port] || `ANT${parsed.port}`;
          this._emitChange('antennaNames');
          return true;
        }

        case 'xit':
          this._state.xitEnabled = Boolean(parsed.xitEnabled);
          this._emitChange('xitEnabled');
          return true;

        case 'micGain':
          this._state.micGain = parsed.micGain;
          this._emitChange('micGain');
          return true;

        case 'compLevel':
          this._state.compDbSet = parsed.compDbSet;
          this._emitChange('compDbSet');
          return true;

        case 'txMonitor':
          if (parsed.channel === 0) {
            this._state.monCw = parsed.level;
            this._emitChange('monCw');
            return true;
          }
          if (parsed.channel === 1) {
            this._state.monData = parsed.level;
            this._emitChange('monData');
            return true;
          }
          if (parsed.channel === 2) {
            this._state.monVoice = parsed.level;
            this._emitChange('monVoice');
            return true;
          }
          return false;

        case 'micInput':
          this._state.micInput = parsed.micInput;
          this._emitChange('micInput');
          return true;

        case 'vox':
          if (parsed.modeChar === 'C') this._state.voxCw = Boolean(parsed.enabled);
          else if (parsed.modeChar === 'V') this._state.voxVoice = Boolean(parsed.enabled);
          else if (parsed.modeChar === 'D') this._state.voxData = Boolean(parsed.enabled);
          else return false;
          this._emitChange('vox');
          return true;

        case 'cwSpeed':
          this._state.cwSpeedWpm = parsed.wpm;
          this._emitChange('cwSpeedWpm');
          return true;

        case 'keyerPaddle':
          this._state.keyerIambic = parsed.iambic;
          this._state.keyerPaddleOrder = parsed.paddleOrder;
          this._state.keyerWeight = parsed.weight;
          this._emitChange('keyerPaddle');
          return true;

        case 'keyerStatus':
          this._state.keyerBufferFull = Boolean(parsed.bufferFull);
          this._emitChange('keyerBufferFull');
          return true;

        case 'dvrPlayback':
          this._state.dvrSlot = Number.isFinite(parsed.slot) ? parsed.slot : 0;
          this._state.dvrPlaying = Boolean(parsed.playing);
          this._emitChange('dvrPlayback');
          return true;

        case 'radioId':
          this.updateConnection({ radioId: parsed.id });
          return true;

        case 'serial':
          this.updateConnection({ serial: parsed.serial });
          return true;

        case 'decodedText': {
          let bufChanged = false;
          if (Number.isFinite(parsed.txQueued) && this._state.txBufferCount !== parsed.txQueued) {
            this._state.txBufferCount = parsed.txQueued;
            bufChanged = true;
          }
          if (!parsed.text || parsed.text.length === 0) {
            if (bufChanged) {
              this._emitChange('txBufferCount');
              return true;
            }
            return false;
          }
          const rx = parsed.rx || 'A';
          const now = Date.now();
          const norm = String(parsed.text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          const parts = norm.split('\n');

          let latestEntry = null;
          for (let i = this._state.decodedText.length - 1; i >= 0; i--) {
            if (this._state.decodedText[i].rx === rx) {
              latestEntry = this._state.decodedText[i];
              break;
            }
          }

          if (parts[0].length > 0) {
            if (latestEntry && !latestEntry.closed && latestEntry.text.length < 600) {
              latestEntry.text += parts[0];
              latestEntry.timestamp = now;
            } else {
              latestEntry = {
                id: ++this._nextTextId,
                rx,
                text: parts[0],
                timestamp: now,
                closed: false,
              };
              this._state.decodedText.push(latestEntry);
            }
          }

          if (parts.length > 1) {
            if (latestEntry) {
              latestEntry.closed = true;
            }
            for (let k = 1; k < parts.length; k++) {
              if (parts[k].length > 0) {
                this._state.decodedText.push({
                  id: ++this._nextTextId,
                  rx,
                  text: parts[k],
                  timestamp: now,
                  closed: k < parts.length - 1,
                });
              }
            }
          }

          if (this._state.decodedText.length > MAX_DECODED_TEXT) {
            this._state.decodedText.splice(
              0,
              this._state.decodedText.length - MAX_DECODED_TEXT
            );
          }
          this._emitChange('decodedText');
          return true;
        }

        default:
          return false;
      }
    }
  }

  RadioState.bandForFreq = bandForFreq;

  K4.createDefaultRxState = createDefaultRxState;
  K4.RadioState = RadioState;
})();
