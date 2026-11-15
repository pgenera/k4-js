'use strict';

(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const MODE_KEY_MAP = {
    LSB: { modeCode: 1 },
    USB: { modeCode: 2 },
    CW: { modeCode: 3 },
    FM: { modeCode: 4 },
    AM: { modeCode: 5 },
    DATA: { modeCode: 6 },
    'CW-R': { modeCode: 7 },
    'DATA-R': { modeCode: 9 },
    'DATA-A': { modeCode: 6, subMode: 0 },
    'AFSK-A': { modeCode: 6, subMode: 1 },
    'FSK-D': { modeCode: 6, subMode: 2 },
    'PSK-D': { modeCode: 6, subMode: 3 },
  };

  function clamp(val, min, max) {
    return val < min ? min : val > max ? max : val;
  }

  function encodeAsciiBytes(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      out[i] = str.charCodeAt(i) & 0xff;
    }
    return out;
  }

  function resolveBand(bandIdOrDef) {
    if (!bandIdOrDef) return null;
    if (typeof bandIdOrDef === 'object' && bandIdOrDef.bn !== undefined) {
      return bandIdOrDef;
    }
    const needle = String(bandIdOrDef).trim().toLowerCase();
    const bands = K4.BANDS || [];
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      if (
        b.id.toLowerCase() === needle ||
        b.label.toLowerCase() === needle ||
        b.bn.toLowerCase() === needle
      ) {
        return b;
      }
    }
    return null;
  }

  function nowMs() {
    if (globalThis.performance && typeof globalThis.performance.now === 'function') {
      return globalThis.performance.now();
    }
    return Date.now();
  }

  function isWsOpen(ws) {
    return Boolean(ws && ws.readyState === 1);
  }

  function isWsConnecting(ws) {
    return Boolean(ws && ws.readyState === 0);
  }

  /**
   * K4 WebSocket transport client managing SHA-384 auth, stream framing, keepalive,
   * receive-only enforcement, and optimistic + CAT-confirmed RadioState updates.
   */
  class Client extends K4.EventEmitter {
    /**
     * @param {Object} [opts]
     * @param {K4.RadioState} [opts.state]
     * @param {K4.RxOnlyGate} [opts.gate]
     */
    constructor(opts = {}) {
      super();
      this.state = opts.state || new K4.RadioState();
      this.gate = opts.gate || new K4.RxOnlyGate('rx-only');
      this._framer = new K4.PacketFramer((payload) => this._handleFrame(payload));
      this._ws = null;
      this._connGen = 0;
      this._pingTimer = null;
      this._tbPollTimer = null;
      this._totTimer = null;
      this._txPosture = 'rx-only';
      if (this.state && typeof this.state.on === 'function') {
        this.state.on('change', () => this._syncTbPolling());
      }
      this._bootstrapTimer = null;
      this._bootstrapSent = false;
      this._pendingEmMode = 1;
      this._pendingSlTier = 2;
      this._lastPingSentPerfMs = null;
      this._manualDisconnect = false;
      this._pagehideHandler = null;
      this._metrics = {
        bytesIn: 0,
        bytesOut: 0,
        wsMessages: 0,
        catPacketsIn: 0,
        catPacketsOut: 0,
        panPacketsIn: 0,
        miniPanPacketsIn: 0,
        audioPacketsIn: 0,
      };

      // Always initialize in mandatory 'rx-only' safety posture regardless of passed gate/state.
      this._disarmToRxOnly({ silentCat: true, emitPttChange: false });

      this.state.on('change', (snapshot, changedKey) => {
        this.emit('state', snapshot, changedKey);
      });
      this.gate.on('blocked', (entry) => {
        this.emit('blocked', entry);
      });
    }

    /**
     * Compute the default WebSocket endpoint URL for the current origin/protocol.
     * @returns {string}
     */
    static defaultWsUrl() {
      const loc = globalThis.location;
      if (!loc || loc.protocol === 'file:') {
        return 'ws://127.0.0.1:9280';
      }
      if (
        loc.protocol === 'http:' &&
        (loc.hostname === '127.0.0.1' || loc.hostname === 'localhost')
      ) {
        return 'ws://' + loc.host + '/ws';
      }
      return (loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host + '/ws';
    }

    /**
     * Return a current snapshot of RadioState.
     * @returns {Object}
     */
    getState() {
      return this.state.getSnapshot();
    }

    /**
     * Return transport, framer, and RxOnlyGate metrics.
     * @returns {Object}
     */
    getMetrics() {
      const conn = this.state.getSnapshot().connection;
      return {
        status: conn.status,
        authStatus: conn.authStatus,
        rttMs: conn.rttMs,
        bytesIn: this._metrics.bytesIn,
        bytesOut: this._metrics.bytesOut,
        wsMessages: this._metrics.wsMessages,
        catPacketsIn: this._metrics.catPacketsIn,
        catPacketsOut: this._metrics.catPacketsOut,
        panPacketsIn: this._metrics.panPacketsIn,
        miniPanPacketsIn: this._metrics.miniPanPacketsIn,
        audioPacketsIn: this._metrics.audioPacketsIn,
        framer: this._framer.getStats(),
        gate: this.gate.getStats(),
      };
    }

    _clearBootstrapTimer() {
      if (this._bootstrapTimer !== null) {
        clearTimeout(this._bootstrapTimer);
        this._bootstrapTimer = null;
      }
    }

    _stopTbPolling() {
      if (this._tbPollTimer !== null) {
        clearInterval(this._tbPollTimer);
        this._tbPollTimer = null;
      }
    }

    _syncTbPolling() {
      if (!isWsOpen(this._ws) || !this.state) {
        this._stopTbPolling();
        return;
      }
      const snap = this.state.getSnapshot();
      const aOn = Boolean(snap.rxA && snap.rxA.textDecodeMode > 0);
      const bOn = Boolean(snap.rxB && snap.rxB.textDecodeMode > 0);
      if (!aOn && !bOn) {
        this._stopTbPolling();
        return;
      }
      if (this._tbPollTimer !== null) return;
      this._tbPollTimer = setInterval(() => {
        if (!isWsOpen(this._ws) || !this.state) {
          this._stopTbPolling();
          return;
        }
        const s = this.state.getSnapshot();
        let q = '';
        if (s.rxA && s.rxA.textDecodeMode > 0) q += 'TB;';
        if (s.rxB && s.rxB.textDecodeMode > 0) q += 'TB$;';
        if (q) {
          this.sendCat(q);
        } else {
          this._stopTbPolling();
        }
      }, 350);
    }

    _clearTotTimer() {
      if (this._totTimer !== null) {
        clearTimeout(this._totTimer);
        this._totTimer = null;
      }
    }

    _disarmToRxOnly({ silentCat = false, emitPttChange = true, sendDisconnectRx = false } = {}) {
      this._clearTotTimer();
      const snap = this.state ? this.state.getSnapshot() : {};
      const wasActive = Boolean(snap.pttHeld || snap.txActive || snap.atuTuning);
      const wasTestPosture = this._txPosture === 'tx-test' || Boolean(snap.txTestMode);

      let cleanupSent = false;
      if (!silentCat && wasTestPosture && isWsOpen(this._ws)) {
        const stopPrefix = snap.atuTuning ? 'TU0;RX;' : (wasActive || sendDisconnectRx ? 'RX;' : '');
        try {
          this.sendCat(`${stopPrefix}TS0;`);
          cleanupSent = true;
        } catch (_) {
          // Ignore teardown errors.
        }
      }

      this.gate.setPolicy('rx-only');
      this.gate.setTxAudioAllowed(false);
      this._txPosture = 'rx-only';

      if (this.state && typeof this.state.updateTxSafety === 'function') {
        this.state.updateTxSafety(
          Object.assign(
            {
              operatingPolicy: 'rx-only',
              txPosture: 'rx-only',
              pttHeld: false,
              txStartedAt: null,
              txActive: false,
              atuTuning: false,
              atuTuneKind: null,
            },
            wasTestPosture ? { txTestMode: false } : null
          ),
          'txPosture'
        );
      }

      if (emitPttChange) {
        this.emit('txPttChange', {
          active: false,
          posture: 'rx-only',
          testMode: false,
        });
      }

      if (!silentCat && !cleanupSent && (wasActive || sendDisconnectRx) && isWsOpen(this._ws)) {
        try {
          this.sendCat(snap.atuTuning ? 'TU0;RX;' : 'RX;');
        } catch (_) {
          // Ignore teardown errors.
        }
      }
    }

    _stopKeepalive() {
      this._stopTbPolling();
      this._clearTotTimer();
      if (this._pingTimer !== null) {
        clearInterval(this._pingTimer);
        this._pingTimer = null;
      }
      this._clearBootstrapTimer();
      this._bootstrapSent = false;
    }

    _sendBootstrapAndStartKeepalive(gen, emMode, slTier) {
      if (gen !== this._connGen || !isWsOpen(this._ws) || this._bootstrapSent) {
        return;
      }
      this._stopKeepalive();
      this._bootstrapSent = true;

      const bootstrapCat =
        `RDY;K41;ER1;AI5;EM${emMode};SL${slTier};` +
        'FA;FB;MD;MD$;DT;DT$;BW;BW$;IS;IS$;CW;VT;VT$;LK;LK$;SB;FT;SMH;SMH$;' +
        '#SPN;#SPN$;#REF;#REF$;#SCL;#AVG;#WBS;#AR;#DPM;#MP;#MP$;#FXT;TD;TD$;MX;' +
        'SQ;SQ$;AP;AP$;RT;RT$;RO;RO$;DV;OV;OV$;#FRZ;#FPS;#NB;#NB$;#NBL;#NBL$;#DSM;#WFH;' +
        'SIFP1;SIRF1;SIDA1;TM1;PO1;SIDU1;SIRC1;';
      this.sendCat(bootstrapCat);
      this._syncTbPolling();

      this._pingTimer = setInterval(() => {
        if (gen !== this._connGen || !isWsOpen(this._ws)) {
          return;
        }
        this._lastPingSentPerfMs = nowMs();
        this.sendCat(K4.CatCodec.builders.ping(Math.floor(Date.now() / 1000)));
      }, 1000);

      this._attachPagehide();
    }

    _attachPagehide() {
      this._detachPagehide();
      if (typeof globalThis.addEventListener !== 'function') return;
      this._pagehideHandler = () => {
        this._sendCleanDisconnectCat();
      };
      globalThis.addEventListener('pagehide', this._pagehideHandler);
    }

    _detachPagehide() {
      if (this._pagehideHandler && typeof globalThis.removeEventListener === 'function') {
        globalThis.removeEventListener('pagehide', this._pagehideHandler);
      }
      this._pagehideHandler = null;
    }

    _sendCleanDisconnectCat() {
      this._disarmToRxOnly({ silentCat: false, emitPttChange: true });
      if (isWsOpen(this._ws)) {
        try {
          this.sendCat('RRN;');
        } catch (_) {
          // Ignore errors during page teardown.
        }
      }
    }

    _emitConnection() {
      this.emit('connection', this.state.getSnapshot().connection);
    }

    _resolveEncodeMode(encodeMode) {
      if (
        encodeMode === 0 ||
        encodeMode === 1 ||
        encodeMode === 2 ||
        encodeMode === 3 ||
        encodeMode === '0' ||
        encodeMode === '1' ||
        encodeMode === '2' ||
        encodeMode === '3'
      ) {
        return Number(encodeMode);
      }
      const opusSupported =
        K4.OpusPacketDecoder &&
        typeof K4.OpusPacketDecoder.isSupported === 'function' &&
        K4.OpusPacketDecoder.isSupported();
      return opusSupported ? 3 : 1;
    }

    _handleFrame(payload) {
      const pkt = K4.BinaryPackets.parse(payload);
      if (!pkt) return;

      if (!this._bootstrapSent) {
        this._sendBootstrapAndStartKeepalive(
          this._connGen,
          this._pendingEmMode,
          this._pendingSlTier
        );
      }

      const conn = this.state.getSnapshot().connection;
      if (conn.authStatus !== 'authenticated' || conn.status !== 'connected') {
        this.state.updateConnection({
          status: 'connected',
          authStatus: 'authenticated',
          error: null,
        });
        this._emitConnection();
      }

      switch (pkt.type) {
        case 0: {
          this._metrics.catPacketsIn++;
          const cmds = K4.CatCodec.splitFrames(pkt.text);
          for (let i = 0; i < cmds.length; i++) {
            const raw = cmds[i];
            const parsed = K4.CatCodec.parseCommand(raw);
            if (parsed) {
              if (parsed.kind === 'pong') {
                if (this._lastPingSentPerfMs !== null) {
                  const rttMs = Math.max(0, Math.round(nowMs() - this._lastPingSentPerfMs));
                  this.state.updateConnection({ rttMs });
                  this._emitConnection();
                }
              } else if (parsed.kind === 'radioError') {
                this.emit('error', {
                  source: 'radio',
                  code: parsed.code,
                  message: parsed.message || `K4 error ${parsed.code}`,
                  raw,
                });
              }
              this.state.applyParsedCat(parsed);
            }
            this.emit('cat', { parsed, raw });
          }
          break;
        }
        case 1:
          this._metrics.audioPacketsIn++;
          this.emit('audio', pkt);
          break;
        case 2:
          this._metrics.panPacketsIn++;
          this.state.applyPanMeta(pkt);
          this.emit('pan', { rx: pkt.rx, pkt });
          break;
        case 3:
          this._metrics.miniPanPacketsIn++;
          this.emit('minipan', { rx: pkt.rx, pkt });
          break;
        default:
          break;
      }
    }

    /**
     * Connect to the K4 WebSocket bridge, perform raw 96-byte SHA-384 auth, and bootstrap CAT.
     * @param {Object} [opts]
     * @returns {Promise<Object>} Resolves with connection snapshot after open and bootstrap send
     */
    connect(opts = {}) {
      const wsUrl = opts.wsUrl ? String(opts.wsUrl).trim() : Client.defaultWsUrl();
      const password = opts.password !== undefined && opts.password !== null ? String(opts.password) : '';
      const subprotocolMode = opts.subprotocolMode || 'auto';
      const encodeModeOpt = opts.encodeMode !== undefined ? opts.encodeMode : 'auto';
      const latencyTierOpt = opts.latencyTier !== undefined ? opts.latencyTier : 2;

      // Close any existing socket cleanly before opening a fresh session, and enforce 'rx-only'.
      if (this._ws) {
        this.disconnect();
      } else {
        this._disarmToRxOnly({ silentCat: true, emitPttChange: true });
      }

      const gen = ++this._connGen;
      this._manualDisconnect = false;
      this._lastPingSentPerfMs = null;
      this._framer.reset();

      let attempts;
      if (subprotocolMode === 'binary') {
        attempts = [['binary']];
      } else if (subprotocolMode === 'none') {
        attempts = [undefined];
      } else {
        attempts = [['binary'], undefined];
      }

      this.state.updateConnection({
        status: 'connecting',
        wsUrl,
        subprotocol: '',
        authStatus: 'none',
        error: null,
        rttMs: null,
      });
      this._emitConnection();

      return new Promise((resolve, reject) => {
        const tryAttempt = (attemptIdx) => {
          if (gen !== this._connGen) {
            reject(new Error('Connection superseded'));
            return;
          }

          const protocols = attempts[attemptIdx];
          let ws;
          try {
            ws = protocols ? new WebSocket(wsUrl, protocols) : new WebSocket(wsUrl);
          } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            this.state.updateConnection({
              status: 'error',
              authStatus: 'none',
              error: msg,
            });
            this._emitConnection();
            this.emit('error', { source: 'transport', message: msg, error: err });
            reject(err);
            return;
          }

          ws.binaryType = 'arraybuffer';
          this._ws = ws;
          let opened = false;
          let handledClose = false;

          ws.onopen = () => {
            if (gen !== this._connGen) {
              try {
                ws.close();
              } catch (_) {
                // Ignore superseded socket close.
              }
              return;
            }
            opened = true;
            this._framer.reset();

            const emMode = this._resolveEncodeMode(encodeModeOpt);
            const rawSl = Number(latencyTierOpt);
            const slTier = clamp(Math.round(Number.isFinite(rawSl) ? rawSl : 2), 0, 7);

            // K4 does not echo SL; apply SL and EM immediately into RadioState.
            this.state.update({ streamingLatency: slTier, encodeMode: emMode }, 'streamingLatency');

            const negotiatedProto = ws.protocol || (protocols ? 'binary' : 'none');
            this.state.updateConnection({
              status: 'authenticating',
              authStatus: 'authenticating',
              subprotocol: negotiatedProto,
              error: null,
            });
            this._emitConnection();

            // Send unframed 96-byte lowercase ASCII SHA-384 hex digest immediately on open.
            const authHex = K4.sha384HexSync(password);
            const authBytes = encodeAsciiBytes(authHex);
            ws.send(authBytes);
            this._metrics.bytesOut += authBytes.byteLength;

            // Match QK4 post-auth ordering: wait for first valid K4 response or 250 ms fallback before bootstrap/PING.
            this._stopKeepalive();
            this._pendingEmMode = emMode;
            this._pendingSlTier = slTier;
            this._bootstrapTimer = setTimeout(() => {
              this._bootstrapTimer = null;
              if (gen === this._connGen && isWsOpen(this._ws) && !this._bootstrapSent) {
                this._sendBootstrapAndStartKeepalive(gen, emMode, slTier);
              }
            }, 250);

            resolve(this.state.getSnapshot().connection);
          };

          ws.onmessage = (ev) => {
            if (gen !== this._connGen) return;
            const data = ev.data;
            if (data instanceof ArrayBuffer) {
              this._metrics.wsMessages++;
              this._metrics.bytesIn += data.byteLength;
              this._framer.push(new Uint8Array(data));
            } else if (data && typeof data.arrayBuffer === 'function') {
              data.arrayBuffer().then((buf) => {
                if (gen !== this._connGen) return;
                this._metrics.wsMessages++;
                this._metrics.bytesIn += buf.byteLength;
                this._framer.push(new Uint8Array(buf));
              });
            }
          };

          ws.onerror = () => {
            if (gen !== this._connGen) return;
            if (opened) {
              this.emit('error', {
                source: 'transport',
                message: 'WebSocket transport error',
              });
            }
          };

          ws.onclose = (ev) => {
            if (handledClose || gen !== this._connGen) return;
            handledClose = true;
            ws.onopen = null;
            ws.onmessage = null;
            ws.onerror = null;
            ws.onclose = null;

            this._stopKeepalive();
            this._detachPagehide();
            if (this._ws === ws) {
              this._ws = null;
            }
            this._disarmToRxOnly({ silentCat: true, emitPttChange: true });

            if (!opened) {
              if (!this._manualDisconnect && attemptIdx + 1 < attempts.length) {
                tryAttempt(attemptIdx + 1);
                return;
              }
              const errMsg =
                'WebSocket connection failed (verify websockify/websocat bridge and endpoint URL)';
              this.state.updateConnection({
                status: 'error',
                authStatus: 'none',
                error: errMsg,
                rttMs: null,
              });
              this._emitConnection();
              const err = new Error(errMsg);
              this.emit('error', { source: 'transport', message: errMsg, error: err });
              reject(err);
              return;
            }

            if (this._manualDisconnect) {
              this.state.updateConnection({
                status: 'disconnected',
                authStatus: 'none',
                error: null,
                rttMs: null,
              });
              this._emitConnection();
              return;
            }

            const currentConn = this.state.getSnapshot().connection;
            if (currentConn.authStatus === 'authenticating') {
              const authErr =
                'Authentication rejected or socket closed before K4 handshake (check K4 network password)';
              this.state.updateConnection({
                status: 'error',
                authStatus: 'rejected',
                error: authErr,
                rttMs: null,
              });
              this._emitConnection();
              this.emit('error', { source: 'auth', message: authErr });
              return;
            }

            const clean = ev && ev.wasClean;
            const code = ev && ev.code !== undefined ? ev.code : 1006;
            const closeErr = clean ? null : `WebSocket closed unexpectedly (code ${code})`;
            this.state.updateConnection({
              status: clean ? 'disconnected' : 'error',
              authStatus: 'none',
              error: closeErr,
              rttMs: null,
            });
            this._emitConnection();
          };
        };

        tryAttempt(0);
      });
    }

    /**
     * Cleanly send RRN;, stop keepalive, and close the WebSocket connection.
     */
    disconnect() {
      this._manualDisconnect = true;
      this._connGen++;
      this._stopKeepalive();
      this._detachPagehide();

      const ws = this._ws;
      const wsWasOpen = isWsOpen(ws);
      this._disarmToRxOnly({ silentCat: !wsWasOpen, emitPttChange: true });

      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try {
          if (isWsOpen(ws)) {
            this.sendCat('RRN;');
            ws.close(1000, 'Client disconnect');
          } else if (isWsConnecting(ws)) {
            ws.close();
          }
        } catch (_) {
          // Ignore close errors.
        }
      }
      this._ws = null;

      this.state.updateConnection({
        status: 'disconnected',
        authStatus: 'none',
        error: null,
        rttMs: null,
      });
      this._emitConnection();
    }

    /**
     * Filter a CAT command string through RxOnlyGate and send if allowed and connected.
     * @param {string} cmdStr
     * @returns {{ sent: boolean, allowed: string[], blocked: string[], sanitized: string }}
     */
    sendCat(cmdStr) {
      const verdict = this.gate.inspectCat(cmdStr);
      if (
        verdict.sanitized.length > 0 &&
        isWsOpen(this._ws) &&
        this.gate.inspectBinary(0x00)
      ) {
        const framed = K4.PacketFramer.encodeCatPacket(verdict.sanitized);
        this._ws.send(framed);
        this._metrics.catPacketsOut++;
        this._metrics.bytesOut += framed.byteLength;
        return {
          sent: true,
          allowed: verdict.allowed,
          blocked: verdict.blocked,
          sanitized: verdict.sanitized,
        };
      }
      return {
        sent: false,
        allowed: verdict.allowed,
        blocked: verdict.blocked,
        sanitized: verdict.sanitized,
      };
    }

    /**
     * Gate and send an outbound binary packet (blocked in rx-only for any type != 0x00).
     * @param {number} typeByte
     * @param {Uint8Array} payloadUint8
     * @returns {{ sent: boolean, blocked: boolean }}
     */
    sendBinary(typeByte, payloadUint8) {
      if (!this.gate.inspectBinary(typeByte)) {
        return { sent: false, blocked: true };
      }
      if (!isWsOpen(this._ws)) {
        return { sent: false, blocked: false };
      }
      const framed = K4.PacketFramer.encodePacket(payloadUint8);
      this._ws.send(framed);
      this._metrics.bytesOut += framed.byteLength;
      return { sent: true, blocked: false };
    }

    /**
     * Tune receiver 'A' or 'B' to `freqHz`, clamped to 100 kHz .. 54 MHz.
     * @param {'A'|'B'} rx
     * @param {number} freqHz
     * @param {{ optimistically?: boolean }} [opts]
     */
    tune(rx, freqHz, { optimistically = true } = {}) {
      const target = rx === 'B' ? 'B' : 'A';
      const clamped = Math.round(clamp(Number(freqHz), 100000, 54000000));
      if (optimistically) {
        this.state.updateRx(
          target,
          { freqHz: clamped },
          target === 'B' ? 'rxB.freqHz' : 'rxA.freqHz'
        );
      }
      const res = this.sendCat(K4.CatCodec.builders.freq(target, clamped));
      return Object.assign({ freqHz: clamped }, res);
    }

    /**
     * Step receiver 'A' or 'B' frequency by `steps * stepHz`.
     * @param {'A'|'B'} rx
     * @param {number} steps
     * @param {number} [stepHzOverride]
     */
    stepFrequency(rx, steps, stepHzOverride) {
      const target = rx === 'B' ? 'B' : 'A';
      const rxState = this.state.getRx(target);
      const stepHz =
        Number.isFinite(stepHzOverride) && stepHzOverride > 0
          ? stepHzOverride
          : rxState.stepHz || 100;
      const nextHz = rxState.freqHz + Math.round(Number(steps)) * stepHz;
      return this.tune(target, nextHz);
    }

    /**
     * Switch receiver 'A' or 'B' band using a band id ('20m'), BN code ('05'), or band object.
     * @param {'A'|'B'} rx
     * @param {string|Object} bandIdOrDef
     */
    setBand(rx, bandIdOrDef) {
      const target = rx === 'B' ? 'B' : 'A';
      const band = resolveBand(bandIdOrDef);
      if (!band) {
        throw new RangeError(`Unknown K4 band: ${bandIdOrDef}`);
      }
      const current = this.state.getRx(target);
      const patch = { band };
      if (
        Number.isFinite(band.defaultHz) &&
        (current.freqHz < band.startHz || current.freqHz > band.endHz)
      ) {
        patch.freqHz = band.defaultHz;
      }
      this.state.updateRx(target, patch, target === 'B' ? 'rxB.band' : 'rxA.band');
      return this.sendCat(K4.CatCodec.builders.band(target, band.bn));
    }

    /**
     * Set operating mode (and optional data sub-mode) on receiver 'A' or 'B'.
     * Accepts numeric mode code or mode key ('LSB', 'CW-R', 'DATA-A', 'AFSK-A', 'FSK-D', 'PSK-D', etc.).
     * @param {'A'|'B'} rx
     * @param {number|string} modeKey
     * @param {number} [dataSubMode]
     */
    setMode(rx, modeKey, dataSubMode) {
      const target = rx === 'B' ? 'B' : 'A';
      let modeCode;
      let resolvedSubMode =
        dataSubMode !== undefined && dataSubMode !== null ? Number(dataSubMode) : null;

      if (typeof modeKey === 'number') {
        modeCode = modeKey;
      } else {
        const str = String(modeKey).trim().toUpperCase();
        if (/^\d+$/.test(str)) {
          modeCode = parseInt(str, 10);
        } else if (MODE_KEY_MAP[str]) {
          modeCode = MODE_KEY_MAP[str].modeCode;
          if (resolvedSubMode === null && MODE_KEY_MAP[str].subMode !== undefined) {
            resolvedSubMode = MODE_KEY_MAP[str].subMode;
          }
        } else {
          throw new RangeError(`Unsupported K4 mode: ${modeKey}`);
        }
      }

      const patch = { mode: modeCode };
      const cmds = [K4.CatCodec.builders.mode(target, modeCode)];
      if (resolvedSubMode !== null && Number.isFinite(resolvedSubMode)) {
        const sub = clamp(Math.round(resolvedSubMode), 0, 3);
        patch.dataSubMode = sub;
        cmds.push(K4.CatCodec.builders.dataSubMode(target, sub));
      }

      this.state.updateRx(target, patch, target === 'B' ? 'rxB.mode' : 'rxA.mode');
      return this.sendCat(cmds.join(''));
    }

    /**
     * Update panadapter/waterfall display parameters and send validated CAT commands.
     * @param {'A'|'B'} rx
     * @param {Object} patch
     */
    setDisplay(rx, patch) {
      if (!patch || typeof patch !== 'object') {
        return { sent: false, allowed: [], blocked: [], sanitized: '' };
      }
      const target = rx === 'B' ? 'B' : 'A';
      const cmds = [];
      const rxPatch = {};
      const globalDisplayPatch = {};
      const topPatch = {};
      let sentArm = false;

      const spanVal = patch.panSpanHz !== undefined ? patch.panSpanHz : patch.spanHz;
      if (spanVal !== undefined) {
        const v = Math.round(clamp(Number(spanVal), 6000, 368000));
        rxPatch.panSpanHz = v;
        cmds.push(K4.CatCodec.builders.panSpan(target, v));
      }

      const refVal = patch.panRefDbm !== undefined ? patch.panRefDbm : patch.refDbm;
      if (refVal !== undefined) {
        if (patch.autoRef !== true) {
          const curA = this.state.getRx('A');
          const curB = this.state.getRx('B');
          if (curA.autoRef || curB.autoRef) {
            cmds.push(K4.CatCodec.builders.autoRef(false));
            globalDisplayPatch.autoRef = false;
            sentArm = true;
          }
        }
        const v = Math.round(clamp(Number(refVal), -160, 20));
        rxPatch.panRefDbm = v;
        cmds.push(K4.CatCodec.builders.panRef(target, v));
      }

      const scaleVal = patch.panScaleDb !== undefined ? patch.panScaleDb : patch.scaleDb;
      if (scaleVal !== undefined) {
        const v = Math.round(clamp(Number(scaleVal), 10, 150));
        globalDisplayPatch.panScaleDb = v;
        cmds.push(K4.CatCodec.builders.panScale(v));
      }

      const avgVal = patch.panAvg !== undefined ? patch.panAvg : patch.avg;
      if (avgVal !== undefined) {
        const v = Math.round(clamp(Number(avgVal), 1, 20));
        topPatch.panAvg = v;
        cmds.push(K4.CatCodec.builders.panAvg(v));
      }

      if (patch.wfBlack !== undefined) {
        const v = Math.round(clamp(Number(patch.wfBlack), 5, 30));
        globalDisplayPatch.wfBlack = v;
        cmds.push(K4.CatCodec.builders.wfBlack(v));
      }

      if (patch.autoRef !== undefined) {
        const v = Boolean(patch.autoRef);
        globalDisplayPatch.autoRef = v;
        if (v) {
          cmds.push(K4.CatCodec.builders.autoRef(true));
          cmds.push(K4.CatCodec.builders.autoRefOneShot());
          cmds.push('#REF;#REF$;');
        } else {
          if (!sentArm) {
            cmds.push(K4.CatCodec.builders.autoRef(false));
          }
          cmds.push('#REF;#REF$;');
        }
      }

      if (patch.dualPanMode !== undefined) {
        const v = Math.round(clamp(Number(patch.dualPanMode), 0, 2));
        topPatch.dualPanMode = v;
        cmds.push(K4.CatCodec.builders.dualPan(v));
      }

      if (patch.fixedTune !== undefined) {
        const v = Boolean(patch.fixedTune);
        topPatch.fixedTune = v;
        cmds.push(K4.CatCodec.builders.fixedTune(v));
      }

      if (patch.miniPan !== undefined) {
        const v = Boolean(patch.miniPan);
        rxPatch.miniPan = v;
        cmds.push(K4.CatCodec.builders.miniPan(target, v));
        cmds.push(`#MP${target === 'B' ? '$' : ''};`);
      }

      if (patch.panFrozen !== undefined) {
        const v = Boolean(patch.panFrozen);
        topPatch.panFrozen = v;
        cmds.push(K4.CatCodec.builders.panFreeze(v), '#FRZ;');
      }

      if (patch.panFps !== undefined) {
        const v = Math.round(clamp(Number(patch.panFps) || 20, 1, 30));
        topPatch.panFps = v;
        cmds.push(K4.CatCodec.builders.panFps(v), '#FPS;');
      }

      if (patch.displayMode !== undefined) {
        const v = Number(patch.displayMode) === 0 || Number(patch.displayMode) === 2 ? 0 : 1;
        topPatch.displayMode = v;
        cmds.push(K4.CatCodec.builders.displayMode(v), '#DSM;');
      }

      if (patch.waterfallHeightPct !== undefined) {
        const v = Math.round(clamp(Number(patch.waterfallHeightPct), 0, 100));
        topPatch.waterfallHeightPct = v;
        cmds.push(K4.CatCodec.builders.waterfallHeight(v), '#WFH;');
      }

      if (patch.panNbMode !== undefined) {
        const v = Math.round(clamp(Number(patch.panNbMode) || 0, 0, 2));
        rxPatch.panNbMode = v;
        cmds.push(K4.CatCodec.builders.panNb(target, v), `#NB${target === 'B' ? '$' : ''};`);
      }

      if (patch.panNbLevel !== undefined) {
        const v = Math.round(clamp(Number(patch.panNbLevel) || 0, 0, 14));
        rxPatch.panNbLevel = v;
        cmds.push(K4.CatCodec.builders.panNbLevel(target, v), `#NBL${target === 'B' ? '$' : ''};`);
      }

      if (Object.keys(rxPatch).length > 0) {
        this.state.updateRx(target, rxPatch, target === 'B' ? 'rxB.display' : 'rxA.display');
      }
      if (Object.keys(globalDisplayPatch).length > 0) {
        this.state.updateRx('A', globalDisplayPatch, 'display');
        this.state.updateRx('B', globalDisplayPatch, 'display');
      }
      if (Object.keys(topPatch).length > 0) {
        this.state.update(topPatch, 'display');
      }

      return this.sendCat(cmds.join(''));
    }

    /**
     * Trigger one-shot Auto-Reference (#AR1) and re-query both #REF values.
     */
    applyAutoRefNow() {
      return this.sendCat(K4.CatCodec.builders.autoRefOneShot() + '#REF;#REF$;');
    }

    /**
     * Configure CW / DATA text decode (TD / TD$) and immediately poll TD/TB.
     * @param {'A'|'B'} rx
     * @param {{ mode?: number, threshold?: number, lines?: number }} opts
     */
    setTextDecode(rx, opts = {}) {
      const target = rx === 'B' ? 'B' : 'A';
      const cur = this.state.getRx(target);
      const mode = Math.round(
        clamp(Number(opts.mode !== undefined ? opts.mode : cur.textDecodeMode || 0), 0, 4)
      );
      const threshold = Math.round(
        clamp(Number(opts.threshold !== undefined ? opts.threshold : cur.textDecodeThreshold || 0), 0, 9)
      );
      const fallbackLines = mode > 0 ? Math.max(1, cur.textDecodeLines || 1) : 0;
      const lines = Math.round(
        clamp(Number(opts.lines !== undefined ? opts.lines : fallbackLines), 0, 4)
      );
      const cmd = K4.CatCodec.builders.textDecode(target, mode, threshold, lines);
      const dollar = target === 'B' ? '$' : '';
      this.state.updateRx(
        target,
        {
          textDecodeMode: mode,
          textDecodeThreshold: threshold,
          textDecodeLines: lines,
          textDecodeEnabled: mode > 0,
        },
        target === 'B' ? 'rxB.textDecode' : 'rxA.textDecode'
      );
      this._syncTbPolling();
      return this.sendCat(`${cmd}TD${dollar};TB${dollar};`);
    }

    /**
     * Set K4 audio mix matrix (MX preset).
     * @param {string} mix
     */
    setAudioMix(mix) {
      const m = String(mix).trim().toUpperCase();
      const cmd = K4.CatCodec.builders.audioMix(m);
      this.state.update({ audioMix: m }, 'audioMix');
      return this.sendCat(cmd);
    }

    /**
     * Set streaming audio encode mode (EM0..EM3).
     * @param {number} em
     */
    setEncodeMode(em) {
      const mode = Math.round(clamp(Number(em), 0, 3));
      this.state.update({ encodeMode: mode }, 'encodeMode');
      return this.sendCat(K4.CatCodec.builders.encodeMode(mode));
    }

    /**
     * Set remote streaming audio latency tier (SL0..SL7).
     * Self-applies to RadioState immediately since K4 never echoes SL.
     * @param {number} sl
     */
    setLatencyTier(sl) {
      const tier = Math.round(clamp(Number(sl), 0, 7));
      this.state.update({ streamingLatency: tier }, 'streamingLatency');
      return this.sendCat(K4.CatCodec.builders.streamingLatency(tier));
    }

    /**
     * Set receiver filter bandwidth (BW) and/or IF center pitch (IS).
     * @param {'A'|'B'} rx
     * @param {{ bwHz?: number, ifShiftHz?: number }} patch
     */
    setFilter(rx, patch = {}) {
      const target = rx === 'B' ? 'B' : 'A';
      const cmds = [];
      const rxPatch = {};
      if (patch.bwHz !== undefined) {
        const bwHz = Math.round(clamp(Number(patch.bwHz), 50, 5000));
        rxPatch.bwHz = bwHz;
        cmds.push(K4.CatCodec.builders.bw(target, bwHz));
      }
      if (patch.ifShiftHz !== undefined) {
        const ifShiftHz = Math.round(clamp(Number(patch.ifShiftHz), 0, 5000));
        rxPatch.ifShiftHz = ifShiftHz;
        cmds.push(K4.CatCodec.builders.ifShift(target, ifShiftHz));
      }
      if (Object.keys(rxPatch).length > 0) {
        this.state.updateRx(target, rxPatch, target === 'B' ? 'rxB.filter' : 'rxA.filter');
      }
      return this.sendCat(cmds.join(''));
    }

    /**
     * Set tuning step index (VT, 0..6).
     * @param {'A'|'B'} rx
     * @param {number} stepIdx
     */
    setStep(rx, stepIdx) {
      const target = rx === 'B' ? 'B' : 'A';
      const idx = Math.round(clamp(Number(stepIdx), 0, K4.STEP_HZ_TABLE.length - 1));
      const stepHz = K4.STEP_HZ_TABLE[idx];
      const modeCode = this.state.getRx(target).mode;
      this.state.updateRx(
        target,
        { stepIdx: idx, stepHz },
        target === 'B' ? 'rxB.stepHz' : 'rxA.stepHz'
      );
      return this.sendCat(K4.CatCodec.builders.step(target, idx, modeCode));
    }

    /**
     * Toggle Sub-RX on/off (SB0/SB1).
     * @param {boolean} on
     */
    setSubRx(on) {
      const enabled = Boolean(on);
      this.state.update({ subRxEnabled: enabled }, 'subRxEnabled');
      return this.sendCat(K4.CatCodec.builders.subRx(enabled));
    }

    /**
     * Lock or unlock VFO tuning (LK/LK$).
     * @param {'A'|'B'} rx
     * @param {boolean} locked
     */
    setLock(rx, locked) {
      const target = rx === 'B' ? 'B' : 'A';
      const on = Boolean(locked);
      this.state.updateRx(target, { locked: on }, target === 'B' ? 'rxB.locked' : 'rxA.locked');
      return this.sendCat(K4.CatCodec.builders.lock(target, on));
    }

    /**
     * Configure RIT (RT/RO/RC) on receiver 'A' or 'B'.
     * @param {'A'|'B'} rx
     * @param {{ on?: boolean, offsetHz?: number, clear?: boolean }} patch
     */
    setRit(rx, patch = {}) {
      const target = rx === 'B' ? 'B' : 'A';
      const dollar = target === 'B' ? '$' : '';
      const cmds = [];
      const rxPatch = {};
      if (patch.clear) {
        rxPatch.ritOffsetHz = 0;
        cmds.push(K4.CatCodec.builders.ritClear(target));
      }
      if (patch.on !== undefined) {
        const on = Boolean(patch.on);
        rxPatch.ritOn = on;
        cmds.push(K4.CatCodec.builders.rit(target, on));
      }
      if (patch.offsetHz !== undefined) {
        const hz = Math.round(clamp(Number(patch.offsetHz) || 0, -9999, 9999));
        rxPatch.ritOffsetHz = hz;
        cmds.push(K4.CatCodec.builders.ritOffset(target, hz));
      }
      if (Object.keys(rxPatch).length > 0) {
        this.state.updateRx(target, rxPatch, target === 'B' ? 'rxB.rit' : 'rxA.rit');
        cmds.push(`RT${dollar};`, `RO${dollar};`);
      }
      return this.sendCat(cmds.join(''));
    }

    /**
     * Zero RIT offset on receiver 'A' or 'B' (RC / RC$).
     * @param {'A'|'B'} rx
     */
    clearRit(rx) {
      return this.setRit(rx, { clear: true });
    }

    /**
     * Configure CW Audio Peaking Filter (AP / AP$) on receiver 'A' or 'B'.
     * @param {'A'|'B'} rx
     * @param {{ on?: boolean, bwIdx?: number }} patch
     */
    setApf(rx, patch = {}) {
      const target = rx === 'B' ? 'B' : 'A';
      const dollar = target === 'B' ? '$' : '';
      const cur = this.state.getRx(target);
      const on = patch.on !== undefined ? Boolean(patch.on) : Boolean(cur.apfOn);
      const bwIdx = Math.round(
        clamp(Number(patch.bwIdx !== undefined ? patch.bwIdx : cur.apfBwIdx || 0), 0, 2)
      );
      this.state.updateRx(
        target,
        { apfOn: on, apfBwIdx: bwIdx },
        target === 'B' ? 'rxB.apf' : 'rxA.apf'
      );
      return this.sendCat(`${K4.CatCodec.builders.apf(target, on, bwIdx)}AP${dollar};`);
    }

    /**
     * Set receiver squelch level (SQ / SQ$, 0..40).
     * @param {'A'|'B'} rx
     * @param {number} level
     */
    setSquelch(rx, level) {
      const target = rx === 'B' ? 'B' : 'A';
      const dollar = target === 'B' ? '$' : '';
      const v = Math.round(clamp(Number(level) || 0, 0, 40));
      this.state.updateRx(target, { squelch: v }, target === 'B' ? 'rxB.squelch' : 'rxA.squelch');
      return this.sendCat(`${K4.CatCodec.builders.squelch(target, v)}SQ${dollar};`);
    }

    /**
     * Toggle Diversity Receive mode (DV0/DV1). Turning DV1 on hardware also enables Sub-RX and copies A->B.
     * @param {boolean} on
     */
    setDiversity(on) {
      const enabled = Boolean(on);
      const snap = this.state.getSnapshot();
      if (enabled && snap.hasSubRx !== false) {
        this.state.update({ diversityEnabled: true, subRxEnabled: true }, 'diversityEnabled');
        return this.sendCat('DV1;DV;SB;MD$;BW$;IS$;');
      }
      this.state.update({ diversityEnabled: false }, 'diversityEnabled');
      return this.sendCat('DV0;DV;');
    }

    /**
     * Query read-only TX, ATU, antenna, voice, and keyer parameters cleanly.
     */
    refreshTxState() {
      return this.sendCat(
        'TQX;IN;TS;PC;PCX;AT;AN;ACT;ACN1;ACN2;ACN3;XT;MG;MI;MS;CP;ML0;ML1;ML2;KS;KP;VXC;VXV;VXD;'
      );
    }

    /**
     * Return current TX safety posture ('rx-only', 'tx-test', or 'tx-armed').
     * @returns {'rx-only'|'tx-test'|'tx-armed'}
     */
    getTxPosture() {
      return this._txPosture;
    }

    /**
     * Set active TX operating posture ('rx-only', 'tx-test', or 'tx-armed').
     * Disarming to 'rx-only' sets gate policy first so no stray TX command can leak.
     * @param {'rx-only'|'tx-test'|'tx-armed'} posture
     * @param {{ silentCat?: boolean }} [opts]
     */
    setTxPosture(posture, opts = {}) {
      if (posture !== 'rx-only' && posture !== 'tx-test' && posture !== 'tx-armed') {
        throw new RangeError(`Unsupported TX posture: ${posture}`);
      }
      const silentCat = Boolean(opts && opts.silentCat);
      if (posture === 'rx-only') {
        this._disarmToRxOnly({ silentCat, emitPttChange: true });
        return { sent: !silentCat, allowed: [], blocked: [], sanitized: '' };
      }

      this._clearTotTimer();
      this.gate.setTxAudioAllowed(false);
      this._txPosture = posture;
      this.gate.setPolicy('tx-enabled');

      const isTest = posture === 'tx-test';
      this.state.updateTxSafety(
        {
          operatingPolicy: 'tx-enabled',
          txPosture: posture,
          txTestMode: isTest,
          pttHeld: false,
          txStartedAt: null,
        },
        'txPosture'
      );

      this.emit('txPttChange', {
        active: false,
        posture,
        testMode: isTest,
      });

      if (silentCat) {
        return { sent: false, allowed: [], blocked: [], sanitized: '' };
      }
      return this.sendCat(isTest ? 'TS1;TM1;PO1;' : 'TS0;TM1;PO1;');
    }

    /**
     * Engage hold-only PTT in 'tx-test' or 'tx-armed', arming outbound 0x01 TX audio and TOT deadman timer.
     * @param {{ maxSeconds?: number }} [opts]
     */
    startPtt(opts = {}) {
      const snap = this.state.getSnapshot();
      if (this._txPosture === 'rx-only' || this.gate.getPolicy() !== 'tx-enabled') {
        return { sent: false, blocked: true, allowed: [], sanitized: '', reason: 'TX posture is rx-only' };
      }
      if (snap.txInhibit) {
        return { sent: false, blocked: true, allowed: [], sanitized: '', reason: 'TX INHIBIT active' };
      }
      if (!isWsOpen(this._ws)) {
        return { sent: false, blocked: false, allowed: [], sanitized: '', reason: 'Not connected' };
      }

      this._clearTotTimer();
      this.state.resetTxMeterPeaks();
      this.gate.setTxAudioAllowed(true);

      const startedAt = snap.pttHeld && snap.txStartedAt ? snap.txStartedAt : Date.now();
      this.state.updateTxSafety({ pttHeld: true, txStartedAt: startedAt }, 'pttHeld');

      const requestedSec = opts && Number(opts.maxSeconds);
      const timeoutSec =
        Number.isFinite(requestedSec) && requestedSec > 0
          ? requestedSec
          : Number.isFinite(snap.txTimeoutSec) && snap.txTimeoutSec > 0
          ? snap.txTimeoutSec
          : 180;

      this._totTimer = setTimeout(() => {
        this._totTimer = null;
        this.panicAbortTx('timeout');
      }, Math.max(100, Math.round(timeoutSec * 1000)));

      const res = this.sendCat('TX;TM1;PO1;');
      this.emit('txPttChange', {
        active: true,
        posture: this._txPosture,
        testMode: this._txPosture === 'tx-test' || Boolean(snap.txTestMode),
      });
      return res;
    }

    /**
     * Release hold-only PTT, stop outbound TX audio, clear TOT timer, and return to RX (RX;).
     */
    stopPtt() {
      this._clearTotTimer();
      this.gate.setTxAudioAllowed(false);
      this.state.updateTxSafety({ pttHeld: false, txStartedAt: null }, 'pttHeld');
      this.emit('txPttChange', {
        active: false,
        posture: this._txPosture,
        testMode: this._txPosture === 'tx-test',
      });
      return this.sendCat('RX;');
    }

    /**
     * Send an outbound 0x01 TX audio packet gated by RxOnlyGate policy and txAudioAllowed.
     * @param {Uint8Array} payloadUint8
     * @returns {{ sent: boolean, blocked: boolean }}
     */
    sendTxAudioPacket(payloadUint8) {
      return this.sendBinary(0x01, payloadUint8);
    }

    /**
     * Unconditional emergency panic TX/ATU/keyer abort (TU0;KY @;RX;).
     * @param {string} [reason='panic']
     */
    panicAbortTx(reason = 'panic') {
      this._clearTotTimer();
      this.gate.setTxAudioAllowed(false);
      this.state.updateTxSafety(
        {
          pttHeld: false,
          txStartedAt: null,
          txActive: false,
          atuTuning: false,
          atuTuneKind: null,
          txBufferCount: 0,
        },
        'txActive'
      );
      this.emit('txPttChange', {
        active: false,
        posture: this._txPosture,
        testMode: this._txPosture === 'tx-test',
        reason,
      });
      this.emit('txPanic', { reason, timestamp: Date.now() });
      return this.sendCat('TU0;KY @;RX;');
    }

    /**
     * Select TX antenna port (AN1..AN3).
     * @param {number} port
     */
    setTxAntenna(port) {
      const p = clamp(Math.round(Number(port) || 1), 1, 3);
      const res = this.sendCat(K4.CatCodec.builders.txAntenna(p) + 'AN;');
      if (res.blocked.length === 0) {
        this.state.update({ txAntenna: p }, 'txAntenna');
      }
      return res;
    }

    /**
     * Set KAT4 ATU mode (1 = BYPASS, 2 = AUTO). Never emits AT0.
     * @param {number} mode
     */
    setAtuMode(mode) {
      const m = clamp(Math.round(Number(mode) || 1), 1, 2);
      const res = this.sendCat(K4.CatCodec.builders.atuMode(m) + 'AT;');
      if (res.blocked.length === 0) {
        this.state.update({ atuMode: m }, 'atuMode');
      }
      return res;
    }

    /**
     * Start TX tune or KAT4 ATU tune (1=tune, 2=tune LP, 3=ATU tune, 4=ATU extended search).
     * @param {number} [kind=3]
     */
    startAtuTune(kind = 3) {
      const k = clamp(Math.round(Number(kind) || 3), 1, 4);
      if (this.state.getSnapshot().txInhibit) {
        return {
          sent: false,
          allowed: [],
          blocked: [K4.CatCodec.builders.atuTune(k)],
          sanitized: '',
          reason: 'TX INHIBIT active',
        };
      }
      this.state.resetTxMeterPeaks();
      const res = this.sendCat(K4.CatCodec.builders.atuTune(k) + 'TM1;PO1;');
      if (res.blocked.length === 0) {
        this.state.update({ atuTuning: true, atuTuneKind: k }, 'atuTuning');
      }
      return res;
    }

    /**
     * Abort active ATU tune or tune cycle (TU0;RX;).
     */
    stopAtuTune() {
      this.state.update({ atuTuning: false, atuTuneKind: null }, 'atuTuning');
      return this.sendCat('TU0;RX;');
    }

    /**
     * Set RF power output in watts ('L' 0.1..10.0 W, 'H' 1..110 W, or 'X' mW range).
     * @param {number} watts
     * @param {'L'|'H'|'X'} [range]
     */
    setPowerWatts(watts, range) {
      const cmd = K4.CatCodec.builders.power(watts, range);
      const res = this.sendCat(cmd + 'PC;');
      if (res.blocked.length === 0) {
        const parsed = K4.CatCodec.parseCommand(cmd);
        if (parsed) {
          this.state.applyParsedCat(parsed);
        }
      }
      return res;
    }

    /**
     * Toggle Split operation (FT0/FT1).
     * @param {boolean} on
     */
    setSplit(on) {
      const enabled = Boolean(on);
      const res = this.sendCat(K4.CatCodec.builders.split(enabled) + 'FT;');
      if (res.blocked.length === 0) {
        this.state.update(
          { splitEnabled: enabled, activeTxVfo: enabled ? 'B' : 'A' },
          'splitEnabled'
        );
      }
      return res;
    }

    /**
     * Configure Quick Split: copy VFO A -> B (AB3), tune VFO B to FA + offsetHz, and enable FT1.
     * @param {number} [offsetHz=1000]
     */
    setupQuickSplit(offsetHz = 1000) {
      const snap = this.state.getSnapshot();
      const baseHz = snap.rxA && Number.isFinite(snap.rxA.freqHz) ? snap.rxA.freqHz : 14074000;
      const targetHz = Math.round(clamp(baseHz + (Number(offsetHz) || 0), 100000, 54000000));
      const cmd =
        K4.CatCodec.builders.vfoCopy(3) +
        K4.CatCodec.builders.freq('B', targetHz) +
        K4.CatCodec.builders.split(true) +
        'FB;MD$;FT;';
      const res = this.sendCat(cmd);
      if (res.blocked.length === 0) {
        this.state.updateRx(
          'B',
          {
            freqHz: targetHz,
            mode: snap.rxA ? snap.rxA.mode : undefined,
            dataSubMode: snap.rxA ? snap.rxA.dataSubMode : undefined,
          },
          'rxB.freqHz'
        );
        this.state.update({ splitEnabled: true, activeTxVfo: 'B' }, 'splitEnabled');
      }
      return res;
    }

    /**
     * Enable/disable XIT (XT0/XT1) and optionally adjust RIT/XIT offset (RO).
     * @param {boolean|null|undefined} on
     * @param {number|null|undefined} [offsetHz]
     */
    setXit(on, offsetHz) {
      const cmds = [];
      const hasOn = on !== undefined && on !== null;
      const hasOffset = offsetHz !== undefined && offsetHz !== null;
      if (hasOn) {
        cmds.push(K4.CatCodec.builders.xit(Boolean(on)));
      }
      if (hasOffset) {
        const hz = Math.round(clamp(Number(offsetHz) || 0, -9999, 9999));
        cmds.push(K4.CatCodec.builders.ritOffset('A', hz), 'RO;');
      }
      if (hasOn) {
        cmds.push('XT;');
      }
      if (cmds.length === 0) {
        return { sent: false, allowed: [], blocked: [], sanitized: '' };
      }
      const res = this.sendCat(cmds.join(''));
      if (res.blocked.length === 0) {
        if (hasOn) {
          this.state.update({ xitEnabled: Boolean(on) }, 'xitEnabled');
        }
        if (hasOffset) {
          const hz = Math.round(clamp(Number(offsetHz) || 0, -9999, 9999));
          this.state.updateRx('A', { ritOffsetHz: hz }, 'rxA.rit');
        }
      }
      return res;
    }

    /**
     * Set TX microphone gain (MG, 0..80).
     * @param {number} v
     */
    setMicGain(v) {
      const val = Math.round(clamp(Number(v) || 0, 0, 80));
      const res = this.sendCat(K4.CatCodec.builders.micGain(val) + 'MG;');
      if (res.blocked.length === 0) {
        this.state.update({ micGain: val }, 'micGain');
      }
      return res;
    }

    /**
     * Set speech compressor level in dB (CP, 0..30).
     * @param {number} v
     */
    setCompression(v) {
      const val = Math.round(clamp(Number(v) || 0, 0, 30));
      const res = this.sendCat(K4.CatCodec.builders.compLevel(val) + 'CP;');
      if (res.blocked.length === 0) {
        this.state.update({ compDbSet: val }, 'compDbSet');
      }
      return res;
    }

    /**
     * Set TX monitor sidetone/audio level (ML, channel 0=CW, 1=Data, 2=Voice, 0..100).
     * @param {number} channel
     * @param {number} v
     */
    setTxMonitor(channel, v) {
      const ch = clamp(Math.round(Number(channel) || 0), 0, 2);
      const val = clamp(Math.round(Number(v) || 0), 0, 100);
      const res = this.sendCat(K4.CatCodec.builders.txMonitor(ch, val) + 'ML' + ch + ';');
      if (res.blocked.length === 0) {
        const key = ch === 0 ? 'monCw' : ch === 1 ? 'monData' : 'monVoice';
        this.state.update({ [key]: val }, key);
      }
      return res;
    }

    /**
     * Select TX microphone input source (MI, 0..4).
     * @param {number} v
     */
    setMicInput(v) {
      const idx = clamp(Math.round(Number(v) || 0), 0, 4);
      const res = this.sendCat(K4.CatCodec.builders.micInput(idx) + 'MI;');
      if (res.blocked.length === 0) {
        this.state.update({ micInput: idx }, 'micInput');
      }
      return res;
    }

    /**
     * Toggle VOX / QSK for 'C' (CW), 'V' (Voice), or 'D' (Data) (VXmn;).
     * @param {'C'|'V'|'D'} modeChar
     * @param {boolean} on
     */
    setVox(modeChar, on) {
      const mc = String(modeChar || 'V').toUpperCase();
      const c = mc === 'C' || mc === 'V' || mc === 'D' ? mc : 'V';
      const enabled = Boolean(on);
      const res = this.sendCat(K4.CatCodec.builders.vox(c, enabled) + 'VX' + c + ';');
      if (res.blocked.length === 0) {
        const key = c === 'C' ? 'voxCw' : c === 'V' ? 'voxVoice' : 'voxData';
        this.state.update({ [key]: enabled }, 'vox');
      }
      return res;
    }

    /**
     * Play or stop DVR memory slot (PB0=stop, PB1..PB8=play).
     * @param {number} slot
     */
    playDvr(slot) {
      const s = clamp(Math.round(Number(slot) || 0), 0, 8);
      return this.sendCat(K4.CatCodec.builders.dvrPlay(s));
    }

    /**
     * Set CW keyer speed in WPM (KS, 8..100).
     * @param {number} wpm
     */
    setCwSpeed(wpm) {
      const w = clamp(Math.round(Number(wpm) || 20), 8, 100);
      const res = this.sendCat(K4.CatCodec.builders.cwSpeed(w) + 'KS;');
      if (res.blocked.length === 0) {
        this.state.update({ cwSpeedWpm: w }, 'cwSpeedWpm');
      }
      return res;
    }

    /**
     * Configure keyer iambic mode ('A'|'B'), paddle order ('N'|'R'), and weight (90..125, step 5) (KP).
     * @param {{ iambic?: 'A'|'B', order?: 'N'|'R', paddleOrder?: 'N'|'R', weight?: number }} [opts]
     */
    setKeyerPaddle(opts = {}) {
      const cur = this.state.getSnapshot();
      const o = opts && typeof opts === 'object' ? opts : {};
      const iambic =
        String(o.iambic || cur.keyerIambic || 'A').toUpperCase() === 'B' ? 'B' : 'A';
      const order =
        String(o.order || o.paddleOrder || cur.keyerPaddleOrder || 'N').toUpperCase() === 'R'
          ? 'R'
          : 'N';
      const rawWeight =
        o.weight !== undefined && o.weight !== null ? Number(o.weight) : cur.keyerWeight || 110;
      const weight = clamp(Math.round(rawWeight / 5) * 5, 90, 125);
      const res = this.sendCat(K4.CatCodec.builders.keyerPaddle(iambic, order, weight) + 'KP;');
      if (res.blocked.length === 0) {
        this.state.update(
          { keyerIambic: iambic, keyerPaddleOrder: order, keyerWeight: weight },
          'keyerPaddle'
        );
      }
      return res;
    }

    /**
     * Enqueue CW or direct DATA text into the K4 KY keyer buffer.
     * @param {string} text
     * @param {' '|'W'|'R'} [mode=' ']
     */
    sendKeyerText(text, mode = ' ') {
      const clean = String(text || '').replace(/[;\r\n]/g, '').slice(0, 60);
      if (!clean) {
        return { sent: false, allowed: [], blocked: [], sanitized: '' };
      }
      if (clean.trim() !== '@' && this.state.getSnapshot().txInhibit) {
        return {
          sent: false,
          allowed: [],
          blocked: [K4.CatCodec.builders.keyerText(clean, mode)],
          sanitized: '',
          reason: 'TX INHIBIT active',
        };
      }
      return this.sendCat(K4.CatCodec.builders.keyerText(clean, mode) + 'KY;');
    }

    /**
     * Immediately clear the KY keyer buffer (KY @;).
     */
    clearKeyerBuffer() {
      return this.sendCat(K4.CatCodec.builders.keyerAbort() + 'KY;');
    }
  }

  K4.Client = Client;
})();
