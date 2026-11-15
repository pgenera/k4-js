'use strict';
(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const MACRO_KEYS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'];

  const DEFAULT_FN_MACROS = Object.freeze({
    F1: 'CQ CQ DE K4 K ',
    F2: 'UR 599 TU ',
    F3: 'DE K4 ',
    F4: '73 TU E E ',
    F5: 'AGN? ',
    F6: 'QRL? ',
    F7: 'CAT:SP3;',
    F8: 'CAT:AB2;',
  });

  const DEFAULTS = Object.freeze({
    voiceClickSnapKhz: true,
    mouseQsyMode: 'lr',
    arrowUpDownMode: 'coarse',
    keyboardShortcuts: true,
    fnMacros: DEFAULT_FN_MACROS,
  });

  const STORAGE_KEYS = Object.freeze({
    voiceClickSnapKhz: 'prefs.voiceClickSnapKhz',
    mouseQsyMode: 'prefs.mouseQsyMode',
    arrowUpDownMode: 'prefs.arrowUpDownMode',
    keyboardShortcuts: 'prefs.keyboardShortcuts',
    fnMacros: 'prefs.fnMacros',
  });

  const SHORTCUT_GROUPS = [
    {
      title: 'Tuning',
      items: [
        { keys: ['←', '→'], desc: 'Step active VFO (Shift: 10× · Alt: 1 Hz)' },
        { keys: ['↑', '↓'], desc: 'Arrow action (Coarse ±10× / ±1× Step / Band)' },
        { keys: ['PgUp', 'PgDn'], desc: 'Band Up / Down' },
        { keys: ['[', ']'], desc: 'Band Down / Up' },
        { keys: ['0–9'], desc: 'Direct frequency entry (Jump Bar)' },
      ],
    },
    {
      title: 'VFO & Split',
      items: [
        { keys: ['A', 'B'], desc: 'Select VFO A / VFO B' },
        { keys: ['Shift+A'], desc: 'A ► B frequency copy (2nd tap: full)' },
        { keys: ['X', '/'], desc: 'Swap VFO A / B frequencies' },
        { keys: ['Shift+X'], desc: 'Swap all VFO A / B settings' },
        { keys: ['S'], desc: 'Toggle Split' },
        { keys: ['Shift+S'], desc: 'Quick Split (+1 kHz on VFO B)' },
        { keys: ['U'], desc: 'Toggle Sub RX' },
        { keys: ['L'], desc: 'Lock / Unlock active VFO' },
        { keys: ['R'], desc: 'Toggle RIT on active VFO' },
        { keys: ['Shift+R'], desc: 'Clear RIT / XIT offset' },
      ],
    },
    {
      title: 'CW & Macros',
      items: [
        { keys: ['F1–F8'], desc: 'Run programmable CW / CAT macro' },
        { keys: ['C'], desc: 'CW Auto-Spot (zero-beat)' },
        { keys: ['Shift+C'], desc: 'Toggle CW Spot sidetone' },
        { keys: ['Enter'], desc: 'Keyer box: send CW / DATA buffer' },
        { keys: ['Esc'], desc: 'Keyer box: abort buffer immediately' },
      ],
    },
    {
      title: 'Display, Audio & TX',
      items: [
        { keys: ['M'], desc: 'Mute / Unmute audio' },
        { keys: ['F'], desc: 'Freeze / Unfreeze panadapter' },
        { keys: ['+', '−'], desc: 'Panadapter span zoom in / out' },
        { keys: ['Z', 'Home'], desc: 'Re-center panadapter' },
        { keys: ['Shift+T'], desc: 'ATU Tune (2nd tap within 3s: Full Search)' },
        { keys: ['Space'], desc: 'Hold-only PTT' },
        { keys: ['Esc'], desc: 'Panic abort TX / ATU / Keyer & close' },
        { keys: ['Cmd/Ctrl+K'], desc: 'Command & Frequency Jump Bar' },
        { keys: ['Cmd/Ctrl+,', '?'], desc: 'Open Settings & Keyboard Shortcuts' },
      ],
    },
  ];

  function storageGet(key, fallback) {
    if (K4.storage && typeof K4.storage.get === 'function') {
      return K4.storage.get(key, fallback);
    }
    return fallback;
  }

  function storageSet(key, value) {
    if (K4.storage && typeof K4.storage.set === 'function') {
      K4.storage.set(key, value);
    }
  }

  function normalizeMacros(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    for (let i = 0; i < MACRO_KEYS.length; i++) {
      const k = MACRO_KEYS[i];
      out[k] = typeof src[k] === 'string' ? src[k] : DEFAULT_FN_MACROS[k];
    }
    return out;
  }

  function normalizePref(key, value) {
    switch (key) {
      case 'voiceClickSnapKhz':
        return value === undefined || value === null ? DEFAULTS.voiceClickSnapKhz : Boolean(value);
      case 'mouseQsyMode':
        return value === 'pane' ? 'pane' : 'lr';
      case 'arrowUpDownMode':
        return value === 'step' || value === 'band' ? value : 'coarse';
      case 'keyboardShortcuts':
        return value === undefined || value === null ? DEFAULTS.keyboardShortcuts : Boolean(value);
      case 'fnMacros':
        return normalizeMacros(value);
      default:
        return value;
    }
  }

  function macrosEqual(a, b) {
    if (!a || !b) return false;
    for (let i = 0; i < MACRO_KEYS.length; i++) {
      const k = MACRO_KEYS[i];
      if (a[k] !== b[k]) return false;
    }
    return true;
  }

  function loadAllFromStorage() {
    const rawMouse = storageGet(STORAGE_KEYS.mouseQsyMode, null);
    const legacyMouse = rawMouse === null ? storageGet('k4.mouseQsyMode', DEFAULTS.mouseQsyMode) : rawMouse;
    return {
      voiceClickSnapKhz: normalizePref('voiceClickSnapKhz', storageGet(STORAGE_KEYS.voiceClickSnapKhz, DEFAULTS.voiceClickSnapKhz)),
      mouseQsyMode: normalizePref('mouseQsyMode', legacyMouse),
      arrowUpDownMode: normalizePref('arrowUpDownMode', storageGet(STORAGE_KEYS.arrowUpDownMode, DEFAULTS.arrowUpDownMode)),
      keyboardShortcuts: normalizePref('keyboardShortcuts', storageGet(STORAGE_KEYS.keyboardShortcuts, DEFAULTS.keyboardShortcuts)),
      fnMacros: normalizePref('fnMacros', storageGet(STORAGE_KEYS.fnMacros, DEFAULT_FN_MACROS)),
    };
  }

  function executeMacro(rawText, client, onNotify) {
    const raw = typeof rawText === 'string' ? rawText : '';
    if (!raw.trim()) {
      if (typeof onNotify === 'function') onNotify('Macro is empty', 'warn');
      return false;
    }
    const trimmedStart = raw.trimStart();
    if (/^CAT:/i.test(trimmedStart)) {
      const cmd = trimmedStart.slice(4).trim();
      if (!cmd) {
        if (typeof onNotify === 'function') onNotify('CAT macro is empty', 'warn');
        return false;
      }
      const cat = cmd.endsWith(';') ? cmd : `${cmd};`;
      if (client && typeof client.sendCat === 'function') {
        client.sendCat(cat);
      }
      if (typeof onNotify === 'function') onNotify(`Sent CAT: ${cat}`, 'info');
      return true;
    }
    if (client && typeof client.sendKeyerText === 'function') {
      client.sendKeyerText(raw, ' ');
    } else if (client && typeof client.sendCat === 'function') {
      const clean = raw.replace(/[;\r\n]/g, '').slice(0, 24);
      if (clean) client.sendCat(`KY ${clean};`);
    }
    if (typeof onNotify === 'function') onNotify(`Sent keyer: ${raw.trim()}`, 'info');
    return true;
  }

  const listeners = new Set();
  let cache = loadAllFromStorage();

  const ClientPrefs = {
    DEFAULTS,
    MACRO_KEYS,

    get(key) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) return undefined;
      if (key === 'fnMacros') return { ...cache.fnMacros };
      return cache[key];
    },

    getAll() {
      return {
        voiceClickSnapKhz: cache.voiceClickSnapKhz,
        mouseQsyMode: cache.mouseQsyMode,
        arrowUpDownMode: cache.arrowUpDownMode,
        keyboardShortcuts: cache.keyboardShortcuts,
        fnMacros: { ...cache.fnMacros },
      };
    },

    set(key, value) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) return undefined;
      const next = normalizePref(key, value);
      const changed = key === 'fnMacros' ? !macrosEqual(cache.fnMacros, next) : cache[key] !== next;
      cache[key] = next;

      storageSet(STORAGE_KEYS[key], next);
      if (key === 'mouseQsyMode') {
        storageSet('k4.mouseQsyMode', next);
      }

      if (changed) {
        const snapshot = this.getAll();
        const emitted = key === 'fnMacros' ? { ...next } : next;
        for (const fn of listeners) {
          try {
            fn(key, emitted, snapshot);
          } catch (_) {}
        }
      }
      return key === 'fnMacros' ? { ...next } : next;
    },

    getMacro(fnKey) {
      const k = String(fnKey || '').toUpperCase();
      return Object.prototype.hasOwnProperty.call(cache.fnMacros, k) ? cache.fnMacros[k] : '';
    },

    setMacro(fnKey, text) {
      const k = String(fnKey || '').toUpperCase();
      if (!MACRO_KEYS.includes(k)) return undefined;
      const nextMacros = { ...cache.fnMacros, [k]: typeof text === 'string' ? text : String(text || '') };
      return this.set('fnMacros', nextMacros);
    },

    reset() {
      this.set('voiceClickSnapKhz', DEFAULTS.voiceClickSnapKhz);
      this.set('mouseQsyMode', DEFAULTS.mouseQsyMode);
      this.set('arrowUpDownMode', DEFAULTS.arrowUpDownMode);
      this.set('keyboardShortcuts', DEFAULTS.keyboardShortcuts);
      this.set('fnMacros', DEFAULT_FN_MACROS);
      return this.getAll();
    },

    reload() {
      cache = loadAllFromStorage();
      return this.getAll();
    },

    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    onChange(listener) {
      return this.subscribe(listener);
    },

    executeMacro,
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function syncSwitchBtn(btn, on) {
    const active = Boolean(on);
    btn.classList.toggle('is-on', active);
    btn.textContent = active ? 'ON' : 'OFF';
    btn.setAttribute('aria-checked', active ? 'true' : 'false');
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  class SettingsPanel {
    constructor(opts = {}) {
      this.modal = opts.modal;
      this.client = opts.client;
      this.prefs = opts.prefs || ClientPrefs;
      this.onNotify = opts.onNotify || (() => {});
      this._isOpen = false;
      this._macroInputs = {};
      this._unsubscribe = null;

      this._buildDom();
      this._syncFromPrefs();
      if (this.prefs && typeof this.prefs.onChange === 'function') {
        this._unsubscribe = this.prefs.onChange(() => this._syncFromPrefs());
      }
    }

    _buildSwitchRow({ title, desc, testId, onToggle }) {
      const row = el('div', 'k4-settings-row');
      const info = el('div');
      info.appendChild(el('div', null, title));
      if (desc) info.appendChild(el('div', 'k4-settings-desc', desc));

      const btn = el('button', 'k4-switch-btn', 'OFF');
      btn.type = 'button';
      btn.setAttribute('role', 'switch');
      btn.setAttribute('aria-label', title);
      btn.dataset.testid = testId;
      btn.addEventListener('click', onToggle);

      row.appendChild(info);
      row.appendChild(btn);
      return { row, btn };
    }

    _buildSelectRow({ title, desc, testId, options, onChange }) {
      const row = el('div', 'k4-settings-row');
      const info = el('div');
      info.appendChild(el('div', null, title));
      if (desc) info.appendChild(el('div', 'k4-settings-desc', desc));

      const select = el('select', 'k4-select');
      select.dataset.testid = testId;
      select.setAttribute('aria-label', title);
      for (let i = 0; i < options.length; i++) {
        const opt = document.createElement('option');
        opt.value = options[i].value;
        opt.textContent = options[i].label;
        select.appendChild(opt);
      }
      select.addEventListener('change', () => onChange(select.value));

      row.appendChild(info);
      row.appendChild(select);
      return { row, select };
    }

    _buildDom() {
      const modal = this.modal;
      if (!modal) return;
      modal.textContent = '';

      modal.addEventListener('click', (e) => {
        if (e.target === modal) this.close();
      });

      const card = el('div', 'k4-modal-card k4-settings-card');
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      card.setAttribute('aria-labelledby', 'settings-dialog-title');
      card.addEventListener('click', (e) => e.stopPropagation());

      const head = el('div', 'k4-dialog-head');
      const title = el('h2', 'k4-dialog-title', 'Settings & Keyboard Shortcuts');
      title.id = 'settings-dialog-title';
      head.appendChild(title);

      const closeBtn = el('button', 'k4-icon-btn', '×');
      closeBtn.type = 'button';
      closeBtn.dataset.testid = 'settings-close-btn';
      closeBtn.style.fontSize = '18px';
      closeBtn.title = 'Close settings (Escape)';
      closeBtn.setAttribute('aria-label', 'Close settings');
      closeBtn.addEventListener('click', () => this.close());
      head.appendChild(closeBtn);
      this._closeBtn = closeBtn;
      card.appendChild(head);

      const body = el('div', 'k4-settings-body');

      // 1. Tuning & Controls
      const tuningSec = el('section', 'k4-settings-section');
      tuningSec.appendChild(el('h3', 'k4-settings-section-title', 'Tuning & Controls'));

      const voiceRow = this._buildSwitchRow({
        title: 'Voice click-to-tune nearest 1 kHz',
        desc: 'Round panadapter click-to-tune to the nearest whole kilohertz on voice modes (LSB, USB, AM, FM), independent of VFO step. Hold Alt while clicking for 1 Hz fine tune.',
        testId: 'pref-voice-snap-khz',
        onToggle: () => this.prefs.set('voiceClickSnapKhz', !this.prefs.get('voiceClickSnapKhz')),
      });
      this._voiceSnapBtn = voiceRow.btn;
      tuningSec.appendChild(voiceRow.row);

      const mouseRow = this._buildSelectRow({
        title: 'Panadapter mouse click target',
        desc: 'Choose whether left/right panadapter clicks target VFO A / VFO B or always tune the clicked panadapter pane VFO.',
        testId: 'pref-mouse-qsy',
        options: [
          { value: 'lr', label: 'Left=A / Right=B' },
          { value: 'pane', label: 'Clicked pane VFO' },
        ],
        onChange: (val) => this.prefs.set('mouseQsyMode', val),
      });
      this._mouseQsySelect = mouseRow.select;
      tuningSec.appendChild(mouseRow.row);

      const arrowRow = this._buildSelectRow({
        title: 'Up / Down arrow key action',
        desc: 'Behavior when pressing ArrowUp / ArrowDown outside text inputs and VFO digit cells.',
        testId: 'pref-arrow-updown',
        options: [
          { value: 'coarse', label: '±10× VFO Step' },
          { value: 'step', label: '±1× VFO Step' },
          { value: 'band', label: 'Band Up / Down' },
        ],
        onChange: (val) => this.prefs.set('arrowUpDownMode', val),
      });
      this._arrowUpDownSelect = arrowRow.select;
      tuningSec.appendChild(arrowRow.row);

      const kbdRow = this._buildSwitchRow({
        title: 'K4 keyboard shortcuts',
        desc: 'Enable direct unmodified single-key K4 shortcuts when not typing in an input or modal.',
        testId: 'pref-kbd-enabled',
        onToggle: () => this.prefs.set('keyboardShortcuts', !this.prefs.get('keyboardShortcuts')),
      });
      this._kbdEnabledBtn = kbdRow.btn;
      tuningSec.appendChild(kbdRow.row);

      body.appendChild(tuningSec);

      // 2. Programmable F1-F8 Macros
      const macroSec = el('section', 'k4-settings-section');
      macroSec.appendChild(el('h3', 'k4-settings-section-title', 'Programmable Macros (F1 – F8)'));
      macroSec.appendChild(
        el(
          'div',
          'k4-settings-desc',
          'Plain text sends via the CW / DATA keyer; prefix with CAT: (e.g. CAT:SP3;) to execute raw CAT commands.'
        )
      );

      const macroGrid = el('div', 'k4-macro-grid');
      for (let i = 0; i < MACRO_KEYS.length; i++) {
        const key = MACRO_KEYS[i];
        const item = el('div', 'k4-macro-item');

        const keyBadge = el('span', 'k4-macro-key', key);
        item.appendChild(keyBadge);

        const input = el('input', 'k4-macro-input');
        input.type = 'text';
        input.dataset.testid = `pref-fn-macro-${key}`;
        input.setAttribute('aria-label', `${key} macro text`);
        input.placeholder = `${key} macro text or CAT:CMD;`;
        input.addEventListener('input', () => {
          this.prefs.setMacro(key, input.value);
        });
        input.addEventListener('change', () => {
          this.prefs.setMacro(key, input.value);
        });
        this._macroInputs[key] = input;
        item.appendChild(input);

        const runBtn = el('button', 'k4-btn k4-macro-run-btn', 'Run');
        runBtn.type = 'button';
        runBtn.dataset.testid = `pref-fn-macro-run-${key}`;
        runBtn.title = `Execute ${key} macro now`;
        runBtn.addEventListener('click', () => {
          executeMacro(this.prefs.getMacro(key), this.client, this.onNotify);
        });
        item.appendChild(runBtn);

        macroGrid.appendChild(item);
      }
      macroSec.appendChild(macroGrid);
      body.appendChild(macroSec);

      // 3. K4 Keyboard Shortcuts Reference
      const shortcutsSec = el('section', 'k4-settings-section');
      shortcutsSec.dataset.testid = 'settings-shortcuts-section';
      shortcutsSec.tabIndex = -1;
      shortcutsSec.appendChild(el('h3', 'k4-settings-section-title', 'K4 Keyboard Shortcuts Reference'));

      for (let g = 0; g < SHORTCUT_GROUPS.length; g++) {
        const grp = SHORTCUT_GROUPS[g];
        const grpTitle = el('div', 'k4-settings-desc', grp.title);
        grpTitle.style.fontWeight = '700';
        shortcutsSec.appendChild(grpTitle);

        const grid = el('div', 'k4-shortcut-grid');
        for (let j = 0; j < grp.items.length; j++) {
          const item = grp.items[j];
          const row = el('div', 'k4-shortcut-row');

          const keysWrap = el('span');
          for (let k = 0; k < item.keys.length; k++) {
            if (k > 0) keysWrap.appendChild(document.createTextNode(' '));
            keysWrap.appendChild(el('kbd', 'k4-kbd', item.keys[k]));
          }
          row.appendChild(keysWrap);
          row.appendChild(el('span', null, item.desc));
          grid.appendChild(row);
        }
        shortcutsSec.appendChild(grid);
      }

      this._shortcutsSection = shortcutsSec;
      body.appendChild(shortcutsSec);

      card.appendChild(body);
      modal.appendChild(card);
    }

    _syncFromPrefs() {
      if (!this.prefs) return;
      if (this._voiceSnapBtn) {
        syncSwitchBtn(this._voiceSnapBtn, this.prefs.get('voiceClickSnapKhz'));
      }
      if (this._mouseQsySelect) {
        this._mouseQsySelect.value = this.prefs.get('mouseQsyMode');
      }
      if (this._arrowUpDownSelect) {
        this._arrowUpDownSelect.value = this.prefs.get('arrowUpDownMode');
      }
      if (this._kbdEnabledBtn) {
        syncSwitchBtn(this._kbdEnabledBtn, this.prefs.get('keyboardShortcuts'));
      }
      const macros = this.prefs.get('fnMacros') || {};
      const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
      for (let i = 0; i < MACRO_KEYS.length; i++) {
        const key = MACRO_KEYS[i];
        const input = this._macroInputs[key];
        if (input && activeEl !== input) {
          input.value = typeof macros[key] === 'string' ? macros[key] : '';
        }
      }
    }

    isOpen() {
      return this._isOpen;
    }

    open(focusSection) {
      if (!this.modal) return;
      this._syncFromPrefs();
      this._isOpen = true;
      this.modal.hidden = false;
      this.modal.dataset.open = 'true';
      requestAnimationFrame(() => {
        if (!this._isOpen) return;
        if (focusSection === 'shortcuts' && this._shortcutsSection) {
          if (this._closeBtn && typeof this._closeBtn.focus === 'function') {
            this._closeBtn.focus({ preventScroll: true });
          }
          if (typeof this._shortcutsSection.scrollIntoView === 'function') {
            this._shortcutsSection.scrollIntoView({ block: 'start' });
          }
        } else if (this._voiceSnapBtn && typeof this._voiceSnapBtn.focus === 'function') {
          this._voiceSnapBtn.focus();
        }
      });
    }

    close() {
      if (!this._isOpen || !this.modal) return;
      this._isOpen = false;
      if (
        typeof document !== 'undefined' &&
        document.activeElement &&
        this.modal.contains(document.activeElement) &&
        typeof document.activeElement.blur === 'function'
      ) {
        document.activeElement.blur();
      }
      this.modal.dataset.open = 'false';
      this.modal.hidden = true;
    }

    destroy() {
      if (typeof this._unsubscribe === 'function') {
        this._unsubscribe();
        this._unsubscribe = null;
      }
    }
  }

  SettingsPanel.executeMacro = executeMacro;

  K4.ClientPrefs = ClientPrefs;
  K4.SettingsPanel = SettingsPanel;
})();
