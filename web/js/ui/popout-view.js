'use strict';

(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const PEAK_HOLD_MS = 350;
  const PEAK_DECAY_DB_PER_SEC = 18;

  const MODE_LABELS = {
    1: 'LSB',
    2: 'USB',
    3: 'CW',
    4: 'FM',
    5: 'AM',
    6: 'DATA',
    7: 'CW-R',
    9: 'DATA-R',
  };
  const DATA_SUB_LABELS = {
    0: 'DATA-A',
    1: 'AFSK-A',
    2: 'FSK-D',
    3: 'PSK-D',
  };

  function clamp(v, min, max) {
    return v < min ? min : (v > max ? max : v);
  }

  function formatFreqMHz(hz) {
    const n = Math.max(0, Math.round(Number(hz) || 0));
    const mhz = Math.floor(n / 1e6);
    const khz = Math.floor((n % 1e6) / 1e3);
    const rem = n % 1e3;
    return `${mhz}.${String(khz).padStart(3, '0')}.${String(rem).padStart(3, '0')}`;
  }

  function formatMode(rx) {
    if (!rx) return 'USB';
    const m = rx.mode;
    if (m === 6 || m === 9) {
      const base = DATA_SUB_LABELS[rx.dataSubMode] || 'DATA-A';
      return m === 9 ? `${base}-R` : base;
    }
    return MODE_LABELS[m] || 'USB';
  }

  function formatBw(bwHz) {
    const bw = Number(bwHz);
    if (!Number.isFinite(bw) || bw <= 0) return '';
    return bw >= 1000 ? `${(bw / 1000).toFixed(2).replace(/\.?0+$/, '')}k` : `${Math.round(bw)}Hz`;
  }

  function formatSUnit(dBm) {
    if (K4.SpectrumScale && typeof K4.SpectrumScale.sUnitForDbm === 'function') {
      const res = K4.SpectrumScale.sUnitForDbm(dBm);
      if (typeof res === 'string') return res;
      if (res && typeof res.label === 'string') return res.label;
    }
    if (dBm <= -73) {
      return `S${clamp(Math.round((dBm + 127) / 6), 0, 9)}`;
    }
    return `S9+${Math.max(1, Math.round(dBm + 73))}`;
  }

  function dbmToPct(dBm) {
    return clamp(((dBm + 127) / 94) * 100, 0, 100);
  }

  function stepPeak(now, dbm, st) {
    if (dbm >= st.peakDbm) {
      st.peakDbm = dbm;
      st.peakAt = now;
      st.lastDecayAt = now;
      return st.peakDbm;
    }
    if (now - st.peakAt >= PEAK_HOLD_MS) {
      const start = Math.max(st.lastDecayAt, st.peakAt + PEAK_HOLD_MS);
      const dt = Math.max(0, (now - start) / 1000);
      if (dt > 0) {
        st.peakDbm = Math.max(dbm, st.peakDbm - dt * PEAK_DECAY_DB_PER_SEC);
      }
    }
    st.lastDecayAt = now;
    return st.peakDbm;
  }

  const POPOUT_CSS = `
    :root {
      color-scheme: dark;
      --bg: #090b10;
      --surface: #111622;
      --surface-2: #161d2d;
      --border: rgba(148, 163, 184, 0.16);
      --text: #f1f5f9;
      --muted: #94a3b8;
      --dim: #64748b;
      --cyan: #38bdf8;
      --green: #22c55e;
      --amber: #f59e0b;
      --red: #f43f5e;
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      --sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%;
      height: 100%;
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      overflow: hidden;
      user-select: none;
      -webkit-user-select: none;
    }
    .pip-root {
      display: flex;
      flex-direction: column;
      gap: 7px;
      height: 100%;
      padding: 8px 10px;
    }
    .pip-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      min-height: 24px;
    }
    .pip-status {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      font-size: 11px;
      color: var(--muted);
    }
    .pip-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--dim);
      flex-shrink: 0;
    }
    .pip-dot[data-status="connected"] { background: var(--green); box-shadow: 0 0 6px rgba(34, 197, 94, 0.55); }
    .pip-dot[data-status="connecting"],
    .pip-dot[data-status="authenticating"] { background: var(--amber); }
    .pip-dot[data-status="error"] { background: var(--red); }
    .pip-host {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-weight: 600;
      color: var(--text);
    }
    .pip-state-pill {
      font-family: var(--mono);
      font-size: 10px;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 999px;
      background: rgba(56, 189, 248, 0.14);
      color: var(--cyan);
      border: 1px solid rgba(56, 189, 248, 0.3);
      letter-spacing: 0.04em;
    }
    .pip-state-pill[data-mode="tx"] {
      background: rgba(244, 63, 94, 0.22);
      color: #fda4af;
      border-color: rgba(244, 63, 94, 0.65);
    }
    .pip-state-pill[data-mode="tune"] {
      background: rgba(245, 158, 11, 0.22);
      color: #fcd34d;
      border-color: rgba(245, 158, 11, 0.65);
    }
    .pip-actions {
      display: flex;
      align-items: center;
      gap: 5px;
      flex-shrink: 0;
    }
    .pip-btn {
      appearance: none;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      font-family: var(--mono);
      font-size: 10px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 5px;
      cursor: pointer;
      line-height: 1.2;
    }
    .pip-btn:hover:not(:disabled) { border-color: rgba(56, 189, 248, 0.55); background: var(--surface-2); }
    .pip-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .pip-btn[data-active="true"] {
      background: rgba(56, 189, 248, 0.18);
      border-color: rgba(56, 189, 248, 0.55);
      color: var(--cyan);
    }
    .pip-btn--ptt[data-active="true"] {
      background: rgba(244, 63, 94, 0.35);
      border-color: rgba(244, 63, 94, 0.85);
      color: #fff;
    }

    .pip-vfo-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 6px 9px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .pip-vfo-a-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    }
    .pip-vfo-a {
      font-family: var(--mono);
      font-variant-numeric: tabular-nums;
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--cyan);
      line-height: 1.08;
      cursor: ns-resize;
    }
    .pip-vfo-meta {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .pip-badge {
      font-family: var(--mono);
      font-size: 10px;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 4px;
      background: rgba(148, 163, 184, 0.14);
      color: var(--text);
    }
    .pip-badge--bw { color: var(--muted); font-weight: 600; }
    .pip-badge--split { background: rgba(245, 158, 11, 0.2); color: #fcd34d; }
    .pip-badge--rit { background: rgba(56, 189, 248, 0.16); color: var(--cyan); }
    .pip-vfo-b-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-family: var(--mono);
      font-variant-numeric: tabular-nums;
      font-size: 11px;
      color: var(--muted);
    }
    .pip-vfo-b-freq { color: var(--green); font-weight: 600; }
    .pip-vfo-b-row[data-dim="true"] .pip-vfo-b-freq { color: var(--dim); }

    .pip-meter-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 6px 9px;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .pip-s-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      font-family: var(--mono);
      font-variant-numeric: tabular-nums;
      font-size: 11px;
    }
    .pip-s-label { color: var(--muted); font-size: 10px; font-weight: 700; letter-spacing: 0.05em; }
    .pip-s-val { font-weight: 700; color: var(--text); }
    .pip-s-val .pip-s-dbm { color: var(--muted); font-weight: 500; }
    .pip-bar-track {
      position: relative;
      height: 8px;
      border-radius: 4px;
      background: #070a10;
      border: 1px solid rgba(148, 163, 184, 0.14);
      overflow: hidden;
    }
    .pip-bar-fill {
      height: 100%;
      width: 0%;
      border-radius: 3px;
      transition: width 45ms linear;
    }
    .pip-bar-fill--s {
      background: linear-gradient(90deg, #22c55e 0%, #38bdf8 55%, #f59e0b 74%, #f43f5e 100%);
    }
    .pip-bar-peak {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 2px;
      background: #f8fafc;
      box-shadow: 0 0 4px rgba(248, 250, 252, 0.7);
      pointer-events: none;
    }
    .pip-s-ticks {
      display: flex;
      justify-content: space-between;
      font-family: var(--mono);
      font-size: 9px;
      color: var(--dim);
      margin-top: -2px;
    }

    .pip-tx-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 5px 10px;
      opacity: 0.72;
      transition: opacity 120ms ease;
    }
    .pip-tx-grid[data-tx="true"] { opacity: 1; }
    .pip-tx-row {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .pip-tx-head {
      display: flex;
      justify-content: space-between;
      font-family: var(--mono);
      font-variant-numeric: tabular-nums;
      font-size: 10px;
    }
    .pip-tx-k { color: var(--muted); font-weight: 700; }
    .pip-tx-v { color: var(--text); font-weight: 700; }
    .pip-tx-track {
      height: 5px;
      border-radius: 3px;
      background: #070a10;
      border: 1px solid rgba(148, 163, 184, 0.12);
      overflow: hidden;
    }
    .pip-tx-fill {
      height: 100%;
      width: 0%;
      border-radius: 2px;
      background: var(--cyan);
      transition: width 45ms linear;
    }
    .pip-tx-fill[data-lvl="ok"] { background: var(--green); }
    .pip-tx-fill[data-lvl="warn"] { background: var(--amber); }
    .pip-tx-fill[data-lvl="crit"] { background: var(--red); }

    .pip-foot {
      margin-top: auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      font-family: var(--mono);
      font-variant-numeric: tabular-nums;
      font-size: 10px;
      color: var(--muted);
      padding: 2px 2px 0;
      border-top: 1px solid rgba(148, 163, 184, 0.12);
    }
    .pip-metric[data-lvl="warn"] { color: var(--amber); font-weight: 700; }
    .pip-metric[data-lvl="crit"] { color: var(--red); font-weight: 700; }
  `;

  /**
   * Always-on-top Document Picture-in-Picture (with popup fallback) mini-rig readout
   * displaying VFO A/B, S-meter, 4-bar TX meters (PWR/SWR/ALC/CMP), key DC/PA metrics,
   * and quick Audio Mute + Hold-PTT controls.
   */
  class PopoutView {
    constructor(opts = {}) {
      this._getSnapshot = typeof opts.getSnapshot === 'function' ? opts.getSnapshot : () => ({});
      this._getAudioDiag = typeof opts.getAudioDiag === 'function' ? opts.getAudioDiag : () => ({});
      this._onToggleMute = typeof opts.onToggleMute === 'function' ? opts.onToggleMute : null;
      this._onPttStart = typeof opts.onPttStart === 'function' ? opts.onPttStart : null;
      this._onPttEnd = typeof opts.onPttEnd === 'function' ? opts.onPttEnd : null;
      this._onStepVfo = typeof opts.onStepVfo === 'function' ? opts.onStepVfo : null;
      this._onStateChange = typeof opts.onStateChange === 'function' ? opts.onStateChange : null;

      this._win = null;
      this._refs = null;
      this._peakA = { peakDbm: -127, peakAt: 0, lastDecayAt: 0 };
      this._pttHeld = false;
      this._rafId = 0;
      this._pendingRender = false;
      this._lastSnapshot = null;
      this._lastAudioDiag = null;
    }

    static isDocumentPipSupported() {
      return Boolean(
        globalThis.documentPictureInPicture &&
        typeof globalThis.documentPictureInPicture.requestWindow === 'function'
      );
    }

    isOpen() {
      return Boolean(this._win && !this._win.closed);
    }

    async toggle() {
      if (this.isOpen()) {
        this.close();
        return false;
      }
      return this.open();
    }

    async open() {
      if (this.isOpen()) {
        try {
          this._win.focus();
        } catch (_) {}
        return true;
      }

      let win = null;
      if (PopoutView.isDocumentPipSupported()) {
        win = await globalThis.documentPictureInPicture.requestWindow({
          width: 390,
          height: 248,
        });
      } else if (typeof globalThis.open === 'function') {
        win = globalThis.open('', 'k4-mini-rig', 'popup=yes,width=390,height=248');
      }
      if (!win) {
        return false;
      }

      this._mountInto(win);
      if (this._onStateChange) this._onStateChange(true);
      this.update(this._getSnapshot(), this._getAudioDiag(), true);
      return true;
    }

    close() {
      const win = this._win;
      this._teardownRefs();
      if (win && !win.closed) {
        try {
          win.close();
        } catch (_) {}
      }
    }

    _teardownRefs() {
      if (this._pttHeld) {
        this._pttHeld = false;
        if (this._onPttEnd) this._onPttEnd();
      }
      if (this._rafId && this._win && typeof this._win.cancelAnimationFrame === 'function') {
        try {
          this._win.cancelAnimationFrame(this._rafId);
        } catch (_) {}
      }
      this._rafId = 0;
      this._pendingRender = false;
      const wasOpen = Boolean(this._win);
      this._win = null;
      this._refs = null;
      if (wasOpen && this._onStateChange) {
        this._onStateChange(false);
      }
    }

    _mountInto(win) {
      this._win = win;
      const doc = win.document;
      doc.title = 'K4 Mini-Rig';
      if (doc.head) {
        doc.head.innerHTML = '';
        const style = doc.createElement('style');
        style.textContent = POPOUT_CSS;
        doc.head.appendChild(style);
      }
      doc.body.innerHTML = '';

      const el = (tag, cls, text) => {
        const n = doc.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
      };

      const root = el('div', 'pip-root');

      // 1. Header
      const head = el('div', 'pip-head');
      const statusWrap = el('div', 'pip-status');
      const dot = el('span', 'pip-dot');
      const host = el('span', 'pip-host', 'Disconnected');
      const statePill = el('span', 'pip-state-pill', 'RX');
      statusWrap.append(dot, host, statePill);

      const actions = el('div', 'pip-actions');
      const muteBtn = el('button', 'pip-btn', 'MUTE');
      muteBtn.type = 'button';
      muteBtn.dataset.testid = 'pip-mute-btn';
      muteBtn.addEventListener('click', () => {
        if (this._onToggleMute) this._onToggleMute();
      });

      const pttBtn = el('button', 'pip-btn pip-btn--ptt', 'PTT');
      pttBtn.type = 'button';
      pttBtn.dataset.testid = 'pip-ptt-btn';
      pttBtn.disabled = true;
      const releasePtt = () => {
        if (!this._pttHeld) return;
        this._pttHeld = false;
        pttBtn.dataset.active = 'false';
        if (this._onPttEnd) this._onPttEnd();
      };
      pttBtn.addEventListener('pointerdown', (e) => {
        if (pttBtn.disabled || e.button !== 0) return;
        e.preventDefault();
        this._pttHeld = true;
        pttBtn.dataset.active = 'true';
        try { pttBtn.setPointerCapture(e.pointerId); } catch (_) {}
        if (this._onPttStart) this._onPttStart();
      });
      pttBtn.addEventListener('pointerup', releasePtt);
      pttBtn.addEventListener('pointercancel', releasePtt);
      pttBtn.addEventListener('lostpointercapture', releasePtt);

      actions.append(muteBtn, pttBtn);
      head.append(statusWrap, actions);

      // 2. VFO Card
      const vfoCard = el('div', 'pip-vfo-card');
      const vfoARow = el('div', 'pip-vfo-a-row');
      const vfoAFreq = el('div', 'pip-vfo-a', '14.074.000');
      vfoAFreq.dataset.testid = 'pip-vfo-a';
      vfoAFreq.title = 'Scroll to tune VFO A';
      vfoAFreq.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (!this._onStepVfo) return;
        const dir = e.deltaY < 0 ? 1 : -1;
        this._onStepVfo('A', dir, Boolean(e.shiftKey));
      }, { passive: false });

      const vfoMeta = el('div', 'pip-vfo-meta');
      const modeBadge = el('span', 'pip-badge', 'USB');
      const bwBadge = el('span', 'pip-badge pip-badge--bw', '2.4k');
      const splitBadge = el('span', 'pip-badge pip-badge--split', 'SPLIT');
      splitBadge.hidden = true;
      const ritBadge = el('span', 'pip-badge pip-badge--rit', 'RIT');
      ritBadge.hidden = true;
      vfoMeta.append(modeBadge, bwBadge, splitBadge, ritBadge);
      vfoARow.append(vfoAFreq, vfoMeta);

      const vfoBRow = el('div', 'pip-vfo-b-row');
      const vfoBFreq = el('span', 'pip-vfo-b-freq', 'B 14.074.000');
      vfoBFreq.dataset.testid = 'pip-vfo-b';
      const vfoBMeta = el('span', '', 'SUB OFF');
      vfoBRow.append(vfoBFreq, vfoBMeta);
      vfoCard.append(vfoARow, vfoBRow);

      // 3. S-Meter + TX Meters Card
      const meterCard = el('div', 'pip-meter-card');

      const sHead = el('div', 'pip-s-head');
      const sLabel = el('span', 'pip-s-label', 'S-METER');
      const sVal = el('span', 'pip-s-val');
      sVal.dataset.testid = 'pip-smeter-val';
      const sUnit = el('span', '', 'S0');
      const sDbm = el('span', 'pip-s-dbm', ' · -127 dBm');
      sVal.append(sUnit, sDbm);
      sHead.append(sLabel, sVal);

      const sTrack = el('div', 'pip-bar-track');
      const sFill = el('div', 'pip-bar-fill pip-bar-fill--s');
      const sPeak = el('div', 'pip-bar-peak');
      sPeak.style.left = '0%';
      sTrack.append(sFill, sPeak);

      const sTicks = el('div', 'pip-s-ticks');
      for (const t of ['S1', 'S5', 'S9', '+20', '+40']) {
        sTicks.appendChild(el('span', '', t));
      }

      const txGrid = el('div', 'pip-tx-grid');
      txGrid.dataset.testid = 'pip-tx-meters';
      const makeTxBar = (key, label) => {
        const row = el('div', 'pip-tx-row');
        const h = el('div', 'pip-tx-head');
        const k = el('span', 'pip-tx-k', label);
        const v = el('span', 'pip-tx-v', '—');
        v.dataset.testid = `pip-tx-${key}`;
        h.append(k, v);
        const tr = el('div', 'pip-tx-track');
        const fl = el('div', 'pip-tx-fill');
        tr.appendChild(fl);
        row.append(h, tr);
        txGrid.appendChild(row);
        return { v, fl };
      };
      const txBars = {
        pwr: makeTxBar('pwr', 'PWR'),
        swr: makeTxBar('swr', 'SWR'),
        alc: makeTxBar('alc', 'ALC'),
        cmp: makeTxBar('cmp', 'CMP'),
      };

      meterCard.append(sHead, sTrack, sTicks, txGrid);

      // 4. Footer Key Metrics
      const foot = el('div', 'pip-foot');
      const mVolts = el('span', 'pip-metric', '— V');
      const mAmps = el('span', 'pip-metric', '— A');
      const mTemp = el('span', 'pip-metric', 'PA —°C');
      const mRtt = el('span', 'pip-metric', 'RTT —');
      foot.append(mVolts, mAmps, mTemp, mRtt);

      root.append(head, vfoCard, meterCard, foot);
      doc.body.appendChild(root);

      this._refs = {
        dot, host, statePill, muteBtn, pttBtn,
        vfoAFreq, modeBadge, bwBadge, splitBadge, ritBadge,
        vfoBRow, vfoBFreq, vfoBMeta,
        sUnit, sDbm, sFill, sPeak,
        txGrid, txBars,
        mVolts, mAmps, mTemp, mRtt,
      };

      const onClose = () => this._teardownRefs();
      win.addEventListener('pagehide', onClose, { once: true });
      win.addEventListener('beforeunload', onClose, { once: true });
      win.addEventListener('blur', releasePtt);
    }

    update(snapshot, audioDiag, immediate = false) {
      if (!this.isOpen() || !this._refs) return;
      this._lastSnapshot = snapshot || this._getSnapshot();
      this._lastAudioDiag = audioDiag || this._getAudioDiag();
      if (immediate) {
        this._renderNow();
        return;
      }
      if (this._pendingRender) return;
      this._pendingRender = true;
      const win = this._win;
      if (win && typeof win.requestAnimationFrame === 'function') {
        this._rafId = win.requestAnimationFrame(() => {
          this._rafId = 0;
          this._pendingRender = false;
          this._renderNow();
        });
      } else {
        this._pendingRender = false;
        this._renderNow();
      }
    }

    _renderNow() {
      if (!this.isOpen() || !this._refs) return;
      const snap = this._lastSnapshot || this._getSnapshot() || {};
      const aDiag = this._lastAudioDiag || this._getAudioDiag() || {};
      const r = this._refs;

      const conn = snap.connection || {};
      const status = conn.status || 'disconnected';
      const connected = status === 'connected';
      r.dot.dataset.status = status;
      r.host.textContent = connected
        ? (conn.radioId || 'K4')
        : (status === 'connecting' || status === 'authenticating' ? 'Connecting…' : 'Disconnected');

      const txActive = Boolean(snap.txActive);
      const atuTuning = Boolean(snap.atuTuning);
      const txOrTune = txActive || atuTuning;
      if (atuTuning) {
        r.statePill.textContent = 'TUNE';
        r.statePill.dataset.mode = 'tune';
      } else if (txActive) {
        r.statePill.textContent = snap.txTestMode ? 'TEST' : 'TX';
        r.statePill.dataset.mode = 'tx';
      } else {
        r.statePill.textContent = 'RX';
        r.statePill.dataset.mode = 'rx';
      }

      const muted = aDiag.muted !== false;
      r.muteBtn.textContent = muted ? 'UNMUTE' : 'AUDIO ON';
      r.muteBtn.dataset.active = muted ? 'false' : 'true';

      const isDemo = Boolean(conn.wsUrl && String(conn.wsUrl).startsWith('demo://'));
      const canTx = connected && !isDemo && !snap.txInhibit && Boolean(this._onPttStart);
      r.pttBtn.disabled = !canTx;
      if (!canTx && this._pttHeld) {
        this._pttHeld = false;
        r.pttBtn.dataset.active = 'false';
      }

      // VFO A & B
      const rxA = snap.rxA || {};
      const rxB = snap.rxB || {};
      r.vfoAFreq.textContent = formatFreqMHz(rxA.freqHz);
      r.modeBadge.textContent = formatMode(rxA);
      const bwTxt = formatBw(rxA.bwHz);
      r.bwBadge.textContent = bwTxt;
      r.bwBadge.hidden = !bwTxt;
      r.splitBadge.hidden = !snap.split;
      const ritOn = Boolean(rxA.ritOn);
      const ritHz = Number(rxA.ritHz) || 0;
      r.ritBadge.hidden = !ritOn;
      if (ritOn) {
        r.ritBadge.textContent = `RIT ${ritHz >= 0 ? '+' : ''}${ritHz}`;
      }

      const subOn = Boolean(snap.subRxEnabled);
      r.vfoBFreq.textContent = `B ${formatFreqMHz(rxB.freqHz)}`;
      r.vfoBMeta.textContent = subOn
        ? `${formatMode(rxB)} ${formatBw(rxB.bwHz)}`.trim()
        : (snap.split ? `TX ${formatMode(rxB)}` : 'SUB OFF');
      r.vfoBRow.dataset.dim = (subOn || snap.split) ? 'false' : 'true';

      // S-Meter
      const rawDbm = Number.isFinite(rxA.sMeterDbm) ? rxA.sMeterDbm : -127;
      const peakDbm = stepPeak(performance.now(), rawDbm, this._peakA);
      r.sUnit.textContent = formatSUnit(rawDbm);
      r.sDbm.textContent = ` · ${Math.round(rawDbm)} dBm`;
      r.sFill.style.width = `${dbmToPct(rawDbm).toFixed(1)}%`;
      r.sPeak.style.left = `${dbmToPct(peakDbm).toFixed(1)}%`;

      // TX Meters
      const tm = snap.txMeters || {};
      const fwd = Number(tm.fwdWatts) || 0;
      const pkFwd = Number(tm.peakFwdWatts) || 0;
      const swr = Number(tm.swr) >= 1.0 ? Number(tm.swr) : (Number(tm.peakSwr) >= 1.0 ? Number(tm.peakSwr) : (snap.atuMatchedSwr || 1.0));
      const alc = Number(tm.alcBars) || 0;
      const cmp = Number(tm.compDb) || 0;
      const qrp = snap.txPowerRange === 'L' || (Number(snap.txPowerWatts) > 0 && Number(snap.txPowerWatts) <= 10);
      const maxPwr = qrp ? 10 : 110;

      r.txGrid.dataset.tx = txOrTune ? 'true' : 'false';

      const shownPwr = txOrTune ? fwd : pkFwd;
      r.txBars.pwr.v.textContent = txOrTune
        ? `${fwd.toFixed(1)} W`
        : (pkFwd > 0 ? `pk ${pkFwd.toFixed(1)} W` : '0.0 W');
      r.txBars.pwr.fl.style.width = `${clamp((shownPwr / maxPwr) * 100, 0, 100).toFixed(1)}%`;
      r.txBars.pwr.fl.dataset.lvl = txOrTune ? 'ok' : '';

      r.txBars.swr.v.textContent = `${swr.toFixed(2)}:1`;
      r.txBars.swr.fl.style.width = `${clamp(((swr - 1.0) / 2.5) * 100, 0, 100).toFixed(1)}%`;
      r.txBars.swr.fl.dataset.lvl = swr > 2.5 ? 'crit' : (swr > 1.5 ? 'warn' : 'ok');

      r.txBars.alc.v.textContent = `${alc} / 7`;
      r.txBars.alc.fl.style.width = `${clamp((alc / 7) * 100, 0, 100).toFixed(1)}%`;
      r.txBars.alc.fl.dataset.lvl = alc >= 6 ? 'warn' : (alc >= 1 ? 'ok' : '');

      r.txBars.cmp.v.textContent = `${Math.round(cmp)} dB`;
      r.txBars.cmp.fl.style.width = `${clamp((cmp / 30) * 100, 0, 100).toFixed(1)}%`;
      r.txBars.cmp.fl.dataset.lvl = cmp > 18 ? 'warn' : (cmp > 0 ? 'ok' : '');

      // Key Metrics Footer
      const tel = snap.telemetry || {};
      const vs = tel.supplyVolts != null ? Number(tel.supplyVolts) : null;
      const amps = tel.totalAmps != null ? Number(tel.totalAmps) : (tel.supplyAmps != null ? Number(tel.supplyAmps) : null);
      const paTemp = tel.paTempC != null ? Number(tel.paTempC) : null;
      const rtt = conn.rttMs != null ? Math.round(Number(conn.rttMs)) : null;

      r.mVolts.textContent = vs != null ? `${vs.toFixed(1)}V` : '— V';
      r.mVolts.dataset.lvl = vs != null ? (vs < 11.2 ? 'crit' : (vs < 11.8 ? 'warn' : 'ok')) : 'ok';

      r.mAmps.textContent = amps != null ? `${amps.toFixed(1)}A` : '— A';
      r.mAmps.dataset.lvl = amps != null && amps > 21 ? 'warn' : 'ok';

      r.mTemp.textContent = paTemp != null ? `PA ${paTemp.toFixed(0)}°C` : 'PA —°C';
      r.mTemp.dataset.lvl = paTemp != null ? (paTemp >= 75 ? 'crit' : (paTemp >= 60 ? 'warn' : 'ok')) : 'ok';

      r.mRtt.textContent = rtt != null ? `RTT ${rtt}ms` : 'RTT —';
    }
  }

  K4.PopoutView = PopoutView;
})();
