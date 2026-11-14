'use strict';

(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  function clampByte(v) {
    const r = Math.round(v);
    return r < 0 ? 0 : r > 255 ? 255 : r;
  }

  /**
   * Builds a 256-entry RGBA Uint8Array(1024) LUT.
   * Index 0 is strictly reserved as [9, 11, 16, 255] (#090B10) for blank waterfall history.
   */
  function buildLut(stops) {
    const lut = new Uint8Array(1024);

    for (let idx = 1; idx < 256; idx++) {
      const t = (idx - 1) / 254;
      let seg = 0;
      while (seg < stops.length - 2 && t > stops[seg + 1][0]) {
        seg++;
      }
      const [t0, c0] = stops[seg];
      const [t1, c1] = stops[seg + 1];
      const frac = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      const u = frac < 0 ? 0 : frac > 1 ? 1 : frac;
      const off = idx * 4;
      lut[off] = clampByte(c0[0] + (c1[0] - c0[0]) * u);
      lut[off + 1] = clampByte(c0[1] + (c1[1] - c0[1]) * u);
      lut[off + 2] = clampByte(c0[2] + (c1[2] - c0[2]) * u);
      lut[off + 3] = 255;
    }

    lut[0] = 9;
    lut[1] = 11;
    lut[2] = 16;
    lut[3] = 255;
    return lut;
  }

  const obsidian = buildLut([
    [0.0, [9, 11, 16]],
    [0.25, [30, 58, 138]],
    [0.55, [6, 182, 212]],
    [0.82, [245, 158, 11]],
    [1.0, [248, 250, 252]],
  ]);

  const thermal = buildLut([
    [0.0, [9, 11, 16]],
    [0.28, [153, 27, 27]],
    [0.56, [234, 88, 12]],
    [0.82, [250, 204, 21]],
    [1.0, [255, 255, 255]],
  ]);

  const viridis = buildLut([
    [0.0, [68, 1, 84]],
    [0.25, [59, 82, 139]],
    [0.5, [33, 145, 140]],
    [0.75, [94, 201, 98]],
    [1.0, [253, 231, 37]],
  ]);

  const cyan = buildLut([
    [0.0, [7, 16, 24]],
    [0.45, [14, 116, 144]],
    [0.78, [56, 189, 248]],
    [1.0, [224, 242, 254]],
  ]);

  const NAMES = ['obsidian', 'thermal', 'viridis', 'cyan'];
  const LABELS = {
    obsidian: 'Obsidian',
    thermal: 'Thermal',
    viridis: 'Viridis',
    cyan: 'Cyan',
  };
  const luts = {
    obsidian,
    thermal,
    viridis,
    cyan,
  };

  function has(name) {
    return Object.prototype.hasOwnProperty.call(luts, name);
  }

  function get(name) {
    return has(name) ? luts[name] : luts.obsidian;
  }

  function list() {
    return NAMES.slice();
  }

  K4.WaterfallLuts = {
    DEFAULT: 'obsidian',
    NAMES,
    LABELS,
    luts,
    obsidian,
    thermal,
    viridis,
    cyan,
    has,
    get,
    list,
  };
})();
