'use strict';

(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const RING_HEIGHT = 512;
  const DEFAULT_BINS = 1024;
  const MINIPAN_HEADER_H = 24;
  const ACCENT_RGB_A = [56 / 255, 189 / 255, 248 / 255];
  const ACCENT_RGB_B = [34 / 255, 197 / 255, 94 / 255];
  const MONO_FONT =
    '"SF Mono", ui-monospace, "Cascadia Mono", "Roboto Mono", monospace';
  const SANS_FONT =
    'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

  function ensureGlobalPerf() {
    const p = (globalThis.__k4Perf = globalThis.__k4Perf || {});
    if (typeof p.panFrames !== 'number') p.panFrames = 0;
    if (typeof p.overlayDraws !== 'number') p.overlayDraws = 0;
    if (typeof p.overlaySkips !== 'number') p.overlaySkips = 0;
    if (typeof p.hudMeasures !== 'number') p.hudMeasures = 0;
    if (typeof p.metaTexUploads !== 'number') p.metaTexUploads = 0;
    return p;
  }

  function createPerfCounters() {
    ensureGlobalPerf();
    return {
      panFrames: 0,
      overlayDraws: 0,
      overlaySkips: 0,
      hudMeasures: 0,
      metaTexUploads: 0,
    };
  }

  function bumpPerf(perf, key) {
    if (perf) perf[key] = (perf[key] || 0) + 1;
    const g = ensureGlobalPerf();
    g[key] = (g[key] || 0) + 1;
  }

  function ensureMiniPanBaseStyles() {
    if (typeof document === 'undefined' || !document.head) return;
    if (document.getElementById('k4-minipan-base-style')) return;
    const style = document.createElement('style');
    style.id = 'k4-minipan-base-style';
    style.textContent = `
:where(.k4-minipan-box) {
  position: absolute;
  z-index: 6;
  display: none;
  flex-direction: column;
  box-sizing: border-box;
  border-radius: 8px;
  border: 1px solid rgba(56, 189, 248, 0.35);
  background: rgba(9, 11, 16, 0.92);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
  overflow: hidden;
  pointer-events: auto;
  user-select: none;
  touch-action: none;
}
:where(.k4-minipan-box[data-snapping="true"]) {
  transition: left 140ms ease-out, top 140ms ease-out;
}
:where(.k4-minipan-box[data-dragging="true"]) {
  transition: none;
}
:where(.k4-minipan-box[data-rx="B"]) {
  border-color: rgba(34, 197, 94, 0.48);
}
:where(.k4-minipan-header) {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  flex: 0 0 24px;
  padding: 0 6px 0 8px;
  background: rgba(14, 19, 29, 0.94);
  border-bottom: 1px solid rgba(148, 163, 184, 0.16);
  cursor: grab;
  user-select: none;
  touch-action: none;
}
:where(.k4-minipan-header:active),
:where(.k4-minipan-box[data-dragging="true"] .k4-minipan-header) {
  cursor: grabbing;
}
:where(.k4-minipan-title) {
  font-family: ${SANS_FONT};
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: #38BDF8;
  white-space: nowrap;
}
:where(.k4-minipan-box[data-rx="B"] .k4-minipan-title) {
  color: #22C55E;
}
:where(.k4-minipan-span) {
  margin-left: auto;
  font-family: ${MONO_FONT};
  font-variant-numeric: tabular-nums;
  font-size: 10px;
  color: #CBD5E1;
  white-space: nowrap;
}
:where(.k4-minipan-close) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #94A3B8;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}
:where(.k4-minipan-close:hover) {
  background: rgba(148, 163, 184, 0.18);
  color: #F8FAFC;
}
:where(.k4-minipan-canvas) {
  display: block;
  width: 100%;
  flex: 1 1 auto;
  min-height: 0;
  pointer-events: auto;
}
`;
    document.head.appendChild(style);
  }

  function computeViewportCropInto(out, viewCenterHz, viewSpanHz, streamCenterHz, tierKHz) {
    const safeTierKHz = Number.isFinite(tierKHz) && tierKHz > 0 ? tierKHz : 48;
    const tierSpanHz = Math.max(1000, safeTierKHz * 1000);
    const spanHz =
      Number.isFinite(viewSpanHz) && viewSpanHz > 0 ? viewSpanHz : tierSpanHz;
    if (!Number.isFinite(viewCenterHz) || !Number.isFinite(streamCenterHz)) {
      const spanRatio = clamp(spanHz / tierSpanHz, 0.01, 1.0);
      const leftRatio = 0.5 * (1.0 - spanRatio);
      out.tierSpanHz = tierSpanHz;
      out.spanRatio = spanRatio;
      out.leftRatio = leftRatio;
      out.rightRatio = leftRatio + spanRatio;
      return out;
    }
    const spanRatio = Math.max(0.005, spanHz / tierSpanHz);
    const streamLeftHz = streamCenterHz - tierSpanHz * 0.5;
    const viewLeftHz = viewCenterHz - spanHz * 0.5;
    const leftRatio = (viewLeftHz - streamLeftHz) / tierSpanHz;
    out.tierSpanHz = tierSpanHz;
    out.spanRatio = spanRatio;
    out.leftRatio = leftRatio;
    out.rightRatio = leftRatio + spanRatio;
    return out;
  }

  const WF_VERT_SRC = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

  const WF_FRAG_SRC = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_wfTex;
uniform sampler2D u_lutTex;
uniform sampler2D u_metaTex;
uniform int u_writeRow;
uniform int u_filledRows;
uniform int u_liveRows;
uniform int u_binCount;
uniform float u_visibleRows;
uniform int u_ringHeight;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  int rowAge = int(floor(v_uv.y * u_visibleRows));
  if (rowAge < 0 || rowAge >= u_filledRows || rowAge >= u_ringHeight) {
    fragColor = texelFetch(u_lutTex, ivec2(0, 0), 0);
    return;
  }
  int ringRow = ((u_writeRow - 1 - rowAge) % u_ringHeight + u_ringHeight) % u_ringHeight;
  vec2 rowMeta = texelFetch(u_metaTex, ivec2(0, ringRow), 0).rg;
  float tierU = rowMeta.x + v_uv.x * rowMeta.y;
  if (tierU < 0.0 || tierU > 1.0) {
    fragColor = texelFetch(u_lutTex, ivec2(0, 0), 0);
    return;
  }
  int binIdx = clamp(int(floor(tierU * float(u_binCount))), 0, u_binCount - 1);
  float val = texelFetch(u_wfTex, ivec2(binIdx, ringRow), 0).r;
  int lutIdx = clamp(int(floor(val * 255.0 + 0.5)), 0, 255);
  vec4 baseCol = texelFetch(u_lutTex, ivec2(lutIdx, 0), 0);
  if (rowAge >= u_liveRows) {
    vec4 bgCol = texelFetch(u_lutTex, ivec2(0, 0), 0);
    int stripe = (int(gl_FragCoord.x) + int(gl_FragCoord.y)) % 8;
    float t = stripe < 2 ? 0.22 : 0.42;
    fragColor = vec4(mix(bgCol.rgb, baseCol.rgb, t), 1.0);
    return;
  }
  fragColor = baseCol;
}`;

  const SPEC_VERT_SRC = `#version 300 es
