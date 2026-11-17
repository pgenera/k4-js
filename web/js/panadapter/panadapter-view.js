'use strict';

(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  function createDefaultSnapshot() {
    return {
      cwPitchHz: 500,
      subRxEnabled: false,
      splitEnabled: false,
      vfoLinked: false,
      panAvg: 4,
      dualPanMode: 0,
      rxA: {
        freqHz: 14074000,
        mode: 6,
        dataSubMode: 0,
        bwHz: 2700,
        ifShiftHz: 1500,
        stepHz: 100,
        notchOn: false,
        notchHz: 750,
        panSpanHz: 48000,
        panRefDbm: -110,
        panScaleDb: 80,
        wfBlack: 14,
        miniPan: false,
        panCenterHz: 14074000,
        panTierKHz: 48,
        noiseFloorDbm: -120,
      },
      rxB: {
        freqHz: 14025000,
        mode: 3,
        dataSubMode: 0,
        bwHz: 500,
        ifShiftHz: 500,
        stepHz: 100,
        notchOn: false,
        notchHz: 750,
        panSpanHz: 48000,
        panRefDbm: -110,
        panScaleDb: 80,
        wfBlack: 14,
        miniPan: false,
        panCenterHz: 14025000,
        panTierKHz: 48,
        noiseFloorDbm: -120,
      },
    };
  }

  const IGNORED_STATE_KEYS = new Set([
    'rxA.sMeterDbm',
    'rxB.sMeterDbm',
    'telemetry',
    'connection.rttMs',
    'rxA.panMeta',
    'rxB.panMeta',
    'audio.rxGain',
    'spotTone',
  ]);

  class PanadapterView {
    constructor(opts = {}) {
      const {
        container,
        state,
        client,
        renderer = 'auto',
        palette = 'obsidian',
        peakHold = false,
        mouseQsyMode = 'lr',
        onSelectTarget = null,
        onToggleWheelRit = null,
        onNotify = null,
        onViewportChange = null,
      } = opts || {};
      if (!container) {
        throw new Error('PanadapterView requires a container element');
      }
      this._container = container;
      this._state = state || null;
      this._client = client || null;
      this._destroyed = false;

      this._targetRx = 'A';
      this._mouseQsyMode = mouseQsyMode === 'pane' ? 'pane' : 'lr';
      this._voiceClickSnapKhz =
        opts && opts.voiceClickSnapKhz !== undefined
          ? Boolean(opts.voiceClickSnapKhz)
          : Boolean(
              K4.storage ? K4.storage.get('prefs.voiceClickSnapKhz', true) : true
            );
      this._wheelRitMode = false;
      this._onSelectTarget =
        typeof onSelectTarget === 'function' ? onSelectTarget : null;
      this._onToggleWheelRit =
        typeof onToggleWheelRit === 'function' ? onToggleWheelRit : null;
      this._onNotify = typeof onNotify === 'function' ? onNotify : null;
      this._onViewportChange =
        typeof onViewportChange === 'function' ? onViewportChange : null;
      this._palette = palette || 'obsidian';
      this._peakHold = Boolean(peakHold);
      this._framesRendered = 0;
      this._lastClickFreqHz = null;
      this._hoverState = null;
      this._rafId = 0;
      this._autoFixedTuneFromDrag = false;

      if (typeof globalThis.getComputedStyle === 'function') {
        const pos = globalThis.getComputedStyle(container).position;
        if (pos === 'static') {
          container.style.position = 'relative';
        }
      }

      this._miniPanRafId = 0;
      this._miniPanDirtyRx = { A: false, B: false };

      this._renderer = K4.createPanRenderer(container, {
        renderer,
        palette: this._palette,
        onHudInvalidate: () => this._scheduleRender(),
        onCloseMiniPan: (rx) => this.closeMiniPan(rx),
      });

      this._panes = {
        A: this._createPaneState(),
        B: this._createPaneState(),
      };
      const initialSnap = this._getSnapshot();
      for (const rxKey of ['A', 'B']) {
        const rxInit = (rxKey === 'B' ? initialSnap.rxB : initialSnap.rxA) || {};
        if (Number.isFinite(rxInit.freqHz) && rxInit.freqHz > 0) {
          this._panes[rxKey].lastKnownStateFreqHz = rxInit.freqHz;
        }
      }

      this._miniPanByRx = {
        A: {
          rx: 'A',
          centerFreqHz: 14074000,
          spanKHz: 10,
          dbmBins: null,
          seq: 0,
          rawDbmScratch: new Float32Array(1024),
        },
        B: {
          rx: 'B',
          centerFreqHz: 14025000,
          spanKHz: 10,
          dbmBins: null,
          seq: 0,
          rawDbmScratch: new Float32Array(1024),
        },
      };

      container.dataset.renderer = this._renderer.type;
      container.dataset.frames = '0';
      container.dataset.targetRx = this._targetRx;
      container.dataset.mouseQsyMode = this._mouseQsyMode;
      container.dataset.wheelRit = 'false';

      this._interaction = K4.PanadapterInteraction
        ? new K4.PanadapterInteraction({
            surface: this._renderer.surface,
            renderer: this._renderer,
            view: this,
            state: this._state,
            client: this._client,
          })
        : null;

      this._unsubState = null;
      if (this._state && typeof this._state.on === 'function') {
        this._unsubState = this._state.on('change', (snap, changedKey, changedKeysSet) => {
          this._onStateChange(snap, changedKey, changedKeysSet);
        });
      }
      this._bookmarksRev = 0;
      this._cachedBookmarks =
        K4.BookmarkStore && typeof K4.BookmarkStore.list === 'function'
          ? K4.BookmarkStore.list()
          : [];
      this._unsubBookmarks =
        K4.BookmarkStore && typeof K4.BookmarkStore.subscribe === 'function'
          ? K4.BookmarkStore.subscribe((next) => {
              this._cachedBookmarks = Array.isArray(next)
                ? next
                : K4.BookmarkStore.list();
              this._bookmarksRev++;
              this._scheduleRender();
            })
          : null;

      this._resizeObserver = null;
      if (typeof globalThis.ResizeObserver === 'function') {
        this._resizeObserver = new globalThis.ResizeObserver(() => {
          this.resize();
        });
        this._resizeObserver.observe(container);
      }
      this._onWindowResize = () => this.resize();
      if (typeof globalThis.addEventListener === 'function') {
        globalThis.addEventListener('resize', this._onWindowResize);
      }

      this._onVisibilityChange = () => {
        if (!this._destroyed && typeof document !== 'undefined' && !document.hidden) {
          this._renderer.resize();
          this._renderNow(false);
        }
      };
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', this._onVisibilityChange);
      }

      // Draw initial clean grid/needles at framesRendered = 0 and schedule a rAF pass
      // so sibling HUD overlays mounted immediately after construction are measured.
      this._renderNow(false);
      this._scheduleRender();
    }

    _createPaneState() {
      return {
        averager: new K4.PowerAverager(1024, 4),
        rawDbmScratch: new Float32Array(1024),
        wfRowScratch: new Uint8Array(1024),
        avgDbm: null,
        shownDbm: null,
        peakDbm: null,
        binsReady: false,
        binSeq: 0,
        lastTierKHz: null,
        lastCenterHz: null,
        panCenterHz: null,
        streamCenterHz: null,
        streamSpanHz: null,
        pendingStreamCenterHz: null,
        pendingStreamCenterUntil: 0,
        customCenterHz: null,
        customSpanHz: null,
        recentRadioSpans: [],
        lastKnownStateSpanHz: null,
        lastKnownStateFreqHz: null,
        tierKHz: null,
        noiseFloorDbm: null,
      };
    }

    _getSnapshot() {
      if (this._state && typeof this._state.getSnapshot === 'function') {
        return this._state.getSnapshot();
      }
      return createDefaultSnapshot();
    }

    _onStateChange(snap, changedKey, changedKeysSet) {
      if (this._destroyed || !snap) return;
      if (changedKeysSet && changedKeysSet.size > 0) {
        let relevant = false;
        for (const k of changedKeysSet) {
          if (k === 'txMeters') {
            if (snap.atuTuning) {
              relevant = true;
              break;
            }
            continue;
          }
          if (!IGNORED_STATE_KEYS.has(k)) {
            relevant = true;
            break;
          }
        }
        if (!relevant) return;
      } else if (
        changedKey &&
        (IGNORED_STATE_KEYS.has(changedKey) ||
          (changedKey === 'txMeters' && !snap.atuTuning))
      ) {
        return;
      }
      if (!snap.fixedTune) {
        this._autoFixedTuneFromDrag = false;
      }
      const isVfoCopy =
        changedKey === 'vfoCopy' ||
        Boolean(changedKeysSet && changedKeysSet.has('vfoCopy'));
      const nowMs =
        typeof performance !== 'undefined' ? performance.now() : Date.now();
      for (const rxKey of ['A', 'B']) {
        const rxSnap = (rxKey === 'B' ? snap.rxB : snap.rxA) || {};
        const pane = this._panes[rxKey];
        const curSpan = Number(rxSnap.panSpanHz);
        if (Number.isFinite(curSpan) && curSpan > 0) {
          if (
            pane.lastKnownStateSpanHz !== null &&
            curSpan !== pane.lastKnownStateSpanHz
          ) {
            const isOwnEcho = pane.recentRadioSpans.some(
              (s) => Math.abs(s - curSpan) <= 500
            );
            if (!isOwnEcho) {
              pane.customSpanHz = null;
              pane.customCenterHz = null;
              pane.recentRadioSpans.length = 0;
            }
          }
          pane.lastKnownStateSpanHz = curSpan;
        }
        const streamSpan =
          Number.isFinite(pane.streamSpanHz) && pane.streamSpanHz > 0
            ? pane.streamSpanHz
            : Number.isFinite(curSpan) && curSpan > 0
              ? curSpan
              : 48000;
        const panCenter = Number(rxSnap.panCenterHz);
        const awaitingStreamShift =
          !isVfoCopy &&
          pane.pendingStreamCenterUntil > nowMs &&
          Number.isFinite(pane.pendingStreamCenterHz) &&
          (!Number.isFinite(panCenter) ||
            Math.abs(panCenter - pane.pendingStreamCenterHz) > 2500);
        if (Number.isFinite(panCenter) && panCenter > 0 && !awaitingStreamShift) {
          if (
            isVfoCopy ||
            !(Number.isFinite(pane.streamCenterHz) && pane.streamCenterHz > 0) ||
            Math.abs(pane.streamCenterHz - panCenter) > streamSpan / 2
          ) {
            pane.streamCenterHz = panCenter;
            pane.panCenterHz = panCenter;
            if (isVfoCopy) {
              pane.pendingStreamCenterUntil = 0;
              pane.pendingStreamCenterHz = null;
            }
          }
        }
        const newFreq = Number(rxSnap.freqHz);
        if (pane.customCenterHz !== null) {
          const baseSpan =
            Number.isFinite(curSpan) && curSpan > 0 ? curSpan : 48000;
          const viewSpan = clamp(
            Number.isFinite(pane.customSpanHz) && pane.customSpanHz > 0
              ? pane.customSpanHz
              : baseSpan,
            6000,
            368000
          );
          const halfMargin = viewSpan * 0.48;
          const oldFreq =
            Number.isFinite(pane.lastKnownStateFreqHz) &&
            pane.lastKnownStateFreqHz > 0
              ? pane.lastKnownStateFreqHz
              : newFreq;
          const oldInView =
            Number.isFinite(oldFreq) &&
            oldFreq > 0 &&
            Math.abs(oldFreq - pane.customCenterHz) <= halfMargin;
          const newInView =
            Number.isFinite(newFreq) &&
            newFreq > 0 &&
            Math.abs(newFreq - pane.customCenterHz) <= halfMargin;
          if (isVfoCopy) {
            if (!(oldInView && newInView)) {
              pane.customCenterHz = null;
            }
          } else if (
            !awaitingStreamShift &&
            viewSpan >= streamSpan * 0.99 &&
            Number.isFinite(newFreq) &&
            newFreq > 0 &&
            !newInView
          ) {
            pane.customCenterHz = null;
          }
        }
        if (Number.isFinite(newFreq) && newFreq > 0) {
          pane.lastKnownStateFreqHz = newFreq;
        }
      }
      this._scheduleRender();
    }

    _resolveStreamCenterHz(rxKey, rxSnap) {
      const p = this._panes[rxKey];
      if (Number.isFinite(p.streamCenterHz)) return p.streamCenterHz;
      if (Number.isFinite(p.panCenterHz)) return p.panCenterHz;
      if (rxSnap && Number.isFinite(rxSnap.panCenterHz)) return rxSnap.panCenterHz;
      return (rxSnap && Number.isFinite(rxSnap.freqHz) && rxSnap.freqHz) || 14074000;
    }

    _resolvePaneViewport(rxKey, rxSnap) {
      const pane = this._panes[rxKey];
      const streamCenterHz = this._resolveStreamCenterHz(rxKey, rxSnap);
      const baseSpanHz =
        rxSnap && Number.isFinite(rxSnap.panSpanHz) && rxSnap.panSpanHz > 0
          ? rxSnap.panSpanHz
          : 48000;
      const userSpanHz = clamp(
        Number.isFinite(pane.customSpanHz) && pane.customSpanHz > 0
          ? pane.customSpanHz
          : baseSpanHz,
        6000,
        368000
      );
      const maxOffsetHz = Math.max(0, (368000 - userSpanHz) * 0.5);
      let panCenterHz = streamCenterHz;
      if (Number.isFinite(pane.customCenterHz) && maxOffsetHz > 0) {
        const offsetHz = clamp(
          pane.customCenterHz - streamCenterHz,
          -maxOffsetHz,
          maxOffsetHz
        );
        panCenterHz = Math.round(streamCenterHz + offsetHz);
      }
      const vfoFreqHz =
        (rxSnap && Number.isFinite(rxSnap.freqHz) && rxSnap.freqHz) ||
        streamCenterHz;
      const isOffset =
        Math.abs(panCenterHz - streamCenterHz) >= 50 ||
        Math.abs(panCenterHz - vfoFreqHz) >= 50;
      return { streamCenterHz, panCenterHz, userSpanHz, isOffset };
    }

    _recordRadioSpan(pane, spanHz) {
      const clamped = clamp(Math.round(spanHz), 6000, 368000);
      pane.recentRadioSpans.push(clamped);
      if (pane.recentRadioSpans.length > 12) {
        pane.recentRadioSpans.shift();
      }
      return clamped;
    }

    getVisibleSpanHz(rx) {
      const key = rx === 'B' ? 'B' : 'A';
      const snap = this._getSnapshot();
      const rxSnap = (key === 'B' ? snap.rxB : snap.rxA) || {};
      return this._resolvePaneViewport(key, rxSnap).userSpanHz;
    }

    isViewportOffset(rx) {
      const key = rx === 'B' ? 'B' : 'A';
      const snap = this._getSnapshot();
      const rxSnap = (key === 'B' ? snap.rxB : snap.rxA) || {};
      return this._resolvePaneViewport(key, rxSnap).isOffset;
    }

    applyMapZoom(
      rx,
      { factor = 1, targetSpanHz = null, anchorFrac = 0.5, anchorFreqHz = null } = {}
    ) {
      const key = rx === 'B' ? 'B' : 'A';
      const snap = this._getSnapshot();
      const rxSnap = (key === 'B' ? snap.rxB : snap.rxA) || {};
      const pane = this._panes[key];
      const cur = this._resolvePaneViewport(key, rxSnap);

      const u = clamp(Number.isFinite(anchorFrac) ? anchorFrac : 0.5, 0, 1);
      const fAnchor = Number.isFinite(anchorFreqHz)
        ? anchorFreqHz
        : cur.panCenterHz + (u - 0.5) * cur.userSpanHz;
      const rawNextSpan =
        Number.isFinite(targetSpanHz) && targetSpanHz > 0
          ? targetSpanHz
          : cur.userSpanHz * (Number.isFinite(factor) && factor > 0 ? factor : 1);
      const nextSpanHz = clamp(Math.round(rawNextSpan), 6000, 368000);

      const rawCenterHz = fAnchor - (u - 0.5) * nextSpanHz;
      const maxOffsetHz = Math.max(0, (368000 - nextSpanHz) * 0.5);
      const clampedOffsetHz = clamp(
        rawCenterHz - cur.streamCenterHz,
        -maxOffsetHz,
        maxOffsetHz
      );
      const nextCenterHz = Math.round(cur.streamCenterHz + clampedOffsetHz);

      pane.customCenterHz = Math.abs(clampedOffsetHz) < 25 ? null : nextCenterHz;
      pane.customSpanHz = nextSpanHz;
      const effectiveCenterHz =
        pane.customCenterHz === null ? cur.streamCenterHz : nextCenterHz;
      const radioSpanHz = this._recordRadioSpan(
        pane,
        Math.ceil(nextSpanHz + 2 * Math.abs(effectiveCenterHz - cur.streamCenterHz))
      );

      this._scheduleRender();
      if (this._onViewportChange) {
        this._onViewportChange(key);
      }
      return {
        rx: key,
        panCenterHz: effectiveCenterHz,
        userSpanHz: nextSpanHz,
        streamCenterHz: cur.streamCenterHz,
        radioSpanHz,
        isOffset: Math.abs(effectiveCenterHz - cur.streamCenterHz) >= 50,
      };
    }

    panViewportByHz(rx, deltaHz) {
      const key = rx === 'B' ? 'B' : 'A';
      const snap = this._getSnapshot();
      const rxSnap = (key === 'B' ? snap.rxB : snap.rxA) || {};
      const pane = this._panes[key];
      const cur = this._resolvePaneViewport(key, rxSnap);

      const rawCenterHz =
        cur.panCenterHz + (Number.isFinite(deltaHz) ? deltaHz : 0);
      const maxOffsetHz = Math.max(0, (368000 - cur.userSpanHz) * 0.5);
      const rawOffsetHz = rawCenterHz - cur.streamCenterHz;
      let recenterStreamHz = null;
      let nextStreamCenterHz = cur.streamCenterHz;
      let effectiveCenterHz;

      if (Math.abs(rawOffsetHz) > maxOffsetHz) {
        const clampedAbs = clamp(Math.round(rawCenterHz), 100000, 54000000);
        nextStreamCenterHz = clampedAbs;
        pane.streamCenterHz = clampedAbs;
        pane.customCenterHz = null;
        pane.pendingStreamCenterHz = clampedAbs;
        pane.pendingStreamCenterUntil =
          (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 500;
        effectiveCenterHz = clampedAbs;
        recenterStreamHz = clampedAbs;
      } else {
        const clampedOffsetHz = clamp(rawOffsetHz, -maxOffsetHz, maxOffsetHz);
        const nextCenterHz = Math.round(cur.streamCenterHz + clampedOffsetHz);
        pane.customCenterHz = Math.abs(clampedOffsetHz) < 25 ? null : nextCenterHz;
        effectiveCenterHz =
          pane.customCenterHz === null ? cur.streamCenterHz : nextCenterHz;
      }

      pane.customSpanHz = cur.userSpanHz;
      const radioSpanHz = this._recordRadioSpan(
        pane,
        Math.ceil(
          cur.userSpanHz + 2 * Math.abs(effectiveCenterHz - nextStreamCenterHz)
        )
      );
      const vfoFreqHz =
        (rxSnap && Number.isFinite(rxSnap.freqHz) && rxSnap.freqHz) ||
        nextStreamCenterHz;

      this._scheduleRender();
      if (this._onViewportChange) {
        this._onViewportChange(key);
      }
      return {
        rx: key,
        panCenterHz: effectiveCenterHz,
        userSpanHz: cur.userSpanHz,
        streamCenterHz: nextStreamCenterHz,
        radioSpanHz,
        recenterStreamHz,
        isOffset:
          Math.abs(effectiveCenterHz - nextStreamCenterHz) >= 50 ||
          Math.abs(effectiveCenterHz - vfoFreqHz) >= 50,
      };
    }

    resetViewport(rx, { syncRadioSpan = true } = {}) {
      const key = rx === 'B' ? 'B' : 'A';
      const pane = this._panes[key];
      const prevSpanHz = this.getVisibleSpanHz(key);
      pane.customCenterHz = null;
      pane.customSpanHz = null;
      pane.streamCenterHz = null;
      pane.pendingStreamCenterHz = null;
      pane.pendingStreamCenterUntil = 0;
      pane.recentRadioSpans.length = 0;

      if (this._interaction && typeof this._interaction.cancelPendingIfCenter === 'function') {
        this._interaction.cancelPendingIfCenter();
      }

      if (this._client && (syncRadioSpan || this._autoFixedTuneFromDrag)) {
        const shouldClearFixedTune = Boolean(this._autoFixedTuneFromDrag);
        this._autoFixedTuneFromDrag = false;
        const displayPatch = {};
        if (syncRadioSpan) {
          displayPatch.panSpanHz = clamp(Math.round(prevSpanHz), 6000, 368000);
        }
        if (shouldClearFixedTune) {
          displayPatch.fixedTune = false;
        }
        if (Object.keys(displayPatch).length > 0) {
          if (typeof this._client.setDisplay === 'function') {
            this._client.setDisplay(key, displayPatch);
          } else if (shouldClearFixedTune && typeof this._client.sendCat === 'function') {
            this._client.sendCat('#FXT0;');
          }
        }
        if (typeof this._client.sendCat === 'function') {
          this._client.sendCat(key === 'B' ? 'FC$;' : 'FC;');
        }
      }

      this._scheduleRender();
      if (this._onViewportChange) {
        this._onViewportChange(key);
      }
    }

    _activeMiniPanRx(snap) {
      const rxA = (snap && snap.rxA) || {};
      const rxB = (snap && snap.rxB) || {};
      const aOn = Boolean(rxA.miniPan);
      const bOn = Boolean(
        snap && snap.subRxEnabled && rxB.miniPan && rxB.miniPanAvailable !== false
      );
      if (!aOn && !bOn) return null;
      if (aOn && bOn) return this._targetRx === 'B' ? 'B' : 'A';
      return bOn ? 'B' : 'A';
    }

    _scheduleRender() {
      if (this._destroyed || this._rafId) return;
      if (typeof document !== 'undefined' && document.hidden === true) return;
      if (typeof globalThis.requestAnimationFrame === 'function') {
        this._rafId = globalThis.requestAnimationFrame(() => {
          this._rafId = 0;
          this._renderNow(false);
        });
      } else {
        this._renderNow(false);
      }
    }

    _scheduleMiniPanRender(rx) {
      if (this._destroyed) return;
      if (typeof document !== 'undefined' && document.hidden === true) return;
      if (
        !this._renderer ||
        typeof this._renderer.renderMiniPan !== 'function'
      ) {
        this._scheduleRender();
        return;
      }
      const key = rx === 'B' ? 'B' : 'A';
      this._miniPanDirtyRx[key] = true;
      if (this._miniPanRafId || this._rafId) return;
      const flush = () => {
        this._miniPanRafId = 0;
        if (this._destroyed || this._rafId) return;
        const doA = this._miniPanDirtyRx.A;
        const doB = this._miniPanDirtyRx.B;
        this._miniPanDirtyRx.A = false;
        this._miniPanDirtyRx.B = false;
        if (!doA && !doB) return;
        const frameState = this.getFrameState();
        if (doA) this._renderer.renderMiniPan('A', frameState);
        if (doB) this._renderer.renderMiniPan('B', frameState);
      };
      if (typeof globalThis.requestAnimationFrame === 'function') {
        this._miniPanRafId = globalThis.requestAnimationFrame(flush);
      } else {
        flush();
      }
    }

    _renderNow(countFrame) {
      if (this._destroyed) return;
      this._miniPanDirtyRx.A = false;
      this._miniPanDirtyRx.B = false;
      if (this._miniPanRafId && typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(this._miniPanRafId);
        this._miniPanRafId = 0;
      }
      const frameState = this.getFrameState();
      this._renderer.render(frameState);
      if (countFrame) {
        this._framesRendered++;
        this._container.dataset.frames = String(this._framesRendered);
      }
    }

    getFrameState() {
      const snapshot = this._getSnapshot();
      const rxA = snapshot.rxA || createDefaultSnapshot().rxA;
      const rxB = snapshot.rxB || createDefaultSnapshot().rxB;

      const buildPaneFrame = (rxKey, rxSnap) => {
        const p = this._panes[rxKey];
        const tierKHz = p.tierKHz || rxSnap.panTierKHz || 48;
        const vp = this._resolvePaneViewport(rxKey, rxSnap);
        const refDbm = Number.isFinite(rxSnap.panRefDbm) ? rxSnap.panRefDbm : -110;
        const scaleDb = Number.isFinite(rxSnap.panScaleDb) ? rxSnap.panScaleDb : 80;
        const wfBlack = Number.isFinite(rxSnap.wfBlack) ? rxSnap.wfBlack : 14;
        const noiseFloorDbm = Number.isFinite(p.noiseFloorDbm)
          ? p.noiseFloorDbm
          : rxSnap.noiseFloorDbm;

        return {
          rx: rxKey,
          binsReady: p.binsReady,
          binSeq: p.binSeq,
          avgDbm: p.avgDbm,
          shownDbm: p.shownDbm,
          peakDbm: p.peakDbm,
          streamCenterHz: vp.streamCenterHz,
          panCenterHz: vp.panCenterHz,
          tierKHz,
          userSpanHz: vp.userSpanHz,
          isViewportOffset: vp.isOffset,
          refDbm,
          scaleDb,
          wfBlack,
          noiseFloorDbm,
        };
      };

      const mpRx = this._activeMiniPanRx(snapshot);
      return {
        snapshot,
        panes: {
          A: buildPaneFrame('A', rxA),
          B: buildPaneFrame('B', rxB),
        },
        miniPanByRx: this._miniPanByRx,
        miniPan: mpRx
          ? Object.assign({ active: true }, this._miniPanByRx[mpRx])
          : {
              active: false,
              rx: 'A',
              centerFreqHz: 14074000,
              spanKHz: 10,
              dbmBins: null,
            },
        targetRx: this._targetRx,
        mouseQsyMode: this._mouseQsyMode,
        wheelRitMode: this._wheelRitMode,
        dualPanMode: Number.isFinite(snapshot.dualPanMode)
          ? snapshot.dualPanMode
          : 0,
        peakHold: this._peakHold,
        palette: this._palette,
        hover: this._hoverState,
        dragState:
          this._interaction && this._interaction._dragMode
            ? this._interaction._dragMode
            : '',
        bookmarks: this._cachedBookmarks,
        bookmarksRev: this._bookmarksRev,
      };
    }

    pushPanPacket(pkt) {
      if (this._destroyed || !pkt || !pkt.bins || pkt.bins.length === 0) return;
      const snap = this._getSnapshot();
      if (snap.panFrozen) return;
      const rx = pkt.rx === 'B' ? 'B' : 'A';
      const pane = this._panes[rx];
      const rxSnap = (rx === 'B' ? snap.rxB : snap.rxA) || {};
      const n = pkt.bins.length;

      if (pane.rawDbmScratch.length < n) {
        pane.rawDbmScratch = new Float32Array(n);
      }
      if (pane.wfRowScratch.length < n) {
        pane.wfRowScratch = new Uint8Array(n);
      }

      const rawDbm = K4.SpectrumScale.decodePanBins(
        pkt.bins,
        pane.rawDbmScratch
      ).subarray(0, n);

      const tierKHz =
        Number.isFinite(pkt.sampleRateKHz) && pkt.sampleRateKHz > 0
          ? pkt.sampleRateKHz
          : rxSnap.panTierKHz || 48;
      const tierSpanHz = Math.max(1000, tierKHz * 1000);
      const streamSpanHz =
        Number.isFinite(pkt.spanHz) && pkt.spanHz > 0
          ? pkt.spanHz
          : tierSpanHz || 48000;
      const centerHz = Number.isFinite(pkt.centerFreqHz)
        ? pkt.centerFreqHz
        : rxSnap.freqHz || 14074000;

      if (
        pane.lastTierKHz !== null &&
        (pane.lastTierKHz !== tierKHz ||
          Math.abs(centerHz - pane.lastCenterHz) > tierSpanHz / 4)
      ) {
        pane.averager.clear();
        if (
          pane.lastCenterHz !== null &&
          Math.abs(centerHz - pane.lastCenterHz) > 500000
        ) {
          this._renderer.clearWaterfall(rx);
        }
      }

      const nowMs =
        typeof performance !== 'undefined' ? performance.now() : Date.now();
      const awaitingStreamShift =
        pane.pendingStreamCenterUntil > nowMs &&
        Number.isFinite(pane.pendingStreamCenterHz) &&
        Math.abs(centerHz - pane.pendingStreamCenterHz) > 2500;

      pane.lastTierKHz = tierKHz;
      pane.lastCenterHz = centerHz;
      if (!awaitingStreamShift) {
        pane.pendingStreamCenterUntil = 0;
        pane.pendingStreamCenterHz = null;
        pane.streamCenterHz = centerHz;
        pane.panCenterHz = centerHz;
      }
      pane.tierKHz = tierKHz;
      pane.streamSpanHz = streamSpanHz;
      if (
        !awaitingStreamShift &&
        pane.customCenterHz !== null &&
        Math.abs(pane.customCenterHz - centerHz) > streamSpanHz / 2
      ) {
        pane.customCenterHz = null;
        pane.customSpanHz = null;
        pane.recentRadioSpans.length = 0;
      }
      if (Number.isFinite(pkt.noiseFloorDbm)) {
        pane.noiseFloorDbm = pkt.noiseFloorDbm;
      }

      const avgCount = Number.isFinite(snap.panAvg) ? snap.panAvg : 4;
      const res = pane.averager.push(rawDbm, avgCount);
      pane.avgDbm = res.avgDbm;
      pane.shownDbm = res.shownDbm;
      pane.peakDbm = res.peakDbm;
      pane.binsReady = true;

      const wfRow = K4.WaterfallRowMapper.mapRow(
        res.avgDbm,
        {
          refDbm: Number.isFinite(rxSnap.panRefDbm) ? rxSnap.panRefDbm : -110,
          scaleDb: Number.isFinite(rxSnap.panScaleDb) ? rxSnap.panScaleDb : 80,
          wfBlack: Number.isFinite(rxSnap.wfBlack) ? rxSnap.wfBlack : 14,
        },
        pane.wfRowScratch
      ).subarray(0, res.avgDbm.length);

      this._renderer.pushWaterfallRow(
        wfRow,
        { centerFreqHz: centerHz, tierSpanHz, rx },
        rx
      );

      pane.binSeq = (pane.binSeq + 1) | 0;
      this._renderNow(true);
    }

    pushMiniPanPacket(pkt) {
      if (this._destroyed || !pkt || !pkt.bins || pkt.bins.length === 0) return;
      const snap = this._getSnapshot();
      if (snap.panFrozen) return;
      const rx = pkt.rx === 'B' ? 'B' : 'A';
      const buf = this._miniPanByRx[rx];
      const n = pkt.bins.length;
      if (buf.rawDbmScratch.length < n) {
        buf.rawDbmScratch = new Float32Array(n);
      }
      const dbm = K4.SpectrumScale.decodeMiniPanBins(
        pkt.bins,
        buf.rawDbmScratch
      ).subarray(0, n);

      buf.centerFreqHz = Number.isFinite(pkt.centerFreqHz)
        ? pkt.centerFreqHz
        : buf.centerFreqHz;
      const rawSpanKHz = Number.isFinite(pkt.spanKHz)
        ? pkt.spanKHz
        : pkt.sampleRateKHz;
      buf.spanKHz =
        Number.isFinite(rawSpanKHz) && rawSpanKHz > 0 ? rawSpanKHz : 10;
      buf.dbmBins = dbm;
      buf.seq = (buf.seq + 1) | 0;

      const rxSnap = rx === 'B' ? snap.rxB : snap.rxA;
      const mpEnabled = Boolean(
        rxSnap &&
          rxSnap.miniPan &&
          (rx === 'A' || (snap.subRxEnabled && rxSnap.miniPanAvailable !== false))
      );
      if (mpEnabled) {
        this._scheduleMiniPanRender(rx);
      }
    }

    setTargetRx(rx) {
      this._targetRx = rx === 'B' ? 'B' : 'A';
      this._container.dataset.targetRx = this._targetRx;
      this._scheduleRender();
    }

    getTargetRx() {
      return this._targetRx;
    }

    isMobileViewport() {
      return (
        typeof window !== 'undefined' &&
        window.innerWidth <= 959 &&
        Boolean(
          this._container &&
            this._container.clientWidth > 0 &&
            this._container.clientWidth <= 959
        )
      );
    }

    setMouseQsyMode(mode) {
      this._mouseQsyMode = mode === 'pane' ? 'pane' : 'lr';
      this._container.dataset.mouseQsyMode = this._mouseQsyMode;
      this._scheduleRender();
    }

    getMouseQsyMode() {
      return this._mouseQsyMode;
    }

    setVoiceClickSnapKhz(on) {
      this._voiceClickSnapKhz = Boolean(on);
      if (K4.storage && typeof K4.storage.set === 'function') {
        K4.storage.set('prefs.voiceClickSnapKhz', this._voiceClickSnapKhz);
      }
    }

    getVoiceClickSnapKhz() {
      return Boolean(this._voiceClickSnapKhz);
    }

    setWheelRitMode(on) {
      this._wheelRitMode = Boolean(on);
      this._container.dataset.wheelRit = this._wheelRitMode ? 'true' : 'false';
      this._scheduleRender();
    }

    getWheelRitMode() {
      return this._wheelRitMode;
    }

    toggleWheelRitMode() {
      if (this._onToggleWheelRit) {
        this._onToggleWheelRit();
      } else {
        this.setWheelRitMode(!this._wheelRitMode);
      }
    }

    selectTargetFromMouse(rx) {
      const next = rx === 'B' ? 'B' : 'A';
      this.setWheelRitMode(false);
      this.setTargetRx(next);
      if (this._onSelectTarget) {
        this._onSelectTarget(next);
      }
    }

    notify(msg, level) {
      if (this._onNotify) {
        this._onNotify(msg, level || 'info');
      }
    }

    setPalette(name) {
      const valid =
        K4.WaterfallLuts && K4.WaterfallLuts.has(name) ? name : 'obsidian';
      this._palette = valid;
      this._renderer.setPalette(valid);
      this._scheduleRender();
    }

    setPeakHold(enabled) {
      this._peakHold = Boolean(enabled);
      if (this._peakHold) {
        this._panes.A.averager.resetPeakHold();
        this._panes.B.averager.resetPeakHold();
      }
      this._scheduleRender();
    }

    setHoverState(hover) {
      this._hoverState = hover;
      this._scheduleRender();
    }

    setLastClickFreqHz(freqHz) {
      this._lastClickFreqHz = freqHz;
    }

    getMetrics() {
      const snap = this._getSnapshot();
      const activeKey = this._targetRx === 'B' ? 'B' : 'A';
      const activePane = this._panes[activeKey];
      const rxSnap = (activeKey === 'B' ? snap.rxB : snap.rxA) || {};
      const vp = this._resolvePaneViewport(activeKey, rxSnap);
      const tierKHz = activePane.tierKHz || rxSnap.panTierKHz || 48;
      const paneRing =
        this._renderer && this._renderer._panes ? this._renderer._panes[activeKey] : null;

      return {
        framesRendered: this._framesRendered,
        liveRows: paneRing ? paneRing.liveRows || 0 : 0,
        rendererType: this._renderer.type,
        lastClickFreqHz: this._lastClickFreqHz,
        streamCenterHz: vp.streamCenterHz,
        panCenterHz: vp.panCenterHz,
        userSpanHz: vp.userSpanHz,
        isViewportOffset: vp.isOffset,
        tierKHz,
        targetRx: this._targetRx,
        palette: this._palette,
        peakHold: this._peakHold,
        miniPanActive: Boolean(this._activeMiniPanRx(snap)),
      };
    }

    closeMiniPan(rx) {
      if (this._destroyed) return;
      const target = rx === 'B' ? 'B' : 'A';
      if (this._client && typeof this._client.setDisplay === 'function') {
        this._client.setDisplay(target, { miniPan: false });
      }
      const snap = this._getSnapshot();
      const rxSnap = target === 'B' ? snap.rxB : snap.rxA;
      if (
        rxSnap &&
        rxSnap.miniPan &&
        this._state &&
        typeof this._state.updateRx === 'function'
      ) {
        this._state.updateRx(
          target,
          { miniPan: false },
          target === 'B' ? 'rxB.miniPan' : 'rxA.miniPan'
        );
      }
      this._scheduleRender();
    }

    invalidateHudLayout() {
      if (
        this._destroyed ||
        !this._renderer ||
        typeof this._renderer.invalidateHudLayout !== 'function'
      ) {
        return 0;
      }
      const inset = this._renderer.invalidateHudLayout();
      this._scheduleRender();
      return inset;
    }

    getPerfCounters() {
      if (!this._renderer || typeof this._renderer.getPerfCounters !== 'function') {
        return Object.assign({}, globalThis.__k4Perf || {});
      }
      return this._renderer.getPerfCounters();
    }

    /**
     * Clear waterfall ring history so no synthetic pre-seed remains while offline or switching bands.
     * @param {'A'|'B'} [rx]
     */
    clearWaterfall(rx) {
      if (this._destroyed || !this._renderer || typeof this._renderer.clearWaterfall !== 'function') {
        return;
      }
      this._renderer.clearWaterfall(rx);
      this._scheduleRender();
    }

    resize() {
      if (this._destroyed) return;
      this._renderer.resize();
      this._renderNow(false);
    }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      if (this._rafId && typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(this._rafId);
        this._rafId = 0;
      }
      if (this._miniPanRafId && typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(this._miniPanRafId);
        this._miniPanRafId = 0;
      }
      if (this._unsubState) {
        this._unsubState();
        this._unsubState = null;
      }
      if (this._unsubBookmarks) {
        this._unsubBookmarks();
        this._unsubBookmarks = null;
      }
      if (this._resizeObserver) {
        this._resizeObserver.disconnect();
        this._resizeObserver = null;
      }
      if (this._onWindowResize && typeof globalThis.removeEventListener === 'function') {
        globalThis.removeEventListener('resize', this._onWindowResize);
        this._onWindowResize = null;
      }
      if (
        this._onVisibilityChange &&
        typeof document !== 'undefined' &&
        typeof document.removeEventListener === 'function'
      ) {
        document.removeEventListener('visibilitychange', this._onVisibilityChange);
        this._onVisibilityChange = null;
      }
      if (this._interaction) {
        this._interaction.destroy();
        this._interaction = null;
      }
      if (this._renderer) {
        this._renderer.destroy();
        this._renderer = null;
      }
    }
  }

  K4.PanadapterView = PanadapterView;
})();
