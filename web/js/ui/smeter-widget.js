'use strict';
(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  function clamp(v, min, max) {
    return v < min ? min : (v > max ? max : v);
  }

  function formatSUnit(dBm) {
    if (K4.SpectrumScale && typeof K4.SpectrumScale.sUnitForDbm === 'function') {
      const res = K4.SpectrumScale.sUnitForDbm(dBm);
      if (typeof res === 'string') return res;
      if (res && typeof res.label === 'string') return res.label;
    }
    if (dBm <= -73) {
      const s = clamp(Math.round((dBm + 127) / 6), 0, 9);
      return `S${s}`;
    }
    const over = Math.max(1, Math.round(dBm + 73));
    return `S9+${over}`;
  }

  function dbmToPct(dBm) {
    return clamp(((dBm + 127) / 94) * 100, 0, 100);
  }

  class SMeterWidget {
    constructor(opts) {
      this.container = opts.container;
      this._peakDbm = -127;
      this._lastPeakAt = 0;
      this._lastText = '';
      this._lastPct = -1;
      this._lastSubPct = -1;
      this._lastSubVis = null;
      this._buildDom();
    }

    _buildDom() {
      const root = this.container;
      root.textContent = '';

      const head = document.createElement('div');
      head.className = 'k4-smeter-head';

      this.titleEl = document.createElement('span');
      this.titleEl.className = 'k4-smeter-title';
      this.titleEl.textContent = 'S-METER';
      head.appendChild(this.titleEl);

      this.ovfBadge = document.createElement('span');
      this.ovfBadge.className = 'k4-smeter-ovf';
      this.ovfBadge.dataset.testid = 'smeter-ovf-badge';
      this.ovfBadge.textContent = 'OVF';
      this.ovfBadge.title = 'ADC Overflow';
      this.ovfBadge.hidden = true;
      head.appendChild(this.ovfBadge);

      this.dbmEl = document.createElement('span');
      this.dbmEl.className = 'k4-smeter-dbm';
      this.dbmEl.dataset.testid = 'smeter-dbm';
      this.dbmEl.textContent = 'S2 · -115 dBm';
      head.appendChild(this.dbmEl);

      root.appendChild(head);

      const track = document.createElement('div');
      track.className = 'k4-smeter-track';

      const s9Mark = document.createElement('div');
      s9Mark.className = 'k4-smeter-s9-mark';
      s9Mark.title = 'S9 (-73 dBm)';
      track.appendChild(s9Mark);

      this.fillEl = document.createElement('div');
      this.fillEl.className = 'k4-smeter-fill';
      track.appendChild(this.fillEl);

      this.peakEl = document.createElement('div');
      this.peakEl.className = 'k4-smeter-peak';
      track.appendChild(this.peakEl);

      root.appendChild(track);

      this.subWrap = document.createElement('div');
      this.subWrap.className = 'k4-smeter-sub';
      this.subWrap.hidden = true;
      this.subFillEl = document.createElement('div');
      this.subFillEl.className = 'k4-smeter-sub-fill';
      this.subWrap.appendChild(this.subFillEl);
      root.appendChild(this.subWrap);

      const ticks = document.createElement('div');
      ticks.className = 'k4-smeter-ticks';
      const labels = ['S1', '3', '5', '7', '9', '+20', '+40'];
      for (let i = 0; i < labels.length; i++) {
        const sp = document.createElement('span');
        sp.textContent = labels[i];
        ticks.appendChild(sp);
      }
      root.appendChild(ticks);
    }

    update(snapshot, targetRx) {
      const rxA = snapshot.rxA || {};
      const rxB = snapshot.rxB || {};
      const useSubPrimary = targetRx === 'B' && snapshot.subRxEnabled;
      const primaryRx = useSubPrimary ? rxB : rxA;
      const primaryDbm = Number(primaryRx.sMeterDbm);
      const dbm = Number.isFinite(primaryDbm) ? primaryDbm : -115;

      const now = performance.now();
      if (dbm >= this._peakDbm) {
        this._peakDbm = dbm;
        this._lastPeakAt = now;
      } else {
        const dt = Math.max(0, (now - this._lastPeakAt) / 1000);
        if (dt > 0.35) {
          this._peakDbm = Math.max(dbm, this._peakDbm - dt * 18);
          this._lastPeakAt = now;
        }
      }

      const pct = Math.round(dbmToPct(dbm) * 10) / 10;
      const peakPct = Math.round(dbmToPct(this._peakDbm) * 10) / 10;
      if (this._lastPct !== pct) {
        this._lastPct = pct;
        this.fillEl.style.width = `${pct}%`;
      }
      this.peakEl.style.left = `${peakPct}%`;

      const ovf = Boolean(primaryRx.adcOverflow);
      if (this.ovfBadge && this.ovfBadge.hidden !== !ovf) {
        this.ovfBadge.hidden = !ovf;
      }

      const label = `${formatSUnit(dbm)} · ${Math.round(dbm)} dBm`;
      if (this._lastText !== label) {
        this._lastText = label;
        this.dbmEl.textContent = label;
      }

      const showSub = Boolean(snapshot.subRxEnabled);
      if (this._lastSubVis !== showSub) {
        this._lastSubVis = showSub;
        this.subWrap.hidden = !showSub;
      }
      if (showSub) {
        const subDbm = Number.isFinite(Number(rxB.sMeterDbm)) ? Number(rxB.sMeterDbm) : -115;
        const subPct = Math.round(dbmToPct(subDbm) * 10) / 10;
        if (this._lastSubPct !== subPct) {
          this._lastSubPct = subPct;
          this.subFillEl.style.width = `${subPct}%`;
        }
      }
    }
  }

  K4.SMeterWidget = SMeterWidget;
})();
