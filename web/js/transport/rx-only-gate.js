'use strict';

(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const VALID_POLICIES = new Set(['rx-only', 'tx-enabled']);

  // Explicit TX, keyer, DVR, power, remote-admin, hardware-config, and front-panel switch prefixes blocked in rx-only mode.
  const BLOCKED_PREFIXES = [
    'DARM',
    'DAPM',
    'DAMP',
    'DARC',
    'SWT',
    'SWH',
    'MOX',
    'VOX',
    '#TX',
    '#CAL',
    'SP1',
    'SP2',
    'SP3',
    'ACT',
    'KZL',
    'KZF',
    'RRP',
    'RRC',
    'RRT',
    'TX',
    'TU',
    'KY',
    'KZ',
    'PB',
    'PC',
    'EC',
    'EE',
    'LB',
    'PS',
    'SW',
    'VX',
    'CP',
    'MG',
    'ML',
    'KP',
    'KS',
    'ES',
    'DW',
    'DR',
    'AT',
    'TE',
    'TG',
    'TM',
    'DO',
    'XF',
    'XT',
    'TS',
    'DM',
    'PK',
    'PL',
    'RP',
    'MI',
    'MS',
    'VG',
    'VI',
    'SD',
    'RS',
    'MB',
  ].sort((a, b) => b.length - a.length);

  // Permitted RX, panadapter, audio, and session prefixes (checked longest-first).
  const ALLOWED_PREFIXES = [
    'PING',
    'PONG',
    'SMH',
    'RDY',
    'RRN',
    'DNB',
    'UPB',
    'FA',
    'FB',
    'MD',
    'DT',
    'BW',
    'IS',
    'CW',
    'VT',
    'LK',
    'BN',
    'SB',
    'LN',
    'PA',
    'RA',
    'AG',
    'RG',
    'SQ',
    'NB',
    'NR',
    'NM',
    'NA',
    'GT',
    'AP',
    'AR',
    'MX',
    'BL',
    'RD',
    'RU',
    'RC',
    'TD',
    'TB',
    'EM',
    'SL',
    'K4',
    'ER',
    'AI',
    'SM',
    'DV',
    'OV',
    'FI',
    'FC',
    'RT',
    'RO',
    'VC',
    'FP',
    'MA',
    'DN',
    'UP',
  ].sort((a, b) => b.length - a.length);

  const ALLOWED_HASH_PREFIXES = [
    '#HREF',
    '#HWBS',
    '#HWFC',
    '#HWFH',
    '#HDPM',
    '#SPN',
    '#REF',
    '#SCL',
    '#AVG',
    '#WBS',
    '#WFC',
    '#WFH',
    '#DPM',
    '#FRZ',
    '#FXT',
    '#FXA',
    '#FSL',
    '#PKM',
    '#FPS',
    '#CWT',
    '#VFA',
    '#VFB',
    '#MKA',
    '#MKB',
    '#DSM',
    '#HDM',
    '#HDS',
    '#UNM',
    '#NBL',
    '#SFL',
    '#AR',
    '#MP',
    '#NB',
  ];

  function matchPrefixBoundary(cmdUpper, prefix) {
    if (!cmdUpper.startsWith(prefix)) return false;
    if (cmdUpper.length === prefix.length) return true;
    const next = cmdUpper[prefix.length];
    if (prefix === 'VC' && next === '$') return false;
    // K4 CAT prefixes are separated from args by $, digits, sign, query, toggle, or space.
    return (
      next === '$' ||
      next === '+' ||
      next === '-' ||
      next === '/' ||
      next === '\\' ||
      next === ' ' ||
      next === '~' ||
      next === '?' ||
      (next >= '0' && next <= '9') ||
      prefix === 'MX' ||
      prefix === '#AR'
    );
  }

  function isCatAllowedInRxOnly(cmdUpper) {
    if (
      cmdUpper === 'RX' ||
      cmdUpper === 'SP0' ||
      cmdUpper === 'ID' ||
      cmdUpper === 'OM' ||
      cmdUpper === 'SN' ||
      cmdUpper === 'RV' ||
      cmdUpper === 'AN' ||
      cmdUpper === 'FT' ||
      cmdUpper === 'FT0' ||
      cmdUpper === 'IF' ||
      cmdUpper === 'TQ' ||
      cmdUpper === 'IN' ||
      cmdUpper === 'BG' ||
      cmdUpper === 'PP' ||
      cmdUpper === 'PP1' ||
      /^PP\d{2}$/.test(cmdUpper)
    ) {
      return { allowed: true, reason: null };
    }

    if (cmdUpper.startsWith('SP')) {
      return { allowed: false, reason: 'TX spot/sidetone command blocked in rx-only mode' };
    }

    for (let i = 0; i < BLOCKED_PREFIXES.length; i++) {
      const bp = BLOCKED_PREFIXES[i];
      if (cmdUpper.startsWith(bp)) {
        return { allowed: false, reason: `Command prefix ${bp} blocked in rx-only mode` };
      }
    }

    if (cmdUpper.startsWith('#')) {
      for (let i = 0; i < ALLOWED_HASH_PREFIXES.length; i++) {
        if (matchPrefixBoundary(cmdUpper, ALLOWED_HASH_PREFIXES[i])) {
          return { allowed: true, reason: null };
        }
      }
      return { allowed: false, reason: 'Unrecognized # command blocked by default-deny rx-only policy' };
    }

    for (let i = 0; i < ALLOWED_PREFIXES.length; i++) {
      const ap = ALLOWED_PREFIXES[i];
      if (matchPrefixBoundary(cmdUpper, ap)) {
        return { allowed: true, reason: null };
      }
      // Allow K40 / K41 / K4 and AI0..AI5 and ER0..ER1 and RDY and RRN and MX<preset>.
      if (ap === 'MX' && cmdUpper.startsWith('MX')) {
        return { allowed: true, reason: null };
      }
    }

    return { allowed: false, reason: 'Unrecognized command blocked by default-deny rx-only policy' };
  }

  /**
   * Client-side safety gate enforcing rx-only CAT and outbound binary packet rules.
   */
  class RxOnlyGate extends K4.EventEmitter {
    /**
     * @param {string|{policy?: string}} [policyOrOpts='rx-only']
     */
    constructor(policyOrOpts = 'rx-only') {
      super();
      const rawPolicy =
        typeof policyOrOpts === 'object' && policyOrOpts !== null
          ? policyOrOpts.policy
          : policyOrOpts;
      const policy = rawPolicy || 'rx-only';
      if (!VALID_POLICIES.has(policy)) {
        throw new RangeError(`Unsupported RxOnlyGate policy: ${policy}`);
      }
      this._policy = policy;
      this._stats = {
        blockedCatCount: 0,
        blockedBinaryCount: 0,
        recentBlocked: [],
      };
    }

    /**
     * Return active gate policy ('rx-only' or 'tx-enabled').
     * @returns {string}
     */
    getPolicy() {
      return this._policy;
    }

    _recordBlocked(entry) {
      this._stats.recentBlocked.push(entry);
      if (this._stats.recentBlocked.length > 25) {
        this._stats.recentBlocked.shift();
      }
      this.emit('blocked', entry);
    }

    /**
     * Inspect a CAT command string (possibly batched with semicolons) against the active policy.
     * @param {string} cmdStr
     * @returns {{ allowed: string[], blocked: string[], sanitized: string }}
     */
    inspectCat(cmdStr) {
      const allowed = [];
      const blocked = [];
      if (typeof cmdStr !== 'string' || cmdStr.trim().length === 0) {
        return { allowed, blocked, sanitized: '' };
      }

      const splitter = K4.CatCodec && K4.CatCodec.splitFrames;
      const tokens = splitter
        ? splitter(cmdStr)
        : cmdStr
            .split(';')
            .map((s) => s.trim())
            .filter(Boolean);

      for (let i = 0; i < tokens.length; i++) {
        const rawToken = tokens[i].trim();
        if (!rawToken) continue;
        const upperToken = rawToken.toUpperCase();
        const terminated = upperToken + ';';

        if (this._policy === 'tx-enabled') {
          allowed.push(terminated);
          continue;
        }

        const verdict = isCatAllowedInRxOnly(upperToken);
        if (verdict.allowed) {
          allowed.push(terminated);
        } else {
          blocked.push(terminated);
          this._stats.blockedCatCount++;
          this._recordBlocked({
            kind: 'cat',
            command: terminated,
            reason: verdict.reason,
            timestamp: Date.now(),
          });
        }
      }

      return {
        allowed,
        blocked,
        sanitized: allowed.join(''),
      };
    }

    /**
     * Inspect an outbound K4 binary packet type byte.
     * In rx-only mode, only 0x00 (CAT) is permitted; outbound 0x01 audio is blocked.
     * @param {number} typeByte
     * @returns {boolean}
     */
    inspectBinary(typeByte) {
      if (this._policy === 'tx-enabled') {
        return true;
      }
      if (typeByte === 0x00) {
        return true;
      }
      this._stats.blockedBinaryCount++;
      this._recordBlocked({
        kind: 'binary',
        typeByte,
        reason: `Outbound binary packet type 0x${Number(typeByte).toString(16).padStart(2, '0')} blocked in rx-only mode`,
        timestamp: Date.now(),
      });
      return false;
    }

    /**
     * Return gate statistics and a copy of recent blocked entries (max 25).
     * @returns {Object}
     */
    getStats() {
      return {
        policy: this._policy,
        blockedCatCount: this._stats.blockedCatCount,
        blockedBinaryCount: this._stats.blockedBinaryCount,
        totalBlockedCount: this._stats.blockedCatCount + this._stats.blockedBinaryCount,
        recentBlocked: this._stats.recentBlocked.slice(),
      };
    }
  }

  K4.RxOnlyGate = RxOnlyGate;
})();
