'use strict';
(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const S_TICK_LABELS = ['S1', '3', '5', '7', '9', '+20', '+40'];
  const PEAK_HOLD_MS = 350;
  const PEAK_DECAY_DB_PER_SEC = 18;

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

  function stepPeak(now, dbm, peakState) {
    if (dbm >= peakState.peakDbm) {
      peakState.peakDbm = dbm;
      peakState.peakAt = now;
      peakState.lastDecayAt = now;
      return peakState.peakDbm;
    }
    if (now - peakState.peakAt >= PEAK_HOLD_MS) {
      const decayStart = Math.max(peakState.lastDecayAt, peakState.peakAt + PEAK_HOLD_MS);
      const decayDt = Math.max(0, (now - decayStart) / 1000);
      if (decayDt > 0) {
        peakState.peakDbm = Math.max(dbm, peakState.peakDbm - decayDt * PEAK_DECAY_DB_PER_SEC);
      }
    }
    peakState.lastDecayAt = now;
    return peakState.peakDbm;
  }

  function createDbmReadout(testId) {
    const el = document.createElement('span');
    el.className = 'k4-smeter-dbm';
    el.dataset.testid = testId;

    const sunitEl = document.createElement('span');
    sunitEl.className = 'k4-smeter-sunit';
    sunitEl.textContent = 'S2';

    const sepEl = document.createElement('span');
    sepEl.className = 'k4-smeter-sep';
    sepEl.textContent = ' · ';

    const dbmNumEl = document.createElement('span');
    dbmNumEl.className = 'k4-smeter-dbm-num';
    dbmNumEl.textContent = '-115 dBm';

    el.appendChild(sunitEl);
    el.appendChild(sepEl);
    el.appendChild(dbmNumEl);
    return { el, sunitEl, sepEl, dbmNumEl };
  }

  function createTicks() {
    const ticks = document.createElement('div');
    ticks.className = 'k4-smeter-ticks';
    for (let i = 0; i < S_TICK_LABELS.length; i++) {
      const sp = document.createElement('span');
      sp.textContent = S_TICK_LABELS[i];
      if (i >= 4) sp.className = 'k4-smeter-tick-hi';
      ticks.appendChild(sp);
    }
    return ticks;
  }

  class SMeterWidget {
    constructor(opts) {
      this.container = opts.container;
      this.onToggleMiniPan = typeof opts.onToggleMiniPan === 'function' ? opts.onToggleMiniPan : null;
      this._peakStateA = { peakDbm: -127, peakAt: 0, lastDecayAt: 0 };
      this._peakStateB = { peakDbm: -127, peakAt: 0, lastDecayAt: 0 };
      this._peakDbm = -127;
      this._peakDbmB = -127;
      this._peakRaf = 0;
      this._currentlyShowingTx = false;
      this._showingDualRx = false;
      this._buildDom();
    }

    _createRxBlock(rx) {
      const isB = rx === 'B';
      const suffix = isB ? 'b' : 'a';

      const root = document.createElement('div');
      root.className = `k4-smeter-block k4-smeter-block-${suffix}`;
      root.dataset.testid = isB ? 'smeter-block-b' : 'smeter-block-a';
      if (isB) root.hidden = true;

      const head = document.createElement('div');
      head.className = 'k4-smeter-head';

      const badgeEl = document.createElement('span');
      badgeEl.className = `k4-smeter-vfo-badge k4-smeter-vfo-badge--${suffix}`;
      badgeEl.textContent = rx;
      head.appendChild(badgeEl);

      const ovfBadge = document.createElement('span');
      ovfBadge.className = 'k4-smeter-ovf';
      ovfBadge.dataset.testid = isB ? 'smeter-b-ovf-badge' : 'smeter-ovf-badge';
      ovfBadge.textContent = 'OVF';
      ovfBadge.title = isB ? 'Sub RX ADC Overflow' : 'ADC Overflow';
      ovfBadge.hidden = true;
      head.appendChild(ovfBadge);

      const readout = createDbmReadout(isB ? 'smeter-b-dbm' : 'smeter-dbm');
      head.appendChild(readout.el);
      root.appendChild(head);

      const track = document.createElement('div');
      track.className = 'k4-smeter-track';
      track.title = `Click meter to toggle Mini-Pan ${rx}`;

      const s9Mark = document.createElement('div');
      s9Mark.className = 'k4-smeter-s9-mark';
      s9Mark.title = 'S9 (-73 dBm)';
      track.appendChild(s9Mark);

      const fillEl = document.createElement('div');
      fillEl.className = `k4-smeter-fill k4-smeter-fill--${suffix}`;
      track.appendChild(fillEl);

      const peakEl = document.createElement('div');
      peakEl.className = 'k4-smeter-peak';
      track.appendChild(peakEl);

      root.appendChild(track);
      root.appendChild(createTicks());

      root.title = `Click meter to toggle Mini-Pan ${rx}`;
      root.addEventListener('click', (e) => {
        if (e.target && typeof e.target.closest === 'function' && e.target.closest('button')) {
          return;
        }
        if (this.onToggleMiniPan) {
          this.onToggleMiniPan(rx);
        }
      });

      return {
        root,
        head,
        badgeEl,
        ovfBadge,
        dbmEl: readout.el,
        sunitEl: readout.sunitEl,
        dbmNumEl: readout.dbmNumEl,
        fillEl,
        peakEl,
        lastDbm: -115,
        lastPct: -1,
        lastPeakPct: -1,
        lastTextKey: '',
        lastOvf: false,
      };
    }

    _buildDom() {
      const root = this.container;
      root.textContent = '';

      this.txVfoEl =
        typeof document !== 'undefined'
          ? document.querySelector('[data-testid="k4-tx-vfo-indicator"]')
          : null;
      if (!this.txVfoEl) {
        this.txVfoEl = document.createElement('span');
        this.txVfoEl.className = 'k4-tx-vfo-ind';
        this.txVfoEl.dataset.testid = 'k4-tx-vfo-indicator';
        this.txVfoEl.dataset.state = 'standby';
        this.txVfoEl.textContent = '◀ TX';
      }

      this.blocksWrap = document.createElement('div');
      this.blocksWrap.className = 'k4-smeter-blocks';

      this._blockA = this._createRxBlock('A');
      this._blockB = this._createRxBlock('B');

      // Preserve direct property references for existing callers/tests
      this.ovfBadge = this._blockA.ovfBadge;
      this.dbmEl = this._blockA.dbmEl;
      this.fillEl = this._blockA.fillEl;
      this.peakEl = this._blockA.peakEl;
      this.ovfBadgeB = this._blockB.ovfBadge;
      this.dbmElB = this._blockB.dbmEl;
      this.fillElB = this._blockB.fillEl;
      this.peakElB = this._blockB.peakEl;

      // TX Meter Cluster (PWR, SWR, ALC 0..7 + sweet spot 4..5, CMP 0..30 dB)
      this.txCluster = document.createElement('div');
      this.txCluster.className = 'k4-tx-meter-cluster';
      this.txCluster.dataset.testid = 'tx-meter-cluster';
      this.txCluster.hidden = true;

      this.txHead = document.createElement('div');
      this.txHead.className = 'k4-tx-meter-head';

      this.txHeadVfoBadge = document.createElement('span');
      this.txHeadVfoBadge.className = 'k4-smeter-vfo-badge k4-smeter-vfo-badge--tx';
      this.txHeadVfoBadge.textContent = 'TX A';
      this.txHead.appendChild(this.txHeadVfoBadge);

      this.txHeadTag = document.createElement('span');
      this.txHeadTag.className = 'k4-tx-meter-tag';
      this.txHeadTag.textContent = 'IDLE';
      this.txHead.appendChild(this.txHeadTag);
      this.txCluster.appendChild(this.txHead);

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

      this.blocksWrap.appendChild(this._blockA.root);
      this.blocksWrap.appendChild(this._blockB.root);
      this.blocksWrap.appendChild(this.txCluster);
      root.appendChild(this.blocksWrap);
    }

    _updateRxBlock(block, rxState, now, peakState, allowOvf) {
      const rawDbm = Number(rxState.sMeterDbm);
      const dbm = Number.isFinite(rawDbm) ? rawDbm : -115;
      block.lastDbm = dbm;

      const peakDbm = stepPeak(now, dbm, peakState);
      const pct = Math.round(dbmToPct(dbm) * 10) / 10;
      const peakPct = Math.round(dbmToPct(peakDbm) * 10) / 10;

      if (block.lastPct !== pct) {
        block.lastPct = pct;
        block.fillEl.style.width = `${pct}%`;
      }
      if (block.lastPeakPct !== peakPct) {
        block.lastPeakPct = peakPct;
        block.peakEl.style.left = `${peakPct}%`;
      }

      const ovf = allowOvf && Boolean(rxState.adcOverflow);
      if (block.lastOvf !== ovf) {
        block.lastOvf = ovf;
        block.ovfBadge.hidden = !ovf;
      }

      const sText = formatSUnit(dbm);
      const dText = `${Math.round(dbm)} dBm`;
      const textKey = `${sText}|${dText}`;
      if (block.lastTextKey !== textKey) {
        block.lastTextKey = textKey;
        block.sunitEl.textContent = sText;
        block.dbmNumEl.textContent = dText;
      }
    }

    _schedulePeakTick() {
      if (this._peakRaf || typeof requestAnimationFrame !== 'function') return;
      this._peakRaf = requestAnimationFrame(() => {
        this._peakRaf = 0;
        this._tickPeaks();
      });
    }

    _cancelPeakTick() {
      if (this._peakRaf && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this._peakRaf);
      }
      this._peakRaf = 0;
    }

    _tickPeaks() {
      const now = performance.now();
      let needsMore = false;

      if (!this._blockA.root.hidden) {
        const peakA = stepPeak(now, this._blockA.lastDbm, this._peakStateA);
        this._peakDbm = peakA;
        const peakPctA = Math.round(dbmToPct(peakA) * 10) / 10;
        if (this._blockA.lastPeakPct !== peakPctA) {
          this._blockA.lastPeakPct = peakPctA;
          this._blockA.peakEl.style.left = `${peakPctA}%`;
        }
        if (peakA > this._blockA.lastDbm + 0.05) {
          needsMore = true;
        }
      }

      if (!this._blockB.root.hidden) {
        const peakB = stepPeak(now, this._blockB.lastDbm, this._peakStateB);
        this._peakDbmB = peakB;
        const peakPctB = Math.round(dbmToPct(peakB) * 10) / 10;
        if (this._blockB.lastPeakPct !== peakPctB) {
          this._blockB.lastPeakPct = peakPctB;
          this._blockB.peakEl.style.left = `${peakPctB}%`;
        }
        if (peakB > this._blockB.lastDbm + 0.05) {
          needsMore = true;
        }
      }

      if (needsMore) {
        this._schedulePeakTick();
      }
    }

    update(snapshot, targetRx) {
      this._lastSnapshot = snapshot;
      this._lastTargetRx = targetRx;

      const showTx = Boolean(snapshot.txActive || snapshot.atuTuning || snapshot.isTransmitting);
      this._currentlyShowingTx = showTx;

      const split = Boolean(snapshot.splitEnabled);
      const subOn = Boolean(snapshot.subRxEnabled);
      const showBlockA = !showTx || split;
      const showBlockB = subOn && !(showTx && split);
      const showDualRx = subOn && !showTx;
      this._showingDualRx = showDualRx;

      this.blocksWrap.hidden = false;
      this.container.classList.toggle('is-dual-rx', showDualRx || (showTx && !split && subOn));
      this.container.classList.toggle('is-tx-split', showTx && split);
      this.container.classList.toggle('is-tx-main', showTx && !split);

      this._blockA.root.hidden = !showBlockA;
      this._blockB.root.hidden = !showBlockB;
      this.txCluster.hidden = !showTx;

      this._blockA.root.classList.toggle('is-target', (showBlockA && showBlockB) && targetRx !== 'B');
      this._blockB.root.classList.toggle('is-target', showBlockB && targetRx === 'B');

      const isTestHead = Boolean(snapshot.txTestMode || snapshot.txPosture === 'tx-test');
      let txIndText = split ? 'TX ▶' : '◀ TX';
      let txIndState = 'standby';
      if (snapshot.txInhibit) {
        txIndText = split ? 'TX Inhibit ▶' : '◀ TX Inhibit';
        txIndState = 'inhibit';
      } else if (isTestHead) {
        txIndText = split ? 'TX Test ▶' : '◀ TX Test';
        txIndState = 'test';
      } else if (snapshot.atuTuning) {
        txIndText = split ? 'ATU ▶' : '◀ ATU';
        txIndState = 'atu';
      } else if (snapshot.txActive) {
        txIndText = split ? 'TX ▶' : '◀ TX';
        txIndState = 'live';
      }
      if (this.txVfoEl) {
        this.txVfoEl.textContent = txIndText;
        this.txVfoEl.dataset.state = txIndState;
        this.txVfoEl.dataset.keyed = snapshot.txActive ? 'true' : 'false';
        this.txVfoEl.title = `Active TX VFO: VFO ${split ? 'B (SPLIT)' : 'A'}${isTestHead ? ' · TX Test (RF output inhibited)' : ''}`;
      }

      const rxA = snapshot.rxA || {};
      const rxB = snapshot.rxB || {};
      const now = performance.now();

      if (showBlockA) {
        this._updateRxBlock(this._blockA, rxA, now, this._peakStateA, true);
        this._peakDbm = this._peakStateA.peakDbm;
      } else {
        this._peakDbm = stepPeak(
          now,
          Number.isFinite(Number(rxA.sMeterDbm)) ? Number(rxA.sMeterDbm) : -115,
          this._peakStateA
        );
      }

      if (showBlockB) {
        this._updateRxBlock(this._blockB, rxB, now, this._peakStateB, true);
        this._peakDbmB = this._peakStateB.peakDbm;
      } else {
        if (this._blockB.lastOvf) {
          this._blockB.lastOvf = false;
          this._blockB.ovfBadge.hidden = true;
        }
        this._peakDbmB = stepPeak(
          now,
          Number.isFinite(Number(rxB.sMeterDbm)) ? Number(rxB.sMeterDbm) : -115,
          this._peakStateB
        );
      }

      const needsTickA = showBlockA && this._peakStateA.peakDbm > this._blockA.lastDbm + 0.05;
      const needsTickB = showBlockB && this._peakStateB.peakDbm > this._blockB.lastDbm + 0.05;
      if (needsTickA || needsTickB) {
        this._schedulePeakTick();
      } else if (showTx && !showBlockA && !showBlockB) {
        this._cancelPeakTick();
      }

      if (showTx) {
        const tm = snapshot.txMeters || {};
        const fwd = Math.max(0, Number(tm.fwdWatts) || 0);
        const swr = Number(tm.swr) >= 1.0 ? Number(tm.swr) : 1.0;
        const alc = Math.max(0, Math.min(7, Number(tm.alcBars) || 0));
        const cmp = Math.max(0, Math.min(30, Number(tm.compDb) || 0));
        const isTest = Boolean(snapshot.txTestMode || snapshot.txPosture === 'tx-test');

        if (this.txHeadVfoBadge) {
          this.txHeadVfoBadge.textContent = split ? 'TX B' : 'TX A';
        }

        if (snapshot.atuTuning) {
          this.txHeadTag.textContent = 'ATU TUNE';
          this.txHeadTag.className = 'k4-tx-meter-tag is-test';
        } else if (snapshot.txActive && isTest) {
          this.txHeadTag.textContent = 'TX Test';
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

    destroy() {
      this._cancelPeakTick();
    }
  }

  K4.SMeterWidget = SMeterWidget;
})();
