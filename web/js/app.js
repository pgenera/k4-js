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
      const prefs = K4.ClientPrefs;
      this._mouseQsyMode = prefs
        ? prefs.get('mouseQsyMode')
        : (K4.storage && K4.storage.get('k4.mouseQsyMode', 'lr')) === 'pane'
          ? 'pane'
          : 'lr';
      this._voiceClickSnapKhz = prefs ? prefs.get('voiceClickSnapKhz') : true;
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
      this._lastRadioId = '';
      this._lastWsUrl = '';
      this._lastHudCwMode = null;
      this._a2bWindowUntil = 0;
      this._a2bCueTimer = null;
      this._atuTopCueTimer = null;
      this._pttPointerId = null;
      this._pttKeyHeld = false;
      this._pttHeldUi = false;
      this._pttRequestGen = 0;
      this._lastSensorTickMs = 0;
      this._reconnectTimer = null;
      this._reconnectAttempt = 0;
      this._autoReconnecting = false;
      this._hadAuthenticatedSession = false;
      this._manualDisconnect = false;
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
        voiceProcessing: true,
        wavName: '',
      };

      this.state = new K4.RadioState();
      this.gate = new K4.RxOnlyGate('tx-enabled');
      this.client = new K4.Client({ state: this.state, gate: this.gate });
      this.audio = new K4.AudioEngine({
        state: this.state,
        mediaSmeterEnabled: prefs ? prefs.get('mediaSessionSmeter') : true,
        targetRx: this._targetRx,
      });

      this._dom = {
        topBar: document.getElementById('top-bar'),
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
        centerSplitInd: document.getElementById('center-split-ind'),
        centerMsgInd: document.getElementById('center-msg-ind'),
        centerVoxInd: document.getElementById('center-vox-ind'),
        centerQskInd: document.getElementById('center-qsk-ind'),
        centerRitXitBox: document.getElementById('center-rit-xit-box'),
        txPostureBar: document.getElementById('tx-posture-bar'),
        txModeTestBtn: document.getElementById('tx-mode-test'),
        pttBtn: document.getElementById('ptt-btn'),
        settingsBtn: document.getElementById('settings-btn'),
        drawerToggleBtn: document.getElementById('drawer-toggle'),
        panStage: document.getElementById('pan-stage'),
        drawer: document.getElementById('inspector-drawer'),
        mobileNav: document.getElementById('mobile-nav'),
        mobileSheet: document.getElementById('mobile-sheet'),
        omnibarModal: document.getElementById('omnibar-modal'),
        connDialog: document.getElementById('connection-dialog'),
        settingsModal: document.getElementById('settings-modal'),
        pwaUpdateBanner: document.getElementById('pwa-update-banner'),
        toastStack: document.getElementById('toast-stack'),
      };

      const rendererOpt = this._params.get('renderer') || 'auto';
      this.panadapter = new K4.PanadapterView({
        container: this._dom.panStage,
        state: this.state,
        client: this.client,
        renderer: rendererOpt,
        mouseQsyMode: this._mouseQsyMode,
        voiceClickSnapKhz: this._voiceClickSnapKhz,
        onSelectTarget: (rx) => this.setTargetRx(rx),
        onToggleWheelRit: () => this.toggleWheelRitMode(),
        onNotify: (msg, level) => this.toast(msg, level),
        onViewportChange: () => this._scheduleRender(),
      });

      if (this.panadapter.setPalette) this.panadapter.setPalette(this._palette);
      if (this.panadapter.setPeakHold) this.panadapter.setPeakHold(this._peakHold);
      if (this.panadapter.setTargetRx) this.panadapter.setTargetRx(this._targetRx);

      this._mountStageOverlays();
      this._initPwa();
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

      this._hudTargetBtn = el('button', 'k4-hud-btn k4-hud-mouse-btn k4-hud-desktop-only is-cyan');
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
      this._hudTargetLabel = el('span', 'k4-hud-mouse-label', 'A');
      this._hudTargetBtn.appendChild(this._hudTargetLabel);
      this._hudTargetBtn.title = 'K4 Mouse target (Left=A blue, Right=B green, R=RIT wheel). Click to cycle; middle-click or Shift-click toggles RIT wheel.';
      this._hudTargetBtn.addEventListener('click', (e) => {
        if (e.shiftKey) {
          this.toggleWheelRitMode();
        } else if (this._wheelRitMode) {
          this.toggleWheelRitMode(false);
          this.setTargetRx('A');
        } else if (this._targetRx === 'A') {
          this.setTargetRx('B');
        } else {
          const snap = this._getSnapshot();
          const hasRit = Boolean((snap.rxA && snap.rxA.ritOn) || (snap.rxB && snap.rxB.ritOn) || snap.xitEnabled);
          if (hasRit) {
            this.toggleWheelRitMode(true);
          } else {
            this.setTargetRx('A');
          }
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

      group.appendChild(el('span', 'k4-hud-sep k4-hud-desktop-only'));

      this._hudStepBtn = el('button', 'k4-hud-btn k4-hud-desktop-only', 'Step: 100 Hz');
      this._hudStepBtn.type = 'button';
      this._hudStepBtn.dataset.testid = 'hud-step-btn';
      this._hudStepBtn.title = 'Cycle tuning step size';
      this._hudStepBtn.addEventListener('click', () => this._cycleStep());
      group.appendChild(this._hudStepBtn);

      group.appendChild(el('span', 'k4-hud-sep k4-hud-desktop-only'));

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
      this._hudCenterBtn.addEventListener('click', () => this._recenterPanadapter());
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

      this._hudSpotSep = el('span', 'k4-hud-sep');
      group.appendChild(this._hudSpotSep);

      this._hudAutoSpotBtn = el('button', 'k4-hud-btn', 'Auto Spot');
      this._hudAutoSpotBtn.id = 'hud-auto-spot-btn';
      this._hudAutoSpotBtn.type = 'button';
      this._hudAutoSpotBtn.dataset.testid = 'auto-spot-btn';
      this._hudAutoSpotBtn.title = 'Zero-beat CW signal on active VFO';
      this._hudAutoSpotBtn.addEventListener('click', () => this._triggerAutoSpot());
      group.appendChild(this._hudAutoSpotBtn);

      this._hudCwSpotBtn = el('button', 'k4-hud-btn', 'Spot');
      this._hudCwSpotBtn.id = 'hud-cw-spot-btn';
      this._hudCwSpotBtn.type = 'button';
      this._hudCwSpotBtn.dataset.testid = 'cw-spot-btn';
      this._hudCwSpotBtn.setAttribute('aria-pressed', 'false');
      this._hudCwSpotBtn.title = 'Toggle CW Spot sidetone';
      this._hudCwSpotBtn.addEventListener('click', () => this._toggleSpotTone());
      group.appendChild(this._hudCwSpotBtn);

      hudTop.appendChild(group);

      this._hudPanNbPill = el('button', 'k4-pan-nb-pill', 'NB');
      this._hudPanNbPill.type = 'button';
      this._hudPanNbPill.dataset.testid = 'pan-nb-pill';
      this._hudPanNbPill.hidden = true;
      this._hudPanNbPill.title = 'Panadapter DDC Noise Blanker (#NB) active — click to cycle Off / On / Auto';
      this._hudPanNbPill.addEventListener('click', () => {
        const snap = this._getSnapshot();
        const dispRx = this._dispRx(snap);
        const dispS = (dispRx === 'B' ? snap.rxB : snap.rxA) || {};
        const nextMode = ((Number(dispS.panNbMode) || 0) + 1) % 3;
        this.client.setDisplay(dispRx, { panNbMode: nextMode });
      });
      hudTop.appendChild(this._hudPanNbPill);

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

      // Non-modal disconnected state prompt when dialog is dismissed
      const dcCard = el('div', 'k4-disconnected-card');
      dcCard.dataset.testid = 'disconnected-card';
      dcCard.hidden = true;
      const dcTitle = el('div', 'k4-disconnected-title', 'Not Connected to K4');
      const dcSub = el(
        'div',
        'k4-disconnected-sub',
        `Endpoint: ${K4.Client && typeof K4.Client.defaultWsUrl === 'function' ? K4.Client.defaultWsUrl() : 'ws://127.0.0.1:9280'}`
      );
      const dcCmd = el('code', 'k4-disconnected-cmd', 'websockify 127.0.0.1:9280 <k4-ip>:9205');
      const dcBtn = el('button', 'k4-btn k4-btn--primary', 'Connect…');
      dcBtn.type = 'button';
      dcBtn.dataset.testid = 'disconnected-connect-btn';
      dcBtn.addEventListener('click', () => this.openConnectionDialog());
      dcCard.appendChild(dcTitle);
      dcCard.appendChild(dcSub);
      dcCard.appendChild(dcCmd);
      dcCard.appendChild(dcBtn);
      stage.appendChild(dcCard);
      this._disconnectedCard = dcCard;
    }

    _initWidgets() {
      const handleSelectTarget = (rx) => {
        this.setTargetRx(rx);
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
        onToggleMiniPan: (rx) => {
          const snap = this._getSnapshot();
          const target = rx === 'B' ? 'B' : 'A';
          const rxS = target === 'B' ? snap.rxB : snap.rxA;
          if (target === 'B' && !snap.subRxEnabled) {
            this.client.setSubRx(true);
          }
          if (typeof this.client.setDisplay === 'function') {
            this.client.setDisplay(target, { miniPan: !(rxS && rxS.miniPan) });
          }
        },
      });

      this.omnibar = new K4.Omnibar({
        modal: this._dom.omnibarModal,
        client: this.client,
        state: this.state,
        getTargetRx: () => this._targetRx,
        onSetTargetRx: (rx) => this.setTargetRx(rx),
        onSetPalette: (pal) => this.setPalette(pal),
        onToggleAudio: (muteOverride) => this.toggleAudio(muteOverride),
        onOpenSettings: (section) => this.openSettings(section),
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
        onBeginHoldPtt: () => this._beginHoldPtt(),
        onEndHoldPtt: () => this._endHoldPtt(),
        isPttHeld: () => Boolean(this._pttHeldUi),
        onSwapVfo: (all) => this._swapVfo(Boolean(all)),
        onTriggerA2B: (all) => this._triggerA2B(Boolean(all)),
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

      this.settingsPanel = K4.SettingsPanel
        ? new K4.SettingsPanel({
            modal: this._dom.settingsModal,
            triggerBtn: this._dom.settingsBtn,
            client: this.client,
            prefs: K4.ClientPrefs,
            pwa: this.pwa,
            onNotify: (msg, level) => this.toast(msg, level),
          })
        : { open() {}, close() {}, isOpen: () => false };

      if (this._dom.connDialog && typeof globalThis.MutationObserver === 'function') {
        this._connDialogObs = new globalThis.MutationObserver(() => {
          this._syncDisconnectedCard(this._getSnapshot());
        });
        this._connDialogObs.observe(this._dom.connDialog, {
          attributes: true,
          attributeFilter: ['data-open', 'hidden'],
        });
      }

      if (K4.ClientPrefs && typeof K4.ClientPrefs.onChange === 'function') {
        this._unsubClientPrefs = K4.ClientPrefs.onChange((key, val) => {
          if (key === 'voiceClickSnapKhz') {
            this._voiceClickSnapKhz = Boolean(val);
            if (this.panadapter && typeof this.panadapter.setVoiceClickSnapKhz === 'function') {
              this.panadapter.setVoiceClickSnapKhz(this._voiceClickSnapKhz);
            }
          } else if (key === 'mouseQsyMode') {
            const next = val === 'pane' ? 'pane' : 'lr';
            if (this._mouseQsyMode !== next) {
              this.setMouseQsyMode(next);
            }
          } else if (key === 'mediaSessionSmeter') {
            if (this.audio && typeof this.audio.setMediaSmeterEnabled === 'function') {
              this.audio.setMediaSmeterEnabled(Boolean(val));
            }
          }
        });
      }
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
        const snap = this._getSnapshot();
        const policy =
          this.gate && typeof this.gate.getPolicy === 'function'
            ? this.gate.getPolicy()
            : 'rx-only';
        const reason = (info && info.reason) || '';
        const isRxOnlyBlock =
          policy === 'rx-only' &&
          snap.txPosture === 'rx-only' &&
          !snap.txActive &&
          !reason.includes('permanently blocked');
        this.toast(
          isRxOnlyBlock
            ? `Blocked ${cmd} in RX-only mode`
            : `Blocked ${cmd}: ${reason || 'command not permitted'}`,
          'blocked'
        );
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
        const isSuppressedReconnectErr =
          this._autoReconnecting && err && typeof err === 'object' && err.source === 'transport';
        if (!isSuppressedReconnectErr) {
          this.toast(msg, 'error');
        }
        this._scheduleRender();
      });

      this.client.on('connection', (conn) => {
        const nextStatus = (conn && conn.status) || 'disconnected';
        const nextAuth = (conn && conn.authStatus) || null;
        const nextRadioId = (conn && conn.radioId) || '';
        const nextWsUrl = (conn && conn.wsUrl) || '';
        const connMetaChanged =
          nextStatus !== this._lastConnStatus ||
          nextAuth !== this._lastAuthStatus ||
          nextRadioId !== this._lastRadioId ||
          nextWsUrl !== this._lastWsUrl;
        if (connMetaChanged || (this.connectionDialog && typeof this.connectionDialog.isOpen === 'function' && this.connectionDialog.isOpen())) {
          this.connectionDialog.syncConnectionState(conn);
        }
        if (conn && conn.status === 'connected' && conn.authStatus === 'authenticated') {
          const wasReconnecting = this._autoReconnecting;
          this._hadAuthenticatedSession = true;
          this._manualDisconnect = false;
          this._clearAutoReconnect();
          if (this._pendingConnectClose || wasReconnecting) {
            this._pendingConnectClose = false;
            this.connectionDialog.close();
            this.toast(wasReconnecting ? 'Reconnected to K4 Receiver' : 'Connected to K4 Receiver', 'success');
          }
        } else if (conn && conn.authStatus === 'rejected') {
          this._hadAuthenticatedSession = false;
          this._clearAutoReconnect();
        } else if (
          (nextStatus === 'error' || nextStatus === 'disconnected') &&
          this._canAutoReconnect(conn) &&
          !this._reconnectTimer
        ) {
          this._scheduleAutoReconnect(false);
        }
        if (connMetaChanged) {
          this._syncTxMicStandby();
          if (this.pwa) this.pwa.notifyActivityChanged();
          this._render(['connection']);
        } else {
          this._scheduleMeterRender(['connection.rttMs']);
        }
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
          } else {
            if (typeof this.audio.stopTxCapture === 'function') {
              this.audio.stopTxCapture();
            }
            if (typeof this.audio.releaseMicStandby === 'function') {
              this.audio.releaseMicStandby();
            }
          }
          if (this.pwa) this.pwa.notifyActivityChanged();
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
        const syncMediaUi = () => {
          const snap = this._getSnapshot();
          const aDiag = this.audio && this.audio.getDiagnostics ? this.audio.getDiagnostics() : { started: false, muted: true };
          this._syncAudioToggleUi(snap, aDiag);
          this._updateConnLatency(snap, aDiag);
          this._syncPwaWakeLock(aDiag);
          if (this.inspector) {
            if (typeof this.inspector._getVisibleTabId === 'function' && this.inspector._getVisibleTabId() === 'audio') {
              this.inspector.update(snap, ['audio']);
            } else {
              if (this.inspector._dirtyTabs) this.inspector._dirtyTabs.add('audio');
              if (typeof this.inspector._syncAfScopeLoop === 'function') {
                this.inspector._syncAfScopeLoop();
              }
            }
          }
        };
        this.audio.on('started', syncMediaUi);
        this.audio.on('mute', syncMediaUi);
        this.audio.on('mediaAction', syncMediaUi);
        this.audio.on('stopped', syncMediaUi);
      }

      const METER_ONLY_KEYS = new Set([
        'rxA.sMeterDbm',
        'rxB.sMeterDbm',
        'rxA.panMeta',
        'rxB.panMeta',
        'txMeters',
        'telemetry',
        'decodedText',
        'connection.rttMs',
        'latency',
        'swr',
        'alc',
        'power',
        'idd',
        'vdd',
        'temp',
      ]);

      const MIC_SYNC_KEYS = new Set([
        'rxA.mode',
        'rxB.mode',
        'rxA.dataSubMode',
        'rxB.dataSubMode',
        'splitEnabled',
        'activeTxVfo',
        'txPosture',
        'txTestMode',
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
          connStatus === this._lastConnStatus &&
          connAuthStatus === this._lastAuthStatus &&
          (conn.radioId || '') === this._lastRadioId &&
          (conn.wsUrl || '') === this._lastWsUrl;

        let allMeterOnly = keyList.length > 0;
        let syncMic = false;
        let syncPwaActivity = false;
        for (let i = 0; i < keyList.length; i++) {
          const k = keyList[i];
          if (MIC_SYNC_KEYS.has(k)) syncMic = true;
          if (
            k === 'txActive' ||
            k === 'pttHeld' ||
            k === 'atuTuning' ||
            k === 'txBufferCount' ||
            (k === 'connection' && !connMetaUnchanged)
          ) {
            syncPwaActivity = true;
          }
          if (METER_ONLY_KEYS.has(k)) continue;
          if (k === 'connection' && connMetaUnchanged) continue;
          allMeterOnly = false;
        }
        if (syncMic) {
          this._syncTxMicStandby();
        }
        if (syncPwaActivity && this.pwa) {
          this.pwa.notifyActivityChanged();
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
      if (this._dom.settingsBtn) {
        this._dom.settingsBtn.addEventListener('click', () => {
          if (this.settingsPanel && this.settingsPanel.isOpen()) this.settingsPanel.close();
          else this.openSettings();
        });
      }

      this._syncTopbarHeight();
      if (typeof ResizeObserver === 'function' && this._dom.topBar) {
        this._topBarResizeObserver = new ResizeObserver(() => this._syncTopbarHeight());
        this._topBarResizeObserver.observe(this._dom.topBar);
      }

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
            this._swapVfo(true);
          }, 750);
        });
        this._dom.vfoAbBtn.addEventListener('pointerup', clearAbHold);
        this._dom.vfoAbBtn.addEventListener('pointercancel', clearAbHold);
        this._dom.vfoAbBtn.addEventListener('pointerleave', clearAbHold);
        this._dom.vfoAbBtn.addEventListener('click', (e) => {
          if (abHoldTriggered) {
            abHoldTriggered = false;
            return;
          }
          this._swapVfo(Boolean(e.shiftKey));
        });
      }
      if (this._dom.vfoA2bBtn) {
        this._dom.vfoA2bBtn.addEventListener('click', (e) => this._triggerA2B(Boolean(e.shiftKey)));
      }
      if (this._dom.vfoSplitBtn) {
        this._dom.vfoSplitBtn.addEventListener('click', (e) => this._toggleSplit(Boolean(e.shiftKey)));
      }
      if (this._dom.vfoSubBtn) {
        this._dom.vfoSubBtn.addEventListener('click', () => this._toggleSubRx());
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
          if (e.shiftKey) {
            this._triggerAtuTune();
            return;
          }
          if (snap.atuTuning) {
            if (typeof this.client.stopAtuTune === 'function') this.client.stopAtuTune();
            else this.client.sendCat('TU0;');
            return;
          }
          const nextMode = Number(snap.atuMode) === 2 ? 1 : 2;
          if (typeof this.client.setAtuMode === 'function') this.client.setAtuMode(nextMode);
          else this.client.sendCat(`AT${nextMode};`);
        });
      }

      // Center K4 Icon Area (SPLIT, MSG, VOX, QSK, shared RIT/XIT offset box)
      if (this._dom.centerSplitInd) {
        this._dom.centerSplitInd.addEventListener('click', (e) => this._toggleSplit(Boolean(e.shiftKey)));
      }
      if (this._dom.centerMsgInd) {
        this._dom.centerMsgInd.addEventListener('click', (e) => {
          if (e.shiftKey && this.inspector && typeof this.inspector.openTab === 'function') {
            this.inspector.openTab('tx');
            return;
          }
          if (this.inspector) {
            this.inspector._msgBank = this.inspector._msgBank === 2 ? 1 : 2;
            this.inspector.update(this._getSnapshot(), ['dvr']);
          }
          this._render();
        });
      }
      if (this._dom.centerVoxInd) {
        this._dom.centerVoxInd.addEventListener('click', () => {
          const snap = this._getSnapshot();
          const rx = snap.activeTxVfo === 'B' ? (snap.rxB || {}) : (snap.rxA || {});
          const mode = Number(rx.mode) || 2;
          let ch = 'V';
          let cur = Boolean(snap.voxVoice);
          if (mode === 3 || mode === 7) {
            ch = 'C';
            cur = Boolean(snap.voxCw);
          } else if (mode === 6 || mode === 9) {
            ch = 'D';
            cur = Boolean(snap.voxData);
          }
          if (typeof this.client.setVox === 'function') this.client.setVox(ch, !cur);
          else this.client.sendCat(`VX${ch}${!cur ? '1' : '0'};`);
        });
      }
      if (this._dom.centerQskInd) {
        this._dom.centerQskInd.addEventListener('click', () => {
          const next = !Boolean(this._getSnapshot().voxCw);
          if (typeof this.client.setVox === 'function') this.client.setVox('C', next);
          else this.client.sendCat(`VXC${next ? '1' : '0'};`);
        });
      }
      if (this._dom.centerRitXitBox) {
        const box = this._dom.centerRitXitBox;
        box.addEventListener('click', (e) => {
          const snap = this._getSnapshot();
          if (e.shiftKey) {
            const nextXit = !Boolean(snap.xitEnabled);
            if (typeof this.client.setXit === 'function') this.client.setXit(nextXit);
            else this.client.sendCat(`XT${nextXit ? '1' : '0'};`);
            return;
          }
          const rx = this._targetRx === 'B' ? 'B' : 'A';
          const rxS = (rx === 'B' ? snap.rxB : snap.rxA) || {};
          const nextRit = !Boolean(rxS.ritOn);
          if (typeof this.client.setRit === 'function') this.client.setRit(rx, { on: nextRit });
          else this.client.sendCat(`RT${rx === 'B' ? '$' : ''}${nextRit ? '1' : '0'};`);
        });
        box.addEventListener('dblclick', (e) => {
          e.preventDefault();
          const snap = this._getSnapshot();
          const rx = this._targetRx === 'B' ? 'B' : 'A';
          if (typeof this.client.clearRit === 'function') this.client.clearRit(rx);
          if (snap.xitEnabled && typeof this.client.setXit === 'function') this.client.setXit(true, 0);
        });
        box.addEventListener('wheel', (e) => {
          e.preventDefault();
          const snap = this._getSnapshot();
          const rx = this._targetRx === 'B' ? 'B' : 'A';
          const rxS = (rx === 'B' ? snap.rxB : snap.rxA) || {};
          const cur = Number(rxS.ritOffsetHz) || 0;
          const step = e.shiftKey ? 50 : 10;
          const next = Math.max(-9990, Math.min(9990, cur + (e.deltaY < 0 ? step : -step)));
          if (snap.xitEnabled && !rxS.ritOn && typeof this.client.setXit === 'function') {
            this.client.setXit(true, next);
          } else if (typeof this.client.setRit === 'function') {
            this.client.setRit(rx, { on: true, offsetHz: next });
          }
        }, { passive: false });
      }

      // TX Test control
      if (this._dom.txModeTestBtn) {
        this._dom.txModeTestBtn.addEventListener('click', () => this.toggleTxTest());
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
        if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          if (this.omnibar.isOpen()) this.omnibar.close();
          else this.openOmnibar();
          return;
        }

        if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === ',') {
          e.preventDefault();
          if (this.settingsPanel && this.settingsPanel.isOpen()) this.settingsPanel.close();
          else this.openSettings();
          return;
        }

        if (e.key === 'Escape') {
          const snap = this._getSnapshot();
          const modalOpen =
            this.omnibar.isOpen() ||
            this.connectionDialog.isOpen() ||
            Boolean(this.settingsPanel && this.settingsPanel.isOpen()) ||
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
        const modalOpen =
          this.omnibar.isOpen() ||
          this.connectionDialog.isOpen() ||
          Boolean(this.settingsPanel && this.settingsPanel.isOpen());
        if (isEditing || modalOpen) {
          return;
        }

        if (K4.ClientPrefs && K4.ClientPrefs.get('keyboardShortcuts') === false) {
          return;
        }

        if (e.ctrlKey || e.metaKey) {
          return;
        }

        const onVfoDigit = Boolean(e.target && e.target.classList && e.target.classList.contains('k4-vfo-digit'));
        if (onVfoDigit && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || (!e.altKey && /^[0-9]$/.test(e.key)))) {
          return;
        }

        if (e.code === 'Space' && !e.altKey) {
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

        if (e.key === '?' && !e.altKey) {
          e.preventDefault();
          this.openSettings('shortcuts');
          return;
        }

        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          const mult = e.shiftKey ? 10 : 1;
          const dir = e.key === 'ArrowLeft' ? -1 : 1;
          this.client.stepFrequency(this._targetRx, dir * mult, e.altKey ? 1 : undefined);
          return;
        }

        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const dir = e.key === 'ArrowUp' ? 1 : -1;
          const mode = K4.ClientPrefs ? K4.ClientPrefs.get('arrowUpDownMode') : 'coarse';
          if (mode === 'band') {
            this._stepBand(dir);
          } else if (mode === 'step') {
            this.client.stepFrequency(this._targetRx, dir, e.altKey ? 1 : undefined);
          } else {
            this.client.stepFrequency(this._targetRx, dir * 10, e.altKey ? 1 : undefined);
          }
          return;
        }

        if (e.altKey) {
          return;
        }

        if (/^F[1-8]$/.test(e.key)) {
          e.preventDefault();
          this._executeFnMacro(e.key);
          return;
        }

        if (/^[0-9]$/.test(e.key)) {
          e.preventDefault();
          this.openOmnibar(e.key);
          return;
        }

        if (e.key === 'PageUp' || e.key === ']') {
          e.preventDefault();
          this._stepBand(1);
        } else if (e.key === 'PageDown' || e.key === '[') {
          e.preventDefault();
          this._stepBand(-1);
        } else if (e.key === 'a' && !e.shiftKey) {
          e.preventDefault();
          this.setTargetRx('A');
        } else if (e.key === 'b' && !e.shiftKey) {
          e.preventDefault();
          this.setTargetRx('B');
        } else if (e.key === 'A' || (e.shiftKey && e.key.toLowerCase() === 'a')) {
          e.preventDefault();
          this._triggerA2B(false);
        } else if (e.key === 'x' || e.key === '/') {
          e.preventDefault();
          this._swapVfo(false);
        } else if (e.key === 'X' || (e.shiftKey && e.key.toLowerCase() === 'x')) {
          e.preventDefault();
          this._swapVfo(true);
        } else if (e.key === 's' && !e.shiftKey) {
          e.preventDefault();
          this._toggleSplit(false);
        } else if (e.key === 'S' || (e.shiftKey && e.key.toLowerCase() === 's')) {
          e.preventDefault();
          this._toggleSplit(true);
        } else if (e.key === 'u' || e.key === 'U') {
          e.preventDefault();
          this._toggleSubRx();
        } else if (e.key === 'c' && !e.shiftKey) {
          e.preventDefault();
          this._triggerAutoSpot();
        } else if (e.key === 'C' || (e.shiftKey && e.key.toLowerCase() === 'c')) {
          e.preventDefault();
          this._toggleSpotTone();
        } else if (e.key === 'l' || e.key === 'L') {
          e.preventDefault();
          this._toggleLock();
        } else if (e.key === 'r' && !e.shiftKey) {
          e.preventDefault();
          this._toggleRit();
        } else if (e.key === 'R' || (e.shiftKey && e.key.toLowerCase() === 'r')) {
          e.preventDefault();
          this._clearRit();
        } else if (e.key === 'T' || (e.shiftKey && e.key.toLowerCase() === 't')) {
          e.preventDefault();
          this._triggerAtuTune();
        } else if (e.key === 'z' || e.key === 'Z' || e.key === 'Home') {
          e.preventDefault();
          this._recenterPanadapter();
        } else if (e.key === 'm' || e.key === 'M') {
          e.preventDefault();
          this.toggleAudio();
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
        if (!document.hidden && this._autoReconnecting && this._canAutoReconnect()) {
          this._scheduleAutoReconnect(true);
        }
        if (this.inspector && typeof this.inspector._syncAfScopeLoop === 'function') {
          this.inspector._syncAfScopeLoop();
        }
      });

      window.addEventListener('online', () => {
        if (this._autoReconnecting && this._canAutoReconnect()) {
          this._scheduleAutoReconnect(true);
        }
      });

      window.addEventListener('pagehide', () => {
        this._endHoldPtt();
      });

      window.addEventListener('resize', () => {
        this._syncTopbarHeight();
        if (this.panadapter && typeof this.panadapter.invalidateHudLayout === 'function') {
          this.panadapter.invalidateHudLayout();
        }
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

    _initPwa() {
      this._pwaBannerText = null;
      this._pwaUpdateNowBtn = null;
      this._pwaUpdateLaterBtn = null;
      const banner = this._dom.pwaUpdateBanner;
      if (banner) {
        banner.textContent = '';
        this._pwaBannerText = el('span', 'k4-update-banner-text', '');
        const actions = el('div', 'k4-update-banner-actions');

        this._pwaUpdateNowBtn = el('button', 'k4-btn k4-btn--primary', 'Update now');
        this._pwaUpdateNowBtn.type = 'button';
        this._pwaUpdateNowBtn.dataset.testid = 'pwa-update-now';
        this._pwaUpdateNowBtn.addEventListener('click', () => {
          if (this.pwa && typeof this.pwa.applyUpdateNow === 'function') {
            this.pwa.applyUpdateNow();
          }
        });
        actions.appendChild(this._pwaUpdateNowBtn);

        this._pwaUpdateLaterBtn = el('button', 'k4-btn', 'Later');
        this._pwaUpdateLaterBtn.type = 'button';
        this._pwaUpdateLaterBtn.dataset.testid = 'pwa-update-later';
        this._pwaUpdateLaterBtn.addEventListener('click', () => {
          if (this.pwa && typeof this.pwa.deferUpdate === 'function') {
            this.pwa.deferUpdate();
          }
        });
        actions.appendChild(this._pwaUpdateLaterBtn);

        banner.appendChild(this._pwaBannerText);
        banner.appendChild(actions);
      }

      this.pwa = K4.PwaManager
        ? new K4.PwaManager({
            isTxBusy: () => this._isTxBusyForUpdate(),
            isConnected: () => this._isConnectedForUpdate(),
            onBeforeReload: () => this._savePostUpdateReconnect(),
            onUpdateState: (st) => {
              this._renderPwaUpdateBanner(st);
              if (this.settingsPanel && typeof this.settingsPanel.syncPwaState === 'function') {
                this.settingsPanel.syncPwaState(st);
              }
            },
            onNotify: (msg, level) => this.toast(msg, level),
          })
        : null;
    }

    _isTxBusyForUpdate() {
      const snap = this._getSnapshot();
      return Boolean(
        snap.txActive ||
          snap.pttHeld ||
          this._pttHeldUi ||
          this._pttKeyHeld ||
          snap.atuTuning ||
          Number(snap.txBufferCount) > 0
      );
    }

    _isConnectedForUpdate() {
      const conn = this._getSnapshot().connection;
      if (!conn) return false;
      return (
        conn.status === 'connected' ||
        conn.status === 'connecting' ||
        conn.status === 'authenticating'
      );
    }

    _savePostUpdateReconnect() {
      if (!this._isConnectedForUpdate()) return;
      try {
        if (typeof globalThis.sessionStorage === 'undefined' || !globalThis.sessionStorage) return;
        const opts = this._lastConnectOpts || this.connectionDialog.getOptions();
        globalThis.sessionStorage.setItem(
          'k4.pwa.resumeConnect',
          JSON.stringify({ savedAt: Date.now(), opts })
        );
      } catch (_) {}
    }

    _consumePostUpdateReconnect() {
      try {
        if (typeof globalThis.sessionStorage === 'undefined' || !globalThis.sessionStorage) return null;
        const raw = globalThis.sessionStorage.getItem('k4.pwa.resumeConnect');
        globalThis.sessionStorage.removeItem('k4.pwa.resumeConnect');
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || !parsed.opts) return null;
        const ageMs = Date.now() - Number(parsed.savedAt || 0);
        if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= 30000) return null;
        return parsed.opts;
      } catch (_) {
        return null;
      }
    }

    _renderPwaUpdateBanner(st) {
      const banner = this._dom.pwaUpdateBanner;
      if (!banner) return;
      if (!st || !st.updateReady || st.phase === 'idle' || st.phase === 'checking' || st.phase === 'reloading') {
        banner.hidden = true;
        return;
      }
      banner.hidden = false;
      banner.dataset.phase = st.phase;

      if (this._pwaBannerText) {
        if (st.phase === 'countdown') {
          this._pwaBannerText.textContent = `Update ready · applying in ${st.countdownSec}s`;
        } else if (st.phase === 'deferred-tx') {
          this._pwaBannerText.textContent = 'Update ready · paused during TX';
        } else {
          this._pwaBannerText.textContent = 'Update ready';
        }
      }
      if (this._pwaUpdateNowBtn) {
        this._pwaUpdateNowBtn.disabled = st.phase === 'deferred-tx';
      }
      if (this._pwaUpdateLaterBtn) {
        this._pwaUpdateLaterBtn.hidden = st.phase !== 'countdown';
      }
    }

    _initDemoListeners() {
      if (this._demoListenersBound) return;
      this._demoListenersBound = true;
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('k4-demo-notice', (ev) => {
          const msg = ev && ev.detail && ev.detail.message;
          if (msg) this.toast(msg, 'info');
        });
        window.addEventListener('k4-demo-progress', (ev) => {
          const d = ev && ev.detail;
          if (d && d.phase === 'ready' && d.manifest) {
            this._mountDemoBar(d.manifest);
          }
        });
      }
    }

    _mountDemoBar(manifest) {
      if (!this._dom.panStage || !manifest) return;
      this._unmountDemoBar();

      const bar = el('div', 'k4-demo-bar');
      bar.id = 'k4-demo-bar';
      bar.dataset.testid = 'demo-bar';
      bar.setAttribute('role', 'region');
      bar.setAttribute('aria-label', 'Live Band Demo Controls');

      const badge = el('span', 'k4-demo-badge', `DEMO · ${(manifest.band || 'BAND').toUpperCase()}`);
      bar.appendChild(badge);

      const title = el('span', 'k4-demo-title', manifest.title || 'Recorded RF Band');
      bar.appendChild(title);

      const bms = Array.isArray(manifest.bookmarks) ? manifest.bookmarks : [];
      if (bms.length > 0) {
        const bmWrap = el('div', 'k4-demo-bookmarks');
        for (let i = 0; i < bms.length; i++) {
          const bm = bms[i];
          const btn = el('button', 'k4-demo-chip', bm.label || `${(bm.freqHz / 1e6).toFixed(4)}`);
          btn.type = 'button';
          btn.title = `Tune VFO A to ${bm.label || bm.freqHz} (${bm.mode || 'USB'})`;
          btn.addEventListener('click', () => {
            if (bm.mode && typeof this.client.setMode === 'function') {
              this.client.setMode('A', bm.mode);
            }
            if (Number.isFinite(Number(bm.freqHz)) && typeof this.client.tune === 'function') {
              this.client.tune('A', Number(bm.freqHz));
            }
          });
          bmWrap.appendChild(btn);
        }
        bar.appendChild(bmWrap);
      }

      const audioBtn = el('button', 'k4-demo-audio-cta', 'Enable Audio');
      audioBtn.type = 'button';
      audioBtn.dataset.testid = 'demo-enable-audio';
      audioBtn.addEventListener('click', () => {
        if (this._dom.audioToggleBtn) {
          this._dom.audioToggleBtn.click();
        }
        audioBtn.hidden = true;
      });
      if (this.audio && typeof this.audio.getDiagnostics === 'function') {
        const diag = this.audio.getDiagnostics();
        if (diag && diag.started && !diag.muted) audioBtn.hidden = true;
      }
      bar.appendChild(audioBtn);
      this._demoAudioCta = audioBtn;

      const closeBtn = el('button', 'k4-demo-close', '×');
      closeBtn.type = 'button';
      closeBtn.title = 'Hide demo bar';
      closeBtn.addEventListener('click', () => this._unmountDemoBar());
      bar.appendChild(closeBtn);

      this._dom.panStage.appendChild(bar);
      this._demoBarEl = bar;
    }

    _unmountDemoBar() {
      if (this._demoBarEl && this._demoBarEl.parentNode) {
        this._demoBarEl.parentNode.removeChild(this._demoBarEl);
      }
      this._demoBarEl = null;
      this._demoAudioCta = null;
    }

    _handleStartup() {
      this._initDemoListeners();
      const resumeOpts = this._consumePostUpdateReconnect();
      const autoConnect = this._params.get('autoconnect');
      const demoParam = this._params.get('demo');
      const host =
        typeof location !== 'undefined' && location.hostname
          ? String(location.hostname).toLowerCase()
          : '';
      const isHostedDemoHost =
        host.endsWith('.github.io') || host.endsWith('.pages.dev');
      const wantDemo =
        demoParam === '1' ||
        demoParam === 'true' ||
        (demoParam !== '0' &&
          demoParam !== 'false' &&
          autoConnect !== '1' &&
          autoConnect !== 'true' &&
          (Boolean(globalThis.K4_DEMO_DEFAULT) || isHostedDemoHost));
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
      if (resumeOpts) {
        this.connect(resumeOpts).catch(() => {
          this.openConnectionDialog();
        });
      } else if (wantDemo && typeof K4.DemoSocket === 'function') {
        this.connect({
          wsUrl: 'demo://band',
          password: '',
          encodeMode: 1,
          subprotocolMode: 'none',
          latencyTier: 2,
        }).catch(() => {
          this.openConnectionDialog();
        });
      } else if (autoConnect === '1' || autoConnect === 'true') {
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
      if (this.pwa && typeof this.pwa.start === 'function') {
        this.pwa.start();
      }
    }

    _clearAutoReconnect() {
      if (this._reconnectTimer !== null) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      this._reconnectAttempt = 0;
      this._autoReconnecting = false;
    }

    _canAutoReconnect(conn) {
      if (!this._hadAuthenticatedSession || this._manualDisconnect || !this._lastConnectOpts) {
        return false;
      }
      if (this._isDemoMode()) return false;
      if (conn && conn.authStatus === 'rejected') return false;
      return true;
    }

    _scheduleAutoReconnect(immediate = false) {
      if (!this._canAutoReconnect()) return;
      if (this._reconnectTimer !== null) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      const firstDrop = !this._autoReconnecting;
      this._autoReconnecting = true;
      if (firstDrop) {
        this.toast('Connection lost — reconnecting…', 'info');
        this._render(['connection']);
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return;
      }
      const backoffTableMs = [1500, 3000, 6000, 12000, 20000, 30000];
      const baseMs = immediate
        ? 150
        : backoffTableMs[Math.min(this._reconnectAttempt, backoffTableMs.length - 1)];
      const jitterMs = immediate ? 0 : Math.round(baseMs * (Math.random() * 0.3 - 0.15));
      const delayMs = Math.max(100, baseMs + jitterMs);
      if (!immediate) {
        this._reconnectAttempt += 1;
      }
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        void this._runAutoReconnect();
      }, delayMs);
    }

    async _runAutoReconnect() {
      if (!this._canAutoReconnect()) {
        this._clearAutoReconnect();
        return;
      }
      const snap = this._getSnapshot();
      const status = snap && snap.connection && snap.connection.status;
      if (status === 'connected' || status === 'connecting' || status === 'authenticating') {
        return;
      }
      try {
        await this.connect(this._lastConnectOpts, { isAutoReconnect: true });
      } catch (_) {
        if (this._canAutoReconnect()) {
          this._scheduleAutoReconnect(false);
        }
      }
    }

    async connect(opts, meta = null) {
      const isAuto = Boolean(meta && meta.isAutoReconnect);
      if (!isAuto) {
        this._manualDisconnect = false;
        this._clearAutoReconnect();
      }
      const finalOpts = Object.assign({}, this.connectionDialog.getOptions(), opts || {});
      this._lastConnectOpts = Object.assign({}, finalOpts);
      this._resetTxSafety();
      this._pendingConnectClose = !isAuto;
      try {
        await this.client.connect(finalOpts);
        // If authenticated synchronously or already connected, ensure dialog closes cleanly
        const snap = this._getSnapshot();
        if (snap.connection && snap.connection.status === 'connected' && snap.connection.authStatus === 'authenticated') {
          this._pendingConnectClose = false;
          this.connectionDialog.close();
        }
        if (finalOpts.wsUrl && String(finalOpts.wsUrl).startsWith('demo://') && K4.DemoSocket && K4.DemoSocket.lastManifest) {
          this._mountDemoBar(K4.DemoSocket.lastManifest);
        } else {
          this._unmountDemoBar();
        }
      } catch (err) {
        this._pendingConnectClose = false;
        throw err;
      }
    }

    disconnect() {
      this._manualDisconnect = true;
      this._hadAuthenticatedSession = false;
      this._clearAutoReconnect();
      this._pendingConnectClose = false;
      this._lastConnectOpts = null;
      this._resetTxSafety();
      this._unmountDemoBar();
      this.client.disconnect();
      if (this.pwa) this.pwa.notifyActivityChanged();
      this.toast('Disconnected from radio', 'info');
    }

    _isDemoMode(snap) {
      const s = snap || this._getSnapshot();
      const wsUrl =
        (s && s.connection && s.connection.wsUrl) ||
        (this._lastConnectOpts && this._lastConnectOpts.wsUrl) ||
        '';
      return Boolean(
        (this.client && typeof this.client.isDemoMode === 'function' && this.client.isDemoMode()) ||
        String(wsUrl).startsWith('demo://')
      );
    }

    _resetTxSafety() {
      this._pttRequestGen += 1;
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
      return K4.isVoiceOrAfDataMode(snap || this._getSnapshot());
    }

    _startTxAudioIfVoiceMode() {
      if (!this.audio || typeof this.audio.startTxCapture !== 'function') return;
      const snap = this._getSnapshot();
      if (this._isDemoMode(snap)) return;
      if (!this._isVoiceOrAfDataMode(snap)) return;
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

    _syncTxMicStandby() {
      if (!this.audio) return;
      const snap = this._getSnapshot();
      const conn = snap.connection || {};
      const isDemo = this._isDemoMode(snap);
      const txActive = Boolean(this._pttHeldUi || snap.pttHeld || snap.txActive);
      const keepMicOpen =
        !isDemo &&
        conn.status === 'connected' &&
        txActive &&
        this._txAudioConfig.source === 'mic' &&
        this._isVoiceOrAfDataMode(snap);
      if (!keepMicOpen) {
        const curState =
          typeof this.audio.getMicStatus === 'function'
            ? this.audio.getMicStatus().state
            : 'idle';
        const shouldRelease =
          Boolean(this.audio._standbyMicStream) ||
          curState === 'ready' ||
          curState === 'requesting' ||
          curState === 'capturing' ||
          (isDemo && curState !== 'idle');
        if (shouldRelease && typeof this.audio.releaseMicStandby === 'function') {
          this.audio.releaseMicStandby();
        }
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
      if (this._isDemoMode(snap)) {
        this.toast('Demo mode is receive-only', 'info');
        return;
      }
      const posture = (this.client && typeof this.client.getTxPosture === 'function')
        ? this.client.getTxPosture()
        : (snap.txPosture || 'tx-armed');
      this._endHoldPtt();
      const next = !(Boolean(snap.txTestMode) || posture === 'tx-test');
      if (this.client && typeof this.client.setTxTest === 'function') {
        this.client.setTxTest(next);
      }
      this._syncTxMicStandby();
      this.toast(
        next ? 'TX Test ON — RF output inhibited' : 'TX Test OFF — TX Ready',
        'info'
      );
      this._render();
    }

    _beginHoldPtt() {
      const snap = this._getSnapshot();
      if (this._isDemoMode(snap)) return;
      if (!snap.connection || snap.connection.status !== 'connected') return;
      const posture = snap.txPosture || (this.client && typeof this.client.getTxPosture === 'function' ? this.client.getTxPosture() : 'tx-armed');
      if (posture === 'rx-only' || snap.txInhibit) return;
      if (
        this._isVoiceOrAfDataMode(snap) &&
        this._txAudioConfig &&
        this._txAudioConfig.source === 'mic' &&
        this.audio
      ) {
        const secOk = typeof this.audio.isMicSecureContextAvailable === 'function'
          ? this.audio.isMicSecureContextAvailable()
          : Boolean(window.isSecureContext);
        const st = typeof this.audio.getMicStatus === 'function'
          ? this.audio.getMicStatus()
          : { state: 'ready' };
        if (
          secOk &&
          st.state !== 'ready' &&
          st.state !== 'capturing' &&
          typeof this.audio.ensureMicReady === 'function'
        ) {
          this._pttHeldUi = true;
          const pttGen = ++this._pttRequestGen;
          this._render();
          this.audio.ensureMicReady({
            deviceId: this._txAudioConfig.deviceId || '',
            voiceProcessing: Boolean(this._txAudioConfig.voiceProcessing),
          }).then((res) => {
            const stillHeld = pttGen === this._pttRequestGen && this._pttHeldUi;
            if (!stillHeld) {
              if (this.audio && typeof this.audio.releaseMicStandby === 'function') {
                this.audio.releaseMicStandby();
              }
              if (res && (res.state === 'ready' || res.permissionGranted)) {
                if (this.inspector && typeof this.inspector._refreshMicDevices === 'function') {
                  this.inspector._refreshMicDevices();
                }
                this.toast('Microphone permission granted — hold PTT to transmit', 'info');
              }
              this._render();
              return;
            }
            const latest = this._getSnapshot();
            const latestPosture =
              latest.txPosture ||
              (this.client && typeof this.client.getTxPosture === 'function' ? this.client.getTxPosture() : 'tx-armed');
            if (
              this._isDemoMode(latest) ||
              latestPosture === 'rx-only' ||
              latest.txInhibit ||
              (latest.connection && latest.connection.status !== 'connected')
            ) {
              this._pttHeldUi = false;
              if (this.audio && typeof this.audio.releaseMicStandby === 'function') {
                this.audio.releaseMicStandby();
              }
              this._render();
              return;
            }
            if (res && (res.state === 'ready' || res.state === 'capturing')) {
              if (this.inspector && typeof this.inspector._refreshMicDevices === 'function') {
                this.inspector._refreshMicDevices();
              }
              if (this.pwa) this.pwa.notifyActivityChanged();
              if (this.client && typeof this.client.startPtt === 'function') {
                this.client.startPtt({ maxSeconds: 180 });
              }
            } else {
              this._pttHeldUi = false;
              if (this.inspector && typeof this.inspector.openTab === 'function') {
                this.inspector.openTab('tx');
              }
              this.toast('Microphone unavailable — grant mic permission or pick a TX audio source', 'warn');
            }
            this._render();
          });
          return;
        }
      }
      this._pttHeldUi = true;
      if (this.pwa) this.pwa.notifyActivityChanged();
      if (this.client && typeof this.client.startPtt === 'function') {
        this.client.startPtt({ maxSeconds: 180 });
      }
      this._render();
    }

    _endHoldPtt() {
      const snap = this._getSnapshot();
      const wasActive = Boolean(this._pttHeldUi || this._pttKeyHeld || snap.pttHeld || snap.txActive);
      this._pttRequestGen += 1;
      this._pttPointerId = null;
      this._pttKeyHeld = false;
      this._pttHeldUi = false;
      if (this.audio && typeof this.audio.stopTxCapture === 'function') {
        this.audio.stopTxCapture();
      }
      if (this.audio && typeof this.audio.releaseMicStandby === 'function') {
        this.audio.releaseMicStandby();
      }
      if (wasActive && this.client && typeof this.client.stopPtt === 'function') {
        this.client.stopPtt();
      }
      if (this.pwa) this.pwa.notifyActivityChanged();
      this._render();
    }

    panicAbortTx(reason = 'escape') {
      this._pttRequestGen += 1;
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
      if (this.pwa) this.pwa.notifyActivityChanged();
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
      if (this.audio && typeof this.audio.setMediaSmeterTargetRx === 'function') {
        this.audio.setMediaSmeterTargetRx(next);
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
      if (K4.ClientPrefs && typeof K4.ClientPrefs.set === 'function') {
        K4.ClientPrefs.set('mouseQsyMode', next);
      } else if (K4.storage) {
        K4.storage.set('k4.mouseQsyMode', next);
      }
      if (this.panadapter && this.panadapter.setMouseQsyMode) {
        this.panadapter.setMouseQsyMode(next);
      }
      this._render();
    }

    _syncTopbarHeight() {
      const bar = this._dom && this._dom.topBar;
      if (!bar || typeof document === 'undefined' || !document.documentElement) return;
      const rect = bar.getBoundingClientRect();
      if (rect && rect.height > 0) {
        document.documentElement.style.setProperty('--topbar-live-h', `${Math.ceil(rect.height)}px`);
      }
    }

    _recenterPanadapter() {
      const snap = this._getSnapshot();
      const dispRx = this._dispRx(snap);
      if (this.panadapter && this.panadapter.resetViewport) {
        this.panadapter.resetViewport(dispRx, { syncRadioSpan: true });
      }
    }

    _triggerAutoSpot() {
      if (typeof this.client.autoSpot === 'function') {
        this.client.autoSpot(this._targetRx);
      } else {
        this.client.sendCat(`SP${this._targetRx === 'B' ? '$' : ''}3;`);
      }
    }

    _toggleSpotTone() {
      const snap = this._getSnapshot();
      const rxS = (this._targetRx === 'B' ? snap.rxB : snap.rxA) || {};
      const nextOn = !(snap.spotTone || snap.cwSpotOn || rxS.spotMode === 1 || rxS.spotMode === 2);
      if (typeof this.client.setSpotTone === 'function') {
        this.client.setSpotTone(nextOn ? 1 : 0, 'A');
      } else {
        this.client.sendCat(`SP${nextOn ? '1' : '0'};`);
      }
    }

    _swapVfo(fullSwap) {
      const code = fullSwap ? 5 : 2;
      if (typeof this.client.vfoCopy === 'function') this.client.vfoCopy(code);
      else this.client.sendCat(`AB${code};`);
      if (fullSwap) this.toast('VFO A ↔ B full swap', 'info');
    }

    _triggerA2B(fullOverride) {
      const now = Date.now();
      const doFull = Boolean(fullOverride) || now < (this._a2bWindowUntil || 0);
      if (this._a2bCueTimer) {
        clearTimeout(this._a2bCueTimer);
        this._a2bCueTimer = null;
      }
      if (doFull) {
        this._a2bWindowUntil = 0;
        if (this._dom.vfoA2bBtn) this._dom.vfoA2bBtn.dataset.window = 'freq';
        if (typeof this.client.vfoCopy === 'function') this.client.vfoCopy(3);
        else this.client.sendCat('AB3;');
        this.toast('VFO A → B full copy', 'info');
      } else {
        this._a2bWindowUntil = now + 3000;
        if (this._dom.vfoA2bBtn) this._dom.vfoA2bBtn.dataset.window = 'full';
        if (typeof this.client.vfoCopy === 'function') this.client.vfoCopy(0);
        else this.client.sendCat('AB0;');
        this._a2bCueTimer = setTimeout(() => {
          this._a2bCueTimer = null;
          this._a2bWindowUntil = 0;
          if (this._dom.vfoA2bBtn) this._dom.vfoA2bBtn.dataset.window = 'freq';
        }, 3020);
      }
    }

    _toggleSplit(quickSplit) {
      if (quickSplit && typeof this.client.setupQuickSplit === 'function') {
        this.client.setupQuickSplit(1000);
        this.toast('Quick Split (+1 kHz on VFO B)', 'info');
      } else {
        const snap = this._getSnapshot();
        this.client.setSplit(!snap.splitEnabled);
      }
    }

    _toggleSubRx() {
      const snap = this._getSnapshot();
      this.client.setSubRx(!snap.subRxEnabled);
    }

    _toggleLock() {
      const snap = this._getSnapshot();
      const rxS = (this._targetRx === 'B' ? snap.rxB : snap.rxA) || {};
      const nextLocked = !Boolean(rxS.locked);
      if (typeof this.client.setLock === 'function') {
        this.client.setLock(this._targetRx, nextLocked);
      } else {
        this.client.sendCat(`LK${this._targetRx === 'B' ? '$' : ''}${nextLocked ? '1' : '0'};`);
      }
    }

    _toggleRit() {
      const snap = this._getSnapshot();
      const rxS = (this._targetRx === 'B' ? snap.rxB : snap.rxA) || {};
      const nextOn = !Boolean(rxS.ritOn);
      if (typeof this.client.setRit === 'function') {
        this.client.setRit(this._targetRx, { on: nextOn });
      } else {
        this.client.sendCat(`RT${this._targetRx === 'B' ? '$' : ''}${nextOn ? '1' : '0'};`);
      }
    }

    _clearRit() {
      if (typeof this.client.clearRit === 'function') {
        this.client.clearRit(this._targetRx);
      } else {
        this.client.sendCat(`RC${this._targetRx === 'B' ? '$' : ''};`);
      }
      this.toast(`Cleared RIT VFO ${this._targetRx}`, 'info');
    }

    _stepBand(dir) {
      const bands = Array.isArray(K4.BANDS) ? K4.BANDS : [];
      if (bands.length === 0 || !this.client || typeof this.client.setBand !== 'function') return;
      const snap = this._getSnapshot();
      const rxS = (this._targetRx === 'B' ? snap.rxB : snap.rxA) || {};
      let curIdx = -1;
      if (rxS.band != null) {
        const bandKey = typeof rxS.band === 'object' ? (rxS.band.bn || rxS.band.id || '') : rxS.band;
        if (bandKey !== '') {
          const bnStr = String(bandKey).padStart(2, '0');
          curIdx = bands.findIndex((b) => b.bn === bnStr || String(b.id) === String(bandKey));
        }
      }
      if (curIdx < 0 && Number.isFinite(rxS.freqHz)) {
        curIdx = bands.findIndex((b) => rxS.freqHz >= b.startHz && rxS.freqHz <= b.endHz);
      }
      if (curIdx < 0 && K4.BandPlan && typeof K4.BandPlan.getBandForFreq === 'function' && rxS.freqHz) {
        const bpBand = K4.BandPlan.getBandForFreq(rxS.freqHz);
        if (bpBand) curIdx = bands.findIndex((b) => b.id === bpBand.id || b.label === bpBand.label);
      }
      if (curIdx < 0) curIdx = 0;
      const nextIdx = (curIdx + dir + bands.length) % bands.length;
      const nextBand = bands[nextIdx];
      if (nextBand) {
        this.client.setBand(this._targetRx, nextBand);
      }
    }

    _triggerAtuTune() {
      const snap = this._getSnapshot();
      if (snap.hasAtu === false) return;
      const now = Date.now();
      const hot = Number(snap.atuSearchWindowUntil) > now || now < (this._atuTuneWindowUntil || 0);
      if (typeof this.client.startAtuTune === 'function') {
        this.client.startAtuTune(hot);
      } else {
        this.client.sendCat(hot ? 'TU4;' : 'TU3;');
      }
      if (!snap.txInhibit) {
        this._atuTuneWindowUntil = hot ? 0 : now + 3000;
      }
    }

    _executeFnMacro(fnKey) {
      const text = K4.ClientPrefs ? K4.ClientPrefs.getMacro(fnKey) : '';
      if (K4.SettingsPanel && typeof K4.SettingsPanel.executeMacro === 'function') {
        K4.SettingsPanel.executeMacro(text, this.client, (msg, level) => this.toast(msg, level));
      }
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
      this._syncPwaWakeLock();
      this._scheduleRender();
    }

    toggleDrawer() {
      this._drawerOpen = !this._drawerOpen;
      this._applyDrawerState();
      if (this._drawerOpen && this._dom.drawer) {
        requestAnimationFrame(() => {
          const target = this._dom.drawer.querySelector('.k4-tab-btn.is-active, .k4-tab-btn, button, input, select');
          if (target && typeof target.focus === 'function') {
            target.focus({ preventScroll: true });
          }
        });
      } else if (!this._drawerOpen && this._dom.drawer && this._dom.drawer.contains(document.activeElement) && this._dom.drawerToggleBtn) {
        this._dom.drawerToggleBtn.focus({ preventScroll: true });
      }
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
        if (
          res &&
          Number.isFinite(res.recenterStreamHz) &&
          this.panadapter._interaction &&
          typeof this.panadapter._interaction._sendIfCenterThrottled === 'function'
        ) {
          this.panadapter._interaction._sendIfCenterThrottled(dispRx, res.recenterStreamHz, true);
        }
        this.client.setDisplay(dispRx, { panSpanHz: res.radioSpanHz });
      } else {
        this.client.setDisplay(dispRx, { panSpanHz: targetSpanHz });
      }
    }

    _toggleTicker() {
      if (this._tickerEl && this._tickerEl.dataset.idle === 'true') {
        this._tickerExpanded = true;
        this._tickerEl.dataset.idle = 'false';
      } else {
        this._tickerExpanded = !this._tickerExpanded;
      }
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
      if (this.settingsPanel) this.settingsPanel.close();
      this.inspector.closeMobileSheet();
      this._syncTopbarHeight();
      this.omnibar.open(initialText);
    }

    openConnectionDialog() {
      this.omnibar.close();
      if (this.settingsPanel) this.settingsPanel.close();
      this.inspector.closeMobileSheet();
      this.connectionDialog.syncConnectionState(this._getSnapshot().connection);
      this.connectionDialog.open();
    }

    openSettings(focusSection) {
      this.omnibar.close();
      this.connectionDialog.close();
      this.inspector.closeMobileSheet();
      if (this.settingsPanel) this.settingsPanel.open(focusSection);
    }

    openMobileSheet(tabId) {
      this.inspector.toggleMobileSheet(tabId || 'tune');
    }

    closeOverlays() {
      this.omnibar.close();
      this.connectionDialog.close();
      if (this.settingsPanel) this.settingsPanel.close();
      this.inspector.closeMobileSheet();
    }

    toast(message, level = 'info') {
      if (!this._dom.toastStack || !message) return;
      const msgText = String(message);
      const last = this._dom.toastStack.lastElementChild;
      if (last && last.dataset.level === level && last.textContent === msgText) {
        return;
      }
      const item = el('div', 'k4-toast', msgText);
      item.dataset.level = level;
      this._dom.toastStack.appendChild(item);
      while (this._dom.toastStack.children.length > 3) {
        this._dom.toastStack.removeChild(this._dom.toastStack.firstChild);
      }
      const ttlMs = (level === 'info' || level === 'success') ? 2200 : 3800;
      setTimeout(() => {
        if (item.parentNode) item.parentNode.removeChild(item);
      }, ttlMs);
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

      if (pending.includes('decodedText')) {
        this._renderDecodedText(snap.decodedText);
      }

      if (this._dom.topAtuBtn && (pending.includes('txMeters') || pending.includes('swr'))) {
        this._syncTopRfStatus(snap);
      }

      if (!this.inspector) return;
      const touchesAudio = pending.some((k) => k === 'connection.rttMs' || k === 'latency' || k === 'telemetry');
      const touchesTx = pending.some(
        (k) => k === 'txMeters' || k === 'telemetry' || k === 'swr' || k === 'alc' || k === 'power' || k === 'idd' || k === 'vdd' || k === 'temp'
      );
      if (this.inspector.isDrawerOpen && this.inspector.isDrawerOpen()) {
        if (typeof this.inspector._updateSensorStrip === 'function') {
          this.inspector._updateSensorStrip(snap);
        }
        const visTab = typeof this.inspector._getVisibleTabId === 'function' ? this.inspector._getVisibleTabId() : null;
        if (touchesAudio) {
          if (visTab === 'audio' && typeof this.inspector._updateAudioTab === 'function') {
            const rxS = (this._targetRx === 'B' ? snap.rxB : snap.rxA) || {};
            this.inspector._updateAudioTab(snap, rxS, aDiag);
          } else {
            if (this.inspector._dirtyTabs) this.inspector._dirtyTabs.add('audio');
            if (this._uiPerf) {
              this._uiPerf.inspectorTabSkips += 1;
              if (!this.inspector._afScopeTimer) this._uiPerf.afScopeSkips += 1;
            }
          }
        }
        if (touchesTx) {
          if (visTab === 'tx' && typeof this.inspector._updateTxTab === 'function') {
            this.inspector._updateTxTab(snap, aDiag);
          } else {
            if (this.inspector._dirtyTabs) this.inspector._dirtyTabs.add('tx');
            if (this._uiPerf) this._uiPerf.inspectorTabSkips += 1;
          }
        }
      } else {
        if (this.inspector._dirtyTabs) {
          this.inspector._dirtyTabs.add('audio');
          this.inspector._dirtyTabs.add('tx');
        }
        if (this._uiPerf) {
          if (touchesAudio) {
            this._uiPerf.inspectorTabSkips += 1;
            if (!this.inspector._afScopeTimer) this._uiPerf.afScopeSkips += 1;
          }
          if (touchesTx) this._uiPerf.inspectorTabSkips += 1;
        }
      }
    }

    _syncDisconnectedCard(snap) {
      if (!this._disconnectedCard) return;
      const conn = (snap && snap.connection) || {};
      const status = conn.status || 'disconnected';
      const dlgOpen = Boolean(this._dom.connDialog && this._dom.connDialog.dataset.open === 'true');
      this._disconnectedCard.hidden = !(status === 'disconnected' && !dlgOpen && !this._autoReconnecting);
    }

    _syncPwaWakeLock(aDiag) {
      const diag =
        aDiag || (this.audio && this.audio.getDiagnostics ? this.audio.getDiagnostics() : { started: false, muted: true });
      if (this.pwa && typeof this.pwa.setAudioPlaying === 'function') {
        this.pwa.setAudioPlaying(Boolean(diag && diag.started && !diag.muted));
      }
    }

    _syncAudioToggleUi(snap, aDiagOverride) {
      if (!this._dom.audioToggleBtn || !this._dom.audioLabel) return;
      const aDiag =
        aDiagOverride || (this.audio && this.audio.getDiagnostics ? this.audio.getDiagnostics() : { started: false, muted: true });
      const modeTxt = snap.encodeMode === 2 || snap.encodeMode === 3 ? 'Opus 48k' : (snap.encodeMode === 0 ? 'PCM 24b' : 'PCM 12k');
      if (!aDiag.started) {
        this._dom.audioToggleBtn.dataset.state = 'off';
        this._dom.audioLabel.textContent = 'Audio Off';
        this._dom.audioToggleBtn.title = `Start Receiver Audio (${modeTxt})`;
        this._dom.audioToggleBtn.setAttribute('aria-pressed', 'false');
      } else if (aDiag.muted) {
        this._dom.audioToggleBtn.dataset.state = 'muted';
        this._dom.audioLabel.textContent = 'Muted';
        this._dom.audioToggleBtn.title = `Unmute Receiver Audio (${modeTxt}, M)`;
        this._dom.audioToggleBtn.setAttribute('aria-pressed', 'false');
      } else {
        this._dom.audioToggleBtn.dataset.state = 'active';
        this._dom.audioLabel.textContent = 'Audio';
        this._dom.audioToggleBtn.title = `Mute Receiver Audio (${modeTxt}, M)`;
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
        this._dom.connRtt.title = '';
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
      this._dom.connRtt.textContent = audioActive && e2eRxNum !== null ? `${e2eRxNum}ms` : `RTT ${rttNum}ms`;

      const halfRtt = Number.isFinite(brk.rxNetHalfRttMs) ? Math.round(brk.rxNetHalfRttMs) : Math.round(rttNum / 2);
      const frame = Number.isFinite(brk.rxFrameMs) ? Math.round(brk.rxFrameMs) : 20;
      const jitter = Number.isFinite(brk.rxJitterMs) ? Math.round(brk.rxJitterMs) : 0;
      const outMs = Number.isFinite(brk.rxAudioOutMs) ? Math.round(brk.rxAudioOutMs) : 0;
      const tooltip = audioActive && e2eRxNum !== null
        ? [
            `Estimated RX audio delay: ${e2eRxNum} ms (radio -> speakers)`,
            `• Network one-way (½ RTT): ${halfRtt} ms (ping RTT: ${rttNum} ms)`,
            `• Audio packet framing: ${frame} ms`,
            `• Browser jitter buffer: ${jitter} ms`,
            `• Web Audio output: ${outMs} ms`,
            ...(e2eTxNum !== null ? [`Estimated TX audio delay: ${e2eTxNum} ms (mic -> radio)`] : []),
            'Click for connection settings',
          ].join('\n')
        : [
            `Network round-trip latency (RTT): ${rttNum} ms (CAT ping to radio)`,
            'Unmute audio to show total estimated RX audio delay (network + framing + jitter buffer + output).',
            'Click for connection settings',
          ].join('\n');
      this._dom.connRtt.title = tooltip;
      this._dom.connBtn.title = tooltip;
    }

    _syncTopRfStatus(snap) {
      if (this._dom.topAntBtn) {
        const ant = K4.formatTxAntenna(snap);
        this._dom.topAntBtn.replaceChildren();
        const portSpan = document.createElement('span');
        portSpan.className = 'k4-ant-port';
        if (ant.hasCustom) {
          portSpan.textContent = `${ant.port}:`;
          this._dom.topAntBtn.appendChild(portSpan);
          const nameSpan = document.createElement('span');
          nameSpan.className = 'k4-ant-name';
          nameSpan.textContent = ant.rawName;
          this._dom.topAntBtn.appendChild(nameSpan);
        } else {
          portSpan.textContent = `ANT ${ant.port}`;
          this._dom.topAntBtn.appendChild(portSpan);
        }
        this._dom.topAntBtn.dataset.port = String(ant.port);
        this._dom.topAntBtn.title = `Active TX Antenna ANT ${ant.port}${ant.hasCustom ? ` (${ant.rawName})` : ''} — click to cycle ANT 1 → 2 → 3`;
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
        const swrLabel = liveSwr >= 1.0 ? ` (SWR ${liveSwr.toFixed(1)}:1)` : '';

        if (tuning) {
          btn.dataset.state = 'tuning';
          btn.textContent = liveSwr >= 1.0 ? `TUNE ${liveSwr.toFixed(1)}` : 'ATU TUNE';
          btn.title = 'ATU tuning in progress — click to stop';
        } else if (searchHot) {
          btn.dataset.state = 'search-hot';
          btn.textContent = 'ATU 2x FULL';
          btn.title = 'Double-tap window open: Shift+Click or Shift+T to run Full Search ATU tune';
        } else if (Number(snap.atuMode) === 2) {
          if (liveSwr >= 1.8) {
            btn.dataset.state = 'warn';
            btn.textContent = `ATU ${liveSwr.toFixed(1)}`;
            btn.title = `ATU Auto — high SWR${swrLabel} (click: Bypass · Shift+Click / Shift+T: ATU Tune)`;
          } else {
            btn.dataset.state = 'auto';
            btn.textContent = 'ATU';
            btn.title = `ATU Auto${swrLabel} (click: Bypass · Shift+Click / Shift+T: ATU Tune · 2nd tap: Full Search)`;
          }
        } else {
          btn.dataset.state = 'bypass';
          btn.textContent = 'BYP';
          btn.title = `ATU Bypassed${swrLabel} (click: Auto · Shift+Click / Shift+T: ATU Tune)`;
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
      if (status === 'connected') {
        this._wasConnectedForWf = true;
      } else if (this._wasConnectedForWf) {
        this._wasConnectedForWf = false;
        if (this.panadapter && typeof this.panadapter.clearWaterfall === 'function') {
          this.panadapter.clearWaterfall();
        }
      }
      this._lastConnStatus = status;
      this._lastAuthStatus = conn.authStatus || null;
      this._lastRadioId = conn.radioId || '';
      this._lastWsUrl = conn.wsUrl || '';
      this._dom.connBtn.dataset.status = status;
      let statusLabel = 'Disconnected';
      if (status === 'connected') {
        statusLabel = conn.radioId ? `${conn.radioId} · ${extractHostLabel(conn.wsUrl)}` : extractHostLabel(conn.wsUrl);
      } else if (this._autoReconnecting) {
        statusLabel = 'Reconnecting…';
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
      this._syncDisconnectedCard(snap);

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

      // K4 Center Icon Area
      const splitOn = Boolean(snap.splitEnabled);
      if (this._dom.centerSplitInd) {
        this._dom.centerSplitInd.classList.toggle('is-active', splitOn);
        this._dom.centerSplitInd.setAttribute('aria-pressed', splitOn ? 'true' : 'false');
      }
      if (this._dom.centerMsgInd) {
        const msgBank = this.inspector && this.inspector._msgBank === 2 ? 2 : 1;
        const msgPlaying = Boolean(snap.dvrPlaying);
        this._dom.centerMsgInd.textContent = msgBank === 2 ? 'MSG II' : 'MSG I';
        this._dom.centerMsgInd.classList.toggle('is-active', msgPlaying || msgBank === 2);
        this._dom.centerMsgInd.setAttribute('aria-pressed', msgPlaying ? 'true' : 'false');
      }
      const txVfoObj = snap.activeTxVfo === 'B' ? (snap.rxB || {}) : (snap.rxA || {});
      const txModeNum = Number(txVfoObj.mode) || 2;
      const activeVoxOn =
        txModeNum === 3 || txModeNum === 7
          ? Boolean(snap.voxCw)
          : txModeNum === 6 || txModeNum === 9
          ? Boolean(snap.voxData)
          : Boolean(snap.voxVoice);
      if (this._dom.centerVoxInd) {
        this._dom.centerVoxInd.classList.toggle('is-active', activeVoxOn);
        this._dom.centerVoxInd.setAttribute('aria-pressed', activeVoxOn ? 'true' : 'false');
      }
      if (this._dom.centerQskInd) {
        const qskOn = Boolean(snap.voxCw) && (txModeNum === 3 || txModeNum === 7);
        this._dom.centerQskInd.classList.toggle('is-active', qskOn);
        this._dom.centerQskInd.setAttribute('aria-pressed', qskOn ? 'true' : 'false');
      }
      if (this._dom.centerRitXitBox) {
        const tgtS = (this._targetRx === 'B' ? snap.rxB : snap.rxA) || {};
        const ritOn = Boolean(tgtS.ritOn);
        const xitOn = Boolean(snap.xitEnabled);
        const offHz = Math.round(Number(tgtS.ritOffsetHz) || 0);
        const sign = offHz < 0 ? '-' : '+';
        const khzVal = (Math.abs(offHz) / 1000).toFixed(2);
        const prefix = ritOn && xitOn ? 'R/X' : xitOn ? 'XIT' : 'RIT';
        this._dom.centerRitXitBox.textContent = `${prefix} ${sign}${khzVal}`;
        this._dom.centerRitXitBox.classList.toggle('is-active', ritOn || xitOn);
        this._dom.centerRitXitBox.classList.toggle('is-rit-on', ritOn);
        this._dom.centerRitXitBox.classList.toggle('is-xit-on', xitOn);
        this._dom.centerRitXitBox.setAttribute('aria-pressed', ritOn || xitOn ? 'true' : 'false');
      }

      // Top-bar ANT & ATU pills
      this._syncTopRfStatus(snap);

      // Audio Toggle Button
      this._syncAudioToggleUi(snap, aDiag);

      // Direct TX Controls (TEST, Mic status, Hold-to-Talk PTT)
      const isDemo = this._isDemoMode(snap);
      const posture = isDemo
        ? 'rx-only'
        : (snap.txPosture || (this.client && typeof this.client.getTxPosture === 'function' ? this.client.getTxPosture() : 'tx-armed'));
      const isTest = !isDemo && Boolean(snap.txTestMode || posture === 'tx-test');
      const transmitting = !isDemo && Boolean(snap.txActive || snap.atuTuning);
      if (this._dom.txPostureBar) {
        this._dom.txPostureBar.dataset.posture = posture;
        this._dom.txPostureBar.dataset.txTest = isTest ? 'true' : 'false';
        this._dom.txPostureBar.dataset.transmitting = transmitting ? 'true' : 'false';
      }
      if (this._dom.txModeTestBtn) {
        this._dom.txModeTestBtn.disabled = isDemo;
        this._dom.txModeTestBtn.classList.toggle('is-active', isTest);
        this._dom.txModeTestBtn.setAttribute('aria-pressed', isTest ? 'true' : 'false');
        this._dom.txModeTestBtn.title = isDemo
          ? 'Demo mode is receive-only'
          : 'Toggle TX Test mode (TS1 — RF output inhibited)';
      }

      if (this._dom.pttBtn) {
        const pttEnabled = !isDemo && posture !== 'rx-only' && !snap.txInhibit;
        this._dom.pttBtn.disabled = !pttEnabled;
        const pttActive = !isDemo && Boolean(this._pttHeldUi || snap.pttHeld || snap.txActive);
        const pttInfo = K4.describePttMicState(snap, this._txAudioConfig, this.audio, isTest);
        this._dom.pttBtn.classList.toggle('is-held', !isDemo && Boolean(this._pttHeldUi || snap.pttHeld));
        this._dom.pttBtn.classList.toggle('is-tx', !isDemo && Boolean(snap.txActive));
        this._dom.pttBtn.dataset.micState = pttInfo.micState;
        this._dom.pttBtn.dataset.micWarn = !isDemo && pttInfo.micWarn ? 'true' : 'false';
        this._dom.pttBtn.setAttribute('aria-pressed', pttActive ? 'true' : 'false');
        this._dom.pttBtn.textContent = (!isDemo && snap.txActive) ? pttInfo.topTxLabel : pttInfo.idleLabel;
        this._dom.pttBtn.title = isDemo
          ? 'Demo mode is receive-only (microphone unused)'
          : `Hold to transmit (Spacebar when un-focused; releases immediately on keyup or blur)${pttInfo.titleDetail}`;
      }

      // Floating Panadapter HUD
      const rxS = (this._targetRx === 'B' ? snap.rxB : snap.rxA) || {};
      const dispRx = this._dispRx(snap);
      const dispS = (dispRx === 'B' ? snap.rxB : snap.rxA) || {};
      const loupeRx = this._resolveLoupeRx(snap);
      const loupeS = (loupeRx === 'B' ? snap.rxB : snap.rxA) || {};
      this._hudTargetLabel.textContent = this._wheelRitMode
        ? 'R'
        : this._targetRx;
      this._hudTargetBtn.classList.toggle('is-cyan', !this._wheelRitMode && this._targetRx === 'A');
      this._hudTargetBtn.classList.toggle('is-amber', !this._wheelRitMode && this._targetRx === 'B');
      this._hudTargetBtn.classList.toggle('is-rit', Boolean(this._wheelRitMode));
      const qsyDesc =
        this._mouseQsyMode === 'pane'
          ? 'Left Only (Pane=VFO, Shift+Left=B)'
          : 'Left=A, Right=B (in either pane)';
      this._hudTargetBtn.title = `K4 Mouse (${qsyDesc}). Wheel tunes ${this._wheelRitMode ? `VFO ${this._targetRx} RIT/XIT (R)` : `VFO ${this._targetRx}`}. Click to cycle; middle-click or Shift-click to toggle R.`;
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
      if (this._hudPanNbPill) {
        const nbMode = Number(dispS.panNbMode) || 0;
        this._hudPanNbPill.hidden = nbMode <= 0;
        if (nbMode > 0) {
          this._hudPanNbPill.textContent = nbMode === 2 ? 'NB AUTO' : 'NB';
          this._hudPanNbPill.dataset.panNbMode = String(nbMode);
        }
      }

      const isCw = Number(rxS.mode) === 3 || Number(rxS.mode) === 7;
      const spotActive = Boolean(snap.spotTone || rxS.spotMode === 1 || rxS.spotMode === 2);
      if (this._hudSpotSep) {
        this._hudSpotSep.hidden = !isCw;
      }
      if (this._hudAutoSpotBtn) {
        this._hudAutoSpotBtn.hidden = !isCw;
        this._hudAutoSpotBtn.disabled = !isCw;
        this._hudAutoSpotBtn.classList.toggle('is-cw-ready', isCw);
        this._hudAutoSpotBtn.title = isCw
          ? `Zero-beat CW signal on VFO ${this._targetRx}`
          : 'Auto Spot (select CW or CW-R mode)';
      }
      if (this._hudCwSpotBtn) {
        this._hudCwSpotBtn.hidden = !isCw;
        this._hudCwSpotBtn.disabled = !isCw;
        this._hudCwSpotBtn.classList.toggle('is-cw-ready', isCw);
        this._hudCwSpotBtn.classList.toggle('is-active', isCw && spotActive);
        this._hudCwSpotBtn.setAttribute('aria-pressed', isCw && spotActive ? 'true' : 'false');
        this._hudCwSpotBtn.title = isCw
          ? 'Toggle CW Spot sidetone'
          : 'Spot sidetone (select CW or CW-R mode)';
      }
      if (this._lastHudCwMode !== isCw) {
        this._lastHudCwMode = isCw;
        if (this.panadapter && typeof this.panadapter.invalidateHudLayout === 'function') {
          this.panadapter.invalidateHudLayout();
        }
      }

      // Decoded Text Ticker (TB$)
      let tickerSupported = false;
      if (this._tickerDecodeSelect && typeof K4.syncDecodeSelect === 'function') {
        const tdDesc = K4.syncDecodeSelect(this._tickerDecodeSelect, rxS);
        tickerSupported = Boolean(tdDesc && tdDesc.supported);
      }
      const hasDecoded = Array.isArray(snap.decodedText) && snap.decodedText.length > 0;
      if (this._tickerEl) {
        this._tickerEl.dataset.idle = !tickerSupported && !hasDecoded && !this._tickerExpanded ? 'true' : 'false';
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
