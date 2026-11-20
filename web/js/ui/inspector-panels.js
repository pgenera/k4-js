'use strict';
(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const DESKTOP_TABS = [
    { key: 'band', id: 'band-mode', label: 'BAND', rx: null },
    { key: 'main-rx', id: 'dsp', label: 'MAIN RX', rx: 'A' },
    { key: 'sub-rx', id: 'dsp', label: 'SUB RX', rx: 'B' },
    { key: 'display', id: 'display', label: 'DISPLAY', rx: null },
    { key: 'audio', id: 'audio', label: 'AUDIO', rx: null },
    { key: 'tx', id: 'tx', label: 'TX', rx: null },
  ];

  const MOBILE_TABS = [
    { id: 'tune', label: 'Tune' },
    { id: 'band-mode', label: 'BAND' },
    { id: 'dsp', label: 'MAIN RX' },
    { id: 'display', label: 'DISPLAY' },
    { id: 'audio', label: 'AUDIO' },
    { id: 'tx', label: 'TX' },
  ];

  const CURSOR_MODES = [
    { key: 'TRACK', label: 'TRACK', fixedTune: false, mode: null },
    { key: 'FIXED1', label: 'FIXED1', fixedTune: true, mode: 0 },
    { key: 'FIXED2', label: 'FIXED2', fixedTune: true, mode: 1 },
    { key: 'SLIDE1', label: 'SLIDE1', fixedTune: true, mode: 2 },
    { key: 'SLIDE2', label: 'SLIDE2', fixedTune: true, mode: 4 },
    { key: 'STATIC', label: 'STATIC', fixedTune: true, mode: 3 },
  ];

  const MODE_CHOICES = [
    { id: 'LSB', label: 'LSB', code: 1, key: 'LSB', sub: null },
    { id: 'USB', label: 'USB', code: 2, key: 'USB', sub: null },
    { id: 'CW', label: 'CW', code: 3, key: 'CW', sub: null },
    { id: 'CW-R', label: 'CW-R', code: 7, key: 'CW-R', sub: null },
    { id: 'AM', label: 'AM', code: 5, key: 'AM', sub: null },
    { id: 'FM', label: 'FM', code: 4, key: 'FM', sub: null },
    { id: 'DATA-A', label: 'DATA-A', code: 6, key: 'DATA', sub: 0 },
    { id: 'AFSK-A', label: 'AFSK-A', code: 6, key: 'DATA', sub: 1 },
    { id: 'FSK-D', label: 'FSK-D', code: 6, key: 'DATA', sub: 2 },
    { id: 'PSK-D', label: 'PSK-D', code: 6, key: 'DATA', sub: 3 },
  ];

  const STEP_LABELS = ['1 Hz', '10 Hz', '100 Hz', '1 kHz', '2.5 kHz', '5 kHz', '10 kHz'];
  const SPAN_PRESETS = [6000, 12000, 24000, 48000, 96000, 192000, 368000];
  const MIX_OPTIONS = ['A.B', 'AB.AB', 'A.AB', 'AB.B', 'A.-A', 'A.A', 'B.B', 'AB.A', 'B.AB', 'B.A'];
  const PALETTES = [
    { id: 'obsidian', label: 'Obsidian' },
    { id: 'thermal', label: 'Thermal' },
    { id: 'viridis', label: 'Viridis' },
    { id: 'cyan', label: 'Cyan' },
    { id: 'k4', label: 'K4 Classic' },
  ];
  const LATENCY_MS = [35, 60, 75, 95, 115, 140, 180, 240];

  const SENSOR_META = [
    { key: 'vs', label: 'Supply Voltage', stripLabel: 'VS', unit: 'V', warnMin: 11.8, critMin: 11.2, color: '#38BDF8', decimals: 2 },
    { key: 'is', label: 'Current / Peak', stripLabel: 'IS', unit: 'A', warnMax: 21.0, minFloor: 0, color: '#F59E0B', decimals: 1 },
    { key: 'pt', label: 'PA Heatsink', stripLabel: 'PA TEMP', unit: '°C', warnMax: 60, critMax: 75, color: '#F97316', decimals: 1 },
    { key: 'lt', label: 'LPA / Driver', unit: '°C', warnMax: 60, critMax: 75, color: '#FB923C', decimals: 1 },
    { key: 'tf', label: 'Front Panel', unit: '°C', warnMax: 55, critMax: 70, color: '#A78BFA', decimals: 1 },
    { key: 'sys', label: 'CPU / DAP / DUC', unit: '°C', warnMax: 70, critMax: 85, color: '#34D399', decimals: 1 },
    { key: 'fwd', label: 'RF Forward Power', unit: 'W', minFloor: 0, color: '#22D3EE', decimals: 1 },
    { key: 'swr', label: 'Antenna SWR', stripLabel: 'SWR', unit: ':1', warnMax: 1.5, critMax: 2.5, minFloor: 1.0, color: '#F43F5E', decimals: 2 },
  ];
  const SENSOR_META_BY_KEY = Object.fromEntries(SENSOR_META.map((m) => [m.key, m]));

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  function sensorTempLevel(t) {
    return t == null ? 'ok' : (t >= 75 ? 'crit' : (t >= 60 ? 'warn' : 'ok'));
  }

  function sensorTfLevel(t) {
    return t == null ? 'ok' : (t >= 70 ? 'crit' : (t >= 55 ? 'warn' : 'ok'));
  }

  function sensorVoltLevel(v) {
    return v == null ? 'ok' : (v < 11.2 ? 'crit' : (v < 11.8 ? 'warn' : 'ok'));
  }

  function sensorSwrLevel(s) {
    return s > 2.5 ? 'crit' : (s > 1.5 ? 'warn' : 'ok');
  }

  function extractSensorReadings(snapshot) {
    const s = snapshot || {};
    const tel = s.telemetry || {};
    const tm = s.txMeters || {};
    const isAmps = tel.supplyAmps != null ? Number(tel.supplyAmps) : null;
    const fwdWatts = Number(tm.fwdWatts) || 0;
    return {
      tel,
      tm,
      vs: tel.supplyVolts != null ? Number(tel.supplyVolts) : null,
      sag: tel.txVoltDrop != null ? Number(tel.txVoltDrop) : 0,
      isAmps,
      peakIs: tel.peakSupplyAmps != null ? Number(tel.peakSupplyAmps) : isAmps,
      pt: tel.paTempC != null ? Number(tel.paTempC) : null,
      lt: tel.lpaTempC != null ? Number(tel.lpaTempC) : null,
      tf: tel.fpTempC != null ? Number(tel.fpTempC) : null,
      fwdWatts,
      peakFwd: Number(tm.peakFwdWatts) || fwdWatts,
      swr: Number(tm.swr) >= 1.0 ? Number(tm.swr) : (s.atuMatchedSwr || 1.0),
    };
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function makeCard(titleText, rightBadgeEl) {
    const card = el('div', 'k4-card');
    const head = el('div', 'k4-card-title');
    head.appendChild(el('span', '', titleText));
    if (rightBadgeEl) head.appendChild(rightBadgeEl);
    card.appendChild(head);
    return card;
  }

  function createMobileIconSvg(tabId) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.4');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    if (tabId === 'tune') {
      path.setAttribute('d', 'M2.5 4h3M2.5 8h3M2.5 12h3M7.5 4h6M7.5 8h6M7.5 12h6');
    } else if (tabId === 'band-mode') {
      path.setAttribute('d', 'M2 5h12M2 11h12M6 2.5v5M10 8.5v5');
    } else if (tabId === 'dsp') {
      path.setAttribute('d', 'M2 11.5L5.2 4.5H10.8L14 11.5');
    } else if (tabId === 'display') {
      path.setAttribute('d', 'M1.8 11.5L4.5 7.5L7.2 9.5L10.5 4L14.2 11.5');
    } else if (tabId === 'tx') {
      path.setAttribute('d', 'M8.8 1.5L4.2 8.6H8L7.2 14.5L11.8 7.4H8Z');
    } else {
      path.setAttribute('d', 'M2.5 6.2H5.2L8.8 3.2V12.8L5.2 9.8H2.5ZM11.3 5.7A3 3 0 0 1 11.3 10.3');
    }
    svg.appendChild(path);
    return svg;
  }

  function makeSliderRow({ label, min, max, step, value, formatValue, onInput, onChange }) {
    const row = el('div', 'k4-slider-row');
    const head = el('div', 'k4-slider-head');
    const lbl = el('span', 'k4-slider-label', label);
    const valEl = el('span', 'k4-slider-val', formatValue(value));
    head.appendChild(lbl);
    head.appendChild(valEl);
    row.appendChild(head);

    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'k4-range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);

    let lastSent = 0;
    input.addEventListener('pointerdown', () => { input.dataset.dragging = '1'; });
    input.addEventListener('pointerup', () => { delete input.dataset.dragging; });
    input.addEventListener('pointercancel', () => { delete input.dataset.dragging; });
    input.addEventListener('blur', () => { delete input.dataset.dragging; });

    input.addEventListener('input', () => {
      const v = Number(input.value);
      valEl.textContent = formatValue(v);
      const now = performance.now();
      if (onInput && now - lastSent >= 50) {
        lastSent = now;
        onInput(v);
      }
    });

    input.addEventListener('change', () => {
      delete input.dataset.dragging;
      const v = Number(input.value);
      valEl.textContent = formatValue(v);
      if (onChange) onChange(v);
      else if (onInput) onInput(v);
    });

    row.appendChild(input);

    return {
      row,
      input,
      labelEl: lbl,
      sync(nextVal) {
        const num = Number(nextVal);
        if (!Number.isFinite(num)) return;
        valEl.textContent = formatValue(num);
        if (input.dataset.dragging !== '1' && document.activeElement !== input) {
          input.value = String(num);
        }
      },
    };
  }

  function makeSwitchRow(label, onToggle, emerald) {
    const row = el('div', 'k4-toggle-row');
    row.appendChild(el('span', 'k4-slider-label', label));
    const btn = el('button', `k4-switch-btn${emerald ? ' is-emerald' : ''}`, 'OFF');
    btn.type = 'button';
    btn.addEventListener('click', onToggle);
    row.appendChild(btn);
    return {
      row,
      btn,
      sync(on) {
        btn.classList.toggle('is-on', Boolean(on));
        btn.textContent = on ? 'ON' : 'OFF';
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      },
    };
  }

  function syncDecodeSelect(selectEl, rxState) {
    const desc =
      K4.CatCodec && typeof K4.CatCodec.describeTextDecode === 'function'
        ? K4.CatCodec.describeTextDecode(rxState)
        : {
            supported: false,
            thresholdSupported: false,
            reason: 'Decode unavailable',
            options: [{ mode: 0, label: 'Decode: N/A' }],
          };
    const sig = desc.options.map((o) => `${o.mode}:${o.label}`).join('|');
    if (selectEl.dataset.sig !== sig) {
      selectEl.textContent = '';
      for (let i = 0; i < desc.options.length; i++) {
        const opt = document.createElement('option');
        opt.value = String(desc.options[i].mode);
        opt.textContent = desc.options[i].label;
        selectEl.appendChild(opt);
      }
      selectEl.dataset.sig = sig;
    }
    const modeNum =
      rxState && Number.isFinite(rxState.textDecodeMode) ? rxState.textDecodeMode : 0;
    const hasOpt = desc.options.some((o) => o.mode === modeNum);
    const targetVal = String(hasOpt ? modeNum : 0);
    if (document.activeElement !== selectEl && selectEl.value !== targetVal) {
      selectEl.value = targetVal;
    }
    selectEl.disabled = !desc.supported;
    selectEl.title = desc.reason || 'Text Decode Mode';
    return desc;
  }

  function isLsbPrimaryFreq(freqHz) {
    const f = Number(freqHz);
    if (!Number.isFinite(f) || f <= 0) return false;
    if (f >= 5300000 && f <= 5450000) return false; // 60m is USB
    return f < 10000000; // < 10 MHz (160m/80m/40m) -> LSB first; >= 10 MHz -> USB first
  }

  function isVoiceOrAfDataMode(snap) {
    const s = snap || {};
    const txVfo = s.activeTxVfo || (s.splitEnabled ? 'B' : 'A');
    const rxS = txVfo === 'B' ? (s.rxB || {}) : (s.rxA || {});
    const mode = Number(rxS.mode) || 0;
    const sub = Number(rxS.dataSubMode) || 0;
    return mode === 1 || mode === 2 || mode === 4 || mode === 5 || ((mode === 6 || mode === 9) && (sub === 0 || sub === 1));
  }

  function describePttMicState(snapshot, txAudioConfig, audioEngine, isTestMode) {
    const s = snapshot || {};
    const cfg = txAudioConfig || {};
    const voiceMode = isVoiceOrAfDataMode(s);
    const micSt = audioEngine && typeof audioEngine.getMicStatus === 'function'
      ? audioEngine.getMicStatus()
      : { state: 'idle' };
    const src = cfg.source || 'mic';
    const micState = src !== 'mic' ? 'synth' : (micSt.state || 'idle');
    const micWarn = Boolean(
      voiceMode &&
      src === 'mic' &&
      (micState === 'denied' || micState === 'insecure' || micState === 'unavailable' || micState === 'error')
    );
    let idleLabel = 'PTT';
    let titleDetail = '';
    if (src !== 'mic') {
      const srcTag = src === 'tone-1k' ? '1kHz' : src === 'wav' ? 'WAV' : 'TONE';
      idleLabel = `PTT (${srcTag})`;
      titleDetail = ` · Source: ${srcTag}`;
    } else if (micWarn) {
      idleLabel = 'PTT !';
      titleDetail = ` · Mic ${micState}${micSt.error ? `: ${micSt.error}` : ''} (press PTT to retry or open TX Audio)`;
    } else if (voiceMode && (micState === 'ready' || micState === 'capturing')) {
      titleDetail = micSt.deviceLabel ? ` · Mic: ${micSt.deviceLabel}` : ' · Mic ready';
    }
    return {
      voiceMode,
      micSt,
      micState,
      micWarn,
      idleLabel,
      txLabel: isTestMode ? 'TX TEST' : 'ON AIR',
      topTxLabel: isTestMode ? 'TX Test' : 'ON AIR',
      titleDetail,
    };
  }

  K4.syncDecodeSelect = syncDecodeSelect;
  K4.isLsbPrimaryFreq = isLsbPrimaryFreq;
  K4.isVoiceOrAfDataMode = isVoiceOrAfDataMode;
  K4.describePttMicState = describePttMicState;

  class InspectorPanels {
    constructor(opts) {
      this.drawerEl = opts.drawerEl;
      this.mobileNavEl = opts.mobileNavEl;
      this.mobileSheetEl = opts.mobileSheetEl;
      this.client = opts.client;
      this.state = opts.state;
      this.gate = opts.gate;
      this.audio = opts.audio;
      this.panadapter = opts.panadapter;

      this.getTargetRx = opts.getTargetRx || (() => 'A');
      this.onSetTargetRx = opts.onSetTargetRx || (() => {});
      this.onSetPalette = opts.onSetPalette || (() => {});
      this.getPalette = opts.getPalette || (() => 'obsidian');
      this.onSetPeakHold = opts.onSetPeakHold || (() => {});
      this.getPeakHold = opts.getPeakHold || (() => false);
      this.getMouseQsyMode = opts.getMouseQsyMode || (() => 'lr');
      this.onSetMouseQsyMode = opts.onSetMouseQsyMode || (() => {});
      this.onToggleAudio = opts.onToggleAudio || (() => {});
      this.onSetTxPosture = opts.onSetTxPosture || ((posture) => {
        if (this.client && typeof this.client.setTxPosture === 'function') {
          this.client.setTxPosture(posture, { confirmed: posture === 'tx-armed' });
        }
      });
      this.onToggleTxTest = opts.onToggleTxTest || (() => {
        if (this.client && typeof this.client.setTxTest === 'function') {
          const snap = this.client.state ? this.client.state.getSnapshot() : {};
          this.client.setTxTest(!Boolean(snap.txTestMode));
        }
      });
      this.onPanicAbort = opts.onPanicAbort || (() => {
        if (this.client && typeof this.client.panicAbortTx === 'function') {
          this.client.panicAbortTx('ui-panic');
        }
      });
      this.onBeginHoldPtt = opts.onBeginHoldPtt || (() => {
        if (this.client && typeof this.client.startPtt === 'function') this.client.startPtt();
      });
      this.onEndHoldPtt = opts.onEndHoldPtt || (() => {
        if (this.client && typeof this.client.stopPtt === 'function') this.client.stopPtt();
      });
      this.isPttHeld = opts.isPttHeld || (() => false);
      this.onSwapVfo = opts.onSwapVfo || null;
      this.onTriggerA2B = opts.onTriggerA2B || null;
      this.getTxAudioConfig = opts.getTxAudioConfig || (() => this._localTxAudio);
      this.onSetTxAudioConfig = opts.onSetTxAudioConfig || ((patch) => {
        Object.assign(this._localTxAudio, patch);
      });
      this.onLoadTxWav = opts.onLoadTxWav || null;
      this.onOpenDrawer = opts.onOpenDrawer || (() => {});
      this.isDrawerOpen =
        opts.isDrawerOpen ||
        (() => (this.drawerEl ? this.drawerEl.dataset.open !== 'false' : true));

      this._activeDesktopTab = 'band-mode';
      this._activeMobileTab = null;
      this._mobileSheetSnap = 'compact';
      this._panes = {};
      this._refs = {};
      this._dirtyTabs = new Set(['band-mode', 'dsp', 'display', 'audio', 'tune', 'tx']);
      this._atuCueTimer = null;
      this._keypadBuffer = '';
      this._localAudio = { gainA: 0.85, gainB: 0.85, balance: 0 };
      const hasSecureMic = Boolean(
        globalThis.isSecureContext &&
          globalThis.navigator &&
          globalThis.navigator.mediaDevices &&
          typeof globalThis.navigator.mediaDevices.getUserMedia === 'function'
      );
      this._localTxAudio = {
        source: hasSecureMic ? 'mic' : 'two-tone',
        deviceId: '',
        voiceProcessing: false,
        wavName: '',
      };
      this._micDevices = [];
      this._msgBank = 1;
      this._selectedSensorKey = null;
      this._sensorWindowSec = 180;
      this._statusModeIdx = 0;

      this._buildDrawerShell();
      this._buildMobileShell();
      this._buildPanes();
      this.syncHost();
    }

    _builders() {
      return (K4.CatCodec && K4.CatCodec.builders) || {};
    }

    _sendCat(cmd) {
      this.client.sendCat(cmd);
    }

    _snap() {
      return this.state.getSnapshot ? this.state.getSnapshot() : this.state;
    }

    _rxSnap(rx) {
      const snap = this._snap();
      return (rx === 'B' ? snap.rxB : snap.rxA) || {};
    }

    _buildDrawerShell() {
      this.drawerEl.textContent = '';
      this.drawerTabBar = el('div', 'k4-panel-tabs');
      this._desktopTabBtns = {};
      this._desktopTabItems = [];
      for (let i = 0; i < DESKTOP_TABS.length; i++) {
        const t = DESKTOP_TABS[i];
        const btn = el('button', `k4-tab-btn${t.rx === 'B' ? ' is-vfo-b' : ''}`, t.label);
        btn.type = 'button';
        btn.dataset.tab = t.id;
        btn.dataset.tabKey = t.key;
        if (t.rx) btn.dataset.rx = t.rx;
        btn.addEventListener('click', () => {
          if (t.rx) this.onSetTargetRx(t.rx);
          this.selectDesktopTab(t.id);
        });
        if (!this._desktopTabBtns[t.id]) this._desktopTabBtns[t.id] = btn;
        this._desktopTabItems.push({ ...t, btn });
        this.drawerTabBar.appendChild(btn);
      }
      this.drawerEl.appendChild(this.drawerTabBar);

      this.drawerScroll = el('div', 'k4-panel-scroll');
      this.drawerEl.appendChild(this.drawerScroll);

      // Compact always-visible K4 Status Area + live sensor telemetry footer
      this.sensorStrip = el('div', 'k4-sensor-strip');
      this.sensorStrip.setAttribute('role', 'group');
      this.sensorStrip.setAttribute('aria-label', 'K4 status area and telemetry sensors');
      this.sensorStrip.dataset.testid = 'sensor-strip';

      const statusCycler = el('button', 'k4-sensor-pill k4-sensor-pill--clock');
      statusCycler.type = 'button';
      statusCycler.dataset.testid = 'status-area-cycler';
      statusCycler.title = 'Tap to cycle Status Area (UTC / RTT / Supply / Radio)';
      const cyclerVal = el('span', 'k4-sensor-pill-val', 'UTC --:--Z');
      statusCycler.appendChild(cyclerVal);
      statusCycler.addEventListener('click', () => {
        this._statusModeIdx = (this._statusModeIdx + 1) % 4;
        this._updateSensorStrip(this._snap());
      });
      this.sensorStrip.appendChild(statusCycler);
      this._statusCyclerBtn = statusCycler;
      this._statusCyclerVal = cyclerVal;

      const makeStripPill = (key, lbl) => {
        const pill = el('button', 'k4-sensor-pill');
        pill.type = 'button';
        pill.dataset.sensorKey = key;
        pill.dataset.testid = `strip-sensor-${key}`;
        pill.title = `Open ${lbl} graph in TX`;
        const lblEl = el('span', 'k4-sensor-pill-lbl', lbl);
        pill.appendChild(lblEl);
        const val = el('span', 'k4-sensor-pill-val', '--');
        pill.appendChild(val);
        pill.addEventListener('click', () => {
          this._selectedSensorKey = pill.dataset.sensorKey || key;
          this.openTab('tx', this._refs.txSensorsCard);
        });
        this.sensorStrip.appendChild(pill);
        return { pill, lbl: lblEl, val };
      };
      this._strip = {
        vs: makeStripPill('vs', 'V'),
        is: makeStripPill('is', 'I'),
        pt: makeStripPill('pt', 'PA'),
        swr: makeStripPill('swr', 'SWR'),
      };
      this.drawerEl.appendChild(this.sensorStrip);
    }

    _buildMobileShell() {
      this.mobileNavEl.textContent = '';
      this._mobileNavBtns = {};
      for (let i = 0; i < MOBILE_TABS.length; i++) {
        const t = MOBILE_TABS[i];
        const btn = el('button', 'k4-mobile-nav-btn');
        btn.type = 'button';
        btn.appendChild(createMobileIconSvg(t.id));
        btn.appendChild(el('span', '', t.label));
        btn.addEventListener('click', () => this.toggleMobileSheet(t.id));
        this._mobileNavBtns[t.id] = btn;
        this.mobileNavEl.appendChild(btn);
      }

      this.mobileSheetEl.textContent = '';
      const sheetHead = el('div', 'k4-sheet-head');
      const titleWrap = el('div', '');
      titleWrap.style.flex = '1';
      const grabber = el('div', 'k4-sheet-grabber');
      grabber.dataset.testid = 'mobile-sheet-grabber';
      grabber.setAttribute('role', 'button');
      grabber.tabIndex = 0;
      grabber.title = 'Tap or drag to resize sheet';
      const snapOrder = ['compact', 'mid', 'tall'];
      const cycleSnap = () => {
        const idx = snapOrder.indexOf(this._mobileSheetSnap || 'compact');
        this._mobileSheetSnap = snapOrder[(idx + 1) % snapOrder.length];
        if (this.mobileSheetEl) this.mobileSheetEl.dataset.snap = this._mobileSheetSnap;
      };
      grabber.addEventListener('click', (e) => {
        e.stopPropagation();
        cycleSnap();
      });
      grabber.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          cycleSnap();
        }
      });
      titleWrap.appendChild(grabber);
      this.sheetTitleEl = el('div', 'k4-sheet-title', 'Controls');
      titleWrap.appendChild(this.sheetTitleEl);
      sheetHead.appendChild(titleWrap);

      const closeBtn = el('button', 'k4-icon-btn', '×');
      closeBtn.type = 'button';
      closeBtn.style.fontSize = '18px';
      closeBtn.title = 'Close sheet';
      closeBtn.addEventListener('click', () => this.closeMobileSheet());
      sheetHead.appendChild(closeBtn);

      // Touch swipe up/down on header resizes or dismisses sheet
      let touchStartY = 0;
      sheetHead.addEventListener('touchstart', (e) => {
        if (e.touches && e.touches[0]) touchStartY = e.touches[0].clientY;
      }, { passive: true });
      sheetHead.addEventListener('touchend', (e) => {
        if (!e.changedTouches || !e.changedTouches[0]) return;
        const dy = e.changedTouches[0].clientY - touchStartY;
        const curIdx = snapOrder.indexOf(this._mobileSheetSnap || 'compact');
        if (dy < -28) {
          this._mobileSheetSnap = snapOrder[Math.min(snapOrder.length - 1, curIdx + 1)];
          if (this.mobileSheetEl) this.mobileSheetEl.dataset.snap = this._mobileSheetSnap;
        } else if (dy > 32) {
          if (curIdx > 0) {
            this._mobileSheetSnap = snapOrder[curIdx - 1];
            if (this.mobileSheetEl) this.mobileSheetEl.dataset.snap = this._mobileSheetSnap;
          } else {
            this.closeMobileSheet();
          }
        }
      }, { passive: true });

      this.mobileSheetEl.appendChild(sheetHead);
      this.sheetScroll = el('div', 'k4-panel-scroll');
      this.mobileSheetEl.appendChild(this.sheetScroll);
    }

    _buildPanes() {
      this._panes['band-mode'] = this._buildBandModePane();
      this._panes['dsp'] = this._buildDspPane();
      this._panes['display'] = this._buildDisplayPane();
      this._panes['audio'] = this._buildAudioPane();
      this._panes['tune'] = this._buildTunePane();
      this._panes['tx'] = this._buildTxPane();
    }

    _buildBandModePane() {
      const pane = el('div', 'k4-panel-pane k4-pane--band');

      // Receiver Target & Sub RX
      const rxCard = makeCard('Target receiver');
      const targetGroup = el('div', 'k4-seg-group');
      const btnA = el('button', 'k4-seg-btn', 'VFO A (Main)');
      btnA.type = 'button';
      btnA.addEventListener('click', () => this.onSetTargetRx('A'));
      const btnB = el('button', 'k4-seg-btn is-amber', 'VFO B (Sub)');
      btnB.type = 'button';
      btnB.addEventListener('click', () => this.onSetTargetRx('B'));
      targetGroup.appendChild(btnA);
      targetGroup.appendChild(btnB);
      rxCard.appendChild(targetGroup);
      this._refs.targetBtns = { A: btnA, B: btnB };

      const subRow = makeSwitchRow('Sub Receiver', () => {
        const next = !this._snap().subRxEnabled;
        if (typeof this.client.setSubRx === 'function') {
          this.client.setSubRx(next);
        } else {
          const b = this._builders();
          this._sendCat(b.subRx ? b.subRx(next) : `SB${next ? '1' : '0'};`);
        }
      });
      rxCard.appendChild(subRow.row);
      this._refs.subSwitch = subRow;

      const linkRow = makeSwitchRow('VFO LNK', () => {
        const next = !this._snap().vfoLinked;
        if (this.state && typeof this.state.update === 'function') {
          this.state.update({ vfoLinked: next }, 'vfoLinked');
        }
        this._sendCat(`LN${next ? '1' : '0'};`);
      });
      rxCard.appendChild(linkRow.row);
      this._refs.linkSwitch = linkRow;

      const divRow = makeSwitchRow('Diversity RX', () => {
        const next = !this._snap().diversityEnabled;
        if (typeof this.client.setDiversity === 'function') {
          this.client.setDiversity(next);
        } else {
          this._sendCat(`DV${next ? '1' : '0'};`);
        }
      }, true);
      divRow.btn.dataset.testid = 'diversity-switch';
      rxCard.appendChild(divRow.row);
      this._refs.divSwitch = divRow;

      pane.appendChild(rxCard);

      // Band Grid
      const bandCard = makeCard('Amateur bands');
      const bandGrid = el('div', 'k4-pill-grid');
      const bands = Array.isArray(K4.BANDS) ? K4.BANDS : [];
      this._refs.bandBtns = [];
      for (let i = 0; i < bands.length; i++) {
        const band = bands[i];
        const btn = el('button', 'k4-choice-pill', band.label);
        btn.type = 'button';
        btn.addEventListener('click', () => {
          this.client.setBand(this.getTargetRx(), band);
        });
        bandGrid.appendChild(btn);
        this._refs.bandBtns.push({ band, btn });
      }
      bandCard.appendChild(bandGrid);
      pane.appendChild(bandCard);

      // Mode Grid (5 columns x 2 rows)
      const modeCard = makeCard('Operating mode');
      const modeGrid = el('div', 'k4-pill-grid k4-pill-grid--5');
      modeGrid.dataset.testid = 'operating-mode-grid';
      this._refs.modeGrid = modeGrid;
      this._lastModeOrderLsbFirst = null;
      this._refs.modeBtns = [];
      for (let i = 0; i < MODE_CHOICES.length; i++) {
        const mc = MODE_CHOICES[i];
        const btn = el('button', 'k4-choice-pill', mc.label);
        btn.type = 'button';
        btn.addEventListener('click', () => {
          this.client.setMode(this.getTargetRx(), mc.key, mc.sub !== null ? mc.sub : undefined);
        });
        modeGrid.appendChild(btn);
        this._refs.modeBtns.push({ mc, btn });
      }
      modeCard.appendChild(modeGrid);
      pane.appendChild(modeCard);

      // Tuning Step
      const stepCard = makeCard('Tuning step');
      const stepGrid = el('div', 'k4-pill-grid');
      this._refs.stepBtns = [];
      for (let i = 0; i < STEP_LABELS.length; i++) {
        const idx = i;
        const btn = el('button', 'k4-choice-pill', STEP_LABELS[i]);
        btn.type = 'button';
        btn.addEventListener('click', () => {
          const rx = this.getTargetRx();
          if (typeof this.client.setStep === 'function') {
            this.client.setStep(rx, idx);
          } else {
            const b = this._builders();
            const rxS = this._rxSnap(rx);
            this._sendCat(b.step ? b.step(rx, idx, rxS.mode) : `VT${rx === 'B' ? '$' : ''}${idx};`);
          }
        });
        stepGrid.appendChild(btn);
        this._refs.stepBtns.push({ idx, btn });
      }
      stepCard.appendChild(stepGrid);
      pane.appendChild(stepCard);

      pane.appendChild(this._buildMemoryCard());

      return pane;
    }

    _buildMemoryCard() {
      const card = el('div', 'k4-card');
      card.dataset.testid = 'memory-card';
      const fmt = (m) => (m ? (m.freqHz / 1e6).toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : 'empty');
      const mem = (this._refs.mem = { storeArmed: false, channel: 1 });

      // RCL / STORE selector (K4: tap RCL or STORE, then pick a memory)
      const modeRow = el('div', 'k4-seg-group');
      mem.rclBtn = el('button', 'k4-seg-btn is-active', 'RCL');
      mem.stoBtn = el('button', 'k4-seg-btn', 'STORE');
      mem.rclBtn.type = mem.stoBtn.type = 'button';
      mem.rclBtn.dataset.testid = 'mem-rcl';
      mem.stoBtn.dataset.testid = 'mem-store';
      const setArmed = (on) => {
        mem.storeArmed = on;
        mem.rclBtn.classList.toggle('is-active', !on);
        mem.stoBtn.classList.toggle('is-active', on);
        mem.rclBtn.setAttribute('aria-pressed', on ? 'false' : 'true');
        mem.stoBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      };
      mem.rclBtn.addEventListener('click', () => setArmed(false));
      mem.stoBtn.addEventListener('click', () => setArmed(true));
      modeRow.appendChild(mem.rclBtn);
      modeRow.appendChild(mem.stoBtn);

      const head = el('div', 'k4-mem-head');
      const title = el('div', 'k4-card-title');
      title.appendChild(el('span', '', 'Frequency memories'));
      head.appendChild(title);
      head.appendChild(modeRow);
      card.appendChild(head);

      const rxNow = () => this.getTargetRx();
      const current = () => {
        const s = this._rxSnap(rxNow());
        return { freqHz: s.freqHz, mode: s.mode, dataSubMode: s.dataSubMode || 0, bwHz: s.bwHz };
      };
      const bandLabel = () => {
        const f = Number(this._rxSnap(rxNow()).freqHz) || 0;
        const bands = Array.isArray(K4.BANDS) ? K4.BANDS : [];
        const b = bands.find((x) => f >= x.startHz && f <= x.endHz);
        return b ? b.label : null;
      };
      const recall = (m, label) => {
        if (!m) return;
        const rx = rxNow();
        this.client.tune(rx, m.freqHz, { optimistically: true });
        if (m.mode != null) {
          const dataSubMode = (Number(m.mode) === 6 || Number(m.mode) === 9) ? (m.dataSubMode || 0) : undefined;
          this.client.setMode(rx, m.mode, dataSubMode);
        }
        if (m.bwHz != null && typeof this.client.setFilter === 'function') this.client.setFilter(rx, { bwHz: m.bwHz });
        if (typeof this.onNotify === 'function') this.onNotify(`Recalled ${label} (${(m.freqHz / 1e6).toFixed(4)} MHz)`, 'info');
      };
      const store = (setter, label) => {
        const cur = current();
        if (setter(cur) && typeof this.onNotify === 'function') {
          this.onNotify(`Stored ${label} (${(cur.freqHz / 1e6).toFixed(4)} MHz)`, 'info');
        }
        setArmed(false);
      };

      // Quick memories for the current band (K4: M1-M4 per band)
      const quickGrid = el('div', 'k4-mem-quick-grid');
      mem.quickBtns = [];
      for (let n = 1; n <= 4; n++) {
        const btn = el('button', 'k4-choice-pill k4-mem-pill', `M${n}`);
        btn.type = 'button';
        btn.dataset.testid = `mem-quick-${n}`;
        btn.addEventListener('click', (e) => {
          const band = bandLabel();
          if (!band) return;
          const existing = K4.MemoryStore.getQuick(band, n);
          if (e.shiftKey && existing) {
            if (typeof K4.MemoryStore.clearQuick === 'function') {
              K4.MemoryStore.clearQuick(band, n);
              if (typeof this.onNotify === 'function') this.onNotify(`Cleared ${band} M${n}`, 'info');
            }
            setArmed(false);
            return;
          }
          if (mem.storeArmed) {
            store((cur) => K4.MemoryStore.setQuick(band, n, cur), `${band} M${n}`);
          } else {
            recall(existing, `${band} M${n}`);
          }
        });
        quickGrid.appendChild(btn);
        mem.quickBtns.push(btn);
      }
      card.appendChild(quickGrid);

      // General memories 1-200 (K4: 200 general-purpose memories)
      const chRow = el('div', 'k4-mem-channel');
      const prev = el('button', 'k4-choice-pill', '\u2039');
      const next = el('button', 'k4-choice-pill', '\u203A');
      prev.type = next.type = 'button';
      prev.setAttribute('aria-label', 'Previous memory channel');
      next.setAttribute('aria-label', 'Next memory channel');
      prev.dataset.testid = 'mem-prev';
      next.dataset.testid = 'mem-next';
      mem.chBtn = el('button', 'k4-choice-pill k4-mem-ch', '');
      mem.chBtn.type = 'button';
      mem.chBtn.dataset.testid = 'mem-channel';
      mem.chBtn.title = 'Recall (or store when STORE is selected; Shift+Click to clear) this memory channel';
      const maxCh = K4.MemoryStore.CHANNELS;
      const step = (d) => {
        mem.channel = ((mem.channel - 1 + d + maxCh) % maxCh) + 1;
        this._refreshMemories();
      };
      prev.addEventListener('click', () => step(-1));
      next.addEventListener('click', () => step(1));
      mem.chBtn.addEventListener('click', (e) => {
        const ch = mem.channel;
        const existing = K4.MemoryStore.getChannel(ch);
        if (e.shiftKey && existing) {
          if (typeof K4.MemoryStore.clearChannel === 'function') {
            K4.MemoryStore.clearChannel(ch);
            if (typeof this.onNotify === 'function') this.onNotify(`Cleared memory ${String(ch).padStart(3, '0')}`, 'info');
          }
          setArmed(false);
          return;
        }
        if (mem.storeArmed) {
          store((cur) => K4.MemoryStore.setChannel(ch, cur), `memory ${String(ch).padStart(3, '0')}`);
        } else {
          recall(existing, `memory ${String(ch).padStart(3, '0')}`);
        }
      });
      chRow.appendChild(prev);
      chRow.appendChild(mem.chBtn);
      chRow.appendChild(next);
      card.appendChild(chRow);

      card.title = 'Saved in this browser. The K4 does not expose its own memories over CAT yet.';
      if (K4.MemoryStore && typeof K4.MemoryStore.subscribe === 'function') {
        K4.MemoryStore.subscribe(() => this._refreshMemories());
      }
      this._refreshMemories = () => {
        const band = bandLabel();
        mem.quickBtns.forEach((btn, i) => {
          const m = band ? K4.MemoryStore.getQuick(band, i + 1) : null;
          btn.textContent = m ? `M${i + 1} ${fmt(m)}` : `M${i + 1}`;
          btn.classList.toggle('is-empty', !m);
          btn.disabled = !band;
          btn.title = band
            ? (m ? `${band} quick memory ${i + 1} (Shift+Click to clear)` : `${band} quick memory ${i + 1}`)
            : 'No band at this frequency';
        });
        const cm = K4.MemoryStore.getChannel(mem.channel);
        mem.chBtn.textContent = `${String(mem.channel).padStart(3, '0')} ${fmt(cm)}`;
        mem.chBtn.classList.toggle('is-empty', !cm);
      };
      this._refreshMemories();
      return card;
    }

    _buildDspPane() {
      const pane = el('div', 'k4-panel-pane');

      const filterCard = makeCard('IF filter & pitch');
      const trapWrap = el('div', 'k4-dsp-trap-wrap');
      const trapSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      trapSvg.setAttribute('viewBox', '0 0 240 36');
      trapSvg.setAttribute('class', 'k4-dsp-trap-svg');
      trapSvg.dataset.testid = 'dsp-filter-trapezoid';
      trapSvg.setAttribute('aria-hidden', 'true');
      const trapCenter = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      trapCenter.setAttribute('x1', '120');
      trapCenter.setAttribute('y1', '2');
      trapCenter.setAttribute('x2', '120');
      trapCenter.setAttribute('y2', '34');
      trapCenter.setAttribute('stroke-dasharray', '2 2');
      trapCenter.setAttribute('class', 'k4-vfo-trap-center');
      const trapBase = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      trapBase.setAttribute('x1', '4');
      trapBase.setAttribute('y1', '33');
      trapBase.setAttribute('x2', '236');
      trapBase.setAttribute('y2', '33');
      trapBase.setAttribute('class', 'k4-vfo-trap-center');
      const trapPoly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      trapPoly.setAttribute('class', 'k4-vfo-trap-poly');
      trapPoly.setAttribute('points', '72,33 90,7 150,7 168,33');
      trapSvg.appendChild(trapBase);
      trapSvg.appendChild(trapCenter);
      trapSvg.appendChild(trapPoly);
      const trapMeta = el('div', 'k4-dsp-trap-meta', 'BW 2.70k\nIS 1500');
      trapWrap.appendChild(trapSvg);
      trapWrap.appendChild(trapMeta);
      filterCard.appendChild(trapWrap);
      this._refs.dspTrapSvg = trapSvg;
      this._refs.dspTrapPoly = trapPoly;
      this._refs.dspTrapMeta = trapMeta;

      const applyFilter = (rx, patch) => {
        if (typeof this.client.setFilter === 'function') {
          this.client.setFilter(rx, patch);
          return;
        }
        const b = this._builders();
        if (patch.bwHz !== undefined) {
          this._sendCat(b.bw ? b.bw(rx, patch.bwHz) : `BW${rx === 'B' ? '$' : ''}${String(Math.round(patch.bwHz / 10)).padStart(4, '0')};`);
        }
        if (patch.ifShiftHz !== undefined) {
          this._sendCat(b.ifShift ? b.ifShift(rx, patch.ifShiftHz) : `IS${rx === 'B' ? '$' : ''}${String(Math.round(patch.ifShiftHz / 10)).padStart(4, '0')};`);
        }
      };

      this._refs.bwSlider = makeSliderRow({
        label: 'Width',
        min: 50,
        max: 5000,
        step: 50,
        value: 2700,
        formatValue: (v) => (v >= 1000 ? `${(v / 1000).toFixed(2).replace(/0$/, '')} kHz` : `${v} Hz`),
        onInput: (v) => applyFilter(this.getTargetRx(), { bwHz: v }),
      });
      filterCard.appendChild(this._refs.bwSlider.row);

      const flRow = el('div', 'k4-pill-grid');
      flRow.dataset.testid = 'filter-preset-group';
      this._refs.flBtns = [];
      for (let n = 1; n <= 3; n++) {
        const btn = el('button', 'k4-choice-pill', `FL${n}`);
        btn.type = 'button';
        btn.dataset.testid = `filter-preset-${n}`;
        btn.title = `Filter preset ${n} for the current mode (FP${n})`;
        btn.addEventListener('click', () => {
          if (typeof this.client.setFilterPreset === 'function') this.client.setFilterPreset(this.getTargetRx(), n);
        });
        flRow.appendChild(btn);
        this._refs.flBtns.push(btn);
      }
      const normBtn = el('button', 'k4-choice-pill', 'NORM');
      normBtn.type = 'button';
      normBtn.dataset.testid = 'filter-norm-btn';
      normBtn.title = "Reset passband to the mode's nominal width and shift (FP~)";
      normBtn.addEventListener('click', () => {
        if (typeof this.client.normalizeFilter === 'function') this.client.normalizeFilter(this.getTargetRx());
      });
      flRow.appendChild(normBtn);
      filterCard.appendChild(flRow);

      const bwPresetGrid = el('div', 'k4-pill-grid');
      const bwPresets = [250, 500, 2400, 2800];
      for (let i = 0; i < bwPresets.length; i++) {
        const hz = bwPresets[i];
        const btn = el('button', 'k4-choice-pill', hz >= 1000 ? `${(hz / 1000).toFixed(1)}k` : String(hz));
        btn.type = 'button';
        btn.addEventListener('click', () => applyFilter(this.getTargetRx(), { bwHz: hz }));
        bwPresetGrid.appendChild(btn);
      }
      filterCard.appendChild(bwPresetGrid);

      this._refs.isSlider = makeSliderRow({
        label: 'IF Shift',
        min: 0,
        max: 5000,
        step: 50,
        value: 1500,
        formatValue: (v) => `${v} Hz`,
        onInput: (v) => applyFilter(this.getTargetRx(), { ifShiftHz: v }),
      });
      filterCard.appendChild(this._refs.isSlider.row);

      this._refs.cwPitchSlider = makeSliderRow({
        label: 'CW Pitch',
        min: 250,
        max: 950,
        step: 10,
        value: 500,
        formatValue: (v) => `${v} Hz`,
        onInput: (v) => {
          const b = this._builders();
          if (this.state && typeof this.state.update === 'function') {
            this.state.update({ cwPitchHz: v }, 'cwPitchHz');
          }
          this._sendCat(b.cwPitch ? b.cwPitch(v) : `CW${String(Math.round(v / 10)).padStart(2, '0')};`);
        },
      });
      filterCard.appendChild(this._refs.cwPitchSlider.row);
      pane.appendChild(filterCard);

      const rfCard = makeCard('RF Front-End & AGC');
      rfCard.appendChild(el('span', 'k4-slider-label', 'Preamp'));
      const paGroup = el('div', 'k4-seg-group');
      this._refs.paBtns = {};
      const paOpts = [
        { level: 0, label: 'Off' },
        { level: 1, label: '10 dB' },
        { level: 2, label: '18 dB' },
      ];
      for (let i = 0; i < paOpts.length; i++) {
        const opt = paOpts[i];
        const btn = el('button', 'k4-seg-btn', opt.label);
        btn.type = 'button';
        btn.addEventListener('click', () => {
          const rx = this.getTargetRx();
          const b = this._builders();
          if (this.state && typeof this.state.updateRx === 'function') {
            this.state.updateRx(rx, { preamp: opt.level }, `${rx}.preamp`);
          }
          this._sendCat(b.preamp ? b.preamp(rx, opt.level) : `PA${rx === 'B' ? '$' : ''}${opt.level > 0 ? `${opt.level}1` : '00'};`);
        });
        paGroup.appendChild(btn);
        this._refs.paBtns[opt.level] = btn;
      }
      rfCard.appendChild(paGroup);

      this._refs.attenSlider = makeSliderRow({
        label: 'Attenuator',
        min: 0,
        max: 21,
        step: 3,
        value: 0,
        formatValue: (v) => (v === 0 ? 'Off' : `${v} dB`),
        onInput: (v) => {
          const rx = this.getTargetRx();
          const b = this._builders();
          if (this.state && typeof this.state.updateRx === 'function') {
            this.state.updateRx(rx, { attenDb: v }, `${rx}.attenDb`);
          }
          this._sendCat(b.atten ? b.atten(rx, v) : `RA${rx === 'B' ? '$' : ''}${String(v).padStart(2, '0')}${v > 0 ? '1' : '0'};`);
        },
      });
      rfCard.appendChild(this._refs.attenSlider.row);

      this._refs.rfGainSlider = makeSliderRow({
        label: 'RF Gain',
        min: -60,
        max: 0,
        step: 1,
        value: 0,
        formatValue: (v) => `${v} dB`,
        onInput: (v) => {
          const rx = this.getTargetRx();
          const b = this._builders();
          const mag = Math.round(v);
          if (this.state && typeof this.state.updateRx === 'function') {
            this.state.updateRx(rx, { rfGainDb: mag }, `${rx}.rfGainDb`);
          }
          this._sendCat(b.rfGain ? b.rfGain(rx, mag) : `RG${rx === 'B' ? '$' : ''}${mag === 0 ? '00' : String(mag)};`);
        },
      });
      rfCard.appendChild(this._refs.rfGainSlider.row);

      this._refs.squelchSlider = makeSliderRow({
        label: 'Squelch',
        min: 0,
        max: 40,
        step: 1,
        value: 0,
        formatValue: (v) => `${Math.round(v)}`,
        onChange: (v) => {
          const rx = this.getTargetRx();
          if (typeof this.client.setSquelch === 'function') {
            this.client.setSquelch(rx, Math.round(v));
          } else {
            this._sendCat(`SQ${rx === 'B' ? '$' : ''}${String(Math.round(v)).padStart(3, '0')};`);
          }
        },
      });
      this._refs.squelchSlider.input.dataset.testid = 'squelch-slider';
      rfCard.appendChild(this._refs.squelchSlider.row);

      rfCard.appendChild(el('span', 'k4-slider-label', 'AGC'));
      const agcGroup = el('div', 'k4-seg-group');
      this._refs.agcBtns = {};
      const agcOpts = [
        { mode: 0, label: 'Off' },
        { mode: 1, label: 'Slow' },
        { mode: 2, label: 'Fast' },
      ];
      for (let i = 0; i < agcOpts.length; i++) {
        const opt = agcOpts[i];
        const btn = el('button', 'k4-seg-btn', opt.label);
        btn.type = 'button';
        btn.addEventListener('click', () => {
          const rx = this.getTargetRx();
          const b = this._builders();
          if (this.state && typeof this.state.updateRx === 'function') {
            this.state.updateRx(rx, { agc: opt.mode }, `${rx}.agc`);
          }
          this._sendCat(b.agc ? b.agc(rx, opt.mode) : `GT${rx === 'B' ? '$' : ''}${opt.mode};`);
        });
        agcGroup.appendChild(btn);
        this._refs.agcBtns[opt.mode] = btn;
      }
      rfCard.appendChild(agcGroup);
      pane.appendChild(rfCard);

      const dspCard = makeCard('Noise & Notch DSP');
      this._refs.nbSwitch = makeSwitchRow('Noise Blanker', () => {
        const rx = this.getTargetRx();
        const s = this._rxSnap(rx);
        const b = this._builders();
        const next = !s.nbOn;
        if (this.state && typeof this.state.updateRx === 'function') {
          this.state.updateRx(rx, { nbOn: next }, `${rx}.nbOn`);
        }
        this._sendCat(b.nb ? b.nb(rx, s.nbLevel ?? 5, next) : `NB${rx === 'B' ? '$' : ''}${String(s.nbLevel ?? 5).padStart(2, '0')}${next ? '1' : '0'};`);
      });
      dspCard.appendChild(this._refs.nbSwitch.row);

      this._refs.nbSlider = makeSliderRow({
        label: 'NB Level',
        min: 0,
        max: 15,
        step: 1,
        value: 5,
        formatValue: (v) => String(v),
        onInput: (v) => {
          const rx = this.getTargetRx();
          const s = this._rxSnap(rx);
          const b = this._builders();
          if (this.state && typeof this.state.updateRx === 'function') {
            this.state.updateRx(rx, { nbLevel: v }, `${rx}.nbLevel`);
          }
          this._sendCat(b.nb ? b.nb(rx, v, Boolean(s.nbOn)) : `NB${rx === 'B' ? '$' : ''}${String(v).padStart(2, '0')}${s.nbOn ? '1' : '0'};`);
        },
      });
      dspCard.appendChild(this._refs.nbSlider.row);

      this._refs.nrSwitch = makeSwitchRow('Noise Reduction', () => {
        const rx = this.getTargetRx();
        const s = this._rxSnap(rx);
        const nextOn = !s.nrOn;
        const mode = s.nrMode === 'ssnr' ? 'ssnr' : 'lms';
        if (typeof this.client.setNr === 'function') {
          this.client.setNr(rx, { on: nextOn, mode });
        } else {
          const b = this._builders();
          const rawLvl = mode === 'ssnr' ? s.ssnrLevel : s.lmsNrLevel;
          const defLvl = mode === 'ssnr' ? 5 : 4;
          const maxLvl = mode === 'ssnr' ? 25 : 10;
          const lvl = nextOn
            ? (rawLvl > 0 ? clamp(Math.round(rawLvl), 1, maxLvl) : defLvl)
            : clamp(Math.round(rawLvl || 0), 0, maxLvl);
          const cmd = mode === 'ssnr'
            ? (b.ssnr ? b.ssnr(rx, lvl, nextOn) : `NRS${rx === 'B' ? '$' : ''}${String(lvl).padStart(2, '0')}${nextOn ? '1' : '0'};`)
            : (b.nr ? b.nr(rx, lvl, nextOn) : `NR${rx === 'B' ? '$' : ''}${String(lvl).padStart(2, '0')}${nextOn ? '1' : '0'};`);
          this._sendCat(cmd);
        }
      });
      this._refs.nrSwitch.btn.dataset.testid = 'nr-switch';
      this._refs.nrSwitch.row.style.flexWrap = 'wrap';

      const nrCtrlGroup = el('div', '');
      nrCtrlGroup.style.display = 'inline-flex';
      nrCtrlGroup.style.alignItems = 'center';
      nrCtrlGroup.style.gap = '6px';
      nrCtrlGroup.style.marginLeft = 'auto';

      const nrModeSeg = el('div', 'k4-seg-group');
      nrModeSeg.style.padding = '2px';
      nrModeSeg.style.gap = '2px';
      const makeNrModeBtn = (mode, label) => {
        const btn = el('button', 'k4-seg-btn', label);
        btn.type = 'button';
        btn.dataset.testid = `nr-mode-${mode}`;
        btn.style.minHeight = '22px';
        btn.style.padding = '2px 7px';
        btn.setAttribute('aria-pressed', 'false');
        btn.addEventListener('click', () => {
          const rx = this.getTargetRx();
          const s = this._rxSnap(rx);
          if (typeof this.client.setNr === 'function') {
            this.client.setNr(rx, { mode });
          } else {
            const on = Boolean(s.nrOn);
            const b = this._builders();
            const rawLvl = mode === 'ssnr' ? s.ssnrLevel : s.lmsNrLevel;
            const defLvl = mode === 'ssnr' ? 5 : 4;
            const maxLvl = mode === 'ssnr' ? 25 : 10;
            const lvl = rawLvl > 0 ? clamp(Math.round(rawLvl), 1, maxLvl) : defLvl;
            const cmd = mode === 'ssnr'
              ? (b.ssnr ? b.ssnr(rx, lvl, on) : `NRS${rx === 'B' ? '$' : ''}${String(lvl).padStart(2, '0')}${on ? '1' : '0'};`)
              : (b.nr ? b.nr(rx, lvl, on) : `NR${rx === 'B' ? '$' : ''}${String(lvl).padStart(2, '0')}${on ? '1' : '0'};`);
            this._sendCat(cmd);
          }
        });
        return btn;
      };
      const nrModeLmsBtn = makeNrModeBtn('lms', 'LMS');
      const nrModeSsnrBtn = makeNrModeBtn('ssnr', 'SSNR');
      nrModeSeg.appendChild(nrModeLmsBtn);
      nrModeSeg.appendChild(nrModeSsnrBtn);
      this._refs.nrModeBtns = { lms: nrModeLmsBtn, ssnr: nrModeSsnrBtn };

      nrCtrlGroup.appendChild(nrModeSeg);
      nrCtrlGroup.appendChild(this._refs.nrSwitch.btn);
      this._refs.nrSwitch.row.appendChild(nrCtrlGroup);
      dspCard.appendChild(this._refs.nrSwitch.row);

      this._refs.nrSlider = makeSliderRow({
        label: 'NR Level',
        min: 1,
        max: 10,
        step: 1,
        value: 4,
        formatValue: (v) => String(Math.round(v)),
        onInput: (v) => {
          const rx = this.getTargetRx();
          const s = this._rxSnap(rx);
          const mode = s.nrMode === 'ssnr' ? 'ssnr' : 'lms';
          const maxLvl = mode === 'ssnr' ? 25 : 10;
          const level = clamp(Math.round(Number(v) || 1), 1, maxLvl);
          if (typeof this.client.setNr === 'function') {
            this.client.setNr(rx, { mode, level });
          } else {
            const on = Boolean(s.nrOn);
            const b = this._builders();
            const cmd = mode === 'ssnr'
              ? (b.ssnr ? b.ssnr(rx, level, on) : `NRS${rx === 'B' ? '$' : ''}${String(level).padStart(2, '0')}${on ? '1' : '0'};`)
              : (b.nr ? b.nr(rx, level, on) : `NR${rx === 'B' ? '$' : ''}${String(level).padStart(2, '0')}${on ? '1' : '0'};`);
            this._sendCat(cmd);
          }
        },
      });
      this._refs.nrSlider.input.dataset.testid = 'nr-slider';
      dspCard.appendChild(this._refs.nrSlider.row);

      this._refs.nmSwitch = makeSwitchRow('Manual Notch', () => {
        const rx = this.getTargetRx();
        const s = this._rxSnap(rx);
        const b = this._builders();
        const next = !s.notchOn;
        if (this.state && typeof this.state.updateRx === 'function') {
          this.state.updateRx(rx, { notchOn: next }, `${rx}.notchOn`);
        }
        this._sendCat(b.notch ? b.notch(rx, s.notchHz ?? 750, next) : `NM${rx === 'B' ? '$' : ''}${String(s.notchHz ?? 750).padStart(4, '0')}${next ? '1' : '0'};`);
      });
      dspCard.appendChild(this._refs.nmSwitch.row);

      this._refs.nmSlider = makeSliderRow({
        label: 'Notch Freq',
        min: 150,
        max: 5000,
        step: 10,
        value: 750,
        formatValue: (v) => `${v} Hz`,
        onInput: (v) => {
          const rx = this.getTargetRx();
          const s = this._rxSnap(rx);
          const b = this._builders();
          if (this.state && typeof this.state.updateRx === 'function') {
            this.state.updateRx(rx, { notchHz: v }, `${rx}.notchHz`);
          }
          this._sendCat(b.notch ? b.notch(rx, v, Boolean(s.notchOn)) : `NM${rx === 'B' ? '$' : ''}${String(v).padStart(4, '0')}${s.notchOn ? '1' : '0'};`);
        },
      });
      dspCard.appendChild(this._refs.nmSlider.row);

      pane.appendChild(dspCard);

      const ritApfCard = makeCard('RIT & CW Peaking');
      this._refs.ritSwitch = makeSwitchRow('RIT', () => {
        const rx = this.getTargetRx();
        const s = this._rxSnap(rx);
        this.client.setRit(rx, { on: !s.ritOn });
      });
      this._refs.ritSwitch.btn.dataset.testid = 'rit-switch';
      ritApfCard.appendChild(this._refs.ritSwitch.row);

      this._refs.ritOffsetSlider = makeSliderRow({
        label: 'RIT Offset',
        min: -3000,
        max: 3000,
        step: 10,
        value: 0,
        formatValue: (v) => `${v > 0 ? '+' : ''}${Math.round(v)} Hz`,
        onChange: (v) => this.client.setRit(this.getTargetRx(), { offsetHz: Math.round(v) }),
      });
      this._refs.ritOffsetSlider.input.dataset.testid = 'rit-offset-slider';
      ritApfCard.appendChild(this._refs.ritOffsetSlider.row);

      const ritQuick = el('div', 'k4-rit-quick-row');
      const ritDeltas = [-50, -10, 0, 10, 50];
      for (let i = 0; i < ritDeltas.length; i++) {
        const delta = ritDeltas[i];
        const btn = el('button', 'k4-seg-btn', delta === 0 ? 'Clear' : `${delta > 0 ? '+' : ''}${delta}`);
        btn.type = 'button';
        if (delta === 0) {
          btn.dataset.testid = 'rit-clear-btn';
          btn.addEventListener('click', () => this.client.clearRit(this.getTargetRx()));
        } else {
          btn.addEventListener('click', () => {
            const rx = this.getTargetRx();
            const s = this._rxSnap(rx);
            this.client.setRit(rx, { offsetHz: (s.ritOffsetHz || 0) + delta });
          });
        }
        ritQuick.appendChild(btn);
      }
      ritApfCard.appendChild(ritQuick);

      this._refs.apfSwitch = makeSwitchRow('CW Audio Peak Filter', () => {
        const rx = this.getTargetRx();
        const s = this._rxSnap(rx);
        this.client.setApf(rx, { on: !s.apfOn });
      });
      this._refs.apfSwitch.btn.dataset.testid = 'apf-switch';
      ritApfCard.appendChild(this._refs.apfSwitch.row);

      ritApfCard.appendChild(el('span', 'k4-slider-label', 'CW APF Width'));
      const apfSeg = el('div', 'k4-seg-group');
      const apfWidths = ['30 Hz', '50 Hz', '150 Hz'];
      this._refs.apfBwBtns = [];
      for (let i = 0; i < apfWidths.length; i++) {
        const b = el('button', 'k4-seg-btn', apfWidths[i]);
        b.type = 'button';
        b.dataset.apfBw = String(i);
        b.addEventListener('click', () => this.client.setApf(this.getTargetRx(), { bwIdx: i }));
        apfSeg.appendChild(b);
        this._refs.apfBwBtns.push(b);
      }
      ritApfCard.appendChild(apfSeg);

      ritApfCard.appendChild(el('span', 'k4-slider-label', 'CW Zero-Beat & Spot'));
      const spotGrid = el('div', 'k4-btn-grid k4-btn-grid--2');
      const autoSpotBtn = el('button', 'k4-btn k4-btn--amber', 'Auto Spot');
      autoSpotBtn.type = 'button';
      autoSpotBtn.dataset.testid = 'auto-spot-btn';
      autoSpotBtn.title = 'Zero-beat CW signal on active VFO';
      autoSpotBtn.addEventListener('click', () => {
        const rx = this.getTargetRx();
        if (typeof this.client.autoSpot === 'function') {
          this.client.autoSpot(rx);
        } else {
          this._sendCat(`SP${rx === 'B' ? '$' : ''}3;`);
        }
      });

      const cwSpotBtn = el('button', 'k4-btn', 'Spot Tone');
      cwSpotBtn.type = 'button';
      cwSpotBtn.dataset.testid = 'cw-spot-btn';
      cwSpotBtn.setAttribute('aria-pressed', 'false');
      cwSpotBtn.title = 'Toggle CW Spot sidetone pitch reference';
      cwSpotBtn.addEventListener('click', () => {
        const snap = this._snap();
        const rx = this.getTargetRx();
        const rxS = (rx === 'B' ? snap.rxB : snap.rxA) || {};
        const nextOn = !(snap.spotTone || snap.cwSpotOn || rxS.spotMode === 1 || rxS.spotMode === 2);
        if (typeof this.client.setSpotTone === 'function') {
          this.client.setSpotTone(nextOn ? 1 : 0, 'A');
        } else {
          this._sendCat(`SP${nextOn ? '1' : '0'};`);
        }
      });

      spotGrid.appendChild(autoSpotBtn);
      spotGrid.appendChild(cwSpotBtn);
      ritApfCard.appendChild(spotGrid);
      this._refs.autoSpotBtn = autoSpotBtn;
      this._refs.cwSpotBtn = cwSpotBtn;

      pane.appendChild(ritApfCard);

      const tdCard = makeCard('CW / Data Text Decode');
      const tdRow = el('div', 'k4-decode-row');
      const tdSelect = document.createElement('select');
      tdSelect.className = 'k4-select';
      tdSelect.dataset.testid = 'dsp-td-select';
      tdSelect.setAttribute('aria-label', 'Text Decode Mode');
      tdSelect.addEventListener('change', () => {
        if (typeof this.client.setTextDecode === 'function') {
          this.client.setTextDecode(this.getTargetRx(), { mode: Number(tdSelect.value) });
        }
      });
      tdRow.appendChild(tdSelect);
      this._refs.tdSelect = tdSelect;

      const tdThreshSelect = document.createElement('select');
      tdThreshSelect.className = 'k4-select';
      tdThreshSelect.dataset.testid = 'dsp-td-thresh';
      tdThreshSelect.setAttribute('aria-label', 'CW Decode Threshold');
      const autoOpt = document.createElement('option');
      autoOpt.value = '0';
      autoOpt.textContent = 'Thr: AUTO';
      tdThreshSelect.appendChild(autoOpt);
      for (let t = 1; t <= 9; t++) {
        const opt = document.createElement('option');
        opt.value = String(t);
        opt.textContent = `Thr: ${t}`;
        tdThreshSelect.appendChild(opt);
      }
      tdThreshSelect.addEventListener('change', () => {
        if (typeof this.client.setTextDecode === 'function') {
          this.client.setTextDecode(this.getTargetRx(), {
            threshold: Number(tdThreshSelect.value),
          });
        }
      });
      tdRow.appendChild(tdThreshSelect);
      this._refs.tdThreshSelect = tdThreshSelect;
      tdCard.appendChild(tdRow);

      this._refs.tdNote = el('div', 'k4-decode-note', 'Requires CW, CW-R, FSK-D, or PSK-D mode');
      tdCard.appendChild(this._refs.tdNote);
      pane.appendChild(tdCard);

      return pane;
    }

    _dispRx(snapshot) {
      const s = snapshot || this._snap();
      return K4.CatCodec && K4.CatCodec.resolveDisplayRx
        ? K4.CatCodec.resolveDisplayRx(s, this.getTargetRx())
        : s.dualPanMode === 2
        ? this.getTargetRx()
        : s.dualPanMode === 1
        ? 'B'
        : 'A';
    }

    _buildDisplayPane() {
      const pane = el('div', 'k4-panel-pane');

      const panBadge = el('span', 'k4-pane-badge', 'PAN A');
      this._refs.dispBadge = panBadge;
      const spanCard = makeCard('PAN & REF LVL', panBadge);
      const spanGrid = el('div', 'k4-pill-grid');
      this._refs.spanBtns = [];
      for (let i = 0; i < SPAN_PRESETS.length; i++) {
        const hz = SPAN_PRESETS[i];
        const btn = el('button', 'k4-choice-pill', `${hz / 1000}k`);
        btn.type = 'button';
        btn.addEventListener('click', () => {
          const rx = this._dispRx();
          if (this.panadapter && typeof this.panadapter.resetViewport === 'function') {
            this.panadapter.resetViewport(rx, { syncRadioSpan: false });
          }
          this.client.setDisplay(rx, { panSpanHz: hz });
        });
        spanGrid.appendChild(btn);
        this._refs.spanBtns.push({ hz, btn });
      }
      spanCard.appendChild(spanGrid);

      this._refs.spanSlider = makeSliderRow({
        label: 'PAN Span',
        min: 6,
        max: 368,
        step: 1,
        value: 48,
        formatValue: (v) => `${v} kHz`,
        onInput: (v) => {
          const rx = this._dispRx();
          if (this.panadapter && typeof this.panadapter.resetViewport === 'function') {
            this.panadapter.resetViewport(rx, { syncRadioSpan: false });
          }
          this.client.setDisplay(rx, { panSpanHz: v * 1000 });
        },
      });
      spanCard.appendChild(this._refs.spanSlider.row);

      this._refs.refSlider = makeSliderRow({
        label: 'REF LVL',
        min: -160,
        max: 0,
        step: 1,
        value: -110,
        formatValue: (v) => `${v} dBm`,
        onInput: (v) => {
          this.client.setDisplay(this._dispRx(), { panRefDbm: v });
        },
      });
      spanCard.appendChild(this._refs.refSlider.row);

      this._refs.scaleSlider = makeSliderRow({
        label: 'Scale',
        min: 10,
        max: 150,
        step: 5,
        value: 80,
        formatValue: (v) => `${v} dB`,
        onInput: (v) => {
          this.client.setDisplay(this._dispRx(), { panScaleDb: v });
        },
      });
      spanCard.appendChild(this._refs.scaleSlider.row);

      this._refs.avgSlider = makeSliderRow({
        label: 'PAN Averaging',
        min: 1,
        max: 20,
        step: 1,
        value: 4,
        formatValue: (v) => `${v} frames`,
        onInput: (v) => {
          this.client.setDisplay(this._dispRx(), { panAvg: v });
        },
      });
      spanCard.appendChild(this._refs.avgSlider.row);

      this._refs.wbsSlider = makeSliderRow({
        label: 'WTR CLRS Floor',
        min: 5,
        max: 30,
        step: 1,
        value: 14,
        formatValue: (v) => String(v),
        onInput: (v) => {
          this.client.setDisplay(this._dispRx(), { wfBlack: v });
        },
      });
      spanCard.appendChild(this._refs.wbsSlider.row);

      this._refs.autoRefSwitch = makeSwitchRow('Auto-Reference', () => {
        const rx = this._dispRx();
        const s = this._rxSnap(rx);
        this.client.setDisplay(rx, { autoRef: !s.autoRef });
      });
      spanCard.appendChild(this._refs.autoRefSwitch.row);

      const actRow = el('div', 'k4-pill-grid k4-pill-grid--2');
      const centerBtn = el('button', 'k4-choice-pill', 'Center on VFO');
      centerBtn.type = 'button';
      centerBtn.addEventListener('click', () => {
        const rx = this._dispRx();
        if (this.panadapter && typeof this.panadapter.resetViewport === 'function') {
          this.panadapter.resetViewport(rx, { syncRadioSpan: true });
        } else {
          const b = this._builders();
          this._sendCat(b.centerPan ? b.centerPan(rx) : rx === 'B' ? 'FC$;' : 'FC;');
        }
      });
      const arNowBtn = el('button', 'k4-choice-pill', 'Auto-Ref Now');
      arNowBtn.type = 'button';
      arNowBtn.addEventListener('click', () => {
        if (typeof this.client.applyAutoRefNow === 'function') {
          this.client.applyAutoRefNow();
        } else {
          const b = this._builders();
          this._sendCat((b.autoRefOneShot ? b.autoRefOneShot() : '#AR1;') + '#REF;#REF$;');
        }
      });
      actRow.appendChild(centerBtn);
      actRow.appendChild(arNowBtn);
      spanCard.appendChild(actRow);

      spanCard.appendChild(el('span', 'k4-slider-label', 'Cursor Mode'));
      const cursorGrid = el('div', 'k4-pill-grid k4-pill-grid--3');
      cursorGrid.dataset.testid = 'cursor-mode-group';
      this._refs.cursorModeBtns = [];
      for (let i = 0; i < CURSOR_MODES.length; i++) {
        const cm = CURSOR_MODES[i];
        const btn = el('button', 'k4-choice-pill', cm.label);
        btn.type = 'button';
        btn.dataset.cursorMode = cm.key;
        btn.addEventListener('click', () => {
          if (this.panadapter) this.panadapter._autoFixedTuneFromDrag = false;
          const patch = cm.mode === null ? { fixedTune: false } : { fixedTune: true, fixedTuneMode: cm.mode };
          this.client.setDisplay(this._dispRx(), patch);
        });
        cursorGrid.appendChild(btn);
        this._refs.cursorModeBtns.push({ cm, btn });
      }
      spanCard.appendChild(cursorGrid);

      this._refs.freezeSwitch = makeSwitchRow('Freeze WTRFALL', () => {
        const s = this._snap();
        this.client.setDisplay(this._dispRx(s), { panFrozen: !s.panFrozen });
      });
      this._refs.freezeSwitch.btn.dataset.testid = 'display-freeze-switch';
      spanCard.appendChild(this._refs.freezeSwitch.row);

      this._refs.fpsSlider = makeSliderRow({
        label: 'Frame Rate',
        min: 5,
        max: 30,
        step: 1,
        value: 20,
        formatValue: (v) => `${Math.round(v)} fps`,
        onChange: (v) => this.client.setDisplay(this._dispRx(), { panFps: Math.round(v) }),
      });
      this._refs.fpsSlider.input.dataset.testid = 'fps-slider';
      spanCard.appendChild(this._refs.fpsSlider.row);

      spanCard.appendChild(el('span', 'k4-slider-label', 'PAN DDC Blanker'));
      const panNbSeg = el('div', 'k4-seg-group');
      const panNbModes = [
        [0, 'Off'],
        [1, 'On'],
        [2, 'Auto'],
      ];
      this._refs.panNbBtns = [];
      for (let i = 0; i < panNbModes.length; i++) {
        const [val, text] = panNbModes[i];
        const b = el('button', 'k4-seg-btn', text);
        b.type = 'button';
        b.dataset.panNb = String(val);
        b.addEventListener('click', () => this.client.setDisplay(this._dispRx(), { panNbMode: val }));
        panNbSeg.appendChild(b);
        this._refs.panNbBtns.push(b);
      }
      spanCard.appendChild(panNbSeg);

      this._refs.panNbLevelSlider = makeSliderRow({
        label: 'Pan NB Level',
        min: 0,
        max: 14,
        step: 1,
        value: 0,
        formatValue: (v) => `${Math.round(v)}`,
        onChange: (v) => this.client.setDisplay(this._dispRx(), { panNbLevel: Math.round(v) }),
      });
      this._refs.panNbLevelSlider.input.dataset.testid = 'pan-nbl-slider';
      spanCard.appendChild(this._refs.panNbLevelSlider.row);

      pane.appendChild(spanCard);

      const layoutCard = makeCard('WTRFALL & WTR CLRS');
      const dpmGroup = el('div', 'k4-seg-group');
      const dpmMain = el('button', 'k4-seg-btn', '1x Main (A)');
      dpmMain.type = 'button';
      dpmMain.addEventListener('click', () =>
        this.client.setDisplay(this._dispRx(), { dualPanMode: 0 })
      );
      const dpmSub = el('button', 'k4-seg-btn is-amber', '1x Sub (B)');
      dpmSub.type = 'button';
      dpmSub.addEventListener('click', () =>
        this.client.setDisplay(this._dispRx(), { dualPanMode: 1 })
      );
      const dpmDual = el('button', 'k4-seg-btn', '2x Dual');
      dpmDual.type = 'button';
      dpmDual.addEventListener('click', () =>
        this.client.setDisplay(this._dispRx(), { dualPanMode: 2 })
      );
      dpmGroup.appendChild(dpmMain);
      dpmGroup.appendChild(dpmSub);
      dpmGroup.appendChild(dpmDual);
      layoutCard.appendChild(dpmGroup);
      this._refs.dpmBtns = { 0: dpmMain, 1: dpmSub, 2: dpmDual };

      this._refs.miniPanASwitch = makeSwitchRow('Mini-Pan VFO A', () => {
        const s = this._rxSnap('A');
        this.client.setDisplay('A', { miniPan: !s.miniPan });
      });
      layoutCard.appendChild(this._refs.miniPanASwitch.row);

      this._refs.miniPanBSwitch = makeSwitchRow('Mini-Pan VFO B', () => {
        const s = this._rxSnap('B');
        this.client.setDisplay('B', { miniPan: !s.miniPan });
      });
      layoutCard.appendChild(this._refs.miniPanBSwitch.row);

      this._refs.peakHoldSwitch = makeSwitchRow('Peak Hold Trace', () => {
        this.onSetPeakHold(!this.getPeakHold());
      });
      this._refs.peakHoldSwitch.btn.dataset.testid = 'peak-hold-switch';
      layoutCard.appendChild(this._refs.peakHoldSwitch.row);

      layoutCard.appendChild(el('span', 'k4-slider-label', 'WTR CLRS Palette'));
      const palGrid = el('div', 'k4-pill-grid k4-pill-grid--2');
      this._refs.paletteBtns = {};
      for (let i = 0; i < PALETTES.length; i++) {
        const p = PALETTES[i];
        const btn = el('button', 'k4-choice-pill', p.label);
        btn.type = 'button';
        btn.addEventListener('click', () => this.onSetPalette(p.id));
        palGrid.appendChild(btn);
        this._refs.paletteBtns[p.id] = btn;
      }
      layoutCard.appendChild(palGrid);

      layoutCard.appendChild(el('span', 'k4-slider-label', 'Display Mode'));
      const dsmSeg = el('div', 'k4-seg-group');
      const specWfBtn = el('button', 'k4-seg-btn', 'Spec + WF');
      specWfBtn.type = 'button';
      specWfBtn.dataset.testid = 'dsm-spec-wf';
      specWfBtn.dataset.dsm = '1';
      specWfBtn.addEventListener('click', () => {
        const snap = this.state.getSnapshot();
        this.client.setDisplay(this._dispRx(snap), { displayMode: 1 });
      });
      const specOnlyBtn = el('button', 'k4-seg-btn', 'Spectrum Only');
      specOnlyBtn.type = 'button';
      specOnlyBtn.dataset.testid = 'dsm-spec-only';
      specOnlyBtn.dataset.dsm = '0';
      specOnlyBtn.addEventListener('click', () => {
        const snap = this.state.getSnapshot();
        this.client.setDisplay(this._dispRx(snap), { displayMode: 0 });
      });
      dsmSeg.appendChild(specWfBtn);
      dsmSeg.appendChild(specOnlyBtn);
      layoutCard.appendChild(dsmSeg);
      this._refs.dsmBtns = [specWfBtn, specOnlyBtn];

      this._refs.wfhSlider = makeSliderRow({
        label: 'WTRFALL Height',
        min: 20,
        max: 80,
        step: 5,
        value: 60,
        formatValue: (v) => `${Math.round(v)}%`,
        onChange: (v) => {
          const snap = this.state.getSnapshot();
          this.client.setDisplay(this._dispRx(snap), { waterfallHeightPct: Math.round(v) });
        },
      });
      this._refs.wfhSlider.input.dataset.testid = 'wfh-slider';
      layoutCard.appendChild(this._refs.wfhSlider.row);

      layoutCard.appendChild(el('span', 'k4-slider-label', 'Mouse L/R Button QSY'));
      const qsySeg = el('div', 'k4-seg-group');
      const lrBtn = el('button', 'k4-seg-btn', 'Left=A, Right=B');
      lrBtn.type = 'button';
      lrBtn.dataset.testid = 'mouse-qsy-lr';
      lrBtn.dataset.qsyMode = 'lr';
      lrBtn.addEventListener('click', () => this.onSetMouseQsyMode('lr'));
      const paneBtn = el('button', 'k4-seg-btn', 'Left Only (Pan=VFO)');
      paneBtn.type = 'button';
      paneBtn.dataset.testid = 'mouse-qsy-pane';
      paneBtn.dataset.qsyMode = 'pane';
      paneBtn.addEventListener('click', () => this.onSetMouseQsyMode('pane'));
      qsySeg.appendChild(lrBtn);
      qsySeg.appendChild(paneBtn);
      layoutCard.appendChild(qsySeg);
      this._refs.mouseQsyBtns = [lrBtn, paneBtn];

      pane.appendChild(layoutCard);

      return pane;
    }

    _buildAudioPane() {
      const pane = el('div', 'k4-panel-pane');

      const scopeCard = makeCard('AF Passband Scope & Clip Recorder');
      const scopeCanvas = document.createElement('canvas');
      scopeCanvas.className = 'k4-af-scope-canvas';
      scopeCanvas.width = 320;
      scopeCanvas.height = 96;
      scopeCanvas.dataset.testid = 'af-scope-canvas';
      scopeCard.appendChild(scopeCanvas);
      this._refs.afScopeCanvas = scopeCanvas;

      const wavBar = el('div', 'k4-wav-bar');
      const wavBtn = el('button', 'k4-btn-secondary', '● Record .wav');
      wavBtn.type = 'button';
      wavBtn.dataset.testid = 'wav-record-btn';
      const wavStatus = el('span', 'k4-mono-sm', 'Ready (12 kHz Stereo PCM16)');
      wavStatus.dataset.testid = 'wav-status';
      const wavLink = el('a', 'k4-mini-pill', 'Download .wav');
      wavLink.dataset.testid = 'wav-download-link';
      wavLink.hidden = true;
      wavLink.setAttribute('download', 'k4-clip.wav');

      wavBtn.addEventListener('click', () => {
        if (!this.audio) return;
        if (!this.audio.isRecording()) {
          if (this._wavBlobUrl) {
            URL.revokeObjectURL(this._wavBlobUrl);
            this._wavBlobUrl = null;
          }
          wavLink.hidden = true;
          this.audio.startRecording();
          wavBtn.textContent = '■ Stop .wav';
          wavBtn.classList.add('is-recording');
          wavStatus.textContent = 'Recording 0.0 s...';
        } else {
          const rec = this.audio.stopRecording();
          wavBtn.textContent = '● Record .wav';
          wavBtn.classList.remove('is-recording');
          const byteLen = rec && rec.wavBytes ? rec.wavBytes.byteLength : (rec && rec.blob ? rec.blob.size : 0);
          if (rec && rec.blob && byteLen > 0) {
            this._wavBlobUrl = URL.createObjectURL(rec.blob);
            wavLink.href = this._wavBlobUrl;
            wavLink.download = rec.filename || 'k4-clip.wav';
            wavLink.textContent = `Save ${(byteLen / 1024).toFixed(1)} KB .wav`;
            wavLink.hidden = false;
            wavStatus.textContent = `Captured ${rec.durationSec.toFixed(1)} s (${(byteLen / 1024).toFixed(1)} KB)`;
          } else {
            wavStatus.textContent = 'No audio frames captured';
          }
        }
      });

      wavBar.appendChild(wavBtn);
      wavBar.appendChild(wavStatus);
      wavBar.appendChild(wavLink);
      scopeCard.appendChild(wavBar);
      this._refs.wavBtn = wavBtn;
      this._refs.wavStatus = wavStatus;
      this._refs.wavLink = wavLink;
      pane.appendChild(scopeCard);
      this._syncAfScopeLoop();

      const audioCard = makeCard('Audio Mixer & Stream');
      const muteBtn = el('button', 'k4-btn-primary', 'Start & Unmute Audio');
      muteBtn.type = 'button';
      muteBtn.style.width = '100%';
      muteBtn.addEventListener('click', () => this.onToggleAudio());
      audioCard.appendChild(muteBtn);
      this._refs.panelAudioBtn = muteBtn;

      this._refs.gainASlider = makeSliderRow({
        label: 'Main RX Gain',
        min: 0,
        max: 100,
        step: 1,
        value: 100,
        formatValue: (v) => `${v}%`,
        onInput: (v) => {
          this._localAudio.gainA = v / 100;
          if (this.audio && this.audio.setVolume) this.audio.setVolume('A', this._localAudio.gainA);
        },
      });
      audioCard.appendChild(this._refs.gainASlider.row);

      this._refs.gainBSlider = makeSliderRow({
        label: 'Sub RX Gain',
        min: 0,
        max: 100,
        step: 1,
        value: 100,
        formatValue: (v) => `${v}%`,
        onInput: (v) => {
          this._localAudio.gainB = v / 100;
          if (this.audio && this.audio.setVolume) this.audio.setVolume('B', this._localAudio.gainB);
        },
      });
      audioCard.appendChild(this._refs.gainBSlider.row);

      this._refs.balanceSlider = makeSliderRow({
        label: 'Stereo Balance',
        min: -100,
        max: 100,
        step: 5,
        value: 0,
        formatValue: (v) => (v === 0 ? 'Center' : (v < 0 ? `${Math.abs(v)}% L` : `${v}% R`)),
        onInput: (v) => {
          this._localAudio.balance = v / 100;
          if (this.audio && this.audio.setBalance) this.audio.setBalance(this._localAudio.balance);
        },
      });
      audioCard.appendChild(this._refs.balanceSlider.row);

      audioCard.appendChild(el('span', 'k4-slider-label', 'Channel Mix'));
      const mixGrid = el('div', 'k4-pill-grid k4-pill-grid--5');
      this._refs.mixBtns = {};
      for (let i = 0; i < MIX_OPTIONS.length; i++) {
        const mx = MIX_OPTIONS[i];
        const btn = el('button', 'k4-choice-pill', mx);
        btn.type = 'button';
        btn.addEventListener('click', () => {
          this.client.setAudioMix(mx);
          if (this.audio && this.audio.setMixMode) this.audio.setMixMode(mx);
        });
        mixGrid.appendChild(btn);
        this._refs.mixBtns[mx] = btn;
      }
      audioCard.appendChild(mixGrid);

      this._refs.slSlider = makeSliderRow({
        label: 'Latency Tier',
        min: 0,
        max: 7,
        step: 1,
        value: 2,
        formatValue: (v) => `SL${v} (${LATENCY_MS[v] || 75} ms)`,
        onInput: (v) => {
          this.client.setLatencyTier(v);
          if (this.audio && this.audio.setLatencyTier) this.audio.setLatencyTier(v);
        },
      });
      audioCard.appendChild(this._refs.slSlider.row);

      const emLabel = el('span', 'k4-slider-label', 'Encode Mode');
      audioCard.appendChild(emLabel);
      const emSelect = document.createElement('select');
      emSelect.className = 'k4-select';
      const opusOk = Boolean(K4.OpusPacketDecoder && K4.OpusPacketDecoder.isSupported && K4.OpusPacketDecoder.isSupported());
      const emChoices = [
        { val: '1', label: 'PCM S16LE 12k (Lowest CPU)' },
        { val: '0', label: 'PCM 24-bit 12k' },
        { val: '3', label: opusOk ? 'Opus 48k Stereo (Low BW)' : 'Opus (unavailable on file://)' },
      ];
      for (let i = 0; i < emChoices.length; i++) {
        const opt = document.createElement('option');
        opt.value = emChoices[i].val;
        opt.textContent = emChoices[i].label;
        if (emChoices[i].val === '3' && !opusOk) opt.disabled = true;
        emSelect.appendChild(opt);
      }
      emSelect.addEventListener('change', () => {
        this.client.setEncodeMode(Number(emSelect.value));
      });
      audioCard.appendChild(emSelect);
      this._refs.emSelect = emSelect;
      pane.appendChild(audioCard);

      // Telemetry Card
      const diagCard = makeCard('Observatory Telemetry');
      const kvGrid = el('div', 'k4-kv-grid');
      const diagFields = [
        ['renderer', 'Renderer'],
        ['frames', 'Frames'],
        ['panTier', 'Pan Tier'],
        ['rtt', 'RTT'],
        ['e2eLatency', 'Audio Latency'],
        ['sink', 'Audio Sink'],
        ['bufferMs', 'Jitter Buf'],
        ['packets', 'Audio Pkts'],
        ['underruns', 'Underruns / Gaps'],
        ['supply', 'DC Supply'],
        ['cpuTemp', 'CPU / FP Temp'],
        ['paTemp', 'PA / LPA Temp'],
      ];
      this._refs.diag = {};
      for (let i = 0; i < diagFields.length; i++) {
        const [k, label] = diagFields[i];
        const box = el('div', 'k4-kv-item');
        box.appendChild(el('div', 'k4-kv-k', label));
        const val = el('div', 'k4-kv-v', '—');
        val.dataset.testid = `diag-${k}`;
        box.appendChild(val);
        kvGrid.appendChild(box);
        this._refs.diag[k] = val;
      }
      diagCard.appendChild(kvGrid);
      pane.appendChild(diagCard);

      return pane;
    }

    _buildTunePane() {
      const pane = el('div', 'k4-panel-pane k4-pane--tune');
      const card = makeCard('Direct frequency entry');

      const vfoOpRow = el('div', 'k4-pill-grid');
      vfoOpRow.dataset.testid = 'mobile-vfo-ops';
      const abBtn = el('button', 'k4-choice-pill', 'A/B');
      abBtn.type = 'button';
      abBtn.dataset.testid = 'mobile-vfo-ab-btn';
      const triggerSwap = (swapAll) => {
        const all = Boolean(swapAll);
        if (this.onSwapVfo) this.onSwapVfo(all);
        else if (typeof this.client.vfoSwap === 'function') this.client.vfoSwap(all);
        else if (typeof this.client.vfoCopy === 'function') this.client.vfoCopy(all ? 5 : 2);
        else this._sendCat(all ? 'AB5;' : 'AB2;');
      };
      let abHoldTimer = null;
      let abHoldTriggered = false;
      const clearAbHold = () => {
        if (abHoldTimer) {
          clearTimeout(abHoldTimer);
          abHoldTimer = null;
        }
      };
      abBtn.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        abHoldTriggered = false;
        clearAbHold();
        abHoldTimer = setTimeout(() => {
          abHoldTimer = null;
          abHoldTriggered = true;
          triggerSwap(true);
        }, 750);
      });
      abBtn.addEventListener('pointerup', clearAbHold);
      abBtn.addEventListener('pointercancel', clearAbHold);
      abBtn.addEventListener('pointerleave', clearAbHold);
      abBtn.addEventListener('click', (e) => {
        if (abHoldTriggered) {
          abHoldTriggered = false;
          return;
        }
        triggerSwap(Boolean(e.shiftKey));
      });
      const a2bBtn = el('button', 'k4-choice-pill', 'A►B');
      a2bBtn.type = 'button';
      a2bBtn.dataset.testid = 'mobile-vfo-a2b-btn';
      a2bBtn.addEventListener('click', (e) => {
        if (this.onTriggerA2B) this.onTriggerA2B(Boolean(e.shiftKey));
        else if (typeof this.client.vfoCopyAtoB === 'function') this.client.vfoCopyAtoB(Boolean(e.shiftKey));
        else if (typeof this.client.vfoCopy === 'function') this.client.vfoCopy(e.shiftKey ? 3 : 0);
        else this._sendCat(e.shiftKey ? 'AB3;' : 'AB0;');
      });
      const splitBtn = el('button', 'k4-choice-pill', 'SPLIT');
      splitBtn.type = 'button';
      splitBtn.addEventListener('click', () => {
        const next = !this._snap().splitEnabled;
        if (typeof this.client.setSplit === 'function') this.client.setSplit(next);
        else this._sendCat(`FT${next ? '1' : '0'};`);
      });
      const subBtn = el('button', 'k4-choice-pill is-vfo-b', 'SUB');
      subBtn.type = 'button';
      subBtn.addEventListener('click', () => {
        const next = !this._snap().subRxEnabled;
        if (typeof this.client.setSubRx === 'function') this.client.setSubRx(next);
        else this._sendCat(`SB${next ? '1' : '0'};`);
      });
      vfoOpRow.appendChild(abBtn);
      vfoOpRow.appendChild(a2bBtn);
      vfoOpRow.appendChild(splitBtn);
      vfoOpRow.appendChild(subBtn);
      card.appendChild(vfoOpRow);
      this._refs.mobileSplitBtn = splitBtn;
      this._refs.mobileSubBtn = subBtn;

      const topRow = el('div', 'k4-tune-top-row');

      const targetGroup = el('div', 'k4-seg-group k4-tune-rx-group');
      const btnA = el('button', 'k4-seg-btn', 'VFO A');
      btnA.type = 'button';
      btnA.addEventListener('click', () => this.onSetTargetRx('A'));
      const btnB = el('button', 'k4-seg-btn is-amber', 'VFO B');
      btnB.type = 'button';
      btnB.addEventListener('click', () => this.onSetTargetRx('B'));
      targetGroup.appendChild(btnA);
      targetGroup.appendChild(btnB);
      topRow.appendChild(targetGroup);
      this._refs.mobileTargetBtns = { A: btnA, B: btnB };

      const disp = el('div', 'k4-keypad-display');
      const dispVal = el('span', 'k4-keypad-val', 'MHz / kHz...');
      disp.appendChild(dispVal);
      topRow.appendChild(disp);
      card.appendChild(topRow);
      this._refs.keypadDisplay = dispVal;

      const pad = el('div', 'k4-keypad');
      const addDigitKey = (k, cls) => {
        const btn = el('button', cls ? `k4-key-btn ${cls}` : 'k4-key-btn', k);
        btn.type = 'button';
        btn.addEventListener('click', () => {
          if (k === '⌫') {
            this._keypadBuffer = this._keypadBuffer.slice(0, -1);
          } else if (k === 'CLR') {
            this._keypadBuffer = '';
          } else if (k === '.' && this._keypadBuffer.includes('.')) {
            return;
          } else {
            this._keypadBuffer += k;
          }
          this._syncKeypadDisplay();
        });
        pad.appendChild(btn);
      };

      const lockBtn = el('button', 'k4-key-btn k4-key-btn--fn', 'Lock VFO');
      lockBtn.type = 'button';
      lockBtn.addEventListener('click', () => {
        const rx = this.getTargetRx();
        const s = this._rxSnap(rx);
        if (typeof this.client.setLock === 'function') {
          this.client.setLock(rx, !s.locked);
        } else {
          const b = this._builders();
          this._sendCat(b.lock ? b.lock(rx, !s.locked) : `LK${rx === 'B' ? '$' : ''}${!s.locked ? '1' : '0'};`);
        }
      });
      this._refs.mobileLockBtn = lockBtn;

      const goBtn = el('button', 'k4-key-btn k4-key-btn--go', 'Tune Frequency');
      goBtn.type = 'button';
      goBtn.addEventListener('click', () => this._commitKeypad());

      // 4x4 grid (every row 44px, fits 46vh without clipping)
      addDigitKey('1');
      addDigitKey('2');
      addDigitKey('3');
      addDigitKey('⌫', 'k4-key-btn--fn');
      addDigitKey('4');
      addDigitKey('5');
      addDigitKey('6');
      addDigitKey('CLR', 'k4-key-btn--fn');
      addDigitKey('7');
      addDigitKey('8');
      addDigitKey('9');
      pad.appendChild(lockBtn);
      addDigitKey('.');
      addDigitKey('0');
      pad.appendChild(goBtn);

      card.appendChild(pad);

      const stepRow = el('div', 'k4-pill-grid');
      const mobileSteps = [
        { idx: 1, label: '10 Hz' },
        { idx: 2, label: '100 Hz' },
        { idx: 3, label: '1 kHz' },
        { idx: 5, label: '5 kHz' },
      ];
      this._refs.mobileStepBtns = [];
      for (let i = 0; i < mobileSteps.length; i++) {
        const ms = mobileSteps[i];
        const btn = el('button', 'k4-choice-pill', ms.label);
        btn.type = 'button';
        btn.addEventListener('click', () => {
          const rx = this.getTargetRx();
          if (typeof this.client.setStep === 'function') {
            this.client.setStep(rx, ms.idx);
          } else {
            const b = this._builders();
            const s = this._rxSnap(rx);
            this._sendCat(b.step ? b.step(rx, ms.idx, s.mode) : `VT${rx === 'B' ? '$' : ''}${ms.idx};`);
          }
        });
        stepRow.appendChild(btn);
        this._refs.mobileStepBtns.push({ idx: ms.idx, btn });
      }
      card.appendChild(stepRow);
      pane.appendChild(card);

      return pane;
    }

    _syncKeypadDisplay() {
      if (!this._refs.keypadDisplay) return;
      this._refs.keypadDisplay.textContent = this._keypadBuffer || 'MHz / kHz...';
    }

    _commitKeypad() {
      const s = this._keypadBuffer.trim();
      if (!s) return;
      let hz = null;
      if (s.includes('.')) {
        const val = parseFloat(s);
        if (val >= 0.1 && val <= 54) hz = Math.round(val * 1e6);
      } else {
        const n = parseInt(s, 10);
        if (n >= 100000 && n <= 54000000) hz = n;
        else if (n >= 100 && n <= 54000) hz = n * 1000;
        else if (n >= 1 && n <= 54) hz = n * 1000000;
      }
      if (hz !== null) {
        this.client.tune(this.getTargetRx(), hz, { optimistically: true });
        this._keypadBuffer = '';
        this._syncKeypadDisplay();
        this.closeMobileSheet();
      }
    }

    _uiPerf() {
      if (typeof window === 'undefined') return null;
      return (window.__k4UiPerf = window.__k4UiPerf || {
        fullRenders: 0,
        meterFastRenders: 0,
        inspectorUpdates: 0,
        inspectorTabSkips: 0,
        afScopeSkips: 0,
      });
    }

    _getVisibleTabId() {
      if (typeof window !== 'undefined' && window.innerWidth < 960) {
        return this._activeMobileTab || null;
      }
      if (!this.isDrawerOpen()) {
        return null;
      }
      return this._activeDesktopTab || 'band-mode';
    }

    _shouldRunAfScope() {
      if (typeof document !== 'undefined' && document.hidden) return false;
      if (this._getVisibleTabId() !== 'audio') return false;
      const canvas = this._refs.afScopeCanvas;
      if (!canvas || !canvas.isConnected) return false;
      const aDiag = this.audio && this.audio.getDiagnostics ? this.audio.getDiagnostics() : {};
      const isRec = Boolean(this.audio && typeof this.audio.isRecording === 'function' && this.audio.isRecording());
      return Boolean((aDiag.started && !aDiag.muted) || isRec);
    }

    _syncAfScopeLoop() {
      if (this._shouldRunAfScope()) {
        this._startAfScopeLoop();
      } else {
        if (this._afScopeTimer) {
          clearInterval(this._afScopeTimer);
          this._afScopeTimer = null;
        }
        const perf = this._uiPerf();
        if (perf) perf.afScopeSkips += 1;
      }
    }

    _startAfScopeLoop() {
      if (this._afScopeTimer) return;
      if (!this._shouldRunAfScope()) {
        const perf = this._uiPerf();
        if (perf) perf.afScopeSkips += 1;
        return;
      }
      this._afScopeTimer = setInterval(() => {
        if (!this._shouldRunAfScope()) {
          this._syncAfScopeLoop();
          return;
        }
        this._drawAfScope(this._snap());
      }, 120);
    }

    _drawAfScope(snapshot) {
      const canvas = this._refs.afScopeCanvas;
      if (!canvas || !canvas.isConnected) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      if (this.audio && typeof this.audio.isRecording === 'function' && this.audio.isRecording() && this._refs.wavStatus) {
        const st = this.audio.getRecordingStatus ? this.audio.getRecordingStatus() : {};
        const sec = Number(st.durationSec || (st.totalFrames ? st.totalFrames / 12000 : 0) || 0);
        this._refs.wavStatus.textContent = `Recording ${sec.toFixed(1)} s...`;
      }

      const w = canvas.width;
      const h = canvas.height;
      const maxHz = 3200;
      ctx.fillStyle = '#070A10';
      ctx.fillRect(0, 0, w, h);

      // 500 Hz grid lines
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
      ctx.lineWidth = 1;
      for (let hz = 500; hz < maxHz; hz += 500) {
        const x = Math.round((hz / maxHz) * w) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }

      const snap = snapshot || {};
      const rxS = (this.getTargetRx() === 'B' ? snap.rxB : snap.rxA) || {};
      const mode = rxS.mode;
      const bwHz = Number(rxS.bwHz) || 2700;

      // Passband & CW APF overlay
      if (mode === 3 || mode === 7) {
        const pitch = Number(snap.cwPitchHz) || 500;
        const x1 = Math.max(0, ((pitch - bwHz * 0.5) / maxHz) * w);
        const x2 = Math.min(w, ((pitch + bwHz * 0.5) / maxHz) * w);
        ctx.fillStyle = 'rgba(56, 189, 248, 0.12)';
        ctx.fillRect(x1, 0, Math.max(2, x2 - x1), h);
        if (rxS.apfOn) {
          const apfWidths = [30, 50, 150];
          const aw = apfWidths[rxS.apfBwIdx || 0] || 50;
          const ax1 = Math.max(0, ((pitch - aw * 0.5) / maxHz) * w);
          const ax2 = Math.min(w, ((pitch + aw * 0.5) / maxHz) * w);
          ctx.fillStyle = 'rgba(16, 185, 129, 0.28)';
          ctx.fillRect(ax1, 0, Math.max(2, ax2 - ax1), h);
        }
      } else {
        const x1 = (300 / maxHz) * w;
        const x2 = Math.min(w, ((300 + bwHz) / maxHz) * w);
        ctx.fillStyle = 'rgba(56, 189, 248, 0.10)';
        ctx.fillRect(x1, 0, Math.max(2, x2 - x1), h);
      }

      if (rxS.notchOn && rxS.notchHz > 0 && rxS.notchHz <= maxHz) {
        const nx = (rxS.notchHz / maxHz) * w;
        ctx.save();
        ctx.strokeStyle = 'rgba(34, 197, 94, 0.80)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(nx, 0);
        ctx.lineTo(nx, h);
        ctx.stroke();
        ctx.restore();
      }

      if (!this.audio || typeof this.audio.getAfSpectrum !== 'function') return;
      const spec = this.audio.getAfSpectrum(maxHz);
      const bins =
        Array.isArray(spec) || ArrayBuffer.isView(spec)
          ? spec
          : spec && spec.binsDb
            ? spec.binsDb
            : spec && spec.bins
              ? spec.bins
              : null;
      if (!bins || bins.length < 2) return;

      let hasNeg = false;
      for (let i = 0; i < bins.length; i++) {
        if (bins[i] < 0) {
          hasNeg = true;
          break;
        }
      }

      ctx.beginPath();
      for (let i = 0; i < bins.length; i++) {
        const x = (i / (bins.length - 1)) * w;
        const raw = bins[i];
        const norm = hasNeg ? Math.max(0, Math.min(1, (raw + 96) / 96)) : Math.max(0, Math.min(1, raw));
        const y = h - 4 - norm * (h - 10);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = '#38BDF8';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fillStyle = 'rgba(56, 189, 248, 0.18)';
      ctx.fill();
    }

    _buildTxPane() {
      const pane = el('div', 'k4-panel-pane');

      // (a) TX & Split card
      const statusBadge = el('span', 'k4-card-badge', 'RDY');
      const statusCard = makeCard('TX & Split', statusBadge);

      const txCtrlStack = el('div', 'k4-tx-card-controls');
      const txCardPttBtn = el('button', 'k4-ptt-btn k4-tx-card-ptt', 'PTT');
      txCardPttBtn.type = 'button';
      txCardPttBtn.dataset.testid = 'tx-card-ptt-btn';
      txCardPttBtn.setAttribute('aria-pressed', 'false');
      txCardPttBtn.title = 'Hold to transmit (release to return to receive)';
      let pttPtrId = null;
      txCardPttBtn.addEventListener('pointerdown', (e) => {
        if ((e.pointerType === 'mouse' && e.button !== 0) || txCardPttBtn.disabled) return;
        e.preventDefault();
        pttPtrId = e.pointerId != null ? e.pointerId : 0;
        if (e.pointerId != null) {
          try {
            txCardPttBtn.setPointerCapture(e.pointerId);
          } catch (_) {}
        }
        this.onBeginHoldPtt();
      });
      const stopCardPtt = (e) => {
        if (pttPtrId === null) return;
        if (e && e.pointerId != null && e.pointerId !== pttPtrId && e.type !== 'lostpointercapture') {
          return;
        }
        const activeId = pttPtrId;
        pttPtrId = null;
        try {
          if (txCardPttBtn.hasPointerCapture && txCardPttBtn.hasPointerCapture(activeId)) {
            txCardPttBtn.releasePointerCapture(activeId);
          }
        } catch (_) {}
        this.onEndHoldPtt();
      };
      txCardPttBtn.addEventListener('pointerup', stopCardPtt);
      txCardPttBtn.addEventListener('pointercancel', stopCardPtt);
      txCardPttBtn.addEventListener('lostpointercapture', stopCardPtt);
      txCardPttBtn.addEventListener('contextmenu', (e) => e.preventDefault());
      txCardPttBtn.addEventListener('click', (e) => e.preventDefault());

      const testToggleBtn = el('button', 'k4-seg-btn k4-test-switch', 'TEST');
      testToggleBtn.type = 'button';
      testToggleBtn.dataset.testid = 'tx-card-test-btn';
      testToggleBtn.style.width = '100%';
      testToggleBtn.title = 'K4 TEST switch: toggle off-air TX Test without altering RF power setting';
      testToggleBtn.addEventListener('click', () => this.onToggleTxTest());
      txCtrlStack.appendChild(txCardPttBtn);
      txCtrlStack.appendChild(testToggleBtn);
      statusCard.appendChild(txCtrlStack);
      this._refs.txCardPttBtn = txCardPttBtn;
      this._refs.txTestToggleBtn = testToggleBtn;

      const txBanner = el('div', 'k4-tx-banner', '');
      txBanner.hidden = true;
      txBanner.dataset.state = 'matched';
      statusCard.appendChild(txBanner);
      this._refs.txStatusBanner = txBanner;
      this._refs.txStatusBadge = statusBadge;

      const metaRow = el('div', 'k4-diag-list');
      const vfoRow = el('div', 'k4-diag-row');
      vfoRow.appendChild(el('span', 'k4-diag-key', 'Active TX VFO'));
      const txVfoVal = el('span', 'k4-diag-val', 'VFO A');
      vfoRow.appendChild(txVfoVal);
      metaRow.appendChild(vfoRow);

      const totRow = el('div', 'k4-diag-row');
      totRow.appendChild(el('span', 'k4-diag-key', 'TX Timeout'));
      const txTotVal = el('span', 'k4-diag-val', '3:00');
      totRow.appendChild(txTotVal);
      metaRow.appendChild(totRow);
      statusCard.appendChild(metaRow);
      this._refs.txVfoVal = txVfoVal;
      this._refs.txTotVal = txTotVal;

      const splitSwitch = makeSwitchRow('Split TX on VFO B', () => {
        const next = !this._snap().splitEnabled;
        if (typeof this.client.setSplit === 'function') {
          this.client.setSplit(next);
        } else {
          this._sendCat(`FT${next ? '1' : '0'};`);
        }
      });
      statusCard.appendChild(splitSwitch.row);
      this._refs.txSplitSwitch = splitSwitch;

      const splitMacroRow = el('div', 'k4-btn-grid k4-btn-grid--2');
      const quickSplitBtn = el('button', 'k4-btn', 'A►B Split +1 kHz');
      quickSplitBtn.type = 'button';
      quickSplitBtn.addEventListener('click', () => {
        if (typeof this.client.setupQuickSplit === 'function') {
          this.client.setupQuickSplit(1000);
        } else {
          const base = Number((this._snap().rxA || {}).freqHz) || 14074000;
          this._sendCat(`FB${String(base + 1000).padStart(11, '0')};`);
          this._sendCat('FT1;');
        }
      });
      const panicBtn = el('button', 'k4-btn k4-btn--danger', 'STOP TX · RX (Esc)');
      panicBtn.type = 'button';
      panicBtn.dataset.testid = 'stop-tx-btn';
      panicBtn.title = 'Stop transmission, cancel tune/playback, and return to receive (Esc)';
      panicBtn.addEventListener('click', () => this.onPanicAbort());
      splitMacroRow.appendChild(quickSplitBtn);
      splitMacroRow.appendChild(panicBtn);
      statusCard.appendChild(splitMacroRow);

      const xitSwitch = makeSwitchRow('XIT Offset', () => {
        const snap = this._snap();
        const next = !snap.xitEnabled;
        if (typeof this.client.setXit === 'function') {
          this.client.setXit(next);
        } else {
          this._sendCat(`XT${next ? '1' : '0'};`);
        }
      });
      statusCard.appendChild(xitSwitch.row);
      this._refs.txXitSwitch = xitSwitch;

      const xitCtrlRow = el('div', 'k4-btn-grid k4-btn-grid--3');
      const xitDownBtn = el('button', 'k4-btn', 'XIT -100');
      xitDownBtn.type = 'button';
      xitDownBtn.addEventListener('click', () => {
        const cur = Number((this._snap().rxA || {}).ritOffsetHz) || 0;
        if (typeof this.client.setXit === 'function') {
          this.client.setXit(true, cur - 100);
        } else {
          this._sendCat('RD0100;');
        }
      });
      const xitZeroBtn = el('button', 'k4-btn', 'XIT 0 Hz');
      xitZeroBtn.type = 'button';
      xitZeroBtn.addEventListener('click', () => {
        if (typeof this.client.setXit === 'function') {
          this.client.setXit(Boolean(this._snap().xitEnabled), 0);
        } else {
          this._sendCat('RC;');
        }
      });
      const xitUpBtn = el('button', 'k4-btn', 'XIT +100');
      xitUpBtn.type = 'button';
      xitUpBtn.addEventListener('click', () => {
        const cur = Number((this._snap().rxA || {}).ritOffsetHz) || 0;
        if (typeof this.client.setXit === 'function') {
          this.client.setXit(true, cur + 100);
        } else {
          this._sendCat('RU0100;');
        }
      });
      xitCtrlRow.appendChild(xitDownBtn);
      xitCtrlRow.appendChild(xitZeroBtn);
      xitCtrlRow.appendChild(xitUpBtn);
      statusCard.appendChild(xitCtrlRow);
      this._refs.txXitZeroBtn = xitZeroBtn;

      pane.appendChild(statusCard);

      // (b) ATU & Antenna card
      const atuBadge = el('span', 'k4-card-badge', 'KAT4');
      const atuCard = makeCard('ATU & Antenna', atuBadge);
      this._refs.atuModuleBadge = atuBadge;

      const antRow = el('div', 'k4-slider-row');
      const antHead = el('div', 'k4-slider-head');
      antHead.appendChild(el('span', 'k4-slider-label', 'TX Antenna'));
      antRow.appendChild(antHead);
      const antBtn = el('button', 'k4-btn k4-ant-cycle-btn', 'ANT 1');
      antBtn.type = 'button';
      antBtn.dataset.testid = 'tx-antenna-btn';
      antBtn.title = 'Cycle TX Antenna (ANT 1 → 2 → 3 → 1)';
      antBtn.addEventListener('click', () => {
        if (typeof this.client.cycleTxAntenna === 'function') {
          this.client.cycleTxAntenna();
        } else {
          const snap = this._snap();
          const cur = Number(snap.txAntenna) || 1;
          const next = (cur % 3) + 1;
          if (typeof this.client.setTxAntenna === 'function') {
            this.client.setTxAntenna(next);
          } else {
            this._sendCat(`AN${next};`);
          }
        }
      });
      antRow.appendChild(antBtn);
      atuCard.appendChild(antRow);
      this._refs.txAntennaBtn = antBtn;

      const atuModeSeg = el('div', 'k4-seg-group');
      const bypassBtn = el('button', 'k4-seg-btn', 'BYPASS');
      bypassBtn.type = 'button';
      bypassBtn.addEventListener('click', () => {
        if (typeof this.client.setAtuMode === 'function') this.client.setAtuMode(1);
        else this._sendCat('AT1;');
      });
      const autoBtn = el('button', 'k4-seg-btn', 'AUTO');
      autoBtn.type = 'button';
      autoBtn.addEventListener('click', () => {
        if (typeof this.client.setAtuMode === 'function') this.client.setAtuMode(2);
        else this._sendCat('AT2;');
      });
      atuModeSeg.appendChild(bypassBtn);
      atuModeSeg.appendChild(autoBtn);
      atuCard.appendChild(atuModeSeg);
      this._refs.atuModeBtns = { 1: bypassBtn, 2: autoBtn };

      const atuTuneBtn = el('button', 'k4-btn k4-btn--amber k4-btn--full', 'ATU TUNE');
      atuTuneBtn.type = 'button';
      atuTuneBtn.dataset.testid = 'atu-tune-btn';
      atuTuneBtn.title = 'Start KAT4 ATU Tune (tap again within 5s for Full Search)';
      atuTuneBtn.addEventListener('click', () => {
        if (typeof this.client.startAtuTune === 'function') {
          this.client.startAtuTune();
        } else {
          const hot = Number(this._snap().atuSearchWindowUntil) > Date.now();
          this._sendCat(hot ? 'TU4;' : 'TU3;');
        }
      });
      atuCard.appendChild(atuTuneBtn);

      const atuGrid = el('div', 'k4-btn-grid k4-btn-grid--2');
      const atuLpBtn = el('button', 'k4-btn', 'TUNE LP');
      atuLpBtn.type = 'button';
      atuLpBtn.addEventListener('click', () => {
        if (typeof this.client.startAtuTune === 'function') this.client.startAtuTune(2);
        else this._sendCat('TU2;');
      });

      const atuStopBtn = el('button', 'k4-btn k4-btn--danger', 'STOP');
      atuStopBtn.type = 'button';
      atuStopBtn.dataset.testid = 'atu-stop-btn';
      atuStopBtn.addEventListener('click', () => {
        if (typeof this.client.stopAtuTune === 'function') this.client.stopAtuTune();
        else this._sendCat('TU0;');
      });

      atuGrid.appendChild(atuLpBtn);
      atuGrid.appendChild(atuStopBtn);
      atuCard.appendChild(atuGrid);
      this._refs.atuBtns = { tune: atuTuneBtn, lp: atuLpBtn, stop: atuStopBtn };

      const atuStatus = el('div', 'k4-tx-banner', 'KAT4 Standby');
      atuStatus.dataset.testid = 'atu-status';
      atuStatus.dataset.state = 'idle';
      atuCard.appendChild(atuStatus);
      this._refs.atuStatus = atuStatus;

      pane.appendChild(atuCard);

      // (c) RF Power & Audio TX card
      const pwrCard = makeCard('RF Power & TX Audio');

      const sendPowerWatts = (raw) => {
        const watts = K4.quantizePowerWatts(raw);
        if (typeof this.client.setPowerWatts === 'function') {
          this.client.setPowerWatts(watts);
        } else if (watts <= 10) {
          this._sendCat(`PC${String(Math.round(watts * 10)).padStart(3, '0')}L;`);
        } else {
          this._sendCat(`PC${String(watts).padStart(3, '0')}H;`);
        }
      };

      const pwrSlider = makeSliderRow({
        label: 'RF Power',
        min: 0.1,
        max: 110,
        step: 0.1,
        value: 10,
        formatValue: (v) => {
          const w = K4.quantizePowerWatts(v);
          return w <= 10 ? `${w.toFixed(1)} W` : `${Math.round(w)} W`;
        },
        onInput: sendPowerWatts,
        onChange: sendPowerWatts,
      });
      pwrSlider.input.dataset.testid = 'tx-power-slider';
      pwrCard.appendChild(pwrSlider.row);
      this._refs.txPowerSlider = pwrSlider;

      const mgSlider = makeSliderRow({
        label: 'Mic Gain',
        min: 0,
        max: 80,
        step: 1,
        value: 15,
        formatValue: (v) => String(Math.round(v)),
        onInput: (v) => {
          if (typeof this.client.setMicGain === 'function') this.client.setMicGain(v);
          else this._sendCat(`MG${String(Math.round(v)).padStart(3, '0')};`);
        },
      });
      pwrCard.appendChild(mgSlider.row);
      this._refs.txMgSlider = mgSlider;

      const cpSlider = makeSliderRow({
        label: 'Speech Comp',
        min: 0,
        max: 30,
        step: 1,
        value: 0,
        formatValue: (v) => `${Math.round(v)} dB`,
        onInput: (v) => {
          if (typeof this.client.setCompression === 'function') this.client.setCompression(v);
          else this._sendCat(`CP${String(Math.round(v)).padStart(3, '0')};`);
        },
      });
      pwrCard.appendChild(cpSlider.row);
      this._refs.txCpSlider = cpSlider;

      const mlSlider = makeSliderRow({
        label: 'TX Monitor',
        min: 0,
        max: 100,
        step: 1,
        value: 5,
        formatValue: (v) => String(Math.round(v)),
        onInput: (v) => {
          const ch = this._txMonitorChannel();
          if (typeof this.client.setTxMonitor === 'function') this.client.setTxMonitor(ch, v);
          else this._sendCat(`ML${ch}${String(Math.round(v)).padStart(3, '0')};`);
        },
      });
      pwrCard.appendChild(mlSlider.row);
      this._refs.txMlSlider = mlSlider;

      const voxSwitch = makeSwitchRow('VOX', () => {
        const snap = this._snap();
        const rx = snap.activeTxVfo === 'B' ? (snap.rxB || {}) : (snap.rxA || {});
        const mode = Number(rx.mode) || 2;
        let ch = 'V';
        let cur = Boolean(snap.voxVoice);
        if (mode === 3 || mode === 7) { ch = 'C'; cur = Boolean(snap.voxCw); }
        else if (mode === 6 || mode === 9) { ch = 'D'; cur = Boolean(snap.voxData); }
        if (typeof this.client.setVox === 'function') this.client.setVox(ch, !cur);
        else this._sendCat(`VX${ch}${!cur ? '1' : '0'};`);
      });
      pwrCard.appendChild(voxSwitch.row);
      this._refs.txVoxSwitch = voxSwitch;

      const dvrHead = el('div', 'k4-slider-head');
      dvrHead.appendChild(el('span', 'k4-slider-label', 'Message Memories (M1–M4)'));
      const dvrBankBadge = el('span', 'k4-slider-val', 'BANK 1 (#1–4)');
      dvrHead.appendChild(dvrBankBadge);
      pwrCard.appendChild(dvrHead);
      this._refs.msgBankBadge = dvrBankBadge;

      const msgRow = el('div', 'k4-btn-grid k4-btn-grid--4');
      this._refs.msgSlotBtns = [];
      for (let i = 1; i <= 4; i++) {
        const b = el('button', 'k4-btn', `M${i}`);
        b.type = 'button';
        b.dataset.testid = `msg-m${i}`;
        b.dataset.msgIndex = String(i);
        b.title = `Play K4 Message Memory M${i}`;
        b.addEventListener('click', () => {
          const slot = (this._msgBank === 2 ? 4 : 0) + i;
          if (typeof this.client.playDvr === 'function') this.client.playDvr(slot);
          else this._sendCat(`PB${slot};`);
        });
        msgRow.appendChild(b);
        this._refs.msgSlotBtns.push({ idx: i, btn: b });
      }
      pwrCard.appendChild(msgRow);

      const msgCtrlRow = el('div', 'k4-btn-grid k4-btn-grid--2');
      const bankBtn = el('button', 'k4-btn k4-btn--amber k4-msg-bank-btn', 'BANK 1 (1–4)');
      bankBtn.type = 'button';
      bankBtn.dataset.testid = 'msg-bank-btn';
      bankBtn.title = 'Switch K4 Message Bank 1 (#1–4) / Bank 2 (#5–8)';
      bankBtn.addEventListener('click', () => {
        this._msgBank = this._msgBank === 2 ? 1 : 2;
        this.update(this._snap());
      });
      const stopMsgBtn = el('button', 'k4-btn', 'STOP');
      stopMsgBtn.type = 'button';
      stopMsgBtn.dataset.testid = 'msg-stop-btn';
      stopMsgBtn.title = 'Cancel DVR / CW message playback';
      stopMsgBtn.addEventListener('click', () => {
        if (typeof this.client.playDvr === 'function') this.client.playDvr(0);
        else this._sendCat('PB0;');
      });
      msgCtrlRow.appendChild(bankBtn);
      msgCtrlRow.appendChild(stopMsgBtn);
      pwrCard.appendChild(msgCtrlRow);
      this._refs.msgBankBtn = bankBtn;
      this._refs.msgStopBtn = stopMsgBtn;

      // TX Audio Source & Live VU Meter
      const srcRow = el('div', 'k4-slider-row');
      srcRow.appendChild(el('div', 'k4-slider-head')).appendChild(el('span', 'k4-slider-label', 'Web TX Audio Source'));
      const srcSelect = document.createElement('select');
      srcSelect.className = 'k4-select';
      srcSelect.dataset.testid = 'tx-audio-source';
      const srcOpts = [
        { val: 'mic', label: 'Microphone (Live)' },
        { val: 'two-tone', label: 'Two-Tone Test (700/1900 Hz)' },
        { val: 'tone-1k', label: '1 kHz Test Tone' },
        { val: 'wav', label: 'WAV / Voice Loop' },
      ];
      for (let i = 0; i < srcOpts.length; i++) {
        const opt = document.createElement('option');
        opt.value = srcOpts[i].val;
        opt.textContent = srcOpts[i].label;
        srcSelect.appendChild(opt);
      }
      srcSelect.addEventListener('change', () => {
        const nextSrc = srcSelect.value;
        if (nextSrc === 'mic' && !this._isMicSecureContext()) {
          this.onSetTxAudioConfig({ source: 'two-tone' });
          srcSelect.value = 'two-tone';
        } else {
          this.onSetTxAudioConfig({ source: nextSrc });
          if (nextSrc === 'mic') this._refreshMicDevices();
        }
        this.update(this._snap());
      });
      srcRow.appendChild(srcSelect);
      pwrCard.appendChild(srcRow);
      this._refs.txAudioSource = srcSelect;

      const micSecNote = el(
        'div',
        'k4-tx-inline-alert',
        'Live Microphone requires a SecureContext (open http://localhost:9280 or HTTPS). Two-Tone, 1 kHz, and WAV test sources work over file://.'
      );
      micSecNote.hidden = true;
      pwrCard.appendChild(micSecNote);
      this._refs.txMicSecNote = micSecNote;

      // Mic device & AEC wrap
      const micExtras = el('div', 'k4-slider-row');
      micExtras.hidden = true;
      const micDevSelect = document.createElement('select');
      micDevSelect.className = 'k4-select';
      const defOpt = document.createElement('option');
      defOpt.value = '';
      defOpt.textContent = 'System Default Microphone';
      micDevSelect.appendChild(defOpt);
      micDevSelect.addEventListener('change', () => {
        this.onSetTxAudioConfig({ deviceId: micDevSelect.value });
      });
      micExtras.appendChild(micDevSelect);
      const vpSwitch = makeSwitchRow('Mic AEC / Noise Supp', () => {
        const cfg = this.getTxAudioConfig();
        this.onSetTxAudioConfig({ voiceProcessing: !cfg.voiceProcessing });
        this.update(this._snap());
      });
      micExtras.appendChild(vpSwitch.row);
      pwrCard.appendChild(micExtras);
      this._refs.txMicExtras = micExtras;
      this._refs.txMicDevSelect = micDevSelect;
      this._refs.txVpSwitch = vpSwitch;

      // WAV file picker wrap
      const wavExtras = el('div', 'k4-slider-row');
      wavExtras.hidden = true;
      const wavBtnRow = el('div', 'k4-toggle-row');
      const wavNameEl = el('span', 'k4-slider-val', 'Built-in voice test loop');
      const wavPickBtn = el('button', 'k4-btn', 'Load WAV...');
      wavPickBtn.type = 'button';
      const wavInput = document.createElement('input');
      wavInput.type = 'file';
      wavInput.accept = 'audio/*,.wav';
      wavInput.hidden = true;
      wavPickBtn.addEventListener('click', () => wavInput.click());
      wavInput.addEventListener('change', async () => {
        const file = wavInput.files && wavInput.files[0];
        if (!file) return;
        if (this.onLoadTxWav) {
          await this.onLoadTxWav(file);
        } else if (this.audio && typeof this.audio.setTxWaveBuffer === 'function') {
          try {
            const buf = await file.arrayBuffer();
            const AC = window.AudioContext || window.webkitAudioContext;
            if (AC) {
              const ctx = new AC();
              const decoded = await ctx.decodeAudioData(buf);
              this.audio.setTxWaveBuffer(decoded.getChannelData(0), decoded.sampleRate);
              ctx.close().catch(() => {});
              this.onSetTxAudioConfig({ wavName: file.name });
            }
          } catch (_) {}
        }
        wavInput.value = '';
        this.update(this._snap());
      });
      wavBtnRow.appendChild(wavNameEl);
      wavBtnRow.appendChild(wavPickBtn);
      wavBtnRow.appendChild(wavInput);
      wavExtras.appendChild(wavBtnRow);
      pwrCard.appendChild(wavExtras);
      this._refs.txWavExtras = wavExtras;
      this._refs.txWavNameEl = wavNameEl;

      // Live TX input VU meter
      const vuWrap = el('div', 'k4-tx-vu-wrap');
      const vuHead = el('div', 'k4-slider-head');
      vuHead.appendChild(el('span', 'k4-slider-label', 'TX Audio Input Level'));
      const vuVal = el('span', 'k4-slider-val', '0% · 0 pkts');
      vuHead.appendChild(vuVal);
      const vuTrack = el('div', 'k4-tx-vu-track');
      const vuFill = el('div', 'k4-tx-vu-fill');
      vuTrack.appendChild(vuFill);
      vuWrap.appendChild(vuHead);
      vuWrap.appendChild(vuTrack);
      pwrCard.appendChild(vuWrap);
      this._refs.txVuVal = vuVal;
      this._refs.txVuFill = vuFill;

      pane.appendChild(pwrCard);

      // (d) CW / DATA Keyer card
      const kyCard = makeCard('CW / Direct DATA Keyer');

      const kyInput = document.createElement('textarea');
      kyInput.className = 'k4-ky-textarea';
      kyInput.dataset.testid = 'cw-ky-input';
      kyInput.rows = 2;
      kyInput.maxLength = 64;
      kyInput.placeholder = 'CW / FSK-D / PSK-D keyer (Enter sends · Esc aborts)...';
      kyCard.appendChild(kyInput);
      this._refs.cwKyInput = kyInput;

      const sendKeyerBuffer = (clearAfter) => {
        const raw = kyInput.value || '';
        if (!raw.trim()) return;
        const payload = clearAfter ? raw : raw.trim();
        if (typeof this.client.sendKeyerText === 'function') {
          this.client.sendKeyerText(payload, ' ');
        } else {
          this._sendCat(`KY ${payload.slice(0, 24)};`);
        }
        if (clearAfter) kyInput.value = '';
      };

      const abortKeyerBuffer = () => {
        if (typeof this.client.clearKeyerBuffer === 'function') {
          this.client.clearKeyerBuffer();
        } else {
          this._sendCat('KY @;');
        }
      };

      kyInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          sendKeyerBuffer(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          abortKeyerBuffer();
          kyInput.blur();
        }
      });

      const kyActions = el('div', 'k4-btn-grid k4-btn-grid--2');
      const kySendBtn = el('button', 'k4-btn k4-btn--amber', 'Send');
      kySendBtn.type = 'button';
      kySendBtn.dataset.testid = 'cw-ky-send';
      kySendBtn.addEventListener('click', () => sendKeyerBuffer(false));

      const kyAbortBtn = el('button', 'k4-btn k4-btn--danger', 'Stop');
      kyAbortBtn.type = 'button';
      kyAbortBtn.dataset.testid = 'cw-ky-abort';
      kyAbortBtn.addEventListener('click', abortKeyerBuffer);
      kyActions.appendChild(kySendBtn);
      kyActions.appendChild(kyAbortBtn);
      kyCard.appendChild(kyActions);

      const macroGrid = el('div', 'k4-btn-grid k4-btn-grid--3');
      const macros = [
        { lbl: 'CQ', text: 'CQ CQ DE K4 K ' },
        { lbl: 'DE TEST', text: 'DE K4WEB K ' },
        { lbl: '599 TU', text: 'UR 599 TU ' },
        { lbl: 'AGN?', text: 'AGN? ' },
        { lbl: 'BK', text: 'BK ' },
        { lbl: '73', text: '73 GL E E ' },
      ];
      for (let i = 0; i < macros.length; i++) {
        const m = macros[i];
        const mb = el('button', 'k4-btn', m.lbl);
        mb.type = 'button';
        mb.addEventListener('click', () => {
          if (typeof this.client.sendKeyerText === 'function') {
            this.client.sendKeyerText(m.text, ' ');
          } else {
            this._sendCat(`KY ${m.text};`);
          }
        });
        macroGrid.appendChild(mb);
      }
      kyCard.appendChild(macroGrid);

      const tbWrap = el('div', 'k4-tx-vu-wrap');
      const tbHead = el('div', 'k4-slider-head');
      tbHead.appendChild(el('span', 'k4-slider-label', 'Keyer TX Queue'));
      const tbVal = el('span', 'k4-slider-val', '0 chars');
      tbHead.appendChild(tbVal);
      const tbTrack = el('div', 'k4-tb-track');
      const tbFill = el('div', 'k4-tb-fill');
      tbTrack.appendChild(tbFill);
      tbWrap.appendChild(tbHead);
      tbWrap.appendChild(tbTrack);
      kyCard.appendChild(tbWrap);
      this._refs.tbVal = tbVal;
      this._refs.tbFill = tbFill;

      const ksSlider = makeSliderRow({
        label: 'CW Speed',
        min: 8,
        max: 100,
        step: 1,
        value: 20,
        formatValue: (v) => `${Math.round(v)} WPM`,
        onInput: (v) => {
          if (typeof this.client.setCwSpeed === 'function') this.client.setCwSpeed(v);
          else this._sendCat(`KS${String(Math.round(v)).padStart(3, '0')};`);
        },
      });
      kyCard.appendChild(ksSlider.row);
      this._refs.cwKsSlider = ksSlider;

      const kpSlider = makeSliderRow({
        label: 'Keyer Weight',
        min: 90,
        max: 125,
        step: 1,
        value: 115,
        formatValue: (v) => (v / 100).toFixed(2),
        onInput: (v) => {
          const snap = this._snap();
          if (typeof this.client.setKeyerPaddle === 'function') {
            this.client.setKeyerPaddle({
              iambic: snap.keyerIambic || 'A',
              order: snap.keyerPaddleOrder || 'N',
              weight: Math.round(v),
            });
          } else {
            this._sendCat(`KP${snap.keyerIambic || 'A'}${snap.keyerPaddleOrder || 'N'}${String(Math.round(v)).padStart(3, '0')};`);
          }
        },
      });
      kyCard.appendChild(kpSlider.row);
      this._refs.cwKpSlider = kpSlider;

      const paddleRow = el('div', 'k4-btn-grid k4-btn-grid--3');
      const iambicBtn = el('button', 'k4-btn', 'Iambic A');
      iambicBtn.type = 'button';
      iambicBtn.addEventListener('click', () => {
        const snap = this._snap();
        const next = snap.keyerIambic === 'B' ? 'A' : 'B';
        if (typeof this.client.setKeyerPaddle === 'function') {
          this.client.setKeyerPaddle({
            iambic: next,
            order: snap.keyerPaddleOrder || 'N',
            weight: snap.keyerWeight || 115,
          });
        }
      });
      const polBtn = el('button', 'k4-btn', 'Paddle N');
      polBtn.type = 'button';
      polBtn.addEventListener('click', () => {
        const snap = this._snap();
        const next = snap.keyerPaddleOrder === 'R' ? 'N' : 'R';
        if (typeof this.client.setKeyerPaddle === 'function') {
          this.client.setKeyerPaddle({
            iambic: snap.keyerIambic || 'A',
            order: next,
            weight: snap.keyerWeight || 115,
          });
        }
      });
      const qskBtn = el('button', 'k4-btn', 'QSK / CW VOX');
      qskBtn.type = 'button';
      qskBtn.addEventListener('click', () => {
        const cur = Boolean(this._snap().voxCw);
        if (typeof this.client.setVox === 'function') this.client.setVox('C', !cur);
        else this._sendCat(`VX${!cur ? '1' : '0'};`);
      });
      paddleRow.appendChild(iambicBtn);
      paddleRow.appendChild(polBtn);
      paddleRow.appendChild(qskBtn);
      kyCard.appendChild(paddleRow);
      this._refs.cwIambicBtn = iambicBtn;
      this._refs.cwPolBtn = polBtn;
      this._refs.cwQskBtn = qskBtn;

      pane.appendChild(kyCard);

      // (e) Expanded PA, Electrical & Thermal Sensors Card
      const sensorsCard = makeCard('PA, Electrical & Thermal Sensors');
      sensorsCard.dataset.testid = 'tx-sensors-card';
      this._refs.txSensorsCard = sensorsCard;

      const thermalAlert = el('div', 'k4-tx-inline-alert', '');
      thermalAlert.hidden = true;
      sensorsCard.appendChild(thermalAlert);
      this._refs.txThermalAlert = thermalAlert;

      const sensorGrid = el('div', 'k4-sensor-grid');
      const makeSensorTile = (key, lbl) => {
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'k4-sensor-tile';
        tile.dataset.sensorKey = key;
        tile.dataset.testid = `sensor-tile-${key}`;
        tile.setAttribute('aria-pressed', 'false');
        tile.title = `Click to open ${lbl} history graph`;
        const top = el('div', 'k4-sensor-tile-head');
        top.appendChild(el('span', 'k4-sensor-tile-lbl', lbl));
        tile.appendChild(top);
        const val = el('span', 'k4-sensor-tile-val', '—');
        tile.appendChild(val);
        tile.addEventListener('click', () => {
          this._selectedSensorKey = this._selectedSensorKey === key ? null : key;
          this.update(this._snap());
        });
        sensorGrid.appendChild(tile);
        return { tile, val };
      };
      this._refs.sensors = {
        vs: makeSensorTile('vs', 'Supply Voltage'),
        is: makeSensorTile('is', 'Current / Peak'),
        pt: makeSensorTile('pt', 'PA Heatsink'),
        lt: makeSensorTile('lt', 'LPA / Driver'),
        tf: makeSensorTile('tf', 'Front Panel'),
        sys: makeSensorTile('sys', 'CPU / DAP / DUC'),
        fwd: makeSensorTile('fwd', 'RF Forward Power'),
        swr: makeSensorTile('swr', 'Antenna SWR'),
      };
      sensorsCard.appendChild(sensorGrid);

      const graphPanel = el('div', 'k4-sensor-graph-panel');
      graphPanel.dataset.testid = 'sensor-graph-panel';
      graphPanel.hidden = true;

      const graphHead = el('div', 'k4-sensor-graph-head');
      const graphTitle = el('span', 'k4-sensor-graph-title', 'Sensor History');
      const graphControls = el('div', 'k4-sensor-graph-ctrls');
      const win60 = el('button', 'k4-sensor-win-btn', '60s');
      win60.type = 'button';
      const win180 = el('button', 'k4-sensor-win-btn is-active', '3m');
      win180.type = 'button';
      const syncWinBtns = () => {
        win60.classList.toggle('is-active', this._sensorWindowSec === 60);
        win180.classList.toggle('is-active', this._sensorWindowSec !== 60);
      };
      win60.addEventListener('click', () => {
        this._sensorWindowSec = 60;
        syncWinBtns();
        this.update(this._snap());
      });
      win180.addEventListener('click', () => {
        this._sensorWindowSec = 180;
        syncWinBtns();
        this.update(this._snap());
      });
      const graphCloseBtn = el('button', 'k4-sensor-win-btn', '×');
      graphCloseBtn.type = 'button';
      graphCloseBtn.dataset.testid = 'sensor-graph-close';
      graphCloseBtn.title = 'Close sensor graph';
      graphCloseBtn.addEventListener('click', () => {
        this._selectedSensorKey = null;
        this.update(this._snap());
      });
      graphControls.appendChild(win60);
      graphControls.appendChild(win180);
      graphControls.appendChild(graphCloseBtn);
      graphHead.appendChild(graphTitle);
      graphHead.appendChild(graphControls);
      graphPanel.appendChild(graphHead);

      const graphStats = el('div', 'k4-sensor-graph-stats', 'Min — · Now — · Max —');
      graphPanel.appendChild(graphStats);

      const graphCanvas = document.createElement('canvas');
      graphCanvas.className = 'k4-sensor-graph-canvas';
      graphCanvas.dataset.testid = 'sensor-graph-canvas';
      graphCanvas.width = 280;
      graphCanvas.height = 104;
      graphPanel.appendChild(graphCanvas);

      sensorsCard.appendChild(graphPanel);
      this._refs.sensorGraphPanel = graphPanel;
      this._refs.sensorGraphTitle = graphTitle;
      this._refs.sensorGraphStats = graphStats;
      this._refs.sensorGraphCanvas = graphCanvas;

      const omRow = el('div', 'k4-om-badges');
      const makeOmBadge = (name) => {
        const b = el('span', 'k4-om-badge', name);
        omRow.appendChild(b);
        return b;
      };
      this._refs.omBadges = {
        kat4: makeOmBadge('KAT4'),
        kpa4: makeOmBadge('KPA4'),
        krx4: makeOmBadge('KRX4'),
        amp: makeOmBadge('LINEAR AMP'),
      };
      sensorsCard.appendChild(omRow);

      pane.appendChild(sensorsCard);
      return pane;
    }

    _txMonitorChannel() {
      const snap = this._snap();
      const rx = snap.activeTxVfo === 'B' ? (snap.rxB || {}) : (snap.rxA || {});
      const mode = Number(rx.mode) || 2;
      if (mode === 3 || mode === 7) return 0; // CW
      if (mode === 6 || mode === 9) return 1; // Data
      return 2; // Voice
    }

    _isMicSecureContext() {
      if (this.audio && typeof this.audio.isMicSecureContextAvailable === 'function') {
        return Boolean(this.audio.isMicSecureContextAvailable());
      }
      return Boolean(window.isSecureContext);
    }

    _isDemoMode(snapshot) {
      const s = snapshot || (typeof this._snap === 'function' ? this._snap() : null);
      const wsUrl = (s && s.connection && s.connection.wsUrl) || '';
      return Boolean(
        (this.client && typeof this.client.isDemoMode === 'function' && this.client.isDemoMode()) ||
        String(wsUrl).startsWith('demo://')
      );
    }

    async _refreshMicDevices() {
      if (this._isDemoMode()) return;
      if (!this.audio || typeof this.audio.listAudioInputs !== 'function') return;
      try {
        const list = await this.audio.listAudioInputs();
        this._micDevices = Array.isArray(list) ? list : [];
        const sel = this._refs.txMicDevSelect;
        if (!sel) return;
        const cur = this.getTxAudioConfig().deviceId || '';
        sel.textContent = '';
        const def = document.createElement('option');
        def.value = '';
        def.textContent = 'System Default Microphone';
        sel.appendChild(def);
        for (let i = 0; i < this._micDevices.length; i++) {
          const d = this._micDevices[i];
          const opt = document.createElement('option');
          opt.value = d.deviceId || '';
          opt.textContent = d.label || `Microphone ${i + 1}`;
          sel.appendChild(opt);
        }
        sel.value = cur;
      } catch (_) {}
    }

    openTab(tabId, scrollTargetEl) {
      if (!this._panes[tabId]) return;
      if (window.innerWidth < 960) {
        if (tabId !== this._activeMobileTab) {
          this._activeMobileTab = tabId;
          this._mobileSheetSnap = tabId === 'tune' ? 'compact' : 'mid';
        }
      } else {
        if (tabId === 'tune') return;
        this.onOpenDrawer();
        this._activeDesktopTab = tabId;
      }
      this.syncHost();
      this.syncVisibleTab();
      if (scrollTargetEl && typeof scrollTargetEl.scrollIntoView === 'function') {
        requestAnimationFrame(() => {
          scrollTargetEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
      }
    }

    destroy() {
      if (this._afScopeTimer) {
        clearInterval(this._afScopeTimer);
        this._afScopeTimer = null;
      }
      if (this._atuCueTimer) {
        clearTimeout(this._atuCueTimer);
        this._atuCueTimer = null;
      }
      if (typeof this._unsubBookmarks === 'function') {
        this._unsubBookmarks();
        this._unsubBookmarks = null;
      }
      if (this._wavBlobUrl) {
        URL.revokeObjectURL(this._wavBlobUrl);
        this._wavBlobUrl = null;
      }
    }

    selectDesktopTab(tabId) {
      if (!this._panes[tabId] || tabId === 'tune') return;
      this._activeDesktopTab = tabId;
      this.syncHost();
      this.syncVisibleTab();
    }

    toggleMobileSheet(tabId) {
      if (this._activeMobileTab === tabId) {
        this.closeMobileSheet();
        return;
      }
      this._activeMobileTab = tabId;
      this._mobileSheetSnap = tabId === 'tune' ? 'compact' : 'mid';
      this.syncHost();
      this.syncVisibleTab();
    }

    closeMobileSheet() {
      this._activeMobileTab = null;
      this.syncHost();
      this._syncAfScopeLoop();
    }

    isMobileSheetOpen() {
      return Boolean(this._activeMobileTab);
    }

    onDrawerVisibilityChange() {
      this.syncVisibleTab();
    }

    syncVisibleTab() {
      const visibleTab = this._getVisibleTabId();
      const snap = this._snap();
      if (this.isDrawerOpen()) {
        this._updateSensorStrip(snap);
      }
      if (visibleTab && this._dirtyTabs.has(visibleTab)) {
        this._updateTab(visibleTab, snap);
        this._dirtyTabs.delete(visibleTab);
      }
      this._syncAfScopeLoop();
    }

    _syncDesktopTabHighlights() {
      const targetRx = this.getTargetRx();
      if (Array.isArray(this._desktopTabItems)) {
        for (let i = 0; i < this._desktopTabItems.length; i++) {
          const item = this._desktopTabItems[i];
          const active =
            item.id === this._activeDesktopTab &&
            (item.rx === null || item.rx === targetRx);
          item.btn.classList.toggle('is-active', active);
        }
        return;
      }
      for (const id of Object.keys(this._desktopTabBtns)) {
        this._desktopTabBtns[id].classList.toggle('is-active', id === this._activeDesktopTab);
      }
    }

    syncHost() {
      const isMobile = window.innerWidth < 960;

      this._syncDesktopTabHighlights();

      for (const id of Object.keys(this._mobileNavBtns)) {
        this._mobileNavBtns[id].classList.toggle('is-active', id === this._activeMobileTab);
      }

      if (!isMobile) {
        this._activeMobileTab = null;
        this.mobileSheetEl.dataset.open = 'false';
        this.mobileSheetEl.setAttribute('aria-hidden', 'true');
        const activePane = this._panes[this._activeDesktopTab];
        if (activePane && activePane.parentNode !== this.drawerScroll) {
          this.drawerScroll.textContent = '';
          this.drawerScroll.appendChild(activePane);
        }
      } else if (this._activeMobileTab && this._panes[this._activeMobileTab]) {
        const tabMeta = MOBILE_TABS.find((t) => t.id === this._activeMobileTab);
        this.sheetTitleEl.textContent = tabMeta ? tabMeta.label : 'Controls';
        const activePane = this._panes[this._activeMobileTab];
        if (activePane.parentNode !== this.sheetScroll) {
          this.sheetScroll.textContent = '';
          this.sheetScroll.appendChild(activePane);
        }
        this.mobileSheetEl.dataset.snap = this._mobileSheetSnap || 'compact';
        this.mobileSheetEl.dataset.open = 'true';
        this.mobileSheetEl.setAttribute('aria-hidden', 'false');
      } else {
        this.mobileSheetEl.dataset.open = 'false';
        this.mobileSheetEl.setAttribute('aria-hidden', 'true');
      }
    }

    _tabsForChangedKeys(changedKeys) {
      if (!changedKeys) {
        return ['band-mode', 'dsp', 'display', 'audio', 'tune', 'tx'];
      }
      const list = Array.isArray(changedKeys) ? changedKeys : Array.from(changedKeys);
      if (list.length === 0) {
        return ['band-mode', 'dsp', 'display', 'audio', 'tune', 'tx'];
      }
      const out = new Set();
      for (let i = 0; i < list.length; i++) {
        const k = String(list[i] || '');
        if (
          k.endsWith('.freqHz') ||
          k.endsWith('.mode') ||
          k.endsWith('.dataSubMode') ||
          k.endsWith('.stepHz') ||
          k.endsWith('.locked') ||
          k.endsWith('.band') ||
          k === 'band' ||
          k === 'subRxEnabled' ||
          k === 'vfoLinked' ||
          k === 'diversityEnabled' ||
          k === 'optionModules'
        ) {
          out.add('band-mode');
          out.add('tune');
          if (k.endsWith('.mode') || k.endsWith('.freqHz')) out.add('dsp');
          if (k.endsWith('.mode') || k === 'optionModules' || k === 'subRxEnabled') out.add('tx');
          if (k === 'subRxEnabled') out.add('display');
        } else if (
          k.endsWith('.filter') ||
          k.endsWith('.filterPreset') ||
          k.endsWith('.bwHz') ||
          k.endsWith('.ifShiftHz') ||
          k.endsWith('.preamp') ||
          k.endsWith('.attenDb') ||
          k.endsWith('.rfGainDb') ||
          k.endsWith('.squelch') ||
          k.endsWith('.agc') ||
          k.endsWith('.nb') ||
          k.endsWith('.nr') ||
          k.endsWith('.notch') ||
          k.endsWith('.rit') ||
          k.endsWith('.ritOn') ||
          k.endsWith('.ritOffsetHz') ||
          k.endsWith('.apf') ||
          k.endsWith('.textDecode') ||
          k === 'cwPitchHz' ||
          k === 'spotTone' ||
          k === 'cwSpotOn' ||
          k.endsWith('.spotMode')
        ) {
          out.add('dsp');
          if (k.endsWith('.rit') || k.endsWith('.ritOn') || k.endsWith('.ritOffsetHz')) {
            out.add('tx');
          }
        } else if (
          k === 'display' ||
          k.endsWith('.display') ||
          k.endsWith('.miniPan') ||
          k.endsWith('.panNbMode') ||
          k.endsWith('.panNbLevel') ||
          k.endsWith('.panMeta') ||
          k === 'dualPanMode' ||
          k === 'panAvg' ||
          k === 'panFrozen' ||
          k === 'panFps' ||
          k === 'displayMode' ||
          k === 'waterfallHeightPct' ||
          k === 'fixedTune' ||
          k === 'fixedTuneMode' ||
          k === 'panScaleDb' ||
          k === 'wfBlack' ||
          k === 'autoRef'
        ) {
          out.add('display');
          if (k.endsWith('.panMeta')) out.add('audio');
        } else if (
          k === 'audioMix' ||
          k === 'encodeMode' ||
          k === 'streamingLatency' ||
          k === 'audio' ||
          k === 'connection'
        ) {
          out.add('audio');
          if (k === 'connection') out.add('tx');
        } else if (
          k === 'telemetry' ||
          k === 'txMeters' ||
          k.startsWith('tx') ||
          k.startsWith('atu') ||
          k.startsWith('power') ||
          k === 'splitEnabled' ||
          k === 'xitEnabled' ||
          k === 'activeTxVfo' ||
          k === 'antennaNames' ||
          k === 'micGain' ||
          k === 'compDbSet' ||
          k.startsWith('mon') ||
          k === 'vox' ||
          k === 'cwSpeedWpm' ||
          k.startsWith('keyer') ||
          k === 'dvrPlayback'
        ) {
          out.add('tx');
          if (k === 'telemetry') out.add('audio');
        } else if (!k.endsWith('.sMeterDbm') && !k.endsWith('.adcOverflow') && k !== 'decodedText') {
          return ['band-mode', 'dsp', 'display', 'audio', 'tune', 'tx'];
        }
      }
      return Array.from(out);
    }

    update(snapshot, changedKeys = null) {
      if (!snapshot) return;
      const perf = this._uiPerf();
      if (perf) perf.inspectorUpdates += 1;

      const targetRx = this.getTargetRx();
      this._syncDesktopTabHighlights();

      // Target buttons
      if (this._refs.targetBtns) {
        this._refs.targetBtns.A.classList.toggle('is-active', targetRx === 'A');
        this._refs.targetBtns.B.classList.toggle('is-active', targetRx === 'B');
      }
      if (this._refs.mobileTargetBtns) {
        this._refs.mobileTargetBtns.A.classList.toggle('is-active', targetRx === 'A');
        this._refs.mobileTargetBtns.B.classList.toggle('is-active', targetRx === 'B');
      }

      const affected = this._tabsForChangedKeys(changedKeys);
      for (let i = 0; i < affected.length; i++) {
        this._dirtyTabs.add(affected[i]);
      }

      if (this.isDrawerOpen()) {
        this._updateSensorStrip(snapshot);
      }

      const visibleTab = this._getVisibleTabId();
      for (let i = 0; i < affected.length; i++) {
        const tabId = affected[i];
        if (tabId === visibleTab) {
          this._updateTab(tabId, snapshot);
          this._dirtyTabs.delete(tabId);
        } else if (perf) {
          perf.inspectorTabSkips += 1;
        }
      }

      if (visibleTab !== 'audio') {
        if (this._afScopeTimer) {
          this._syncAfScopeLoop();
        } else if (perf) {
          perf.afScopeSkips += 1;
        }
      }
    }

    _updateTab(tabId, snapshot) {
      const targetRx = this.getTargetRx();
      const rxS = (targetRx === 'B' ? snapshot.rxB : snapshot.rxA) || {};
      const isAmber = targetRx === 'B';
      if (tabId === 'band-mode') {
        this._updateBandModeTab(snapshot, rxS, isAmber);
      } else if (tabId === 'dsp') {
        this._updateDspTab(snapshot, rxS);
      } else if (tabId === 'display') {
        this._updateDisplayTab(snapshot);
      } else if (tabId === 'audio') {
        const aDiag = this.audio && this.audio.getDiagnostics ? this.audio.getDiagnostics() : {};
        this._updateAudioTab(snapshot, rxS, aDiag);
      } else if (tabId === 'tx') {
        const aDiag = this.audio && this.audio.getDiagnostics ? this.audio.getDiagnostics() : {};
        this._updateTxTab(snapshot, aDiag);
      } else if (tabId === 'tune') {
        this._updateBandModeTab(snapshot, rxS, isAmber);
      }
    }

    _updateBandModeTab(snapshot, rxS, isAmber) {
      if (this._refs.subSwitch) this._refs.subSwitch.sync(snapshot.subRxEnabled);
      if (this._refs.linkSwitch) this._refs.linkSwitch.sync(snapshot.vfoLinked);
      if (this._refs.divSwitch) {
        const hasDiv = snapshot.hasDiversity !== false;
        this._refs.divSwitch.row.hidden = !hasDiv;
        this._refs.divSwitch.sync(Boolean(hasDiv && snapshot.diversityEnabled));
        this._refs.divSwitch.btn.disabled = !hasDiv || !snapshot.subRxEnabled;
      }

      // Bands
      if (this._refs.bandBtns) {
        const freq = Number(rxS.freqHz) || 0;
        for (let i = 0; i < this._refs.bandBtns.length; i++) {
          const { band, btn } = this._refs.bandBtns[i];
          const active = freq >= band.startHz && freq <= band.endHz;
          btn.classList.toggle('is-active', active);
          btn.classList.toggle('is-amber', isAmber && active);
        }
      }

      // Modes
      if (this._refs.modeBtns) {
        const lsbFirst = isLsbPrimaryFreq(rxS.freqHz);
        if (this._refs.modeGrid && this._lastModeOrderLsbFirst !== lsbFirst) {
          let lsbBtn = null;
          let usbBtn = null;
          for (let i = 0; i < this._refs.modeBtns.length; i++) {
            const item = this._refs.modeBtns[i];
            if (item.mc.id === 'LSB') lsbBtn = item.btn;
            else if (item.mc.id === 'USB') usbBtn = item.btn;
          }
          if (lsbBtn && usbBtn) {
            const ordered = lsbFirst ? [lsbBtn, usbBtn] : [usbBtn, lsbBtn];
            this._refs.modeGrid.insertBefore(ordered[0], this._refs.modeGrid.firstChild);
            this._refs.modeGrid.insertBefore(ordered[1], ordered[0].nextSibling);
          }
          this._lastModeOrderLsbFirst = lsbFirst;
        }
        for (let i = 0; i < this._refs.modeBtns.length; i++) {
          const { mc, btn } = this._refs.modeBtns[i];
          const active = rxS.mode === mc.code && (mc.sub === null || rxS.dataSubMode === mc.sub);
          btn.classList.toggle('is-active', active);
          btn.classList.toggle('is-amber', isAmber && active);
        }
      }

      if (typeof this._refreshMemories === 'function') this._refreshMemories();

      // Steps
      if (this._refs.stepBtns) {
        for (let i = 0; i < this._refs.stepBtns.length; i++) {
          const { idx, btn } = this._refs.stepBtns[i];
          btn.classList.toggle('is-active', rxS.stepIdx === idx);
        }
      }
      if (this._refs.mobileStepBtns) {
        for (let i = 0; i < this._refs.mobileStepBtns.length; i++) {
          const { idx, btn } = this._refs.mobileStepBtns[i];
          btn.classList.toggle('is-active', rxS.stepIdx === idx);
        }
      }
      if (this._refs.mobileLockBtn) {
        this._refs.mobileLockBtn.textContent = rxS.locked ? 'Unlock VFO' : 'Lock VFO';
      }
      if (this._refs.mobileSplitBtn) {
        this._refs.mobileSplitBtn.classList.toggle('is-active', Boolean(snapshot.splitEnabled));
      }
      if (this._refs.mobileSubBtn) {
        this._refs.mobileSubBtn.classList.toggle('is-active', Boolean(snapshot.subRxEnabled));
      }
    }

    _updateDspTab(snapshot, rxS) {
      const isB = this.getTargetRx() === 'B';
      if (this._refs.dspTrapPoly) {
        const trap =
          typeof K4.computeFilterTrapezoidPoints === 'function'
            ? K4.computeFilterTrapezoidPoints(rxS, snapshot.cwPitchHz ?? 500, 240, 34)
            : null;
        const pts = trap && trap.points ? trap.points : '72,32 88,6 152,6 168,32';
        this._refs.dspTrapPoly.setAttribute('points', pts);
        this._refs.dspTrapPoly.style.stroke = isB ? '#22C55E' : '#38BDF8';
        this._refs.dspTrapPoly.style.fill = isB ? 'rgba(34, 197, 94, 0.28)' : 'rgba(56, 189, 248, 0.28)';
      }
      if (this._refs.dspTrapMeta) {
        const bw = Number(rxS.bwHz ?? 2700);
        const bwStr = bw >= 1000 ? `${(bw / 1000).toFixed(2).replace(/0$/, '')}k` : `${bw}`;
        this._refs.dspTrapMeta.textContent = `BW ${bwStr} · IS ${Math.round(rxS.ifShiftHz ?? 1500)}`;
      }

      if (this._refs.flBtns) {
        const cur = Number(rxS.filterPreset ?? 1);
        this._refs.flBtns.forEach((b, i) => {
          const on = i + 1 === cur;
          b.classList.toggle('is-active', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
      }

      // DSP sliders & toggles
      if (this._refs.bwSlider) this._refs.bwSlider.sync(rxS.bwHz ?? 2700);
      if (this._refs.isSlider) this._refs.isSlider.sync(rxS.ifShiftHz ?? 1500);
      if (this._refs.cwPitchSlider) this._refs.cwPitchSlider.sync(snapshot.cwPitchHz ?? 500);

      if (this._refs.paBtns) {
        const pa = Number(rxS.preamp) || 0;
        for (const lvl of Object.keys(this._refs.paBtns)) {
          this._refs.paBtns[lvl].classList.toggle('is-active', Number(lvl) === pa);
        }
      }
      if (this._refs.attenSlider) this._refs.attenSlider.sync(rxS.attenDb ?? 0);
      if (this._refs.rfGainSlider) this._refs.rfGainSlider.sync(rxS.rfGainDb ?? 0);
      if (this._refs.squelchSlider) this._refs.squelchSlider.sync(rxS.squelch ?? 0);
      if (this._refs.agcBtns) {
        const agc = Number(rxS.agc ?? 1);
        for (const m of Object.keys(this._refs.agcBtns)) {
          this._refs.agcBtns[m].classList.toggle('is-active', Number(m) === agc);
        }
      }
      if (this._refs.nbSwitch) this._refs.nbSwitch.sync(rxS.nbOn);
      if (this._refs.nbSlider) this._refs.nbSlider.sync(rxS.nbLevel ?? 5);
      const nrMode = rxS.nrMode === 'ssnr' ? 'ssnr' : 'lms';
      const nrOn = Boolean(rxS.nrOn);
      if (this._refs.nrSwitch) this._refs.nrSwitch.sync(nrOn);
      if (this._refs.nrModeBtns) {
        this._refs.nrModeBtns.lms.classList.toggle('is-active', nrMode === 'lms');
        this._refs.nrModeBtns.lms.setAttribute('aria-pressed', nrMode === 'lms' ? 'true' : 'false');
        this._refs.nrModeBtns.ssnr.classList.toggle('is-active', nrMode === 'ssnr');
        this._refs.nrModeBtns.ssnr.setAttribute('aria-pressed', nrMode === 'ssnr' ? 'true' : 'false');
      }
      if (this._refs.nrSlider) {
        const isSsnr = nrMode === 'ssnr';
        const targetMax = isSsnr ? '25' : '10';
        const inp = this._refs.nrSlider.input;
        if (inp.min !== '1') inp.min = '1';
        if (inp.max !== targetMax) inp.max = targetMax;
        if (this._refs.nrSlider.labelEl) {
          this._refs.nrSlider.labelEl.textContent = isSsnr ? 'SSNR Level' : 'NR Level';
        }
        const rawLevel = isSsnr ? rxS.ssnrLevel : rxS.lmsNrLevel;
        const displayLevel =
          Number.isFinite(rawLevel) && rawLevel >= 1
            ? clamp(Math.round(rawLevel), 1, isSsnr ? 25 : 10)
            : isSsnr
            ? 5
            : 4;
        this._refs.nrSlider.sync(displayLevel);
      }
      if (this._refs.nmSwitch) this._refs.nmSwitch.sync(rxS.notchOn);
      if (this._refs.nmSlider) this._refs.nmSlider.sync(rxS.notchHz ?? 750);

      if (this._refs.ritSwitch) this._refs.ritSwitch.sync(rxS.ritOn);
      if (this._refs.ritOffsetSlider) this._refs.ritOffsetSlider.sync(rxS.ritOffsetHz ?? 0);
      const isCwMode = rxS.mode === 3 || rxS.mode === 7;
      if (this._refs.apfSwitch) {
        this._refs.apfSwitch.sync(rxS.apfOn);
        this._refs.apfSwitch.btn.disabled = !isCwMode;
      }
      if (this._refs.apfBwBtns) {
        const bwIdx = Number(rxS.apfBwIdx ?? 0);
        for (let i = 0; i < this._refs.apfBwBtns.length; i++) {
          const b = this._refs.apfBwBtns[i];
          b.classList.toggle('is-active', Number(b.dataset.apfBw) === bwIdx);
          b.disabled = !isCwMode;
        }
      }
      if (this._refs.autoSpotBtn) {
        this._refs.autoSpotBtn.disabled = !isCwMode;
        this._refs.autoSpotBtn.classList.toggle('is-cw-ready', isCwMode);
        this._refs.autoSpotBtn.title = isCwMode
          ? 'Zero-beat CW signal on active VFO'
          : 'Available in CW / CW-R mode';
      }
      if (this._refs.cwSpotBtn) {
        const spotOn = Boolean(snapshot.spotTone || snapshot.cwSpotOn || rxS.spotMode === 1 || rxS.spotMode === 2);
        this._refs.cwSpotBtn.disabled = !isCwMode;
        this._refs.cwSpotBtn.classList.toggle('is-active', isCwMode && spotOn);
        this._refs.cwSpotBtn.setAttribute('aria-pressed', isCwMode && spotOn ? 'true' : 'false');
        this._refs.cwSpotBtn.title = isCwMode
          ? 'Toggle CW Spot sidetone pitch reference'
          : 'Available in CW / CW-R mode';
      }

      if (this._refs.tdSelect) {
        const desc = syncDecodeSelect(this._refs.tdSelect, rxS);
        if (this._refs.tdThreshSelect) {
          this._refs.tdThreshSelect.disabled = !desc.thresholdSupported;
          const thrVal = String(rxS.textDecodeThreshold ?? 0);
          if (
            document.activeElement !== this._refs.tdThreshSelect &&
            this._refs.tdThreshSelect.value !== thrVal
          ) {
            this._refs.tdThreshSelect.value = thrVal;
          }
        }
        if (this._refs.tdNote) {
          this._refs.tdNote.textContent = desc.supported
            ? rxS.textDecodeMode > 0
              ? 'Decoding active'
              : 'Ready for CW / DATA decode'
            : desc.reason;
        }
      }
    }

    _updateDisplayTab(snapshot) {
      const dispRx = this._dispRx(snapshot);
      const dispS = (dispRx === 'B' ? snapshot.rxB : snapshot.rxA) || {};
      if (this._refs.dispBadge) {
        this._refs.dispBadge.textContent = `PAN ${dispRx}`;
        this._refs.dispBadge.classList.toggle('is-amber', dispRx === 'B');
      }
      const spanHz =
        (this.panadapter && typeof this.panadapter.getVisibleSpanHz === 'function'
          ? this.panadapter.getVisibleSpanHz(dispRx)
          : Number(dispS.panSpanHz)) || 48000;
      if (this._refs.spanBtns) {
        for (let i = 0; i < this._refs.spanBtns.length; i++) {
          const { hz, btn } = this._refs.spanBtns[i];
          btn.classList.toggle('is-active', Math.abs(spanHz - hz) < 500);
        }
      }
      if (this._refs.spanSlider) this._refs.spanSlider.sync(Math.round(spanHz / 1000));
      if (this._refs.refSlider) this._refs.refSlider.sync(dispS.panRefDbm ?? -110);
      if (this._refs.scaleSlider) this._refs.scaleSlider.sync(dispS.panScaleDb ?? 80);
      if (this._refs.avgSlider) this._refs.avgSlider.sync(snapshot.panAvg ?? 4);
      if (this._refs.wbsSlider) this._refs.wbsSlider.sync(dispS.wfBlack ?? 14);
      if (this._refs.autoRefSwitch) this._refs.autoRefSwitch.sync(dispS.autoRef);
      if (this._refs.cursorModeBtns) {
        const ftOn = Boolean(snapshot.fixedTune);
        const ftMode = Number.isFinite(Number(snapshot.fixedTuneMode)) ? Number(snapshot.fixedTuneMode) : 1;
        for (let i = 0; i < this._refs.cursorModeBtns.length; i++) {
          const { cm, btn } = this._refs.cursorModeBtns[i];
          const active = cm.mode === null ? !ftOn : (ftOn && ftMode === cm.mode);
          btn.classList.toggle('is-active', active);
          btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        }
      }
      if (this._refs.freezeSwitch) this._refs.freezeSwitch.sync(snapshot.panFrozen);
      if (this._refs.fpsSlider) this._refs.fpsSlider.sync(snapshot.panFps ?? 20);
      if (this._refs.panNbBtns) {
        const pnb = Number(dispS.panNbMode ?? 0);
        for (let i = 0; i < this._refs.panNbBtns.length; i++) {
          const b = this._refs.panNbBtns[i];
          b.classList.toggle('is-active', Number(b.dataset.panNb) === pnb);
        }
      }
      if (this._refs.panNbLevelSlider) this._refs.panNbLevelSlider.sync(dispS.panNbLevel ?? 0);
      if (this._refs.dpmBtns) {
        const dpm = snapshot.dualPanMode === 1 ? 1 : snapshot.dualPanMode === 2 ? 2 : 0;
        this._refs.dpmBtns[0].classList.toggle('is-active', dpm === 0);
        this._refs.dpmBtns[1].classList.toggle('is-active', dpm === 1);
        this._refs.dpmBtns[2].classList.toggle('is-active', dpm === 2);
        this._refs.dpmBtns[1].disabled = false;
        this._refs.dpmBtns[2].disabled = false;
        this._refs.dpmBtns[1].title = 'Single Pan VFO B';
        this._refs.dpmBtns[2].title = 'Dual Panadapter VFO A + B';
      }
      const rxAState = snapshot.rxA || {};
      const rxBState = snapshot.rxB || {};
      if (this._refs.miniPanASwitch) this._refs.miniPanASwitch.sync(rxAState.miniPan);
      if (this._refs.miniPanBSwitch) {
        this._refs.miniPanBSwitch.sync(rxBState.miniPan);
        const mpBDisabled = !snapshot.subRxEnabled || rxBState.miniPanAvailable === false;
        this._refs.miniPanBSwitch.btn.disabled = mpBDisabled;
        this._refs.miniPanBSwitch.btn.title = mpBDisabled
          ? !snapshot.subRxEnabled
            ? 'Enable Sub-RX first'
            : 'Mini-Pan VFO B unavailable'
          : '';
      }
      if (this._refs.peakHoldSwitch) this._refs.peakHoldSwitch.sync(this.getPeakHold());
      if (this._refs.dsmBtns) {
        const dsm = Number(snapshot.displayMode ?? 1);
        for (let i = 0; i < this._refs.dsmBtns.length; i++) {
          const b = this._refs.dsmBtns[i];
          b.classList.toggle('is-active', Number(b.dataset.dsm) === dsm);
        }
      }
      if (this._refs.wfhSlider) {
        this._refs.wfhSlider.sync(snapshot.waterfallHeightPct ?? 60);
        this._refs.wfhSlider.input.disabled = snapshot.displayMode === 0 || snapshot.displayMode === 2;
      }
      if (this._refs.paletteBtns) {
        const pal = this.getPalette();
        for (const k of Object.keys(this._refs.paletteBtns)) {
          this._refs.paletteBtns[k].classList.toggle('is-active', k === pal);
        }
      }
      if (this._refs.mouseQsyBtns) {
        const qsyMode = this.getMouseQsyMode();
        for (let i = 0; i < this._refs.mouseQsyBtns.length; i++) {
          const b = this._refs.mouseQsyBtns[i];
          b.classList.toggle('is-active', b.dataset.qsyMode === qsyMode);
        }
      }
    }

    _updateAudioTab(snapshot, rxS, aDiag) {
      if (this._refs.panelAudioBtn) {
        if (!aDiag.started) {
          this._refs.panelAudioBtn.textContent = 'Start & Unmute Audio';
        } else {
          this._refs.panelAudioBtn.textContent = aDiag.muted ? 'Unmute Receiver Audio' : 'Mute Receiver Audio';
        }
      }
      if (this._refs.mixBtns) {
        const mx = snapshot.audioMix || 'A.B';
        for (const k of Object.keys(this._refs.mixBtns)) {
          this._refs.mixBtns[k].classList.toggle('is-active', k === mx);
        }
      }
      if (this._refs.slSlider) this._refs.slSlider.sync(snapshot.streamingLatency ?? 2);
      if (this._refs.emSelect && document.activeElement !== this._refs.emSelect) {
        const em = String(snapshot.encodeMode ?? 1);
        if (this._refs.emSelect.querySelector(`option[value="${em}"]:not(:disabled)`)) {
          this._refs.emSelect.value = em;
        }
      }

      if (this._refs.diag) {
        const pMet = this.panadapter && this.panadapter.getMetrics ? this.panadapter.getMetrics() : {};
        const conn = snapshot.connection || {};
        this._refs.diag.renderer.textContent = pMet.rendererType || '—';
        this._refs.diag.frames.textContent = String(pMet.framesRendered ?? 0);
        this._refs.diag.panTier.textContent = pMet.tierKHz ? `${pMet.tierKHz} kHz` : `${rxS.panTierKHz || 48} kHz`;
        this._refs.diag.rtt.textContent = conn.rttMs !== null && conn.rttMs !== undefined ? `${conn.rttMs} ms` : '—';
        if (this._refs.diag.e2eLatency) {
          const lb =
            aDiag.e2eRxMs !== undefined || aDiag.localPipelineMs !== undefined
              ? aDiag
              : this.audio && typeof this.audio.getLatencyBreakdown === 'function'
              ? this.audio.getLatencyBreakdown(conn.rttMs)
              : null;
          let latText = '—';
          if (lb) {
            if (lb.e2eRxMs != null) {
              const parts = [];
              if (lb.rxNetHalfRttMs != null) parts.push(`½${lb.rxNetHalfRttMs}`);
              if (lb.rxFrameMs != null) parts.push(`${lb.rxFrameMs}`);
              if (lb.rxJitterMs != null) parts.push(`J${lb.rxJitterMs}`);
              if (lb.rxAudioOutMs != null) parts.push(`O${lb.rxAudioOutMs}`);
              const txPart = lb.e2eTxMs != null ? ` · TX ${lb.e2eTxMs}ms` : '';
              latText = `RX ${lb.e2eRxMs}ms (${parts.join('+')})${txPart}`;
            } else if (aDiag.started && !aDiag.muted && lb.localPipelineMs != null) {
              const txPart = lb.e2eTxMs != null ? ` · TX ${lb.e2eTxMs}ms` : '';
              latText = `RX local ${lb.localPipelineMs}ms${txPart}`;
            } else if (lb.e2eTxMs != null) {
              latText = `RX off · TX ${lb.e2eTxMs}ms`;
            } else {
              latText = 'RX off';
            }
          }
          this._refs.diag.e2eLatency.textContent = latText;
          const latTip = lb && lb.e2eRxMs != null
            ? [
                `Estimated RX audio delay: ${lb.e2eRxMs} ms (radio -> speakers)`,
                `• ½: one-way network delay (½ RTT = ${lb.rxNetHalfRttMs ?? 0} ms)`,
                `• ${lb.rxFrameMs ?? 20}: audio packet framing (${lb.rxFrameMs ?? 20} ms)`,
                `• J: browser jitter buffer (${lb.rxJitterMs ?? 0} ms)`,
                `• O: Web Audio output latency (${lb.rxAudioOutMs ?? 0} ms)`,
                ...(lb.e2eTxMs != null ? [`Estimated TX audio delay: ${lb.e2eTxMs} ms (mic -> radio)`] : []),
              ].join('\n')
            : 'Estimated one-way RX/TX audio delay (½ RTT + packet framing + jitter buffer + Web Audio output).';
          this._refs.diag.e2eLatency.title = latTip;
          if (this._refs.diag.e2eLatency.parentNode) {
            this._refs.diag.e2eLatency.parentNode.title = latTip;
          }
        }
        this._refs.diag.sink.textContent = aDiag.sinkType || 'none';
        this._refs.diag.bufferMs.textContent = aDiag.started ? `${Math.round(aDiag.bufferMs || 0)} / ${aDiag.targetMs || 75} ms` : 'stopped';
        this._refs.diag.packets.textContent = String(aDiag.packetsIn ?? 0);
        this._refs.diag.underruns.textContent = `${aDiag.underruns ?? 0} / ${aDiag.seqGaps ?? 0}`;
        const tel = snapshot.telemetry || {};
        this._refs.diag.supply.textContent =
          tel.supplyVolts != null
            ? `${tel.supplyVolts.toFixed(1)} V${tel.supplyAmps != null ? ` · ${tel.supplyAmps.toFixed(2)} A` : ''}`
            : '—';
        const cpuParts = [];
        if (tel.cpuTempC != null) cpuParts.push(`CPU ${tel.cpuTempC.toFixed(1)}°C`);
        if (tel.fpTempC != null) cpuParts.push(`FP ${tel.fpTempC.toFixed(1)}°C`);
        this._refs.diag.cpuTemp.textContent = cpuParts.length ? cpuParts.join(' · ') : '—';
        const paParts = [];
        if (tel.paTempC != null) paParts.push(`PA ${tel.paTempC.toFixed(1)}°C`);
        if (tel.lpaTempC != null) paParts.push(`LPA ${tel.lpaTempC.toFixed(1)}°C`);
        this._refs.diag.paTemp.textContent = paParts.length ? paParts.join(' · ') : '—';
      }

      this._syncAfScopeLoop();
      if (this._shouldRunAfScope()) {
        this._drawAfScope(snapshot);
      }
    }

    _updateSensorStrip(snapshot) {
      if (!this._strip) return;
      const { vs, isAmps, peakIs, pt, tf, swr } = extractSensorReadings(snapshot);
      const conn = (snapshot && snapshot.connection) || {};

      if (this._statusCyclerVal) {
        const modeIdx = this._statusModeIdx || 0;
        let statusText = '';
        if (modeIdx === 0) {
          statusText = `UTC ${new Date().toISOString().slice(11, 16)}Z`;
        } else if (modeIdx === 1) {
          statusText = conn.rttMs !== null && conn.rttMs !== undefined ? `RTT ${conn.rttMs}ms` : 'RTT —';
        } else if (modeIdx === 2) {
          const vTxt = vs != null ? `${vs.toFixed(1)}V` : '—';
          const aTxt = isAmps != null ? `${isAmps.toFixed(1)}A` : '';
          statusText = aTxt ? `${vTxt} ${aTxt}` : vTxt;
        } else {
          statusText = snapshot.serialNumber ? `K4 #${snapshot.serialNumber}` : (snapshot.radioId || 'K4');
        }
        this._statusCyclerVal.textContent = statusText;
        if (this._statusCyclerBtn) {
          this._statusCyclerBtn.dataset.mode = ['utc', 'rtt', 'dc', 'radio'][modeIdx] || 'utc';
        }
      }

      this._strip.vs.val.textContent = vs != null ? `${vs.toFixed(1)}V` : '—';
      this._strip.vs.pill.dataset.level = sensorVoltLevel(vs);
      this._strip.vs.pill.classList.toggle('is-selected', this._selectedSensorKey === 'vs');

      this._strip.is.val.textContent = isAmps != null
        ? (peakIs != null && peakIs > isAmps + 0.3 ? `${isAmps.toFixed(1)}A` : `${isAmps.toFixed(1)}A`)
        : '—';
      this._strip.is.pill.dataset.level = isAmps != null && isAmps > 21 ? 'warn' : 'ok';
      this._strip.is.pill.classList.toggle('is-selected', this._selectedSensorKey === 'is');

      const stripTempKey = pt == null && tf != null ? 'tf' : 'pt';
      const stripTempVal = pt != null ? pt : tf;
      const stripTempLbl = stripTempKey === 'tf' ? 'FP' : 'PA';
      this._strip.pt.lbl.textContent = stripTempLbl;
      this._strip.pt.pill.dataset.sensorKey = stripTempKey;
      this._strip.pt.pill.title = `Open ${stripTempKey === 'tf' ? 'Front Panel' : 'PA'} temp graph in TX`;
      this._strip.pt.val.textContent = stripTempVal != null ? `${stripTempVal.toFixed(0)}°` : '—';
      this._strip.pt.pill.dataset.level = stripTempKey === 'tf' ? sensorTfLevel(stripTempVal) : sensorTempLevel(stripTempVal);
      this._strip.pt.pill.classList.toggle('is-selected', this._selectedSensorKey === stripTempKey);

      this._strip.swr.val.textContent = `${swr.toFixed(1)}`;
      this._strip.swr.pill.dataset.level = sensorSwrLevel(swr);
      this._strip.swr.pill.classList.toggle('is-selected', this._selectedSensorKey === 'swr');
    }

    _updateTxTab(snapshot, aDiag) {
      this._updateTxAndSensors(snapshot, aDiag);
    }

    _updateTxAndSensors(snapshot, aDiag) {
      const { tel, vs, sag, isAmps, peakIs, pt, lt, tf, fwdWatts, peakFwd, swr } = extractSensorReadings(snapshot);
      const isDemo = this._isDemoMode(snapshot);
      const txActive = !isDemo && Boolean(snapshot.txActive);
      const isTest = !isDemo && Boolean(snapshot.txTestMode || snapshot.txPosture === 'tx-test');
      const atuTuning = !isDemo && Boolean(snapshot.atuTuning);

      // (a) TX & Split
      if (this._refs.txCardPttBtn) {
        const pttBtn = this._refs.txCardPttBtn;
        const posture = isDemo ? 'rx-only' : (snapshot.txPosture || 'rx-only');
        const pttEnabled = !isDemo && posture !== 'rx-only' && !snapshot.txInhibit;
        pttBtn.disabled = !pttEnabled;
        const held = !isDemo && Boolean(this.isPttHeld() || snapshot.pttHeld);
        const cfg = typeof this.getTxAudioConfig === 'function' ? this.getTxAudioConfig() : {};
        const pttInfo = describePttMicState(snapshot, cfg, this.audio, isTest);
        pttBtn.classList.toggle('is-held', held);
        pttBtn.classList.toggle('is-tx', txActive);
        pttBtn.dataset.txTest = isTest ? 'true' : 'false';
        pttBtn.dataset.micState = pttInfo.micState;
        pttBtn.dataset.micWarn = !isDemo && pttInfo.micWarn ? 'true' : 'false';
        pttBtn.setAttribute('aria-pressed', (held || txActive) ? 'true' : 'false');
        pttBtn.textContent = txActive ? pttInfo.txLabel : pttInfo.idleLabel;
        pttBtn.title = isDemo
          ? 'Demo mode is receive-only (microphone unused)'
          : `Hold to transmit (release to return to receive)${pttInfo.titleDetail}`;
      }
      if (this._refs.txTestToggleBtn) {
        this._refs.txTestToggleBtn.disabled = isDemo;
        this._refs.txTestToggleBtn.classList.toggle('is-active', isTest);
        this._refs.txTestToggleBtn.setAttribute('aria-pressed', isTest ? 'true' : 'false');
        this._refs.txTestToggleBtn.textContent = 'TEST';
      }
      if (this._refs.txStatusBanner) {
        const b = this._refs.txStatusBanner;
        if (snapshot.txInhibit) {
          b.hidden = false;
          b.textContent = 'TX INHIBIT';
          b.dataset.state = 'warn';
          if (this._refs.txStatusBadge) this._refs.txStatusBadge.textContent = 'INHIBIT';
        } else if (atuTuning) {
          b.hidden = false;
          b.textContent = 'ATU Tuning...';
          b.dataset.state = 'tuning';
          if (this._refs.txStatusBadge) this._refs.txStatusBadge.textContent = 'ATU';
        } else {
          b.hidden = true;
          b.textContent = '';
          if (this._refs.txStatusBadge) {
            this._refs.txStatusBadge.textContent = txActive
              ? (isTest ? 'TEST' : 'TX')
              : (isTest ? 'TEST' : 'RDY');
          }
        }
      }
      if (this._refs.txVfoVal) {
        const txVfo = snapshot.activeTxVfo || (snapshot.splitEnabled ? 'B' : 'A');
        this._refs.txVfoVal.textContent = snapshot.splitEnabled
          ? `VFO ${txVfo} (SPLIT)`
          : `VFO ${txVfo}`;
      }
      if (this._refs.txTotVal) {
        const maxSec = Number(snapshot.txTimeoutSec) || 180;
        const elapsed = txActive && snapshot.txStartedAt ? Math.max(0, Math.floor((Date.now() - snapshot.txStartedAt) / 1000)) : 0;
        const rem = Math.max(0, maxSec - elapsed);
        const mm = String(Math.floor(rem / 60)).padStart(1, '0');
        const ss = String(rem % 60).padStart(2, '0');
        this._refs.txTotVal.textContent = txActive ? `${mm}:${ss} rem (${elapsed}s)` : `${mm}:${ss}`;
      }
      if (this._refs.txSplitSwitch) this._refs.txSplitSwitch.sync(Boolean(snapshot.splitEnabled));
      if (this._refs.txXitSwitch) this._refs.txXitSwitch.sync(Boolean(snapshot.xitEnabled));
      if (this._refs.txXitZeroBtn) {
        const off = Number((snapshot.rxA || {}).ritOffsetHz) || 0;
        this._refs.txXitZeroBtn.textContent = off === 0 ? 'XIT 0 Hz' : `${off > 0 ? '+' : ''}${off} Hz`;
      }

      // (b) ATU & Antenna
      if (this._refs.txAntennaBtn) {
        const ant = K4.formatTxAntenna(snapshot);
        this._refs.txAntennaBtn.textContent = ant.label;
        this._refs.txAntennaBtn.dataset.port = String(ant.port);
      }
      if (this._refs.atuModuleBadge) {
        this._refs.atuModuleBadge.textContent = snapshot.hasAtu === false ? 'NO ATU' : (atuTuning ? 'TUNING' : 'KAT4');
      }
      if (this._refs.atuModeBtns) {
        const am = Number(snapshot.atuMode);
        this._refs.atuModeBtns[1].classList.toggle('is-active', am === 1);
        this._refs.atuModeBtns[2].classList.toggle('is-active', am === 2);
      }
      const searchWindowRemMs = (Number(snapshot.atuSearchWindowUntil) || 0) - Date.now();
      const searchHot = !atuTuning && searchWindowRemMs > 0;
      if (this._atuCueTimer) {
        clearTimeout(this._atuCueTimer);
        this._atuCueTimer = null;
      }
      if (searchHot) {
        this._atuCueTimer = setTimeout(() => {
          this._atuCueTimer = null;
          if (this._getVisibleTabId() === 'tx') {
            this._updateTxTab(this._snap(), this.audio && this.audio.getDiagnostics ? this.audio.getDiagnostics() : {});
          } else {
            this._dirtyTabs.add('tx');
          }
        }, searchWindowRemMs + 30);
      }
      if (this._refs.atuBtns) {
        this._refs.atuBtns.tune.classList.toggle('k4-btn--search-hot', searchHot);
        this._refs.atuBtns.tune.textContent = searchHot ? '2nd TAP: FULL' : 'ATU TUNE';
        this._refs.atuBtns.tune.disabled = snapshot.hasAtu === false;
      }
      if (this._refs.atuStatus) {
        const st = this._refs.atuStatus;
        const am = Number(snapshot.atuMode);
        if (snapshot.hasAtu === false || am === 0) {
          st.textContent = 'KAT4 internal ATU not detected';
          st.dataset.state = 'idle';
        } else if (atuTuning) {
          st.textContent = `KAT4 ${snapshot.atuTuneKind === 4 ? 'Full Search' : 'Tuning'}... SWR ${swr.toFixed(2)}:1`;
          st.dataset.state = 'tuning';
        } else if (searchHot) {
          st.textContent = 'Tap ATU TUNE again within 5s for Full Search';
          st.dataset.state = 'warn';
        } else if (am === 1) {
          st.textContent = 'KAT4 Bypassed';
          st.dataset.state = 'idle';
        } else if (snapshot.atuMatchedSwr) {
          const mFreq = snapshot.atuLastTunedFreqHz ? `${(snapshot.atuLastTunedFreqHz / 1e6).toFixed(3)} MHz` : 'active band';
          st.textContent = `Matched ${Number(snapshot.atuMatchedSwr).toFixed(2)}:1 @ ${mFreq}`;
          st.dataset.state = 'matched';
        } else {
          st.textContent = 'KAT4 Auto Ready';
          st.dataset.state = 'idle';
        }
      }

      // (c) RF Power & Audio TX
      if (this._refs.txPowerSlider) {
        this._refs.txPowerSlider.sync(snapshot.powerWatts ?? 10);
      }
      if (this._refs.txMgSlider) this._refs.txMgSlider.sync(snapshot.micGain ?? 15);
      if (this._refs.txCpSlider) this._refs.txCpSlider.sync(snapshot.compDbSet ?? 0);
      if (this._refs.txMlSlider) {
        const ch = this._txMonitorChannel();
        const mlVal = ch === 0 ? snapshot.monCw : (ch === 1 ? snapshot.monData : snapshot.monVoice);
        this._refs.txMlSlider.sync(mlVal ?? 5);
      }
      if (this._refs.txVoxSwitch) {
        const rx = snapshot.activeTxVfo === 'B' ? (snapshot.rxB || {}) : (snapshot.rxA || {});
        const mode = Number(rx.mode) || 2;
        const voxOn = (mode === 3 || mode === 7) ? snapshot.voxCw : ((mode === 6 || mode === 9) ? snapshot.voxData : snapshot.voxVoice);
        this._refs.txVoxSwitch.sync(Boolean(voxOn));
      }

      // K4 Message Memories (M1-M4 + BANK + STOP)
      if (this._refs.msgBankBadge && this._refs.msgSlotBtns && this._refs.msgBankBtn) {
        const bankOffset = this._msgBank === 2 ? 4 : 0;
        const activeSlot = snapshot.dvrPlaying ? Number(snapshot.dvrSlot) || 0 : 0;
        this._refs.msgBankBadge.textContent =
          activeSlot > 0
            ? `PLAY #${activeSlot} · BANK ${this._msgBank}`
            : `BANK ${this._msgBank} (#${bankOffset + 1}–${bankOffset + 4})`;
        this._refs.msgBankBtn.textContent =
          this._msgBank === 2 ? 'BANK 2 (5–8)' : 'BANK 1 (1–4)';
        this._refs.msgBankBtn.classList.toggle('is-active', this._msgBank === 2);
        for (let i = 0; i < this._refs.msgSlotBtns.length; i++) {
          const item = this._refs.msgSlotBtns[i];
          const slot = bankOffset + item.idx;
          const isPlaying = activeSlot === slot;
          item.btn.classList.toggle('is-active', isPlaying);
          item.btn.title = `Play K4 Message M${item.idx}`;
        }
        if (this._refs.msgStopBtn) {
          this._refs.msgStopBtn.classList.toggle('is-active', activeSlot > 0);
        }
      }

      // Web TX Audio Source & VU meter
      const cfg = this.getTxAudioConfig();
      const secureOk = this._isMicSecureContext();
      if (this._refs.txAudioSource) {
        const sel = this._refs.txAudioSource;
        sel.disabled = isDemo;
        const micOpt = sel.querySelector('option[value="mic"]');
        if (micOpt) {
          micOpt.disabled = isDemo || !secureOk;
          micOpt.textContent = isDemo
            ? 'Microphone (Disabled in Demo)'
            : (secureOk ? 'Microphone (Live)' : 'Microphone (Requires localhost / HTTPS)');
        }
        const activeSrc = cfg.source === 'mic' && !secureOk ? 'two-tone' : (cfg.source || 'two-tone');
        if (document.activeElement !== sel && sel.value !== activeSrc) {
          sel.value = activeSrc;
        }
        if (this._refs.txMicSecNote) this._refs.txMicSecNote.hidden = isDemo || secureOk;
        if (this._refs.txMicExtras) this._refs.txMicExtras.hidden = isDemo || !(activeSrc === 'mic' && secureOk);
        if (this._refs.txWavExtras) this._refs.txWavExtras.hidden = isDemo || activeSrc !== 'wav';
        if (this._refs.txVpSwitch) this._refs.txVpSwitch.sync(Boolean(cfg.voiceProcessing));
        if (this._refs.txWavNameEl && cfg.wavName) {
          this._refs.txWavNameEl.textContent = cfg.wavName;
        }
      }
      if (this._refs.txVuFill && this._refs.txVuVal) {
        const level = Math.max(0, Math.min(1, Number(aDiag.txInputLevel) || 0));
        const pkts = Number(aDiag.txPacketsOut) || 0;
        this._refs.txVuFill.style.width = `${Math.round(level * 100)}%`;
        this._refs.txVuVal.textContent = `${Math.round(level * 100)}% · ${pkts} pkts`;
      }

      // (d) CW / DATA Keyer
      if (this._refs.tbVal && this._refs.tbFill) {
        const q = Math.max(0, Number(snapshot.txBufferCount) || 0);
        const full = Boolean(snapshot.keyerBufferFull || q >= 24);
        this._refs.tbVal.textContent = full ? `${q} (FULL)` : `${q} chars`;
        this._refs.tbFill.style.width = `${Math.min(100, Math.round((q / 24) * 100))}%`;
        this._refs.tbFill.classList.toggle('is-full', full);
      }
      if (this._refs.cwKsSlider) this._refs.cwKsSlider.sync(snapshot.cwSpeedWpm ?? 20);
      if (this._refs.cwKpSlider) this._refs.cwKpSlider.sync(snapshot.keyerWeight ?? 115);
      if (this._refs.cwIambicBtn) this._refs.cwIambicBtn.textContent = `Iambic ${snapshot.keyerIambic || 'A'}`;
      if (this._refs.cwPolBtn) this._refs.cwPolBtn.textContent = `Paddle ${snapshot.keyerPaddleOrder || 'N'}`;
      if (this._refs.cwQskBtn) this._refs.cwQskBtn.classList.toggle('is-active', Boolean(snapshot.voxCw));

      // (e) Expanded PA, Electrical & Thermal Sensors
      if (this._refs.sensors) {
        const s = this._refs.sensors;
        s.vs.val.textContent = vs != null ? `${vs.toFixed(2)} V (ΔV ${sag.toFixed(2)} V)` : '—';
        s.vs.tile.dataset.level = sensorVoltLevel(vs);

        const paA = tel.paAmps != null ? ` · PA ${Number(tel.paAmps).toFixed(1)}A` : '';
        s.is.val.textContent = isAmps != null
          ? `${isAmps.toFixed(1)} A (pk ${(peakIs ?? isAmps).toFixed(1)} A)${paA}`
          : '—';
        s.is.tile.dataset.level = isAmps != null && isAmps > 21 ? 'warn' : 'ok';

        const isConnected = Boolean(snapshot.connection && snapshot.connection.status === 'connected');
        const paIdleLabel = isConnected ? 'Idle (on TX)' : '—';
        s.pt.val.textContent = pt != null ? `${pt.toFixed(1)} °C` : paIdleLabel;
        s.pt.tile.dataset.level = sensorTempLevel(pt);

        s.lt.val.textContent = lt != null ? `${lt.toFixed(1)} °C` : paIdleLabel;
        s.lt.tile.dataset.level = sensorTempLevel(lt);

        s.tf.val.textContent = tf != null ? `${tf.toFixed(1)} °C` : '—';
        s.tf.tile.dataset.level = sensorTfLevel(tf);

        const sysParts = [];
        if (tel.cpuTempC != null) sysParts.push(`C:${Number(tel.cpuTempC).toFixed(0)}°`);
        if (tel.dapTempC != null) sysParts.push(`D:${Number(tel.dapTempC).toFixed(0)}°`);
        if (tel.ducTempC != null) sysParts.push(`U:${Number(tel.ducTempC).toFixed(0)}°`);
        if (tel.ducDrive != null) sysParts.push(`DV:${Number(tel.ducDrive).toFixed(0)}`);
        s.sys.val.textContent = sysParts.length ? sysParts.join(' ') : '—';
        s.sys.tile.dataset.level = sensorTempLevel(tel.cpuTempC != null ? Number(tel.cpuTempC) : null);

        if (s.fwd) {
          const activeTxOrTune = txActive || atuTuning;
          s.fwd.val.textContent = activeTxOrTune || peakFwd > 0
            ? `${fwdWatts.toFixed(1)} W (pk ${peakFwd.toFixed(1)} W)`
            : '0.0 W (RX)';
          s.fwd.tile.dataset.level = activeTxOrTune && fwdWatts > 0 ? 'ok' : 'ok';
        }
        if (s.swr) {
          s.swr.val.textContent = `${swr.toFixed(2)}:1`;
          s.swr.tile.dataset.level = sensorSwrLevel(swr);
        }

        for (const k of Object.keys(s)) {
          const selected = this._selectedSensorKey === k;
          s[k].tile.classList.toggle('is-selected', selected);
          s[k].tile.setAttribute('aria-pressed', selected ? 'true' : 'false');
        }

        const maxHot = Math.max(pt || 0, lt || 0, tf || 0);
        if (this._refs.txThermalAlert) {
          if (maxHot >= 75) {
            this._refs.txThermalAlert.hidden = false;
            this._refs.txThermalAlert.className = 'k4-tx-inline-alert k4-tx-inline-alert--danger';
            this._refs.txThermalAlert.textContent = `CRITICAL THERMAL WARNING (${maxHot.toFixed(1)} °C >= 75 °C) — Drop TX immediately!`;
          } else if (maxHot >= 60) {
            this._refs.txThermalAlert.hidden = false;
            this._refs.txThermalAlert.className = 'k4-tx-inline-alert';
            this._refs.txThermalAlert.textContent = `Elevated PA/LPA temperature (${maxHot.toFixed(1)} °C >= 60 °C) — Monitor duty cycle.`;
          } else {
            this._refs.txThermalAlert.hidden = true;
          }
        }
      }
      this._renderSensorGraph(snapshot);
      if (this._refs.omBadges) {
        this._refs.omBadges.kat4.classList.toggle('is-present', snapshot.hasAtu !== false);
        this._refs.omBadges.kpa4.classList.toggle('is-present', Boolean(snapshot.hasKpa4));
        this._refs.omBadges.krx4.classList.toggle('is-present', Boolean(snapshot.hasKrx4));
        this._refs.omBadges.amp.classList.toggle('is-present', Boolean(snapshot.hasLinearAmp));
      }
    }

    _renderSensorGraph() {
      const panel = this._refs.sensorGraphPanel;
      const canvas = this._refs.sensorGraphCanvas;
      const key = this._selectedSensorKey;
      if (!panel || !canvas) return;
      const meta = key ? SENSOR_META_BY_KEY[key] : null;
      if (!meta) {
        panel.hidden = true;
        return;
      }
      panel.hidden = false;
      this._refs.sensorGraphTitle.textContent = `${meta.label} (${meta.unit})`;

      const hist =
        this.state && typeof this.state.getSensorHistory === 'function'
          ? this.state.getSensorHistory(key, this._sensorWindowSec)
          : { points: [], min: null, max: null, current: null };
      const points = Array.isArray(hist.points) ? hist.points.slice() : [];
      if (points.length === 0 && Number.isFinite(hist.current)) {
        points.push({ ts: Date.now(), value: hist.current });
      }
      const fmt = (v) => (Number.isFinite(v) ? `${v.toFixed(meta.decimals)} ${meta.unit}` : '—');
      const minVal = hist.min != null ? hist.min : (points[0] ? points[0].value : null);
      const maxVal = hist.max != null ? hist.max : (points[0] ? points[0].value : null);
      this._refs.sensorGraphStats.textContent = `Min ${fmt(minVal)} · Now ${fmt(hist.current)} · Max ${fmt(maxVal)}`;

      const cssW = Math.max(220, canvas.clientWidth || 264);
      const cssH = 104;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.save();
      ctx.scale(dpr, dpr);

      ctx.fillStyle = '#090D16';
      ctx.fillRect(0, 0, cssW, cssH);

      const padL = 36;
      const padR = 8;
      const padT = 10;
      const padB = 18;
      const plotW = Math.max(10, cssW - padL - padR);
      const plotH = Math.max(10, cssH - padT - padB);

      if (points.length === 0) {
        ctx.fillStyle = '#64748B';
        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Waiting for telemetry samples...', cssW / 2, cssH / 2 + 4);
        ctx.restore();
        return;
      }

      let lo = Number.isFinite(minVal) ? minVal : 0;
      let hi = Number.isFinite(maxVal) ? maxVal : 1;
      if (Number.isFinite(meta.minFloor)) lo = Math.min(lo, meta.minFloor);
      if (hi - lo < (meta.unit === 'V' ? 0.5 : meta.unit === ':1' ? 0.4 : 2)) {
        const mid = (hi + lo) * 0.5;
        const half = meta.unit === 'V' ? 0.4 : meta.unit === ':1' ? 0.25 : 2;
        lo = Number.isFinite(meta.minFloor) ? Math.max(meta.minFloor, mid - half) : mid - half;
        hi = mid + half;
      } else {
        const span = hi - lo;
        lo = Number.isFinite(meta.minFloor) ? Math.max(meta.minFloor, lo - span * 0.1) : lo - span * 0.1;
        hi = hi + span * 0.12;
      }

      const nowTs = Date.now();
      const startTs = nowTs - this._sensorWindowSec * 1000;
      const xOf = (ts) => padL + clamp((ts - startTs) / Math.max(1000, nowTs - startTs), 0, 1) * plotW;
      const yOf = (val) => padT + (1 - clamp((val - lo) / Math.max(1e-6, hi - lo), 0, 1)) * plotH;

      // Subtle grid + Y axis ticks
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
      ctx.lineWidth = 1;
      ctx.fillStyle = '#94A3B8';
      ctx.font = '10px ui-monospace, SFMono-Regular, monospace';
      ctx.textAlign = 'right';
      for (let g = 0; g <= 2; g++) {
        const frac = g / 2;
        const y = padT + frac * plotH;
        const labelVal = hi - frac * (hi - lo);
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(cssW - padR, y);
        ctx.stroke();
        ctx.fillText(labelVal.toFixed(meta.decimals > 1 ? 1 : 0), padL - 4, y + 3);
      }

      // Optional threshold lines
      const drawThresh = (val, color) => {
        if (!Number.isFinite(val) || val < lo || val > hi) return;
        const y = yOf(val);
        ctx.save();
        ctx.strokeStyle = color;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(cssW - padR, y);
        ctx.stroke();
        ctx.restore();
      };
      drawThresh(meta.warnMax ?? meta.warnMin, 'rgba(245, 158, 11, 0.55)');
      drawThresh(meta.critMax ?? meta.critMin, 'rgba(244, 63, 94, 0.65)');

      // X axis window labels
      ctx.fillStyle = '#64748B';
      ctx.textAlign = 'left';
      ctx.fillText(`-${this._sensorWindowSec}s`, padL, cssH - 4);
      ctx.textAlign = 'right';
      ctx.fillText('now', cssW - padR, cssH - 4);

      // Line + subtle fill
      ctx.beginPath();
      for (let i = 0; i < points.length; i++) {
        const px = xOf(points[i].ts);
        const py = yOf(points[i].value);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = meta.color;
      ctx.lineWidth = 1.8;
      ctx.stroke();

      if (points.length >= 2) {
        const lastPt = points[points.length - 1];
        const firstPt = points[0];
        ctx.lineTo(xOf(lastPt.ts), padT + plotH);
        ctx.lineTo(xOf(firstPt.ts), padT + plotH);
        ctx.closePath();
        ctx.fillStyle = meta.color + '24';
        ctx.fill();
      }

      const last = points[points.length - 1];
      ctx.fillStyle = meta.color;
      ctx.beginPath();
      ctx.arc(xOf(last.ts), yOf(last.value), 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  K4.InspectorPanels = InspectorPanels;
})();