in vec2 a_pos;
in float a_alpha;
out float v_alpha;
void main() {
  v_alpha = a_alpha;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

  const SPEC_FRAG_SRC = `#version 300 es
precision highp float;
uniform vec4 u_color;
in float v_alpha;
out vec4 fragColor;
void main() {
  fragColor = vec4(u_color.rgb, u_color.a * v_alpha);
}`;

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  function seedWaterfallRingNoise(uint8Row, binCount, ringHeight, dstBuf) {
    const sampleCount = Math.min(32, uint8Row.length);
    const samples = [];
    const stride = Math.max(1, Math.floor(uint8Row.length / Math.max(1, sampleCount)));
    for (let i = 0; i < uint8Row.length && samples.length < sampleCount; i += stride) {
      samples.push(uint8Row[i]);
    }
    samples.sort((a, b) => a - b);
    const q25 = samples.length > 0 ? samples[Math.floor(samples.length * 0.25)] : 28;
    const base = clamp(q25, 16, 96);
    for (let r = 0; r < ringHeight; r++) {
      const off = r * binCount;
      for (let b = 0; b < binCount; b++) {
        const grain = (r * 131 + b * 17 + (r >> 2) * 31) & 7;
        dstBuf[off + b] = clamp(base - 4 + grain, 8, 255);
      }
    }
  }

  function formatAxisKHz(hz) {
    const khz = hz / 1000;
    if (Math.abs(khz - Math.round(khz)) < 0.05) {
      return String(Math.round(khz));
    }
    return khz.toFixed(1);
  }

  function pickNiceTickStepHz(spanHz, widthPx) {
    const candidates = [500, 1000, 2000, 5000, 10000, 20000, 25000, 50000, 100000];
    const maxTicks = Math.max(3, Math.floor(widthPx / 76));
    for (let i = 0; i < candidates.length; i++) {
      if (spanHz / candidates[i] <= maxTicks) {
        return candidates[i];
      }
    }
    return 100000;
  }

  function measureHudTopInset(container, cssH) {
    if (!container || cssH < 120) return 0;
    const hud = container.querySelector(':scope > .k4-pan-hud-top');
    if (!hud) return 0;
    const style =
      typeof globalThis.getComputedStyle === 'function'
        ? globalThis.getComputedStyle(hud)
        : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) {
      return 0;
    }
    const cRect = container.getBoundingClientRect();
    const hRect = hud.getBoundingClientRect();
    if (!(hRect.height > 0 && hRect.width > 0 && cRect.height > 0)) {
      return 0;
    }
    const relBottom = hRect.bottom - cRect.top;
    if (relBottom <= 0) return 0;
    return Math.max(
      40,
      Math.min(Math.ceil(relBottom + 6), Math.floor(cssH * 0.25))
    );
  }

  function computePaneLayouts(width, height, dualPanMode, topInset = 0, layoutOpts = null) {
    const w = Math.max(0, width);
    const h = Math.max(0, height);
    if (w === 0 || h === 0) return [];

    const y0 = clamp(Math.round(topInset || 0), 0, Math.max(0, h - 80));
    const totalH = Math.max(40, h - y0);

    const rects = [];
    if (dualPanMode === 2) {
      if (w >= 1000) {
        const w1 = Math.floor((w - 2) / 2);
        const w2 = w - 2 - w1;
        rects.push({ rx: 'A', x: 0, y: y0, w: w1, h: totalH });
        rects.push({ rx: 'B', x: w1 + 2, y: y0, w: w2, h: totalH });
      } else {
        const h1 = Math.floor((totalH - 2) / 2);
        const h2 = totalH - 2 - h1;
        rects.push({ rx: 'A', x: 0, y: y0, w, h: h1 });
        rects.push({ rx: 'B', x: 0, y: y0 + h1 + 2, w, h: h2 });
      }
    } else {
      const primaryRx = dualPanMode === 1 ? 'B' : 'A';
      rects.push({ rx: primaryRx, x: 0, y: y0, w, h: totalH });
    }

    const dispMode =
      layoutOpts && Number.isFinite(layoutOpts.displayMode) ? layoutOpts.displayMode : 1;
    const wfhRaw =
      layoutOpts && Number.isFinite(layoutOpts.waterfallHeightPct)
        ? layoutOpts.waterfallHeightPct
        : 62;
    const specOnly = dispMode === 0 || dispMode === 2 || wfhRaw <= 0;

    return rects.map((r) => {
      const axisH = 22;
      const availH = Math.max(40, r.h - axisH);
      const axisY = r.y;
      const specY = r.y + axisH;
      if (specOnly) {
        const specH = availH;
        return {
          rx: r.rx,
          paneRect: { x: r.x, y: r.y, w: r.w, h: r.h },
          axisRect: { x: r.x, y: axisY, w: r.w, h: axisH },
          specRect: { x: r.x, y: specY, w: r.w, h: specH },
          wfRect: { x: r.x, y: specY + specH, w: r.w, h: 0 },
        };
      }
      const wfFrac = clamp(wfhRaw / 100, 0.15, 0.85);
      let wfH = Math.max(16, Math.round(availH * wfFrac));
      const specH = Math.max(20, availH - wfH);
      wfH = Math.max(16, availH - specH);
      const wfY = specY + specH;
      return {
        rx: r.rx,
        paneRect: { x: r.x, y: r.y, w: r.w, h: r.h },
        axisRect: { x: r.x, y: axisY, w: r.w, h: axisH },
        specRect: { x: r.x, y: specY, w: r.w, h: specH },
        wfRect: { x: r.x, y: wfY, w: r.w, h: wfH },
      };
    });
  }

  function computeNotchRfHz(rxState) {
    if (!rxState || !rxState.notchOn) return null;
    const carrier = rxState.freqHz || 0;
    const notch = Number.isFinite(rxState.notchHz) ? rxState.notchHz : 750;
    const mode = rxState.mode;
    const sub = rxState.dataSubMode || 0;
    if (mode === 1 || mode === 7 || (mode === 9 && sub === 0)) {
      return carrier - notch;
    }
    return carrier + notch;
  }

  function sampleShownDbmAtFreq(pane, freqHz) {
    if (!pane || !pane.binsReady || !pane.shownDbm || pane.shownDbm.length < 2) {
      return null;
    }
    const tierSpanHz = Math.max(1000, (pane.tierKHz || 48) * 1000);
    const streamCenter = Number.isFinite(pane.streamCenterHz)
      ? pane.streamCenterHz
      : pane.panCenterHz;
    const tierLeft = streamCenter - tierSpanHz * 0.5;
    const tierU = (freqHz - tierLeft) / tierSpanHz;
    if (tierU < 0 || tierU > 1) return null;
    const n = pane.shownDbm.length;
    const fIdx = tierU * (n - 1);
    const i0 = Math.floor(fIdx);
    const i1 = Math.min(n - 1, i0 + 1);
    const frac = fIdx - i0;
    return pane.shownDbm[i0] * (1 - frac) + pane.shownDbm[i1] * frac;
  }

  function ensureSurfaceDom(container) {
    ensureMiniPanBaseStyles();
    let surface = container.querySelector(':scope > .k4-pan-surface');
    if (!surface) {
      surface = document.createElement('div');
      surface.className = 'k4-pan-surface';
      surface.setAttribute('data-testid', 'pan-canvas');
      surface.style.position = 'relative';
      surface.style.width = '100%';
      surface.style.height = '100%';
      surface.style.overflow = 'hidden';
      surface.style.touchAction = 'none';
      surface.style.userSelect = 'none';
      surface.style.zIndex = '0';
      container.insertBefore(surface, container.firstChild);
    } else {
      surface.setAttribute('data-testid', 'pan-canvas');
      surface.style.touchAction = 'none';
    }

    let glCanvas = surface.querySelector(':scope > .k4-pan-gl');
    if (!glCanvas) {
      glCanvas = document.createElement('canvas');
      glCanvas.className = 'k4-pan-gl';
      glCanvas.style.position = 'absolute';
      glCanvas.style.inset = '0';
      glCanvas.style.width = '100%';
      glCanvas.style.height = '100%';
      glCanvas.style.display = 'block';
      surface.appendChild(glCanvas);
    }

    let overlayCanvas = surface.querySelector(':scope > .k4-pan-overlay');
    if (!overlayCanvas) {
      overlayCanvas = document.createElement('canvas');
      overlayCanvas.className = 'k4-pan-overlay';
      overlayCanvas.style.position = 'absolute';
      overlayCanvas.style.inset = '0';
      overlayCanvas.style.width = '100%';
      overlayCanvas.style.height = '100%';
      overlayCanvas.style.display = 'block';
      overlayCanvas.style.pointerEvents = 'none';
      surface.appendChild(overlayCanvas);
    }

    // Remove any legacy or stale Mini-Pan boxes before mounting fresh A & B boxes
    const staleBoxes = surface.querySelectorAll(':scope > .k4-minipan-box');
    for (let i = 0; i < staleBoxes.length; i++) {
      staleBoxes[i].remove();
    }

    return { surface, glCanvas, overlayCanvas };
  }

  function drawRoundedPill(ctx, x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.lineTo(x + w - rad, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
    ctx.lineTo(x + w, y + h - rad);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
    ctx.lineTo(x + rad, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
    ctx.lineTo(x, y + rad);
    ctx.quadraticCurveTo(x, y, x + rad, y);
    ctx.closePath();
  }

  function collectStatusPills(snapshot, primaryRxState) {
    const pills = [];
    if (primaryRxState && primaryRxState.adcOverflow) {
      pills.push({
        text: 'ADC OVF',
        fill: 'rgba(225, 29, 72, 0.92)',
        stroke: null,
        textColor: '#FFF1F2',
      });
    }
    if (primaryRxState && primaryRxState.panNbMode > 0) {
      pills.push({
        text: 'NB',
        fill: 'rgba(56, 189, 248, 0.20)',
        stroke: 'rgba(56, 189, 248, 0.72)',
        textColor: '#BAE6FD',
      });
    }
    if (snapshot.panFrozen) {
      pills.push({
        text: 'FROZEN',
        fill: 'rgba(56, 189, 248, 0.24)',
        stroke: 'rgba(56, 189, 248, 0.78)',
        textColor: '#E0F2FE',
      });
    }
    if (snapshot.txInhibit) {
      pills.push({
        text: 'TX INHIBIT',
        fill: 'rgba(225, 29, 72, 0.92)',
        stroke: 'rgba(253, 164, 175, 0.85)',
        textColor: '#FFF1F2',
      });
    }
    if (snapshot.atuTuning) {
      const swr =
        snapshot.txMeters &&
        Number.isFinite(snapshot.txMeters.swr) &&
        snapshot.txMeters.swr > 0
          ? snapshot.txMeters.swr.toFixed(1)
          : '-.-';
      pills.push({
        text: 'ATU TUNE · SWR ' + swr + ':1',
        fill: 'rgba(234, 88, 12, 0.92)',
        stroke: 'rgba(253, 186, 116, 0.90)',
        textColor: '#FFF7ED',
      });
    }
    if (snapshot.txTestMode || snapshot.txPosture === 'tx-test') {
      pills.push({
        text: 'TX Test',
        fill: 'rgba(249, 115, 22, 0.24)',
        stroke: 'rgba(249, 115, 22, 0.88)',
        textColor: '#FFEDD5',
      });
    }
    return pills;
  }

  function layoutStatusPills(ctx, specRect, pills, monoFont) {
    if (!pills || pills.length === 0) return [];
    const font = 'bold 9.5px ' + monoFont;
    ctx.font = font;
    const minLeft = specRect.x + Math.min(120, specRect.w * 0.35);
    let pillRight = specRect.x + specRect.w - 8;
    let pillY = specRect.y + 6;
    const placed = [];
    for (let i = 0; i < pills.length; i++) {
      const p = pills[i];
      const w = ctx.measureText(p.text).width + 10;
      const h = 16;
      if (i > 0 && pillRight - w < minLeft) {
        pillY += 20;
        pillRight = specRect.x + specRect.w - 8;
      }
      const x = Math.max(specRect.x + 4, pillRight - w);
      placed.push({
        x,
        y: pillY,
        w,
        h,
        text: p.text,
        fill: p.fill,
        stroke: p.stroke,
        textColor: p.textColor,
        font,
      });
      pillRight = x - 6;
    }
    return placed;
  }

  function pickNonOverlappingY(x, w, h, candidateYs, occupiedBoxes, specRect) {
    const minY = specRect.y + 4;
    const maxY = Math.max(minY, specRect.y + specRect.h - h - 4);
    for (let i = 0; i < candidateYs.length; i++) {
      const cy = clamp(candidateYs[i], minY, maxY);
      const overlaps = occupiedBoxes.some(
        (b) =>
          x < b.x + b.w + 3 &&
          x + w + 3 > b.x &&
          cy < b.y + b.h + 2 &&
          cy + h + 2 > b.y
      );
      if (!overlaps) return cy;
    }
    return clamp(candidateYs[candidateYs.length - 1], minY, maxY);
  }

  function drawTxOverlayOnSpectrum({
    ctx,
    specRect,
    paneRx,
    dualPanMode,
    panCenterHz,
    userSpanHz,
    viewLeftHz,
    viewRightHz,
    cwPitchHz,
    snapshot,
    rxA,
    rxB,
    txOverlay,
    txPosture,
    isLiveTx,
    occupiedBoxes,
    monoFont,
  }) {
    if (!txOverlay) return null;
    const isTest = Boolean(snapshot.txTestMode || txPosture === 'tx-test');
    const txShown = Boolean(txOverlay.isSplitOrXit || isLiveTx || isTest);
    if (!txShown) return null;

    const txState = txOverlay.txVfo === 'B' ? rxB : rxA;
    const txPinHz = K4.SpectrumGeometry.displayMarkerHz(
      Object.assign({}, txState, { freqHz: txOverlay.carrierHz }),
      cwPitchHz
    );

    const splitEnabled = Boolean(snapshot.splitEnabled);
    const xitEnabled = Boolean(snapshot.xitEnabled);
    let txLabel = isTest && !snapshot.atuTuning
      ? (splitEnabled ? 'TX Test B' : 'TX Test')
      : 'TX';
    if (!isTest || snapshot.atuTuning) {
      if (splitEnabled && xitEnabled) {
        txLabel = 'TX B·XIT';
      } else if (splitEnabled) {
        txLabel = 'TX B';
      } else if (xitEnabled) {
        txLabel = 'XIT';
      }
    }

    let curtainFill;
    let curtainEdge;
    let pinColor;
    let badgeFill;
    let badgeStroke;
    let badgeText;
    if (isLiveTx && (!isTest || snapshot.atuTuning)) {
      curtainFill = 'rgba(249, 115, 22, 0.24)';
      curtainEdge = '#F97316';
      pinColor = '#F97316';
      badgeFill = '#EA580C';
      badgeStroke = '#FDBA74';
      badgeText = '#FFF7ED';
    } else if (!isTest && txPosture === 'tx-armed') {
      curtainFill = 'rgba(249, 115, 22, 0.13)';
      curtainEdge = 'rgba(249, 115, 22, 0.72)';
      pinColor = 'rgba(251, 146, 60, 0.92)';
      badgeFill = 'rgba(14, 19, 29, 0.90)';
      badgeStroke = 'rgba(249, 115, 22, 0.88)';
      badgeText = '#FFEDD5';
    } else {
      curtainFill = isLiveTx ? 'rgba(249, 115, 22, 0.22)' : 'rgba(251, 146, 60, 0.11)';
      curtainEdge = isLiveTx ? '#F97316' : 'rgba(251, 146, 60, 0.68)';
      pinColor = isLiveTx ? '#FB923C' : 'rgba(251, 146, 60, 0.88)';
      badgeFill = isLiveTx ? 'rgba(234, 88, 12, 0.90)' : 'rgba(14, 19, 29, 0.90)';
      badgeStroke = 'rgba(251, 146, 60, 0.85)';
      badgeText = isLiveTx ? '#FFF7ED' : '#FDBA74';
    }

    const lowX = K4.SpectrumGeometry.xFromRfFreq(
      txOverlay.lowHz,
      specRect.x,
      specRect.w,
      panCenterHz,
      userSpanHz
    );
    const highX = K4.SpectrumGeometry.xFromRfFreq(
      txOverlay.highHz,
      specRect.x,
      specRect.w,
      panCenterHz,
      userSpanHz
    );
    if (highX >= specRect.x && lowX <= specRect.x + specRect.w) {
      const leftClamped = Math.max(specRect.x, lowX);
      const rightClamped = Math.min(specRect.x + specRect.w, highX);
      const curW = Math.max(1, rightClamped - leftClamped);
      ctx.fillStyle = curtainFill;
      ctx.fillRect(leftClamped, specRect.y, curW, specRect.h);

      ctx.save();
      if (!isLiveTx) ctx.setLineDash([4, 3]);
      ctx.strokeStyle = curtainEdge;
      ctx.lineWidth = isLiveTx ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(lowX) + 0.5, specRect.y);
      ctx.lineTo(Math.round(lowX) + 0.5, specRect.y + specRect.h);
      ctx.moveTo(Math.round(highX) + 0.5, specRect.y);
      ctx.lineTo(Math.round(highX) + 0.5, specRect.y + specRect.h);
      ctx.stroke();
      ctx.restore();
    }

    if (txPinHz >= viewLeftHz && txPinHz <= viewRightHz) {
      const txX = K4.SpectrumGeometry.xFromRfFreq(
        txPinHz,
        specRect.x,
        specRect.w,
        panCenterHz,
        userSpanHz
      );
      ctx.save();
      if (!isLiveTx) ctx.setLineDash([4, 3]);
      ctx.strokeStyle = pinColor;
      ctx.lineWidth = isLiveTx ? 2.0 : 1.5;
      ctx.beginPath();
      ctx.moveTo(txX, specRect.y);
      ctx.lineTo(txX, specRect.y + specRect.h);
      ctx.stroke();
      ctx.restore();

      ctx.font = 'bold 9.5px ' + monoFont;
      const bw = ctx.measureText(txLabel).width + 10;
      const bh = 15;
      const bx = clamp(
        txX - bw / 2,
        specRect.x + 4,
        specRect.x + specRect.w - bw - 4
      );
      const by = pickNonOverlappingY(
        bx,
        bw,
        bh,
        [specRect.y + 5, specRect.y + 24, specRect.y + 43, specRect.y + 62],
        occupiedBoxes,
        specRect
      );
      drawRoundedPill(ctx, bx, by, bw, bh, 4);
      ctx.fillStyle = badgeFill;
      ctx.fill();
      if (badgeStroke) {
        ctx.strokeStyle = badgeStroke;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.fillStyle = badgeText;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(txLabel, bx + bw / 2, by + bh / 2 + 0.5);
    } else if (dualPanMode !== 2 || txOverlay.txVfo === paneRx) {
      const isLeft = txPinHz < viewLeftHz;
      const badge = (isLeft ? '◀ ' : '') + txLabel + (isLeft ? '' : ' ▶');
      ctx.font = 'bold 9.5px ' + monoFont;
      const bw = ctx.measureText(badge).width + 10;
      const bh = 15;
      const bx = isLeft ? specRect.x + 6 : specRect.x + specRect.w - bw - 6;
      const by = pickNonOverlappingY(
        bx,
        bw,
        bh,
        [specRect.y + 24, specRect.y + 43, specRect.y + 62],
        occupiedBoxes,
        specRect
      );
      drawRoundedPill(ctx, bx, by, bw, bh, 4);
      ctx.fillStyle = badgeFill;
      ctx.fill();
      ctx.strokeStyle = badgeStroke;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = badgeText;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(badge, bx + bw / 2, by + bh / 2 + 0.5);
    }

    return txPinHz;
  }

  function isPortraitMobileViewport(cssW, cssH, frameState) {
    if (frameState && typeof frameState.isPortraitMobile === 'boolean') {
      return frameState.isPortraitMobile;
    }
    if (
      typeof window !== 'undefined' &&
      window.innerWidth > 0 &&
      window.innerHeight > 0
    ) {
      return window.innerWidth <= 959 && window.innerHeight > window.innerWidth;
    }
    return cssW > 0 && cssH > 0 && cssW <= 959 && cssH > cssW;
  }

  function drawMainOverlay({
    overlayCtx,
    cssW,
    cssH,
    dpr,
    layouts,
    frameState,
    vfoPillBoxes,
  }) {
    if (Array.isArray(vfoPillBoxes)) {
      vfoPillBoxes.length = 0;
    }
    if (!overlayCtx || cssW <= 0 || cssH <= 0) return;

    const ctx = overlayCtx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const snapshot = (frameState && frameState.snapshot) || {};
    const dualPanMode = frameState ? frameState.dualPanMode : 0;
    const cwPitchHz = Number.isFinite(snapshot.cwPitchHz) ? snapshot.cwPitchHz : 500;
    const subRxEnabled = Boolean(snapshot.subRxEnabled);
    const splitEnabled = Boolean(snapshot.splitEnabled);
    const targetRx = frameState && frameState.targetRx ? frameState.targetRx : 'A';
    const hover = frameState && frameState.hover;
    const isPortraitMobile = isPortraitMobileViewport(cssW, cssH, frameState);

    const monoFont =
      '"SF Mono", ui-monospace, "Cascadia Mono", "Roboto Mono", monospace';
    const sansFont =
      'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

    // Top HUD clearance header strip (when .k4-pan-hud-top reserves space above panes)
    const topBarH = layouts.length > 0 ? layouts[0].paneRect.y : 0;
    if (topBarH > 0) {
      ctx.fillStyle = '#0C1018';
      ctx.fillRect(0, 0, cssW, topBarH);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, topBarH - 0.5);
      ctx.lineTo(cssW, topBarH - 0.5);
      ctx.stroke();
    }

    // Divider line for Dual-Pan
    if (dualPanMode === 2 && layouts.length === 2) {
      ctx.fillStyle = 'rgba(148, 163, 184, 0.25)';
      if (cssW >= 1000) {
        ctx.fillRect(
          layouts[0].paneRect.w,
          topBarH,
          2,
          Math.max(0, cssH - topBarH)
        );
      } else {
        ctx.fillRect(
          0,
          layouts[0].paneRect.y + layouts[0].paneRect.h,
          cssW,
          2
        );
      }
    }

    for (let li = 0; li < layouts.length; li++) {
      const layout = layouts[li];
      const paneRx = layout.rx;
      const pane = frameState && frameState.panes ? frameState.panes[paneRx] : null;
      const rxA = snapshot.rxA || { freqHz: 14074000, mode: 6, dataSubMode: 0, bwHz: 2700, ifShiftHz: 1500 };
      const rxB = snapshot.rxB || { freqHz: 14025000, mode: 3, dataSubMode: 0, bwHz: 500, ifShiftHz: 500 };
      const primaryRxState = paneRx === 'B' ? rxB : rxA;

      const panCenterHz =
        pane && Number.isFinite(pane.panCenterHz)
          ? pane.panCenterHz
          : primaryRxState.panCenterHz || primaryRxState.freqHz;
      const userSpanHz =
        pane && Number.isFinite(pane.userSpanHz) && pane.userSpanHz > 0
          ? pane.userSpanHz
          : primaryRxState.panSpanHz || 48000;
      const refDbm =
        pane && Number.isFinite(pane.refDbm)
          ? pane.refDbm
          : Number.isFinite(primaryRxState.panRefDbm)
          ? primaryRxState.panRefDbm
          : -110;
      const scaleDb =
        pane && Number.isFinite(pane.scaleDb) && pane.scaleDb > 0
          ? pane.scaleDb
          : primaryRxState.panScaleDb || 80;

      const viewLeftHz = panCenterHz - userSpanHz * 0.5;
      const viewRightHz = panCenterHz + userSpanHz * 0.5;
      const minDbm = refDbm;
      const maxDbm = refDbm + scaleDb;

      const { paneRect, specRect, axisRect, wfRect } = layout;

      // 1. Spectrum Grid & Labels
      ctx.save();
      ctx.beginPath();
      ctx.rect(specRect.x, specRect.y, specRect.w, specRect.h);
      ctx.clip();

      const dbStep = scaleDb > 95 ? 20 : 10;
      const firstDb = Math.ceil(minDbm / dbStep) * dbStep;
      ctx.font = '10px ' + monoFont;
      ctx.textBaseline = 'middle';

      for (let db = firstDb; db <= maxDbm - 1; db += dbStep) {
        const yNorm = (maxDbm - db) / scaleDb;
        const y = Math.round(specRect.y + yNorm * specRect.h) + 0.5;
        if (y < specRect.y + 8 || y > specRect.y + specRect.h - 6) continue;

        ctx.strokeStyle = 'rgba(148, 163, 184, 0.11)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(specRect.x, y);
        ctx.lineTo(specRect.x + specRect.w, y);
        ctx.stroke();

        ctx.fillStyle = 'rgba(148, 163, 184, 0.72)';
        ctx.textAlign = 'left';
        ctx.fillText(db + ' dBm', specRect.x + 6, y);

        if (K4.SpectrumScale) {
          const su = K4.SpectrumScale.sUnitForDbm(db);
          ctx.fillStyle = 'rgba(100, 116, 139, 0.75)';
          ctx.textAlign = 'right';
          ctx.fillText(su.label, specRect.x + specRect.w - 6, y);
        }
      }

      // Noise floor indicator line
      if (pane && Number.isFinite(pane.noiseFloorDbm)) {
        const nfNorm = (maxDbm - pane.noiseFloorDbm) / scaleDb;
        if (nfNorm > 0.05 && nfNorm < 0.96) {
          const nfY = Math.round(specRect.y + nfNorm * specRect.h) + 0.5;
          ctx.save();
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(specRect.x, nfY);
          ctx.lineTo(specRect.x + specRect.w, nfY);
          ctx.stroke();
          ctx.restore();
        }
      }

      // Vertical frequency gridlines
      const tickStepHz = pickNiceTickStepHz(userSpanHz, specRect.w);
      const firstTickHz = Math.ceil(viewLeftHz / tickStepHz) * tickStepHz;
      const ticks = [];
      for (let f = firstTickHz; f <= viewRightHz; f += tickStepHz) {
        const x = K4.SpectrumGeometry.xFromRfFreq(
          f,
          specRect.x,
          specRect.w,
          panCenterHz,
          userSpanHz
        );
        ticks.push({ freqHz: f, x });
        const xSnap = Math.round(x) + 0.5;
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.09)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(xSnap, specRect.y);
        ctx.lineTo(xSnap, specRect.y + specRect.h);
        ctx.stroke();
      }

      // Peak-hold hairline
      if (frameState && frameState.peakHold && pane && pane.binsReady && pane.peakDbm) {
        const peakBins = pane.peakDbm;
        const n = peakBins.length;
        const crop = K4.SpectrumGeometry.computeViewportCrop(
          panCenterHz,
          userSpanHz,
          pane.streamCenterHz,
          pane.tierKHz
        );
        ctx.strokeStyle = 'rgba(248, 250, 252, 0.48)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
          const uTier = i / (n - 1);
          const uView = (uTier - crop.leftRatio) / crop.spanRatio;
          if (uView < -0.02 || uView > 1.02) continue;
          const x = specRect.x + uView * specRect.w;
          const yNorm = clamp((maxDbm - peakBins[i]) / scaleDb, 0, 1);
          const y = specRect.y + yNorm * specRect.h;
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      }

      // Passband curtains & Manual Notch & Needles
      const vfosToDraw = [];
      if (dualPanMode === 2) {
        if (paneRx === 'A') {
          vfosToDraw.push({ key: 'A', state: rxA, color: '#38BDF8', fill: 'rgba(56, 189, 248, 0.18)', edge: 'rgba(56, 189, 248, 0.72)', showCurtain: true, primary: true });
          if (subRxEnabled) {
            vfosToDraw.push({ key: 'B', state: rxB, color: '#22C55E', fill: 'rgba(34, 197, 94, 0.14)', edge: 'rgba(34, 197, 94, 0.68)', showCurtain: true, primary: false });
          }
        } else {
          vfosToDraw.push({ key: 'B', state: rxB, color: '#22C55E', fill: 'rgba(34, 197, 94, 0.16)', edge: 'rgba(34, 197, 94, 0.72)', showCurtain: true, primary: true });
        }
      } else {
        vfosToDraw.push({
          key: 'A',
          state: rxA,
          color: '#38BDF8',
          fill: 'rgba(56, 189, 248, 0.18)',
          edge: 'rgba(56, 189, 248, 0.72)',
          showCurtain: true,
          primary: targetRx !== 'B',
        });
        const hideBOnPortraitMobile =
          isPortraitMobile && paneRx === 'A' && !subRxEnabled && targetRx !== 'B';
        const showBCurtain =
          !hideBOnPortraitMobile && (subRxEnabled || targetRx === 'B');
        const showBNeedle =
          !hideBOnPortraitMobile &&
          (subRxEnabled ||
            splitEnabled ||
            targetRx === 'B' ||
            (rxB.freqHz >= viewLeftHz && rxB.freqHz <= viewRightHz));
        if (showBNeedle) {
          vfosToDraw.push({
            key: 'B',
            state: rxB,
            color: '#22C55E',
            fill: 'rgba(34, 197, 94, 0.14)',
            edge: 'rgba(34, 197, 94, 0.68)',
            showCurtain: showBCurtain,
            primary: targetRx === 'B',
          });
        }
      }

      const occupiedBoxes = [];
      for (let vi = 0; vi < vfosToDraw.length; vi++) {
        const vfo = vfosToDraw[vi];
        const pb = K4.SpectrumGeometry.computePassbandRange(vfo.state, cwPitchHz);
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

        if (vfo.showCurtain && highX >= specRect.x && lowX <= specRect.x + specRect.w) {
          const leftClamped = Math.max(specRect.x, lowX);
          const rightClamped = Math.min(specRect.x + specRect.w, highX);
          const curW = Math.max(1, rightClamped - leftClamped);
          ctx.fillStyle = vfo.fill;
          ctx.fillRect(leftClamped, specRect.y, curW, specRect.h);

          const edgeHint = hover && hover.edgeHint;
          const lowHovered = edgeHint && edgeHint.rx === vfo.key && edgeHint.edge === 'low';
          const highHovered = edgeHint && edgeHint.rx === vfo.key && edgeHint.edge === 'high';

          ctx.lineWidth = lowHovered ? 2.2 : 1;
          ctx.strokeStyle = lowHovered ? '#F8FAFC' : vfo.edge;
          ctx.beginPath();
          ctx.moveTo(Math.round(lowX) + 0.5, specRect.y);
          ctx.lineTo(Math.round(lowX) + 0.5, specRect.y + specRect.h);
          ctx.stroke();

          ctx.lineWidth = highHovered ? 2.2 : 1;
          ctx.strokeStyle = highHovered ? '#F8FAFC' : vfo.edge;
          ctx.beginPath();
          ctx.moveTo(Math.round(highX) + 0.5, specRect.y);
          ctx.lineTo(Math.round(highX) + 0.5, specRect.y + specRect.h);
          ctx.stroke();
        }

        // Manual notch vertical marker
        const notchRf = computeNotchRfHz(vfo.state);
        if (notchRf !== null && notchRf >= viewLeftHz && notchRf <= viewRightHz) {
          const nx =
            Math.round(
              K4.SpectrumGeometry.xFromRfFreq(
                notchRf,
                specRect.x,
                specRect.w,
                panCenterHz,
                userSpanHz
              )
            ) + 0.5;
          ctx.save();
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = '#F43F5E';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(nx, specRect.y + 16);
          ctx.lineTo(nx, specRect.y + specRect.h);
          ctx.stroke();
          ctx.restore();

          ctx.fillStyle = '#F43F5E';
          ctx.font = 'bold 9px ' + monoFont;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText('N', nx, specRect.y + 4);
        }

        // VFO needle & pill flag
        const markerHz = K4.SpectrumGeometry.displayMarkerHz(vfo.state, cwPitchHz);
        const lockSuffix = vfo.state && vfo.state.locked ? ' LOCK' : '';
        if (markerHz >= viewLeftHz && markerHz <= viewRightHz) {
          const mx = K4.SpectrumGeometry.xFromRfFreq(
            markerHz,
            specRect.x,
            specRect.w,
            panCenterHz,
            userSpanHz
          );
          ctx.strokeStyle = vfo.color;
          ctx.lineWidth = vfo.primary ? 1.8 : 1.3;
          ctx.beginPath();
          ctx.moveTo(mx, specRect.y);
          ctx.lineTo(mx, specRect.y + specRect.h);
          ctx.stroke();

          const isNarrowSpec = specRect.w < 460;
          const pillText =
            (!isNarrowSpec
              ? vfo.key + ' ' + K4.formatFreqMHz(vfo.state.freqHz)
              : vfo.key) + lockSuffix;
          ctx.font = 'bold 10px ' + monoFont;
          const textW = ctx.measureText(pillText).width;
          const pillW = isNarrowSpec ? Math.max(22, textW + 12) : textW + 10;
          const pillH = isNarrowSpec ? 18 : 16;
          const pillX = clamp(
            mx - pillW / 2,
            specRect.x + 4,
            specRect.x + specRect.w - pillW - 4
          );
          const pillY =
            vfo.key === 'B' && vfosToDraw.length > 1
              ? specRect.y + 27
              : specRect.y + 5;

          const isPillHighlighted = Boolean(
            (frameState && frameState.dragVfoRx === vfo.key) ||
              (hover && hover.vfoPillRx === vfo.key)
          );

          drawRoundedPill(ctx, pillX, pillY, pillW, pillH, 4);
          ctx.fillStyle = vfo.color;
          ctx.fill();
          if (isPillHighlighted) {
            ctx.strokeStyle = '#F8FAFC';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
          ctx.fillStyle = '#090B10';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(pillText, pillX + pillW / 2, pillY + pillH / 2 + 0.5);
          occupiedBoxes.push({ x: pillX, y: pillY, w: pillW, h: pillH });
          if (Array.isArray(vfoPillBoxes)) {
            vfoPillBoxes.push({
              rx: vfo.key,
              paneRx,
              x: pillX,
              y: pillY,
              w: pillW,
              h: pillH,
              mx,
              markerHz,
              freqHz: vfo.state.freqHz,
            });
          }
        } else if (vfo.primary || subRxEnabled) {
          // Off-screen VFO direction badge
          const isLeft = markerHz < viewLeftHz;
          const badge = (isLeft ? '◀ ' : '') + vfo.key + lockSuffix + (isLeft ? '' : ' ▶');
          ctx.font = 'bold 10px ' + monoFont;
          const bw = ctx.measureText(badge).width + 10;
          const bx = isLeft ? specRect.x + 6 : specRect.x + specRect.w - bw - 6;
          const by = vfo.key === 'B' ? specRect.y + 27 : specRect.y + 6;
          drawRoundedPill(ctx, bx, by, bw, 16, 4);
          ctx.fillStyle = 'rgba(14, 19, 29, 0.88)';
          ctx.fill();
          ctx.strokeStyle = vfo.color;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.fillStyle = vfo.color;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(badge, bx + bw / 2, by + 8.5);
          occupiedBoxes.push({ x: bx, y: by, w: bw, h: 16 });
        }

        // RIT RX offset marker & badge when active
        if (vfo.state && vfo.state.ritOn && vfo.state.ritOffsetHz) {
          const ritHz = K4.SpectrumGeometry.displayMarkerHz(
            Object.assign({}, vfo.state, {
              freqHz: (vfo.state.freqHz || 0) + (vfo.state.ritOffsetHz || 0),
            }),
            cwPitchHz
          );
          if (ritHz >= viewLeftHz && ritHz <= viewRightHz) {
            const rxX = K4.SpectrumGeometry.xFromRfFreq(
              ritHz,
              specRect.x,
              specRect.w,
              panCenterHz,
              userSpanHz
            );
            ctx.save();
            ctx.setLineDash([2, 3]);
            ctx.strokeStyle = '#A78BFA';
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.moveTo(rxX, specRect.y + 20);
            ctx.lineTo(rxX, specRect.y + specRect.h);
            ctx.stroke();
            ctx.restore();
            ctx.fillStyle = '#C4B5FD';
            ctx.font = 'bold 9px ' + monoFont;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText('RIT', rxX, specRect.y + 22);
          }
        }
      }

      // Compute top-right status pills first so TX badge avoids them, then draw TX overlay & pills
      const statusPills = layoutStatusPills(
        ctx,
        specRect,
        collectStatusPills(snapshot, primaryRxState),
        monoFont
      );
      for (let pi = 0; pi < statusPills.length; pi++) {
        occupiedBoxes.push(statusPills[pi]);
      }

      const txPosture = snapshot.txPosture || 'rx-only';
      const txSnap = Object.assign({}, snapshot, { rxA, rxB });
      const txOverlay =
        K4.SpectrumGeometry &&
        typeof K4.SpectrumGeometry.computeTxOverlay === 'function'
          ? K4.SpectrumGeometry.computeTxOverlay(txSnap)
          : null;
      const isLiveTx = Boolean(
        snapshot.txActive || snapshot.atuTuning || (txOverlay && txOverlay.active)
      );
      const txPinHz = drawTxOverlayOnSpectrum({
        ctx,
        specRect,
        paneRx,
        dualPanMode,
        panCenterHz,
        userSpanHz,
        viewLeftHz,
        viewRightHz,
        cwPitchHz,
        snapshot,
        rxA,
        rxB,
        txOverlay,
        txPosture,
        isLiveTx,
        occupiedBoxes,
        monoFont,
      });

      // Status pills (ADC Overflow / Pan Freeze / TX Inhibit / ATU Tune / TX Test)
      for (let pi = 0; pi < statusPills.length; pi++) {
        const p = statusPills[pi];
        ctx.font = p.font;
        drawRoundedPill(ctx, p.x, p.y, p.w, p.h, 4);
        ctx.fillStyle = p.fill;
        ctx.fill();
        if (p.stroke) {
          ctx.strokeStyle = p.stroke;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        ctx.fillStyle = p.textColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.text, p.x + p.w / 2, p.y + p.h / 2 + 0.5);
      }

      if (dualPanMode === 2) {
        const tag = paneRx === 'A' ? 'PAN A' : 'PAN B';
        const col = paneRx === 'A' ? '#38BDF8' : '#22C55E';
        ctx.font = 'bold 10px ' + sansFont;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = col;
        ctx.fillText(tag, specRect.x + 8, specRect.y + specRect.h - 20);
      }

      // K4-style lower-right A/B corner tab
      {
        const tabCol = paneRx === 'A' ? '#38BDF8' : '#22C55E';
        const tabX = specRect.x + specRect.w - 22;
        const tabY = specRect.y + specRect.h - 19;
        drawRoundedPill(ctx, tabX, tabY, 16, 15, 3);
        ctx.fillStyle = 'rgba(14, 19, 29, 0.86)';
        ctx.fill();
        ctx.strokeStyle = tabCol;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.font = 'bold 9.5px ' + monoFont;
        ctx.fillStyle = tabCol;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(paneRx, tabX + 8, tabY + 8);
      }

      // Dedicated lower-spectrum lane for saved frequency bookmark pins & labels (never overlaps kHz axis)
      {
        const bookmarks = (frameState && frameState.bookmarks) || [];
        const maxRightX = specRect.x + specRect.w - 28;
        let lastBmLabelRight = -1e9;
        for (let bi = 0; bi < bookmarks.length; bi++) {
          const bm = bookmarks[bi];
          if (!bm || bm.freqHz < viewLeftHz || bm.freqHz > viewRightHz) continue;
          const bx = K4.SpectrumGeometry.xFromRfFreq(
            bm.freqHz,
            specRect.x,
            specRect.w,
            panCenterHz,
            userSpanHz
          );
          if (bx < specRect.x + 6 || bx > maxRightX) continue;
          ctx.fillStyle = '#FBBF24';
          ctx.beginPath();
          ctx.moveTo(bx, specRect.y + specRect.h - 1);
          ctx.lineTo(bx - 3.5, specRect.y + specRect.h - 7);
          ctx.lineTo(bx + 3.5, specRect.y + specRect.h - 7);
          ctx.closePath();
          ctx.fill();

          const shortLabel = String(bm.label || '').slice(0, 12);
          if (shortLabel) {
            ctx.font = 'bold 8.5px ' + sansFont;
            const lw = ctx.measureText(shortLabel).width;
            if (bx + 5 > lastBmLabelRight && bx + 9 + lw < maxRightX) {
              drawRoundedPill(ctx, bx + 4, specRect.y + specRect.h - 17, lw + 6, 12, 3);
              ctx.fillStyle = 'rgba(9, 11, 16, 0.82)';
              ctx.fill();
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.fillStyle = 'rgba(251, 191, 36, 0.94)';
              ctx.fillText(shortLabel, bx + 7, specRect.y + specRect.h - 11);
              lastBmLabelRight = bx + 14 + lw;
            }
          }
        }
      }

      // Spectrum -> Waterfall abutment hairline
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.24)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(specRect.x, specRect.y + specRect.h - 0.5);
      ctx.lineTo(specRect.x + specRect.w, specRect.y + specRect.h - 0.5);
      ctx.stroke();

      ctx.restore();

      // 2. Top-Edge 22px Frequency Axis & IARU Band-Plan Ribbon (K4 panadapter style)
      ctx.save();
      ctx.fillStyle = '#0B1019';
      ctx.fillRect(axisRect.x, axisRect.y, axisRect.w, axisRect.h);

      // 3px IARU Region 2 Band-Plan ribbon along bottom of top axis
      if (K4.BandPlan) {
        const segs = K4.BandPlan.getSegmentsInRange(viewLeftHz, viewRightHz);
        const ribbonY = axisRect.y + axisRect.h - 3;
        for (let si = 0; si < segs.length; si++) {
          const s = segs[si];
          const sx0 = clamp(
            K4.SpectrumGeometry.xFromRfFreq(
              s.startHz,
              axisRect.x,
              axisRect.w,
              panCenterHz,
              userSpanHz
            ),
            axisRect.x,
            axisRect.x + axisRect.w
          );
          const sx1 = clamp(
            K4.SpectrumGeometry.xFromRfFreq(
              s.endHz,
              axisRect.x,
              axisRect.w,
              panCenterHz,
              userSpanHz
            ),
            axisRect.x,
            axisRect.x + axisRect.w
          );
          const sw = sx1 - sx0;
          if (sw > 0.5) {
            ctx.globalAlpha = 0.85;
            ctx.fillStyle = s.color;
            ctx.fillRect(sx0, ribbonY, sw, 3);
            ctx.globalAlpha = 1;
            ctx.fillStyle = '#090B10';
            ctx.fillRect(sx0, ribbonY, 1, 3);
          }
        }
      }

      // Axis hairline
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(axisRect.x, axisRect.y + axisRect.h - 0.5);
      ctx.lineTo(axisRect.x + axisRect.w, axisRect.y + axisRect.h - 0.5);
      ctx.stroke();

      // kHz ticks & labels along top edge
      ctx.font = '10.5px ' + monoFont;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let ti = 0; ti < ticks.length; ti++) {
        const t = ticks[ti];
        if (t.x < axisRect.x + 22 || t.x > axisRect.x + axisRect.w - 22) continue;
        const tx = Math.round(t.x) + 0.5;
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.42)';
        ctx.beginPath();
        ctx.moveTo(tx, axisRect.y + axisRect.h - 7);
        ctx.lineTo(tx, axisRect.y + axisRect.h - 3);
        ctx.stroke();

        ctx.fillStyle = '#CBD5E1';
        ctx.fillText(formatAxisKHz(t.freqHz), t.x, axisRect.y + 9.5);
      }
      ctx.restore();

      // 3. Waterfall VFO Needle Hairlines (subtle guide through waterfall)
      if (wfRect.h > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(wfRect.x, wfRect.y, wfRect.w, wfRect.h);
        ctx.clip();
        for (let vi = 0; vi < vfosToDraw.length; vi++) {
          const vfo = vfosToDraw[vi];
          const markerHz = K4.SpectrumGeometry.displayMarkerHz(vfo.state, cwPitchHz);
          if (markerHz >= viewLeftHz && markerHz <= viewRightHz) {
            const mx = K4.SpectrumGeometry.xFromRfFreq(
              markerHz,
              wfRect.x,
              wfRect.w,
              panCenterHz,
              userSpanHz
            );
            ctx.strokeStyle =
              vfo.key === 'A'
                ? 'rgba(56, 189, 248, 0.34)'
                : 'rgba(34, 197, 94, 0.34)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(mx, wfRect.y);
            ctx.lineTo(mx, wfRect.y + wfRect.h);
            ctx.stroke();
          }
        }
        if (txPinHz !== null && txPinHz >= viewLeftHz && txPinHz <= viewRightHz) {
          const txWfX = K4.SpectrumGeometry.xFromRfFreq(
            txPinHz,
            wfRect.x,
            wfRect.w,
            panCenterHz,
            userSpanHz
          );
          ctx.save();
          if (!isLiveTx) ctx.setLineDash([3, 3]);
          ctx.strokeStyle = isLiveTx
            ? 'rgba(249, 115, 22, 0.78)'
            : 'rgba(251, 146, 60, 0.45)';
          ctx.lineWidth = isLiveTx ? 1.5 : 1;
          ctx.beginPath();
          ctx.moveTo(txWfX, wfRect.y);
          ctx.lineTo(txWfX, wfRect.y + wfRect.h);
          ctx.stroke();
          ctx.restore();
        }
        ctx.restore();

        // 3b. Draggable Spectrum / Waterfall Divider Border
        const dividerHot = Boolean(hover && hover.dividerRx === paneRx);
        const divY = Math.round(wfRect.y) + 0.5;
        ctx.save();
        ctx.strokeStyle = dividerHot
          ? 'rgba(56, 189, 248, 0.85)'
          : 'rgba(148, 163, 184, 0.22)';
        ctx.lineWidth = dividerHot ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(wfRect.x, divY);
        ctx.lineTo(wfRect.x + wfRect.w, divY);
        ctx.stroke();
        if (dividerHot) {
          const handleW = 36;
          const handleH = 4;
          const hx0 = Math.round(wfRect.x + (wfRect.w - handleW) * 0.5);
          const hy0 = Math.round(wfRect.y - handleH * 0.5);
          drawRoundedPill(ctx, hx0, hy0, handleW, handleH, 2);
          ctx.fillStyle = 'rgba(56, 189, 248, 0.95)';
          ctx.fill();
        }
        ctx.restore();
      }

      // 4. Interactive Hover Crosshair & Readout Pill
      if (hover && hover.active && hover.paneRx === paneRx && !hover.dividerRx) {
        const hx = clamp(hover.xPx, paneRect.x, paneRect.x + paneRect.w);
        const hy = clamp(hover.yPx, paneRect.y, paneRect.y + paneRect.h);

        ctx.save();
        ctx.beginPath();
        ctx.rect(paneRect.x, paneRect.y, paneRect.w, paneRect.h);
        ctx.clip();

        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(241, 245, 249, 0.36)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(hx) + 0.5, specRect.y);
        ctx.lineTo(Math.round(hx) + 0.5, wfRect.y + wfRect.h);
        if (hy >= specRect.y && hy <= specRect.y + specRect.h) {
          ctx.moveTo(specRect.x, Math.round(hy) + 0.5);
          ctx.lineTo(specRect.x + specRect.w, Math.round(hy) + 0.5);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        const rfHz = K4.SpectrumGeometry.rfFreqFromX(
          hx,
          specRect.x,
          specRect.w,
          panCenterHz,
          userSpanHz
        );
        const targetState =
          dualPanMode === 2
            ? paneRx === 'B'
              ? rxB
              : rxA
            : frameState.targetRx === 'B'
            ? rxB
            : rxA;
        const activeMarkerHz = K4.SpectrumGeometry.displayMarkerHz(
          targetState,
          cwPitchHz
        );
        const deltaKHz = (rfHz - activeMarkerHz) / 1000;
        const binDbm = sampleShownDbmAtFreq(pane, rfHz);
        const cursorDbm =
          hy >= specRect.y && hy <= specRect.y + specRect.h
            ? maxDbm - ((hy - specRect.y) / specRect.h) * scaleDb
            : null;
        const displayDbm = binDbm !== null ? binDbm : cursorDbm;
        const seg = K4.BandPlan ? K4.BandPlan.findSegmentAt(rfHz) : null;

        const line1 =
          K4.formatFreqMHz(rfHz) +
          ' MHz' +
          (displayDbm !== null ? '  |  ' + displayDbm.toFixed(1) + ' dBm' : '') +
          '  |  Δ ' +
          (deltaKHz >= 0 ? '+' : '') +
          deltaKHz.toFixed(2) +
          ' kHz';
        const line2 = seg ? seg.mode + ' · ' + seg.label : '';

        ctx.font = '11px ' + monoFont;
        const w1 = ctx.measureText(line1).width;
        ctx.font = '10.5px ' + sansFont;
        const w2 = line2 ? ctx.measureText(line2).width + 14 : 0;
        const boxW = Math.ceil(Math.max(w1, w2)) + 18;
        const boxH = line2 ? 40 : 24;

        let bx = hx + 12;
        if (bx + boxW > paneRect.x + paneRect.w - 8) {
          bx = hx - boxW - 12;
        }
        bx = clamp(bx, paneRect.x + 6, paneRect.x + paneRect.w - boxW - 6);

        let by = hy - boxH - 10;
        if (by < paneRect.y + 6) {
          by = hy + 14;
        }
        by = clamp(by, paneRect.y + 6, paneRect.y + paneRect.h - boxH - 6);

        drawRoundedPill(ctx, bx, by, boxW, boxH, 6);
        ctx.fillStyle = 'rgba(10, 14, 22, 0.90)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.font = '11px ' + monoFont;
        ctx.fillStyle = '#F1F5F9';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(line1, bx + 9, by + 6);

        if (line2) {
          ctx.fillStyle = seg.color;
          ctx.beginPath();
          ctx.arc(bx + 13, by + 28, 3.5, 0, Math.PI * 2);
          ctx.fill();

          ctx.font = '10.5px ' + sansFont;
          ctx.fillStyle = '#CBD5E1';
          ctx.fillText(line2, bx + 22, by + 22);
        }

        ctx.restore();
      }
    }

  }

  function isDocumentHidden() {
    return typeof document !== 'undefined' && document.hidden === true;
  }

  function minipanStorageKey(rx) {
    return rx === 'B' ? 'k4.minipan.pos.b' : 'k4.minipan.pos.a';
  }

  function readMiniPanPos(rx) {
    if (!K4.storage || typeof K4.storage.get !== 'function') return null;
    const val = K4.storage.get(minipanStorageKey(rx), null);
    if (!val || typeof val !== 'object') return null;
    if (!Number.isFinite(val.left) || !Number.isFinite(val.top)) return null;
    return { left: Math.round(val.left), top: Math.round(val.top) };
  }

  function writeMiniPanPos(rx, left, top) {
    if (!K4.storage || typeof K4.storage.set !== 'function') return;
    K4.storage.set(minipanStorageKey(rx), {
      left: Math.round(left),
      top: Math.round(top),
    });
  }

  function clearMiniPanPos(rx) {
    const key = minipanStorageKey(rx);
    if (K4.storage && typeof K4.storage.remove === 'function') {
      K4.storage.remove(key);
    } else if (K4.storage && typeof K4.storage.set === 'function') {
      K4.storage.set(key, null);
    }
  }

  function rxOverlaySignaturePart(rxState) {
    if (!rxState) return '';
    return [
      rxState.freqHz || 0,
      rxState.mode || 0,
      rxState.dataSubMode || 0,
      rxState.bwHz || 0,
      rxState.ifShiftHz || 0,
      Number.isFinite(rxState.filterLoHz) ? rxState.filterLoHz : '',
      Number.isFinite(rxState.filterHiHz) ? rxState.filterHiHz : '',
      rxState.locked ? 1 : 0,
      rxState.ritOn ? 1 : 0,
      rxState.ritOffsetHz || 0,
      rxState.notchOn ? 1 : 0,
      rxState.notchHz || 0,
      rxState.adcOverflow ? 1 : 0,
      rxState.panCenterHz || 0,
      rxState.panSpanHz || 0,
      rxState.panRefDbm || 0,
      rxState.panScaleDb || 0,
      rxState.panNbMode || 0,
    ].join(',');
  }

  function paneOverlaySignaturePart(pane, peakHold) {
    if (!pane) return '';
    return [
      pane.panCenterHz || 0,
      pane.userSpanHz || 0,
      pane.refDbm || 0,
      pane.scaleDb || 0,
      pane.streamCenterHz || 0,
      pane.tierKHz || 0,
      pane.binsReady ? 1 : 0,
      Number.isFinite(pane.noiseFloorDbm) ? Math.round(pane.noiseFloorDbm) : '',
      peakHold ? pane.binSeq || 0 : 0,
    ].join(',');
  }

  function computeOverlaySignature({
    frameState,
    layouts,
    cssW,
    cssH,
    dpr,
    hudTopInset,
    paletteName,
  }) {
    const snap = (frameState && frameState.snapshot) || {};
    const rxA = snap.rxA || {};
    const rxB = snap.rxB || {};
    const panes = (frameState && frameState.panes) || {};
    const dualPanMode = frameState ? frameState.dualPanMode : 0;
    const peakHold = Boolean(frameState && frameState.peakHold);
    const hover = frameState && frameState.hover;
    const theme =
      typeof document !== 'undefined' &&
      document.documentElement &&
      document.documentElement.dataset
        ? document.documentElement.dataset.theme || ''
        : '';

    const isPortraitMobile = isPortraitMobileViewport(cssW, cssH, frameState);

    let hoverPart = '0';
    if (hover && hover.active) {
      const hPane = panes[hover.paneRx];
      hoverPart = [
        hover.paneRx || 'A',
        Math.round(hover.xPx || 0),
        Math.round(hover.yPx || 0),
        hover.edgeHint ? (hover.edgeHint.rx || '') + ':' + (hover.edgeHint.edge || '') : '',
        hover.vfoPillRx || '',
        hover.dividerRx || '',
        hPane ? hPane.binSeq || 0 : 0,
      ].join(',');
    } else if (hover && hover.dividerRx) {
      hoverPart = 'div:' + hover.dividerRx;
    } else if (hover && hover.vfoPillRx) {
      hoverPart = 'pill:' + hover.vfoPillRx;
    }

    let bmPart = '';
    if (frameState && Number.isFinite(frameState.bookmarksRev)) {
      bmPart = String(frameState.bookmarksRev);
    } else if (frameState && Array.isArray(frameState.bookmarks)) {
      const bms = frameState.bookmarks;
      bmPart = String(bms.length);
      for (let i = 0; i < bms.length; i++) {
        bmPart += ';' + (bms[i].freqHz || 0) + ':' + (bms[i].label || '');
      }
    }

    const swrPart =
      snap.atuTuning && snap.txMeters && Number.isFinite(snap.txMeters.swr)
        ? snap.txMeters.swr.toFixed(1)
        : '';

    const needB = Boolean(
      snap.subRxEnabled ||
        snap.splitEnabled ||
        dualPanMode === 1 ||
        dualPanMode === 2 ||
        (frameState && (frameState.targetRx === 'B' || frameState.dragVfoRx === 'B')) ||
        !isPortraitMobile
    );

    let layoutPart = '';
    if (layouts) {
      for (let i = 0; i < layouts.length; i++) {
        const l = layouts[i];
        layoutPart +=
          l.rx +
          ':' +
          l.specRect.h +
          ':' +
          l.wfRect.h +
          (i < layouts.length - 1 ? '|' : '');
      }
    }

    return [
      cssW,
      cssH,
      dpr,
      hudTopInset,
      paletteName || '',
      theme,
      isPortraitMobile ? 1 : 0,
      dualPanMode,
      layoutPart,
      frameState && frameState.targetRx ? frameState.targetRx : 'A',
      peakHold ? 1 : 0,
      frameState && frameState.dragState ? frameState.dragState : '',
      frameState && frameState.dragVfoRx ? frameState.dragVfoRx : '',
      Number.isFinite(snap.cwPitchHz) ? snap.cwPitchHz : 500,
      snap.subRxEnabled ? 1 : 0,
      snap.splitEnabled ? 1 : 0,
      snap.xitEnabled ? 1 : 0,
      snap.txVfo || 'A',
      snap.txActive ? 1 : 0,
      snap.atuTuning ? 1 : 0,
      swrPart,
      snap.txPosture || 'rx-only',
      snap.txTestMode ? 1 : 0,
      snap.panFrozen ? 1 : 0,
      snap.txInhibit ? 1 : 0,
      Number.isFinite(snap.displayMode) ? snap.displayMode : 1,
      Number.isFinite(snap.waterfallHeightPct) ? snap.waterfallHeightPct : 62,
      bmPart,
      hoverPart,
      rxOverlaySignaturePart(rxA),
      needB ? rxOverlaySignaturePart(rxB) : '',
      paneOverlaySignaturePart(panes.A, peakHold),
      snap.subRxEnabled || snap.splitEnabled || dualPanMode === 1 || dualPanMode === 2
        ? paneOverlaySignaturePart(panes.B, peakHold)
        : '',
    ].join('#');
  }

  function drawMiniPanCanvas({
    canvas,
    ctx,
    cssW,
    cssH,
    dpr,
    rx,
    mp,
    rxState,
    cwPitchHz,
  }) {
    if (!canvas || !ctx || cssW <= 0 || cssH <= 0) return;

    const targetW = Math.max(1, Math.round(cssW * dpr));
    const targetH = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    ctx.fillStyle = '#090B10';
    ctx.fillRect(0, 0, cssW, cssH);

    const accent = rx === 'B' ? '#22C55E' : '#38BDF8';
    const accentSoft =
      rx === 'B' ? 'rgba(34, 197, 94, 0.22)' : 'rgba(56, 189, 248, 0.22)';
    const spanKHz = (mp && mp.spanKHz) || 10;
    const spanHz = spanKHz * 1000;
    const centerHz =
      (mp && Number.isFinite(mp.centerFreqHz) ? mp.centerFreqHz : null) ||
      K4.SpectrumGeometry.displayMarkerHz(rxState, cwPitchHz);

    const padX = 6;
    const plotY = 4;
    const padBottom = cssH < 66 ? 13 : 15;
    const plotW = Math.max(20, cssW - padX * 2);
    const plotH = Math.max(16, cssH - plotY - padBottom);

    const refDbm = Number.isFinite(rxState.panRefDbm) ? rxState.panRefDbm : -110;
    const scaleDb = Math.max(10, Number.isFinite(rxState.panScaleDb) ? rxState.panScaleDb : 80);
    const maxDbm = refDbm + scaleDb;

    // Grid
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
    ctx.lineWidth = 1;
    for (let k = 1; k <= 3; k++) {
      const gy = Math.round(plotY + (plotH * k) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padX, gy);
      ctx.lineTo(padX + plotW, gy);
      ctx.stroke();
    }

    // Passband curtain & marker needle
    const pb = K4.SpectrumGeometry.computePassbandRange(rxState, cwPitchHz);
    const lowX = K4.SpectrumGeometry.xFromRfFreq(pb.lowHz, padX, plotW, centerHz, spanHz);
    const highX = K4.SpectrumGeometry.xFromRfFreq(pb.highHz, padX, plotW, centerHz, spanHz);
    const cLeft = clamp(lowX, padX, padX + plotW);
    const cRight = clamp(highX, padX, padX + plotW);
    if (cRight > cLeft) {
      ctx.fillStyle = accentSoft;
      ctx.fillRect(cLeft, plotY, cRight - cLeft, plotH);
    }

    const markerHz = K4.SpectrumGeometry.displayMarkerHz(rxState, cwPitchHz);
    const mx = K4.SpectrumGeometry.xFromRfFreq(markerHz, padX, plotW, centerHz, spanHz);
    if (mx >= padX && mx <= padX + plotW) {
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(mx, plotY);
      ctx.lineTo(mx, plotY + plotH);
      ctx.stroke();
    }

    // Spectrum trace
    const bins = mp && mp.dbmBins;
    if (bins && bins.length >= 2) {
      const n = bins.length;
      ctx.save();
      ctx.beginPath();
      ctx.rect(padX, plotY, plotW, plotH);
      ctx.clip();

      const grad = ctx.createLinearGradient(0, plotY, 0, plotY + plotH);
      grad.addColorStop(
        0,
        rx === 'B' ? 'rgba(34, 197, 94, 0.42)' : 'rgba(56, 189, 248, 0.42)'
      );
      grad.addColorStop(1, 'rgba(9, 11, 16, 0.02)');

      ctx.beginPath();
      ctx.moveTo(padX, plotY + plotH);
      for (let i = 0; i < n; i++) {
        const x = padX + (i / (n - 1)) * plotW;
        const yNorm = clamp((maxDbm - bins[i]) / scaleDb, 0, 1);
        const y = plotY + yNorm * plotH;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(padX + plotW, plotY + plotH);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = padX + (i / (n - 1)) * plotW;
        const yNorm = clamp((maxDbm - bins[i]) / scaleDb, 0, 1);
        const y = plotY + yNorm * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.font = '10px ' + MONO_FONT;
      ctx.fillStyle = '#64748B';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Awaiting #MP stream…', cssW / 2, plotY + plotH / 2);
    }

    // Center frequency footer
    ctx.font = '9.5px ' + MONO_FONT;
    ctx.fillStyle = '#94A3B8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(K4.formatFreqMHz(centerHz) + ' MHz', cssW / 2, cssH - 2);
  }

  class MiniPanBoxController {
    constructor(surface, rx, opts = {}) {
      this.surface = surface;
      this.rx = rx === 'B' ? 'B' : 'A';
      this._onClose = typeof opts.onClose === 'function' ? opts.onClose : null;
      this._onBringToFront =
        typeof opts.onBringToFront === 'function' ? opts.onBringToFront : null;
      this._destroyed = false;

      const box = document.createElement('div');
      box.className = 'k4-minipan-box';
      box.dataset.rx = this.rx;
      box.dataset.testid = this.rx === 'B' ? 'minipan-box-b' : 'minipan-box-a';
      box.dataset.dragging = 'false';
      box.style.display = 'none';
      box.setAttribute('aria-label', 'Mini-Pan ' + this.rx);

      const header = document.createElement('div');
      header.className = 'k4-minipan-header k4-minipan-drag';
      header.dataset.testid = this.rx === 'B' ? 'minipan-drag-b' : 'minipan-drag-a';
      header.title = 'Drag to move Mini-Pan ' + this.rx + ' · Double-click to reset';

      const titleEl = document.createElement('span');
      titleEl.className = 'k4-minipan-title';
      titleEl.textContent = 'Mini-Pan ' + this.rx;

      const spanEl = document.createElement('span');
      spanEl.className = 'k4-minipan-span';
      spanEl.textContent = '10 kHz';

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'k4-minipan-close';
      closeBtn.dataset.testid = this.rx === 'B' ? 'minipan-close-b' : 'minipan-close-a';
      closeBtn.setAttribute('aria-label', 'Close Mini-Pan ' + this.rx);
      closeBtn.textContent = '×';

      header.appendChild(titleEl);
      header.appendChild(spanEl);
      header.appendChild(closeBtn);

      const canvas = document.createElement('canvas');
      canvas.className = 'k4-minipan-canvas';
      canvas.dataset.testid = this.rx === 'B' ? 'minipan-canvas-b' : 'minipan-canvas-a';

      box.appendChild(header);
      box.appendChild(canvas);
      surface.appendChild(box);

      this.box = box;
      this.header = header;
      this.titleEl = titleEl;
      this.spanEl = spanEl;
      this.closeBtn = closeBtn;
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: true });

      this._customPos = readMiniPanPos(this.rx);
      box.dataset.docked = this._customPos ? 'false' : 'true';
      this._visible = false;
      this._lastCanvasSig = null;
      this._lastSpanText = '10 kHz';
      this._lastStyleKey = '';
      this._bounds = { cssW: 0, cssH: 0, hudTopInset: 0 };
      this._rect = { left: 0, top: 0, w: 208, h: 120 };
      this._dragState = null;
      this._snapTimer = null;

      this._bindEvents();
    }

    _clampPos(rawLeft, rawTop, boxW, boxH, bounds) {
      const cssW = bounds && bounds.cssW > 0 ? bounds.cssW : this.surface.clientWidth || 800;
      const cssH = bounds && bounds.cssH > 0 ? bounds.cssH : this.surface.clientHeight || 400;
      const topInset =
        bounds && Number.isFinite(bounds.hudTopInset) ? Math.max(0, bounds.hudTopInset) : 0;

      const minLeft = cssW >= boxW + 12 ? 6 : Math.max(0, Math.floor((cssW - boxW) * 0.5));
      const maxLeft = Math.max(minLeft, cssW - boxW - 6);
      const maxTop = Math.max(0, cssH - boxH - 6);
      const desiredMinTop = Math.max(6, Math.round(topInset) + 4);
      const minTop = Math.min(desiredMinTop, maxTop);

      return {
        left: Math.round(clamp(rawLeft, minLeft, maxLeft)),
        top: Math.round(clamp(rawTop, minTop, maxTop)),
      };
    }

    _computeBoxGeometry(layout, bounds, dualPanMode, subRxEnabled, avoidRect) {
      const cssW = bounds.cssW || 800;
      const cssH = bounds.cssH || 400;
      const paneRect =
        layout && layout.paneRect ? layout.paneRect : { x: 0, y: 0, w: cssW, h: cssH };
      const specRect =
        layout && layout.specRect ? layout.specRect : { x: 0, y: 0, w: cssW, h: Math.max(120, cssH - 26) };

      const isCompact = cssW < 640 || paneRect.w < 440;
      const twoVfosInPane = dualPanMode !== 2 && subRxEnabled;
      const leftClear = isCompact ? 42 : 56;
      const rightClear = isCompact ? 34 : 42;
      const sideClear = this.rx === 'B' ? rightClear : leftClear;
      const vfoClear = dualPanMode === 2 ? 22 : twoVfosInPane ? 40 : 24;

      const maxBoxW = Math.max(
        136,
        Math.min(212, Math.floor(paneRect.w - sideClear - 16))
      );
      const boxW = isCompact
        ? clamp(maxBoxW, 136, 178)
        : clamp(maxBoxW, 168, 212);
      const availH = Math.max(76, specRect.h - vfoClear - 6);
      const idealH = Math.round(boxW * 0.58) + MINIPAN_HEADER_H;
      const boxH = clamp(
        idealH,
        Math.min(82, availH),
        Math.min(134, availH)
      );

      let defaultLeft =
        this.rx === 'B'
          ? Math.round(Math.max(paneRect.x + 6, paneRect.x + paneRect.w - rightClear - boxW))
          : Math.round(
              Math.min(
                paneRect.x + leftClear,
                Math.max(paneRect.x + 6, paneRect.x + paneRect.w - boxW - 6)
              )
            );
      let defaultTop = Math.round(specRect.y + vfoClear);

      if (avoidRect && avoidRect.w > 0 && avoidRect.h > 0) {
        const horizOverlap =
          defaultLeft < avoidRect.left + avoidRect.w + 8 &&
          defaultLeft + boxW + 8 > avoidRect.left;
        const vertOverlap =
          defaultTop < avoidRect.top + avoidRect.h + 8 &&
          defaultTop + boxH + 8 > avoidRect.top;
        if (horizOverlap && vertOverlap) {
          const belowTop = avoidRect.top + avoidRect.h + 8;
          if (belowTop + boxH <= specRect.y + specRect.h - 4) {
            defaultTop = belowTop;
          } else if (this.rx === 'B') {
            defaultLeft = Math.min(
              paneRect.x + paneRect.w - boxW - 6,
              avoidRect.left + avoidRect.w + 8
            );
          } else {
            defaultLeft = Math.max(paneRect.x + 6, avoidRect.left - boxW - 8);
          }
        }
      }

      const docked = this._clampPos(defaultLeft, defaultTop, boxW, boxH, bounds);
      return {
        boxW,
        boxH,
        defaultLeft: docked.left,
        defaultTop: docked.top,
      };
    }

    _applyPositionDom(left, top, boxW, boxH, docked) {
      this._rect.left = left;
      this._rect.top = top;
      this._rect.w = boxW;
      this._rect.h = boxH;

      const key = left + '|' + top + '|' + boxW + '|' + boxH + '|' + (docked ? 1 : 0);
      if (key === this._lastStyleKey && this._visible) return;
      this._lastStyleKey = key;

      this.box.style.display = 'flex';
      this.box.style.right = 'auto';
      this.box.style.left = left + 'px';
      this.box.style.top = top + 'px';
      this.box.style.width = boxW + 'px';
      this.box.style.height = boxH + 'px';
      this.box.dataset.docked = docked ? 'true' : 'false';
      this._visible = true;
    }

    clampToBounds(bounds) {
      if (bounds) {
        this._bounds = {
          cssW: bounds.cssW || 0,
          cssH: bounds.cssH || 0,
          hudTopInset: bounds.hudTopInset || 0,
        };
      }
      if (!this._visible) return;
      const boxW = this._rect.w || 208;
      const boxH = this._rect.h || 120;
      const rawLeft = this._customPos ? this._customPos.left : this._rect.left;
      const rawTop = this._customPos ? this._customPos.top : this._rect.top;
      const clamped = this._clampPos(rawLeft, rawTop, boxW, boxH, this._bounds);
      this._applyPositionDom(clamped.left, clamped.top, boxW, boxH, !this._customPos);
    }

    _bindEvents() {
      const stopOnly = (e) => {
        e.stopPropagation();
      };
      const stopAndPrevent = (e) => {
        e.preventDefault();
        e.stopPropagation();
      };

      const isoEvents = [
        'pointerdown',
        'pointermove',
        'pointerup',
        'pointercancel',
        'mousedown',
        'mouseup',
        'click',
        'dblclick',
        'auxclick',
      ];
      for (let i = 0; i < isoEvents.length; i++) {
        this.box.addEventListener(isoEvents[i], stopOnly);
      }
      this.box.addEventListener('wheel', stopAndPrevent, { passive: false });
      this.box.addEventListener('contextmenu', stopAndPrevent);

      this.closeBtn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
      });
      this.closeBtn.addEventListener('mousedown', (e) => {
        e.stopPropagation();
      });
      this.closeBtn.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      this.closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this._onClose) this._onClose(this.rx);
      });

      this._onDragMove = (e) => {
        if (!this._dragState) return;
        if (this._dragState.isPointer) {
          if (
            e.pointerId !== undefined &&
            this._dragState.pointerId !== null &&
            e.pointerId !== this._dragState.pointerId
          ) {
            return;
          }
          if (e.type === 'mousemove') return;
        }
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
        const dx = e.clientX - this._dragState.startClientX;
        const dy = e.clientY - this._dragState.startClientY;
        if (!this._dragState.moved) {
          if (dx === 0 && dy === 0) return;
          this._dragState.moved = true;
          this.box.dataset.dragging = 'true';
          this.box.dataset.docked = 'false';
        }
        const next = this._clampPos(
          this._dragState.startLeft + dx,
          this._dragState.startTop + dy,
          this._rect.w,
          this._rect.h,
          this._bounds
        );
        this._customPos = { left: next.left, top: next.top };
        this._applyPositionDom(next.left, next.top, this._rect.w, this._rect.h, false);
      };

      this._onDragEnd = (e) => {
        if (!this._dragState) return;
        if (this._dragState.isPointer) {
          if (
            e.pointerId !== undefined &&
            this._dragState.pointerId !== null &&
            e.pointerId !== this._dragState.pointerId
          ) {
            return;
          }
          if (e.type === 'mouseup') return;
        }
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
        const st = this._dragState;
        this._dragState = null;
        this.box.dataset.dragging = 'false';

        if (st.pointerId !== null && typeof this.header.releasePointerCapture === 'function') {
          try {
            if (
              typeof this.header.hasPointerCapture === 'function' &&
              this.header.hasPointerCapture(st.pointerId)
            ) {
              this.header.releasePointerCapture(st.pointerId);
            }
          } catch (_err) {
            // Ignore release failures when pointer capture was synthetic
          }
        }
        this._detachWindowDragListeners();

        if (st.moved || this._customPos !== null) {
          const next = this._clampPos(
            this._customPos ? this._customPos.left : this._rect.left,
            this._customPos ? this._customPos.top : this._rect.top,
            this._rect.w,
            this._rect.h,
            this._bounds
          );
          this._customPos = { left: next.left, top: next.top };
          writeMiniPanPos(this.rx, next.left, next.top);
          this._applyPositionDom(next.left, next.top, this._rect.w, this._rect.h, false);
        }
      };

      const startDrag = (e) => {
        if (e.target && typeof e.target.closest === 'function' && e.target.closest('.k4-minipan-close')) {
          return;
        }
        if (e.button !== undefined && e.button !== 0 && e.pointerType !== 'touch') {
          return;
        }
        if (this._dragState) return;

        e.preventDefault();
        e.stopPropagation();

        if (this._snapTimer) {
          clearTimeout(this._snapTimer);
          this._snapTimer = null;
          delete this.box.dataset.snapping;
        }

        if (this._onBringToFront) this._onBringToFront(this.rx);

        const isPointer = e.type === 'pointerdown' && e.pointerId !== undefined;
        const pointerId = isPointer ? e.pointerId : null;
        this._dragState = {
          isPointer,
          pointerId,
          startClientX: e.clientX || 0,
          startClientY: e.clientY || 0,
          startLeft: this._rect.left,
          startTop: this._rect.top,
          moved: false,
        };
        if (this._customPos !== null) {
          this.box.dataset.dragging = 'true';
        }

        if (pointerId !== null && typeof this.header.setPointerCapture === 'function') {
          try {
            this.header.setPointerCapture(pointerId);
          } catch (_err) {
            // Ignore synthetic pointers without active browser capture id
          }
        }
        this._attachWindowDragListeners();
      };

      this.header.addEventListener('pointerdown', startDrag);
      this.header.addEventListener('mousedown', startDrag);

      this.header.addEventListener('dblclick', (e) => {
        if (e.target && typeof e.target.closest === 'function' && e.target.closest('.k4-minipan-close')) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();

        this._customPos = null;
        clearMiniPanPos(this.rx);
        this.box.dataset.docked = 'true';
        this.box.dataset.snapping = 'true';
        if (this._snapTimer) clearTimeout(this._snapTimer);
        this._snapTimer = setTimeout(() => {
          this._snapTimer = null;
          if (!this._destroyed && this.box) {
            delete this.box.dataset.snapping;
          }
        }, 180);

        if (this._lastDockPos) {
          const clamped = this._clampPos(
            this._lastDockPos.left,
            this._lastDockPos.top,
            this._rect.w,
            this._rect.h,
            this._bounds
          );
          this._applyPositionDom(clamped.left, clamped.top, this._rect.w, this._rect.h, true);
        }
      });
    }

    _attachWindowDragListeners() {
      if (typeof globalThis.addEventListener !== 'function') return;
      globalThis.addEventListener('pointermove', this._onDragMove, true);
      globalThis.addEventListener('pointerup', this._onDragEnd, true);
      globalThis.addEventListener('pointercancel', this._onDragEnd, true);
      globalThis.addEventListener('mousemove', this._onDragMove, true);
      globalThis.addEventListener('mouseup', this._onDragEnd, true);
    }

    _detachWindowDragListeners() {
      if (typeof globalThis.removeEventListener !== 'function') return;
      globalThis.removeEventListener('pointermove', this._onDragMove, true);
      globalThis.removeEventListener('pointerup', this._onDragEnd, true);
      globalThis.removeEventListener('pointercancel', this._onDragEnd, true);
      globalThis.removeEventListener('mousemove', this._onDragMove, true);
      globalThis.removeEventListener('mouseup', this._onDragEnd, true);
    }

    update({
      visible,
      bounds,
      dpr,
      layout,
      avoidRect,
      snapshot,
      mp,
      frameState,
    }) {
      if (this._destroyed) return null;
      if (bounds) {
        this._bounds = {
          cssW: bounds.cssW || 0,
          cssH: bounds.cssH || 0,
          hudTopInset: bounds.hudTopInset || 0,
        };
      }

      if (!visible) {
        if (this._visible || this.box.style.display !== 'none') {
          this.box.style.display = 'none';
          this._visible = false;
          this._lastStyleKey = '';
          this._lastCanvasSig = null;
        }
        return null;
      }

      const dualPanMode = frameState ? frameState.dualPanMode : 0;
      const subRxEnabled = Boolean(snapshot && snapshot.subRxEnabled);
      const geom = this._computeBoxGeometry(
        layout,
        this._bounds,
        dualPanMode,
        subRxEnabled,
        avoidRect
      );
      this._lastDockPos = { left: geom.defaultLeft, top: geom.defaultTop };

      const targetPos = this._customPos
        ? this._clampPos(
            this._customPos.left,
            this._customPos.top,
            geom.boxW,
            geom.boxH,
            this._bounds
          )
        : { left: geom.defaultLeft, top: geom.defaultTop };

      this._applyPositionDom(
        targetPos.left,
        targetPos.top,
        geom.boxW,
        geom.boxH,
        !this._customPos
      );

      const rxState =
        this.rx === 'B'
          ? (snapshot && snapshot.rxB) || {}
          : (snapshot && snapshot.rxA) || {};
      const cwPitchHz =
        snapshot && Number.isFinite(snapshot.cwPitchHz) ? snapshot.cwPitchHz : 500;
      const spanKHz = (mp && mp.spanKHz) || 10;
      const spanText = spanKHz + ' kHz';
      if (spanText !== this._lastSpanText) {
        this._lastSpanText = spanText;
        this.spanEl.textContent = spanText;
      }

      const canvasW = Math.max(24, geom.boxW - 2);
      const canvasH = Math.max(24, geom.boxH - 2 - MINIPAN_HEADER_H);
      const centerHz =
        (mp && Number.isFinite(mp.centerFreqHz) ? mp.centerFreqHz : null) ||
        K4.SpectrumGeometry.displayMarkerHz(rxState, cwPitchHz);

      const mpSig = [
        dpr,
        canvasW,
        canvasH,
        centerHz,
        spanKHz,
        mp ? mp.seq || 0 : 0,
        mp && mp.dbmBins ? mp.dbmBins.length : 0,
        rxState.freqHz || 0,
        rxState.mode || 0,
        rxState.dataSubMode || 0,
        rxState.bwHz || 0,
        rxState.ifShiftHz || 0,
        Number.isFinite(rxState.panRefDbm) ? rxState.panRefDbm : -110,
        Number.isFinite(rxState.panScaleDb) ? rxState.panScaleDb : 80,
        cwPitchHz,
      ].join('|');

      if (mpSig !== this._lastCanvasSig) {
        this._lastCanvasSig = mpSig;
        drawMiniPanCanvas({
          canvas: this.canvas,
          ctx: this.ctx,
          cssW: canvasW,
          cssH: canvasH,
          dpr,
          rx: this.rx,
          mp,
          rxState,
          cwPitchHz,
        });
      }

      return this._rect;
    }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      this._dragState = null;
      if (this._snapTimer) {
        clearTimeout(this._snapTimer);
        this._snapTimer = null;
      }
      this._detachWindowDragListeners();
      if (this.box && this.box.parentNode) {
        this.box.parentNode.removeChild(this.box);
      }
    }
  }

  class PanSurfaceController {
    constructor({ container, paletteName, onHudInvalidate, onCloseMiniPan }) {
      this.container = container;
      const dom = ensureSurfaceDom(container);
      this.surface = dom.surface;
      this.glCanvas = dom.glCanvas;
      this.overlayCanvas = dom.overlayCanvas;
      this.overlayCtx = this.overlayCanvas.getContext('2d', { alpha: true });

      this.paletteName = paletteName || 'obsidian';
      this._onHudInvalidate =
        typeof onHudInvalidate === 'function' ? onHudInvalidate : null;
      this._onCloseMiniPan =
        typeof onCloseMiniPan === 'function' ? onCloseMiniPan : null;

      this.perf = createPerfCounters();
      this.cssW = 0;
      this.cssH = 0;
      this.dpr = 1;
      this._hudTopInset = 0;
      this._layouts = [];
      this._vfoPills = [];
      this._lastLayoutKey = '';
      this._lastOverlaySig = null;
      this._destroyed = false;

      const bringToFront = (rx) => {
        if (rx === 'B') {
          this.miniPans.B.box.style.zIndex = '7';
          this.miniPans.A.box.style.zIndex = '6';
        } else {
          this.miniPans.A.box.style.zIndex = '7';
          this.miniPans.B.box.style.zIndex = '6';
        }
      };

      this.miniPans = {
        A: new MiniPanBoxController(this.surface, 'A', {
          onClose: this._onCloseMiniPan,
          onBringToFront: bringToFront,
        }),
        B: new MiniPanBoxController(this.surface, 'B', {
          onClose: this._onCloseMiniPan,
          onBringToFront: bringToFront,
        }),
      };

      this._hudEl = null;
      this._hudResizeObserver = null;
      this._hudMutationObserver = null;
      this._bindHudObservers();
    }

    _attachHudResizeObserver() {
      const hud = this.container
        ? this.container.querySelector(':scope > .k4-pan-hud-top')
        : null;
      if (hud === this._hudEl) return;
      if (this._hudResizeObserver && this._hudEl) {
        try {
          this._hudResizeObserver.unobserve(this._hudEl);
        } catch (_err) {
          // Ignore already removed element
        }
      }
      this._hudEl = hud;
      if (hud && this._hudResizeObserver) {
        this._hudResizeObserver.observe(hud);
      }
    }

    _bindHudObservers() {
      if (typeof globalThis.ResizeObserver === 'function') {
        this._hudResizeObserver = new globalThis.ResizeObserver(() => {
          this.invalidateHudLayout();
        });
        this._attachHudResizeObserver();
      }
      if (typeof globalThis.MutationObserver === 'function' && this.container) {
        this._hudMutationObserver = new globalThis.MutationObserver(() => {
          this._attachHudResizeObserver();
          this.invalidateHudLayout();
        });
        this._hudMutationObserver.observe(this.container, { childList: true });
      }
      if (
        typeof document !== 'undefined' &&
        document.fonts &&
        document.fonts.ready &&
        typeof document.fonts.ready.then === 'function'
      ) {
        document.fonts.ready.then(() => {
          if (!this._destroyed) this.invalidateHudLayout();
        });
      }
    }

    _measureHudInsetNow() {
      const cssH =
        this.cssH ||
        Math.max(
          0,
          Math.floor(this.surface.clientHeight || this.container.clientHeight || 0)
        );
      if (cssH <= 0) return 0;
      bumpPerf(this.perf, 'hudMeasures');
      return measureHudTopInset(this.container, cssH);
    }

    invalidateHudLayout() {
      if (this._destroyed) return this._hudTopInset;
      this._attachHudResizeObserver();
      const prev = this._hudTopInset;
      this._hudTopInset = this._measureHudInsetNow();
      this._lastLayoutKey = '';
      this._lastOverlaySig = null;

      const bounds = {
        cssW: this.cssW,
        cssH: this.cssH,
        hudTopInset: this._hudTopInset,
      };
      this.miniPans.A.clampToBounds(bounds);
      this.miniPans.B.clampToBounds(bounds);

      if (this._hudTopInset !== prev && this._onHudInvalidate) {
        this._onHudInvalidate();
      }
      return this._hudTopInset;
    }

    resize() {
      if (this._destroyed) return false;
      const dpr = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
      const cssW = Math.max(
        0,
        Math.floor(this.surface.clientWidth || this.container.clientWidth || 0)
      );
      const cssH = Math.max(
        0,
        Math.floor(this.surface.clientHeight || this.container.clientHeight || 0)
      );
      const sizeChanged = cssW !== this.cssW || cssH !== this.cssH || dpr !== this.dpr;
      this.dpr = dpr;
      this.cssW = cssW;
      this.cssH = cssH;

      const devW = Math.round(cssW * dpr);
      const devH = Math.round(cssH * dpr);
      if (devW > 0 && devH > 0) {
        if (this.glCanvas.width !== devW || this.glCanvas.height !== devH) {
          this.glCanvas.width = devW;
          this.glCanvas.height = devH;
        }
        if (this.overlayCanvas.width !== devW || this.overlayCanvas.height !== devH) {
          this.overlayCanvas.width = devW;
          this.overlayCanvas.height = devH;
        }
      }

      if (cssH > 0) {
        this._attachHudResizeObserver();
        this._hudTopInset = this._measureHudInsetNow();
      } else {
        this._hudTopInset = 0;
      }

      if (sizeChanged) {
        this._lastLayoutKey = '';
        this._lastOverlaySig = null;
      }

      const bounds = {
        cssW: this.cssW,
        cssH: this.cssH,
        hudTopInset: this._hudTopInset,
      };
      this.miniPans.A.clampToBounds(bounds);
      this.miniPans.B.clampToBounds(bounds);
      return sizeChanged;
    }

    getHudTopInset() {
      return this._hudTopInset;
    }

    getLayouts(dualPanMode, snap) {
      const dispMode =
        snap && Number.isFinite(snap.displayMode) ? snap.displayMode : 1;
      const wfPct =
        snap && Number.isFinite(snap.waterfallHeightPct)
          ? snap.waterfallHeightPct
          : 62;
      const key = `${this.cssW}|${this.cssH}|${dualPanMode || 0}|${this._hudTopInset}|${dispMode}|${wfPct}`;
      if (key !== this._lastLayoutKey) {
        this._lastLayoutKey = key;
        this._layouts = computePaneLayouts(
          this.cssW,
          this.cssH,
          dualPanMode || 0,
          this._hudTopInset,
          {
            displayMode: dispMode,
            waterfallHeightPct: wfPct,
          }
        );
      }
      return this._layouts;
    }

    _resolveMiniPanInputs(frameState, layouts) {
      const snap = (frameState && frameState.snapshot) || {};
      const rxA = snap.rxA || {};
      const rxB = snap.rxB || {};
      const aEnabled = Boolean(rxA.miniPan);
      const bEnabled = Boolean(
        snap.subRxEnabled && rxB.miniPan && rxB.miniPanAvailable !== false
      );
      const byRx = frameState && frameState.miniPanByRx;
      const fallbackMp = frameState && frameState.miniPan;

      let layoutA = layouts && layouts[0] ? layouts[0] : null;
      let layoutB = layouts && layouts[0] ? layouts[0] : null;
      if (layouts && layouts.length > 0) {
        for (let i = 0; i < layouts.length; i++) {
          if (layouts[i].rx === 'A') layoutA = layouts[i];
          if (layouts[i].rx === 'B') layoutB = layouts[i];
        }
      }

      return {
        snap,
        aEnabled,
        bEnabled,
        mpA: (byRx && byRx.A) || (aEnabled && !bEnabled ? fallbackMp : null),
        mpB: (byRx && byRx.B) || (bEnabled && !aEnabled ? fallbackMp : null),
        layoutA,
        layoutB,
      };
    }

    renderMiniPans(frameState, layouts) {
      if (this._destroyed || this.cssW <= 0 || this.cssH <= 0) return;
      const resolved = this._resolveMiniPanInputs(frameState, layouts || this._layouts);
      const bounds = {
        cssW: this.cssW,
        cssH: this.cssH,
        hudTopInset: this._hudTopInset,
      };
      const rectA = this.miniPans.A.update({
        visible: resolved.aEnabled,
        bounds,
        dpr: this.dpr,
        layout: resolved.layoutA,
        avoidRect: null,
        snapshot: resolved.snap,
        mp: resolved.mpA,
        frameState,
      });
      const samePaneAsA =
        resolved.aEnabled &&
        resolved.layoutA &&
        resolved.layoutB &&
        resolved.layoutA.rx === resolved.layoutB.rx;
      this.miniPans.B.update({
        visible: resolved.bEnabled,
        bounds,
        dpr: this.dpr,
        layout: resolved.layoutB,
        avoidRect: samePaneAsA ? rectA : null,
        snapshot: resolved.snap,
        mp: resolved.mpB,
        frameState,
      });
    }

    renderSingleMiniPan(rx, frameState) {
      if (this._destroyed || this.cssW <= 0 || this.cssH <= 0 || isDocumentHidden()) return;
      const dualPanMode = frameState ? frameState.dualPanMode : 0;
      const snap = (frameState && frameState.snapshot) || {};
      const layouts = this.getLayouts(dualPanMode, snap);
      const resolved = this._resolveMiniPanInputs(frameState, layouts);
      const bounds = {
        cssW: this.cssW,
        cssH: this.cssH,
        hudTopInset: this._hudTopInset,
      };
      if (rx === 'B') {
        const avoidRect =
          resolved.aEnabled &&
          resolved.layoutA &&
          resolved.layoutB &&
          resolved.layoutA.rx === resolved.layoutB.rx &&
          this.miniPans.A._visible
            ? this.miniPans.A._rect
            : null;
        this.miniPans.B.update({
          visible: resolved.bEnabled,
          bounds,
          dpr: this.dpr,
          layout: resolved.layoutB,
          avoidRect,
          snapshot: resolved.snap,
          mp: resolved.mpB,
          frameState,
        });
      } else {
        this.miniPans.A.update({
          visible: resolved.aEnabled,
          bounds,
          dpr: this.dpr,
          layout: resolved.layoutA,
          avoidRect: null,
          snapshot: resolved.snap,
          mp: resolved.mpA,
          frameState,
        });
      }
    }

    getVfoPillBoxes() {
      return this._vfoPills.slice();
    }

    clearVfoPills() {
      this._vfoPills.length = 0;
    }

    renderOverlayAndMiniPans(frameState, layouts) {
      if (this._destroyed) return;
      if (this.cssW <= 0 || this.cssH <= 0) {
        this._vfoPills.length = 0;
        return;
      }
      const sig = computeOverlaySignature({
        frameState,
        layouts,
        cssW: this.cssW,
        cssH: this.cssH,
        dpr: this.dpr,
        hudTopInset: this._hudTopInset,
        paletteName: this.paletteName,
      });
      if (sig !== this._lastOverlaySig) {
        this._lastOverlaySig = sig;
        this._vfoPills.length = 0;
        drawMainOverlay({
          overlayCtx: this.overlayCtx,
          cssW: this.cssW,
          cssH: this.cssH,
          dpr: this.dpr,
          layouts,
          frameState,
          vfoPillBoxes: this._vfoPills,
        });
        bumpPerf(this.perf, 'overlayDraws');
      } else {
        bumpPerf(this.perf, 'overlaySkips');
      }
      this.renderMiniPans(frameState, layouts);
    }

    setPalette(name) {
      this.paletteName = name || 'obsidian';
      this._lastOverlaySig = null;
    }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      this._vfoPills.length = 0;
      if (this._hudResizeObserver) {
        this._hudResizeObserver.disconnect();
        this._hudResizeObserver = null;
      }
      if (this._hudMutationObserver) {
        this._hudMutationObserver.disconnect();
        this._hudMutationObserver = null;
      }
      this._hudEl = null;
      this.miniPans.A.destroy();
      this.miniPans.B.destroy();
    }
  }

  function compileShader(gl, type, src) {
    const sh = gl.createShader(type);
    if (!sh) throw new Error('Unable to create WebGL2 shader');
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) || 'Shader compile error';
      gl.deleteShader(sh);
      throw new Error(log);
    }
    return sh;
  }

  function linkProgram(gl, vertSrc, fragSrc) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog) || 'Program link error';
      gl.deleteProgram(prog);
      throw new Error(log);
    }
    return prog;
  }

  class PanadapterWebGL2 {
    constructor(container, opts = {}) {
      this.type = 'webgl2';
      this.container = container;
      this._ctrl = new PanSurfaceController({
        container,
        paletteName: opts.palette || 'obsidian',
        onHudInvalidate: opts.onHudInvalidate,
        onCloseMiniPan: opts.onCloseMiniPan,
      });
      this.surface = this._ctrl.surface;
      this.glCanvas = this._ctrl.glCanvas;
      this.overlayCanvas = this._ctrl.overlayCanvas;

      const gl =
        opts.glContext ||
        this.glCanvas.getContext('webgl2', {
          antialias: true,
          alpha: false,
          preserveDrawingBuffer: true,
        });
      if (!gl) {
        this._ctrl.destroy();
        throw new Error('WebGL2 context unavailable');
      }

      this.gl = gl;
      this.overlayCtx = this._ctrl.overlayCtx;
      this.paletteName = opts.palette || 'obsidian';
      this.layouts = [];
      this.cssW = 0;
      this.cssH = 0;
      this.dpr = 1;
      this._destroyed = false;
      this._contextLost = false;
      this._specVerts = new Float32Array(DEFAULT_BINS * 2 * 3);
      this._specViewNeeded = null;
      this._zeroWfClearBuf = null;
      this._cropScratch = {
        tierSpanHz: 48000,
        spanRatio: 1,
        leftRatio: 0,
        rightRatio: 1,
      };
      this._wfCropScratch = {
        tierSpanHz: 48000,
        spanRatio: 1,
        leftRatio: 0,
        rightRatio: 1,
      };

      this._onContextLost = (e) => {
        e.preventDefault();
        this._contextLost = true;
      };
      this._onContextRestored = () => {
        this._contextLost = false;
        this._initGlResources();
      };
      this.glCanvas.addEventListener('webglcontextlost', this._onContextLost);
      this.glCanvas.addEventListener('webglcontextrestored', this._onContextRestored);

      this._panes = {
        A: this._createPaneRing(),
        B: this._createPaneRing(),
      };

      this._initGlResources();
      this.resize();
    }

    _createPaneRing() {
      return {
        binCount: DEFAULT_BINS,
        writeRow: 0,
        filledRows: 0,
        liveRows: 0,
        rowCenters: new Float64Array(RING_HEIGHT),
        rowTierSpans: new Float64Array(RING_HEIGHT),
        metaUpload: new Float32Array(RING_HEIGHT * 2),
        metaViewKey: '',
        metaFullDirty: true,
        metaUploaded: false,
        metaRowDirty: new Uint8Array(RING_HEIGHT),
        metaDirtyRows: new Int16Array(RING_HEIGHT),
        metaDirtyCount: 0,
        wfTex: null,
        metaTex: null,
      };
    }

    _initGlResources() {
      const gl = this.gl;
      this.wfProg = linkProgram(gl, WF_VERT_SRC, WF_FRAG_SRC);
      this.specProg = linkProgram(gl, SPEC_VERT_SRC, SPEC_FRAG_SRC);

      this.wfLoc = {
        a_pos: gl.getAttribLocation(this.wfProg, 'a_pos'),
        u_wfTex: gl.getUniformLocation(this.wfProg, 'u_wfTex'),
        u_lutTex: gl.getUniformLocation(this.wfProg, 'u_lutTex'),
        u_metaTex: gl.getUniformLocation(this.wfProg, 'u_metaTex'),
        u_writeRow: gl.getUniformLocation(this.wfProg, 'u_writeRow'),
        u_filledRows: gl.getUniformLocation(this.wfProg, 'u_filledRows'),
        u_liveRows: gl.getUniformLocation(this.wfProg, 'u_liveRows'),
        u_binCount: gl.getUniformLocation(this.wfProg, 'u_binCount'),
        u_visibleRows: gl.getUniformLocation(this.wfProg, 'u_visibleRows'),
        u_ringHeight: gl.getUniformLocation(this.wfProg, 'u_ringHeight'),
      };

      this.specLoc = {
        a_pos: gl.getAttribLocation(this.specProg, 'a_pos'),
        a_alpha: gl.getAttribLocation(this.specProg, 'a_alpha'),
        u_color: gl.getUniformLocation(this.specProg, 'u_color'),
      };

      // Quad VAO
      this.quadVao = gl.createVertexArray();
      gl.bindVertexArray(this.quadVao);
      this.quadBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW
      );
      gl.enableVertexAttribArray(this.wfLoc.a_pos);
      gl.vertexAttribPointer(this.wfLoc.a_pos, 2, gl.FLOAT, false, 0, 0);

      // Spectrum VAO
      this.specVao = gl.createVertexArray();
      gl.bindVertexArray(this.specVao);
      this.specBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.specBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this._specVerts.byteLength, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(this.specLoc.a_pos);
      gl.vertexAttribPointer(this.specLoc.a_pos, 2, gl.FLOAT, false, 12, 0);
      gl.enableVertexAttribArray(this.specLoc.a_alpha);
      gl.vertexAttribPointer(this.specLoc.a_alpha, 1, gl.FLOAT, false, 12, 8);
      gl.bindVertexArray(null);

      // LUT texture
      this.lutTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this._uploadPalette();

      this._initPaneTextures(this._panes.A);
      this._initPaneTextures(this._panes.B);
    }

    _initPaneTextures(paneRing) {
      const gl = this.gl;
      if (paneRing.wfTex) gl.deleteTexture(paneRing.wfTex);
      if (paneRing.metaTex) gl.deleteTexture(paneRing.metaTex);

      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      paneRing.wfTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, paneRing.wfTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const zeros = new Uint8Array(paneRing.binCount * RING_HEIGHT);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R8,
        paneRing.binCount,
        RING_HEIGHT,
        0,
        gl.RED,
        gl.UNSIGNED_BYTE,
        zeros
      );

      paneRing.metaTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, paneRing.metaTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RG32F,
        1,
        RING_HEIGHT,
        0,
        gl.RG,
        gl.FLOAT,
        paneRing.metaUpload
      );
    }

    _uploadPalette() {
      const gl = this.gl;
      if (!gl || !this.lutTex || this._contextLost) return;
      const lut = K4.WaterfallLuts
        ? K4.WaterfallLuts.get(this.paletteName)
        : new Uint8Array(1024);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        256,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        lut
      );
    }

    setPalette(name) {
      this.paletteName = name || 'obsidian';
      this._uploadPalette();
      this._ctrl.setPalette(this.paletteName);
    }

    pushWaterfallRow(uint8Row, meta = {}, paneKey = 'A') {
      if (this._destroyed || this._contextLost || !uint8Row || uint8Row.length === 0) {
        return;
      }
      const key = paneKey === 'B' ? 'B' : 'A';
      const ring = this._panes[key];
      const gl = this.gl;

      if (uint8Row.length !== ring.binCount) {
        ring.binCount = uint8Row.length;
        ring.writeRow = 0;
        ring.filledRows = 0;
        ring.liveRows = 0;
        ring.metaFullDirty = true;
        ring.metaUploaded = false;
        ring.metaViewKey = '';
        ring.metaRowDirty.fill(0);
        ring.metaDirtyCount = 0;
        this._initPaneTextures(ring);
      }

      const nextCenter =
        meta && Number.isFinite(meta.centerFreqHz) ? meta.centerFreqHz : 0;
      const nextSpan =
        meta && Number.isFinite(meta.tierSpanHz) && meta.tierSpanHz > 0
          ? meta.tierSpanHz
          : 0;

      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.bindTexture(gl.TEXTURE_2D, ring.wfTex);

      if (ring.filledRows === 0) {
        ring.liveRows = 0;
        const neededBytes = ring.binCount * RING_HEIGHT;
        if (!this._zeroWfClearBuf || this._zeroWfClearBuf.length !== neededBytes) {
          this._zeroWfClearBuf = new Uint8Array(neededBytes);
        }
        seedWaterfallRingNoise(uint8Row, ring.binCount, RING_HEIGHT, this._zeroWfClearBuf);
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          ring.binCount,
          RING_HEIGHT,
          gl.RED,
          gl.UNSIGNED_BYTE,
          this._zeroWfClearBuf
        );
        ring.rowCenters.fill(nextCenter);
        ring.rowTierSpans.fill(nextSpan);
        ring.filledRows = RING_HEIGHT;
        ring.metaFullDirty = true;
        ring.metaUploaded = false;
      }

      const w = ring.writeRow;
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        w,
        ring.binCount,
        1,
        gl.RED,
        gl.UNSIGNED_BYTE,
        uint8Row
      );

      if (
        !ring.metaUploaded ||
        ring.rowCenters[w] !== nextCenter ||
        ring.rowTierSpans[w] !== nextSpan
      ) {
        if (!ring.metaRowDirty[w]) {
          ring.metaRowDirty[w] = 1;
          if (ring.metaDirtyCount < RING_HEIGHT) {
            ring.metaDirtyRows[ring.metaDirtyCount] = w;
          }
          ring.metaDirtyCount++;
        }
      }
      ring.rowCenters[w] = nextCenter;
      ring.rowTierSpans[w] = nextSpan;

      ring.writeRow = (w + 1) % RING_HEIGHT;
      if (ring.filledRows < RING_HEIGHT) {
        ring.filledRows++;
      }
      if ((ring.liveRows || 0) < RING_HEIGHT) {
        ring.liveRows = (ring.liveRows || 0) + 1;
      }
    }

    clearWaterfall(paneKey) {
      const keys = paneKey ? [paneKey === 'B' ? 'B' : 'A'] : ['A', 'B'];
      const gl = this.gl;
      for (let i = 0; i < keys.length; i++) {
        const ring = this._panes[keys[i]];
        ring.writeRow = 0;
        ring.filledRows = 0;
        ring.liveRows = 0;
        ring.rowCenters.fill(0);
        ring.rowTierSpans.fill(0);
        ring.metaFullDirty = true;
        ring.metaUploaded = false;
        ring.metaViewKey = '';
        ring.metaRowDirty.fill(0);
        ring.metaDirtyCount = 0;
        if (!this._contextLost && gl && ring.wfTex) {
          const neededBytes = ring.binCount * RING_HEIGHT;
          if (!this._zeroWfClearBuf || this._zeroWfClearBuf.length !== neededBytes) {
            this._zeroWfClearBuf = new Uint8Array(neededBytes);
          } else {
            this._zeroWfClearBuf.fill(0);
          }
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.bindTexture(gl.TEXTURE_2D, ring.wfTex);
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.R8,
            ring.binCount,
            RING_HEIGHT,
            0,
            gl.RED,
            gl.UNSIGNED_BYTE,
            this._zeroWfClearBuf
          );
        }
      }
    }

    resize() {
      if (this._destroyed) return;
      this._ctrl.resize();
      this.dpr = this._ctrl.dpr;
      this.cssW = this._ctrl.cssW;
      this.cssH = this._ctrl.cssH;

      const devW = Math.round(this.cssW * this.dpr);
      const devH = Math.round(this.cssH * this.dpr);
      if (devW > 0 && devH > 0) {
        if (this.glCanvas.width !== devW || this.glCanvas.height !== devH) {
          this.glCanvas.width = devW;
          this.glCanvas.height = devH;
        }
      }
    }

    invalidateHudLayout() {
      return this._ctrl.invalidateHudLayout();
    }

    getHudTopInset() {
      return this._ctrl.getHudTopInset();
    }

    getPerfCounters() {
      return Object.assign({}, this._ctrl.perf);
    }

    renderMiniPan(rx, frameState) {
      this._ctrl.renderSingleMiniPan(rx, frameState);
    }

    getLayouts() {
      return this.layouts;
    }

    getVfoPillBoxes() {
      return this._ctrl.getVfoPillBoxes();
    }

    _setScissorRect(cssRect, devW, devH) {
      const gl = this.gl;
      const left = Math.round(cssRect.x * this.dpr);
      const right = Math.round((cssRect.x + cssRect.w) * this.dpr);
      const top = Math.round(cssRect.y * this.dpr);
      const bottom = Math.round((cssRect.y + cssRect.h) * this.dpr);
      const glW = Math.max(1, right - left);
      const glH = Math.max(1, bottom - top);
      const glY = Math.max(0, devH - bottom);
      gl.viewport(left, glY, glW, glH);
      gl.scissor(left, glY, glW, glH);
    }

    _drawSpectrumGl(specRect, pane, accentRgb, devW, devH) {
      const bins = pane && pane.shownDbm;
      if (!pane || !pane.binsReady || !bins || bins.length < 2) return;

      const gl = this.gl;
      const n = bins.length;
      const needed = n * 2 * 3;
      if (this._specVerts.length < needed) {
        this._specVerts = new Float32Array(needed);
        this._specViewNeeded = null;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.specBuf);
        gl.bufferData(gl.ARRAY_BUFFER, this._specVerts.byteLength, gl.DYNAMIC_DRAW);
      }

      const crop = computeViewportCropInto(
        this._cropScratch,
        pane.panCenterHz,
        pane.userSpanHz,
        pane.streamCenterHz,
        pane.tierKHz
      );
      const minDbm = Number.isFinite(pane.refDbm) ? pane.refDbm : -110;
      const scaleDb = Math.max(10, pane.scaleDb || 80);

      this._setScissorRect(specRect, devW, devH);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.specProg);
      gl.bindVertexArray(this.specVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.specBuf);

      // 1. Filled Gradient Strip
      const v = this._specVerts;
      const invNMinus1 = 1 / (n - 1);
      const invSpanRatio = 1 / crop.spanRatio;
      const invScaleDb = 1 / scaleDb;
      for (let i = 0; i < n; i++) {
        const uTier = i * invNMinus1;
        const uView = (uTier - crop.leftRatio) * invSpanRatio;
        const ndcX = uView * 2.0 - 1.0;
        const yNorm = clamp((bins[i] - minDbm) * invScaleDb, 0, 1);
        const ndcY = yNorm * 2.0 - 1.0;

        const base = i * 6;
        v[base] = ndcX;
        v[base + 1] = ndcY;
        v[base + 2] = 0.18 + 0.54 * yNorm;

        v[base + 3] = ndcX;
        v[base + 4] = -1.0;
        v[base + 5] = 0.02;
      }

      let uploadView = v;
      if (v.length !== needed) {
        if (
          !this._specViewNeeded ||
          this._specViewNeeded.length !== needed ||
          this._specViewNeeded.buffer !== v.buffer
        ) {
          this._specViewNeeded = v.subarray(0, needed);
        }
        uploadView = this._specViewNeeded;
      }

      gl.bufferSubData(gl.ARRAY_BUFFER, 0, uploadView);
      gl.uniform4f(this.specLoc.u_color, accentRgb[0], accentRgb[1], accentRgb[2], 0.58);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, n * 2);

      // 2. Crisp Perpendicular Ribbon Trace
      const wCss = Math.max(1, specRect.w);
      const hCss = Math.max(1, specRect.h);
      const halfThick = 0.85;

      for (let i = 0; i < n; i++) {
        const iPrev = i > 0 ? i - 1 : 0;
        const iNext = i < n - 1 ? i + 1 : n - 1;

        const u0 = ((iPrev * invNMinus1) - crop.leftRatio) * invSpanRatio;
        const u1 = ((iNext * invNMinus1) - crop.leftRatio) * invSpanRatio;
        const u = ((i * invNMinus1) - crop.leftRatio) * invSpanRatio;

        const yNormPrev = clamp((bins[iPrev] - minDbm) * invScaleDb, 0, 1);
        const yNormNext = clamp((bins[iNext] - minDbm) * invScaleDb, 0, 1);
        const yNorm = clamp((bins[i] - minDbm) * invScaleDb, 0, 1);

        const px = u * wCss;
        const py = (1 - yNorm) * hCss;
        const tx = (u1 - u0) * wCss;
        const ty = ((1 - yNormNext) - (1 - yNormPrev)) * hCss;
        const len = Math.sqrt(tx * tx + ty * ty) || 1;
        const nx = (-ty / len) * halfThick;
        const ny = (tx / len) * halfThick;

        const base = i * 6;
        v[base] = ((px + nx) / wCss) * 2.0 - 1.0;
        v[base + 1] = 1.0 - ((py + ny) / hCss) * 2.0;
        v[base + 2] = 1.0;

        v[base + 3] = ((px - nx) / wCss) * 2.0 - 1.0;
        v[base + 4] = 1.0 - ((py - ny) / hCss) * 2.0;
        v[base + 5] = 1.0;
      }

      gl.bufferSubData(gl.ARRAY_BUFFER, 0, uploadView);
      gl.uniform4f(this.specLoc.u_color, accentRgb[0], accentRgb[1], accentRgb[2], 0.96);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, n * 2);

      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    }

    _drawWaterfallGl(wfRect, paneKey, paneState, devW, devH) {
      const gl = this.gl;
      const ring = this._panes[paneKey];
      const viewCenterHz =
        paneState && Number.isFinite(paneState.panCenterHz)
          ? paneState.panCenterHz
          : 14074000;
      const userSpanHz =
        paneState && Number.isFinite(paneState.userSpanHz) && paneState.userSpanHz > 0
          ? paneState.userSpanHz
          : 48000;
      const tierKHz =
        paneState && Number.isFinite(paneState.tierKHz) ? paneState.tierKHz : 48;
      const streamCenterHz =
        paneState && Number.isFinite(paneState.streamCenterHz)
          ? paneState.streamCenterHz
          : 0;
      const crop = computeViewportCropInto(
        this._wfCropScratch,
        viewCenterHz,
        userSpanHz,
        paneState && paneState.streamCenterHz,
        tierKHz
      );
      const viewLeftHz = viewCenterHz - userSpanHz * 0.5;
      const viewKey = `${viewCenterHz}|${userSpanHz}|${streamCenterHz}|${tierKHz}`;
      const meta = ring.metaUpload;

      if (!ring.metaUploaded || ring.metaFullDirty || ring.metaViewKey !== viewKey) {
        // Recompute Float64 -> Float32 per-row projection only when view bounds or full ring reset change
        for (let r = 0; r < RING_HEIGHT; r++) {
          const rSpan = ring.rowTierSpans[r];
          if (rSpan > 0) {
            const rLeft = ring.rowCenters[r] - rSpan * 0.5;
            meta[r * 2] = (viewLeftHz - rLeft) / rSpan;
            meta[r * 2 + 1] = userSpanHz / rSpan;
          } else {
            meta[r * 2] = crop.leftRatio;
            meta[r * 2 + 1] = crop.spanRatio;
          }
        }
        ring.metaRowDirty.fill(0);
        ring.metaDirtyCount = 0;
        ring.metaFullDirty = false;
        ring.metaUploaded = true;
        ring.metaViewKey = viewKey;

        gl.bindTexture(gl.TEXTURE_2D, ring.metaTex);
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          1,
          RING_HEIGHT,
          gl.RG,
          gl.FLOAT,
          meta
        );
        bumpPerf(this._ctrl.perf, 'metaTexUploads');
      } else if (ring.metaDirtyCount > 0) {
        if (ring.metaDirtyCount > 16) {
          let anyChanged = false;
          for (let r = 0; r < RING_HEIGHT; r++) {
            const rSpan = ring.rowTierSpans[r];
            let u0;
            let u1;
            if (rSpan > 0) {
              const rLeft = ring.rowCenters[r] - rSpan * 0.5;
              u0 = Math.fround((viewLeftHz - rLeft) / rSpan);
              u1 = Math.fround(userSpanHz / rSpan);
            } else {
              u0 = Math.fround(crop.leftRatio);
              u1 = Math.fround(crop.spanRatio);
            }
            if (meta[r * 2] !== u0 || meta[r * 2 + 1] !== u1) {
              meta[r * 2] = u0;
              meta[r * 2 + 1] = u1;
              anyChanged = true;
            }
          }
          ring.metaRowDirty.fill(0);
          ring.metaDirtyCount = 0;
          if (anyChanged) {
            gl.bindTexture(gl.TEXTURE_2D, ring.metaTex);
            gl.texSubImage2D(
              gl.TEXTURE_2D,
              0,
              0,
              0,
              1,
              RING_HEIGHT,
              gl.RG,
              gl.FLOAT,
              meta
            );
            bumpPerf(this._ctrl.perf, 'metaTexUploads');
          }
        } else {
          let boundMetaTex = false;
          for (let i = 0; i < ring.metaDirtyCount; i++) {
            const r = ring.metaDirtyRows[i];
            ring.metaRowDirty[r] = 0;
            const rSpan = ring.rowTierSpans[r];
            let u0;
            let u1;
            if (rSpan > 0) {
              const rLeft = ring.rowCenters[r] - rSpan * 0.5;
              u0 = Math.fround((viewLeftHz - rLeft) / rSpan);
              u1 = Math.fround(userSpanHz / rSpan);
            } else {
              u0 = Math.fround(crop.leftRatio);
              u1 = Math.fround(crop.spanRatio);
            }
            if (meta[r * 2] !== u0 || meta[r * 2 + 1] !== u1) {
              meta[r * 2] = u0;
              meta[r * 2 + 1] = u1;
              if (!boundMetaTex) {
                gl.bindTexture(gl.TEXTURE_2D, ring.metaTex);
                boundMetaTex = true;
              }
              gl.texSubImage2D(
                gl.TEXTURE_2D,
                0,
                0,
                r,
                1,
                1,
                gl.RG,
                gl.FLOAT,
                meta,
                r * 2
              );
              bumpPerf(this._ctrl.perf, 'metaTexUploads');
            }
          }
          ring.metaDirtyCount = 0;
        }
      }

      this._setScissorRect(wfRect, devW, devH);
      gl.disable(gl.BLEND);
      gl.useProgram(this.wfProg);
      gl.bindVertexArray(this.quadVao);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, ring.wfTex);
      gl.uniform1i(this.wfLoc.u_wfTex, 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.uniform1i(this.wfLoc.u_lutTex, 1);

      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, ring.metaTex);
      gl.uniform1i(this.wfLoc.u_metaTex, 2);

      gl.uniform1i(this.wfLoc.u_writeRow, ring.writeRow);
      gl.uniform1i(this.wfLoc.u_filledRows, ring.filledRows);
      gl.uniform1i(this.wfLoc.u_liveRows, ring.liveRows || 0);
      gl.uniform1i(this.wfLoc.u_binCount, ring.binCount);
      gl.uniform1f(
        this.wfLoc.u_visibleRows,
        Math.min(RING_HEIGHT, Math.max(16, Math.round(wfRect.h / 2)))
      );
      gl.uniform1i(this.wfLoc.u_ringHeight, RING_HEIGHT);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    }

    render(frameState) {
      if (this._destroyed || isDocumentHidden()) return;
      const dualPanMode = frameState ? frameState.dualPanMode : 0;
      const snap = (frameState && frameState.snapshot) || {};
      this.layouts = this._ctrl.getLayouts(dualPanMode, snap);

      const devW = this.glCanvas.width;
      const devH = this.glCanvas.height;
      if (this.cssW <= 0 || this.cssH <= 0 || devW <= 0 || devH <= 0) {
        this._ctrl.clearVfoPills();
        return;
      }

      if (!this._contextLost) {
        const gl = this.gl;
        gl.disable(gl.SCISSOR_TEST);
        gl.viewport(0, 0, devW, devH);
        gl.clearColor(9 / 255, 11 / 255, 16 / 255, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.SCISSOR_TEST);

        for (let i = 0; i < this.layouts.length; i++) {
          const layout = this.layouts[i];
          const paneState =
            frameState && frameState.panes ? frameState.panes[layout.rx] : null;
          const accent = layout.rx === 'B' ? ACCENT_RGB_B : ACCENT_RGB_A;

          this._drawSpectrumGl(layout.specRect, paneState, accent, devW, devH);
          if (layout.wfRect.h > 0) {
            this._drawWaterfallGl(layout.wfRect, layout.rx, paneState, devW, devH);
          }
        }

        gl.disable(gl.SCISSOR_TEST);
      }

      this._ctrl.renderOverlayAndMiniPans(frameState, this.layouts);
      bumpPerf(this._ctrl.perf, 'panFrames');
    }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      this.glCanvas.removeEventListener('webglcontextlost', this._onContextLost);
      this.glCanvas.removeEventListener('webglcontextrestored', this._onContextRestored);

      const gl = this.gl;
      if (gl && !this._contextLost) {
        if (this.wfProg) gl.deleteProgram(this.wfProg);
        if (this.specProg) gl.deleteProgram(this.specProg);
        if (this.quadBuf) gl.deleteBuffer(this.quadBuf);
        if (this.specBuf) gl.deleteBuffer(this.specBuf);
        if (this.quadVao) gl.deleteVertexArray(this.quadVao);
        if (this.specVao) gl.deleteVertexArray(this.specVao);
        if (this.lutTex) gl.deleteTexture(this.lutTex);
        ['A', 'B'].forEach((k) => {
          const r = this._panes[k];
          if (r.wfTex) gl.deleteTexture(r.wfTex);
          if (r.metaTex) gl.deleteTexture(r.metaTex);
        });
      }
      this._ctrl.destroy();
    }
  }

  class PanadapterCanvas2D {
    constructor(container, opts = {}) {
      this.type = 'canvas2d';
      this.container = container;
      this._ctrl = new PanSurfaceController({
        container,
        paletteName: opts.palette || 'obsidian',
        onHudInvalidate: opts.onHudInvalidate,
        onCloseMiniPan: opts.onCloseMiniPan,
      });
      this.surface = this._ctrl.surface;
      this.glCanvas = this._ctrl.glCanvas;
      this.overlayCanvas = this._ctrl.overlayCanvas;

      this.ctx = this.glCanvas.getContext('2d', { alpha: false });
      this.overlayCtx = this._ctrl.overlayCtx;

      this.paletteName = opts.palette || 'obsidian';
      this._updatePackedLut();

      this.layouts = [];
      this.cssW = 0;
      this.cssH = 0;
      this.dpr = 1;
      this._destroyed = false;
      this._cropScratch = {
        tierSpanHz: 48000,
        spanRatio: 1,
        leftRatio: 0,
        rightRatio: 1,
      };

      this._panes = {
        A: this._createPaneRing(),
        B: this._createPaneRing(),
      };

      this.resize();
    }

    _createPaneRing() {
      return {
        binCount: DEFAULT_BINS,
        writeRow: 0,
        filledRows: 0,
        liveRows: 0,
        indexRing: new Uint8Array(DEFAULT_BINS * RING_HEIGHT),
        rowCenters: new Float64Array(RING_HEIGHT),
        rowTierSpans: new Float64Array(RING_HEIGHT),
        wfCanvas: document.createElement('canvas'),
        wfCtx: null,
        wfImg: null,
        wfPixels32: null,
        dirty: true,
        lastKey: '',
      };
    }

    _updatePackedLut() {
      const lut = K4.WaterfallLuts
        ? K4.WaterfallLuts.get(this.paletteName)
        : new Uint8Array(1024);
      this._lutBytes = lut;
      const packed = new Uint32Array(256);
      const dimLo = new Uint32Array(256);
      const dimHi = new Uint32Array(256);
      // Detect host endianness cleanly via DataView
      const testBuf = new ArrayBuffer(4);
      new Uint8Array(testBuf).set([1, 2, 3, 4]);
      const isLittleEndian = new Uint32Array(testBuf)[0] === 0x04030201;
      const packRgba = (r, g, b, a) =>
        isLittleEndian
          ? ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
          : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      const bgR = lut[0];
      const bgG = lut[1];
      const bgB = lut[2];
      for (let i = 0; i < 256; i++) {
        const off = i * 4;
        const r = lut[off];
        const g = lut[off + 1];
        const b = lut[off + 2];
        const a = lut[off + 3];
        packed[i] = packRgba(r, g, b, a);
        dimLo[i] = packRgba(
          Math.round(bgR + (r - bgR) * 0.22),
          Math.round(bgG + (g - bgG) * 0.22),
          Math.round(bgB + (b - bgB) * 0.22),
          a
        );
        dimHi[i] = packRgba(
          Math.round(bgR + (r - bgR) * 0.42),
          Math.round(bgG + (g - bgG) * 0.42),
          Math.round(bgB + (b - bgB) * 0.42),
          a
        );
      }
      this._packedLut = packed;
      this._dimLutLo = dimLo;
      this._dimLutHi = dimHi;
    }

    setPalette(name) {
      this.paletteName = name || 'obsidian';
      this._updatePackedLut();
      this._panes.A.dirty = true;
      this._panes.B.dirty = true;
      this._ctrl.setPalette(this.paletteName);
    }

    pushWaterfallRow(uint8Row, meta = {}, paneKey = 'A') {
      if (this._destroyed || !uint8Row || uint8Row.length === 0) return;
      const key = paneKey === 'B' ? 'B' : 'A';
      const ring = this._panes[key];

      if (uint8Row.length !== ring.binCount) {
        ring.binCount = uint8Row.length;
        ring.indexRing = new Uint8Array(ring.binCount * RING_HEIGHT);
        ring.writeRow = 0;
        ring.filledRows = 0;
        ring.liveRows = 0;
      }

      const nextCenter =
        meta && Number.isFinite(meta.centerFreqHz) ? meta.centerFreqHz : 0;
      const nextSpan =
        meta && Number.isFinite(meta.tierSpanHz) && meta.tierSpanHz > 0
          ? meta.tierSpanHz
          : 0;

      if (ring.filledRows === 0) {
        ring.liveRows = 0;
        seedWaterfallRingNoise(uint8Row, ring.binCount, RING_HEIGHT, ring.indexRing);
        ring.rowCenters.fill(nextCenter);
        ring.rowTierSpans.fill(nextSpan);
        ring.filledRows = RING_HEIGHT;
      }

      ring.indexRing.set(uint8Row, ring.writeRow * ring.binCount);
      ring.rowCenters[ring.writeRow] = nextCenter;
      ring.rowTierSpans[ring.writeRow] = nextSpan;

      ring.writeRow = (ring.writeRow + 1) % RING_HEIGHT;
      if (ring.filledRows < RING_HEIGHT) {
        ring.filledRows++;
      }
      if ((ring.liveRows || 0) < RING_HEIGHT) {
        ring.liveRows = (ring.liveRows || 0) + 1;
      }
      ring.dirty = true;
    }

    clearWaterfall(paneKey) {
      const keys = paneKey ? [paneKey === 'B' ? 'B' : 'A'] : ['A', 'B'];
      for (let i = 0; i < keys.length; i++) {
        const ring = this._panes[keys[i]];
        ring.writeRow = 0;
        ring.filledRows = 0;
        ring.liveRows = 0;
        ring.indexRing.fill(0);
        ring.rowCenters.fill(0);
        ring.rowTierSpans.fill(0);
        ring.dirty = true;
      }
    }

    resize() {
      if (this._destroyed) return;
      this._ctrl.resize();
      this.dpr = this._ctrl.dpr;
      this.cssW = this._ctrl.cssW;
      this.cssH = this._ctrl.cssH;

      const devW = Math.round(this.cssW * this.dpr);
      const devH = Math.round(this.cssH * this.dpr);
      if (devW > 0 && devH > 0) {
        if (this.glCanvas.width !== devW || this.glCanvas.height !== devH) {
          this.glCanvas.width = devW;
          this.glCanvas.height = devH;
        }
      }
      this._panes.A.dirty = true;
      this._panes.B.dirty = true;
    }

    invalidateHudLayout() {
      return this._ctrl.invalidateHudLayout();
    }

    getHudTopInset() {
      return this._ctrl.getHudTopInset();
    }

    getPerfCounters() {
      return Object.assign({}, this._ctrl.perf);
    }

    renderMiniPan(rx, frameState) {
      this._ctrl.renderSingleMiniPan(rx, frameState);
    }

    getLayouts() {
      return this.layouts;
    }

    getVfoPillBoxes() {
      return this._ctrl.getVfoPillBoxes();
    }

    _drawSpectrum2D(specRect, pane, accentHex, accentFillTop) {
      const bins = pane && pane.shownDbm;
      if (!pane || !pane.binsReady || !bins || bins.length < 2) return;

      const ctx = this.ctx;
      const n = bins.length;
      const crop = computeViewportCropInto(
        this._cropScratch,
        pane.panCenterHz,
        pane.userSpanHz,
        pane.streamCenterHz,
        pane.tierKHz
      );
      const minDbm = Number.isFinite(pane.refDbm) ? pane.refDbm : -110;
      const scaleDb = Math.max(10, pane.scaleDb || 80);
      const maxDbm = minDbm + scaleDb;

      ctx.save();
      ctx.beginPath();
      ctx.rect(specRect.x, specRect.y, specRect.w, specRect.h);
      ctx.clip();

      const grad = ctx.createLinearGradient(0, specRect.y, 0, specRect.y + specRect.h);
      grad.addColorStop(0, accentFillTop);
      grad.addColorStop(1, 'rgba(9, 11, 16, 0.02)');

      // Gradient Fill
      ctx.beginPath();
      let firstX = specRect.x;
      let lastX = specRect.x + specRect.w;
      let started = false;
      for (let i = 0; i < n; i++) {
        const uView = ((i / (n - 1)) - crop.leftRatio) / crop.spanRatio;
        if (uView < -0.02 || uView > 1.02) continue;
        const x = specRect.x + uView * specRect.w;
        const yNorm = clamp((maxDbm - bins[i]) / scaleDb, 0, 1);
        const y = specRect.y + yNorm * specRect.h;
        if (!started) {
          firstX = x;
          ctx.moveTo(x, specRect.y + specRect.h);
          ctx.lineTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
        lastX = x;
      }
      if (started) {
        ctx.lineTo(lastX, specRect.y + specRect.h);
        ctx.lineTo(firstX, specRect.y + specRect.h);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
      }

      // Crisp Stroke
      ctx.beginPath();
      started = false;
      for (let i = 0; i < n; i++) {
        const uView = ((i / (n - 1)) - crop.leftRatio) / crop.spanRatio;
        if (uView < -0.02 || uView > 1.02) continue;
        const x = specRect.x + uView * specRect.w;
        const yNorm = clamp((maxDbm - bins[i]) / scaleDb, 0, 1);
        const y = specRect.y + yNorm * specRect.h;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.strokeStyle = accentHex;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.restore();
    }

    _drawWaterfall2D(wfRect, paneKey, paneState) {
      const ring = this._panes[paneKey];
      const w = Math.max(1, Math.floor(wfRect.w));
      const visRows = Math.min(RING_HEIGHT, Math.max(16, Math.round(wfRect.h / 2)));

      const viewCenterHz =
        paneState && Number.isFinite(paneState.panCenterHz)
          ? paneState.panCenterHz
          : 14074000;
      const userSpanHz =
        paneState && Number.isFinite(paneState.userSpanHz) && paneState.userSpanHz > 0
          ? paneState.userSpanHz
          : 48000;
      const tierKHz =
        paneState && Number.isFinite(paneState.tierKHz) ? paneState.tierKHz : 48;

      const viewKey = `${w}x${visRows}|${viewCenterHz}|${userSpanHz}|${tierKHz}|${ring.liveRows || 0}`;
      if (ring.wfCanvas.width !== w || ring.wfCanvas.height !== visRows) {
        ring.wfCanvas.width = w;
        ring.wfCanvas.height = visRows;
        ring.wfCtx = ring.wfCanvas.getContext('2d', { alpha: false });
        ring.wfImg = ring.wfCtx.createImageData(w, visRows);
        ring.wfPixels32 = new Uint32Array(ring.wfImg.data.buffer);
        ring.dirty = true;
      }

      if (ring.dirty || ring.lastKey !== viewKey) {
        ring.dirty = false;
        ring.lastKey = viewKey;
        const px32 = ring.wfPixels32;
        const packed = this._packedLut;
        const dimLo = this._dimLutLo || packed;
        const dimHi = this._dimLutHi || packed;
        const bgColor = packed[0];
        const crop = computeViewportCropInto(
          this._cropScratch,
          viewCenterHz,
          userSpanHz,
          paneState && paneState.streamCenterHz,
          tierKHz
        );
        const viewLeftHz = viewCenterHz - userSpanHz * 0.5;
        const binCount = ring.binCount;
        const indexRing = ring.indexRing;
        const liveRows = ring.liveRows || 0;

        for (let y = 0; y < visRows; y++) {
          const rowStart = y * w;
          if (y >= ring.filledRows) {
            px32.fill(bgColor, rowStart, rowStart + w);
            continue;
          }
          const isLive = y < liveRows;
          const ringRow =
            ((ring.writeRow - 1 - y) % RING_HEIGHT + RING_HEIGHT) % RING_HEIGHT;
          const rSpan = ring.rowTierSpans[ringRow];
          let uOffset = crop.leftRatio;
          let uScale = crop.spanRatio;
          if (rSpan > 0) {
            const rLeft = ring.rowCenters[ringRow] - rSpan * 0.5;
            uOffset = (viewLeftHz - rLeft) / rSpan;
            uScale = userSpanHz / rSpan;
          }

          const srcOff = ringRow * binCount;
          const stepU = uScale / w;
          for (let x = 0; x < w; x++) {
            const tierU = uOffset + (x + 0.5) * stepU;
            if (tierU < 0 || tierU > 1) {
              px32[rowStart + x] = bgColor;
            } else {
              const binIdx = Math.min(binCount - 1, Math.floor(tierU * binCount));
              const lutIdx = indexRing[srcOff + binIdx];
              px32[rowStart + x] = isLive
                ? packed[lutIdx]
                : (((x + y * 2) & 7) < 2 ? dimLo[lutIdx] : dimHi[lutIdx]);
            }
          }
        }
        ring.wfCtx.putImageData(ring.wfImg, 0, 0);
      }

      this.ctx.save();
      this.ctx.imageSmoothingEnabled = false;
      this.ctx.drawImage(
        ring.wfCanvas,
        0,
        0,
        w,
        visRows,
        wfRect.x,
        wfRect.y,
        wfRect.w,
        wfRect.h
      );
      this.ctx.restore();
    }

    render(frameState) {
      if (this._destroyed || isDocumentHidden()) return;
      const dualPanMode = frameState ? frameState.dualPanMode : 0;
      const snap = (frameState && frameState.snapshot) || {};
      this.layouts = this._ctrl.getLayouts(dualPanMode, snap);

      if (this.cssW <= 0 || this.cssH <= 0 || !this.ctx) {
        this._ctrl.clearVfoPills();
        return;
      }

      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = '#090B10';
      ctx.fillRect(0, 0, this.cssW, this.cssH);

      for (let i = 0; i < this.layouts.length; i++) {
        const layout = this.layouts[i];
        const paneState =
          frameState && frameState.panes ? frameState.panes[layout.rx] : null;
        const accentHex = layout.rx === 'B' ? '#22C55E' : '#38BDF8';
        const accentFillTop =
          layout.rx === 'B'
            ? 'rgba(34, 197, 94, 0.36)'
            : 'rgba(56, 189, 248, 0.38)';

        this._drawSpectrum2D(layout.specRect, paneState, accentHex, accentFillTop);
        if (layout.wfRect.h > 0) {
          this._drawWaterfall2D(layout.wfRect, layout.rx, paneState);
        }
      }

      this._ctrl.renderOverlayAndMiniPans(frameState, this.layouts);
      bumpPerf(this._ctrl.perf, 'panFrames');
    }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      this._ctrl.destroy();
    }
  }

  function createPanRenderer(container, opts = {}) {
    if (!container) {
      throw new Error('createPanRenderer requires a container element');
    }
    const mode = opts.renderer || 'auto';
    if (mode !== 'canvas2d') {
      try {
        return new PanadapterWebGL2(container, opts);
      } catch (_err) {
        // Fallback seamlessly when WebGL2 is unavailable or disabled
      }
    }
    return new PanadapterCanvas2D(container, opts);
  }

  K4.PanadapterWebGL2 = PanadapterWebGL2;
  K4.PanadapterCanvas2D = PanadapterCanvas2D;
  K4.createPanRenderer = createPanRenderer;
  K4._computePanLayouts = computePaneLayouts;
  K4._measureHudTopInset = measureHudTopInset;
})();
