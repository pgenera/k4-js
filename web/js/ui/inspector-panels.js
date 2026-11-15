'use strict';
(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const DESKTOP_TABS = [
    { id: 'band-mode', label: 'Band/Mode' },
    { id: 'dsp', label: 'DSP' },
    { id: 'display', label: 'Display' },
    { id: 'audio', label: 'Audio' },
  ];

  const MOBILE_TABS = [
    { id: 'tune', label: 'Tune' },
    { id: 'band-mode', label: 'Band/Mode' },
    { id: 'dsp', label: 'DSP' },
    { id: 'display', label: 'Display' },
    { id: 'audio', label: 'Audio' },
  ];

  const MODE_CHOICES = [
    { id: 'LSB', label: 'LSB', code: 1, key: 'LSB', sub: null },
    { id: 'USB', label: 'USB', code: 2, key: 'USB', sub: null },
    { id: 'CW', label: 'CW', code: 3, key: 'CW', sub: null },
    { id: 'CW-R', label: 'CW-R', code: 7, key: 'CW-R', sub: null },
    { id: 'DATA-A', label: 'DATA-A', code: 6, key: 'DATA', sub: 0 },
    { id: 'AFSK-A', label: 'AFSK-A', code: 6, key: 'DATA', sub: 1 },
    { id: 'FSK-D', label: 'FSK-D', code: 6, key: 'DATA', sub: 2 },
    { id: 'PSK-D', label: 'PSK-D', code: 6, key: 'DATA', sub: 3 },
    { id: 'AM', label: 'AM', code: 5, key: 'AM', sub: null },
    { id: 'FM', label: 'FM', code: 4, key: 'FM', sub: null },
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
    selectEl.title = desc.reason || 'Text Decode Mode (TD / TD$)';
    return desc;
  }

  K4.syncDecodeSelect = syncDecodeSelect;

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
      this.getPeakHold = opts.getPeakHold || (() => true);
      this.onToggleAudio = opts.onToggleAudio || (() => {});

      this._activeDesktopTab = 'band-mode';
      this._activeMobileTab = null;
      this._panes = {};
      this._refs = {};
      this._keypadBuffer = '';
      this._localAudio = { gainA: 0.85, gainB: 0.85, balance: 0 };

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
      for (let i = 0; i < DESKTOP_TABS.length; i++) {
        const t = DESKTOP_TABS[i];
        const btn = el('button', 'k4-tab-btn', t.label);
        btn.type = 'button';
        btn.addEventListener('click', () => this.selectDesktopTab(t.id));
        this._desktopTabBtns[t.id] = btn;
        this.drawerTabBar.appendChild(btn);
      }
      this.drawerEl.appendChild(this.drawerTabBar);

      this.drawerScroll = el('div', 'k4-panel-scroll');
      this.drawerEl.appendChild(this.drawerScroll);
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
      titleWrap.appendChild(el('div', 'k4-sheet-grabber'));
      this.sheetTitleEl = el('div', 'k4-sheet-title', 'Controls');
      titleWrap.appendChild(this.sheetTitleEl);
      sheetHead.appendChild(titleWrap);

      const closeBtn = el('button', 'k4-icon-btn', '×');
      closeBtn.type = 'button';
      closeBtn.style.fontSize = '18px';
      closeBtn.title = 'Close sheet';
      closeBtn.addEventListener('click', () => this.closeMobileSheet());
      sheetHead.appendChild(closeBtn);

      // Touch swipe down to dismiss sheet
      let touchStartY = 0;
      sheetHead.addEventListener('touchstart', (e) => {
        if (e.touches && e.touches[0]) touchStartY = e.touches[0].clientY;
      }, { passive: true });
      sheetHead.addEventListener('touchend', (e) => {
        if (e.changedTouches && e.changedTouches[0] && e.changedTouches[0].clientY - touchStartY > 36) {
          this.closeMobileSheet();
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
    }

    _buildBandModePane() {
      const pane = el('div', 'k4-panel-pane');

      // Receiver Target & Sub RX
      const rxCard = makeCard('Target Receiver');
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

      const subRow = makeSwitchRow('Sub Receiver (SB)', () => {
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

      const linkRow = makeSwitchRow('Link VFOs (LN)', () => {
        const next = !this._snap().vfoLinked;
        if (this.state && typeof this.state.update === 'function') {
          this.state.update({ vfoLinked: next }, 'vfoLinked');
        }
        this._sendCat(`LN${next ? '1' : '0'};`);
      });
      rxCard.appendChild(linkRow.row);
      this._refs.linkSwitch = linkRow;
      pane.appendChild(rxCard);

      // Band Grid
      const bandCard = makeCard('Amateur Bands');
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

      // Mode Grid
      const modeCard = makeCard('Operating Mode');
      const modeGrid = el('div', 'k4-pill-grid k4-pill-grid--3');
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
      const stepCard = makeCard('Tuning Step (VT)');
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

      return pane;
    }

    _buildDspPane() {
      const pane = el('div', 'k4-panel-pane');

      const filterCard = makeCard('IF Filter & Pitch');
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
        label: 'Width (BW)',
        min: 50,
        max: 5000,
        step: 50,
        value: 2700,
        formatValue: (v) => (v >= 1000 ? `${(v / 1000).toFixed(2).replace(/0$/, '')} kHz` : `${v} Hz`),
        onInput: (v) => applyFilter(this.getTargetRx(), { bwHz: v }),
      });
      filterCard.appendChild(this._refs.bwSlider.row);

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
        label: 'IF Shift (IS)',
        min: 0,
        max: 5000,
        step: 50,
        value: 1500,
        formatValue: (v) => `${v} Hz`,
        onInput: (v) => applyFilter(this.getTargetRx(), { ifShiftHz: v }),
      });
      filterCard.appendChild(this._refs.isSlider.row);

      this._refs.cwPitchSlider = makeSliderRow({
        label: 'CW Pitch (CW)',
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
      rfCard.appendChild(el('span', 'k4-slider-label', 'Preamp (PA)'));
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
        label: 'Attenuator (RA)',
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
        label: 'RF Gain (RG)',
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

      rfCard.appendChild(el('span', 'k4-slider-label', 'AGC (GT)'));
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
      this._refs.nbSwitch = makeSwitchRow('Noise Blanker (NB)', () => {
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

      this._refs.nrSwitch = makeSwitchRow('Noise Reduction (NR)', () => {
        const rx = this.getTargetRx();
        const s = this._rxSnap(rx);
        const b = this._builders();
        const next = !s.nrOn;
        if (this.state && typeof this.state.updateRx === 'function') {
          this.state.updateRx(rx, { nrOn: next }, `${rx}.nrOn`);
        }
        this._sendCat(b.nr ? b.nr(rx, s.nrLevel ?? 4, next) : `NR${rx === 'B' ? '$' : ''}${String(s.nrLevel ?? 4).padStart(2, '0')}${next ? '1' : '0'};`);
      });
      dspCard.appendChild(this._refs.nrSwitch.row);

      this._refs.nrSlider = makeSliderRow({
        label: 'NR Level',
        min: 0,
        max: 10,
        step: 1,
        value: 4,
        formatValue: (v) => String(v),
        onInput: (v) => {
          const rx = this.getTargetRx();
          const s = this._rxSnap(rx);
          const b = this._builders();
          if (this.state && typeof this.state.updateRx === 'function') {
            this.state.updateRx(rx, { nrLevel: v }, `${rx}.nrLevel`);
          }
          this._sendCat(b.nr ? b.nr(rx, v, Boolean(s.nrOn)) : `NR${rx === 'B' ? '$' : ''}${String(v).padStart(2, '0')}${s.nrOn ? '1' : '0'};`);
        },
      });
      dspCard.appendChild(this._refs.nrSlider.row);

      this._refs.nmSwitch = makeSwitchRow('Manual Notch (NM)', () => {
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

      const tdCard = makeCard('CW / DATA Text Decode (TD)');
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
      const spanCard = makeCard('Spectrum Geometry', panBadge);
      const spanGrid = el('div', 'k4-pill-grid');
      this._refs.spanBtns = [];
      for (let i = 0; i < SPAN_PRESETS.length; i++) {
        const hz = SPAN_PRESETS[i];
        const btn = el('button', 'k4-choice-pill', `${hz / 1000}k`);
        btn.type = 'button';
        btn.addEventListener('click', () => {
          this.client.setDisplay(this._dispRx(), { panSpanHz: hz });
        });
        spanGrid.appendChild(btn);
        this._refs.spanBtns.push({ hz, btn });
      }
      spanCard.appendChild(spanGrid);

      this._refs.spanSlider = makeSliderRow({
        label: 'Span (#SPN)',
        min: 6,
        max: 368,
        step: 1,
        value: 48,
        formatValue: (v) => `${v} kHz`,
        onInput: (v) => {
          this.client.setDisplay(this._dispRx(), { panSpanHz: v * 1000 });
        },
      });
      spanCard.appendChild(this._refs.spanSlider.row);

      this._refs.refSlider = makeSliderRow({
        label: 'Reference (#REF)',
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
        label: 'Scale (#SCL)',
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
        label: 'Averaging (#AVG)',
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
        label: 'Waterfall Black (#WBS)',
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

      this._refs.autoRefSwitch = makeSwitchRow('Auto-Reference (#AR)', () => {
        const rx = this._dispRx();
        const s = this._rxSnap(rx);
        this.client.setDisplay(rx, { autoRef: !s.autoRef });
      });
      spanCard.appendChild(this._refs.autoRefSwitch.row);

      const actRow = el('div', 'k4-pill-grid k4-pill-grid--2');
      const centerBtn = el('button', 'k4-choice-pill', 'Center on VFO (FC)');
      centerBtn.type = 'button';
      centerBtn.addEventListener('click', () => {
        const rx = this._dispRx();
        const b = this._builders();
        this._sendCat(b.centerPan ? b.centerPan(rx) : rx === 'B' ? 'FC$;' : 'FC;');
      });
      const arNowBtn = el('button', 'k4-choice-pill', 'Auto-Ref Now (#AR1)');
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

      this._refs.fixedTuneSwitch = makeSwitchRow('Fixed Tune (#FXT)', () => {
        const s = this._snap();
        this.client.setDisplay(this._dispRx(), { fixedTune: !s.fixedTune });
      });
      spanCard.appendChild(this._refs.fixedTuneSwitch.row);

      pane.appendChild(spanCard);

      const layoutCard = makeCard('Panadapter Layout & LUT');
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

      this._refs.miniPanASwitch = makeSwitchRow('Mini-Pan VFO A (#MP)', () => {
        const s = this._rxSnap('A');
        this.client.setDisplay('A', { miniPan: !s.miniPan });
      });
      layoutCard.appendChild(this._refs.miniPanASwitch.row);

      this._refs.miniPanBSwitch = makeSwitchRow('Mini-Pan VFO B (#MP$)', () => {
        const s = this._rxSnap('B');
        this.client.setDisplay('B', { miniPan: !s.miniPan });
      });
      layoutCard.appendChild(this._refs.miniPanBSwitch.row);

      this._refs.peakHoldSwitch = makeSwitchRow('Peak Hold Trace', () => {
        this.onSetPeakHold(!this.getPeakHold());
      });
      layoutCard.appendChild(this._refs.peakHoldSwitch.row);

      layoutCard.appendChild(el('span', 'k4-slider-label', 'Waterfall Palette'));
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
      pane.appendChild(layoutCard);

      return pane;
    }

    _buildAudioPane() {
      const pane = el('div', 'k4-panel-pane');

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

      audioCard.appendChild(el('span', 'k4-slider-label', 'Channel Mix (MX)'));
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
        label: 'Latency Tier (SL)',
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

      const emLabel = el('span', 'k4-slider-label', 'Encode Mode (EM)');
      audioCard.appendChild(emLabel);
      const emSelect = document.createElement('select');
      emSelect.className = 'k4-select';
      const opusOk = Boolean(K4.OpusPacketDecoder && K4.OpusPacketDecoder.isSupported && K4.OpusPacketDecoder.isSupported());
      const emChoices = [
        { val: '1', label: 'PCM S16LE 12k (EM1)' },
        { val: '0', label: 'PCM 24-bit 12k (EM0)' },
        { val: '3', label: opusOk ? 'Opus 48k Stereo (EM3)' : 'Opus (EM3 — unavailable on file://)' },
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
        ['sink', 'Audio Sink'],
        ['bufferMs', 'Jitter Buf'],
        ['packets', 'Audio Pkts'],
        ['underruns', 'Underruns / Gaps'],
      ];
      this._refs.diag = {};
      for (let i = 0; i < diagFields.length; i++) {
        const [k, label] = diagFields[i];
        const box = el('div', 'k4-kv-item');
        box.appendChild(el('div', 'k4-kv-k', label));
        const val = el('div', 'k4-kv-v', '—');
        box.appendChild(val);
        kvGrid.appendChild(box);
        this._refs.diag[k] = val;
      }
      diagCard.appendChild(kvGrid);
      pane.appendChild(diagCard);

      // RX-Only Safety Card
      const safeCard = makeCard('Receive-Only Firewall');
      const safeBox = el('div', 'k4-safety-note');
      this._refs.safetyNote = safeBox;
      safeCard.appendChild(safeBox);
      pane.appendChild(safeCard);

      return pane;
    }

    _buildTunePane() {
      const pane = el('div', 'k4-panel-pane k4-pane--tune');
      const card = makeCard('Direct Frequency Entry');

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

    selectDesktopTab(tabId) {
      if (!this._panes[tabId] || tabId === 'tune') return;
      this._activeDesktopTab = tabId;
      this.syncHost();
      this.update(this._snap());
    }

    toggleMobileSheet(tabId) {
      if (this._activeMobileTab === tabId) {
        this.closeMobileSheet();
        return;
      }
      this._activeMobileTab = tabId;
      this.syncHost();
      this.update(this._snap());
    }

    closeMobileSheet() {
      this._activeMobileTab = null;
      this.syncHost();
    }

    isMobileSheetOpen() {
      return Boolean(this._activeMobileTab);
    }

    syncHost() {
      const isMobile = window.innerWidth < 960;

      for (const id of Object.keys(this._desktopTabBtns)) {
        this._desktopTabBtns[id].classList.toggle('is-active', id === this._activeDesktopTab);
      }

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
        this.mobileSheetEl.dataset.open = 'true';
        this.mobileSheetEl.setAttribute('aria-hidden', 'false');
      } else {
        this.mobileSheetEl.dataset.open = 'false';
        this.mobileSheetEl.setAttribute('aria-hidden', 'true');
      }
    }

    update(snapshot) {
      if (!snapshot) return;
      const targetRx = this.getTargetRx();
      const rxS = (targetRx === 'B' ? snapshot.rxB : snapshot.rxA) || {};
      const isAmber = targetRx === 'B';

      // Target buttons
      if (this._refs.targetBtns) {
        this._refs.targetBtns.A.classList.toggle('is-active', targetRx === 'A');
        this._refs.targetBtns.B.classList.toggle('is-active', targetRx === 'B');
      }
      if (this._refs.mobileTargetBtns) {
        this._refs.mobileTargetBtns.A.classList.toggle('is-active', targetRx === 'A');
        this._refs.mobileTargetBtns.B.classList.toggle('is-active', targetRx === 'B');
      }

      if (this._refs.subSwitch) this._refs.subSwitch.sync(snapshot.subRxEnabled);
      if (this._refs.linkSwitch) this._refs.linkSwitch.sync(snapshot.vfoLinked);

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
        for (let i = 0; i < this._refs.modeBtns.length; i++) {
          const { mc, btn } = this._refs.modeBtns[i];
          const active = rxS.mode === mc.code && (mc.sub === null || rxS.dataSubMode === mc.sub);
          btn.classList.toggle('is-active', active);
          btn.classList.toggle('is-amber', isAmber && active);
        }
      }

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
      if (this._refs.agcBtns) {
        const agc = Number(rxS.agc ?? 1);
        for (const m of Object.keys(this._refs.agcBtns)) {
          this._refs.agcBtns[m].classList.toggle('is-active', Number(m) === agc);
        }
      }
      if (this._refs.nbSwitch) this._refs.nbSwitch.sync(rxS.nbOn);
      if (this._refs.nbSlider) this._refs.nbSlider.sync(rxS.nbLevel ?? 5);
      if (this._refs.nrSwitch) this._refs.nrSwitch.sync(rxS.nrOn);
      if (this._refs.nrSlider) this._refs.nrSlider.sync(rxS.nrLevel ?? 4);
      if (this._refs.nmSwitch) this._refs.nmSwitch.sync(rxS.notchOn);
      if (this._refs.nmSlider) this._refs.nmSlider.sync(rxS.notchHz ?? 750);

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
              ? 'Decoding active (TB polling)'
              : 'Ready for CW / DATA decode'
            : desc.reason;
        }
      }

      // Display controls (routed to the visible display RX when Single-Pan)
      const dispRx = this._dispRx(snapshot);
      const dispS = (dispRx === 'B' ? snapshot.rxB : snapshot.rxA) || {};
      if (this._refs.dispBadge) {
        this._refs.dispBadge.textContent = `PAN ${dispRx}`;
        this._refs.dispBadge.classList.toggle('is-amber', dispRx === 'B');
      }
      const spanHz = Number(dispS.panSpanHz) || 48000;
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
      if (this._refs.fixedTuneSwitch) this._refs.fixedTuneSwitch.sync(snapshot.fixedTune);
      if (this._refs.dpmBtns) {
        const dpm = snapshot.dualPanMode === 1 ? 1 : snapshot.dualPanMode === 2 ? 2 : 0;
        const noSub = snapshot.hasSubRx === false;
        this._refs.dpmBtns[0].classList.toggle('is-active', dpm === 0);
        this._refs.dpmBtns[1].classList.toggle('is-active', dpm === 1);
        this._refs.dpmBtns[2].classList.toggle('is-active', dpm === 2);
        this._refs.dpmBtns[1].disabled = noSub;
        this._refs.dpmBtns[2].disabled = noSub;
        const subTip = noSub ? 'Requires Sub-RX option (OM lacks S)' : '';
        this._refs.dpmBtns[1].title = subTip;
        this._refs.dpmBtns[2].title = subTip;
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
            ? 'Enable Sub-RX (SB1) first'
            : 'Mini-Pan VFO B unavailable (#MP$-1)'
          : '';
      }
      if (this._refs.peakHoldSwitch) this._refs.peakHoldSwitch.sync(this.getPeakHold());
      if (this._refs.paletteBtns) {
        const pal = this.getPalette();
        for (const k of Object.keys(this._refs.paletteBtns)) {
          this._refs.paletteBtns[k].classList.toggle('is-active', k === pal);
        }
      }

      // Audio & Diagnostics
      const aDiag = this.audio && this.audio.getDiagnostics ? this.audio.getDiagnostics() : {};
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
        this._refs.diag.sink.textContent = aDiag.sinkType || 'none';
        this._refs.diag.bufferMs.textContent = aDiag.started ? `${Math.round(aDiag.bufferMs || 0)} / ${aDiag.targetMs || 75} ms` : 'stopped';
        this._refs.diag.packets.textContent = String(aDiag.packetsIn ?? 0);
        this._refs.diag.underruns.textContent = `${aDiag.underruns ?? 0} / ${aDiag.seqGaps ?? 0}`;
      }

      if (this._refs.safetyNote) {
        const gStats = this.gate && this.gate.getStats ? this.gate.getStats() : { blockedCatCount: 0, blockedBinaryCount: 0 };
        const totalBlocked = (gStats.blockedCatCount || 0) + (gStats.blockedBinaryCount || 0);
        const policy = this.gate && this.gate.getPolicy ? this.gate.getPolicy() : 'rx-only';
        this._refs.safetyNote.textContent =
          `Policy: ${policy.toUpperCase()} · Intercepted TX attempts: ${totalBlocked}. ` +
          `All TX/tune/keyer/DVR/power commands and outbound audio (0x01) are blocked client-side via K4.RxOnlyGate (Phase 2 TX extension hook).`;
      }
    }
  }

  K4.InspectorPanels = InspectorPanels;
})();
