'use strict';
(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const LATENCY_LABELS = [
    'SL0 — 35 ms (Ultra Low)',
    'SL1 — 60 ms (Low)',
    'SL2 — 75 ms (Balanced)',
    'SL3 — 95 ms (Standard)',
    'SL4 — 115 ms (Safe)',
    'SL5 — 140 ms (WAN)',
    'SL6 — 180 ms (High Jitter)',
    'SL7 — 240 ms (Max Buffer)',
  ];

  class ConnectionDialog {
    constructor(opts) {
      this.modal = opts.modal;
      this.client = opts.client;
      this.onConnectSubmit = opts.onConnectSubmit || (() => Promise.resolve());
      this.onDisconnectClick = opts.onDisconnectClick || (() => {});
      this.initialWsUrl = opts.initialWsUrl || '';

      this._isOpen = false;
      this._connecting = false;
      this._buildDom();
    }

    _buildDom() {
      const modal = this.modal;
      modal.textContent = '';

      const card = document.createElement('form');
      card.className = 'k4-modal-card';
      card.addEventListener('click', (e) => e.stopPropagation());
      card.addEventListener('submit', (e) => {
        e.preventDefault();
        this._handleSubmit();
      });

      const head = document.createElement('div');
      head.className = 'k4-dialog-head';
      const title = document.createElement('h2');
      title.className = 'k4-dialog-title';
      title.textContent = 'Connect to Elecraft K4';
      head.appendChild(title);

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'k4-icon-btn';
      closeBtn.textContent = '×';
      closeBtn.style.fontSize = '18px';
      closeBtn.title = 'Close dialog (Escape)';
      closeBtn.addEventListener('click', () => this.close());
      head.appendChild(closeBtn);
      card.appendChild(head);

      const body = document.createElement('div');
      body.className = 'k4-dialog-body';

      if (typeof location !== 'undefined' && location.protocol === 'file:') {
        const tip = document.createElement('div');
        tip.className = 'k4-banner k4-banner--info';
        const tipTitle = document.createElement('div');
        tipTitle.textContent = 'Running directly from file://. Start a WebSocket-to-TCP bridge to your K4 (or local simulator) before connecting:';
        const code = document.createElement('code');
        code.className = 'k4-code-line';
        code.textContent = 'websockify 127.0.0.1:9280 <k4-ip>:9205';
        tip.appendChild(tipTitle);
        tip.appendChild(code);
        body.appendChild(tip);
      }

      this.errorBanner = document.createElement('div');
      this.errorBanner.className = 'k4-banner k4-banner--error';
      this.errorBanner.hidden = true;
      body.appendChild(this.errorBanner);

      // WebSocket URL
      const wsField = document.createElement('div');
      wsField.className = 'k4-field';
      const wsLbl = document.createElement('label');
      wsLbl.className = 'k4-label';
      wsLbl.htmlFor = 'k4-ws-url-input';
      wsLbl.textContent = 'WebSocket Bridge URL';
      this.wsInput = document.createElement('input');
      this.wsInput.id = 'k4-ws-url-input';
      this.wsInput.type = 'text';
      this.wsInput.className = 'k4-input k4-mono';
      this.wsInput.dataset.testid = 'ws-url-input';
      this.wsInput.required = true;
      this.wsInput.spellcheck = false;
      const defaultUrl = (K4.Client && K4.Client.defaultWsUrl) ? K4.Client.defaultWsUrl() : 'ws://127.0.0.1:9280';
      const savedUrl = K4.storage ? K4.storage.get('k4.wsUrl', '') : '';
      this.wsInput.value = this.initialWsUrl || savedUrl || defaultUrl;
      wsField.appendChild(wsLbl);
      wsField.appendChild(this.wsInput);
      body.appendChild(wsField);

      // Password
      const pwField = document.createElement('div');
      pwField.className = 'k4-field';
      const pwLbl = document.createElement('label');
      pwLbl.className = 'k4-label';
      pwLbl.htmlFor = 'k4-password-input';
      pwLbl.textContent = 'K4 Network Password (hashed client-side with SHA-384)';
      this.pwInput = document.createElement('input');
      this.pwInput.id = 'k4-password-input';
      this.pwInput.type = 'password';
      this.pwInput.className = 'k4-input';
      this.pwInput.dataset.testid = 'password-input';
      this.pwInput.placeholder = 'Optional if radio/sim requires no password';
      const sessionPw = K4.storage ? K4.storage.getSession('k4.sessionPw', '') : '';
      if (sessionPw) this.pwInput.value = sessionPw;
      pwField.appendChild(pwLbl);
      pwField.appendChild(this.pwInput);
      body.appendChild(pwField);

      const remRow = document.createElement('label');
      remRow.className = 'k4-checkbox-row';
      this.rememberCheck = document.createElement('input');
      this.rememberCheck.type = 'checkbox';
      this.rememberCheck.checked = Boolean(sessionPw);
      remRow.appendChild(this.rememberCheck);
      remRow.appendChild(document.createTextNode('Remember password in browser session memory only'));
      body.appendChild(remRow);

      // Audio Codec & Subprotocol
      const row = document.createElement('div');
      row.className = 'k4-field-row';

      const emField = document.createElement('div');
      emField.className = 'k4-field';
      const emLbl = document.createElement('label');
      emLbl.className = 'k4-label';
      emLbl.htmlFor = 'k4-codec-select';
      emLbl.textContent = 'Audio Codec (EM)';
      this.emSelect = document.createElement('select');
      this.emSelect.id = 'k4-codec-select';
      this.emSelect.className = 'k4-select';
      const opusSupported = Boolean(K4.OpusPacketDecoder && K4.OpusPacketDecoder.isSupported && K4.OpusPacketDecoder.isSupported());
      const emOptions = [
        { val: 'auto', text: opusSupported ? 'Auto (Opus / PCM)' : 'Auto (PCM on file://)' },
        { val: '1', text: 'PCM S16LE (EM1)' },
        { val: '0', text: 'PCM 24-bit (EM0)' },
        { val: '3', text: opusSupported ? 'Opus Stereo (EM3)' : 'Opus (EM3 — unsupported)' },
      ];
      for (let i = 0; i < emOptions.length; i++) {
        const opt = document.createElement('option');
        opt.value = emOptions[i].val;
        opt.textContent = emOptions[i].text;
        if (emOptions[i].val === '3' && !opusSupported) opt.disabled = true;
        this.emSelect.appendChild(opt);
      }
      this.emSelect.value = K4.storage ? K4.storage.get('k4.encodeMode', 'auto') : 'auto';
      emField.appendChild(emLbl);
      emField.appendChild(this.emSelect);
      row.appendChild(emField);

      const subField = document.createElement('div');
      subField.className = 'k4-field';
      const subLbl = document.createElement('label');
      subLbl.className = 'k4-label';
      subLbl.htmlFor = 'k4-subproto-select';
      subLbl.textContent = 'WebSocket Subprotocol';
      this.subSelect = document.createElement('select');
      this.subSelect.id = 'k4-subproto-select';
      this.subSelect.className = 'k4-select';
      const subOptions = [
        { val: 'auto', text: 'Auto (websockify + websocat)' },
        { val: 'binary', text: 'binary (websockify)' },
        { val: 'none', text: 'none (websocat)' },
      ];
      for (let i = 0; i < subOptions.length; i++) {
        const opt = document.createElement('option');
        opt.value = subOptions[i].val;
        opt.textContent = subOptions[i].text;
        this.subSelect.appendChild(opt);
      }
      this.subSelect.value = K4.storage ? K4.storage.get('k4.subprotocol', 'auto') : 'auto';
      subField.appendChild(subLbl);
      subField.appendChild(this.subSelect);
      row.appendChild(subField);
      body.appendChild(row);

      // Latency Tier
      const slField = document.createElement('div');
      slField.className = 'k4-field';
      const slLbl = document.createElement('label');
      slLbl.className = 'k4-label';
      slLbl.htmlFor = 'k4-sl-select';
      slLbl.textContent = 'Streaming Latency Tier';
      this.slSelect = document.createElement('select');
      this.slSelect.id = 'k4-sl-select';
      this.slSelect.className = 'k4-select';
      for (let i = 0; i < LATENCY_LABELS.length; i++) {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = LATENCY_LABELS[i];
        this.slSelect.appendChild(opt);
      }
      this.slSelect.value = String(K4.storage ? K4.storage.get('k4.latencyTier', 2) : 2);
      slField.appendChild(slLbl);
      slField.appendChild(this.slSelect);
      body.appendChild(slField);

      card.appendChild(body);

      const foot = document.createElement('div');
      foot.className = 'k4-dialog-foot';

      this.disconnectBtn = document.createElement('button');
      this.disconnectBtn.type = 'button';
      this.disconnectBtn.className = 'k4-btn-danger';
      this.disconnectBtn.dataset.testid = 'disconnect-btn';
      this.disconnectBtn.textContent = 'Disconnect';
      this.disconnectBtn.addEventListener('click', () => {
        this.onDisconnectClick();
      });
      foot.appendChild(this.disconnectBtn);

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'k4-btn-ghost';
      cancelBtn.textContent = 'Close';
      cancelBtn.addEventListener('click', () => this.close());
      foot.appendChild(cancelBtn);

      this.submitBtn = document.createElement('button');
      this.submitBtn.type = 'submit';
      this.submitBtn.className = 'k4-btn-primary';
      this.submitBtn.dataset.testid = 'connect-submit';
      this.submitBtn.textContent = 'Connect';
      foot.appendChild(this.submitBtn);

      card.appendChild(foot);
      modal.appendChild(card);

      modal.addEventListener('click', () => this.close());
    }

    getOptions() {
      const rawEm = this.emSelect.value;
      const encodeMode = rawEm === 'auto' ? 'auto' : Number(rawEm);
      return {
        wsUrl: this.wsInput.value.trim(),
        password: this.pwInput.value,
        encodeMode,
        subprotocolMode: this.subSelect.value,
        latencyTier: Number(this.slSelect.value) || 2,
      };
    }

    _persistPreferences(opts) {
      if (!K4.storage) return;
      K4.storage.set('k4.wsUrl', opts.wsUrl);
      K4.storage.set('k4.encodeMode', String(this.emSelect.value));
      K4.storage.set('k4.subprotocol', opts.subprotocolMode);
      K4.storage.set('k4.latencyTier', opts.latencyTier);
      if (this.rememberCheck.checked && opts.password) {
        K4.storage.setSession('k4.sessionPw', opts.password);
      } else {
        K4.storage.setSession('k4.sessionPw', '');
      }
    }

    async _handleSubmit() {
      if (this._connecting) return;
      const opts = this.getOptions();
      if (!opts.wsUrl) {
        this.setError('Please enter a WebSocket URL (e.g. ws://127.0.0.1:9280).');
        return;
      }
      this._persistPreferences(opts);
      this.setError('');
      this._setConnecting(true);
      try {
        await this.onConnectSubmit(opts);
      } catch (err) {
        this.setError(err && err.message ? err.message : 'Unable to connect to WebSocket bridge.');
      } finally {
        this._setConnecting(false);
      }
    }

    _setConnecting(flag) {
      this._connecting = Boolean(flag);
      this.submitBtn.disabled = this._connecting;
      this.submitBtn.textContent = this._connecting ? 'Connecting...' : 'Connect';
    }

    setError(message) {
      if (message) {
        this.errorBanner.textContent = message;
        this.errorBanner.hidden = false;
      } else {
        this.errorBanner.textContent = '';
        this.errorBanner.hidden = true;
      }
    }

    syncConnectionState(conn) {
      if (!conn) return;
      const active = conn.status === 'connected' || conn.status === 'connecting' || conn.status === 'authenticating';
      this.disconnectBtn.disabled = !active;
      if (conn.status === 'error' || conn.authStatus === 'rejected') {
        const msg = conn.error || (conn.authStatus === 'rejected'
          ? 'Connection closed during authentication — verify K4 password or bridge target.'
          : 'Connection error.');
        this.setError(msg);
      } else if (conn.status === 'connected' && conn.authStatus === 'authenticated') {
        this.setError('');
      }
    }

    isOpen() {
      return this._isOpen;
    }

    open() {
      this._isOpen = true;
      this.modal.hidden = false;
      this.modal.dataset.open = 'true';
      requestAnimationFrame(() => {
        this.wsInput.focus();
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
  }

  K4.ConnectionDialog = ConnectionDialog;
})();
