'use strict';

(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const MODES = Object.freeze({
    1: Object.freeze({ code: 1, key: 'LSB', label: 'LSB', group: 'SSB' }),
    2: Object.freeze({ code: 2, key: 'USB', label: 'USB', group: 'SSB' }),
    3: Object.freeze({ code: 3, key: 'CW', label: 'CW', group: 'CW' }),
    4: Object.freeze({ code: 4, key: 'FM', label: 'FM', group: 'FM' }),
    5: Object.freeze({ code: 5, key: 'AM', label: 'AM', group: 'AM' }),
    6: Object.freeze({ code: 6, key: 'DATA', label: 'DATA', group: 'DATA' }),
    7: Object.freeze({ code: 7, key: 'CW-R', label: 'CW-R', group: 'CW' }),
    9: Object.freeze({ code: 9, key: 'DATA-R', label: 'DATA-R', group: 'DATA' }),
  });

  const DATA_SUBMODES = Object.freeze({
    0: 'DATA-A',
    1: 'AFSK-A',
    2: 'FSK-D',
    3: 'PSK-D',
  });

  const STEP_HZ_TABLE = Object.freeze([1, 10, 100, 1000, 2500, 5000, 10000]);
  const SL_FRAMES_TABLE = Object.freeze([1, 2, 2, 3, 3, 3, 6, 6]);
  const SL_TARGET_MS_TABLE = Object.freeze([35, 60, 75, 95, 115, 140, 180, 240]);

  const AUDIO_MIX_MODES = Object.freeze([
    'A.B',
    'AB.AB',
    'A.-A',
    'A.AB',
    'AB.B',
    'AB.A',
    'B.AB',
    'B.B',
    'B.A',
    'A.A',
  ]);

  const BANDS = Object.freeze([
    Object.freeze({ bn: '00', id: '160m', label: '160m', defaultHz: 1840000, startHz: 1800000, endHz: 2000000 }),
    Object.freeze({ bn: '01', id: '80m', label: '80m', defaultHz: 3573000, startHz: 3500000, endHz: 4000000 }),
    Object.freeze({ bn: '02', id: '60m', label: '60m', defaultHz: 5357000, startHz: 5330500, endHz: 5405000 }),
    Object.freeze({ bn: '03', id: '40m', label: '40m', defaultHz: 7074000, startHz: 7000000, endHz: 7300000 }),
    Object.freeze({ bn: '04', id: '30m', label: '30m', defaultHz: 10136000, startHz: 10100000, endHz: 10150000 }),
    Object.freeze({ bn: '05', id: '20m', label: '20m', defaultHz: 14074000, startHz: 14000000, endHz: 14350000 }),
    Object.freeze({ bn: '06', id: '17m', label: '17m', defaultHz: 18100000, startHz: 18068000, endHz: 18168000 }),
    Object.freeze({ bn: '07', id: '15m', label: '15m', defaultHz: 21074000, startHz: 21000000, endHz: 21450000 }),
    Object.freeze({ bn: '08', id: '12m', label: '12m', defaultHz: 24915000, startHz: 24890000, endHz: 24990000 }),
    Object.freeze({ bn: '09', id: '10m', label: '10m', defaultHz: 28074000, startHz: 28000000, endHz: 29700000 }),
    Object.freeze({ bn: '10', id: '6m', label: '6m', defaultHz: 50313000, startHz: 50000000, endHz: 54000000 }),
  ]);

  function clamp(val, min, max) {
    return val < min ? min : val > max ? max : val;
  }

  function parseIntStrict(str) {
    const t = String(str).trim();
    if (!/^[+-]?\d+$/.test(t)) return null;
    const n = parseInt(t, 10);
    if (!Number.isFinite(n)) return null;
    return n === 0 ? 0 : n;
  }

  /**
   * Convert dBm S-meter reading to S-unit scalar and formatted label.
   * @param {number} dBm
   * @returns {{ sUnits: number, overDb: number, label: string }}
   */
  function sUnitForDbm(dBm) {
    if (!Number.isFinite(dBm)) {
      return { sUnits: 0, overDb: 0, label: 'S0' };
    }
    if (dBm <= -73) {
      const sUnits = clamp((dBm + 127) / 6, 0, 9);
      const rounded = Math.round(sUnits);
      return { sUnits, overDb: 0, label: `S${rounded}` };
    }
    const overDb = Math.max(0, Math.round(dBm + 73));
    const label = overDb > 0 ? `S9+${overDb}` : 'S9';
    return { sUnits: 9, overDb, label };
  }

  /**
   * Split a raw K4 CAT stream chunk into individual command tokens.
   * Handles TBtrrs; / TB$trrs; byte-counted text fields containing literal semicolons
   * before splitting standard ;-delimited frames.
   * @param {string} ascii
   * @returns {string[]}
   */
  function splitFrames(ascii) {
    const out = [];
    if (typeof ascii !== 'string' || ascii.length === 0) return out;

    const n = ascii.length;
    let i = 0;

    while (i < n) {
      while (
        i < n &&
        (ascii[i] === ';' ||
          ascii[i] === '\r' ||
          ascii[i] === '\n' ||
          ascii[i] === ' ' ||
          ascii[i] === '\t')
      ) {
        i++;
      }
      if (i >= n) break;

      if (ascii[i] === 'T' && ascii[i + 1] === 'B') {
        const rest = ascii.slice(i);
        const tbMatch = rest.match(/^TB(\$?)([0-9])([0-9]{2})/);
        if (tbMatch) {
          const headerLen = tbMatch[0].length; // 5 for TBtrr, 6 for TB$trr
          const charLen = parseInt(tbMatch[3], 10);
          const endIdx = Math.min(n, i + headerLen + charLen);
          out.push(ascii.slice(i, endIdx));
          i = endIdx;
          if (i < n && ascii[i] === ';') {
            i++;
          }
          continue;
        }
      }

      const semiIdx = ascii.indexOf(';', i);
      if (semiIdx === -1) {
        const tail = ascii.slice(i).trim();
        if (tail.length > 0) out.push(tail);
        break;
      }
      const token = ascii.slice(i, semiIdx).trim();
      if (token.length > 0) out.push(token);
      i = semiIdx + 1;
    }

    return out;
  }

  function makeRxParser(prefix, handler) {
    const rx = prefix.includes('$') ? 'B' : 'A';
    return { prefix, fn: (arg) => handler(arg, rx) };
  }

  function makeGlobalParser(prefix, handler) {
    return { prefix, fn: (arg) => handler(arg, null) };
  }

  const PARSERS = [
    makeRxParser('#SPN$', (arg, rx) => {
      const v = parseIntStrict(arg);
      if (v === null) return null;
      return { kind: 'panSpan', rx, spanHz: v < 1000 ? v * 1000 : v };
    }),
    makeRxParser('#SPN', (arg, rx) => {
      const v = parseIntStrict(arg);
      if (v === null) return null;
      return { kind: 'panSpan', rx, spanHz: v < 1000 ? v * 1000 : v };
    }),
    makeRxParser('#REF$', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'panRef', rx, refDbm: v };
    }),
    makeRxParser('#REF', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'panRef', rx, refDbm: v };
    }),
    makeRxParser('#SCL$', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'panScale', rx, scaleDb: v };
    }),
    makeRxParser('#SCL', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'panScale', rx, scaleDb: v };
    }),
    makeRxParser('#WBS$', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'wfBlack', rx, wfBlack: v };
    }),
    makeRxParser('#WBS', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'wfBlack', rx, wfBlack: v };
    }),
    makeGlobalParser('#AVG', (arg) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'panAvg', rx: null, avg: v };
    }),
    makeGlobalParser('#DPM', (arg) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'dualPan', rx: null, dualPanMode: v };
    }),
    makeGlobalParser('#FRZ', (arg) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'panFrozen', rx: null, panFrozen: v === 1 };
    }),
    makeGlobalParser('PONG', (arg) => {
      const t = arg.trim();
      if (!t) return { kind: 'pong', rx: null, epoch: null };
      const epoch = Number(t);
      return { kind: 'pong', rx: null, epoch: Number.isFinite(epoch) ? epoch : t };
    }),
    makeGlobalParser('PING', (arg) => {
      const t = arg.trim();
      if (!t) return null;
      const epoch = Number(t);
      return { kind: 'ping', rx: null, epoch: Number.isFinite(epoch) ? epoch : t };
    }),
    makeRxParser('SMH$', (arg, rx) => {
      const v = parseIntStrict(arg);
      if (v === null) return null;
      const s = sUnitForDbm(v);
      return { kind: 'smeterDbm', rx, dBm: v, sUnits: s.sUnits, sLabel: s.label };
    }),
    makeRxParser('SMH', (arg, rx) => {
      const v = parseIntStrict(arg);
      if (v === null) return null;
      const s = sUnitForDbm(v);
      return { kind: 'smeterDbm', rx, dBm: v, sUnits: s.sUnits, sLabel: s.label };
    }),
    makeRxParser('#AR$', (arg, rx) => parseAutoRef(arg, rx)),
    makeRxParser('#AR', (arg, rx) => parseAutoRef(arg, rx)),
    makeRxParser('#MP$', (arg, rx) => parseMiniPan(arg, rx)),
    makeRxParser('#MP', (arg, rx) => parseMiniPan(arg, rx)),
    makeRxParser('SM$', (arg, rx) => parseSMeterBars(arg, rx)),
    makeRxParser('SM', (arg, rx) => parseSMeterBars(arg, rx)),
    makeRxParser('MD$', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'mode', rx, modeCode: v };
    }),
    makeRxParser('MD', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'mode', rx, modeCode: v };
    }),
    makeRxParser('DT$', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'dataSubMode', rx, subMode: v };
    }),
    makeRxParser('DT', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'dataSubMode', rx, subMode: v };
    }),
    makeRxParser('BW$', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'bw', rx, bwHz: v * 10 };
    }),
    makeRxParser('BW', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'bw', rx, bwHz: v * 10 };
    }),
    makeRxParser('IS$', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'ifShift', rx, ifShiftHz: v * 10 };
    }),
    makeRxParser('IS', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'ifShift', rx, ifShiftHz: v * 10 };
    }),
    makeRxParser('VT$', (arg, rx) => parseStep(arg, rx)),
    makeRxParser('VT', (arg, rx) => parseStep(arg, rx)),
    makeRxParser('LK$', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'lock', rx, locked: v === 1 };
    }),
    makeRxParser('LK', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'lock', rx, locked: v === 1 };
    }),
    makeRxParser('PA$', (arg, rx) => parsePreamp(arg, rx)),
    makeRxParser('PA', (arg, rx) => parsePreamp(arg, rx)),
    makeRxParser('RA$', (arg, rx) => parseAtten(arg, rx)),
    makeRxParser('RA', (arg, rx) => parseAtten(arg, rx)),
    makeRxParser('AG$', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'afGain', rx, afGain: v };
    }),
    makeRxParser('AG', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'afGain', rx, afGain: v };
    }),
    makeRxParser('RG$', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'rfGain', rx, rfGainDb: v };
    }),
    makeRxParser('RG', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'rfGain', rx, rfGainDb: v };
    }),
    makeRxParser('SQ$', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'squelch', rx, squelch: v };
    }),
    makeRxParser('SQ', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'squelch', rx, squelch: v };
    }),
    makeRxParser('NB$', (arg, rx) => parseNoiseBlanker(arg, rx)),
    makeRxParser('NB', (arg, rx) => parseNoiseBlanker(arg, rx)),
    makeRxParser('NR$', (arg, rx) => parseNoiseReduction(arg, rx)),
    makeRxParser('NR', (arg, rx) => parseNoiseReduction(arg, rx)),
    makeRxParser('NM$', (arg, rx) => parseNotch(arg, rx)),
    makeRxParser('NM', (arg, rx) => parseNotch(arg, rx)),
    makeRxParser('GT$', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'agc', rx, agc: v };
    }),
    makeRxParser('GT', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'agc', rx, agc: v };
    }),
    makeRxParser('AP$', (arg, rx) => parseApf(arg, rx)),
    makeRxParser('AP', (arg, rx) => parseApf(arg, rx)),
    makeRxParser('BN$', (arg, rx) => parseBand(arg, rx)),
    makeRxParser('BN', (arg, rx) => parseBand(arg, rx)),
    makeRxParser('OV$', (arg, rx) => parseAdcOverflow(arg, rx)),
    makeRxParser('OV', (arg, rx) => parseAdcOverflow(arg, rx)),
    makeRxParser('FI$', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'ifCenter', rx, ifCenterHz: v };
    }),
    makeRxParser('FI', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'ifCenter', rx, ifCenterHz: v };
    }),
    makeRxParser('RT$', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'rit', rx, ritOn: v === 1 };
    }),
    makeRxParser('RT', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'rit', rx, ritOn: v === 1 };
    }),
    makeRxParser('RO$', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'ritOffset', rx, ritOffsetHz: v };
    }),
    makeRxParser('RO', (arg, rx) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'ritOffset', rx, ritOffsetHz: v };
    }),
    makeGlobalParser('DV', (arg) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'diversity', rx: null, diversityEnabled: v === 1 };
    }),
    {
      prefix: 'FA',
      fn: (arg) => {
        const v = parseIntStrict(arg);
        return v === null ? null : { kind: 'freq', rx: 'A', freqHz: v };
      },
    },
    {
      prefix: 'FB',
      fn: (arg) => {
        const v = parseIntStrict(arg);
        return v === null ? null : { kind: 'freq', rx: 'B', freqHz: v };
      },
    },
    makeGlobalParser('CW', (arg) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'cwPitch', rx: null, cwPitchHz: v * 10 };
    }),
    makeGlobalParser('SB', (arg) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'subRx', rx: null, subRxEnabled: v === 1 };
    }),
    makeGlobalParser('FT', (arg) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'split', rx: null, splitEnabled: v === 1 };
    }),
    makeGlobalParser('LN', (arg) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'vfoLink', rx: null, linked: v === 1 };
    }),
    makeGlobalParser('MX', (arg) => {
      const mix = arg.trim().toUpperCase();
      return AUDIO_MIX_MODES.includes(mix) ? { kind: 'audioMix', rx: null, mix } : null;
    }),
    makeGlobalParser('EM', (arg) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'encodeMode', rx: null, encodeMode: v };
    }),
    makeGlobalParser('SL', (arg) => {
      const v = parseIntStrict(arg);
      return v === null ? null : { kind: 'streamingLatency', rx: null, streamingLatency: v };
    }),
    makeGlobalParser('ER', (arg) => {
      const t = arg.trim();
      if (!t) return null;
      const m = t.match(/^(\d+)(?::([\s\S]*))?$/);
      return {
        kind: 'radioError',
        rx: null,
        code: m ? parseInt(m[1], 10) : 0,
        message: m ? (m[2] || '').trim() : t,
      };
    }),
    makeGlobalParser('ID', (arg) => {
      const t = arg.trim();
      return t ? { kind: 'radioId', rx: null, id: t } : null;
    }),
    makeGlobalParser('OM', (arg) => {
      const t = arg.trim();
      if (!t) return null;
      return {
        kind: 'optionModule',
        rx: null,
        om: t,
        optionModules: t,
        hasSubRx: t.includes('S'),
      };
    }),
    makeGlobalParser('SN', (arg) => {
      const t = arg.trim();
      return t ? { kind: 'serial', rx: null, serial: t } : null;
    }),
  ].sort((a, b) => b.prefix.length - a.prefix.length);

  function parseAutoRef(arg, rx) {
    const t = arg.trim().toUpperCase();
    if (!t) return null;
    let autoRef = null;
    if (t === 'A' || t === '1' || t === '9') {
      autoRef = true;
    } else if (t === 'M' || t === '0') {
      autoRef = false;
    } else if (t.length >= 2 && (t[t.length - 1] === '1' || t[t.length - 1] === '0')) {
      autoRef = t[t.length - 1] === '1';
    } else {
      return null;
    }
    return { kind: 'autoRef', rx, autoRef };
  }

  function parseMiniPan(arg, rx) {
    const v = parseIntStrict(arg);
    if (v === null) return null;
    if (v === -1) {
      return { kind: 'miniPan', rx, miniPan: false, miniPanAvailable: false };
    }
    return { kind: 'miniPan', rx, miniPan: v === 1, miniPanAvailable: true };
  }

  function parseSMeterBars(arg, rx) {
    const v = parseIntStrict(arg);
    if (v === null) return null;
    const dBm = -127 + (v * 114) / 42;
    return { kind: 'smeterBars', rx, bars: v, dBm };
  }

  function parseStep(arg, rx) {
    const t = arg.trim();
    if (!/^\d/.test(t)) return null;
    const stepIdx = parseInt(t[0], 10);
    if (stepIdx < 0 || stepIdx >= STEP_HZ_TABLE.length) return null;
    const modeCode = t.length >= 2 && /^\d$/.test(t[1]) ? parseInt(t[1], 10) : null;
    return { kind: 'step', rx, stepIdx, stepHz: STEP_HZ_TABLE[stepIdx], modeCode };
  }

  function parsePreamp(arg, rx) {
    const t = arg.trim();
    if (!/^\d{1,2}$/.test(t)) return null;
    if (t.length === 1) {
      const on = t === '1';
      return { kind: 'preamp', rx, preamp: on ? 1 : 0, preampOn: on };
    }
    const n = parseInt(t[0], 10);
    const on = t[1] === '1';
    return { kind: 'preamp', rx, preamp: on ? n : 0, preampOn: on };
  }

  function parseAtten(arg, rx) {
    const t = arg.trim();
    if (!/^\d{1,3}$/.test(t)) return null;
    if (t.length === 1) {
      const on = t === '1';
      return { kind: 'atten', rx, attenDb: on ? 6 : 0, attenOn: on };
    }
    const nn = parseInt(t.slice(0, -1), 10);
    const on = t[t.length - 1] === '1';
    return { kind: 'atten', rx, attenDb: on ? nn : 0, attenOn: on };
  }

  function parseNoiseBlanker(arg, rx) {
    const t = arg.trim();
    if (!/^\d{1,4}$/.test(t)) return null;
    if (t.length === 1) {
      return { kind: 'nb', rx, nbLevel: null, nbOn: t === '1' };
    }
    return {
      kind: 'nb',
      rx,
      nbLevel: parseInt(t.slice(0, -1), 10),
      nbOn: t[t.length - 1] === '1',
    };
  }

  function parseNoiseReduction(arg, rx) {
    const t = arg.trim();
    if (!/^\d{1,3}$/.test(t)) return null;
    if (t.length === 1) {
      return { kind: 'nr', rx, nrLevel: null, nrOn: t === '1' };
    }
    return {
      kind: 'nr',
      rx,
      nrLevel: parseInt(t.slice(0, -1), 10),
      nrOn: t[t.length - 1] === '1',
    };
  }

  function parseNotch(arg, rx) {
    const t = arg.trim();
    if (!/^\d{1,5}$/.test(t)) return null;
    if (t.length === 1) {
      return { kind: 'notch', rx, notchHz: null, notchOn: t === '1' };
    }
    return {
      kind: 'notch',
      rx,
      notchHz: parseInt(t.slice(0, -1), 10),
      notchOn: t[t.length - 1] === '1',
    };
  }

  function parseApf(arg, rx) {
    const t = arg.trim();
    if (!/^\d{1,2}$/.test(t)) return null;
    return {
      kind: 'apf',
      rx,
      apfOn: t[0] === '1',
      apfBwIdx: t.length >= 2 ? parseInt(t[1], 10) : 0,
    };
  }

  function parseBand(arg, rx) {
    const t = arg.trim();
    if (!/^\d{1,2}$/.test(t)) return null;
    return { kind: 'band', rx, bn: t.padStart(2, '0') };
  }

  function parseAdcOverflow(arg, rx) {
    const t = arg.trim();
    if (!/^[01]{1,2}$/.test(t)) return null;
    return {
      kind: 'adcOverflow',
      rx,
      adcOverflow: t[0] === '1',
      cor: t.length >= 2 ? t[1] === '1' : false,
    };
  }

  /**
   * Parse a single K4 CAT frame (with or without trailing semicolon) into a structured descriptor.
   * @param {string} rawCmd
   * @returns {Object|null}
   */
  function parseCommand(rawCmd) {
    if (typeof rawCmd !== 'string') return null;

    // Handle TB/TB$ before trimming or stripping trailing semicolons, which could be part of decoded text.
    const leadingTrimmed = rawCmd.replace(/^\s+/, '');
    const tbMatch = leadingTrimmed.match(/^TB(\$?)([0-9])([0-9]{2})([\s\S]*)$/);
    if (tbMatch) {
      const rx = tbMatch[1] === '$' ? 'B' : 'A';
      const txQueued = parseInt(tbMatch[2], 10);
      const count = parseInt(tbMatch[3], 10);
      const text = tbMatch[4].slice(0, count);
      return { kind: 'decodedText', rx, txQueued, text };
    }

    let cmd = rawCmd.trim();
    if (cmd.endsWith(';')) {
      cmd = cmd.slice(0, -1).trim();
    }
    if (!cmd || cmd === '?') return null;

    const upper = cmd.toUpperCase();
    for (let i = 0; i < PARSERS.length; i++) {
      const entry = PARSERS[i];
      if (upper.startsWith(entry.prefix)) {
        const arg = cmd.slice(entry.prefix.length);
        return entry.fn(arg);
      }
    }
    return null;
  }

  function rxDollar(rx) {
    return rx === 'B' ? '$' : '';
  }

  const builders = {
    freq(rx, hz) {
      const vfo = rx === 'B' ? 'B' : 'A';
      const clamped = Math.round(clamp(Number(hz), 100000, 54000000));
      return 'F' + vfo + String(clamped).padStart(11, '0') + ';';
    },
    mode(rx, code) {
      return 'MD' + rxDollar(rx) + Math.round(Number(code)) + ';';
    },
    dataSubMode(rx, sub) {
      return 'DT' + rxDollar(rx) + clamp(Math.round(Number(sub)), 0, 3) + ';';
    },
    bw(rx, bwHz) {
      const units = Math.round(clamp(Number(bwHz), 50, 5000) / 10);
      return 'BW' + rxDollar(rx) + String(units).padStart(4, '0') + ';';
    },
    ifShift(rx, hz) {
      const units = Math.round(clamp(Number(hz), 0, 5000) / 10);
      return 'IS' + rxDollar(rx) + String(units).padStart(4, '0') + ';';
    },
    cwPitch(hz) {
      const units = Math.round(clamp(Number(hz), 250, 950) / 10);
      return 'CW' + String(units).padStart(2, '0') + ';';
    },
    step(rx, idx, modeCode) {
      const clampedIdx = clamp(Math.round(Number(idx)), 0, 6);
      const modeSuffix = modeCode === undefined || modeCode === null ? '' : String(modeCode);
      return 'VT' + rxDollar(rx) + clampedIdx + modeSuffix + ';';
    },
    lock(rx, on) {
      return 'LK' + rxDollar(rx) + (on ? '1' : '0') + ';';
    },
    subRx(on) {
      return 'SB' + (on ? '1' : '0') + ';';
    },
    band(rx, bn) {
      return 'BN' + rxDollar(rx) + String(bn).padStart(2, '0') + ';';
    },
    preamp(rx, level) {
      const lvl = clamp(Math.round(Number(level)), 0, 3);
      return 'PA' + rxDollar(rx) + (lvl > 0 ? `${lvl}1` : '00') + ';';
    },
    atten(rx, db) {
      const n = Number(db);
      const val = n > 0 ? clamp(Math.round(n / 3) * 3, 3, 21) : 0;
      return 'RA' + rxDollar(rx) + String(val).padStart(2, '0') + (n > 0 ? '1' : '0') + ';';
    },
    afGain(rx, val) {
      const v = clamp(Math.round(Number(val)), 0, 60);
      return 'AG' + rxDollar(rx) + String(v).padStart(3, '0') + ';';
    },
    rfGain(rx, db) {
      const v = clamp(Math.round(Number(db)), -60, 0);
      return 'RG' + rxDollar(rx) + (v === 0 ? '00' : String(v)) + ';';
    },
    squelch(rx, val) {
      const v = clamp(Math.round(Number(val)), 0, 40);
      return 'SQ' + rxDollar(rx) + String(v).padStart(3, '0') + ';';
    },
    nb(rx, level, on) {
      const lvl = clamp(Math.round(Number(level)), 0, 15);
      return 'NB' + rxDollar(rx) + String(lvl).padStart(2, '0') + (on ? '1' : '0') + ';';
    },
    nr(rx, level, on) {
      const lvl = clamp(Math.round(Number(level)), 0, 10);
      return 'NR' + rxDollar(rx) + String(lvl).padStart(2, '0') + (on ? '1' : '0') + ';';
    },
    notch(rx, hz, on) {
      const f = clamp(Math.round(Number(hz)), 150, 5000);
      return 'NM' + rxDollar(rx) + String(f).padStart(4, '0') + (on ? '1' : '0') + ';';
    },
    agc(rx, mode) {
      return 'GT' + rxDollar(rx) + clamp(Math.round(Number(mode)), 0, 2) + ';';
    },
    apf(rx, on, bwIdx = 0) {
      const bw = clamp(Math.round(Number(bwIdx)), 0, 2);
      return 'AP' + rxDollar(rx) + (on ? '1' : '0') + bw + ';';
    },
    panSpan(rx, spanHz) {
      return '#SPN' + rxDollar(rx) + Math.round(clamp(Number(spanHz), 6000, 368000)) + ';';
    },
    panRef(rx, refDbm) {
      return '#REF' + rxDollar(rx) + Math.round(clamp(Number(refDbm), -160, 20)) + ';';
    },
    panScale(rx, scaleDb) {
      return '#SCL' + rxDollar(rx) + Math.round(clamp(Number(scaleDb), 10, 150)) + ';';
    },
    panAvg(avg) {
      return '#AVG' + String(clamp(Math.round(Number(avg)), 1, 20)).padStart(2, '0') + ';';
    },
    wfBlack(rx, wbs) {
      return '#WBS' + rxDollar(rx) + Math.round(clamp(Number(wbs), 5, 30)) + ';';
    },
    autoRef(rx, on) {
      return '#AR' + rxDollar(rx) + (on ? 'A' : 'M') + ';';
    },
    dualPan(mode) {
      return '#DPM' + clamp(Math.round(Number(mode)), 0, 2) + ';';
    },
    miniPan(rx, on) {
      return '#MP' + rxDollar(rx) + (on ? '1' : '0') + ';';
    },
    centerPan(rx, offsetHz) {
      if (offsetHz !== undefined && offsetHz !== null) {
        const raw = Number(offsetHz);
        if (Number.isFinite(raw) && raw !== 0) {
          const off = Math.round(raw);
          if (off !== 0) {
            return 'FC' + rxDollar(rx) + (off > 0 ? '+' + off : String(off)) + ';';
          }
        }
      }
      return 'FC' + rxDollar(rx) + ';';
    },
    rit(rx, on) {
      return 'RT' + rxDollar(rx) + (on ? '1' : '0') + ';';
    },
    ritOffset(rx, hz) {
      const raw = Number(hz);
      const v = Math.round(clamp(Number.isFinite(raw) ? raw : 0, -9999, 9999));
      return 'RO' + rxDollar(rx) + (v < 0 ? '-' : '+') + String(Math.abs(v)).padStart(4, '0') + ';';
    },
    freezePan(on) {
      return '#FRZ' + (on ? '1' : '0') + ';';
    },
    fixedTune(on) {
      return '#FXT' + (on ? '1' : '0') + ';';
    },
    diversity(on) {
      return 'DV' + (on ? '1' : '0') + ';';
    },
    audioMix(mix) {
      const m = String(mix).trim().toUpperCase();
      if (!AUDIO_MIX_MODES.includes(m)) {
        throw new RangeError(`Invalid K4 audio mix preset: ${mix}`);
      }
      return 'MX' + m + ';';
    },
    encodeMode(em) {
      return 'EM' + clamp(Math.round(Number(em)), 0, 3) + ';';
    },
    streamingLatency(sl) {
      return 'SL' + clamp(Math.round(Number(sl)), 0, 7) + ';';
    },
    ping(epochSec) {
      return 'PING' + Math.floor(Number(epochSec)) + ';';
    },
  };

  K4.MODES = MODES;
  K4.DATA_SUBMODES = DATA_SUBMODES;
  K4.STEP_HZ_TABLE = STEP_HZ_TABLE;
  K4.SL_FRAMES_TABLE = SL_FRAMES_TABLE;
  K4.SL_TARGET_MS_TABLE = SL_TARGET_MS_TABLE;
  K4.BANDS = BANDS;
  K4.AUDIO_MIX_MODES = AUDIO_MIX_MODES;

  K4.CatCodec = {
    splitFrames,
    parseCommand,
    sUnitForDbm,
    builders,
  };
})();
