'use strict';
(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const MODE_ALIASES = {
    lsb: { key: 'LSB', sub: null, label: 'LSB' },
    usb: { key: 'USB', sub: null, label: 'USB' },
    cw: { key: 'CW', sub: null, label: 'CW' },
    'cw-r': { key: 'CW-R', sub: null, label: 'CW-R' },
    cwr: { key: 'CW-R', sub: null, label: 'CW-R' },
    data: { key: 'DATA', sub: 0, label: 'DATA-A' },
    'data-a': { key: 'DATA', sub: 0, label: 'DATA-A' },
    afsk: { key: 'DATA', sub: 1, label: 'AFSK-A' },
    'afsk-a': { key: 'DATA', sub: 1, label: 'AFSK-A' },
    fsk: { key: 'DATA', sub: 2, label: 'FSK-D' },
    'fsk-d': { key: 'DATA', sub: 2, label: 'FSK-D' },
    psk: { key: 'DATA', sub: 3, label: 'PSK-D' },
    'psk-d': { key: 'DATA', sub: 3, label: 'PSK-D' },
    am: { key: 'AM', sub: null, label: 'AM' },
    fm: { key: 'FM', sub: null, label: 'FM' },
  };

  const DEFAULT_PRESETS = [
    { id: 'ft8-20', title: '14.074 MHz — 20m FT8', sub: 'Tune active VFO to 14,074,000 Hz', tag: '14.074', query: '14.074' },
    { id: 'cw-20', title: '14.025 MHz — 20m CW Beacon', sub: 'Tune active VFO to 14,025,000 Hz', tag: '14.025', query: '14.025' },
    { id: 'ft8-40', title: '7.074 MHz — 40m FT8', sub: 'Tune active VFO to 7,074,000 Hz', tag: '7.074', query: '7.074' },
    { id: 'cw-40', title: '7.025 MHz — 40m CW', sub: 'Tune active VFO to 7,025,000 Hz', tag: '7.025', query: '7.025' },
    { id: 'auto-spot', title: 'Auto Spot CW', sub: 'Zero-beat active VFO on CW signal', tag: 'SPOT', query: 'auto spot' },
    { id: 'span-48', title: 'Span 48 kHz', sub: 'Set panadapter span to 48 kHz', tag: 'SPAN', query: 'span 48k' },
    { id: 'sub-toggle', title: 'Toggle Sub Receiver', sub: 'Enable or disable VFO B Sub RX', tag: 'SUB', query: 'sub' },
  ];

  function formatHz(hz) {
    const mhz = (hz / 1e6).toFixed(6).replace(/(\.\d{3})(\d{3})$/, '$1.$2');
    return `${mhz} MHz`;
  }

  function parseFreqToken(str) {
    const s = str.trim().toLowerCase().replace(/,/g, '');
    let m = s.match(/^(\d+(?:\.\d+)?)\s*mhz$/);
    if (m) {
      const hz = Math.round(parseFloat(m[1]) * 1e6);
      return hz >= 100000 && hz <= 54000000 ? hz : null;
    }
    m = s.match(/^(\d+(?:\.\d+)?)\s*(?:khz|k)$/);
    if (m) {
      const hz = Math.round(parseFloat(m[1]) * 1e3);
      return hz >= 100000 && hz <= 54000000 ? hz : null;
    }
    m = s.match(/^(\d+)\s*hz$/);
    if (m) {
      const hz = parseInt(m[1], 10);
      return hz >= 100000 && hz <= 54000000 ? hz : null;
    }
    if (/^\d+\.\d+$/.test(s)) {
      const num = parseFloat(s);
      if (num >= 0.1 && num <= 54.0) return Math.round(num * 1e6);
      if (num > 54.0 && num <= 54000) return Math.round(num * 1e3);
      return null;
    }
    if (/^\d+$/.test(s)) {
      const n = parseInt(s, 10);
      if (n >= 100000 && n <= 54000000) return n;
      if (n >= 100 && n <= 54000) return n * 1000;
      if (n >= 1 && n <= 54) return n * 1000000;
    }
    return null;
  }

  class Omnibar {
    constructor(opts) {
      this.modal = opts.modal;
      this.client = opts.client;
      this.state = opts.state;
      this.getTargetRx = opts.getTargetRx || (() => 'A');
      this.onSetTargetRx = opts.onSetTargetRx || (() => {});
      this.onSetPalette = opts.onSetPalette || (() => {});
      this.onToggleAudio = opts.onToggleAudio || (() => {});
      this.onNotify = opts.onNotify || (() => {});

      this._isOpen = false;
      this._items = [];
      this._selectedIdx = 0;
      this._buildDom();
    }

    _buildDom() {
      const modal = this.modal;
      modal.textContent = '';

      const card = document.createElement('div');
      card.className = 'k4-modal-card k4-omnibar-card';
      card.addEventListener('click', (e) => e.stopPropagation());

      const wrap = document.createElement('div');
      wrap.className = 'k4-omnibar-input-wrap';

      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 16 16');
      icon.setAttribute('width', '16');
      icon.setAttribute('height', '16');
      icon.setAttribute('aria-hidden', 'true');
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', '7');
      circle.setAttribute('cy', '7');
      circle.setAttribute('r', '4.8');
      circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', 'currentColor');
      circle.setAttribute('stroke-width', '1.5');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M10.7 10.7L14 14');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.6');
      path.setAttribute('stroke-linecap', 'round');
      icon.appendChild(circle);
      icon.appendChild(path);
      wrap.appendChild(icon);

      this.inputEl = document.createElement('input');
      this.inputEl.type = 'text';
      this.inputEl.className = 'k4-omnibar-input';
      this.inputEl.dataset.testid = 'omnibar-input';
      this.inputEl.placeholder = 'Type frequency (14.074, 7025), band (20m), mode (cw), span 48k, sub on, vfo b 14025...';
      this.inputEl.autocomplete = 'off';
      this.inputEl.spellcheck = false;
      wrap.appendChild(this.inputEl);

      const escHint = document.createElement('kbd');
      escHint.className = 'k4-kbd-hint';
      escHint.textContent = 'ESC';
      wrap.appendChild(escHint);
      card.appendChild(wrap);

      this.listEl = document.createElement('div');
      this.listEl.className = 'k4-omnibar-list';
      this.listEl.setAttribute('role', 'listbox');
      card.appendChild(this.listEl);

      modal.appendChild(card);

      modal.addEventListener('click', () => this.close());
      this.inputEl.addEventListener('input', () => this._refresh());
      this.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (this._items.length > 0) {
            this._selectedIdx = (this._selectedIdx + 1) % this._items.length;
            this._renderList();
          }
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (this._items.length > 0) {
            this._selectedIdx = (this._selectedIdx - 1 + this._items.length) % this._items.length;
            this._renderList();
          }
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (this._items.length > 0) {
            this._executeItem(this._items[this._selectedIdx] || this._items[0]);
          }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.close();
        }
      });
    }

    isOpen() {
      return this._isOpen;
    }

    open(initialValue) {
      this._isOpen = true;
      this.modal.hidden = false;
      this.modal.dataset.open = 'true';
      this.inputEl.value = typeof initialValue === 'string' ? initialValue : '';
      this._selectedIdx = 0;
      this._refresh();
      requestAnimationFrame(() => {
        this.inputEl.focus();
        this.inputEl.select();
      });
    }

    close() {
      if (!this._isOpen) return;
      this._isOpen = false;
      if (this.modal.contains(document.activeElement) && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
      this.modal.dataset.open = 'false';
      this.modal.hidden = true;
    }

    _parseQuery(raw) {
      const trimmed = raw.trim();
      if (!trimmed) {
        return DEFAULT_PRESETS.map((p) => ({
          title: p.title,
          sub: p.sub,
          tag: p.tag,
          run: () => this._runCommandString(p.query),
        }));
      }

      const items = [];

      const parsed = this._buildAction(trimmed);
      if (parsed) {
        items.push(parsed);
      }

      const lower = trimmed.toLowerCase();
      const bands = Array.isArray(K4.BANDS) ? K4.BANDS : [];
      for (let i = 0; i < bands.length; i++) {
        const b = bands[i];
        if (b.id.toLowerCase().includes(lower) || b.label.toLowerCase().includes(lower)) {
          const already = parsed && parsed.tag === b.label.toUpperCase();
          if (!already) {
            items.push({
              title: `Band ${b.label} (${formatHz(b.defaultHz)})`,
              sub: `Switch VFO ${this.getTargetRx()} to ${b.label}`,
              tag: b.label,
              run: () => this.client.setBand(this.getTargetRx(), b),
            });
          }
        }
      }

      const bookmarks = K4.BookmarkStore ? K4.BookmarkStore.list() : [];
      for (let i = 0; i < bookmarks.length; i++) {
        const bm = bookmarks[i];
        const mhzStr = (bm.freqHz / 1e6).toFixed(4);
        if (
          !lower ||
          bm.label.toLowerCase().includes(lower) ||
          String(bm.freqHz).includes(lower) ||
          mhzStr.includes(lower)
        ) {
          items.push({
            title: bm.label,
            sub: `${mhzStr} MHz · Recall saved bookmark`,
            tag: 'BOOKMARK',
            run: () => this._recallBookmark(bm),
          });
        }
      }

      for (let i = 0; i < DEFAULT_PRESETS.length; i++) {
        const p = DEFAULT_PRESETS[i];
        if (p.title.toLowerCase().includes(lower) || p.query.toLowerCase().includes(lower)) {
          items.push({
            title: p.title,
            sub: p.sub,
            tag: p.tag,
            run: () => this._runCommandString(p.query),
          });
        }
      }

      return items;
    }

    _recallBookmark(bm) {
      if (!bm || !this.client) return;
      const rx = typeof this.getTargetRx === 'function' ? this.getTargetRx() : 'A';
      this.client.tune(rx, bm.freqHz, { optimistically: true });
      if (bm.mode != null) {
        this.client.setMode(rx, bm.mode, bm.dataSubMode || 0);
      }
      if (bm.bwHz != null && typeof this.client.setFilter === 'function') {
        this.client.setFilter(rx, { bwHz: bm.bwHz });
      }
      if (typeof this.onNotify === 'function') {
        this.onNotify(`Recalled ${bm.label} (${(bm.freqHz / 1e6).toFixed(4)} MHz)`, 'info');
      }
    }

    _runCommandString(str) {
      const action = this._buildAction(str);
      if (action && action.run) action.run();
    }

    _buildAction(raw) {
      let targetRx = this.getTargetRx();
      let expr = raw.trim();

      const vfoPrefix = expr.match(/^(?:vfo\s+)?([ab])\s+(.+)$/i);
      if (vfoPrefix) {
        targetRx = vfoPrefix[1].toUpperCase();
        expr = vfoPrefix[2].trim();
      }

      const lower = expr.toLowerCase();

      // Band match (e.g. "20m", "40m")
      const bands = Array.isArray(K4.BANDS) ? K4.BANDS : [];
      for (let i = 0; i < bands.length; i++) {
        const b = bands[i];
        if (b.id.toLowerCase() === lower || b.label.toLowerCase() === lower) {
          return {
            title: `Band ${b.label} on VFO ${targetRx}`,
            sub: `Tune VFO ${targetRx} to ${formatHz(b.defaultHz)}`,
            tag: b.label.toUpperCase(),
            run: () => {
              this.client.setBand(targetRx, b);
            },
          };
        }
      }

      // Mode match
      if (MODE_ALIASES[lower]) {
        const m = MODE_ALIASES[lower];
        return {
          title: `Mode ${m.label} on VFO ${targetRx}`,
          sub: `Set VFO ${targetRx} mode to ${m.label}`,
          tag: m.label,
          run: () => {
            this.client.setMode(targetRx, m.key, m.sub !== null ? m.sub : undefined);
          },
        };
      }

      // Span match ("span 48k", "spn 24", "span 96000")
      const spanMatch = lower.match(/^(?:span|spn)\s+(\d+(?:\.\d+)?)\s*(k|khz|hz)?$/);
      if (spanMatch) {
        let hz = parseFloat(spanMatch[1]);
        if (spanMatch[2] === 'k' || spanMatch[2] === 'khz' || (!spanMatch[2] && hz < 1000)) {
          hz *= 1000;
        }
        hz = Math.max(6000, Math.min(368000, Math.round(hz)));
        const snap = this.state.getSnapshot ? this.state.getSnapshot() : this.state;
        const dispRx =
          K4.CatCodec && typeof K4.CatCodec.resolveDisplayRx === 'function'
            ? K4.CatCodec.resolveDisplayRx(snap, targetRx)
            : targetRx;
        return {
          title: `Panadapter Span ${Math.round(hz / 1000)} kHz`,
          sub: `Set PAN ${dispRx} spectrum span (#SPN)`,
          tag: `${Math.round(hz / 1000)} kHz`,
          run: () => {
            this.client.setDisplay(dispRx, { panSpanHz: hz });
          },
        };
      }

      // Filter BW ("bw 500", "bw 2.4k")
      const bwMatch = lower.match(/^bw\s+(\d+(?:\.\d+)?)\s*(k|khz|hz)?$/);
      if (bwMatch) {
        let hz = parseFloat(bwMatch[1]);
        if (bwMatch[2] === 'k' || bwMatch[2] === 'khz' || (!bwMatch[2] && hz < 15)) {
          hz *= 1000;
        }
        hz = Math.max(50, Math.min(5000, Math.round(hz)));
        return {
          title: `Filter Width ${hz} Hz on VFO ${targetRx}`,
          sub: `Send BW${targetRx === 'B' ? '$' : ''}`,
          tag: `${hz} Hz`,
          run: () => {
            if (typeof this.client.setFilter === 'function') {
              this.client.setFilter(targetRx, { bwHz: hz });
            } else {
              const cmd = K4.CatCodec && K4.CatCodec.builders && K4.CatCodec.builders.bw
                ? K4.CatCodec.builders.bw(targetRx, hz)
                : `BW${targetRx === 'B' ? '$' : ''}${String(Math.round(hz / 10)).padStart(4, '0')};`;
              this.client.sendCat(cmd);
            }
          },
        };
      }

      // Sub RX ("sub", "sub on", "sub off")
      const subMatch = lower.match(/^sub(?:\s+(on|off))?$/);
      if (subMatch) {
        const snap = this.state.getSnapshot ? this.state.getSnapshot() : this.state;
        const next = subMatch[1] ? subMatch[1] === 'on' : !snap.subRxEnabled;
        return {
          title: `Sub Receiver ${next ? 'ON' : 'OFF'}`,
          sub: `Send SB${next ? '1' : '0'};`,
          tag: next ? 'SUB ON' : 'SUB OFF',
          run: () => {
            if (typeof this.client.setSubRx === 'function') {
              this.client.setSubRx(next);
            } else {
              const cmd = K4.CatCodec && K4.CatCodec.builders && K4.CatCodec.builders.subRx
                ? K4.CatCodec.builders.subRx(next)
                : `SB${next ? '1' : '0'};`;
              this.client.sendCat(cmd);
            }
          },
        };
      }

      // Dual-pan & Mini-pan
      const dualMatch = lower.match(/^dual(?:\s+(on|off))?$/);
      if (dualMatch) {
        const snap = this.state.getSnapshot ? this.state.getSnapshot() : this.state;
        const next = dualMatch[1] ? (dualMatch[1] === 'on' ? 2 : 0) : (snap.dualPanMode === 2 ? 0 : 2);
        return {
          title: `Dual Panadapter ${next === 2 ? 'ON (2x)' : 'OFF (1x)'}`,
          sub: `Toggle Dual Panadapter ${next === 2 ? 'ON' : 'OFF'}`,
          tag: next === 2 ? '2x PAN' : '1x PAN',
          run: () => {
            this.client.setDisplay(targetRx, { dualPanMode: next });
          },
        };
      }

      const miniPanMatch = lower.match(/^mini-?pan(?:\s+(on|off))?$/);
      if (miniPanMatch) {
        const snap = this.state.getSnapshot ? this.state.getSnapshot() : this.state;
        const rxS = targetRx === 'B' ? snap.rxB : snap.rxA;
        const next = miniPanMatch[1] ? miniPanMatch[1] === 'on' : !(rxS && rxS.miniPan);
        return {
          title: `Mini-Pan ${targetRx} ${next ? 'ON' : 'OFF'}`,
          sub: `Toggle Mini-Pan ${targetRx}`,
          tag: next ? `MINI-PAN ${targetRx} ON` : `MINI-PAN ${targetRx} OFF`,
          run: () => {
            this.client.setDisplay(targetRx, { miniPan: next });
          },
        };
      }

      // CW Auto Spot & Spot Tone
      const autoSpotMatch = lower.match(/^(?:auto[\s-]?spot|zero[\s-]?beat)(?:\s+cw)?$/);
      if (autoSpotMatch) {
        return {
          title: `Auto Spot CW (VFO ${targetRx})`,
          sub: `Zero-beat CW carrier on VFO ${targetRx}`,
          tag: 'SPOT',
          run: () => {
            if (typeof this.client.autoSpot === 'function') {
              this.client.autoSpot(targetRx);
            } else {
              this.client.sendCat(`SP${targetRx === 'B' ? '$' : ''}3;`);
            }
          },
        };
      }

      const spotMatch = lower.match(/^spot(?:\s+(on|off|auto))?$/);
      if (spotMatch) {
        const arg = spotMatch[1] || 'auto';
        if (arg === 'on' || arg === 'off') {
          const on = arg === 'on';
          return {
            title: `CW Spot Tone ${on ? 'ON' : 'OFF'}`,
            sub: `${on ? 'Enable' : 'Disable'} CW sidetone pitch spotting`,
            tag: 'SPOT',
            run: () => {
              if (typeof this.client.setSpotTone === 'function') {
                this.client.setSpotTone(on ? 1 : 0, 'A');
              } else {
                this.client.sendCat(`SP${on ? '1' : '0'};`);
              }
            },
          };
        }
        return {
          title: `Auto Spot CW (VFO ${targetRx})`,
          sub: `Zero-beat CW carrier on VFO ${targetRx}`,
          tag: 'SPOT',
          run: () => {
            if (typeof this.client.autoSpot === 'function') {
              this.client.autoSpot(targetRx);
            } else {
              this.client.sendCat(`SP${targetRx === 'B' ? '$' : ''}3;`);
            }
          },
        };
      }

      // VFO Copy / Swap / Split / ATU / Antenna / Power
      if (lower === 'a/b' || lower === 'swap') {
        return {
          title: 'Swap VFO A / B Frequencies',
          sub: 'Exchange VFO A and VFO B frequencies',
          tag: 'A/B',
          run: () => (typeof this.client.vfoCopy === 'function' ? this.client.vfoCopy(2) : this.client.sendCat('AB2;')),
        };
      }
      if (lower === 'a>b' || lower === 'a->b' || lower === 'a2b') {
        return {
          title: 'Copy VFO A → VFO B',
          sub: 'Copy VFO A frequency to VFO B',
          tag: 'A►B',
          run: () => (typeof this.client.vfoCopy === 'function' ? this.client.vfoCopy(0) : this.client.sendCat('AB0;')),
        };
      }
      const splitMatch = lower.match(/^(split|quick\s*split)(?:\s+(on|off))?$/);
      if (splitMatch) {
        const snap = this.state.getSnapshot ? this.state.getSnapshot() : this.state;
        const isQuick = splitMatch[1].includes('quick');
        if (isQuick && typeof this.client.setupQuickSplit === 'function') {
          return {
            title: 'Quick Split (+1 kHz)',
            sub: 'Copy VFO A to B (+1 kHz) and enable Split TX',
            tag: 'SPLIT',
            run: () => this.client.setupQuickSplit(1000),
          };
        }
        const next = splitMatch[2] ? splitMatch[2] === 'on' : !snap.splitEnabled;
        return {
          title: `Split TX ${next ? 'ON' : 'OFF'}`,
          sub: `${next ? 'Transmit on VFO B' : 'Transmit on VFO A'}`,
          tag: 'SPLIT',
          run: () => this.client.setSplit(next),
        };
      }
      if (lower === 'atu' || lower === 'atu tune' || lower === 'tune') {
        return {
          title: 'ATU Tune',
          sub: 'Start KAT4 ATU matching cycle (2nd tap: Full Search)',
          tag: 'ATU',
          run: () => this.client.startAtuTune(),
        };
      }
      const antMatch = lower.match(/^ant(?:\s+([1-3]|cycle))?$/);
      if (antMatch) {
        const arg = antMatch[1];
        if (arg && arg !== 'cycle') {
          const port = parseInt(arg, 10);
          return {
            title: `TX Antenna ANT ${port}`,
            sub: `Select TX antenna port ${port}`,
            tag: `ANT ${port}`,
            run: () => this.client.setTxAntenna(port),
          };
        }
        return {
          title: 'Cycle TX Antenna (ANT 1 → 2 → 3)',
          sub: 'Advance to next TX antenna port',
          tag: 'ANT',
          run: () => (typeof this.client.cycleTxAntenna === 'function' ? this.client.cycleTxAntenna() : this.client.setTxAntenna(1)),
        };
      }
      const pwrMatch = lower.match(/^(?:pwr|power)\s+(\d+(?:\.\d+)?)\s*w?$/);
      if (pwrMatch) {
        const w = K4.quantizePowerWatts(pwrMatch[1]);
        return {
          title: `Set RF Power ${w <= 10 ? w.toFixed(1) : w} W`,
          sub: 'Adjust transmitter power output',
          tag: 'PWR',
          run: () => this.client.setPowerWatts(w),
        };
      }

      // NR / SSNR ("nr", "nr on", "nr off", "nr 1..10", "ssnr", "ssnr on", "ssnr off", "ssnr 1..25")
      const nrMatch = lower.match(/^(?:(nr)(?:\s+(on|off|lms|ssnr|\d+))?|(ssnr)(?:\s+(on|off|\d+))?)$/);
      if (nrMatch) {
        const cmdKind = nrMatch[1] || nrMatch[3];
        const arg = nrMatch[2] || nrMatch[4] || '';
        const snap = this.state.getSnapshot ? this.state.getSnapshot() : this.state;
        const rxS = targetRx === 'B' ? snap.rxB : snap.rxA;
        const b = K4.CatCodec && K4.CatCodec.builders;
        const isSsnrCmd = cmdKind === 'ssnr' || arg === 'ssnr';
        const mode = isSsnrCmd ? 'ssnr' : 'lms';
        const maxLvl = isSsnrCmd ? 25 : 10;

        let patch;
        let title;
        let sub;
        if (arg === 'on') {
          patch = { mode, on: true };
          title = `${isSsnrCmd ? 'SSNR' : 'Noise Reduction'} ON (VFO ${targetRx})`;
          sub = `Enable ${isSsnrCmd ? 'SSNR' : 'LMS NR'} on VFO ${targetRx}`;
        } else if (arg === 'off') {
          patch = cmdKind === 'ssnr' ? { mode: 'ssnr', on: false } : { on: false };
          title = `${isSsnrCmd ? 'SSNR' : 'Noise Reduction'} OFF (VFO ${targetRx})`;
          sub = `Disable ${isSsnrCmd ? 'SSNR' : 'NR'} on VFO ${targetRx}`;
        } else if (arg === 'lms' || arg === 'ssnr') {
          patch = { mode: arg };
          title = `NR Mode ${arg.toUpperCase()} (VFO ${targetRx})`;
          sub = `Switch NR algorithm to ${arg.toUpperCase()} on VFO ${targetRx}`;
        } else if (/^\d+$/.test(arg)) {
          const n = parseInt(arg, 10);
          if (n <= 0) {
            patch = { mode, on: false };
            title = `${isSsnrCmd ? 'SSNR' : 'Noise Reduction'} OFF (VFO ${targetRx})`;
            sub = `Disable ${isSsnrCmd ? 'SSNR' : 'LMS NR'} on VFO ${targetRx}`;
          } else {
            const level = Math.max(1, Math.min(maxLvl, n));
            patch = { mode, on: true, level };
            title = `${isSsnrCmd ? 'SSNR' : 'NR'} Level ${level} ON (VFO ${targetRx})`;
            sub = `Enable ${isSsnrCmd ? 'SSNR' : 'LMS NR'} at level ${level} on VFO ${targetRx}`;
          }
        } else if (cmdKind === 'ssnr') {
          const next = !(rxS && rxS.ssnrOn);
          patch = { mode: 'ssnr', on: next };
          title = `SSNR ${next ? 'ON' : 'OFF'} (VFO ${targetRx})`;
          sub = `Toggle SSNR on VFO ${targetRx}`;
        } else {
          const next = !(rxS && rxS.nrOn);
          patch = { on: next };
          title = `Noise Reduction ${next ? 'ON' : 'OFF'} (VFO ${targetRx})`;
          sub = `Toggle NR on VFO ${targetRx}`;
        }

        return {
          title,
          sub,
          tag: isSsnrCmd ? 'SSNR' : 'NR',
          run: () => {
            if (typeof this.client.setNr === 'function') {
              this.client.setNr(targetRx, patch);
            } else {
              const effMode = patch.mode || (rxS && rxS.nrMode === 'ssnr' ? 'ssnr' : 'lms');
              const effOn = patch.on !== undefined ? patch.on : Boolean(rxS && rxS.nrOn);
              const rawLvl =
                patch.level !== undefined
                  ? patch.level
                  : effMode === 'ssnr'
                  ? (rxS && rxS.ssnrLevel)
                  : (rxS && rxS.lmsNrLevel);
              const effDef = effMode === 'ssnr' ? 5 : 4;
              const effMax = effMode === 'ssnr' ? 25 : 10;
              const lvl = effOn
                ? (rawLvl > 0 ? Math.min(effMax, rawLvl) : effDef)
                : Math.max(0, Math.min(effMax, rawLvl || 0));
              const cmd = effMode === 'ssnr'
                ? (b && b.ssnr ? b.ssnr(targetRx, lvl, effOn) : `NRS${targetRx === 'B' ? '$' : ''}${String(lvl).padStart(2, '0')}${effOn ? '1' : '0'};`)
                : (b && b.nr ? b.nr(targetRx, lvl, effOn) : `NR${targetRx === 'B' ? '$' : ''}${String(lvl).padStart(2, '0')}${effOn ? '1' : '0'};`);
              this.client.sendCat(cmd);
            }
          },
        };
      }

      // NB / Notch / Lock
      const dspToggle = lower.match(/^(nb|notch|lock)(?:\s+(on|off))?$/);
      if (dspToggle) {
        const kind = dspToggle[1];
        const snap = this.state.getSnapshot ? this.state.getSnapshot() : this.state;
        const rxS = targetRx === 'B' ? snap.rxB : snap.rxA;
        const b = K4.CatCodec && K4.CatCodec.builders;
        if (kind === 'nb') {
          const next = dspToggle[2] ? dspToggle[2] === 'on' : !(rxS && rxS.nbOn);
          return {
            title: `Noise Blanker ${next ? 'ON' : 'OFF'} (VFO ${targetRx})`,
            sub: `Toggle NB on VFO ${targetRx}`,
            tag: 'NB',
            run: () => this.client.sendCat(b && b.nb ? b.nb(targetRx, rxS ? rxS.nbLevel : 5, next) : `NB${targetRx === 'B' ? '$' : ''}05${next ? '1' : '0'};`),
          };
        }
        if (kind === 'notch') {
          const next = dspToggle[2] ? dspToggle[2] === 'on' : !(rxS && rxS.notchOn);
          return {
            title: `Manual Notch ${next ? 'ON' : 'OFF'} (VFO ${targetRx})`,
            sub: `Toggle NM on VFO ${targetRx}`,
            tag: 'NM',
            run: () => this.client.sendCat(b && b.notch ? b.notch(targetRx, rxS ? rxS.notchHz : 750, next) : `NM${targetRx === 'B' ? '$' : ''}0750${next ? '1' : '0'};`),
          };
        }
        if (kind === 'lock') {
          const next = dspToggle[2] ? dspToggle[2] === 'on' : !(rxS && rxS.locked);
          return {
            title: `VFO ${targetRx} ${next ? 'Lock' : 'Unlock'}`,
            sub: `${next ? 'Lock' : 'Unlock'} main tuning dial on VFO ${targetRx}`,
            tag: 'LOCK',
            run: () => {
              if (typeof this.client.setLock === 'function') {
                this.client.setLock(targetRx, next);
              } else {
                this.client.sendCat(b && b.lock ? b.lock(targetRx, next) : `LK${targetRx === 'B' ? '$' : ''}${next ? '1' : '0'};`);
              }
            },
          };
        }
      }

      // Palette
      const palMatch = lower.match(/^palette\s+(obsidian|thermal|viridis|cyan)$/);
      if (palMatch) {
        const pal = palMatch[1];
        return {
          title: `Waterfall Palette: ${pal}`,
          sub: 'Switch scientific waterfall color LUT',
          tag: 'LUT',
          run: () => this.onSetPalette(pal),
        };
      }

      // Mute / Unmute
      if (lower === 'mute' || lower === 'unmute' || lower === 'audio') {
        return {
          title: lower === 'mute' ? 'Mute Audio' : (lower === 'unmute' ? 'Unmute Audio' : 'Toggle Audio Mute'),
          sub: 'Control receiver stereo audio output',
          tag: 'AUDIO',
          run: () => this.onToggleAudio(lower === 'mute' ? true : (lower === 'unmute' ? false : undefined)),
        };
      }

      // Save VFO bookmark
      const bmMatch = expr.match(/^(?:save|bookmark)\s+(.+)$/i);
      if (bmMatch && K4.BookmarkStore && this.state) {
        const label = bmMatch[1].trim();
        return {
          title: `Bookmark "${label}"`,
          sub: 'Save current VFO frequency, mode & filter',
          tag: 'BOOKMARK',
          run: () => {
            const snap = this.state.getSnapshot();
            const rx = targetRx;
            const rxS = rx === 'B' ? snap.rxB : snap.rxA;
            K4.BookmarkStore.add({
              label,
              freqHz: rxS.freqHz,
              mode: rxS.mode,
              dataSubMode: rxS.dataSubMode || 0,
              bwHz: rxS.bwHz,
            });
            if (typeof this.onNotify === 'function') {
              this.onNotify(`Saved bookmark "${label}"`, 'success');
            }
          },
        };
      }

      // Panadapter Freeze
      if (lower === 'freeze' || lower === 'unfreeze') {
        const freezeOn = lower === 'freeze';
        return {
          title: freezeOn ? 'Freeze Panadapter (#FRZ1)' : 'Unfreeze Panadapter (#FRZ0)',
          sub: 'Pause or resume spectrum & waterfall frames',
          tag: 'PAN',
          run: () => {
            const snap = this.state ? this.state.getSnapshot() : {};
            const dispRx =
              K4.CatCodec && typeof K4.CatCodec.resolveDisplayRx === 'function'
                ? K4.CatCodec.resolveDisplayRx(snap, targetRx)
                : snap.dualPanMode === 1
                  ? 'B'
                  : 'A';
            this.client.setDisplay(dispRx, { panFrozen: freezeOn });
          },
        };
      }

      // RIT commands
      if (lower === 'rit on' || lower === 'rit off') {
        const on = lower === 'rit on';
        return {
          title: on ? `Enable RIT (VFO ${targetRx})` : `Disable RIT (VFO ${targetRx})`,
          sub: 'Toggle Receiver Incremental Tuning on target VFO',
          tag: 'RIT',
          run: () => this.client.setRit(targetRx, { on }),
        };
      }
      if (lower === 'rit clear' || lower === 'rc') {
        return {
          title: `Clear RIT Offset (RC ${targetRx})`,
          sub: 'Zero RIT offset on target VFO',
          tag: 'RIT',
          run: () => this.client.clearRit(targetRx),
        };
      }
      const ritHzMatch = lower.match(/^rit\s+([+-]?\d+)$/);
      if (ritHzMatch) {
        const offsetHz = parseInt(ritHzMatch[1], 10);
        return {
          title: `Set RIT ${offsetHz >= 0 ? '+' : ''}${offsetHz} Hz (VFO ${targetRx})`,
          sub: 'Enable RIT and set offset on target VFO',
          tag: 'RIT',
          run: () => this.client.setRit(targetRx, { on: true, offsetHz }),
        };
      }

      // CW APF
      if (lower === 'apf on' || lower === 'apf off') {
        const on = lower === 'apf on';
        return {
          title: on ? `Enable CW APF (VFO ${targetRx})` : `Disable CW APF (VFO ${targetRx})`,
          sub: 'Toggle CW Audio Peak Filter on target VFO',
          tag: 'DSP',
          run: () => this.client.setApf(targetRx, { on }),
        };
      }

      // Diversity RX (requires KRX4 / 2nd ADC: K4D or K4HD)
      if (lower === 'div on' || lower === 'div off' || lower === 'diversity on' || lower === 'diversity off') {
        const snap = this.state && this.state.getSnapshot ? this.state.getSnapshot() : this.state;
        if (snap && snap.hasDiversity === false) {
          return {
            title: 'Diversity RX Unavailable (Base K4)',
            sub: 'Requires KRX4 / 2nd ADC option (K4D or K4HD; OM lacks S)',
            tag: 'N/A',
            run: () => {},
          };
        }
        const on = lower.endsWith('on');
        return {
          title: on ? 'Enable Diversity RX (DV1)' : 'Disable Diversity RX (DV0)',
          sub: 'Lock VFO B to VFO A phase-coherent RX',
          tag: 'RX',
          run: () => this.client.setDiversity(on),
        };
      }

      // Frequency match
      const freqHz = parseFreqToken(expr);
      if (freqHz !== null) {
        return {
          title: `Tune VFO ${targetRx} → ${formatHz(freqHz)}`,
          sub: `${freqHz.toLocaleString()} Hz`,
          tag: `VFO ${targetRx}`,
          run: () => {
            this.client.tune(targetRx, freqHz, { optimistically: true });
          },
        };
      }

      return null;
    }

    _refresh() {
      this._items = this._parseQuery(this.inputEl.value);
      this._selectedIdx = 0;
      this._renderList();
    }

    _renderList() {
      this.listEl.textContent = '';
      if (this._items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'k4-omnibar-item';
        const sub = document.createElement('span');
        sub.className = 'k4-omnibar-sub';
        sub.textContent = 'No matching frequency or command. Try "14.074", "7025", "20m", "cw", "span 48k", "vfo b 14025".';
        empty.appendChild(sub);
        this.listEl.appendChild(empty);
        return;
      }

      for (let i = 0; i < this._items.length; i++) {
        const item = this._items[i];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'k4-omnibar-item';
        if (item.blocked) btn.classList.add('is-blocked');
        if (i === this._selectedIdx) btn.classList.add('is-selected');

        const textWrap = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'k4-omnibar-title';
        title.textContent = item.title;
        const sub = document.createElement('div');
        sub.className = 'k4-omnibar-sub';
        sub.textContent = item.sub;
        textWrap.appendChild(title);
        textWrap.appendChild(sub);

        const tag = document.createElement('span');
        tag.className = 'k4-omnibar-tag';
        tag.textContent = item.tag;

        btn.appendChild(textWrap);
        btn.appendChild(tag);

        btn.addEventListener('click', () => this._executeItem(item));
        this.listEl.appendChild(btn);
      }
    }

    _executeItem(item) {
      if (!item) return;
      if (typeof item.run === 'function') {
        item.run();
      }
      this.close();
    }
  }

  K4.Omnibar = Omnibar;
})();
