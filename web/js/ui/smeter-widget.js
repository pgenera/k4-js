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
      this._manualMode = null; // null = auto (TX when transmitting/tuning), 'tx', or 'rx'
      this._wasAutoTx = false;
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

      this.modeBtn = document.createElement('button');
      this.modeBtn.type = 'button';
      this.modeBtn.className = 'k4-meter-mode-btn';
      this.modeBtn.dataset.testid = 'meter-mode-toggle';
      this.modeBtn.textContent = 'TX';
      this.modeBtn.title = 'Inspect RX S-meter or TX meter cluster';
      this.modeBtn.addEventListener('click', () => {
        if (this._currentlyShowingTx) {
          this._manualMode = this._wasAutoTx ? 'rx' : null;
        } else {
          this._manualMode = 'tx';
        }
        if (this._lastSnapshot) {
          this.update(this._lastSnapshot, this._lastTargetRx);
        }
      });
      head.appendChild(this.modeBtn);

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

      this.txHeadTag = document.createElement('span');
      this.txHeadTag.className = 'k4-tx-meter-tag';
      this.txHeadTag.textContent = 'IDLE';
      this.txHeadTag.hidden = true;
      head.appendChild(this.txHeadTag);

      root.appendChild(head);

      this.rxBody = document.createElement('div');
      this.rxBody.className = 'k4-smeter-rx-pane';

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

      this.rxBody.appendChild(track);

      this.subWrap = document.createElement('div');
      this.subWrap.className = 'k4-smeter-sub';
      this.subWrap.hidden = true;
      this.subFillEl = document.createElement('div');
      this.subFillEl.className = 'k4-smeter-sub-fill';
      this.subWrap.appendChild(this.subFillEl);
      this.rxBody.appendChild(this.subWrap);

      const ticks = document.createElement('div');
      ticks.className = 'k4-smeter-ticks';
      const labels = ['S1', '3', '5', '7', '9', '+20', '+40'];
      for (let i = 0; i < labels.length; i++) {
        const sp = document.createElement('span');
        sp.textContent = labels[i];
        ticks.appendChild(sp);
      }
      this.rxBody.appendChild(ticks);
      root.appendChild(this.rxBody);

      // TX Meter Cluster (PWR, SWR, ALC 0..7 + sweet spot 4..5, CMP 0..30 dB)
      this.txCluster = document.createElement('div');
      this.txCluster.className = 'k4-tx-meter-cluster';
      this.txCluster.dataset.testid = 'tx-meter-cluster';
      this.txCluster.hidden = true;

      const grid = document.createElement('div');
      grid.className = 'k4-tx-meter-grid';

      const makeBarCell = (label, testId, fillClass, withSweetSpot) => {
        const cell = document.createElement('div');
        cell.className = 'k4-tx-bar-cell';
        cell.dataset.testid = testId;

        const meta = document.createElement('div');
        meta.className = 'k4-tx-bar-meta';
        const lbl = document.createElement('span');
        lbl.className = 'k4-tx-bar-lbl';
        lbl.textContent = label;
        const val = document.createElement('span');
        val.className = 'k4-tx-bar-val';
        val.textContent = '0';
        meta.appendChild(lbl);
        meta.appendChild(val);

        const barTrack = document.createElement('div');
        barTrack.className = 'k4-tx-bar-track';
        if (withSweetSpot) {
          const sweet = document.createElement('div');
          sweet.className = 'k4-tx-bar-sweet';
          sweet.title = 'ALC sweet spot (4-5 bars)';
          barTrack.appendChild(sweet);
        }
        const barFill = document.createElement('div');
        barFill.className = `k4-tx-bar-fill ${fillClass}`;
        barTrack.appendChild(barFill);

        cell.appendChild(meta);
        cell.appendChild(barTrack);
        grid.appendChild(cell);
        return { val, barFill };
      };

      this._txBars = {
        pwr: makeBarCell('PWR', 'tx-meter-pwr', 'k4-tx-bar-fill--pwr', false),
        swr: makeBarCell('SWR', 'tx-meter-swr', 'k4-tx-bar-fill--swr-ok', false),
        alc: makeBarCell('ALC', 'tx-meter-alc', 'k4-tx-bar-fill--alc', true),
        cmp: makeBarCell('CMP', 'tx-meter-cmp', 'k4-tx-bar-fill--cmp', false),
      };
      this.txCluster.appendChild(grid);
      root.appendChild(this.txCluster);
    }

    update(snapshot, targetRx) {
      this._lastSnapshot = snapshot;
      this._lastTargetRx = targetRx;

      const autoTx = Boolean(snapshot.txActive || snapshot.atuTuning);
      if (autoTx && !this._wasAutoTx && this._manualMode === 'rx') {
        this._manualMode = null;
      }
      if (!autoTx && this._wasAutoTx && this._manualMode === 'rx') {
        this._manualMode = null;
      }
      this._wasAutoTx = autoTx;

      const showTx = this._manualMode === 'tx' ? true : (this._manualMode === 'rx' ? false : autoTx);
      this._currentlyShowingTx = showTx;

      this.rxBody.hidden = showTx;
      this.dbmEl.hidden = showTx;
      this.txCluster.hidden = !showTx;
      this.txHeadTag.hidden = !showTx;
      this.titleEl.textContent = showTx ? 'TX METER' : 'S-METER';
      this.modeBtn.textContent = showTx ? 'RX' : 'TX';
      this.modeBtn.classList.toggle('is-tx', showTx);

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

      const ovf = !showTx && Boolean(primaryRx.adcOverflow);
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

      if (showTx) {
        const tm = snapshot.txMeters || {};
        const fwd = Math.max(0, Number(tm.fwdWatts) || 0);
        const swr = Number(tm.swr) >= 1.0 ? Number(tm.swr) : 1.0;
        const alc = Math.max(0, Math.min(7, Number(tm.alcBars) || 0));
        const cmp = Math.max(0, Math.min(30, Number(tm.compDb) || 0));
        const isTest = Boolean(snapshot.txTestMode || snapshot.txPosture === 'tx-test');

        if (snapshot.atuTuning) {
          this.txHeadTag.textContent = 'ATU TUNE';
          this.txHeadTag.className = 'k4-tx-meter-tag is-test';
        } else if (snapshot.txActive && isTest) {
          this.txHeadTag.textContent = 'TX TEST';
          this.txHeadTag.className = 'k4-tx-meter-tag is-test';
        } else if (snapshot.txActive) {
          this.txHeadTag.textContent = 'ON AIR';
          this.txHeadTag.className = 'k4-tx-meter-tag';
        } else {
          this.txHeadTag.textContent = 'STBY';
          this.txHeadTag.className = 'k4-tx-meter-tag';
        }

        const pwrScale = (snapshot.powerRange === 'L' || (Number(snapshot.powerWatts) || 0) <= 10) ? 10 : 110;
        const pwrPct = Math.max(0, Math.min(100, (fwd / pwrScale) * 100));
        this._txBars.pwr.val.textContent = isTest && snapshot.txActive
          ? '0.0W'
          : (fwd >= 10 ? `${fwd.toFixed(0)}W` : `${fwd.toFixed(1)}W`);
        this._txBars.pwr.barFill.style.width = `${pwrPct.toFixed(1)}%`;

        const swrPct = Math.max(0, Math.min(100, ((swr - 1.0) / 2.5) * 100));
        const swrClass = swr > 2.5
          ? 'k4-tx-bar-fill--swr-crit'
          : (swr > 1.5 ? 'k4-tx-bar-fill--swr-warn' : 'k4-tx-bar-fill--swr-ok');
        this._txBars.swr.val.textContent = `${swr.toFixed(2)}:1`;
        this._txBars.swr.barFill.className = `k4-tx-bar-fill ${swrClass}`;
        this._txBars.swr.barFill.style.width = `${swrPct.toFixed(1)}%`;

        const alcPct = (alc / 7) * 100;
        this._txBars.alc.val.textContent = `${Math.round(alc)}/7`;
        this._txBars.alc.barFill.className = `k4-tx-bar-fill ${alc > 5.5 ? 'k4-tx-bar-fill--alc-hot' : 'k4-tx-bar-fill--alc'}`;
        this._txBars.alc.barFill.style.width = `${alcPct.toFixed(1)}%`;

        const cmpPct = (cmp / 30) * 100;
        this._txBars.cmp.val.textContent = `${Math.round(cmp)}dB`;
        this._txBars.cmp.barFill.style.width = `${cmpPct.toFixed(1)}%`;
      }
    }
  }

  K4.SMeterWidget = SMeterWidget;
})();
