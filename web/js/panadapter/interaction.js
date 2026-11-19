'use strict';

(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const SPAN_LADDER_HZ = [
    6000, 12000, 24000, 36000, 48000, 72000, 96000, 144000, 192000, 288000,
    368000,
  ];
  const DRAG_THRESHOLD_PX = 5;
  const TOUCH_PAN_THRESHOLD_PX = 18;
  const VFO_DRAG_THRESHOLD_TOUCH_PX = 4;
  const VFO_DRAG_THRESHOLD_MOUSE_PX = 3;
  const EDGE_HIT_PX = 6;
  const THROTTLE_MS = 50; // max 20 Hz

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  function nearestSpanIndex(spanHz) {
    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < SPAN_LADDER_HZ.length; i++) {
      const diff = Math.abs(SPAN_LADDER_HZ[i] - spanHz);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  class PanadapterInteraction {
    constructor({ surface, renderer, view, state, client }) {
      this.surface = surface;
      this.renderer = renderer;
      this.view = view;
      this.state = state;
      this.client = client;

      this._destroyed = false;
      this._dragMode = null; // 'pan' | 'axis-pan' | 'edge' | 'pinch' | 'vfo' | null
      this._activePointerId = null;
      this._startX = 0;
      this._startY = 0;
      this._dragExceeded = false;
      this._dragRx = 'A';
      this._dragVfoRx = null;
      this._startFreqHz = 14074000;
      this._vfoDragStartFreqHz = 14074000;
      this._vfoDragStartSpanHz = 48000;
      this._vfoDragPlotWidth = 800;
      this._lockedPillAbsorbed = false;
      this._dragHit = null;
      this._edgeInfo = null;

      this._touches = new Map();
      this._wasPinched = false;
      this._pinchStartDist = 0;
      this._pinchStartSpanHz = 48000;
      this._pinchLastSentSpanHz = 0;
      this._pinchRx = 'A';
      this._pinchPlotLeft = 0;
      this._pinchPlotWidth = 800;
      this._pinchAnchorRfHz = 14074000;
      this._pinchSentFirst = false;

      this._inSafariGesture = false;
      this._gestureStartSpanHz = 48000;
      this._gestureAnchorRfHz = 14074000;
      this._gestureRx = 'A';

      this._panLastX = 0;
      this._lastEdgeSendMs = -1e9;
      this._lastSpanSendMs = -1e9;
      this._spanFlushTimer = null;
      this._pendingSpan = null;
      this._lastIfCenterSendMs = -1e9;
      this._ifCenterFlushTimer = null;
      this._pendingIfCenter = null;
      this._lastVfoTuneSendMs = -1e9;
      this._vfoTuneFlushTimer = null;
      this._pendingVfoTune = null;
      this._lastRightHandledMs = -1e9;
      this._lastLockWarnMs = -1e9;

      this._onPointerDown = this._handlePointerDown.bind(this);
      this._onPointerMove = this._handlePointerMove.bind(this);
      this._onPointerUp = this._handlePointerUp.bind(this);
      this._onPointerCancel = this._handlePointerUp.bind(this);
      this._onPointerLeave = this._handlePointerLeave.bind(this);
      this._onLostPointerCapture = this._handleLostPointerCapture.bind(this);
      this._onWindowBlur = this._handleWindowBlur.bind(this);
      this._onVisibilityChange = this._handleVisibilityChange.bind(this);
      this._onContextMenu = this._handleContextMenu.bind(this);
      this._onAuxClick = this._handleAuxClick.bind(this);
      this._onWheel = this._handleWheel.bind(this);
      this._onDblClick = this._handleDblClick.bind(this);
      this._onGestureStart = this._handleGestureStart.bind(this);
      this._onGestureChange = this._handleGestureChange.bind(this);
      this._onGestureEnd = this._handleGestureEnd.bind(this);

      surface.addEventListener('pointerdown', this._onPointerDown);
      surface.addEventListener('pointermove', this._onPointerMove);
      surface.addEventListener('pointerup', this._onPointerUp);
      surface.addEventListener('pointercancel', this._onPointerCancel);
      surface.addEventListener('pointerleave', this._onPointerLeave);
      surface.addEventListener('lostpointercapture', this._onLostPointerCapture);
      surface.addEventListener('contextmenu', this._onContextMenu);
      surface.addEventListener('auxclick', this._onAuxClick);
      surface.addEventListener('wheel', this._onWheel, { passive: false });
      surface.addEventListener('dblclick', this._onDblClick);
      surface.addEventListener('gesturestart', this._onGestureStart, {
        passive: false,
      });
      surface.addEventListener('gesturechange', this._onGestureChange, {
        passive: false,
      });
      surface.addEventListener('gestureend', this._onGestureEnd, {
        passive: false,
      });
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('blur', this._onWindowBlur);
      }
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', this._onVisibilityChange);
      }
    }

    _getLocalPoint(e) {
      const rect = this.surface.getBoundingClientRect();
      return {
        xPx: e.clientX - rect.left,
        yPx: e.clientY - rect.top,
      };
    }

    _getSnapshot() {
      if (this.state && typeof this.state.getSnapshot === 'function') {
        return this.state.getSnapshot();
      }
      return this.view.getFrameState().snapshot || {};
    }

    _isInsideMiniPan(e) {
      const t = e && e.target;
      return Boolean(
        t && typeof t.closest === 'function' && t.closest('.k4-minipan-box')
      );
    }

    _hitTest(xPx, yPx) {
      const frame = this.view.getFrameState();
      const snapshot = frame.snapshot || this._getSnapshot();
      let layouts = this.renderer.getLayouts ? this.renderer.getLayouts() : [];
      if ((!layouts || layouts.length === 0) && K4._computePanLayouts) {
        const w = this.surface.clientWidth || 800;
        const h = this.surface.clientHeight || 400;
        const topInset =
          typeof this.renderer.getHudTopInset === 'function'
            ? this.renderer.getHudTopInset()
            : K4._measureHudTopInset
            ? K4._measureHudTopInset(this.surface.parentElement, h)
            : 0;
        layouts = K4._computePanLayouts(w, h, frame.dualPanMode || 0, topInset, {
          displayMode: snapshot.displayMode,
          waterfallHeightPct: snapshot.waterfallHeightPct,
        });
      }
      if (!layouts || layouts.length === 0) return null;

      let chosen = layouts[0];
      for (let i = 0; i < layouts.length; i++) {
        const l = layouts[i];
        const r = l.paneRect;
        if (xPx >= r.x && xPx <= r.x + r.w && yPx >= r.y && yPx <= r.y + r.h) {
          chosen = l;
          break;
        }
      }

      const paneRx = chosen.rx;
      const paneState = frame.panes ? frame.panes[paneRx] : null;
      const rxKey = paneRx === 'B' ? 'rxB' : 'rxA';
      const rxState = (snapshot && snapshot[rxKey]) || {};
      const panCenterHz =
        paneState && Number.isFinite(paneState.panCenterHz)
          ? paneState.panCenterHz
          : rxState.panCenterHz || rxState.freqHz || 14074000;
      const userSpanHz =
        paneState && Number.isFinite(paneState.userSpanHz) && paneState.userSpanHz > 0
          ? paneState.userSpanHz
          : rxState.panSpanHz || 48000;
      const cwPitchHz = Number.isFinite(snapshot.cwPitchHz) ? snapshot.cwPitchHz : 500;

      return {
        layout: chosen,
        paneRx,
        inAxis:
          yPx >= chosen.axisRect.y && yPx <= chosen.axisRect.y + chosen.axisRect.h,
        inSpec:
          yPx >= chosen.specRect.y && yPx <= chosen.specRect.y + chosen.specRect.h,
        panCenterHz,
        userSpanHz,
        cwPitchHz,
        snapshot,
      };
    }

    _findHoveredEdge(xPx, yPx, hit) {
      if (!hit || hit.inAxis) return null;
      const { layout, paneRx, panCenterHz, userSpanHz, cwPitchHz, snapshot } = hit;
      const { specRect } = layout;
      if (!(specRect.w > 0)) return null;

      const rxA = snapshot.rxA || {};
      const rxB = snapshot.rxB || {};
      const candidates = [];
      if (hit.snapshot && hit.snapshot.dualPanMode === 2) {
        candidates.push(paneRx);
      } else {
        const primary = this.view.getTargetRx();
        candidates.push(primary);
        if (snapshot.subRxEnabled) {
          candidates.push(primary === 'A' ? 'B' : 'A');
        }
      }

      let best = null;
      let bestDist = EDGE_HIT_PX + 0.01;
      for (let i = 0; i < candidates.length; i++) {
        const rx = candidates[i];
        const rxState = rx === 'B' ? rxB : rxA;
        const pb = K4.SpectrumGeometry.computePassbandRange(rxState, cwPitchHz);
        const lowX = K4.SpectrumGeometry.xFromRfFreq(
          pb.lowHz,
          specRect.x,
          specRect.w,
          panCenterHz,
          userSpanHz
        );
        const highX = K4.SpectrumGeometry.xFromRfFreq(
          pb.highHz,
          specRect.x,
          specRect.w,
          panCenterHz,
          userSpanHz
        );
        const dLow = Math.abs(xPx - lowX);
        const dHigh = Math.abs(xPx - highX);
        if (dLow < bestDist) {
          bestDist = dLow;
          best = {
            rx,
            edge: 'low',
            lowHz: pb.lowHz,
            highHz: pb.highHz,
            carrierHz: pb.carrierHz,
            mode: rxState.mode,
            dataSubMode: rxState.dataSubMode || 0,
          };
        }
        if (dHigh < bestDist) {
          bestDist = dHigh;
          best = {
            rx,
            edge: 'high',
            lowHz: pb.lowHz,
            highHz: pb.highHz,
            carrierHz: pb.carrierHz,
            mode: rxState.mode,
            dataSubMode: rxState.dataSubMode || 0,
          };
        }
      }
      return best;
    }

    _findVfoPillHit(xPx, yPx, isTouch) {
      const pills =
        this.renderer && typeof this.renderer.getVfoPillBoxes === 'function'
          ? this.renderer.getVfoPillBoxes()
          : [];
      if (!Array.isArray(pills) || pills.length === 0) return null;

      const padX = isTouch ? 14 : 4;
      const padY = isTouch ? 12 : 4;
      let best = null;
      let bestDistSq = Infinity;

      for (let i = 0; i < pills.length; i++) {
        const p = pills[i];
        if (!p) continue;
        if (
          xPx >= p.x - padX &&
          xPx <= p.x + p.w + padX &&
          yPx >= p.y - padY &&
          yPx <= p.y + p.h + padY
        ) {
          const cx = p.x + p.w * 0.5;
          const cy = p.y + p.h * 0.5;
          const dx = xPx - cx;
          const dy = yPx - cy;
          const distSq = dx * dx + dy * dy;
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            best = p;
          }
        }
      }
      return best;
    }

    _resolveVfoHitPane(hit, pillHit) {
      if (
        !pillHit ||
        !pillHit.paneRx ||
        (hit && hit.paneRx === pillHit.paneRx) ||
        !this.renderer ||
        typeof this.renderer.getLayouts !== 'function'
      ) {
        return hit;
      }
      const layouts = this.renderer.getLayouts() || [];
      let match = null;
      for (let i = 0; i < layouts.length; i++) {
        if (layouts[i] && layouts[i].rx === pillHit.paneRx) {
          match = layouts[i];
          break;
        }
      }
      if (!match) return hit;
      const frame =
        this.view && typeof this.view.getFrameState === 'function'
          ? this.view.getFrameState()
          : {};
      const snap = (hit && hit.snapshot) || frame.snapshot || this._getSnapshot();
      const paneState = frame.panes ? frame.panes[pillHit.paneRx] : null;
      const rxKey = pillHit.paneRx === 'B' ? 'rxB' : 'rxA';
      const rxState = (snap && snap[rxKey]) || {};
      return Object.assign({}, hit || {}, {
        layout: match,
        paneRx: pillHit.paneRx,
        panCenterHz:
          paneState && Number.isFinite(paneState.panCenterHz)
            ? paneState.panCenterHz
            : rxState.panCenterHz || rxState.freqHz || 14074000,
        userSpanHz:
          paneState && Number.isFinite(paneState.userSpanHz) && paneState.userSpanHz > 0
            ? paneState.userSpanHz
            : rxState.panSpanHz || 48000,
        snapshot: snap,
      });
    }

    _beginVfoDrag(e, xPx, yPx, pillHit, hit) {
      const isTouch = e.pointerType === 'touch';
      if (this._isRxLocked(hit, pillHit.rx)) {
        this._notifyLocked(pillHit.rx);
        if (isTouch) {
          this._lockedPillAbsorbed = true;
          this._dragMode = null;
          this._dragVfoRx = null;
        }
        return;
      }
      const dragHit = this._resolveVfoHitPane(hit, pillHit);
      const snap = (dragHit && dragHit.snapshot) || this._getSnapshot();
      const rxKey = pillHit.rx === 'B' ? 'rxB' : 'rxA';
      const rxState = (snap && snap[rxKey]) || {};
      const startFreqHz = Number.isFinite(rxState.freqHz)
        ? rxState.freqHz
        : Number.isFinite(pillHit.freqHz)
        ? pillHit.freqHz
        : 14074000;
      const startSpanHz =
        dragHit && Number.isFinite(dragHit.userSpanHz) && dragHit.userSpanHz > 0
          ? dragHit.userSpanHz
          : rxState.panSpanHz || 48000;
      const plotWidth =
        dragHit && dragHit.layout && dragHit.layout.specRect && dragHit.layout.specRect.w > 0
          ? dragHit.layout.specRect.w
          : (this.surface && this.surface.clientWidth) || 800;

      this._dragMode = 'vfo';
      this._dragVfoRx = pillHit.rx;
      this._startX = xPx;
      this._startY = yPx;
      this._vfoDragStartFreqHz = startFreqHz;
      this._vfoDragStartSpanHz = startSpanHz;
      this._vfoDragPlotWidth = Math.max(1, plotWidth);
      this._dragHit = dragHit;
      this._dragExceeded = false;
      this._lockedPillAbsorbed = false;

      if (!isTouch) {
        this._activePointerId = e.pointerId;
        if (this.surface && this.surface.style) {
          this.surface.style.cursor = 'grabbing';
        }
        try {
          this.surface.setPointerCapture(e.pointerId);
        } catch (_err) {
          // ignore
        }
      } else {
        this._wasPinched = false;
      }

      if (this.view && typeof this.view._scheduleRender === 'function') {
        this.view._scheduleRender();
      }
    }

    _resolveMouseQsyRx(button, hit, shiftKey) {
      const mode =
        this.view && typeof this.view.getMouseQsyMode === 'function'
          ? this.view.getMouseQsyMode()
          : 'lr';
      if (mode === 'pane') {
        if (button !== 0) return null;
        if (shiftKey) return 'B';
        return hit && hit.paneRx === 'B' ? 'B' : 'A';
      }
      if (button === 2) return 'B';
      if (button === 0) return shiftKey ? 'B' : 'A';
      return null;
    }

    _resolveTouchQsyRx(hit) {
      const mobileView = Boolean(
        this.view &&
          typeof this.view.isMobileViewport === 'function' &&
          this.view.isMobileViewport()
      );
      if (!mobileView && hit && hit.snapshot && hit.snapshot.dualPanMode === 2) {
        return hit.paneRx === 'B' ? 'B' : 'A';
      }
      return this.view && typeof this.view.getTargetRx === 'function'
        ? this.view.getTargetRx()
        : 'A';
    }

    _syncMouseTarget(rx) {
      if (this.view && typeof this.view.selectTargetFromMouse === 'function') {
        this.view.selectTargetFromMouse(rx);
      } else if (this.view && typeof this.view.setTargetRx === 'function') {
        this.view.setTargetRx(rx);
      }
    }

    _isRxLocked(hit, rx) {
      const snap = (hit && hit.snapshot) || this._getSnapshot();
      const rxS = snap && (rx === 'B' ? snap.rxB : snap.rxA);
      return Boolean(rxS && rxS.locked);
    }

    _notifyLocked(rx) {
      const now = performance.now();
      if (now - this._lastLockWarnMs < 1200) return;
      this._lastLockWarnMs = now;
      if (this.view && typeof this.view.notify === 'function') {
        this.view.notify(
          `VFO ${rx} is locked — click the VFO ${rx} lock button to unlock`,
          'warn'
        );
      }
    }

    _tuneClick(xPx, hit, rx, fine, syncTarget = true, _isTouchOrMobile = false) {
      if (!hit || !this.client || !rx) return;
      if (syncTarget) {
        this._syncMouseTarget(rx);
      }
      if (this._isRxLocked(hit, rx)) {
        this._notifyLocked(rx);
        return;
      }
      const rxKey = rx === 'B' ? 'rxB' : 'rxA';
      const rxState = (hit.snapshot && hit.snapshot[rxKey]) || {};
      const voiceClickSnapKhz =
        this.view && typeof this.view.getVoiceClickSnapKhz === 'function'
          ? this.view.getVoiceClickSnapKhz()
          : true;
      const snappedHz = K4.SpectrumGeometry.dialFreqFromClick({
        xPx,
        plotLeftPx: hit.layout.specRect.x,
        plotWidthPx: hit.layout.specRect.w,
        panCenterHz: hit.panCenterHz,
        userSpanHz: hit.userSpanHz,
        mode: rxState.mode,
        cwPitchHz: hit.cwPitchHz,
        stepHz: rxState.stepHz || 100,
        fine: Boolean(fine),
        voiceClickSnapKhz,
      });
      this.view.setLastClickFreqHz(snappedHz);
      if (typeof this.client.tune === 'function') {
        this.client.tune(rx, snappedHz, { optimistically: true });
      } else if (typeof this.client.sendCat === 'function' && K4.CatCodec) {
        this.client.sendCat(K4.CatCodec.builders.freq(rx, snappedHz));
      }
    }

    _applyEdgeDrag(xPx, isFinal) {
      const info = this._edgeInfo;
      const hit = this._dragHit;
      if (!info || !hit || !this.client) return;

      const now = performance.now();
      if (!isFinal && now - this._lastEdgeSendMs < THROTTLE_MS) {
        return;
      }
      this._lastEdgeSendMs = now;

      const freqAtCursor = K4.SpectrumGeometry.rfFreqFromX(
        xPx,
        hit.layout.specRect.x,
        hit.layout.specRect.w,
        hit.panCenterHz,
        hit.userSpanHz
      );

      const mode = info.mode;
      const sub = info.dataSubMode || 0;
      const isAsym =
        mode === 1 ||
        mode === 2 ||
        mode === 3 ||
        mode === 7 ||
        ((mode === 6 || mode === 9) && sub === 0);

      let newBw;
      let newIfShift = null;
      if (isAsym) {
        let newLow = info.lowHz;
        let newHigh = info.highHz;
        if (info.edge === 'high') {
          newHigh = Math.max(newLow + 50, freqAtCursor);
        } else {
          newLow = Math.min(newHigh - 50, freqAtCursor);
        }
        newBw = clamp(Math.round((newHigh - newLow) / 10) * 10, 50, 5000);
        const newCenter = (newLow + newHigh) * 0.5;
        const isLower = mode === 1 || mode === 7 || (mode === 9 && sub === 0);
        newIfShift = clamp(
          Math.round(
            (isLower ? info.carrierHz - newCenter : newCenter - info.carrierHz) /
              10
          ) * 10,
          0,
          5000
        );
      } else {
        const oldCenter = (info.lowHz + info.highHz) * 0.5;
        const halfBw = Math.max(25, Math.abs(freqAtCursor - oldCenter));
        newBw = clamp(Math.round((halfBw * 2) / 10) * 10, 50, 5000);
      }

      if (typeof this.client.setFilter === 'function') {
        const patch = { bwHz: newBw };
        if (newIfShift !== null) patch.ifShiftHz = newIfShift;
        this.client.setFilter(info.rx, patch);
        return;
      }

      if (typeof this.client.sendCat === 'function') {
        const builders = K4.CatCodec && K4.CatCodec.builders;
        const prefix = info.rx === 'B' ? '$' : '';
        let cmd =
          builders && builders.bw
            ? builders.bw(info.rx, newBw)
            : 'BW' + prefix + String(Math.round(newBw / 10)).padStart(4, '0') + ';';
        if (newIfShift !== null) {
          cmd +=
            builders && builders.ifShift
              ? builders.ifShift(info.rx, newIfShift)
              : 'IS' + prefix + String(Math.round(newIfShift / 10)).padStart(4, '0') + ';';
        }
        this.client.sendCat(cmd);
      }
      if (this.state && K4.CatCodec) {
        const applyFn =
          typeof this.state.applyParsedCat === 'function'
            ? this.state.applyParsedCat
            : typeof this.state.applyCatCommand === 'function'
            ? this.state.applyCatCommand
            : null;
        if (applyFn) {
          const builders = K4.CatCodec.builders;
          applyFn.call(
            this.state,
            K4.CatCodec.parseCommand(builders.bw(info.rx, newBw))
          );
          if (newIfShift !== null) {
            applyFn.call(
              this.state,
              K4.CatCodec.parseCommand(builders.ifShift(info.rx, newIfShift))
            );
          }
        }
      }
    }

    _sendSpan(rx, spanHz) {
      if (!this.client) return;
      const clamped = clamp(Math.round(spanHz), 6000, 368000);
      if (typeof this.client.setDisplay === 'function') {
        this.client.setDisplay(rx, { panSpanHz: clamped });
      } else if (typeof this.client.sendCat === 'function' && K4.CatCodec) {
        this.client.sendCat(K4.CatCodec.builders.panSpan(rx, clamped));
      }
    }

    _sendSpanThrottled(rx, spanHz, forceImmediate = false) {
      const clamped = clamp(Math.round(spanHz), 6000, 368000);
      const now = performance.now();
      if (forceImmediate || now - this._lastSpanSendMs >= THROTTLE_MS) {
        if (this._spanFlushTimer) {
          clearTimeout(this._spanFlushTimer);
          this._spanFlushTimer = null;
        }
        this._pendingSpan = null;
        this._lastSpanSendMs = now;
        this._sendSpan(rx, clamped);
        return;
      }
      this._pendingSpan = { rx, spanHz: clamped };
      if (!this._spanFlushTimer) {
        const delay = Math.max(8, THROTTLE_MS - (now - this._lastSpanSendMs));
        this._spanFlushTimer = setTimeout(() => {
          this._spanFlushTimer = null;
          if (this._destroyed || !this._pendingSpan) return;
          const p = this._pendingSpan;
          this._pendingSpan = null;
          this._lastSpanSendMs = performance.now();
          this._sendSpan(p.rx, p.spanHz);
        }, delay);
      }
    }

    _flushPendingSpan() {
      if (this._pendingSpan) {
        const p = this._pendingSpan;
        this._sendSpanThrottled(p.rx, p.spanHz, true);
      }
    }

    cancelPendingIfCenter() {
      if (this._ifCenterFlushTimer) {
        clearTimeout(this._ifCenterFlushTimer);
        this._ifCenterFlushTimer = null;
      }
      this._pendingIfCenter = null;
    }

    _cancelPendingVfoTune() {
      if (this._vfoTuneFlushTimer) {
        clearTimeout(this._vfoTuneFlushTimer);
        this._vfoTuneFlushTimer = null;
      }
      this._pendingVfoTune = null;
    }

    _sendVfoTune(rx, freqHz) {
      if (!this.client || !rx) return;
      const clamped = clamp(Math.round(freqHz), 100000, 54000000);
      if (typeof this.client.tune === 'function') {
        this.client.tune(rx, clamped, { optimistically: true });
      } else if (typeof this.client.sendCat === 'function' && K4.CatCodec) {
        this.client.sendCat(K4.CatCodec.builders.freq(rx, clamped));
      }
    }

    _sendVfoTuneThrottled(rx, freqHz, forceImmediate = false) {
      const clamped = clamp(Math.round(freqHz), 100000, 54000000);
      const now = performance.now();
      if (forceImmediate || now - this._lastVfoTuneSendMs >= THROTTLE_MS) {
        if (this._vfoTuneFlushTimer) {
          clearTimeout(this._vfoTuneFlushTimer);
          this._vfoTuneFlushTimer = null;
        }
        this._pendingVfoTune = null;
        this._lastVfoTuneSendMs = now;
        this._sendVfoTune(rx, clamped);
        return;
      }
      this._pendingVfoTune = { rx, freqHz: clamped };
      if (!this._vfoTuneFlushTimer) {
        const delay = Math.max(8, THROTTLE_MS - (now - this._lastVfoTuneSendMs));
        this._vfoTuneFlushTimer = setTimeout(() => {
          this._vfoTuneFlushTimer = null;
          if (this._destroyed || !this._pendingVfoTune) return;
          const p = this._pendingVfoTune;
          this._pendingVfoTune = null;
          this._lastVfoTuneSendMs = performance.now();
          this._sendVfoTune(p.rx, p.freqHz);
        }, delay);
      }
    }

    _applyVfoDrag(xPx, fine, isFinal) {
      if (!this._dragVfoRx) return;
      const snap =
        this._getSnapshot() || (this._dragHit && this._dragHit.snapshot) || {};
      const rxKey = this._dragVfoRx === 'B' ? 'rxB' : 'rxA';
      const rxState = (snap && snap[rxKey]) || {};
      const deltaHz =
        ((xPx - this._startX) / Math.max(1, this._vfoDragPlotWidth)) *
        this._vfoDragStartSpanHz;
      const step = fine ? 1 : rxState.stepHz || 100;
      const targetHz = clamp(
        Math.round((this._vfoDragStartFreqHz + deltaHz) / step) * step,
        100000,
        54000000
      );
      this._sendVfoTuneThrottled(this._dragVfoRx, targetHz, Boolean(isFinal));
    }

    _resetDragState() {
      const hadVfoDrag = this._dragMode === 'vfo';
      this._cancelPendingVfoTune();
      this._wasPinched = false;
      this._lockedPillAbsorbed = false;
      this._dragMode = null;
      this._dragVfoRx = null;
      this._activePointerId = null;
      this._dragExceeded = false;
      this._edgeInfo = null;
      this._dragHit = null;
      if (this.surface && this.surface.style) {
        this.surface.style.cursor = 'crosshair';
      }
      if (hadVfoDrag && this.view && typeof this.view._scheduleRender === 'function') {
        this.view._scheduleRender();
      }
    }

    _clearPointerState() {
      this._touches.clear();
      if (this._dragMode === 'pinch') {
        this._flushPendingSpan();
      }
      this._resetDragState();
    }

    _handleLostPointerCapture(e) {
      if (this._destroyed) return;
      if (e && e.pointerId !== undefined) {
        if (this._touches.has(e.pointerId)) {
          this._touches.delete(e.pointerId);
          if (this._dragMode === 'pinch' && this._touches.size < 2) {
            this._flushPendingSpan();
          }
          if (this._touches.size === 0) {
            this._resetDragState();
          }
          return;
        }
        if (this._activePointerId !== null && e.pointerId === this._activePointerId) {
          this._resetDragState();
        }
        return;
      }
      this._clearPointerState();
    }

    _handleWindowBlur() {
      if (this._destroyed) return;
      this._clearPointerState();
    }

    _handleVisibilityChange() {
      if (this._destroyed) return;
      if (typeof document !== 'undefined' && document.hidden) {
        this._clearPointerState();
      }
    }

    _sendIfCenter(rx, freqHz) {
      if (!this.client) return;
      const clamped = clamp(Math.round(freqHz), 100000, 54000000);
      const snap =
        this.state && typeof this.state.getSnapshot === 'function'
          ? this.state.getSnapshot()
          : null;
      // K4 ignores FI/FC offsets while in #FXT0 (Track); enable #FXT1 when panning stream center.
      if (!snap || !snap.fixedTune) {
        if (typeof this.client.setDisplay === 'function') {
          this.client.setDisplay(rx, { fixedTune: true });
        } else if (typeof this.client.sendCat === 'function') {
          this.client.sendCat('#FXT1;');
          if (this.state && typeof this.state.update === 'function') {
            this.state.update({ fixedTune: true }, 'display');
          }
        }
        if (this.view) {
          this.view._autoFixedTuneFromDrag = true;
        }
      }
      if (typeof this.client.sendCat !== 'function') return;
      const builders = K4.CatCodec && K4.CatCodec.builders;
      if (builders && typeof builders.ifCenter === 'function') {
        this.client.sendCat(builders.ifCenter(rx, clamped));
      } else {
        const prefix = rx === 'B' ? '$' : '';
        this.client.sendCat(
          'FI' + prefix + String(clamped).padStart(11, '0') + ';'
        );
      }
    }

    _sendIfCenterThrottled(rx, freqHz, forceImmediate = false) {
      const clamped = clamp(Math.round(freqHz), 100000, 54000000);
      const now = performance.now();
      if (forceImmediate || now - this._lastIfCenterSendMs >= THROTTLE_MS) {
        if (this._ifCenterFlushTimer) {
          clearTimeout(this._ifCenterFlushTimer);
          this._ifCenterFlushTimer = null;
        }
        this._pendingIfCenter = null;
        this._lastIfCenterSendMs = now;
        this._sendIfCenter(rx, clamped);
        return;
      }
      this._pendingIfCenter = { rx, freqHz: clamped };
      if (!this._ifCenterFlushTimer) {
        const delay = Math.max(8, THROTTLE_MS - (now - this._lastIfCenterSendMs));
        this._ifCenterFlushTimer = setTimeout(() => {
          this._ifCenterFlushTimer = null;
          if (this._destroyed || !this._pendingIfCenter) return;
          const p = this._pendingIfCenter;
          this._pendingIfCenter = null;
          this._lastIfCenterSendMs = performance.now();
          this._sendIfCenter(p.rx, p.freqHz);
        }, delay);
      }
    }

    _pinchDist() {
      const pts = Array.from(this._touches.values());
      if (pts.length < 2) return 40;
      const dx = pts[0].x - pts[1].x;
      const dy = pts[0].y - pts[1].y;
      return Math.max(16, Math.hypot(dx, dy));
    }

    _pinchMidpoint() {
      const pts = Array.from(this._touches.values());
      if (pts.length < 2) return { x: 0, y: 0 };
      return {
        x: (pts[0].x + pts[1].x) * 0.5,
        y: (pts[0].y + pts[1].y) * 0.5,
      };
    }

    _applyViewportPanDrag(xPx, isFinal) {
      const hit = this._dragHit;
      if (!hit || !this.view || typeof this.view.panViewportByHz !== 'function') {
        return;
      }
      const plotW = Math.max(1, hit.layout.specRect.w);
      const dxStep = xPx - this._panLastX;
      this._panLastX = xPx;
      const curSpan =
        typeof this.view.getVisibleSpanHz === 'function'
          ? this.view.getVisibleSpanHz(this._dragRx)
          : hit.userSpanHz;
      const deltaHz = -(dxStep / plotW) * curSpan;
      const res = this.view.panViewportByHz(this._dragRx, deltaHz);
      if (res) {
        this._sendSpanThrottled(this._dragRx, res.radioSpanHz, Boolean(isFinal));
        if (Number.isFinite(res.recenterStreamHz)) {
          this._sendIfCenterThrottled(
            this._dragRx,
            res.recenterStreamHz,
            Boolean(isFinal)
          );
        }
      }
    }

    _handlePointerDown(e) {
      if (this._destroyed || this._isInsideMiniPan(e)) return;
      const { xPx, yPx } = this._getLocalPoint(e);
      const hit = this._hitTest(xPx, yPx);

      if (e.pointerType === 'touch') {
        if (e.isPrimary === true) {
          this._touches.clear();
          this._resetDragState();
        }
        this._touches.set(e.pointerId, {
          x: xPx,
          y: yPx,
          startX: xPx,
          startY: yPx,
        });
        try {
          this.surface.setPointerCapture(e.pointerId);
        } catch (_err) {
          // ignore synthetic pointer errors
        }

        if (this._touches.size === 2) {
          const hadVfoDrag = this._dragMode === 'vfo';
          this._cancelPendingVfoTune();
          this._dragVfoRx = null;
          this._lockedPillAbsorbed = false;
          const mid = this._pinchMidpoint();
          const midHit = this._hitTest(mid.x, mid.y) || hit;
          this._dragMode = 'pinch';
          this._wasPinched = true;
          this._dragExceeded = false;
          this._pinchSentFirst = false;
          this._pinchStartDist = this._pinchDist();
          this._pinchStartSpanHz = midHit ? midHit.userSpanHz : 48000;
          this._pinchLastSentSpanHz = this._pinchStartSpanHz;
          this._pinchRx = midHit && midHit.paneRx === 'B' ? 'B' : 'A';
          this._pinchPlotLeft = midHit ? midHit.layout.specRect.x : 0;
          this._pinchPlotWidth = midHit ? Math.max(1, midHit.layout.specRect.w) : 800;
          const uMid0 = clamp(
            (mid.x - this._pinchPlotLeft) / this._pinchPlotWidth,
            0,
            1
          );
          const center0 = midHit ? midHit.panCenterHz : 14074000;
          this._pinchAnchorRfHz =
            center0 + (uMid0 - 0.5) * this._pinchStartSpanHz;
          if (hadVfoDrag && this.view && typeof this.view._scheduleRender === 'function') {
            this.view._scheduleRender();
          }
        } else if (this._touches.size === 1) {
          const pillHit = this._findVfoPillHit(xPx, yPx, true);
          if (pillHit) {
            this._beginVfoDrag(e, xPx, yPx, pillHit, hit);
            return;
          }
          this._wasPinched = false;
          this._lockedPillAbsorbed = false;
          this._dragMode = 'pan';
          this._dragExceeded = false;
          this._startX = xPx;
          this._startY = yPx;
          this._panLastX = xPx;
          this._dragRx = hit && hit.paneRx === 'B' ? 'B' : 'A';
          this._dragHit = hit;
        }
        return;
      }

      if (e.button === 1) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        if (this.view && typeof this.view.toggleWheelRitMode === 'function') {
          this.view.toggleWheelRitMode();
        }
        return;
      }

      if (e.button === 2) {
        this._lastRightHandledMs = performance.now();
        const rx = this._resolveMouseQsyRx(2, hit, Boolean(e.shiftKey));
        if (rx) {
          this._tuneClick(xPx, hit, rx, e.altKey, true);
        }
        return;
      }

      if (e.button !== 0) return;

      const pillHit = this._findVfoPillHit(xPx, yPx, false);
      if (pillHit) {
        this._beginVfoDrag(e, xPx, yPx, pillHit, hit);
        return;
      }

      const edgeHit = this._findHoveredEdge(xPx, yPx, hit);
      if (edgeHit) {
        this._dragMode = 'edge';
        this._activePointerId = e.pointerId;
        this._startX = xPx;
        this._startY = yPx;
        this._edgeInfo = edgeHit;
        this._dragHit = hit;
        this._dragExceeded = false;
        this.surface.style.cursor = 'ew-resize';
        try {
          this.surface.setPointerCapture(e.pointerId);
        } catch (_err) {
          // ignore
        }
        return;
      }

      if (
        hit &&
        hit.inAxis &&
        this.view &&
        typeof this.view.panViewportByHz === 'function'
      ) {
        this._dragMode = 'axis-pan';
        this._activePointerId = e.pointerId;
        this._startX = xPx;
        this._startY = yPx;
        this._panLastX = xPx;
        this._dragExceeded = false;
        this._dragRx = hit.paneRx === 'B' ? 'B' : 'A';
        this._dragHit = hit;
        try {
          this.surface.setPointerCapture(e.pointerId);
        } catch (_err) {
          // ignore
        }
        return;
      }

      this._dragMode = 'pan';
      this._activePointerId = e.pointerId;
      this._startX = xPx;
      this._startY = yPx;
      this._panLastX = xPx;
      this._dragExceeded = false;
      this._dragRx = hit && hit.paneRx === 'B' ? 'B' : 'A';
      this._dragHit = hit;

      try {
        this.surface.setPointerCapture(e.pointerId);
      } catch (_err) {
        // ignore
      }
    }

    _handlePointerMove(e) {
      if (this._destroyed) return;
      if (!this._dragMode && this._isInsideMiniPan(e)) {
        if (this.view && typeof this.view.setHoverState === 'function') {
          this.view.setHoverState(null);
        }
        this.surface.style.cursor = 'default';
        return;
      }
      const { xPx, yPx } = this._getLocalPoint(e);

      if (e.pointerType === 'touch') {
        if (this._touches.has(e.pointerId)) {
          const entry = this._touches.get(e.pointerId);
          entry.x = xPx;
          entry.y = yPx;
        }
        if (this._touches.size === 2 && this._dragMode === 'pinch') {
          const dist = this._pinchDist();
          const mid = this._pinchMidpoint();
          const ratio = this._pinchStartDist / dist;
          const targetSpanHz = clamp(this._pinchStartSpanHz * ratio, 6000, 368000);
          const uMid = clamp(
            (mid.x - this._pinchPlotLeft) / Math.max(1, this._pinchPlotWidth),
            0,
            1
          );
          const firstEvent = !this._pinchSentFirst;
          this._pinchSentFirst = true;
          if (this.view && typeof this.view.applyMapZoom === 'function') {
            const res = this.view.applyMapZoom(this._pinchRx, {
              targetSpanHz,
              anchorFrac: uMid,
              anchorFreqHz: this._pinchAnchorRfHz,
            });
            this._sendSpanThrottled(this._pinchRx, res.radioSpanHz, firstEvent);
          } else {
            const nextSpan = Math.round(targetSpanHz);
            if (nextSpan !== this._pinchLastSentSpanHz) {
              this._pinchLastSentSpanHz = nextSpan;
              this._sendSpanThrottled(this._pinchRx, nextSpan, firstEvent);
            }
          }
          return;
        }
        if (
          this._touches.size === 1 &&
          !this._wasPinched &&
          !this._lockedPillAbsorbed
        ) {
          if (this._dragMode === 'vfo') {
            if (
              !this._dragExceeded &&
              Math.hypot(xPx - this._startX, yPx - this._startY) >
                VFO_DRAG_THRESHOLD_TOUCH_PX
            ) {
              this._dragExceeded = true;
            }
            if (this._dragExceeded) {
              this._applyVfoDrag(xPx, Boolean(e.altKey), false);
            }
          } else if (this._dragMode === 'pan') {
            const dx = xPx - this._startX;
            const dy = yPx - this._startY;
            if (
              !this._dragExceeded &&
              Math.abs(dx) > TOUCH_PAN_THRESHOLD_PX &&
              Math.abs(dx) > Math.abs(dy) * 0.85
            ) {
              this._dragExceeded = true;
              this._panLastX = xPx;
            }
            if (this._dragExceeded) {
              this._applyViewportPanDrag(xPx, false);
            }
          }
        }
        return;
      }

      const hit = this._hitTest(xPx, yPx);
      const vfoHit = this._dragMode
        ? null
        : this._findVfoPillHit(xPx, yPx, false);
      const edgeHint =
        this._dragMode || vfoHit ? null : this._findHoveredEdge(xPx, yPx, hit);
      if (hit) {
        this.view.setHoverState({
          active: true,
          xPx,
          yPx,
          paneRx: hit.paneRx,
          edgeHint,
          vfoPillRx: vfoHit ? vfoHit.rx : null,
        });
      }

      if (this._dragMode === 'vfo' && e.pointerId === this._activePointerId) {
        this.surface.style.cursor = 'grabbing';
        if (
          !this._dragExceeded &&
          Math.hypot(xPx - this._startX, yPx - this._startY) >
            VFO_DRAG_THRESHOLD_MOUSE_PX
        ) {
          this._dragExceeded = true;
        }
        if (this._dragExceeded) {
          this._applyVfoDrag(xPx, Boolean(e.altKey), false);
        }
        return;
      }

      if (
        (this._dragMode === 'edge' ||
          this._dragMode === 'pan' ||
          this._dragMode === 'axis-pan') &&
        e.pointerId === this._activePointerId
      ) {
        if (
          !this._dragExceeded &&
          Math.hypot(xPx - this._startX, yPx - this._startY) > DRAG_THRESHOLD_PX
        ) {
          this._dragExceeded = true;
        }
        if (this._dragExceeded) {
          if (this._dragMode === 'edge') {
            this.surface.style.cursor = 'ew-resize';
            this._applyEdgeDrag(xPx, false);
          } else {
            this.surface.style.cursor = 'grabbing';
            this._applyViewportPanDrag(xPx, false);
          }
        }
        return;
      }

      this.surface.style.cursor = vfoHit
        ? 'grab'
        : edgeHint
        ? 'ew-resize'
        : hit && hit.inAxis
        ? 'grab'
        : 'crosshair';
    }

    _handlePointerUp(e) {
      if (this._destroyed) return;
      if (
        !this._dragMode &&
        !this._lockedPillAbsorbed &&
        this._activePointerId === null &&
        this._touches.size === 0 &&
        this._isInsideMiniPan(e)
      ) {
        return;
      }
      const { xPx, yPx } = this._getLocalPoint(e);

      if (e.pointerType === 'touch') {
        this._touches.delete(e.pointerId);
        try {
          this.surface.releasePointerCapture(e.pointerId);
        } catch (_err) {
          // ignore
        }
        if (this._dragMode === 'pinch' && this._touches.size < 2) {
          this._flushPendingSpan();
        }
        if (this._touches.size === 0) {
          if (
            e.type === 'pointerup' &&
            !this._wasPinched &&
            !this._lockedPillAbsorbed
          ) {
            if (this._dragMode === 'vfo') {
              if (this._dragExceeded) {
                this._applyVfoDrag(xPx, Boolean(e.altKey), true);
              } else if (this._dragVfoRx) {
                this._syncMouseTarget(this._dragVfoRx);
              }
            } else if (this._dragExceeded) {
              this._applyViewportPanDrag(xPx, true);
            } else {
              const hit =
                this._dragHit || this._hitTest(this._startX, this._startY);
              const rx = this._resolveTouchQsyRx(hit);
              this._tuneClick(this._startX, hit, rx, false, false, true);
            }
          } else if (this._dragMode === 'vfo') {
            this._cancelPendingVfoTune();
          }
          this._resetDragState();
        }
        return;
      }

      if (this._activePointerId !== null && e.pointerId !== this._activePointerId) {
        return;
      }

      if (this._dragMode === 'vfo') {
        if (e.type === 'pointerup') {
          if (this._dragExceeded) {
            this._applyVfoDrag(xPx, Boolean(e.altKey), true);
          } else if (e.button === 0 && this._dragVfoRx) {
            this._syncMouseTarget(this._dragVfoRx);
          }
        } else {
          this._cancelPendingVfoTune();
        }
      } else if (
        this._dragMode === 'edge' ||
        this._dragMode === 'pan' ||
        this._dragMode === 'axis-pan'
      ) {
        if (this._dragExceeded) {
          if (this._dragMode === 'edge') {
            this._applyEdgeDrag(xPx, true);
          } else {
            this._applyViewportPanDrag(xPx, true);
          }
        } else if (e.button === 0 && e.type === 'pointerup') {
          const hit = this._hitTest(xPx, yPx);
          const mobileView = Boolean(
            this.view &&
              typeof this.view.isMobileViewport === 'function' &&
              this.view.isMobileViewport()
          );
          if (mobileView && !e.shiftKey) {
            const rx = this._resolveTouchQsyRx(hit);
            if (rx) {
              this._tuneClick(xPx, hit, rx, Boolean(e.altKey), false, true);
            }
          } else {
            const rx = this._resolveMouseQsyRx(0, hit, Boolean(e.shiftKey));
            if (rx) {
              this._tuneClick(xPx, hit, rx, Boolean(e.altKey), true);
            }
          }
        }
      }

      this._resetDragState();
      try {
        this.surface.releasePointerCapture(e.pointerId);
      } catch (_err) {
        // ignore
      }
      if (!this._destroyed && e.type === 'pointerup' && this.surface && this.surface.style) {
        const vfoHit = this._findVfoPillHit(xPx, yPx, false);
        this.surface.style.cursor = vfoHit ? 'grab' : 'crosshair';
      }
    }

    _handlePointerLeave() {
      if (!this._dragMode) {
        this.view.setHoverState(null);
      }
    }

    _handleContextMenu(e) {
      if (this._destroyed || this._isInsideMiniPan(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (performance.now() - this._lastRightHandledMs > 250) {
        const { xPx, yPx } = this._getLocalPoint(e);
        const hit = this._hitTest(xPx, yPx);
        const rx = this._resolveMouseQsyRx(2, hit, Boolean(e.shiftKey));
        if (rx) {
          this._tuneClick(xPx, hit, rx, e.altKey, true);
        }
      }
    }

    _handleAuxClick(e) {
      if (this._destroyed || this._isInsideMiniPan(e)) return;
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
      }
    }

    _handleWheel(e) {
      if (this._destroyed || this._isInsideMiniPan(e)) return;
      e.preventDefault();
      if (!this.client) return;
      const { xPx, yPx } = this._getLocalPoint(e);
      const hit = this._hitTest(xPx, yPx);
      if (!hit) return;

      if (e.ctrlKey || e.metaKey || hit.inAxis) {
        if (this._inSafariGesture) return;
        const modeScale =
          e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? 320 : 1;
        const rawDelta =
          Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        const dyPx = rawDelta * modeScale;
        if (!Number.isFinite(dyPx) || dyPx === 0) return;

        const zoomRate =
          (e.ctrlKey || e.metaKey) && Math.abs(dyPx) < 50 ? 0.0065 : 0.0032;
        const factor = Math.exp(clamp(dyPx, -180, 180) * zoomRate);
        const u = clamp(
          (xPx - hit.layout.specRect.x) / Math.max(1, hit.layout.specRect.w),
          0,
          1
        );
        const spanRx = hit.paneRx === 'B' ? 'B' : 'A';
        if (this.view && typeof this.view.applyMapZoom === 'function') {
          const res = this.view.applyMapZoom(spanRx, { factor, anchorFrac: u });
          this._sendSpanThrottled(spanRx, res.radioSpanHz);
        } else {
          const nextSpan = clamp(
            Math.round(hit.userSpanHz * factor),
            6000,
            368000
          );
          this._sendSpanThrottled(spanRx, nextSpan);
        }
        return;
      }

      const delta =
        Math.abs(e.deltaX) > Math.abs(e.deltaY) ? -e.deltaX : e.deltaY;
      if (delta === 0) return;
      const steps = delta < 0 ? 1 : -1;

      const wheelRit =
        !e.shiftKey &&
        this.view &&
        typeof this.view.getWheelRitMode === 'function' &&
        this.view.getWheelRitMode();
      if (wheelRit) {
        const rx =
          this.view && typeof this.view.getTargetRx === 'function'
            ? this.view.getTargetRx()
            : 'A';
        const rxKey = rx === 'B' ? 'rxB' : 'rxA';
        const rxState = (hit.snapshot && hit.snapshot[rxKey]) || {};
        const ritStep = e.altKey ? 1 : 10;
        const nextOffset = clamp(
          Math.round((Number(rxState.ritOffsetHz) || 0) + steps * ritStep),
          -9999,
          9999
        );
        if (typeof this.client.setRit === 'function') {
          this.client.setRit(rx, { on: true, offsetHz: nextOffset });
        } else if (typeof this.client.sendCat === 'function' && K4.CatCodec) {
          this.client.sendCat(
            K4.CatCodec.builders.rit(rx, true) +
              K4.CatCodec.builders.ritOffset(rx, nextOffset)
          );
        }
        return;
      }

      const rx = e.shiftKey
        ? 'B'
        : this.view && typeof this.view.getTargetRx === 'function'
        ? this.view.getTargetRx()
        : 'A';
      const rxKey = rx === 'B' ? 'rxB' : 'rxA';
      const rxState = (hit.snapshot && hit.snapshot[rxKey]) || {};
      if (rxState.locked) {
        this._notifyLocked(rx);
        return;
      }
      const stepHz = e.altKey ? 1 : rxState.stepHz || 100;

      if (typeof this.client.stepFrequency === 'function') {
        this.client.stepFrequency(rx, steps, stepHz);
      } else if (typeof this.client.tune === 'function') {
        this.client.tune(rx, (rxState.freqHz || 14074000) + steps * stepHz, {
          optimistically: true,
        });
      }
    }

    _handleDblClick(e) {
      if (this._destroyed || this._isInsideMiniPan(e)) return;
      const { xPx, yPx } = this._getLocalPoint(e);
      const hit = this._hitTest(xPx, yPx);
      if (
        hit &&
        hit.inAxis &&
        this.view &&
        typeof this.view.resetViewport === 'function'
      ) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        this.view.resetViewport(hit.paneRx, { syncRadioSpan: true });
      }
    }

    _handleGestureStart(e) {
      if (this._destroyed || this._isInsideMiniPan(e)) return;
      if (typeof e.preventDefault === 'function') e.preventDefault();
      if (!this.view || typeof this.view.applyMapZoom !== 'function') {
        return;
      }
      const { xPx, yPx } = this._getLocalPoint(e);
      const hit = this._hitTest(xPx, yPx);
      if (!hit) return;
      this._inSafariGesture = true;
      this._gestureRx = hit.paneRx === 'B' ? 'B' : 'A';
      this._gestureStartSpanHz = hit.userSpanHz;
      const u = clamp(
        (xPx - hit.layout.specRect.x) / Math.max(1, hit.layout.specRect.w),
        0,
        1
      );
      this._gestureAnchorRfHz = hit.panCenterHz + (u - 0.5) * hit.userSpanHz;
    }

    _handleGestureChange(e) {
      if (this._destroyed || (!this._inSafariGesture && this._isInsideMiniPan(e))) return;
      if (typeof e.preventDefault === 'function') e.preventDefault();
      if (
        !this._inSafariGesture ||
        !this.view ||
        typeof this.view.applyMapZoom !== 'function'
      ) {
        return;
      }
      const scale = Number(e.scale);
      if (!Number.isFinite(scale) || scale <= 0) return;
      const { xPx, yPx } = this._getLocalPoint(e);
      const hit = this._hitTest(xPx, yPx);
      const u = hit
        ? clamp(
            (xPx - hit.layout.specRect.x) / Math.max(1, hit.layout.specRect.w),
            0,
            1
          )
        : 0.5;
      const targetSpanHz = clamp(this._gestureStartSpanHz / scale, 6000, 368000);
      const res = this.view.applyMapZoom(this._gestureRx, {
        targetSpanHz,
        anchorFrac: u,
        anchorFreqHz: this._gestureAnchorRfHz,
      });
      if (res) {
        this._sendSpanThrottled(this._gestureRx, res.radioSpanHz);
      }
    }

    _handleGestureEnd(e) {
      if (this._destroyed || (!this._inSafariGesture && this._isInsideMiniPan(e))) return;
      if (typeof e.preventDefault === 'function') e.preventDefault();
      this._inSafariGesture = false;
      this._flushPendingSpan();
    }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      if (this._spanFlushTimer) {
        clearTimeout(this._spanFlushTimer);
        this._spanFlushTimer = null;
      }
      this._pendingSpan = null;
      if (this._ifCenterFlushTimer) {
        clearTimeout(this._ifCenterFlushTimer);
        this._ifCenterFlushTimer = null;
      }
      this._pendingIfCenter = null;
      this._cancelPendingVfoTune();
      this._touches.clear();
      this.surface.removeEventListener('pointerdown', this._onPointerDown);
      this.surface.removeEventListener('pointermove', this._onPointerMove);
      this.surface.removeEventListener('pointerup', this._onPointerUp);
      this.surface.removeEventListener('pointercancel', this._onPointerCancel);
      this.surface.removeEventListener('pointerleave', this._onPointerLeave);
      this.surface.removeEventListener('lostpointercapture', this._onLostPointerCapture);
      this.surface.removeEventListener('contextmenu', this._onContextMenu);
      this.surface.removeEventListener('auxclick', this._onAuxClick);
      this.surface.removeEventListener('wheel', this._onWheel);
      this.surface.removeEventListener('dblclick', this._onDblClick);
      this.surface.removeEventListener('gesturestart', this._onGestureStart);
      this.surface.removeEventListener('gesturechange', this._onGestureChange);
      this.surface.removeEventListener('gestureend', this._onGestureEnd);
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('blur', this._onWindowBlur);
      }
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', this._onVisibilityChange);
      }
    }
  }

  K4.PanadapterInteraction = PanadapterInteraction;
})();
