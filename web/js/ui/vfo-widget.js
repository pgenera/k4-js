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
      this._freqHz = this.rx === 'A' ? 14074000 : 14025000;
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

      this.freqEl = document.createElement('div');
      this.freqEl.className = 'k4-vfo-freq';
      this.freqEl.dataset.testid = this.rx === 'A' ? 'vfo-a-freq' : 'vfo-b-freq';
      this.freqEl.title = 'Hover and scroll or click digit top/bottom to tune; double-click to jump';
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
        span.title = `Scroll or click top/bottom (±${formatStepLabel(step)})`;
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
          if (typeof window === 'undefined' || window.innerWidth >= 960) {
            this.onSelectTarget(this.rx);
          }
          const rect = span.getBoundingClientRect();
          const dir = rect.height > 0 && (e.clientY - rect.top) >= rect.height / 2 ? -1 : 1;
          const effStep = e.altKey ? 1 : step;
          this._tuneBy(dir * effStep);
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
      this.freqEl.appendChild(unit);
      root.appendChild(this.freqEl);

      root.addEventListener('click', (e) => {
        if (typeof window !== 'undefined' && window.innerWidth < 960) return;
        const tgt = e.target;
        if (
          tgt === root ||
          tgt === this.freqEl ||
          (tgt &&
            tgt.classList &&
            (tgt.classList.contains('k4-vfo-unit') ||
              tgt.classList.contains('k4-vfo-sep')))
        ) {
          this.onSelectTarget(this.rx);
        }
      });

      this.pillsEl = document.createElement('div');
      this.pillsEl.className = 'k4-vfo-pills';

      if (this.rx === 'B') {
        this.subBtn = document.createElement('button');
        this.subBtn.type = 'button';
        this.subBtn.className = 'k4-mini-pill k4-vfo-sub-btn is-amber';
        this.subBtn.textContent = 'SUB';
        this.subBtn.title = 'Toggle Sub Receiver (SB)';
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

      this.txBadge = document.createElement('span');
      this.txBadge.className = 'k4-tx-target-tag';
      this.txBadge.dataset.testid = this.rx === 'A' ? 'vfo-a-tx-badge' : 'vfo-b-tx-badge';
      this.txBadge.textContent = 'TX';
      this.txBadge.hidden = true;
      this.pillsEl.appendChild(this.txBadge);

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
      this.bwBtn.title = 'Open Filter & DSP controls';
      this.bwBtn.addEventListener('click', () => {
        this.onSelectTarget(this.rx);
        this.onOpenInspector('dsp');
      });
      this.pillsEl.appendChild(this.bwBtn);

      this.ritBadge = document.createElement('span');
      this.ritBadge.className = 'k4-vfo-rit-badge';
      this.ritBadge.dataset.testid = `vfo-${this.rx}-rit-badge`;
      this.ritBadge.textContent = 'RIT';
      this.ritBadge.hidden = true;
      this.pillsEl.appendChild(this.ritBadge);

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
      this.pillsEl.appendChild(this.lockBtn);

      root.appendChild(this.pillsEl);
    }

    _tuneBy(deltaHz) {
      if (this._locked) {
        this.onNotify(`VFO ${this.rx} is locked`, 'warn');
        return;
      }
      const nextHz = Math.max(100000, Math.min(54000000, Math.round(this._freqHz + deltaHz)));
      this.client.tune(this.rx, nextHz, { optimistically: true });
    }

    update(snapshot, targetRx, isMobileCompact) {
      const rxState = this.rx === 'A' ? snapshot.rxA : snapshot.rxB;
      if (!rxState) return;

      const freqHz = Math.max(0, Math.round(Number(rxState.freqHz) || 0));
      this._freqHz = freqHz;
      this._locked = Boolean(rxState.locked);
      this._subRxEnabled = Boolean(snapshot.subRxEnabled);

      const isTarget = targetRx === this.rx;
      if (this._lastCache.isTarget !== isTarget) {
        this.container.dataset.target = isTarget ? 'true' : 'false';
        this._lastCache.isTarget = isTarget;
      }

      if (isMobileCompact !== undefined) {
        const hideMobile = !isTarget;
        this.container.classList.toggle('k4-vfo--mobile-hidden', hideMobile);
      }

      if (this.rx === 'B') {
        this.container.dataset.subEnabled = this._subRxEnabled ? 'true' : 'false';
        if (this.subBtn && this._lastCache.sub !== this._subRxEnabled) {
          this.subBtn.classList.toggle('is-active', this._subRxEnabled);
          this._lastCache.sub = this._subRxEnabled;
        }
        const split = Boolean(snapshot.splitEnabled);
        if (this.splitBadge && this._lastCache.split !== split) {
          this.splitBadge.hidden = !split;
          this._lastCache.split = split;
        }
      }

      if (this.txBadge) {
        const split = Boolean(snapshot.splitEnabled);
        const txVfo = snapshot.activeTxVfo || (split ? 'B' : 'A');
        const isTxTarget = txVfo === this.rx;
        const txActive = Boolean(snapshot.txActive);
        const atuTuning = Boolean(snapshot.atuTuning);
        const posture = snapshot.txPosture || 'rx-only';
        const isTest = Boolean(snapshot.txTestMode || posture === 'tx-test');

        const showTxBadge = isTxTarget && (txActive || atuTuning || split || posture !== 'rx-only');
        let badgeText = split && this.rx === 'B' ? 'SPLIT TX' : 'TX';
        let badgeClass = 'k4-tx-target-tag';
        if (isTxTarget && atuTuning) {
          badgeText = 'ATU';
          badgeClass = 'k4-tx-target-tag is-tx-test';
        } else if (isTxTarget && txActive && isTest) {
          badgeText = 'TEST';
          badgeClass = 'k4-tx-target-tag is-tx-test';
        } else if (isTxTarget && txActive) {
          badgeText = 'TX';
          badgeClass = 'k4-tx-target-tag is-tx-live';
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

      const bwLabel = formatBwText(rxState.bwHz);
      if (this._lastCache.bw !== bwLabel) {
        this._lastCache.bw = bwLabel;
        this.bwBtn.textContent = bwLabel;
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
    }
  }

  K4.VfoWidget = VfoWidget;
})();
