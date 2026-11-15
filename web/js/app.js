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
      this._peakHold = K4.storage ? K4.storage.get('k4.peakHold.v2', false) === true : false;
      this._drawerOpen = window.innerWidth >= 1200;
      this._tickerExpanded = false;
      this._lastTickerCount = 0;
      this._lastDecodedSignature = '';
      this._rafScheduled = false;
      this._meterRafScheduled = false;
      this._pendingMeterKeys = new Set();
      this._pendingConnectClose = false;
      this._lastSyncedMix = null;
      this._lastSyncedSl = null;
      this._lastConnStatus = null;
      this._lastAuthStatus = null;
      this._lastHudCwMode = null;
      this._a2bWindowUntil = 0;
      this._a2bCueTimer = null;
      this._atuTopCueTimer = null;
      this._pttPointerId = null;
      this._pttKeyHeld = false;
      this._pttHeldUi = false;
      this._lastSensorTickMs = 0;
      this._uiPerf =
        typeof window !== 'undefined'
          ? (window.__k4UiPerf = window.__k4UiPerf || {
              fullRenders: 0,
              meterFastRenders: 0,
              inspectorUpdates: 0,
              inspectorTabSkips: 0,
              afScopeSkips: 0,
            })
          : null;
      const hasSecureMic = Boolean(
        globalThis.isSecureContext &&
          globalThis.navigator &&
          globalThis.navigator.mediaDevices &&
          typeof globalThis.navigator.mediaDevices.getUserMedia === 'function'
      );
      this._txAudioConfig = {
        source: hasSecureMic ? 'mic' : 'two-tone',
        deviceId: '',
        voiceProcessing: false,
        wavName: '',
      };

      this.state = new K4.RadioState();
      this.gate = new K4.RxOnlyGate('tx-enabled');
      this.client = new K4.Client({ state: this.state, gate: this.gate });
      this.audio = new K4.AudioEngine({ state: this.state });

      this._dom = {
        connBtn: document.getElementById('conn-btn'),
        connLabel: document.querySelector('#conn-btn .k4-conn-label'),
        connRtt: document.querySelector('#conn-btn .k4-conn-rtt'),
        vfoAMount: document.getElementById('vfo-a-mount'),
        vfoBMount: document.getElementById('vfo-b-mount'),
        vfoCluster: document.getElementById('vfo-cluster'),
        vfoAbBtn: document.getElementById('vfo-ab-btn'),
        vfoA2bBtn: document.getElementById('vfo-a2b-btn'),
        vfoSplitBtn: document.getElementById('vfo-split-btn'),
        vfoSubBtn: document.getElementById('vfo-sub-btn'),
        smeterMount: document.getElementById('smeter-mount'),
        omnibarBtn: document.getElementById('omnibar-btn'),
        audioToggleBtn: document.getElementById('audio-toggle'),
        audioLabel: document.querySelector('#audio-toggle .k4-audio-label'),
        topAntBtn: document.getElementById('top-ant-btn'),
        topAtuBtn: document.getElementById('top-atu-btn'),
        txPostureBar: document.getElementById('tx-posture-bar'),
        txModeTestBtn: document.getElementById('tx-mode-test'),
        txMicBtn: document.getElementById('tx-mic-btn'),
        txMicLabel: document.getElementById('tx-mic-label'),
        pttBtn: document.getElementById('ptt-btn'),
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
      this._hudCenterBtn.title = 'Re-center zoomed panadapter viewport on VFO';
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
      this._hudDualBtn.title = 'Toggle Dual Panadapter';
      this._hudDualBtn.addEventListener('click', () => {
        const snap = this._getSnapshot();
        const next = snap.dualPanMode === 2 ? 0 : 2;
        this.client.setDisplay(this._dispRx(snap), { dualPanMode: next });
      });
      group.appendChild(this._hudDualBtn);

      this._hudLoupeBtn = el('button', 'k4-hud-btn', 'Mini-Pan A');
      this._hudLoupeBtn.type = 'button';
      this._hudLoupeBtn.title = 'Toggle Mini-Pan';
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
      this._hudFreezeBtn.title = 'Freeze/Unfreeze Panadapter';
      this._hudFreezeBtn.addEventListener('click', () => {
        const snap = this._getSnapshot();
        this.client.setDisplay(this._dispRx(snap), { panFrozen: !snap.panFrozen });
      });
      group.appendChild(this._hudFreezeBtn);

      group.appendChild(el('span', 'k4-hud-sep'));

      this._hudAutoSpotBtn = el('button', 'k4-hud-btn', 'Auto Spot');
      this._hudAutoSpotBtn.id = 'hud-auto-spot-btn';
      this._hudAutoSpotBtn.type = 'button';
      this._hudAutoSpotBtn.dataset.testid = 'auto-spot-btn';
      this._hudAutoSpotBtn.title = 'Zero-beat CW signal on active VFO';
      this._hudAutoSpotBtn.addEventListener('click', () => {
        if (typeof this.client.autoSpot === 'function') {
          this.client.autoSpot(this._targetRx);
        } else {
          this.client.sendCat(`SP${this._targetRx === 'B' ? '$' : ''}3;`);
        }
      });
      group.appendChild(this._hudAutoSpotBtn);

      this._hudCwSpotBtn = el('button', 'k4-hud-btn', 'Spot');
      this._hudCwSpotBtn.id = 'hud-cw-spot-btn';
      this._hudCwSpotBtn.type = 'button';
      this._hudCwSpotBtn.dataset.testid = 'cw-spot-btn';
      this._hudCwSpotBtn.setAttribute('aria-pressed', 'false');
      this._hudCwSpotBtn.title = 'Toggle CW Spot sidetone';
      this._hudCwSpotBtn.addEventListener('click', () => {
        const snap = this._getSnapshot();
        const rxS = (this._targetRx === 'B' ? snap.rxB : snap.rxA) || {};
        const nextOn = !(snap.spotTone || snap.cwSpotOn || rxS.spotMode === 1 || rxS.spotMode === 2);
        if (typeof this.client.setSpotTone === 'function') {
          this.client.setSpotTone(nextOn ? 1 : 0, 'A');
        } else {
          this.client.sendCat(`SP${nextOn ? '1' : '0'};`);
        }
      });
      group.appendChild(this._hudCwSpotBtn);

      hudTop.appendChild(group);
      stage.appendChild(hudTop);

      // Bottom-left Decoded Text Ticker (TB$)
      const ticker = el('section', 'k4-text-ticker');
      ticker.id = 'text-ticker';
      ticker.dataset.testid = 'text-ticker';
      ticker.dataset.expanded = 'false';

      const tHead = el('div', 'k4-ticker-header');
      const tSum = el('div', 'k4-ticker-summary');
      this._tickerBadge = el('span', 'k4-ticker-badge', 'DECODE');
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
        onToggleTxTest: () => this.toggleTxTest(),
        onPanicAbort: () => this.panicAbortTx('ui-panic'),
        getTxAudioConfig: () => this._txAudioConfig,
        onSetTxAudioConfig: (patch) => this.setTxAudioConfig(patch),
        onLoadTxWav: (file) => this.loadTxWavFile(file),
        isDrawerOpen: () => this._drawerOpen,
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
        const cmd = (info && (info.command || info.cmd)) || 'command';
        this.toast(`Blocked ${cmd} in RX-only mode`, 'blocked');
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

      if (this.audio && typeof this.audio.on === 'function') {
        this.audio.on('micStatus', (st) => {
          if (st && st.state === 'ready' && this.inspector && typeof this.inspector._refreshMicDevices === 'function') {
            this.inspector._refreshMicDevices();
          }
          this._render();
        });
        this.audio.on('mute', () => {
          this._syncAudioToggleUi(this._getSnapshot());
          if (this.inspector && typeof this.inspector._syncAfScopeLoop === 'function') {
            this.inspector._syncAfScopeLoop();
          }
        });
        this.audio.on('mediaAction', () => {
          this._syncAudioToggleUi(this._getSnapshot());
          if (this.inspector && typeof this.inspector._syncAfScopeLoop === 'function') {
            this.inspector._syncAfScopeLoop();
          }
        });
        this.audio.on('stopped', () => {
          this._syncAudioToggleUi(this._getSnapshot());
          if (this.inspector && typeof this.inspector._syncAfScopeLoop === 'function') {
            this.inspector._syncAfScopeLoop();
          }
        });
      }

      const METER_ONLY_KEYS = new Set([
        'rxA.sMeterDbm',
        'rxB.sMeterDbm',
        'rxA.panMeta',
        'rxB.panMeta',
        'txMeters',
        'telemetry',
        'connection.rttMs',
        'latency',
        'swr',
        'alc',
        'power',
        'idd',
        'vdd',
        'temp',
      ]);

      this.state.on('change', (snap, changedKey, changedKeys) => {
        const keyList =
          changedKeys && typeof changedKeys[Symbol.iterator] === 'function'
            ? Array.from(changedKeys)
            : changedKey
            ? [changedKey]
            : ['state'];

        const conn = snap && snap.connection ? snap.connection : {};
        const connStatus = conn.status || 'disconnected';
        const connAuthStatus = conn.authStatus || null;
        const connMetaUnchanged =
          connStatus === this._lastConnStatus && connAuthStatus === this._lastAuthStatus;

        let allMeterOnly = keyList.length > 0;
        for (let i = 0; i < keyList.length; i++) {
          const k = keyList[i];
          if (METER_ONLY_KEYS.has(k)) continue;
          if (k === 'connection' && connMetaUnchanged) continue;
          allMeterOnly = false;
          break;
        }

        if (allMeterOnly) {
          this._scheduleMeterRender(keyList);
        } else {
          this._render(keyList);
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

      // VFO Cluster (Item 10)
      if (this._dom.vfoAbBtn) {
        let abHoldTimer = null;
        let abHoldTriggered = false;
        const clearAbHold = () => {
          if (abHoldTimer) {
            clearTimeout(abHoldTimer);
            abHoldTimer = null;
          }
        };
        this._dom.vfoAbBtn.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          abHoldTriggered = false;
          clearAbHold();
          abHoldTimer = setTimeout(() => {
            abHoldTimer = null;
            abHoldTriggered = true;
            if (typeof this.client.vfoCopy === 'function') this.client.vfoCopy(5);
            else this.client.sendCat('AB5;');
            this.toast('VFO A ↔ B full swap', 'info');
          }, 450);
        });
        this._dom.vfoAbBtn.addEventListener('pointerup', clearAbHold);
        this._dom.vfoAbBtn.addEventListener('pointercancel', clearAbHold);
        this._dom.vfoAbBtn.addEventListener('pointerleave', clearAbHold);
        this._dom.vfoAbBtn.addEventListener('click', (e) => {
          if (abHoldTriggered) {
            abHoldTriggered = false;
            return;
          }
          const code = e.shiftKey ? 5 : 2;
          if (typeof this.client.vfoCopy === 'function') this.client.vfoCopy(code);
          else this.client.sendCat(`AB${code};`);
          if (e.shiftKey) this.toast('VFO A ↔ B full swap', 'info');
        });
      }
      if (this._dom.vfoA2bBtn) {
        this._dom.vfoA2bBtn.addEventListener('click', (e) => {
          const now = Date.now();
          const doFull = e.shiftKey || now < this._a2bWindowUntil;
          if (this._a2bCueTimer) {
            clearTimeout(this._a2bCueTimer);
            this._a2bCueTimer = null;
          }
          if (doFull) {
            this._a2bWindowUntil = 0;
            this._dom.vfoA2bBtn.dataset.window = 'freq';
            if (typeof this.client.vfoCopy === 'function') this.client.vfoCopy(3);
            else this.client.sendCat('AB3;');
            this.toast('VFO A → B full copy', 'info');
          } else {
            this._a2bWindowUntil = now + 3000;
            this._dom.vfoA2bBtn.dataset.window = 'full';
            if (typeof this.client.vfoCopy === 'function') this.client.vfoCopy(0);
            else this.client.sendCat('AB0;');
            this._a2bCueTimer = setTimeout(() => {
              this._a2bCueTimer = null;
              this._a2bWindowUntil = 0;
              if (this._dom.vfoA2bBtn) this._dom.vfoA2bBtn.dataset.window = 'freq';
            }, 3020);
          }
        });
      }
      if (this._dom.vfoSplitBtn) {
        this._dom.vfoSplitBtn.addEventListener('click', (e) => {
          const snap = this._getSnapshot();
          if (e.shiftKey && typeof this.client.setupQuickSplit === 'function') {
            this.client.setupQuickSplit(1000);
            this.toast('Quick Split (+1 kHz on VFO B)', 'info');
          } else {
            this.client.setSplit(!snap.splitEnabled);
          }
        });
      }
      if (this._dom.vfoSubBtn) {
        this._dom.vfoSubBtn.addEventListener('click', () => {
          const snap = this._getSnapshot();
          this.client.setSubRx(!snap.subRxEnabled);
        });
      }

      // Top-bar ANT & ATU pills (Item 13)
      if (this._dom.topAntBtn) {
        this._dom.topAntBtn.addEventListener('click', () => {
          if (typeof this.client.cycleTxAntenna === 'function') {
            this.client.cycleTxAntenna();
          } else {
            const cur = Number(this._getSnapshot().txAntenna) || 1;
            this.client.setTxAntenna((cur % 3) + 1);
          }
        });
      }
      if (this._dom.topAtuBtn) {
        this._dom.topAtuBtn.addEventListener('click', (e) => {
          const snap = this._getSnapshot();
          if (snap.hasAtu === false) return;
          if (snap.atuTuning) {
            if (typeof this.client.stopAtuTune === 'function') this.client.stopAtuTune();
            else this.client.sendCat('TU0;');
            return;
          }
          if (e.shiftKey) {
            if (typeof this.client.startAtuTune === 'function') this.client.startAtuTune();
            else {
              const hot = Number(snap.atuSearchWindowUntil) > Date.now();
              this.client.sendCat(hot ? 'TU4;' : 'TU3;');
            }
            return;
          }
          const nextMode = Number(snap.atuMode) === 2 ? 1 : 2;
          if (typeof this.client.setAtuMode === 'function') this.client.setAtuMode(nextMode);
          else this.client.sendCat(`AT${nextMode};`);
        });
      }

      // TX Test & Mic status controls
      if (this._dom.txModeTestBtn) {
        this._dom.txModeTestBtn.addEventListener('click', () => this.toggleTxTest());
      }
      if (this._dom.txMicBtn) {
        this._dom.txMicBtn.addEventListener('click', () => {
          const st = this.audio && typeof this.audio.getMicStatus === 'function'
            ? this.audio.getMicStatus()
            : { state: 'idle' };
          if (
            this._txAudioConfig.source === 'mic' &&
            (st.state === 'idle' || st.state === 'denied' || st.state === 'error' || st.state === 'unavailable') &&
            this.audio &&
            typeof this.audio.ensureMicReady === 'function'
          ) {
            this._syncTxMicStandby();
          }
          if (this.inspector && typeof this.inspector.openTab === 'function') {
            this.inspector.openTab('tx');
          }
          this._render();
        });
      }

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
          const modalOpen =
            this.omnibar.isOpen() ||
            this.connectionDialog.isOpen() ||
            this.inspector.isMobileSheetOpen();
          const txBusy = Boolean(
            snap.txActive || snap.pttHeld || this._pttHeldUi || snap.atuTuning || Number(snap.txBufferCount) > 0
          );
          if (txBusy) {
            e.preventDefault();
            this.panicAbortTx('escape');
            this.closeOverlays();
            return;
          }
          if (modalOpen) {
            e.preventDefault();
            this.closeOverlays();
          }
          return;
        }

        const tag = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : '';
        const isEditing = tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable);
        const modalOpen = this.omnibar.isOpen() || this.connectionDialog.isOpen();
        if (isEditing || modalOpen) {
          return;
        }

        if (e.code === 'Space') {
          const snap = this._getSnapshot();
          const posture = snap.txPosture || (typeof this.client.getTxPosture === 'function' ? this.client.getTxPosture() : 'tx-armed');
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
          this.toast('Shortcuts: Cmd/Ctrl+K Jump · M Mute · F Freeze · Space Hold-PTT · Esc Stop TX / Close', 'info');
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
        if (this.inspector && typeof this.inspector._syncAfScopeLoop === 'function') {
          this.inspector._syncAfScopeLoop();
        }
      });

      window.addEventListener('pagehide', () => {
        this._endHoldPtt();
      });

      window.addEventListener('resize', () => {
        this.inspector.syncHost();
        if (this.inspector && typeof this.inspector.onDrawerVisibilityChange === 'function') {
          this.inspector.onDrawerVisibilityChange();
        }
        this._scheduleRender();
      });

      // Keep diagnostics, sensor history & live latency/TOT crisp while connected
      setInterval(() => {
        const snap = this._getSnapshot();
        const now = Date.now();
        if (
          snap.connection &&
          snap.connection.status === 'connected' &&
          now - this._lastSensorTickMs >= 950
        ) {
          this._lastSensorTickMs = now;
          if (this.state && typeof this.state.recordSensorTick === 'function') {
            this.state.recordSensorTick();
          }
        }
        if (typeof document !== 'undefined' && document.hidden) {
          return;
        }
        const aDiag = this.audio && this.audio.getDiagnostics ? this.audio.getDiagnostics() : { started: false, muted: true };
        if (snap.connection && snap.connection.status === 'connected') {
          this._updateConnLatency(snap, aDiag);
        }
        const visibleTab =
          this.inspector && typeof this.inspector._getVisibleTabId === 'function'
            ? this.inspector._getVisibleTabId()
            : null;
        if (visibleTab === 'audio' || visibleTab === 'tx' || snap.txActive) {
          this.inspector.update(snap, ['telemetry', 'audio', 'txMeters']);
        } else if (this._drawerOpen && this.inspector && typeof this.inspector._updateSensorStrip === 'function') {
          this.inspector._updateSensorStrip(snap);
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
      this._pttPointerId = null;
      this._pttKeyHeld = false;
      this._pttHeldUi = false;
      if (this.audio && typeof this.audio.stopTxCapture === 'function') {
        this.audio.stopTxCapture();
      }
      if (this.audio && typeof this.audio.releaseMicStandby === 'function') {
        this.audio.releaseMicStandby();
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

    _syncTxMicStandby(postureOverride) {
      if (!this.audio) return;
      const snap = this._getSnapshot();
      const posture =
        postureOverride ||
        snap.txPosture ||
        (this.client && typeof this.client.getTxPosture === 'function'
          ? this.client.getTxPosture()
          : 'tx-armed');
      const txEnabled =
        posture === 'tx-armed' || posture === 'tx-test' || Boolean(snap.txTestMode);
      if (!txEnabled || this._txAudioConfig.source !== 'mic') {
        if (typeof this.audio.releaseMicStandby === 'function') {
          this.audio.releaseMicStandby();
        }
        return;
      }
      if (typeof this.audio.ensureMicReady === 'function') {
        this.audio.ensureMicReady({
          deviceId: this._txAudioConfig.deviceId || '',
          voiceProcessing: Boolean(this._txAudioConfig.voiceProcessing),
        }).then((st) => {
          if (st && st.state === 'ready' && this.inspector && typeof this.inspector._refreshMicDevices === 'function') {
            this.inspector._refreshMicDevices();
          } else if (st && st.state === 'denied') {
            this.toast('Microphone permission denied — click the MIC badge or TX tab to retry or pick a test tone', 'warn');
          } else if (st && (st.state === 'unavailable' || st.state === 'error')) {
            this.toast(`Microphone unavailable: ${st.error || 'No input device'}`, 'warn');
          }
          this._render();
        });
      }
    }

    setTxAudioConfig(patch) {
      if (!patch || typeof patch !== 'object') return;
      Object.assign(this._txAudioConfig, patch);
      this._syncTxMicStandby();
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

    toggleTxTest() {
      const snap = this._getSnapshot();
      const posture = (this.client && typeof this.client.getTxPosture === 'function')
        ? this.client.getTxPosture()
        : (snap.txPosture || 'tx-armed');
      this._endHoldPtt();
      const next = !(Boolean(snap.txTestMode) || posture === 'tx-test');
      if (this.client && typeof this.client.setTxTest === 'function') {
        this.client.setTxTest(next);
      }
      this._syncTxMicStandby(next ? 'tx-test' : 'tx-armed');
      this.toast(
        next ? 'TX Test ON — RF output inhibited' : 'TX Test OFF — TX Ready',
        'info'
      );
      this._render();
    }

    _beginHoldPtt() {
      const snap = this._getSnapshot();
      const posture = snap.txPosture || (this.client && typeof this.client.getTxPosture === 'function' ? this.client.getTxPosture() : 'tx-armed');
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
      if (this.audio && typeof this.audio.releaseMicStandby === 'function') {
        this.audio.releaseMicStandby();
      }
      this.toast('Stopped TX / returned to receive', 'info');
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
      if (K4.storage) K4.storage.set('k4.peakHold.v2', this._peakHold);
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
      if (this.inspector && typeof this.inspector.onDrawerVisibilityChange === 'function') {
        this.inspector.onDrawerVisibilityChange();
      }
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
      const start = Math.max(0, list.length - 60);
      let sig = String(list.length);
      for (let i = start; i < list.length; i++) {
        const e = list[i];
        const t = e && typeof e.text === 'string' ? e.text : '';
        sig += `|${e ? e.id : ''}:${e ? e.rx : ''}:${t.length}:${t.slice(-8)}`;
      }
      if (sig === this._lastDecodedSignature) return;
      this._lastDecodedSignature = sig;

      this._tickerBadge.textContent = 'DECODE';
      let latest = list.length > 0 ? list[list.length - 1] : null;
      for (let i = start; i < list.length; i++) {
        const e = list[i];
        if (e && latest && Number(e.timestamp || 0) > Number(latest.timestamp || 0)) {
          latest = e;
        }
      }
      if (latest) {
        const latestText = typeof latest.text === 'string' ? latest.text : String(latest.text || '');
        const previewTxt = latestText.length > 44 ? '…' + latestText.slice(-44) : latestText;
        this._tickerPreview.textContent = `[${latest.rx || 'A'}] ${previewTxt}`;
      } else {
        this._tickerPreview.textContent = 'Waiting for decoded CW / RTTY / PSK...';
      }

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

    _scheduleMeterRender(keys) {
      if (Array.isArray(keys)) {
        for (let i = 0; i < keys.length; i++) {
          this._pendingMeterKeys.add(keys[i]);
        }
      }
      if (this._meterRafScheduled || this._rafScheduled) return;
      this._meterRafScheduled = true;
      requestAnimationFrame(() => {
        this._meterRafScheduled = false;
        this._renderMetersAndLatency();
      });
    }

    _renderMetersAndLatency() {
      const pending = Array.from(this._pendingMeterKeys);
      this._pendingMeterKeys.clear();
      if (this._uiPerf) this._uiPerf.meterFastRenders += 1;

      const snap = this._getSnapshot();
      const aDiag = this.audio && this.audio.getDiagnostics ? this.audio.getDiagnostics() : { started: false, muted: true };
      this.smeterWidget.update(snap, this._targetRx);
      this._updateConnLatency(snap, aDiag);

      if (this._dom.topAtuBtn && (pending.includes('txMeters') || pending.includes('swr'))) {
        this._syncTopRfStatus(snap);
      }

      if (!this.inspector) return;
      if (this.inspector.isDrawerOpen && this.inspector.isDrawerOpen()) {
        if (typeof this.inspector._updateSensorStrip === 'function') {
          this.inspector._updateSensorStrip(snap);
        }
        const visTab = typeof this.inspector._getVisibleTabId === 'function' ? this.inspector._getVisibleTabId() : null;
        const touchesAudio = pending.some((k) => k === 'connection.rttMs' || k === 'latency' || k === 'telemetry');
        const touchesTx = pending.some(
          (k) => k === 'txMeters' || k === 'telemetry' || k === 'swr' || k === 'alc' || k === 'power' || k === 'idd' || k === 'vdd' || k === 'temp'
        );
        if (touchesAudio) {
          if (visTab === 'audio' && typeof this.inspector._updateAudioTab === 'function') {
            const rxS = (this._targetRx === 'B' ? snap.rxB : snap.rxA) || {};
            this.inspector._updateAudioTab(snap, rxS, aDiag);
          } else if (this.inspector._dirtyTabs) {
            this.inspector._dirtyTabs.add('audio');
          }
        }
        if (touchesTx) {
          if (visTab === 'tx' && typeof this.inspector._updateTxTab === 'function') {
            this.inspector._updateTxTab(snap, aDiag);
          } else if (this.inspector._dirtyTabs) {
            this.inspector._dirtyTabs.add('tx');
          }
        }
      } else if (this.inspector._dirtyTabs) {
        this.inspector._dirtyTabs.add('audio');
        this.inspector._dirtyTabs.add('tx');
      }
    }

    _syncAudioToggleUi(snap, aDiagOverride) {
      if (!this._dom.audioToggleBtn || !this._dom.audioLabel) return;
      const aDiag =
        aDiagOverride || (this.audio && this.audio.getDiagnostics ? this.audio.getDiagnostics() : { started: false, muted: true });
      if (!aDiag.started) {
        this._dom.audioToggleBtn.dataset.state = 'off';
        this._dom.audioLabel.textContent = 'Audio Off';
        this._dom.audioToggleBtn.setAttribute('aria-pressed', 'false');
      } else if (aDiag.muted) {
        this._dom.audioToggleBtn.dataset.state = 'muted';
        this._dom.audioLabel.textContent = 'Muted';
        this._dom.audioToggleBtn.setAttribute('aria-pressed', 'false');
      } else {
        this._dom.audioToggleBtn.dataset.state = 'active';
        const modeTxt = snap.encodeMode === 2 || snap.encodeMode === 3 ? 'Opus 48k' : (snap.encodeMode === 0 ? 'PCM 24b' : 'PCM 12k');
        this._dom.audioLabel.textContent = modeTxt;
        this._dom.audioToggleBtn.setAttribute('aria-pressed', 'true');
      }
    }

    _updateConnLatency(snap, aDiagOverride) {
      if (!this._dom.connBtn || !this._dom.connRtt) return;
      const conn = snap.connection || {};
      const status = conn.status || 'disconnected';
      if (status !== 'connected' || conn.rttMs === null || conn.rttMs === undefined) {
        this._dom.connBtn.dataset.hasLatency = 'false';
        this._dom.connRtt.textContent = '';
        this._dom.connBtn.title = 'K4 Connection & Settings';
        return;
      }

      const rttNum = Math.max(0, Math.round(Number(conn.rttMs)));
      if (this.audio && typeof this.audio.updateNetworkRtt === 'function') {
        this.audio.updateNetworkRtt(rttNum);
      }
      const diag =
        aDiagOverride || (this.audio && this.audio.getDiagnostics ? this.audio.getDiagnostics() : { started: false, muted: true });
      const brk =
        (this.audio && typeof this.audio.getLatencyBreakdown === 'function'
          ? this.audio.getLatencyBreakdown(rttNum)
          : diag.latency) || {};
      const audioActive = Boolean(diag.started && !diag.muted);
      const e2eRxNum = Number.isFinite(brk.e2eRxMs) ? Math.round(brk.e2eRxMs) : null;
      const e2eTxNum = Number.isFinite(brk.e2eTxMs) ? Math.round(brk.e2eTxMs) : null;

      this._dom.connBtn.dataset.hasLatency = 'true';
      this._dom.connRtt.textContent = audioActive && e2eRxNum !== null ? `E2E ${e2eRxNum}ms` : `RTT ${rttNum}ms`;

      const halfRtt = Number.isFinite(brk.rxNetHalfRttMs) ? Math.round(brk.rxNetHalfRttMs) : Math.round(rttNum / 2);
      const frame = Number.isFinite(brk.rxFrameMs) ? Math.round(brk.rxFrameMs) : 20;
      const jitter = Number.isFinite(brk.rxJitterMs) ? Math.round(brk.rxJitterMs) : 0;
      const outMs = Number.isFinite(brk.rxAudioOutMs) ? Math.round(brk.rxAudioOutMs) : 0;
      const rxTotal = e2eRxNum !== null ? e2eRxNum : rttNum;
      this._dom.connBtn.title = `Connected · Net ½RTT ${halfRtt}ms · Frame ${frame}ms · Jitter ${jitter}ms · Out ${outMs}ms · RX E2E ${rxTotal}ms${e2eTxNum !== null ? ` · TX E2E ${e2eTxNum}ms` : ''} (click for settings)`;
    }

    _syncTopRfStatus(snap) {
      if (this._dom.topAntBtn) {
        const port = Number(snap.txAntenna) || 1;
        const names = snap.antennaNames || {};
        const rawName = names[port] ? String(names[port]).trim() : '';
        const hasCustom = rawName && rawName.replace(/\s+/g, '').toUpperCase() !== `ANT${port}`;
        this._dom.topAntBtn.textContent = hasCustom ? `ANT ${port} · ${rawName}` : `ANT ${port}`;
        this._dom.topAntBtn.dataset.port = String(port);
        this._dom.topAntBtn.title = `Active TX Antenna ANT ${port}${hasCustom ? ` (${rawName})` : ''} — click to cycle ANT 1 → 2 → 3`;
      }

      if (this._dom.topAtuBtn) {
        const btn = this._dom.topAtuBtn;
        if (this._atuTopCueTimer) {
          clearTimeout(this._atuTopCueTimer);
          this._atuTopCueTimer = null;
        }
        if (snap.hasAtu === false || Number(snap.atuMode) === 0) {
          btn.hidden = true;
          return;
        }
        btn.hidden = false;
        const tuning = Boolean(snap.atuTuning);
        const searchRemMs = (Number(snap.atuSearchWindowUntil) || 0) - Date.now();
        const searchHot = !tuning && searchRemMs > 0;
        if (searchHot) {
          this._atuTopCueTimer = setTimeout(() => {
            this._atuTopCueTimer = null;
            this._syncTopRfStatus(this._getSnapshot());
          }, searchRemMs + 30);
        }

        const tm = snap.txMeters || {};
        const liveSwr = Number(tm.swr) >= 1.0 ? Number(tm.swr) : Number(snap.atuMatchedSwr) || 0;
        const swrSuffix = liveSwr >= 1.0 ? ` ${liveSwr.toFixed(1)}` : '';

        if (tuning) {
          btn.dataset.state = 'tuning';
          btn.textContent = liveSwr >= 1.0 ? `TUNE ${liveSwr.toFixed(1)}` : 'ATU TUNE';
          btn.title = 'ATU tuning in progress — click to stop';
        } else if (searchHot) {
          btn.dataset.state = 'search-hot';
          btn.textContent = 'ATU 2x FULL';
          btn.title = 'Double-tap window open: Shift+Click to run Full Search ATU tune';
        } else if (Number(snap.atuMode) === 2) {
          btn.dataset.state = 'auto';
          btn.textContent = `ATU AUTO${swrSuffix}`;
          btn.title = 'ATU Auto (click: Bypass · Shift+Click: ATU Tune · 2nd tap: Full Search)';
        } else {
          btn.dataset.state = 'bypass';
          btn.textContent = 'ATU BYP';
          btn.title = 'ATU Bypassed (click: Auto · Shift+Click: ATU Tune)';
        }
      }
    }

    _scheduleRender() {
      if (this._rafScheduled) return;
      this._rafScheduled = true;
      requestAnimationFrame(() => {
        this._rafScheduled = false;
        this._render();
      });
    }

    _render(changedKeys = null) {
      if (this._uiPerf) this._uiPerf.fullRenders += 1;
      const snap = this._getSnapshot();
      const isMobile = window.innerWidth < 960;

      // Sync AudioEngine parameters & MediaSession metadata when state changes
      if (snap.audioMix && snap.audioMix !== this._lastSyncedMix) {
        this._lastSyncedMix = snap.audioMix;
        if (this.audio.setMixMode) this.audio.setMixMode(snap.audioMix);
      }
      if (Number.isFinite(snap.streamingLatency) && snap.streamingLatency !== this._lastSyncedSl) {
        this._lastSyncedSl = snap.streamingLatency;
        if (this.audio.setLatencyTier) this.audio.setLatencyTier(snap.streamingLatency);
      }
      if (this.audio && typeof this.audio.updateMediaMetadata === 'function') {
        this.audio.updateMediaMetadata(snap);
      }

      // Connection Pill & E2E/RTT Latency
      const conn = snap.connection || {};
      const status = conn.status || 'disconnected';
      this._lastConnStatus = status;
      this._lastAuthStatus = conn.authStatus || null;
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
      const aDiag = this.audio.getDiagnostics ? this.audio.getDiagnostics() : { started: false, muted: true };
      this._updateConnLatency(snap, aDiag);

      // VFOs, VFO Cluster & S-Meter
      this.vfoAWidget.update(snap, this._targetRx, isMobile);
      this.vfoBWidget.update(snap, this._targetRx, isMobile);
      this.smeterWidget.update(snap, this._targetRx);

      if (this._dom.vfoA2bBtn) {
        const a2bHot = Date.now() < this._a2bWindowUntil;
        this._dom.vfoA2bBtn.dataset.window = a2bHot ? 'full' : 'freq';
        this._dom.vfoA2bBtn.textContent = a2bHot ? 'ALL►B' : 'A►B';
      }
      if (this._dom.vfoSplitBtn) {
        const splitOn = Boolean(snap.splitEnabled);
        this._dom.vfoSplitBtn.classList.toggle('is-active', splitOn);
        this._dom.vfoSplitBtn.setAttribute('aria-pressed', splitOn ? 'true' : 'false');
      }
      if (this._dom.vfoSubBtn) {
        const subOn = Boolean(snap.subRxEnabled);
        this._dom.vfoSubBtn.classList.toggle('is-active', subOn);
        this._dom.vfoSubBtn.setAttribute('aria-pressed', subOn ? 'true' : 'false');
      }

      // Top-bar ANT & ATU pills
      this._syncTopRfStatus(snap);

      // Audio Toggle Button
      this._syncAudioToggleUi(snap, aDiag);

      // Direct TX Controls (TEST, Mic status, Hold-to-Talk PTT)
      const posture = snap.txPosture || (this.client && typeof this.client.getTxPosture === 'function' ? this.client.getTxPosture() : 'tx-armed');
      const isTest = Boolean(snap.txTestMode || posture === 'tx-test');
      const transmitting = Boolean(snap.txActive || snap.atuTuning);
      if (this._dom.txPostureBar) {
        this._dom.txPostureBar.dataset.posture = posture;
        this._dom.txPostureBar.dataset.txTest = isTest ? 'true' : 'false';
        this._dom.txPostureBar.dataset.transmitting = transmitting ? 'true' : 'false';
      }
      if (this._dom.txModeTestBtn) {
        this._dom.txModeTestBtn.classList.toggle('is-active', isTest);
        this._dom.txModeTestBtn.setAttribute('aria-pressed', isTest ? 'true' : 'false');
      }

      if (this._dom.txMicBtn && this._dom.txMicLabel) {
        const txEnabled = posture === 'tx-armed' || posture === 'tx-test' || isTest;
        this._dom.txMicBtn.hidden = !txEnabled;
        if (txEnabled) {
          const cfg = this._txAudioConfig || {};
          if (cfg.source !== 'mic') {
            this._dom.txMicBtn.dataset.micState = 'synth';
            this._dom.txMicLabel.textContent =
              cfg.source === 'tone-1k' ? '1kHz' : cfg.source === 'wav' ? 'WAV' : 'TONE';
            this._dom.txMicBtn.title = 'Synthesized TX audio source — click to open TX Audio settings';
          } else {
            const st = this.audio && typeof this.audio.getMicStatus === 'function'
              ? this.audio.getMicStatus()
              : { state: 'idle' };
            const state = st.state || 'idle';
            this._dom.txMicBtn.dataset.micState = state;
            const labels = {
              capturing: 'MIC LIVE',
              ready: 'MIC RDY',
              requesting: 'MIC...',
              denied: 'MIC DENY',
              insecure: 'NO SSL',
              unavailable: 'NO MIC',
              error: 'MIC ERR',
              idle: 'MIC',
            };
            this._dom.txMicLabel.textContent = labels[state] || 'MIC';
            const devInfo = st.deviceLabel ? `: ${st.deviceLabel}` : (st.error ? `: ${st.error}` : '');
            this._dom.txMicBtn.title = `Microphone ${state}${devInfo} (click to retry or open TX Audio settings)`;
          }
        }
      }

      if (this._dom.pttBtn) {
        const pttEnabled = posture !== 'rx-only' && !snap.txInhibit;
        this._dom.pttBtn.disabled = !pttEnabled;
        const pttActive = Boolean(this._pttHeldUi || snap.pttHeld || snap.txActive);
        this._dom.pttBtn.classList.toggle('is-held', Boolean(this._pttHeldUi || snap.pttHeld));
        this._dom.pttBtn.classList.toggle('is-tx', Boolean(snap.txActive));
        this._dom.pttBtn.setAttribute('aria-pressed', pttActive ? 'true' : 'false');
        this._dom.pttBtn.textContent = snap.txActive ? (isTest ? 'TX Test' : 'ON AIR') : 'PTT';
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
      this._hudDualBtn.disabled = false;
      this._hudDualBtn.title = 'Toggle Dual Panadapter';
      this._hudLoupeBtn.textContent = `Mini-Pan ${loupeRx}`;
      this._hudLoupeBtn.classList.toggle('is-active', Boolean(loupeS.miniPan));
      this._hudFreezeBtn.textContent = snap.panFrozen ? 'Frozen' : 'Freeze';
      this._hudFreezeBtn.classList.toggle('is-active', Boolean(snap.panFrozen));

      const isCw = rxS.mode === 'CW' || rxS.mode === 'CW-R';
      const spotActive = Boolean(snap.spotTone || rxS.spotMode === 1 || rxS.spotMode === 2);
      if (this._hudAutoSpotBtn) {
        this._hudAutoSpotBtn.disabled = !isCw;
        this._hudAutoSpotBtn.classList.toggle('is-cw-ready', isCw);
        this._hudAutoSpotBtn.title = isCw
          ? `Zero-beat CW signal on VFO ${this._targetRx}`
          : 'Auto Spot (select CW or CW-R mode)';
      }
      if (this._hudCwSpotBtn) {
        this._hudCwSpotBtn.disabled = !isCw;
        this._hudCwSpotBtn.classList.toggle('is-cw-ready', isCw);
        this._hudCwSpotBtn.classList.toggle('is-active', isCw && spotActive);
        this._hudCwSpotBtn.setAttribute('aria-pressed', isCw && spotActive ? 'true' : 'false');
      }
      if (this._lastHudCwMode !== isCw) {
        this._lastHudCwMode = isCw;
        if (this.panadapter && typeof this.panadapter.invalidateHudLayout === 'function') {
          this.panadapter.invalidateHudLayout();
        }
      }

      // Decoded Text Ticker (TB$)
      if (this._tickerDecodeSelect && typeof K4.syncDecodeSelect === 'function') {
        K4.syncDecodeSelect(this._tickerDecodeSelect, rxS);
      }
      this._renderDecodedText(snap.decodedText);

      // Inspector & Mobile Sheets (with changedKeys tab-dirty skipping)
      this.inspector.update(snap, changedKeys);
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
