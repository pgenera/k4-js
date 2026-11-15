'use strict';
(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const SPAN_STEPS_HZ = [6000, 12000, 24000, 36000, 48000, 72000, 96000, 144000, 192000, 288000, 368000];

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function extractHostLabel(wsUrl) {
    if (!wsUrl) return 'Radio';
    try {
      const u = new URL(wsUrl);
      return u.host || wsUrl;
    } catch (_err) {
      return wsUrl.replace(/^wss?:\/\//, '').split('/')[0] || wsUrl;
    }
  }

  class App {
    constructor() {
      this._params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
      this._targetRx = 'A';
      this._mouseQsyMode = (K4.storage && K4.storage.get('k4.mouseQsyMode', 'lr')) === 'pane' ? 'pane' : 'lr';
      this._wheelRitMode = false;
      this._palette = K4.storage ? K4.storage.get('k4.palette', 'obsidian') : 'obsidian';
      this._peakHold = K4.storage ? K4.storage.get('k4.peakHold', true) !== false : true;
      this._drawerOpen = window.innerWidth >= 1200;
      this._tickerExpanded = false;
      this._lastTickerCount = 0;
      this._lastDecodedSignature = '';
      this._rafScheduled = false;
      this._pendingConnectClose = false;
      this._lastSyncedMix = null;
      this._lastSyncedSl = null;
      this._armConfirmOpen = false;
      this._pttPointerId = null;
      this._pttKeyHeld = false;
      this._pttHeldUi = false;
      this._txAudioConfig = {
        source: 'two-tone',
        deviceId: '',
        voiceProcessing: false,
        wavName: '',
      };

      this.state = new K4.RadioState();
      this.gate = new K4.RxOnlyGate('rx-only');
      this.client = new K4.Client({ state: this.state, gate: this.gate });
      this.audio = new K4.AudioEngine({ state: this.state });

      this._dom = {
        connBtn: document.getElementById('conn-btn'),
        connLabel: document.querySelector('#conn-btn .k4-conn-label'),
        connRtt: document.querySelector('#conn-btn .k4-conn-rtt'),
        vfoAMount: document.getElementById('vfo-a-mount'),
        vfoBMount: document.getElementById('vfo-b-mount'),
        smeterMount: document.getElementById('smeter-mount'),
        omnibarBtn: document.getElementById('omnibar-btn'),
        audioToggleBtn: document.getElementById('audio-toggle'),
        audioLabel: document.querySelector('#audio-toggle .k4-audio-label'),
        txPostureBar: document.getElementById('tx-posture-bar'),
        txModeRxBtn: document.getElementById('tx-mode-rx'),
        txModeTestBtn: document.getElementById('tx-mode-test'),
        txModeArmedBtn: document.getElementById('tx-mode-armed'),
        pttBtn: document.getElementById('ptt-btn'),
        txArmConfirm: document.getElementById('tx-arm-confirm'),
        txArmVfo: document.getElementById('tx-arm-vfo'),
        txArmFreq: document.getElementById('tx-arm-freq'),
        txArmMode: document.getElementById('tx-arm-mode'),
        txArmPower: document.getElementById('tx-arm-power'),
        txArmAnt: document.getElementById('tx-arm-ant'),
        txArmCancelBtn: document.getElementById('tx-arm-cancel-btn'),
        txArmConfirmBtn: document.getElementById('tx-arm-confirm-btn'),
        rxOnlyBadge: document.getElementById('rx-only-badge'),
        rxBlockedCount: document.querySelector('#rx-only-badge .k4-rx-blocked-count'),
        drawerToggleBtn: document.getElementById('drawer-toggle'),
        panStage: document.getElementById('pan-stage'),
        drawer: document.getElementById('inspector-drawer'),
        mobileNav: document.getElementById('mobile-nav'),
        mobileSheet: document.getElementById('mobile-sheet'),
        omnibarModal: document.getElementById('omnibar-modal'),
        connDialog: document.getElementById('connection-dialog'),
        toastStack: document.getElementById('toast-stack'),
      };

      const rendererOpt = this._params.get('renderer') || 'auto';
      this.panadapter = new K4.PanadapterView({
        container: this._dom.panStage,
        state: this.state,
        client: this.client,
        renderer: rendererOpt,
        mouseQsyMode: this._mouseQsyMode,
        onSelectTarget: (rx) => this.setTargetRx(rx),
        onToggleWheelRit: () => this.toggleWheelRitMode(),
        onNotify: (msg, level) => this.toast(msg, level),
        onViewportChange: () => this._scheduleRender(),
      });

      if (this.panadapter.setPalette) this.panadapter.setPalette(this._palette);
      if (this.panadapter.setPeakHold) this.panadapter.setPeakHold(this._peakHold);
      if (this.panadapter.setTargetRx) this.panadapter.setTargetRx(this._targetRx);

      this._mountStageOverlays();
      this._initWidgets();
      this._bindEvents();
      this._applyDrawerState();
      this._scheduleRender();
      this._handleStartup();
    }

    _getSnapshot() {
      return typeof this.state.getSnapshot === 'function'
        ? this.state.getSnapshot()
        : (this.state.snapshot || this.state);
    }

    _mountStageOverlays() {
      const stage = this._dom.panStage;
      stage.addEventListener(
        'wheel',
        (e) => {
          if (e.ctrlKey || e.metaKey) e.preventDefault();
        },
        { passive: false }
      );

      // Top-left panadapter HUD pill
      const hudTop = el('div', 'k4-pan-hud-top');
      const group = el('div', 'k4-hud-group');

      this._hudTargetBtn = el('button', 'k4-hud-btn k4-hud-mouse-btn is-cyan');
      this._hudTargetBtn.type = 'button';
      this._hudTargetBtn.dataset.testid = 'hud-target-btn';
      const mouseSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      mouseSvg.setAttribute('viewBox', '0 0 12 14');
      mouseSvg.setAttribute('width', '12');
      mouseSvg.setAttribute('height', '12');
      mouseSvg.setAttribute('aria-hidden', 'true');
      const mouseBody = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      mouseBody.setAttribute('x', '1.5');
      mouseBody.setAttribute('y', '1');
      mouseBody.setAttribute('width', '9');
      mouseBody.setAttribute('height', '12');
      mouseBody.setAttribute('rx', '4.5');
      mouseBody.setAttribute('fill', 'none');
      mouseBody.setAttribute('stroke', 'currentColor');
      mouseBody.setAttribute('stroke-width', '1.4');
      const mouseWheel = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      mouseWheel.setAttribute('x1', '6');
      mouseWheel.setAttribute('y1', '3.3');
      mouseWheel.setAttribute('x2', '6');
      mouseWheel.setAttribute('y2', '6.2');
      mouseWheel.setAttribute('stroke', 'currentColor');
      mouseWheel.setAttribute('stroke-width', '1.4');
      mouseWheel.setAttribute('stroke-linecap', 'round');
      mouseSvg.appendChild(mouseBody);
      mouseSvg.appendChild(mouseWheel);
      this._hudTargetBtn.appendChild(mouseSvg);
      this._hudTargetLabel = el('span', 'k4-hud-mouse-label', 'Mouse: A');
      this._hudTargetBtn.appendChild(this._hudTargetLabel);
      this._hudTargetBtn.title = 'K4 Mouse target (Left=A, Right=B). Click to switch VFO A/B; middle-click or Shift-click to toggle RIT wheel.';
      this._hudTargetBtn.addEventListener('click', (e) => {
        if (e.shiftKey) {
          this.toggleWheelRitMode();
        } else if (this._wheelRitMode) {
          this.toggleWheelRitMode(false);
        } else {
          this.setTargetRx(this._targetRx === 'A' ? 'B' : 'A');
        }
      });
      this._hudTargetBtn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.setTargetRx(this._targetRx === 'A' ? 'B' : 'A');
      });
      this._hudTargetBtn.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          e.stopPropagation();
          this.toggleWheelRitMode();
        }
      });
      group.appendChild(this._hudTargetBtn);

      group.appendChild(el('span', 'k4-hud-sep'));

      this._hudStepBtn = el('button', 'k4-hud-btn', 'Step: 100 Hz');
      this._hudStepBtn.type = 'button';
      this._hudStepBtn.title = 'Cycle tuning step size';
      this._hudStepBtn.addEventListener('click', () => this._cycleStep());
      group.appendChild(this._hudStepBtn);

      group.appendChild(el('span', 'k4-hud-sep'));

      const zoomInBtn = el('button', 'k4-hud-btn', '−');
      zoomInBtn.type = 'button';
      zoomInBtn.title = 'Zoom span in (narrower)';
      zoomInBtn.addEventListener('click', () => this._stepSpan(-1));
      group.appendChild(zoomInBtn);

      this._hudSpanReadout = el('span', 'k4-hud-readout', '48 kHz');
      group.appendChild(this._hudSpanReadout);

      const zoomOutBtn = el('button', 'k4-hud-btn', '+');
      zoomOutBtn.type = 'button';
      zoomOutBtn.title = 'Zoom span out (wider)';
      zoomOutBtn.addEventListener('click', () => this._stepSpan(1));
      group.appendChild(zoomOutBtn);

      this._hudCenterBtn = el('button', 'k4-hud-btn', 'Center');
      this._hudCenterBtn.type = 'button';
      this._hudCenterBtn.dataset.testid = 'hud-center-btn';
      this._hudCenterBtn.hidden = true;
      this._hudCenterBtn.title = 'Re-center zoomed panadapter viewport on VFO (FC)';
      this._hudCenterBtn.addEventListener('click', () => {
        const snap = this._getSnapshot();
        const dispRx = this._dispRx(snap);
        if (this.panadapter && this.panadapter.resetViewport) {
          this.panadapter.resetViewport(dispRx, { syncRadioSpan: true });
        }
      });
      group.appendChild(this._hudCenterBtn);

      group.appendChild(el('span', 'k4-hud-sep'));

      this._hudDualBtn = el('button', 'k4-hud-btn', '1x');
      this._hudDualBtn.type = 'button';
      this._hudDualBtn.title = 'Toggle Dual Panadapter (#DPM)';
      this._hudDualBtn.addEventListener('click', () => {
        const snap = this._getSnapshot();
        if (snap.hasSubRx === false) return;
        const next = snap.dualPanMode === 2 ? 0 : 2;
        this.client.setDisplay(this._dispRx(snap), { dualPanMode: next });
      });
      group.appendChild(this._hudDualBtn);

      this._hudLoupeBtn = el('button', 'k4-hud-btn', 'Loupe A');
      this._hudLoupeBtn.type = 'button';
      this._hudLoupeBtn.title = 'Toggle Mini-Pan Loupe (#MP / #MP$)';
      this._hudLoupeBtn.addEventListener('click', () => {
        const snap = this._getSnapshot();
        const loupeRx = this._resolveLoupeRx(snap);
        const rxS = loupeRx === 'B' ? snap.rxB : snap.rxA;
        this.client.setDisplay(loupeRx, { miniPan: !(rxS && rxS.miniPan) });
      });
      group.appendChild(this._hudLoupeBtn);

      this._hudFreezeBtn = el('button', 'k4-hud-btn', 'Freeze');
      this._hudFreezeBtn.type = 'button';
      this._hudFreezeBtn.dataset.testid = 'hud-freeze-btn';
      this._hudFreezeBtn.title = 'Freeze/Unfreeze Panadapter (#FRZ)';
      this._hudFreezeBtn.addEventListener('click', () => {
        const snap = this._getSnapshot();
        this.client.setDisplay(this._dispRx(snap), { panFrozen: !snap.panFrozen });
      });
      group.appendChild(this._hudFreezeBtn);

      hudTop.appendChild(group);
      stage.appendChild(hudTop);

      // Bottom-left Decoded Text Ticker (TB$)
      const ticker = el('section', 'k4-text-ticker');
      ticker.id = 'text-ticker';
      ticker.dataset.testid = 'text-ticker';
      ticker.dataset.expanded = 'false';

      const tHead = el('div', 'k4-ticker-header');
      const tSum = el('div', 'k4-ticker-summary');
      this._tickerBadge = el('span', 'k4-ticker-badge', 'TB$ TEXT');
      this._tickerPreview = el('span', 'k4-ticker-preview', 'Waiting for decoded CW / RTTY / PSK...');
      tSum.appendChild(this._tickerBadge);
      tSum.appendChild(this._tickerPreview);
      tHead.appendChild(tSum);

      const tActs = el('div', 'k4-ticker-actions');
      this._tickerDecodeSelect = el('select', 'k4-ticker-select');
      this._tickerDecodeSelect.dataset.testid = 'ticker-td-select';
      this._tickerDecodeSelect.setAttribute('aria-label', 'Text Decode Mode');
      const stopTickerEvt = (e) => e.stopPropagation();
      this._tickerDecodeSelect.addEventListener('click', stopTickerEvt);
      this._tickerDecodeSelect.addEventListener('mousedown', stopTickerEvt);
      this._tickerDecodeSelect.addEventListener('pointerdown', stopTickerEvt);
      this._tickerDecodeSelect.addEventListener('change', () => {
        if (typeof this.client.setTextDecode === 'function') {
          this.client.setTextDecode(this._targetRx, {
            mode: Number(this._tickerDecodeSelect.value),
          });
        }
      });
      tActs.appendChild(this._tickerDecodeSelect);

      const clearBtn = el('button', 'k4-ticker-btn', 'Clear');
      clearBtn.type = 'button';
      clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._clearDecodedText();
      });
      this._tickerExpandBtn = el('button', 'k4-ticker-btn', 'Expand');
      this._tickerExpandBtn.type = 'button';
      this._tickerExpandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleTicker();
      });
      tActs.appendChild(clearBtn);
      tActs.appendChild(this._tickerExpandBtn);
      tHead.appendChild(tActs);

      tHead.addEventListener('click', () => this._toggleTicker());
      ticker.appendChild(tHead);

      this._tickerBody = el('div', 'k4-ticker-body');
      ticker.appendChild(this._tickerBody);
      stage.appendChild(ticker);
      this._tickerEl = ticker;
    }

    _initWidgets() {
      const handleSelectTarget = (rx) => {
        if (window.innerWidth < 960 && this._targetRx === rx) {
          this.setTargetRx(rx === 'A' ? 'B' : 'A');
        } else {
          this.setTargetRx(rx);
        }
      };

      const handleOpenInspector = (tabId) => {
        if (window.innerWidth < 960) {
          this.inspector.toggleMobileSheet(tabId);
        } else {
          if (!this._drawerOpen) {
            this._drawerOpen = true;
            this._applyDrawerState();
          }
          this.inspector.selectDesktopTab(tabId);
        }
      };

      this.vfoAWidget = new K4.VfoWidget({
        container: this._dom.vfoAMount,
        rx: 'A',
        client: this.client,
        onSelectTarget: handleSelectTarget,
        onOpenInspector: handleOpenInspector,
        onOpenOmnibar: () => this.openOmnibar(),
        onNotify: (msg, level) => this.toast(msg, level),
      });

      this.vfoBWidget = new K4.VfoWidget({
        container: this._dom.vfoBMount,
        rx: 'B',
        client: this.client,
        onSelectTarget: handleSelectTarget,
        onOpenInspector: handleOpenInspector,
        onOpenOmnibar: () => this.openOmnibar(),
        onNotify: (msg, level) => this.toast(msg, level),
      });

      this.smeterWidget = new K4.SMeterWidget({
        container: this._dom.smeterMount,
      });

      this.omnibar = new K4.Omnibar({
        modal: this._dom.omnibarModal,
        client: this.client,
        state: this.state,
        getTargetRx: () => this._targetRx,
        onSetTargetRx: (rx) => this.setTargetRx(rx),
        onSetPalette: (pal) => this.setPalette(pal),
        onToggleAudio: (muteOverride) => this.toggleAudio(muteOverride),
        onNotify: (msg, level) => this.toast(msg, level),
      });

      this.inspector = new K4.InspectorPanels({
        drawerEl: this._dom.drawer,
        mobileNavEl: this._dom.mobileNav,
        mobileSheetEl: this._dom.mobileSheet,
        client: this.client,
        state: this.state,
        gate: this.gate,
        audio: this.audio,
        panadapter: this.panadapter,
        getTargetRx: () => this._targetRx,
        onSetTargetRx: (rx) => this.setTargetRx(rx),
        onSetPalette: (pal) => this.setPalette(pal),
        getPalette: () => this._palette,
        onSetPeakHold: (on) => this.setPeakHold(on),
        getPeakHold: () => this._peakHold,
        getMouseQsyMode: () => this._mouseQsyMode,
        onSetMouseQsyMode: (m) => this.setMouseQsyMode(m),
        onToggleAudio: () => this.toggleAudio(),
        onSetTxPosture: (p) => this.setTxPosture(p),
        onPanicAbort: () => this.panicAbortTx('ui-panic'),
        getTxAudioConfig: () => this._txAudioConfig,
        onSetTxAudioConfig: (patch) => this.setTxAudioConfig(patch),
        onLoadTxWav: (file) => this.loadTxWavFile(file),
        onOpenDrawer: () => {
          if (!this._drawerOpen) {
            this._drawerOpen = true;
            this._applyDrawerState();
          }
        },
      });

      this.connectionDialog = new K4.ConnectionDialog({
        modal: this._dom.connDialog,
        client: this.client,
        initialWsUrl: this._params.get('ws') || '',
        onConnectSubmit: (opts) => this.connect(opts),
        onDisconnectClick: () => this.disconnect(),
      });
    }

    _bindEvents() {
      // Client -> Panadapter & Audio
      this.client.on('pan', (ev) => {
        const pkt = ev && ev.pkt ? ev.pkt : ev;
        if (pkt && this.panadapter.pushPanPacket) {
          this.panadapter.pushPanPacket(pkt);
        }
      });

      this.client.on('minipan', (ev) => {
        const pkt = ev && ev.pkt ? ev.pkt : ev;
        if (pkt && this.panadapter.pushMiniPanPacket) {
          this.panadapter.pushMiniPanPacket(pkt);
        }
      });

      this.client.on('audio', (audioPkt) => {
        if (audioPkt && this.audio.pushPacket) {
          this.audio.pushPacket(audioPkt);
        }
      });

      this.client.on('blocked', (info) => {
        const cmd = (info && (info.command || info.cmd)) || 'TX command';
        this.toast(`Blocked ${cmd} — Receive-Only firewall active`, 'blocked');
        this._render();
      });

      this.client.on('error', (err) => {
        let msg = '';
        if (typeof err === 'string') {
          msg = err;
        } else if (err && typeof err === 'object') {
          if (err.code !== undefined && err.code !== null) {
            const codeStr = String(err.code).padStart(2, '0');
            if (!err.message) {
              msg = `K4 Error ${codeStr}`;
            } else if (/^k4\s+error\b/i.test(err.message)) {
              msg = err.message;
            } else {
              msg = `K4 Error ${codeStr}: ${err.message}`;
            }
          } else {
            msg = err.message || err.raw || (err.error && err.error.message) || '';
          }
        }
        if (!msg) {
          msg = 'Radio / transport error';
        }
        this.toast(msg, 'error');
        this._scheduleRender();
      });

      this.client.on('connection', (conn) => {
        this.connectionDialog.syncConnectionState(conn);
        if (this._pendingConnectClose && conn && conn.status === 'connected' && conn.authStatus === 'authenticated') {
          this._pendingConnectClose = false;
          this.connectionDialog.close();
          this.toast('Connected to K4 Receiver', 'success');
        }
        this._render();
      });

      if (typeof this.audio.setTxPacketHandler === 'function') {
        this.audio.setTxPacketHandler((pkt) => {
          if (pkt && typeof this.client.sendTxAudioPacket === 'function') {
            this.client.sendTxAudioPacket(pkt);
          }
        });
      }

      if (typeof this.client.on === 'function') {
        this.client.on('txPttChange', (ev) => {
          const active = Boolean(ev && ev.active);
          if (active) {
            this._startTxAudioIfVoiceMode();
          } else if (typeof this.audio.stopTxCapture === 'function') {
            this.audio.stopTxCapture();
          }
          this._render();
        });
      }

      this.state.on('change', (_snap, changedKey) => {
        if (
          changedKey === 'rxA.sMeterDbm' ||
          changedKey === 'rxB.sMeterDbm' ||
          changedKey === 'rxA.panMeta' ||
          changedKey === 'rxB.panMeta' ||
          changedKey === 'txMeters' ||
          changedKey === 'telemetry'
        ) {
          this._scheduleRender();
        } else {
          this._render();
        }
      });

      // Top bar button handlers
      this._dom.connBtn.addEventListener('click', () => {
        if (this.connectionDialog.isOpen()) this.connectionDialog.close();
        else this.openConnectionDialog();
      });

      this._dom.omnibarBtn.addEventListener('click', () => this.openOmnibar());
      this._dom.audioToggleBtn.addEventListener('click', () => this.toggleAudio());
      this._dom.drawerToggleBtn.addEventListener('click', () => this.toggleDrawer());

      // TX Safety Posture controls & 2-step Arm Confirmation
      if (this._dom.txModeRxBtn) {
        this._dom.txModeRxBtn.addEventListener('click', () => this.setTxPosture('rx-only'));
      }
      if (this._dom.txModeTestBtn) {
        this._dom.txModeTestBtn.addEventListener('click', () => this.setTxPosture('tx-test'));
      }
      if (this._dom.txModeArmedBtn) {
        this._dom.txModeArmedBtn.addEventListener('click', () => this.setTxPosture('tx-armed'));
      }
      if (this._dom.txArmCancelBtn) {
        this._dom.txArmCancelBtn.addEventListener('click', () => this.closeArmConfirm());
      }
      if (this._dom.txArmConfirmBtn) {
        this._dom.txArmConfirmBtn.addEventListener('click', () => this.confirmArmTx());
      }

      // Close arm confirmation popover on outside pointerdown
      document.addEventListener('pointerdown', (e) => {
        if (!this._armConfirmOpen || !this._dom.txArmConfirm) return;
        if (
          this._dom.txArmConfirm.contains(e.target) ||
          (this._dom.txModeArmedBtn && this._dom.txModeArmedBtn.contains(e.target))
        ) {
          return;
        }
        this.closeArmConfirm();
      });

      // Hold-only PTT button (NEVER latches)
      if (this._dom.pttBtn) {
        const ptt = this._dom.pttBtn;
        ptt.addEventListener('pointerdown', (e) => {
          if (e.button !== 0 || ptt.disabled) return;
          e.preventDefault();
          this._pttPointerId = e.pointerId;
          try {
            ptt.setPointerCapture(e.pointerId);
          } catch (_) {}
          this._beginHoldPtt();
        });
        const stopPtrPtt = (e) => {
          if (this._pttPointerId === null && !this._pttHeldUi) return;
          if (e && e.pointerId != null && this._pttPointerId !== null && e.pointerId !== this._pttPointerId && e.type !== 'lostpointercapture') {
            return;
          }
          try {
            if (e && e.pointerId != null && ptt.hasPointerCapture && ptt.hasPointerCapture(e.pointerId)) {
              ptt.releasePointerCapture(e.pointerId);
            }
          } catch (_) {}
          this._endHoldPtt();
        };
        ptt.addEventListener('pointerup', stopPtrPtt);
        ptt.addEventListener('pointercancel', stopPtrPtt);
        ptt.addEventListener('lostpointercapture', stopPtrPtt);
        ptt.addEventListener('contextmenu', (e) => e.preventDefault());
        ptt.addEventListener('click', (e) => e.preventDefault());
      }

      // Global keyboard shortcuts & Hold-Only Spacebar PTT / Unconditional Escape Panic
      document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          if (this.omnibar.isOpen()) this.omnibar.close();
          else this.openOmnibar();
          return;
        }

        if (e.key === 'Escape') {
          const snap = this._getSnapshot();
          const txBusy = Boolean(
            snap.txActive || snap.pttHeld || this._pttHeldUi || snap.atuTuning || Number(snap.txBufferCount) > 0
          );
          if (txBusy) {
            e.preventDefault();
            this.panicAbortTx('escape');
            this.closeOverlays();
            return;
          }
          if (
            this.omnibar.isOpen() ||
            this.connectionDialog.isOpen() ||
            this.inspector.isMobileSheetOpen() ||
            this._armConfirmOpen
          ) {
            e.preventDefault();
            this.closeOverlays();
          }
          return;
        }

        const tag = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : '';
        const isEditing = tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable);
        const modalOpen = this.omnibar.isOpen() || this.connectionDialog.isOpen() || this._armConfirmOpen;
        if (isEditing || modalOpen) {
          return;
        }

        if (e.code === 'Space') {
          const snap = this._getSnapshot();
          const posture = snap.txPosture || (typeof this.client.getTxPosture === 'function' ? this.client.getTxPosture() : 'rx-only');
          if (posture !== 'rx-only' && !snap.txInhibit) {
            e.preventDefault();
            if (!e.repeat && !this._pttKeyHeld) {
              this._pttKeyHeld = true;
              this._beginHoldPtt();
            }
            return;
          }
        }

        if (e.key === 'm' || e.key === 'M') {
          e.preventDefault();
          this.toggleAudio();
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          this.client.stepFrequency(this._targetRx, -1, e.altKey ? 1 : undefined);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          this.client.stepFrequency(this._targetRx, 1, e.altKey ? 1 : undefined);
        } else if (e.key === '+' || e.key === '=') {
          e.preventDefault();
          this._stepSpan(-1);
        } else if (e.key === '-' || e.key === '_') {
          e.preventDefault();
          this._stepSpan(1);
        } else if (e.key === 'f' || e.key === 'F') {
          e.preventDefault();
          const snap = this._getSnapshot();
          this.client.setDisplay(this._dispRx(snap), { panFrozen: !snap.panFrozen });
        } else if (e.key === '?') {
          e.preventDefault();
          this.toast('Shortcuts: Cmd/Ctrl+K Jump · M Mute · F Freeze · Space Hold-PTT (when armed) · Esc TX Panic/Close', 'info');
        }
      });

      document.addEventListener('keyup', (e) => {
        if (e.code === 'Space' && this._pttKeyHeld) {
          e.preventDefault();
          this._endHoldPtt();
        }
      });

      window.addEventListener('blur', () => {
        if (this._pttKeyHeld || this._pttHeldUi) {
          this._endHoldPtt();
        }
      });

      document.addEventListener('visibilitychange', () => {
        if (document.hidden && (this._pttKeyHeld || this._pttHeldUi || this._getSnapshot().txActive)) {
          this._endHoldPtt();
        }
      });

      window.addEventListener('pagehide', () => {
        this._endHoldPtt();
      });

      window.addEventListener('resize', () => {
        this.inspector.syncHost();
        if (this._armConfirmOpen) this._positionArmPopover();
        this._scheduleRender();
      });

      // Keep diagnostics & live TX VU/TOT crisp while open or transmitting
      setInterval(() => {
        const snap = this._getSnapshot();
        if (this._drawerOpen || this.inspector.isMobileSheetOpen() || snap.txActive) {
          this.inspector.update(snap);
        }
      }, 200);
    }

    _handleStartup() {
      const autoConnect = this._params.get('autoconnect');
      const hasPassword = this._params.has('password');
      const passwordParam = hasPassword ? this._params.get('password') || '' : null;
      if (
        hasPassword &&
        typeof window !== 'undefined' &&
        window.history &&
        typeof window.history.replaceState === 'function'
      ) {
        try {
          const cleanParams = new URLSearchParams(window.location.search);
          if (cleanParams.has('password')) {
            cleanParams.delete('password');
            const qs = cleanParams.toString();
            const cleanUrl = window.location.pathname + (qs ? `?${qs}` : '') + (window.location.hash || '');
            window.history.replaceState(window.history.state, '', cleanUrl);
          }
        } catch (_) {
          // Ignore History API errors on restricted origins.
        }
      }
      if (autoConnect === '1' || autoConnect === 'true') {
        const opts = this.connectionDialog.getOptions();
        if (hasPassword) {
          opts.password = passwordParam;
        }
        this.connect(opts).catch(() => {
          this.openConnectionDialog();
        });
      } else {
        this.openConnectionDialog();
      }
    }

    async connect(opts) {
      const finalOpts = Object.assign({}, this.connectionDialog.getOptions(), opts || {});
      this._resetTxSafety();
      this._pendingConnectClose = true;
      try {
        await this.client.connect(finalOpts);
        // If authenticated synchronously or already connected, ensure dialog closes cleanly
        const snap = this._getSnapshot();
        if (snap.connection && snap.connection.status === 'connected' && snap.connection.authStatus === 'authenticated') {
          this._pendingConnectClose = false;
          this.connectionDialog.close();
        }
      } catch (err) {
        this._pendingConnectClose = false;
        throw err;
      }
    }

    disconnect() {
      this._pendingConnectClose = false;
      this._resetTxSafety();
      this.client.disconnect();
      this.toast('Disconnected from radio', 'info');
    }

    _resetTxSafety() {
      this.closeArmConfirm();
      this._pttPointerId = null;
      this._pttKeyHeld = false;
      this._pttHeldUi = false;
      if (this.audio && typeof this.audio.stopTxCapture === 'function') {
        this.audio.stopTxCapture();
      }
      if (this.client && typeof this.client.setTxPosture === 'function') {
        this.client.setTxPosture('rx-only');
      } else if (this.gate && typeof this.gate.setPolicy === 'function') {
        this.gate.setPolicy('rx-only');
      }
    }

    _isVoiceOrAfDataMode(snap) {
      const s = snap || this._getSnapshot();
      const txVfo = s.activeTxVfo || (s.splitEnabled ? 'B' : 'A');
      const rxS = txVfo === 'B' ? (s.rxB || {}) : (s.rxA || {});
      const mode = Number(rxS.mode) || 0;
      const sub = Number(rxS.dataSubMode) || 0;
      return mode === 1 || mode === 2 || mode === 4 || mode === 5 || ((mode === 6 || mode === 9) && (sub === 0 || sub === 1));
    }

    _startTxAudioIfVoiceMode() {
      if (!this.audio || typeof this.audio.startTxCapture !== 'function') return;
      if (!this._isVoiceOrAfDataMode(this._getSnapshot())) return;
      const cfg = this._txAudioConfig;
      const secOk = typeof this.audio.isMicSecureContextAvailable === 'function'
        ? this.audio.isMicSecureContextAvailable()
        : Boolean(window.isSecureContext);
      const source = cfg.source === 'mic' && !secOk ? 'two-tone' : (cfg.source || 'two-tone');
      this.audio.startTxCapture({
        source,
        deviceId: cfg.deviceId || undefined,
        voiceProcessing: Boolean(cfg.voiceProcessing),
      }).catch((err) => {
        this.toast(`TX audio capture unavailable: ${(err && err.message) || err}`, 'error');
      });
    }

    setTxAudioConfig(patch) {
      if (!patch || typeof patch !== 'object') return;
      Object.assign(this._txAudioConfig, patch);
      this._render();
    }

    async loadTxWavFile(file) {
      if (!file || !this.audio || typeof this.audio.setTxWaveBuffer !== 'function') return;
      try {
        const buf = await file.arrayBuffer();
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) throw new Error('WebAudio unavailable');
        const ctx = new AC();
        const decoded = await ctx.decodeAudioData(buf);
        this.audio.setTxWaveBuffer(decoded.getChannelData(0), decoded.sampleRate);
        ctx.close().catch(() => {});
        this._txAudioConfig.wavName = file.name;
        this._txAudioConfig.source = 'wav';
        this.toast(`Loaded TX WAV loop: ${file.name}`, 'success');
        this._render();
      } catch (err) {
        this.toast(`WAV decode error: ${(err && err.message) || err}`, 'error');
      }
    }

    setTxPosture(target) {
      const next = target === 'tx-armed' ? 'tx-armed' : (target === 'tx-test' ? 'tx-test' : 'rx-only');
      if (next === 'rx-only') {
        this._endHoldPtt();
        this.closeArmConfirm();
        if (this.client && typeof this.client.setTxPosture === 'function') {
          this.client.setTxPosture('rx-only');
        }
        this.toast('Receive-only firewall active', 'info');
        this._render();
        return;
      }
      if (next === 'tx-test') {
        this.closeArmConfirm();
        if (this.client && typeof this.client.setTxPosture === 'function') {
          this.client.setTxPosture('tx-test');
        }
        this.toast('TX TEST (0W) active — zero RF output', 'info');
        this._render();
        return;
      }
      const cur = (this.client && typeof this.client.getTxPosture === 'function')
        ? this.client.getTxPosture()
        : (this._getSnapshot().txPosture || 'rx-only');
      if (cur === 'tx-armed') {
        this.closeArmConfirm();
        return;
      }
      this.openArmConfirm();
    }

    openArmConfirm() {
      if (!this._dom.txArmConfirm) return;
      const snap = this._getSnapshot();
      const txVfo = snap.activeTxVfo || (snap.splitEnabled ? 'B' : 'A');
      const rxS = txVfo === 'B' ? (snap.rxB || {}) : (snap.rxA || {});
      const hz = Math.max(0, Math.round(Number(rxS.freqHz) || 0));
      const mhz = Math.floor(hz / 1000000);
      const khz = String(Math.floor((hz % 1000000) / 1000)).padStart(3, '0');
      const hzp = String(hz % 1000).padStart(3, '0');
      const modeNames = { 1: 'LSB', 2: 'USB', 3: 'CW', 4: 'FM', 5: 'AM', 6: 'DATA', 7: 'CW-R', 9: 'DATA-R' };
      const dataSubNames = ['DATA-A', 'AFSK-A', 'FSK-D', 'PSK-D'];
      const modeCode = Number(rxS.mode) || 0;
      const modeStr = (modeCode === 6 || modeCode === 9)
        ? (dataSubNames[Number(rxS.dataSubMode) || 0] || 'DATA-A')
        : (modeNames[modeCode] || 'USB');
      const pRange = snap.powerRange === 'H' ? 'H' : 'L';
      const watts = Number(snap.powerWatts ?? 10);
      const antPort = Number(snap.txAntenna) || 1;
      const antLabel = snap.antennaNames && snap.antennaNames[antPort]
        ? `ANT${antPort} · ${snap.antennaNames[antPort]}`
        : `ANT${antPort}`;

      if (this._dom.txArmVfo) this._dom.txArmVfo.textContent = snap.splitEnabled ? `VFO ${txVfo} (SPLIT)` : `VFO ${txVfo}`;
      if (this._dom.txArmFreq) this._dom.txArmFreq.textContent = `${mhz}.${khz}.${hzp} MHz`;
      if (this._dom.txArmMode) this._dom.txArmMode.textContent = modeStr;
      if (this._dom.txArmPower) {
        this._dom.txArmPower.textContent = `${pRange === 'H' ? Math.round(watts) : watts.toFixed(1)} W (${pRange})`;
      }
      if (this._dom.txArmAnt) this._dom.txArmAnt.textContent = antLabel;

      this._armConfirmOpen = true;
      this._dom.txArmConfirm.hidden = false;
      this._positionArmPopover();
    }

    _positionArmPopover() {
      const pop = this._dom.txArmConfirm;
      const anchor = this._dom.txModeArmedBtn;
      if (!pop || !anchor || this._dom.txArmConfirm.hidden) return;
      const rect = anchor.getBoundingClientRect();
      const vw = window.innerWidth || 1280;
      const top = Math.min((window.innerHeight || 720) - 240, Math.max(52, rect.bottom + 8));
      const right = Math.max(12, Math.min(vw - 332, vw - rect.right));
      pop.style.top = `${Math.round(top)}px`;
      pop.style.right = `${Math.round(right)}px`;
    }

    closeArmConfirm() {
      this._armConfirmOpen = false;
      if (this._dom.txArmConfirm) {
        this._dom.txArmConfirm.hidden = true;
      }
    }

    confirmArmTx() {
      this.closeArmConfirm();
      if (this.client && typeof this.client.setTxPosture === 'function') {
        this.client.setTxPosture('tx-armed', { confirmed: true });
      }
      this.toast('LIVE RF TX ARMED — Hold PTT or Spacebar to transmit', 'info');
      this._render();
    }

    _beginHoldPtt() {
      const snap = this._getSnapshot();
      const posture = snap.txPosture || (this.client && typeof this.client.getTxPosture === 'function' ? this.client.getTxPosture() : 'rx-only');
      if (posture === 'rx-only' || snap.txInhibit) return;
      this._pttHeldUi = true;
      if (this.client && typeof this.client.startPtt === 'function') {
        this.client.startPtt({ maxSeconds: 180 });
      }
      this._render();
    }

    _endHoldPtt() {
      const wasActive = this._pttHeldUi || this._pttKeyHeld || this._pttPointerId !== null;
      this._pttPointerId = null;
      this._pttKeyHeld = false;
      this._pttHeldUi = false;
      if (this.audio && typeof this.audio.stopTxCapture === 'function') {
        this.audio.stopTxCapture();
      }
      if (wasActive && this.client && typeof this.client.stopPtt === 'function') {
        this.client.stopPtt();
      }
      this._render();
    }

    panicAbortTx(reason = 'escape') {
      this._pttPointerId = null;
      this._pttKeyHeld = false;
      this._pttHeldUi = false;
      if (this.audio && typeof this.audio.stopTxCapture === 'function') {
        this.audio.stopTxCapture();
      }
      if (this.client && typeof this.client.panicAbortTx === 'function') {
        this.client.panicAbortTx(reason);
      } else if (this.client && typeof this.client.stopPtt === 'function') {
        this.client.stopPtt();
      }
      this.toast('TX / ATU / Keyer aborted (RX)', 'info');
      this._render();
    }

    setTargetRx(rx, opts = {}) {
      const next = rx === 'B' ? 'B' : 'A';
      const clearRit = !opts || opts.keepRitWheel !== true;
      const changed = this._targetRx !== next || (clearRit && this._wheelRitMode);
      this._targetRx = next;
      if (clearRit) {
        this._wheelRitMode = false;
      }
      if (this.panadapter && this.panadapter.setTargetRx) {
        this.panadapter.setTargetRx(next);
      }
      if (clearRit && this.panadapter && this.panadapter.setWheelRitMode) {
        this.panadapter.setWheelRitMode(false);
      }
      if (changed) {
        this._render();
      }
    }

    setMouseQsyMode(mode) {
      const next = mode === 'pane' ? 'pane' : 'lr';
      this._mouseQsyMode = next;
      if (K4.storage) K4.storage.set('k4.mouseQsyMode', next);
      if (this.panadapter && this.panadapter.setMouseQsyMode) {
        this.panadapter.setMouseQsyMode(next);
      }
      this._render();
    }

    toggleWheelRitMode(force) {
      const next = typeof force === 'boolean' ? force : !this._wheelRitMode;
      this._wheelRitMode = next;
      if (this.panadapter && this.panadapter.setWheelRitMode) {
        this.panadapter.setWheelRitMode(next);
      }
      if (next) {
        const snap = this._getSnapshot();
        const rxS = (this._targetRx === 'B' ? snap.rxB : snap.rxA) || {};
        if (!rxS.ritOn && this.client && typeof this.client.setRit === 'function') {
          this.client.setRit(this._targetRx, { on: true });
        }
        this.toast(
          `Mouse wheel -> VFO ${this._targetRx} RIT (middle-click pan or click Mouse badge to exit)`,
          'info'
        );
      }
      this._render();
    }

    setPalette(name) {
      this._palette = name;
      if (K4.storage) K4.storage.set('k4.palette', name);
      if (this.panadapter && this.panadapter.setPalette) {
        this.panadapter.setPalette(name);
      }
      this._render();
    }

    setPeakHold(on) {
      this._peakHold = Boolean(on);
      if (K4.storage) K4.storage.set('k4.peakHold', this._peakHold);
      if (this.panadapter && this.panadapter.setPeakHold) {
        this.panadapter.setPeakHold(this._peakHold);
      }
      this._render();
    }

    async toggleAudio(forceMute) {
      const diag = this.audio.getDiagnostics ? this.audio.getDiagnostics() : { started: false, muted: true };
      if (!diag.started) {
        try {
          const res = await this.audio.start();
          if (res && res.started) {
            this.audio.setMuted(forceMute === true);
            this.toast(`Audio active (${res.sinkType || 'web-audio'})`, 'success');
          } else {
            this.toast('Web Audio is unavailable in this browser context', 'warn');
          }
        } catch (err) {
          this.toast(err && err.message ? err.message : 'Unable to start Web Audio', 'error');
        }
      } else {
        const nextMuted = typeof forceMute === 'boolean' ? forceMute : !this.audio.isMuted();
        this.audio.setMuted(nextMuted);
      }
      this._scheduleRender();
    }

    toggleDrawer() {
      this._drawerOpen = !this._drawerOpen;
      this._applyDrawerState();
    }

    _applyDrawerState() {
      this._dom.drawer.dataset.open = this._drawerOpen ? 'true' : 'false';
      this._dom.drawerToggleBtn.setAttribute('aria-expanded', this._drawerOpen ? 'true' : 'false');
      const triggerResize = () => {
        if (this.panadapter && this.panadapter.resize) this.panadapter.resize();
        window.dispatchEvent(new Event('resize'));
      };
      requestAnimationFrame(triggerResize);
      setTimeout(triggerResize, 200);
    }

    _cycleStep() {
      const snap = this._getSnapshot();
      const rxS = (this._targetRx === 'B' ? snap.rxB : snap.rxA) || {};
      const curIdx = Number.isFinite(rxS.stepIdx) ? rxS.stepIdx : 2;
      const nextIdx = (curIdx + 1) % 7;
      if (typeof this.client.setStep === 'function') {
        this.client.setStep(this._targetRx, nextIdx);
      } else {
        const b = K4.CatCodec && K4.CatCodec.builders;
        const cmd = b && b.step ? b.step(this._targetRx, nextIdx, rxS.mode) : `VT${this._targetRx === 'B' ? '$' : ''}${nextIdx};`;
        this.client.sendCat(cmd);
      }
    }

    _dispRx(snap) {
      return K4.CatCodec && typeof K4.CatCodec.resolveDisplayRx === 'function'
        ? K4.CatCodec.resolveDisplayRx(snap, this._targetRx)
        : snap && snap.dualPanMode === 2
        ? this._targetRx
        : snap && snap.dualPanMode === 1
        ? 'B'
        : 'A';
    }

    _resolveLoupeRx(snap) {
      const rxB = snap && snap.rxB;
      return this._targetRx === 'B' &&
        snap &&
        snap.subRxEnabled &&
        rxB &&
        rxB.miniPanAvailable !== false
        ? 'B'
        : 'A';
    }

    _stepSpan(dir) {
      const snap = this._getSnapshot();
      const dispRx = this._dispRx(snap);
      const rxS = (dispRx === 'B' ? snap.rxB : snap.rxA) || {};
      const cur =
        (this.panadapter && typeof this.panadapter.getVisibleSpanHz === 'function'
          ? this.panadapter.getVisibleSpanHz(dispRx)
          : Number(rxS.panSpanHz)) || 48000;
      let bestIdx = 0;
      let bestDiff = Infinity;
      for (let i = 0; i < SPAN_STEPS_HZ.length; i++) {
        const d = Math.abs(SPAN_STEPS_HZ[i] - cur);
        if (d < bestDiff) {
          bestDiff = d;
          bestIdx = i;
        }
      }
      const nextIdx = Math.max(0, Math.min(SPAN_STEPS_HZ.length - 1, bestIdx + dir));
      const targetSpanHz = SPAN_STEPS_HZ[nextIdx];
      if (this.panadapter && typeof this.panadapter.applyMapZoom === 'function') {
        const res = this.panadapter.applyMapZoom(dispRx, {
          targetSpanHz,
          anchorFrac: 0.5,
        });
        this.client.setDisplay(dispRx, { panSpanHz: res.radioSpanHz });
      } else {
        this.client.setDisplay(dispRx, { panSpanHz: targetSpanHz });
      }
    }

    _toggleTicker() {
      this._tickerExpanded = !this._tickerExpanded;
      this._tickerEl.dataset.expanded = this._tickerExpanded ? 'true' : 'false';
      this._tickerExpandBtn.textContent = this._tickerExpanded ? 'Collapse' : 'Expand';
    }

    _clearDecodedText() {
      const snap = this._getSnapshot();
      if (typeof this.state.clearDecodedText === 'function') {
        this.state.clearDecodedText();
      } else if (Array.isArray(snap.decodedText)) {
        snap.decodedText.length = 0;
      }
      this._lastTickerCount = 0;
      this._lastDecodedSignature = '';
      this._renderDecodedText([]);
    }

    _renderDecodedText(entries) {
      const list = Array.isArray(entries) ? entries : [];
      const last = list.length > 0 ? list[list.length - 1] : null;
      const sig = `${list.length}:${last ? `${last.rx}:${last.text}` : ''}`;
      if (sig === this._lastDecodedSignature) return;
      this._lastDecodedSignature = sig;

      this._tickerBadge.textContent = list.length > 0 ? `TB$ TEXT (${list.length})` : 'TB$ TEXT';
      this._tickerPreview.textContent = last ? `[${last.rx || 'A'}] ${last.text}` : 'Waiting for decoded CW / RTTY / PSK...';

      if (
        list.length > this._lastTickerCount &&
        this._lastTickerCount === 0 &&
        !this._tickerExpanded &&
        window.innerWidth >= 960
      ) {
        this._tickerExpanded = true;
        this._tickerEl.dataset.expanded = 'true';
        this._tickerExpandBtn.textContent = 'Collapse';
      }
      this._lastTickerCount = list.length;

      this._tickerBody.textContent = '';
      const start = Math.max(0, list.length - 60);
      for (let i = start; i < list.length; i++) {
        const entry = list[i];
        const line = el('div', 'k4-ticker-line');
        const rxBadge = el('span', 'k4-ticker-rx', entry.rx || 'A');
        rxBadge.dataset.rx = entry.rx === 'B' ? 'B' : 'A';
        const msg = el('span', 'k4-ticker-msg', entry.text || '');
        line.appendChild(rxBadge);
        line.appendChild(msg);
        this._tickerBody.appendChild(line);
      }
      this._tickerBody.scrollTop = this._tickerBody.scrollHeight;
    }

    openOmnibar(initialText) {
      this.connectionDialog.close();
      this.inspector.closeMobileSheet();
      this.omnibar.open(initialText);
    }

    openConnectionDialog() {
      this.omnibar.close();
      this.inspector.closeMobileSheet();
      this.connectionDialog.syncConnectionState(this._getSnapshot().connection);
      this.connectionDialog.open();
    }

    openMobileSheet(tabId) {
      this.inspector.toggleMobileSheet(tabId || 'tune');
    }

    closeOverlays() {
      this.closeArmConfirm();
      this.omnibar.close();
      this.connectionDialog.close();
      this.inspector.closeMobileSheet();
    }

    toast(message, level = 'info') {
      if (!this._dom.toastStack || !message) return;
      const item = el('div', 'k4-toast', String(message));
      item.dataset.level = level;
      this._dom.toastStack.appendChild(item);
      while (this._dom.toastStack.children.length > 4) {
        this._dom.toastStack.removeChild(this._dom.toastStack.firstChild);
      }
      setTimeout(() => {
        if (item.parentNode) item.parentNode.removeChild(item);
      }, 3600);
    }

    _scheduleRender() {
      if (this._rafScheduled) return;
      this._rafScheduled = true;
      requestAnimationFrame(() => {
        this._rafScheduled = false;
        this._render();
      });
    }

    _render() {
      const snap = this._getSnapshot();
      const isMobile = window.innerWidth < 960;

      // Sync AudioEngine parameters when state changes
      if (snap.audioMix && snap.audioMix !== this._lastSyncedMix) {
        this._lastSyncedMix = snap.audioMix;
        if (this.audio.setMixMode) this.audio.setMixMode(snap.audioMix);
      }
      if (Number.isFinite(snap.streamingLatency) && snap.streamingLatency !== this._lastSyncedSl) {
        this._lastSyncedSl = snap.streamingLatency;
        if (this.audio.setLatencyTier) this.audio.setLatencyTier(snap.streamingLatency);
      }

      // Connection Pill
      const conn = snap.connection || {};
      const status = conn.status || 'disconnected';
      this._dom.connBtn.dataset.status = status;
      let statusLabel = 'Disconnected';
      if (status === 'connected') {
        statusLabel = conn.radioId ? `${conn.radioId} · ${extractHostLabel(conn.wsUrl)}` : extractHostLabel(conn.wsUrl);
      } else if (status === 'connecting') {
        statusLabel = 'Connecting...';
      } else if (status === 'authenticating') {
        statusLabel = 'Authenticating...';
      } else if (status === 'error') {
        statusLabel = 'Error';
      }
      this._dom.connLabel.textContent = statusLabel;
      this._dom.connRtt.textContent = (status === 'connected' && conn.rttMs !== null && conn.rttMs !== undefined)
        ? `${conn.rttMs}ms`
        : '';

      // VFOs & S-Meter
      this.vfoAWidget.update(snap, this._targetRx, isMobile);
      this.vfoBWidget.update(snap, this._targetRx, isMobile);
      this.smeterWidget.update(snap, this._targetRx);

      // Audio Toggle Button
      const aDiag = this.audio.getDiagnostics ? this.audio.getDiagnostics() : { started: false, muted: true };
      if (!aDiag.started) {
        this._dom.audioToggleBtn.dataset.state = 'off';
        this._dom.audioLabel.textContent = 'Audio Off';
      } else if (aDiag.muted) {
        this._dom.audioToggleBtn.dataset.state = 'muted';
        this._dom.audioLabel.textContent = 'Muted';
      } else {
        this._dom.audioToggleBtn.dataset.state = 'active';
        const modeTxt = snap.encodeMode === 2 || snap.encodeMode === 3 ? 'Opus 48k' : (snap.encodeMode === 0 ? 'PCM 24b' : 'PCM 12k');
        this._dom.audioLabel.textContent = modeTxt;
      }

      // TX Safety Posture Bar, Hold-Only PTT & RX-Only Badge count
      const gStats = this.gate.getStats ? this.gate.getStats() : { blockedCatCount: 0, blockedBinaryCount: 0 };
      const blockedTotal = (gStats.blockedCatCount || 0) + (gStats.blockedBinaryCount || 0);
      this._dom.rxOnlyBadge.dataset.blocked = blockedTotal > 0 ? 'true' : 'false';
      this._dom.rxBlockedCount.hidden = blockedTotal === 0;
      this._dom.rxBlockedCount.textContent = String(blockedTotal);

      const posture = snap.txPosture || (this.client && typeof this.client.getTxPosture === 'function' ? this.client.getTxPosture() : 'rx-only');
      const transmitting = Boolean(snap.txActive || snap.atuTuning);
      const badgeLabel = this._dom.rxOnlyBadge.querySelector('.k4-rx-badge-text');
      if (badgeLabel) {
        badgeLabel.textContent = posture === 'rx-only' ? 'SAFE' : (posture === 'tx-test' ? 'TEST' : (transmitting ? 'ON AIR' : 'ARMED'));
      }
      if (this._dom.txPostureBar) {
        this._dom.txPostureBar.dataset.posture = posture;
        this._dom.txPostureBar.dataset.transmitting = transmitting ? 'true' : 'false';
      }
      const syncPostureBtn = (btn, target) => {
        if (!btn) return;
        const active = posture === target;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      };
      syncPostureBtn(this._dom.txModeRxBtn, 'rx-only');
      syncPostureBtn(this._dom.txModeTestBtn, 'tx-test');
      syncPostureBtn(this._dom.txModeArmedBtn, 'tx-armed');

      if (this._dom.pttBtn) {
        const pttEnabled = posture !== 'rx-only' && !snap.txInhibit;
        this._dom.pttBtn.disabled = !pttEnabled;
        const pttActive = Boolean(this._pttHeldUi || snap.pttHeld || snap.txActive);
        this._dom.pttBtn.classList.toggle('is-held', Boolean(this._pttHeldUi || snap.pttHeld));
        this._dom.pttBtn.classList.toggle('is-tx', Boolean(snap.txActive));
        this._dom.pttBtn.setAttribute('aria-pressed', pttActive ? 'true' : 'false');
        this._dom.pttBtn.textContent = snap.txActive ? (posture === 'tx-test' ? 'TEST TX' : 'ON AIR') : 'PTT';
      }

      // Floating Panadapter HUD
      const rxS = (this._targetRx === 'B' ? snap.rxB : snap.rxA) || {};
      const dispRx = this._dispRx(snap);
      const dispS = (dispRx === 'B' ? snap.rxB : snap.rxA) || {};
      const loupeRx = this._resolveLoupeRx(snap);
      const loupeS = (loupeRx === 'B' ? snap.rxB : snap.rxA) || {};
      this._hudTargetLabel.textContent = this._wheelRitMode
        ? `Mouse: RIT ${this._targetRx}`
        : `Mouse: ${this._targetRx}`;
      this._hudTargetBtn.classList.toggle('is-cyan', !this._wheelRitMode && this._targetRx === 'A');
      this._hudTargetBtn.classList.toggle('is-amber', !this._wheelRitMode && this._targetRx === 'B');
      this._hudTargetBtn.classList.toggle('is-rit', Boolean(this._wheelRitMode));
      const qsyDesc =
        this._mouseQsyMode === 'pane'
          ? 'Left Only (Pane=VFO, Shift+Left=B)'
          : 'Left=A, Right=B (in either pane)';
      this._hudTargetBtn.title = `K4 Mouse (${qsyDesc}). Wheel tunes ${this._wheelRitMode ? `VFO ${this._targetRx} RIT` : `VFO ${this._targetRx}`}. Click/Right-click to switch A/B; middle-click or Shift-click to toggle RIT wheel.`;
      this._hudStepBtn.textContent = `Step: ${rxS.stepHz >= 1000 ? `${rxS.stepHz / 1000}k` : `${rxS.stepHz || 100} Hz`}`;
      const visSpanHz =
        (this.panadapter && typeof this.panadapter.getVisibleSpanHz === 'function'
          ? this.panadapter.getVisibleSpanHz(dispRx)
          : dispS.panSpanHz) || 48000;
      this._hudSpanReadout.textContent =
        visSpanHz < 20000 && visSpanHz % 1000 !== 0
          ? `${(visSpanHz / 1000).toFixed(1)} kHz`
          : `${Math.round(visSpanHz / 1000)} kHz`;
      if (this._hudCenterBtn) {
        this._hudCenterBtn.hidden = !(
          this.panadapter &&
          typeof this.panadapter.isViewportOffset === 'function' &&
          this.panadapter.isViewportOffset(dispRx)
        );
      }
      const dpm = snap.dualPanMode === 1 ? 1 : snap.dualPanMode === 2 ? 2 : 0;
      this._hudDualBtn.textContent = dpm === 2 ? '2x' : dpm === 1 ? '1xB' : '1x';
      this._hudDualBtn.classList.toggle('is-active', dpm === 2);
      this._hudDualBtn.disabled = snap.hasSubRx === false;
      this._hudDualBtn.title =
        snap.hasSubRx === false
          ? 'Requires Sub-RX option (OM lacks S)'
          : 'Toggle Dual Panadapter (#DPM)';
      this._hudLoupeBtn.textContent = `Loupe ${loupeRx}`;
      this._hudLoupeBtn.classList.toggle('is-active', Boolean(loupeS.miniPan));
      this._hudFreezeBtn.textContent = snap.panFrozen ? 'Frozen' : 'Freeze';
      this._hudFreezeBtn.classList.toggle('is-active', Boolean(snap.panFrozen));

      // Decoded Text Ticker (TB$)
      if (this._tickerDecodeSelect && typeof K4.syncDecodeSelect === 'function') {
        K4.syncDecodeSelect(this._tickerDecodeSelect, rxS);
      }
      this._renderDecodedText(snap.decodedText);

      // Inspector & Mobile Sheets
      this.inspector.update(snap);
    }
  }

  K4.App = App;

  function boot() {
    if (!globalThis.k4App) {
      globalThis.k4App = new App();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
