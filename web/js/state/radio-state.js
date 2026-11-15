'use strict';

(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const BANDS = K4.BANDS || [];
  const MAX_DECODED_TEXT = 200;

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
      fpTempC: null,
      cpuTempC: null,
      paTempC: null,
      lpaTempC: null,
      dapTempC: null,
      updatedAt: null,
    };
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
      cwPitchHz: 500,
      subRxEnabled: false,
      splitEnabled: false,
      vfoLinked: false,
      diversityEnabled: false,
      activeTxVfo: 'A',
      panAvg: 4,
      dualPanMode: 0,
      panFrozen: false,
      panFps: 20,
      displayMode: 1,
      waterfallHeightPct: 60,
      fixedTune: false,
      hasSubRx: true,
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
   * Reactive store holding K4 receiver, panadapter, audio, and connection telemetry state.
   */
  class RadioState extends K4.EventEmitter {
    constructor(initial = null) {
      super();
      this._state = createDefaultState();
      this._nextTextId = 0;
      if (initial && typeof initial === 'object') {
        if (initial.rxA) Object.assign(this._state.rxA, initial.rxA);
        if (initial.rxB) Object.assign(this._state.rxB, initial.rxB);
        if (initial.connection) Object.assign(this._state.connection, initial.connection);
        if (initial.telemetry) Object.assign(this._state.telemetry, initial.telemetry);
        for (const k of Object.keys(initial)) {
          if (k !== 'rxA' && k !== 'rxB' && k !== 'connection' && k !== 'telemetry' && k !== 'decodedText') {
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
        cwPitchHz: this._state.cwPitchHz,
        subRxEnabled: this._state.subRxEnabled,
        splitEnabled: this._state.splitEnabled,
        vfoLinked: this._state.vfoLinked,
        diversityEnabled: this._state.diversityEnabled,
        activeTxVfo: this._state.activeTxVfo,
        panAvg: this._state.panAvg,
        dualPanMode: this._state.dualPanMode,
        panFrozen: this._state.panFrozen,
        panFps: this._state.panFps,
        displayMode: this._state.displayMode,
        waterfallHeightPct: this._state.waterfallHeightPct,
        fixedTune: this._state.fixedTune,
        hasSubRx: this._state.hasSubRx,
        optionModules: this._state.optionModules,
        audioMix: this._state.audioMix,
        encodeMode: this._state.encodeMode,
        streamingLatency: this._state.streamingLatency,
        telemetry: Object.assign({}, this._state.telemetry),
        decodedText: this._state.decodedText.slice(),
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
          const patch = { nrOn: parsed.nrOn };
          if (parsed.nrLevel !== null && parsed.nrLevel !== undefined) {
            patch.nrLevel = parsed.nrLevel;
          }
          this.updateRx(parsed.rx, patch, `${rxKey}.nr`);
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
          let changed = false;
          if (parsed.module === 'FP') {
            if (Number.isFinite(f.VS)) { t.supplyVolts = f.VS; changed = true; }
            if (Number.isFinite(f.IS)) { t.supplyAmps = f.IS; changed = true; }
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
          } else if (parsed.module === 'DA') {
            if (Number.isFinite(f.T)) { t.dapTempC = f.T; changed = true; }
          }
          if (changed) {
            t.updatedAt = Date.now();
            this._emitChange('telemetry');
          }
          return changed;
        }

        case 'radioId':
          this.updateConnection({ radioId: parsed.id });
          return true;

        case 'serial':
          this.updateConnection({ serial: parsed.serial });
          return true;

        case 'decodedText': {
          if (!parsed.text || parsed.text.length === 0) return false;
          this._state.decodedText.push({
            id: ++this._nextTextId,
            rx: parsed.rx || 'A',
            text: parsed.text,
            timestamp: Date.now(),
          });
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
