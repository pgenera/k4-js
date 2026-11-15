'use strict';

(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const SPAN_LADDER_HZ = [
    6000, 12000, 24000, 36000, 48000, 72000, 96000, 144000, 192000, 288000,
    368000,
  ];
  const DRAG_THRESHOLD_PX = 5;
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
      this._dragMode = null; // 'pan' | 'edge' | 'pinch' | null
      this._activePointerId = null;
      this._startX = 0;
      this._startY = 0;
      this._dragExceeded = false;
      this._dragRx = 'A';
      this._startFreqHz = 14074000;
      this._dragHit = null;
      this._edgeInfo = null;

      this._touches = new Map();
      this._wasPinched = false;
      this._pinchStartDist = 0;
      this._pinchStartSpanHz = 48000;
      this._pinchLastSentSpanHz = 0;
      this._pinchRx = 'A';

      this._lastPanSendMs = -1e9;
      this._lastEdgeSendMs = -1e9;
      this._lastPinchSendMs = -1e9;
      this._lastRightHandledMs = -1e9;

      this._onPointerDown = this._handlePointerDown.bind(this);
      this._onPointerMove = this._handlePointerMove.bind(this);
      this._onPointerUp = this._handlePointerUp.bind(this);
      this._onPointerCancel = this._handlePointerUp.bind(this);
      this._onPointerLeave = this._handlePointerLeave.bind(this);
      this._onContextMenu = this._handleContextMenu.bind(this);
      this._onWheel = this._handleWheel.bind(this);

      surface.addEventListener('pointerdown', this._onPointerDown);
      surface.addEventListener('pointermove', this._onPointerMove);
      surface.addEventListener('pointerup', this._onPointerUp);
      surface.addEventListener('pointercancel', this._onPointerCancel);
      surface.addEventListener('pointerleave', this._onPointerLeave);
      surface.addEventListener('contextmenu', this._onContextMenu);
      surface.addEventListener('wheel', this._onWheel, { passive: false });
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

    _hitTest(xPx, yPx) {
      const frame = this.view.getFrameState();
      const snapshot = frame.snapshot || this._getSnapshot();
      let layouts = this.renderer.getLayouts ? this.renderer.getLayouts() : [];
      if ((!layouts || layouts.length === 0) && K4._computePanLayouts) {
        const w = this.surface.clientWidth || 800;
        const h = this.surface.clientHeight || 400;
        const topInset = K4._measureHudTopInset
          ? K4._measureHudTopInset(this.surface.parentElement, h)
          : 0;
        layouts = K4._computePanLayouts(w, h, frame.dualPanMode || 0, topInset);
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

    _tuneClick(xPx, hit, rx, fine) {
      if (!hit || !this.client) return;
      const rxKey = rx === 'B' ? 'rxB' : 'rxA';
      const rxState = (hit.snapshot && hit.snapshot[rxKey]) || {};
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
      });
      this.view.setLastClickFreqHz(snappedHz);
      if (typeof this.client.tune === 'function') {
        this.client.tune(rx, snappedHz, { optimistically: true });
      } else if (typeof this.client.sendCat === 'function' && K4.CatCodec) {
        this.client.sendCat(K4.CatCodec.builders.freq(rx, snappedHz));
      }
    }

    _applyPanDrag(xPx, fine, isFinal) {
      const hit = this._dragHit;
      if (!hit || !this.client) return;
      const plotW = Math.max(1, hit.layout.specRect.w);
      const dx = xPx - this._startX;
      const deltaHz = -(dx / plotW) * hit.userSpanHz;
      const rawHz = this._startFreqHz + deltaHz;

      const rxKey = this._dragRx === 'B' ? 'rxB' : 'rxA';
      const rxState = (this._getSnapshot()[rxKey]) || {};
      const finalStep = fine ? 1 : rxState.stepHz || 100;
      const step = isFinal ? finalStep : fine ? 1 : Math.min(finalStep, 100);
      const snappedHz = clamp(Math.round(rawHz / step) * step, 100000, 54000000);

      const now = performance.now();
      if (!isFinal && now - this._lastPanSendMs < THROTTLE_MS) {
        return;
      }
      this._lastPanSendMs = now;
      if (typeof this.client.tune === 'function') {
        this.client.tune(this._dragRx, snappedHz, { optimistically: true });
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

    _pinchDist() {
      const pts = Array.from(this._touches.values());
      if (pts.length < 2) return 40;
      const dx = pts[0].x - pts[1].x;
      const dy = pts[0].y - pts[1].y;
      return Math.max(16, Math.hypot(dx, dy * 0.35));
    }

    _handlePointerDown(e) {
      if (this._destroyed) return;
      const { xPx, yPx } = this._getLocalPoint(e);
      const hit = this._hitTest(xPx, yPx);

      if (e.pointerType === 'touch') {
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
          this._dragMode = 'pinch';
          this._wasPinched = true;
          this._dragExceeded = false;
          this._pinchStartDist = this._pinchDist();
          this._pinchStartSpanHz = hit ? hit.userSpanHz : 48000;
          this._pinchLastSentSpanHz = this._pinchStartSpanHz;
          this._pinchRx = hit && hit.paneRx === 'B' ? 'B' : 'A';
        } else if (this._touches.size === 1) {
          this._wasPinched = false;
          this._dragMode = 'pan';
          this._dragExceeded = false;
          this._startX = xPx;
          this._startY = yPx;
          this._dragRx =
            hit && hit.paneRx === 'B' ? 'B' : this.view.getTargetRx();
          const rxKey = this._dragRx === 'B' ? 'rxB' : 'rxA';
          const rxState = (hit && hit.snapshot && hit.snapshot[rxKey]) || {};
          this._startFreqHz = rxState.freqHz || 14074000;
          this._dragHit = hit;
        }
        return;
      }

      if (e.button === 2) {
        this._lastRightHandledMs = performance.now();
        this._tuneClick(xPx, hit, 'B', e.altKey);
        return;
      }

      if (e.button !== 0) return;

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

      this._dragMode = 'pan';
      this._activePointerId = e.pointerId;
      this._startX = xPx;
      this._startY = yPx;
      this._dragExceeded = false;
      this._dragRx =
        (hit && hit.paneRx === 'B') || e.shiftKey
          ? 'B'
          : this.view.getTargetRx();
      const rxKey = this._dragRx === 'B' ? 'rxB' : 'rxA';
      const rxState = (hit && hit.snapshot && hit.snapshot[rxKey]) || {};
      this._startFreqHz = rxState.freqHz || 14074000;
      this._dragHit = hit;

      try {
        this.surface.setPointerCapture(e.pointerId);
      } catch (_err) {
        // ignore
      }
    }

    _handlePointerMove(e) {
      if (this._destroyed) return;
      const { xPx, yPx } = this._getLocalPoint(e);

      if (e.pointerType === 'touch') {
        if (this._touches.has(e.pointerId)) {
          const entry = this._touches.get(e.pointerId);
          entry.x = xPx;
          entry.y = yPx;
        }
        if (this._touches.size === 2 && this._dragMode === 'pinch') {
          const now = performance.now();
          if (now - this._lastPinchSendMs < THROTTLE_MS) return;
          const dist = this._pinchDist();
          const ratio = this._pinchStartDist / dist;
          const targetSpan = this._pinchStartSpanHz * ratio;
          const nextSpan = SPAN_LADDER_HZ[nearestSpanIndex(targetSpan)];
          if (nextSpan !== this._pinchLastSentSpanHz) {
            this._pinchLastSentSpanHz = nextSpan;
            this._lastPinchSendMs = now;
            this._sendSpan(this._pinchRx, nextSpan);
          }
          return;
        }
        if (
          this._touches.size === 1 &&
          !this._wasPinched &&
          this._dragMode === 'pan'
        ) {
          if (!this._dragExceeded && Math.abs(xPx - this._startX) > DRAG_THRESHOLD_PX) {
            this._dragExceeded = true;
          }
          if (this._dragExceeded) {
            this._applyPanDrag(xPx, false, false);
          }
        }
        return;
      }

      const hit = this._hitTest(xPx, yPx);
      const edgeHint = this._dragMode ? null : this._findHoveredEdge(xPx, yPx, hit);
      if (hit) {
        this.view.setHoverState({
          active: true,
          xPx,
          yPx,
          paneRx: hit.paneRx,
          edgeHint,
        });
      }

      if (
        (this._dragMode === 'edge' || this._dragMode === 'pan') &&
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
            this._applyPanDrag(xPx, Boolean(e.altKey), false);
          }
        }
        return;
      }

      this.surface.style.cursor = edgeHint ? 'ew-resize' : 'crosshair';
    }

    _handlePointerUp(e) {
      if (this._destroyed) return;
      const { xPx, yPx } = this._getLocalPoint(e);

      if (e.pointerType === 'touch') {
        this._touches.delete(e.pointerId);
        if (e.type === 'pointerup' && this._touches.size === 0) {
          if (!this._wasPinched) {
            if (this._dragExceeded) {
              this._applyPanDrag(xPx, false, true);
            } else {
              const hit = this._hitTest(xPx, yPx);
              const rx =
                hit && hit.paneRx === 'B' ? 'B' : this.view.getTargetRx();
              this._tuneClick(xPx, hit, rx, false);
            }
          }
          this._wasPinched = false;
          this._dragMode = null;
          this._dragExceeded = false;
          this._dragHit = null;
        }
        return;
      }

      if (this._activePointerId !== null && e.pointerId !== this._activePointerId) {
        return;
      }

      try {
        this.surface.releasePointerCapture(e.pointerId);
      } catch (_err) {
        // ignore
      }

      if (this._dragMode === 'edge' || this._dragMode === 'pan') {
        if (this._dragExceeded) {
          if (this._dragMode === 'edge') {
            this._applyEdgeDrag(xPx, true);
          } else {
            this._applyPanDrag(xPx, Boolean(e.altKey), true);
          }
        } else if (e.button === 0 && e.type === 'pointerup') {
          const hit = this._hitTest(xPx, yPx);
          const rx =
            (hit && hit.paneRx === 'B') || e.shiftKey
              ? 'B'
              : this.view.getTargetRx();
          this._tuneClick(xPx, hit, rx, Boolean(e.altKey));
        }
      }

      this._dragMode = null;
      this._activePointerId = null;
      this._dragExceeded = false;
      this._edgeInfo = null;
      this._dragHit = null;
      this.surface.style.cursor = 'crosshair';
    }

    _handlePointerLeave() {
      if (!this._dragMode) {
        this.view.setHoverState(null);
      }
    }

    _handleContextMenu(e) {
      e.preventDefault();
      e.stopPropagation();
      if (this._destroyed) return;
      if (performance.now() - this._lastRightHandledMs > 250) {
        const { xPx, yPx } = this._getLocalPoint(e);
        const hit = this._hitTest(xPx, yPx);
        this._tuneClick(xPx, hit, 'B', e.altKey);
      }
    }

    _handleWheel(e) {
      e.preventDefault();
      if (this._destroyed || !this.client) return;
      const { xPx, yPx } = this._getLocalPoint(e);
      const hit = this._hitTest(xPx, yPx);
      if (!hit) return;

      if (e.ctrlKey || e.metaKey || hit.inAxis) {
        const spanRx = hit.paneRx === 'B' ? 'B' : 'A';
        const curIdx = nearestSpanIndex(hit.userSpanHz);
        const dir = e.deltaY < 0 ? -1 : 1;
        const nextIdx = clamp(curIdx + dir, 0, SPAN_LADDER_HZ.length - 1);
        this._sendSpan(spanRx, SPAN_LADDER_HZ[nextIdx]);
        return;
      }

      const rx =
        hit.paneRx === 'B' || e.shiftKey ? 'B' : this.view.getTargetRx();

      const delta =
        Math.abs(e.deltaX) > Math.abs(e.deltaY) ? -e.deltaX : e.deltaY;
      if (delta === 0) return;
      const steps = delta < 0 ? 1 : -1;
      const rxKey = rx === 'B' ? 'rxB' : 'rxA';
      const rxState = (hit.snapshot && hit.snapshot[rxKey]) || {};
      const stepHz = e.altKey ? 1 : rxState.stepHz || 100;

      if (typeof this.client.stepFrequency === 'function') {
        this.client.stepFrequency(rx, steps, stepHz);
      } else if (typeof this.client.tune === 'function') {
        this.client.tune(rx, (rxState.freqHz || 14074000) + steps * stepHz, {
          optimistically: true,
        });
      }
    }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      this.surface.removeEventListener('pointerdown', this._onPointerDown);
      this.surface.removeEventListener('pointermove', this._onPointerMove);
      this.surface.removeEventListener('pointerup', this._onPointerUp);
      this.surface.removeEventListener('pointercancel', this._onPointerCancel);
      this.surface.removeEventListener('pointerleave', this._onPointerLeave);
      this.surface.removeEventListener('contextmenu', this._onContextMenu);
      this.surface.removeEventListener('wheel', this._onWheel);
    }
  }

  K4.PanadapterInteraction = PanadapterInteraction;
})();
