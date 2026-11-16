'use strict';
(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const MODE_FALLBACK = {
    1: 'LSB',
    2: 'USB',
    3: 'CW',
    4: 'FM',
    5: 'AM',
    6: 'DATA',
    7: 'CW-R',
    9: 'DATA-R',
  };

  const DATA_SUBMODE_FALLBACK = {
    0: 'DATA-A',
    1: 'AFSK-A',
    2: 'FSK-D',
    3: 'PSK-D',
  };

  const DIGIT_STEPS = [
    10000000,
    1000000,
    100000,
    10000,
    1000,
    100,
    10,
    1,
  ];

  function formatStepLabel(step) {
    if (step >= 1000000) return `${step / 1000000} MHz`;
    if (step >= 1000) return `${step / 1000} kHz`;
    return `${step} Hz`;
  }

  function formatModeText(rxState) {
    const modeCode = Number(rxState.mode) || 2;
    if (modeCode === 6 || modeCode === 9) {
      const subMap = K4.DATA_SUBMODES || DATA_SUBMODE_FALLBACK;
      const subLabel = subMap[rxState.dataSubMode] || 'DATA-A';
      return modeCode === 9 ? `${subLabel} R` : subLabel;
    }
    const modeInfo = K4.MODES && K4.MODES[modeCode];
    return (modeInfo && (modeInfo.label || modeInfo.key)) || MODE_FALLBACK[modeCode] || 'USB';
  }

  function findBandLabel(freqHz) {
    const bands = Array.isArray(K4.BANDS) ? K4.BANDS : [];
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      if (freqHz >= b.startHz && freqHz <= b.endHz) {
        return b.label || b.id;
      }
    }
    return 'GEN';
  }

  function formatBwText(bwHz) {
    const hz = Number(bwHz) || 2400;
    if (hz >= 1000) {
      const khz = (hz / 1000).toFixed(1).replace(/\.0$/, '');
      return `${khz}k`;
    }
    return `${hz}Hz`;
  }

  function computeFilterTrapezoidPoints(rxState, cwPitchHz, w, h) {
    const s = rxState || {};
    const mode = Number(s.mode) || 2;
    const bwHz = Math.max(50, Math.min(5000, Number(s.bwHz) || 2400));
    let shiftHz = 0;
    if (mode === 3 || mode === 7) {
      const nom = Number.isFinite(Number(cwPitchHz)) ? Number(cwPitchHz) : 500;
      shiftHz = (Number.isFinite(Number(s.ifShiftHz)) ? Number(s.ifShiftHz) : nom) - nom;
    } else if (mode === 1 || mode === 2 || mode === 6 || mode === 9) {
      const nom = 1500;
      shiftHz = (Number.isFinite(Number(s.ifShiftHz)) ? Number(s.ifShiftHz) : nom) - nom;
    }
    const maxHz = 4500;
    const topHalf = Math.max(2, Math.min(w * 0.42, (bwHz / maxHz) * (w * 0.72)));
    const skirt = Math.max(1.4, w * 0.08);
    const botHalf = Math.min(w * 0.48, topHalf + skirt);
    const rawCx = w * 0.5 + (shiftHz / maxHz) * (w * 0.55);
    const cx = Math.max(botHalf + 1, Math.min(w - botHalf - 1, rawCx));
    const topY = 2;
    const botY = h - 1.5;
    const points = `${(cx - botHalf).toFixed(1)},${botY} ${(cx - topHalf).toFixed(1)},${topY} ${(cx + topHalf).toFixed(1)},${topY} ${(cx + botHalf).toFixed(1)},${botY}`;
    return { points, cx, topY, botY };
  }

  K4.computeFilterTrapezoidPoints = computeFilterTrapezoidPoints;

  function mapDigitStepToVtIdx(digitStepHz) {
    if (digitStepHz <= 1) return 0;
    if (digitStepHz <= 10) return 1;
    if (digitStepHz <= 100) return 2;
    if (digitStepHz <= 1000) return 3;
    return 6; // 10 kHz max K4 VT step
  }

  function stepHzToDigitIndex(stepHz) {
    const hz = Number(stepHz) || 100;
    if (hz <= 1) return 7;
    if (hz <= 10) return 6;
    if (hz <= 100) return 5;
    if (hz <= 5000) return 4;
    if (hz <= 10000) return 3;
    if (hz <= 100000) return 2;
    if (hz <= 1000000) return 1;
    return 0;
  }

  function createLockIconSvg() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('aria-hidden', 'true');
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '3.5');
    rect.setAttribute('y', '7');
    rect.setAttribute('width', '9');
    rect.setAttribute('height', '6.5');
    rect.setAttribute('rx', '1.4');
    rect.setAttribute('fill', 'none');
    rect.setAttribute('stroke', 'currentColor');
    rect.setAttribute('stroke-width', '1.5');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linecap', 'round');
    svg.appendChild(rect);
    svg.appendChild(path);
    return svg;
  }

  class VfoWidget {
    constructor(opts) {
      this.container = opts.container;
      this.rx = opts.rx === 'B' ? 'B' : 'A';
      this.client = opts.client;
      this.onSelectTarget = opts.onSelectTarget || (() => {});
      this.onOpenInspector = opts.onOpenInspector || (() => {});
      this.onOpenOmnibar = opts.onOpenOmnibar || (() => {});
      this.onNotify = opts.onNotify || (() => {});

      this._lastCache = {};
      this._digitEls = [];
      this._locked = false;
      this._isTarget = this.rx === 'A';
      this._freqHz = this.rx === 'A' ? 14074000 : 14025000;
      this._lastBwHz = this.rx === 'A' ? 2700 : 500;
      this._subRxEnabled = false;

      this._buildDom();
    }

    _buildDom() {
      const root = this.container;
      root.dataset.rx = this.rx;
      root.dataset.target = this.rx === 'A' ? 'true' : 'false';
      root.textContent = '';

      this.badgeBtn = document.createElement('button');
      this.badgeBtn.type = 'button';
      this.badgeBtn.className = 'k4-vfo-badge';
      this.badgeBtn.dataset.rx = this.rx;
      this.badgeBtn.textContent = this.rx;
      this.badgeBtn.title = `Click to target VFO ${this.rx} for tuning`;
      this.badgeBtn.addEventListener('click', () => {
        this.onSelectTarget(this.rx);
      });
      root.appendChild(this.badgeBtn);

      this.bodyEl = document.createElement('div');
      this.bodyEl.className = 'k4-vfo-body';
      this.topRowEl = document.createElement('div');
      this.topRowEl.className = 'k4-vfo-top-row';

      this.freqEl = document.createElement('div');
      this.freqEl.className = 'k4-vfo-freq';
      this.freqEl.dataset.testid = this.rx === 'A' ? 'vfo-a-freq' : 'vfo-b-freq';
      this.freqEl.title = 'Scroll or click digit top/bottom to tune; right-click digit to set step; double-click to jump';
      this.freqEl.addEventListener('dblclick', (e) => {
        e.preventDefault();
        this.onOpenOmnibar();
      });

      const dotIndices = new Set([2, 5]);
      for (let i = 0; i < DIGIT_STEPS.length; i++) {
        if (dotIndices.has(i)) {
          const sep = document.createElement('span');
          sep.className = 'k4-vfo-sep';
          sep.textContent = '.';
          this.freqEl.appendChild(sep);
        }
        const step = DIGIT_STEPS[i];
        const span = document.createElement('span');
        span.className = 'k4-vfo-digit';
        span.tabIndex = 0;
        span.setAttribute('role', 'spinbutton');
        span.dataset.step = String(step);
        span.title = `Scroll/click ±${formatStepLabel(step)} · Right-click: set ${formatStepLabel(Math.min(step, 10000))} tuning step`;
        span.textContent = '0';

        span.addEventListener('wheel', (e) => {
          e.preventDefault();
          if (typeof window === 'undefined' || window.innerWidth >= 960) {
            this.onSelectTarget(this.rx);
          }
          const dir = e.deltaY < 0 ? 1 : -1;
          const mult = e.shiftKey ? 10 : 1;
          const effStep = e.altKey ? 1 : step * mult;
          this._tuneBy(dir * effStep);
        }, { passive: false });

        span.addEventListener('click', (e) => {
          if (typeof window !== 'undefined' && window.innerWidth < 960 && !this._isTarget) {
            e.stopPropagation();
            this.onSelectTarget(this.rx);
            return;
          }
          if (typeof window === 'undefined' || window.innerWidth >= 960) {
            this.onSelectTarget(this.rx);
          }
          const rect = span.getBoundingClientRect();
          const dir = rect.height > 0 && (e.clientY - rect.top) >= rect.height / 2 ? -1 : 1;
          const effStep = e.altKey ? 1 : step;
          this._tuneBy(dir * effStep);
        });

        span.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.onSelectTarget(this.rx);
          const stepIdx = mapDigitStepToVtIdx(step);
          if (this.client && typeof this.client.setStep === 'function') {
            this.client.setStep(this.rx, stepIdx);
          } else if (this.client && typeof this.client.sendCat === 'function') {
            this.client.sendCat(`VT${this.rx === 'B' ? '$' : ''}${stepIdx};`);
          }
        });

        span.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            this._tuneBy(e.altKey ? 1 : step);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            this._tuneBy(-(e.altKey ? 1 : step));
          }
        });

        this._digitEls.push(span);
        this.freqEl.appendChild(span);
      }

      const unit = document.createElement('span');
      unit.className = 'k4-vfo-unit';
      unit.textContent = 'MHz';
      unit.title = 'Click MHz unit to open Quick Jump & Bookmarks';
      unit.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onSelectTarget(this.rx);
        this.onOpenOmnibar();
      });
      this.freqEl.appendChild(unit);
      this.topRowEl.appendChild(this.freqEl);

      root.addEventListener('click', (e) => {
        const tgt = e.target;
        if (typeof window !== 'undefined' && window.innerWidth < 960) {
          if (!this._isTarget && !(tgt && tgt.closest && tgt.closest('button'))) {
            this.onSelectTarget(this.rx);
          }
          return;
        }
        if (
          tgt === root ||
          tgt === this.bodyEl ||
          tgt === this.topRowEl ||
          tgt === this.freqEl ||
          tgt === this.pillsEl ||
          (tgt &&
            tgt.classList &&
            (tgt.classList.contains('k4-vfo-unit') ||
              tgt.classList.contains('k4-vfo-sep')))
        ) {
          this.onSelectTarget(this.rx);
        }
      });

      this.txBadge = document.createElement('span');
      this.txBadge.className = 'k4-tx-target-tag';
      this.txBadge.dataset.testid = this.rx === 'A' ? 'vfo-a-tx-badge' : 'vfo-b-tx-badge';
      this.txBadge.textContent = 'TX';
      this.txBadge.hidden = true;
      this.topRowEl.appendChild(this.txBadge);

      this.ritBadge = document.createElement('span');
      this.ritBadge.className = 'k4-vfo-rit-badge';
      this.ritBadge.dataset.testid = `vfo-${this.rx}-rit-badge`;
      this.ritBadge.textContent = 'RIT';
      this.ritBadge.hidden = true;
      this.topRowEl.appendChild(this.ritBadge);

      this.lockBtn = document.createElement('button');
      this.lockBtn.type = 'button';
      this.lockBtn.className = 'k4-mini-pill k4-vfo-lock';
      this.lockBtn.title = `Lock/unlock VFO ${this.rx}`;
      this.lockBtn.appendChild(createLockIconSvg());
      this.lockBtn.addEventListener('click', () => {
        const next = !this._locked;
        if (typeof this.client.setLock === 'function') {
          this.client.setLock(this.rx, next);
        } else {
          const cmd = K4.CatCodec && K4.CatCodec.builders && K4.CatCodec.builders.lock
            ? K4.CatCodec.builders.lock(this.rx, next)
            : `LK${this.rx === 'B' ? '$' : ''}${next ? '1' : '0'};`;
          this.client.sendCat(cmd);
        }
      });
      this.topRowEl.appendChild(this.lockBtn);
      this.bodyEl.appendChild(this.topRowEl);

      this.pillsEl = document.createElement('div');
      this.pillsEl.className = 'k4-vfo-pills';

      if (this.rx === 'B') {
        this.subBtn = document.createElement('button');
        this.subBtn.type = 'button';
        this.subBtn.className = 'k4-mini-pill k4-vfo-sub-btn is-vfo-b is-amber';
        this.subBtn.textContent = 'SUB';
        this.subBtn.title = 'Toggle Sub Receiver';
        this.subBtn.addEventListener('click', () => {
          const next = !this._subRxEnabled;
          if (typeof this.client.setSubRx === 'function') {
            this.client.setSubRx(next);
          } else {
            const cmd = K4.CatCodec && K4.CatCodec.builders && K4.CatCodec.builders.subRx
              ? K4.CatCodec.builders.subRx(next)
              : `SB${next ? '1' : '0'};`;
            this.client.sendCat(cmd);
          }
        });
        this.pillsEl.appendChild(this.subBtn);

        this.splitBadge = document.createElement('span');
        this.splitBadge.className = 'k4-split-tag';
        this.splitBadge.textContent = 'SPLIT';
        this.splitBadge.title = 'Split active: transmitting on VFO B';
        this.splitBadge.hidden = true;
        this.pillsEl.appendChild(this.splitBadge);
      }

      this.bandBtn = document.createElement('button');
      this.bandBtn.type = 'button';
      this.bandBtn.className = 'k4-mini-pill k4-vfo-band';
      this.bandBtn.title = 'Open Band & Mode controls';
      this.bandBtn.addEventListener('click', () => {
        this.onSelectTarget(this.rx);
        this.onOpenInspector('band-mode');
      });
      this.pillsEl.appendChild(this.bandBtn);

      this.modeBtn = document.createElement('button');
      this.modeBtn.type = 'button';
      this.modeBtn.className = 'k4-mini-pill k4-vfo-mode';
      this.modeBtn.dataset.testid = this.rx === 'A' ? 'vfo-a-mode' : 'vfo-b-mode';
      this.modeBtn.title = 'Open Mode controls';
      this.modeBtn.addEventListener('click', () => {
        this.onSelectTarget(this.rx);
        this.onOpenInspector('band-mode');
      });
      this.pillsEl.appendChild(this.modeBtn);

      this.bwBtn = document.createElement('button');
      this.bwBtn.type = 'button';
      this.bwBtn.className = 'k4-mini-pill k4-vfo-bw';
      this.bwBtn.title = 'Click to open DSP · Scroll wheel to adjust filter width';
      const svgNs = 'http://www.w3.org/2000/svg';
      this.bwTrapSvg = document.createElementNS(svgNs, 'svg');
      this.bwTrapSvg.setAttribute('viewBox', '0 0 22 11');
      this.bwTrapSvg.setAttribute('class', 'k4-vfo-trap-svg');
      this.bwTrapSvg.dataset.testid = this.rx === 'A' ? 'vfo-a-filter-trapezoid' : 'vfo-b-filter-trapezoid';
      this.bwTrapSvg.setAttribute('aria-hidden', 'true');
      const centerMark = document.createElementNS(svgNs, 'line');
      centerMark.setAttribute('x1', '11');
      centerMark.setAttribute('y1', '1');
      centerMark.setAttribute('x2', '11');
      centerMark.setAttribute('y2', '10');
      centerMark.setAttribute('class', 'k4-vfo-trap-center');
      this.bwTrapPoly = document.createElementNS(svgNs, 'polygon');
      this.bwTrapPoly.setAttribute('class', 'k4-vfo-trap-poly');
      this.bwTrapPoly.setAttribute('points', '3,9.5 6,2 16,2 19,9.5');
      this.bwTrapSvg.appendChild(centerMark);
      this.bwTrapSvg.appendChild(this.bwTrapPoly);
      this.bwTextEl = document.createElement('span');
      this.bwTextEl.className = 'k4-vfo-bw-text';
      this.bwTextEl.textContent = '2.7k';
      this.bwBtn.appendChild(this.bwTrapSvg);
      this.bwBtn.appendChild(this.bwTextEl);
      this.bwBtn.addEventListener('click', () => {
        this.onSelectTarget(this.rx);
        this.onOpenInspector('dsp');
      });
      this.bwBtn.addEventListener('wheel', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.onSelectTarget(this.rx);
        const cur = Number(this._lastBwHz) || 2400;
        const stepBw = cur < 1000 ? 50 : 100;
        const dir = e.deltaY < 0 ? 1 : -1;
        const nextBw = Math.max(50, Math.min(4000, Math.round((cur + dir * stepBw) / 50) * 50));
        if (nextBw === cur) return;
        this._lastBwHz = nextBw;
        if (this.client && typeof this.client.setFilter === 'function') {
          this.client.setFilter(this.rx, { bwHz: nextBw });
        } else if (this.client && typeof this.client.sendCat === 'function') {
          const cmd = K4.CatCodec && K4.CatCodec.builders && K4.CatCodec.builders.bw
            ? K4.CatCodec.builders.bw(this.rx, nextBw)
            : `BW${this.rx === 'B' ? '$' : ''}${String(Math.round(nextBw / 10)).padStart(4, '0')};`;
          this.client.sendCat(cmd);
        }
      }, { passive: false });
      this.pillsEl.appendChild(this.bwBtn);

      this.dspFlagsEl = document.createElement('span');
      this.dspFlagsEl.className = 'k4-vfo-dsp-flags';
      this._dspFlagEls = {};
      for (const flagKey of ['PRE', 'ATT', 'NB', 'NR', 'APF', 'NTCH']) {
        const tag = document.createElement('span');
        tag.className = 'k4-vfo-dsp-tag';
        tag.dataset.flag = flagKey;
        tag.textContent = flagKey;
        tag.hidden = true;
        this.dspFlagsEl.appendChild(tag);
        this._dspFlagEls[flagKey] = tag;
      }
      this.pillsEl.appendChild(this.dspFlagsEl);

      this.bodyEl.appendChild(this.pillsEl);
      root.appendChild(this.bodyEl);
    }

    _tuneBy(deltaHz) {
      if (this._locked) {
        this.onNotify(`VFO ${this.rx} is locked`, 'warn');
        return;
      }
      const nextHz = Math.max(100000, Math.min(54000000, Math.round(this._freqHz + deltaHz)));
      this.client.tune(this.rx, nextHz, { optimistically: true });
    }

    update(snapshot, targetRx) {
      const rxState = this.rx === 'A' ? snapshot.rxA : snapshot.rxB;
      if (!rxState) return;

      const freqHz = Math.max(0, Math.round(Number(rxState.freqHz) || 0));
      this._freqHz = freqHz;
      this._locked = Boolean(rxState.locked);
      this._subRxEnabled = Boolean(snapshot.subRxEnabled);

      const isTarget = targetRx === this.rx;
      this._isTarget = isTarget;
      if (this._lastCache.isTarget !== isTarget) {
        this.container.dataset.target = isTarget ? 'true' : 'false';
        this._lastCache.isTarget = isTarget;
      }

      if (this.rx === 'B') {
        this.container.dataset.subEnabled = this._subRxEnabled ? 'true' : 'false';
        if (this.subBtn && this._lastCache.sub !== this._subRxEnabled) {
          this.subBtn.classList.toggle('is-active', this._subRxEnabled);
          this._lastCache.sub = this._subRxEnabled;
        }
        const split = Boolean(snapshot.splitEnabled);
        if (this.splitBadge && this._lastCache.split !== split) {
          // Keep single crisp TX pill (txBadge) instead of redundant SPLIT + SPLIT TX badges
          this.splitBadge.hidden = true;
          this._lastCache.split = split;
        }
      }

      if (this.txBadge) {
        const split = Boolean(snapshot.splitEnabled);
        const txVfo = snapshot.activeTxVfo || (split ? 'B' : 'A');
        const isTxTarget = txVfo === this.rx;
        const txActive = Boolean(snapshot.txActive);
        const atuTuning = Boolean(snapshot.atuTuning);
        const isTest = Boolean(snapshot.txTestMode || snapshot.txPosture === 'tx-test');

        this.container.dataset.txTarget = isTxTarget ? 'true' : 'false';
        this.container.dataset.split = split ? 'true' : 'false';

        const showTxBadge = isTxTarget && (txActive || atuTuning || isTest || split);
        let badgeText = 'TX';
        let badgeClass = 'k4-tx-target-tag';
        if (isTxTarget && atuTuning) {
          badgeText = 'ATU';
          badgeClass = 'k4-tx-target-tag is-tx-test';
        } else if (isTxTarget && isTest) {
          badgeText = 'TX Test';
          badgeClass = 'k4-tx-target-tag is-tx-test';
        } else if (isTxTarget && txActive) {
          badgeText = 'TX';
          badgeClass = 'k4-tx-target-tag is-tx-live';
        } else if (isTxTarget && split) {
          badgeText = 'TX';
          badgeClass = 'k4-tx-target-tag is-split-tx';
        }

        this.txBadge.hidden = !showTxBadge;
        if (showTxBadge) {
          this.txBadge.textContent = badgeText;
          this.txBadge.className = badgeClass;
        }
        this.container.classList.toggle('is-transmitting', Boolean(isTxTarget && (txActive || atuTuning)));
      }

      if (this._lastCache.freqHz !== freqHz) {
        this._lastCache.freqHz = freqHz;
        this.freqEl.dataset.freqHz = String(freqHz);
        const padded = String(freqHz).padStart(8, '0').slice(-8);
        for (let i = 0; i < 8; i++) {
          const el = this._digitEls[i];
          const ch = padded[i];
          if (i === 0) {
            el.hidden = freqHz < 10000000;
          }
          if (el.textContent !== ch) {
            el.textContent = ch;
          }
          el.classList.toggle('k4-vfo-digit--dim', i === 1 && freqHz < 1000000);
        }
      }

      const stepDigitIdx = stepHzToDigitIndex(rxState.stepHz);
      if (this._lastCache.stepDigitIdx !== stepDigitIdx) {
        this._lastCache.stepDigitIdx = stepDigitIdx;
        for (let i = 0; i < 8; i++) {
          const el = this._digitEls[i];
          const active = i === stepDigitIdx;
          el.classList.toggle('is-step-digit', active);
          el.dataset.stepActive = active ? 'true' : 'false';
        }
      }

      if (this._lastCache.locked !== this._locked) {
        this._lastCache.locked = this._locked;
        this.freqEl.dataset.locked = this._locked ? 'true' : 'false';
        this.lockBtn.classList.toggle('is-locked', this._locked);
        this.lockBtn.setAttribute('aria-pressed', this._locked ? 'true' : 'false');
      }

      const bandLabel = findBandLabel(freqHz);
      if (this._lastCache.band !== bandLabel) {
        this._lastCache.band = bandLabel;
        this.bandBtn.textContent = bandLabel;
      }

      const modeLabel = formatModeText(rxState);
      if (this._lastCache.mode !== modeLabel) {
        this._lastCache.mode = modeLabel;
        this.modeBtn.textContent = modeLabel;
      }

      const bwHzNum = Number(rxState.bwHz) || 2400;
      this._lastBwHz = bwHzNum;
      const bwLabel = formatBwText(bwHzNum);
      if (this._lastCache.bw !== bwLabel) {
        this._lastCache.bw = bwLabel;
        if (this.bwTextEl) this.bwTextEl.textContent = bwLabel;
        else this.bwBtn.textContent = bwLabel;
      }
      if (this.bwTrapPoly) {
        const trapSig = `${bwHzNum}:${rxState.ifShiftHz ?? ''}:${rxState.mode ?? ''}:${snapshot.cwPitchHz ?? ''}`;
        if (this._lastCache.trapSig !== trapSig) {
          this._lastCache.trapSig = trapSig;
          const geom = computeFilterTrapezoidPoints(rxState, snapshot.cwPitchHz, 22, 11);
          this.bwTrapPoly.setAttribute('points', geom.points);
        }
      }

      const ritOn = Boolean(rxState.ritOn);
      const ritHz = Math.round(Number(rxState.ritOffsetHz) || 0);
      const ritText = ritHz === 0 ? 'RIT 0' : `RIT ${ritHz > 0 ? `+${ritHz}` : ritHz}`;
      if (this._lastCache.ritOn !== ritOn || this._lastCache.ritText !== ritText) {
        this._lastCache.ritOn = ritOn;
        this._lastCache.ritText = ritText;
        this.ritBadge.hidden = !ritOn;
        this.ritBadge.textContent = ritText;
      }

      if (this._dspFlagEls) {
        const flags = {
          PRE: Number(rxState.preamp) > 0,
          ATT: Number(rxState.attenDb) > 0,
          NB: Boolean(rxState.nbOn),
          NR: Boolean(rxState.nrOn),
          APF: Boolean(rxState.apfOn),
          NTCH: Boolean(rxState.notchOn),
        };
        const flagSig = `${flags.PRE ? 1 : 0}${flags.ATT ? 1 : 0}${flags.NB ? 1 : 0}${flags.NR ? 1 : 0}${flags.APF ? 1 : 0}${flags.NTCH ? 1 : 0}`;
        if (this._lastCache.flagSig !== flagSig) {
          this._lastCache.flagSig = flagSig;
          for (const key of Object.keys(this._dspFlagEls)) {
            this._dspFlagEls[key].hidden = !flags[key];
          }
        }
      }
    }
  }

  K4.VfoWidget = VfoWidget;
})();
