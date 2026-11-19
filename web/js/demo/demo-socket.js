'use strict';
(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const MODE_NAME_TO_CODE = Object.freeze({
    LSB: { mode: 1, sub: 0, bw: 2400, isHz: 1500 },
    USB: { mode: 2, sub: 0, bw: 2400, isHz: 1500 },
    CW: { mode: 3, sub: 0, bw: 500, isHz: 500 },
    FM: { mode: 4, sub: 0, bw: 4000, isHz: 0 },
    AM: { mode: 5, sub: 0, bw: 4000, isHz: 0 },
    DATA: { mode: 6, sub: 0, bw: 2800, isHz: 1500 },
    'DATA-A': { mode: 6, sub: 0, bw: 2800, isHz: 1500 },
    'AFSK-A': { mode: 6, sub: 1, bw: 500, isHz: 0 },
    'FSK-D': { mode: 6, sub: 2, bw: 500, isHz: 0 },
    'PSK-D': { mode: 6, sub: 3, bw: 500, isHz: 0 },
    'CW-R': { mode: 7, sub: 0, bw: 500, isHz: 500 },
    'DATA-R': { mode: 9, sub: 0, bw: 2800, isHz: 1500 },
  });

  const STEP_HZ = [1, 10, 100, 1000, 2500, 5000, 10000];

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  function padInt(val, width) {
    const n = Math.max(0, Math.round(Number(val) || 0));
    return String(n).padStart(width, '0');
  }

  function framePayload(payload) {
    const len = payload.byteLength;
    const out = new Uint8Array(12 + len);
    out[0] = 0xfe;
    out[1] = 0xfd;
    out[2] = 0xfc;
    out[3] = 0xfb;
    out[4] = (len >>> 24) & 0xff;
    out[5] = (len >>> 16) & 0xff;
    out[6] = (len >>> 8) & 0xff;
    out[7] = len & 0xff;
    out.set(payload, 8);
    out[8 + len] = 0xfb;
    out[9 + len] = 0xfc;
    out[10 + len] = 0xfd;
    out[11 + len] = 0xfe;
    return out;
  }

  function encodeCatFrame(catText) {
    const payload = new Uint8Array(3 + catText.length);
    payload[0] = 0x00;
    payload[1] = 0x00;
    payload[2] = 0x00;
    for (let i = 0; i < catText.length; i++) {
      payload[3 + i] = catText.charCodeAt(i) & 0xff;
    }
    return framePayload(payload);
  }

  function encodeAudioFrame(seq, pcmBytes) {
    const payload = new Uint8Array(7 + pcmBytes.byteLength);
    const dv = new DataView(payload.buffer);
    payload[0] = 0x01;
    payload[1] = 0x01;
    payload[2] = seq & 0xff;
    payload[3] = 0x01; // EM1 12 kHz S16LE stereo
    dv.setUint16(4, 240, true);
    payload[6] = 0x00; // 12 kHz
    payload.set(pcmBytes, 7);
    return framePayload(payload);
  }

  function writeInt64LE(dv, offset, value) {
    if (typeof dv.setBigInt64 === 'function') {
      dv.setBigInt64(offset, BigInt(Math.round(value)), true);
      return;
    }
    const lo = value >>> 0;
    const hi = Math.floor(value / 4294967296);
    dv.setUint32(offset, lo, true);
    dv.setInt32(offset + 4, hi, true);
  }

  function encodePanFrame(typeByte, seq, rxIdx, centerFreqHz, rateOrSpanKHz, noiseFloorDbm, bins) {
    const payload = new Uint8Array(27 + bins.byteLength);
    const dv = new DataView(payload.buffer);
    payload[0] = typeByte;
    payload[1] = 0x00;
    payload[2] = seq & 0xff;
    payload[3] = 0x00;
    payload[4] = rxIdx & 0xff;
    dv.setUint16(5, bins.byteLength, true);
    dv.setUint32(7, 0, true);
    writeInt64LE(dv, 11, centerFreqHz);
    dv.setInt32(19, Math.round(rateOrSpanKHz), true);
    dv.setInt32(23, Math.round((noiseFloorDbm || -118.0) * 10.0), true);
    payload.set(bins, 27);
    return framePayload(payload);
  }

  function spectrumTierKHz(userSpanHz) {
    if (userSpanHz <= 19500) return 24;
    if (userSpanHz <= 36500) return 48;
    if (userSpanHz <= 82500) return 96;
    if (userSpanHz <= 174000) return 192;
    return 384;
  }

  function parseFreqDigits(rawDigits) {
    const digits = String(rawDigits || '').replace(/\D/g, '');
    if (!digits) return null;
    const val = Number(digits);
    if (!Number.isFinite(val)) return null;
    if (digits.length <= 2) return val * 1000000;
    if (digits.length <= 5) return val * 1000;
    return val;
  }

  function smeterDbmToK4Units(dbm) {
    // K4 SMH/SM: 000..060 where S9 (-73 dBm) ≈ 028, S0 (-127 dBm) ≈ 000
    if (dbm <= -73) {
      return clamp(Math.round(((dbm + 127) / 54) * 28), 0, 28);
    }
    return clamp(Math.round(28 + ((dbm + 73) / 60) * 32), 28, 60);
  }

  function dispatchDemoEvent(name, detail) {
    if (typeof globalThis.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      try {
        globalThis.dispatchEvent(new CustomEvent(name, { detail }));
      } catch (_) {
        // Ignore in restricted environments
      }
    }
  }

  function makeRxState(freqHz, modeDef, spanHz) {
    return {
      freqHz,
      mode: modeDef.mode,
      dataSubMode: modeDef.sub,
      bwHz: modeDef.bw,
      ifShiftHz: modeDef.isHz,
      stepIdx: 2, // 100 Hz
      locked: false,
      afGain: 32,
      rfGainDb: 0,
      squelch: 0,
      preamp: 0,
      attenDb: 0,
      nbOn: false,
      nbLevel: 4,
      nrOn: false,
      nrLevel: 3,
      agc: 2, // Fast
      apfOn: false,
      ritOn: false,
      ritOffsetHz: 0,
      panSpanHz: spanHz,
      panRefDbm: -128,
      miniPan: false,
    };
  }

  /**
   * Drop-in WebSocket-compatible virtual Elecraft K4 backed by a static I/Q recording.
   * Speaks the exact K4 :9205 binary framing so K4.Client runs unmodified.
   */
  class DemoSocket {
    constructor(url = 'demo://band', opts = {}) {
      this.url = url;
      this.readyState = 0; // CONNECTING
      this.binaryType = 'arraybuffer';
      this.protocol = 'binary';
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;

      this._closed = false;
      this._authReceived = false;
      this._bootstrapped = false;
      this._audioSeq = 0;
      this._panSeq = 0;
      this._miniSeq = 0;
      this._audioTimer = null;
      this._panTimer = null;
      this._meterTimer = null;
      this._lastRangeNoticeMs = 0;

      this._manifest = opts.manifest || null;
      this._preloadedIq = opts.iqInt16 || null;
      this._preloadedTiles = opts.tiles || null;
      this._demod = null;

      // Virtual K4 radio state
      this._cwPitchHz = 500;
      this._subRxEnabled = false;
      this._splitEnabled = false;
      this._audioMix = 'A.B';
      this._panScaleDb = 70;
      this._panAvg = 2;
      this._wfBlack = 10;
      this._autoRef = false;
      this._fixedTune = true; // Keep recorded slice centered cleanly by default
      this._freeze = false;
      this._dualPanMode = 0;
      this._wfHeight = 50;
      this._panCenterA = 14074000;
      this._panCenterB = 14074000;
      this._rxA = makeRxState(14074000, MODE_NAME_TO_CODE.USB, 18000);
      this._rxB = makeRxState(14074000, MODE_NAME_TO_CODE.USB, 18000);

      this._inFramer = new K4.PacketFramer((payload) => this._handleClientPacket(payload));
      Promise.resolve().then(() => this._initAsync());
    }

    static get lastManifest() {
      return DemoSocket._lastManifest || null;
    }

    async _initAsync() {
      try {
        let manifest = this._manifest;
        let loadedTiles = this._preloadedTiles || null;

        if (!manifest || !loadedTiles) {
          const basePath = this._resolveDemoBase();
          dispatchDemoEvent('k4-demo-progress', { phase: 'manifest', loaded: 0, total: 0, pct: 0 });
          if (!manifest) {
            const mResp = await fetch(basePath + 'manifest.json');
            if (!mResp.ok) {
              throw new Error(`Demo manifest HTTP ${mResp.status}`);
            }
            manifest = await mResp.json();
          }

          if (this._preloadedIq) {
            loadedTiles = [{
              iqInt16: this._preloadedIq,
              sampleRateHz: manifest.sampleRateHz || 20250,
              centerFreqHz: manifest.centerFreqHz || 14074000,
            }];
          } else {
            const tileSpecs =
              Array.isArray(manifest.tiles) && manifest.tiles.length > 0
                ? manifest.tiles
                : [{
                    iqFile: manifest.iqFile || 'band.iq.bin',
                    centerFreqHz: manifest.centerFreqHz || 14074000,
                    sampleRateHz: manifest.sampleRateHz || 20250,
                  }];

            let completedCount = 0;
            loadedTiles = await Promise.all(
              tileSpecs.map(async (spec) => {
                const resp = await fetch(basePath + spec.iqFile);
                if (!resp.ok) {
                  throw new Error(`Demo tile ${spec.iqFile} HTTP ${resp.status}`);
                }
                const buf = await resp.arrayBuffer();
                completedCount++;
                const pct = Math.round((completedCount / tileSpecs.length) * 100);
                dispatchDemoEvent('k4-demo-progress', {
                  phase: 'iq',
                  loaded: completedCount,
                  total: tileSpecs.length,
                  pct,
                });
                return {
                  iqInt16: new Int16Array(buf),
                  sampleRateHz: spec.sampleRateHz || manifest.sampleRateHz || 20250,
                  centerFreqHz: spec.centerFreqHz || manifest.centerFreqHz || 14074000,
                };
              })
            );
          }
        }

        if (this._closed) return;

        this._manifest = manifest;
        DemoSocket._lastManifest = manifest;

        const modeDef = MODE_NAME_TO_CODE[manifest.defaultMode] || MODE_NAME_TO_CODE.USB;
        const defaultSpan = clamp(Number(manifest.defaultSpanHz || 18000), 6000, 368000);
        const startFreq = Number(manifest.defaultFreqHz || manifest.centerFreqHz || 14074000);
        const secondBm =
          Array.isArray(manifest.bookmarks) && manifest.bookmarks.length > 1
            ? manifest.bookmarks[1]
            : null;
        const subFreq = secondBm ? Number(secondBm.freqHz) : startFreq + 2000;
        const subModeDef =
          secondBm && MODE_NAME_TO_CODE[secondBm.mode] ? MODE_NAME_TO_CODE[secondBm.mode] : modeDef;

        this._rxA = makeRxState(startFreq, modeDef, defaultSpan);
        this._rxB = makeRxState(subFreq, subModeDef, defaultSpan);
        this._panCenterA = Number(manifest.centerFreqHz || startFreq);
        this._panCenterB = Number(manifest.centerFreqHz || subFreq);

        this._demod = new K4.DemoDemodulator({
          tiles: loadedTiles,
          centerFreqHz: manifest.centerFreqHz || startFreq,
          noiseFloorOffsetDb: manifest.noiseFloorOffsetDb,
        });

        dispatchDemoEvent('k4-demo-progress', { phase: 'ready', loaded: 100, total: 100, pct: 100, manifest });

        this.readyState = 1; // OPEN
        if (typeof this.onopen === 'function') {
          this.onopen({ target: this });
        }
      } catch (err) {
        if (this._closed) return;
        this.readyState = 3;
        if (typeof this.onerror === 'function') {
          this.onerror({ target: this, error: err, message: err && err.message ? err.message : String(err) });
        }
        if (typeof this.onclose === 'function') {
          this.onclose({ target: this, code: 1006, reason: err && err.message ? err.message : 'Demo load failed', wasClean: false });
        }
      }
    }

    _resolveDemoBase() {
      // Allow demo://custom-path or default ./demo/
      const raw = String(this.url || '').replace(/^demo:\/\//, '').replace(/^\/+/, '');
      if (raw && raw !== 'band' && raw !== 'default') {
        return raw.endsWith('/') ? raw : raw + '/';
      }
      return './demo/';
    }

    _emitBytes(u8) {
      if (this._closed || this.readyState !== 1) return;
      const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      Promise.resolve().then(() => {
        if (this._closed || this.readyState !== 1) return;
        if (typeof this.onmessage === 'function') {
          this.onmessage({ data: ab, target: this });
        }
      });
    }

    _emitCat(text) {
      if (!text) return;
      this._emitBytes(encodeCatFrame(text));
    }

    send(data) {
      if (this._closed || this.readyState !== 1) return;
      const u8 =
        data instanceof Uint8Array
          ? data
          : data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : ArrayBuffer.isView(data)
              ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
              : null;
      if (!u8) return;

      // First message from K4.Client is the unframed 96-byte ASCII SHA-384 auth digest
      if (!this._authReceived) {
        this._authReceived = true;
        this._startStreaming();
        // Send an immediate audio frame just like real K4 R40.B1 to trigger K4.Client bootstrap
        this._tickAudio();
        return;
      }

      this._inFramer.push(u8);
    }

    _startStreaming() {
      if (this._audioTimer !== null) return;
      this._audioTimer = setInterval(() => this._tickAudio(), 20);
      this._panTimer = setInterval(() => this._tickPan(), 66);
      this._meterTimer = setInterval(() => this._tickMeters(), 200);
    }

    _stopStreaming() {
      if (this._audioTimer !== null) {
        clearInterval(this._audioTimer);
        this._audioTimer = null;
      }
      if (this._panTimer !== null) {
        clearInterval(this._panTimer);
        this._panTimer = null;
      }
      if (this._meterTimer !== null) {
        clearInterval(this._meterTimer);
        this._meterTimer = null;
      }
    }

    _tickAudio() {
      if (!this._demod || this._closed || this.readyState !== 1) return;
      const pcm = this._demod.renderAudioFrame(this._rxA, this._rxB, this._subRxEnabled, this._cwPitchHz);
      this._emitBytes(encodeAudioFrame(this._audioSeq++, pcm));
    }

    _tickPan() {
      if (!this._demod || !this._bootstrapped || this._freeze || this._closed || this.readyState !== 1) return;

      const tierA = spectrumTierKHz(this._rxA.panSpanHz);
      const centerA = this._fixedTune ? this._panCenterA : this._rxA.freqHz;
      const panA = this._demod.computeSpectrumBins({
        rx: 'A',
        panCenterHz: centerA,
        spanHz: tierA * 1000,
        averaging: this._panAvg,
        miniPan: false,
      });
      this._emitBytes(encodePanFrame(0x02, this._panSeq++, 0, centerA, tierA, panA.noiseFloorDbm, panA.bins));

      if (this._rxA.miniPan) {
        const mpSpanKHz = this._rxA.mode === 3 || this._rxA.mode === 7 ? 6 : 12;
        const mpCenter =
          this._rxA.mode === 3
            ? this._rxA.freqHz + this._cwPitchHz
            : this._rxA.mode === 7
              ? this._rxA.freqHz - this._cwPitchHz
              : this._rxA.freqHz;
        const mpA = this._demod.computeSpectrumBins({
          rx: 'A',
          panCenterHz: mpCenter,
          spanHz: mpSpanKHz * 1000,
          miniPan: true,
        });
        this._emitBytes(encodePanFrame(0x03, this._miniSeq++, 0, mpCenter, mpSpanKHz, 0, mpA.bins));
      }

      if (this._subRxEnabled && this._dualPanMode > 0) {
        const tierB = spectrumTierKHz(this._rxB.panSpanHz);
        const centerB = this._fixedTune ? this._panCenterB : this._rxB.freqHz;
        const panB = this._demod.computeSpectrumBins({
          rx: 'B',
          panCenterHz: centerB,
          spanHz: tierB * 1000,
          averaging: this._panAvg,
          miniPan: false,
        });
        this._emitBytes(encodePanFrame(0x02, this._panSeq++, 1, centerB, tierB, panB.noiseFloorDbm, panB.bins));
      }
    }

    _tickMeters() {
      if (!this._demod || !this._bootstrapped || this._closed || this.readyState !== 1) return;
      const smA = smeterDbmToK4Units(this._demod.getSmeterDbm('A'));
      let cat = `SM${padInt(smA, 3)};`;
      if (this._subRxEnabled) {
        const smB = smeterDbmToK4Units(this._demod.getSmeterDbm('B'));
        cat += `SM$${padInt(smB, 3)};`;
      }
      this._emitCat(cat);
    }

    _clampDemoFreq(freqHz) {
      const m = this._manifest;
      if (!m) return freqHz;
      const minF = Number(m.minFreqHz || (m.centerFreqHz - (m.sampleRateHz || 20250) * 0.48));
      const maxF = Number(m.maxFreqHz || (m.centerFreqHz + (m.sampleRateHz || 20250) * 0.48));
      if (freqHz < minF || freqHz > maxF) {
        const now = Date.now();
        if (now - this._lastRangeNoticeMs > 1800) {
          this._lastRangeNoticeMs = now;
          dispatchDemoEvent('k4-demo-notice', {
            message: `Demo recording covers ${(minF / 1e6).toFixed(4)}–${(maxF / 1e6).toFixed(4)} MHz (${m.band || 'single band'})`,
          });
        }
        return clamp(freqHz, minF, maxF);
      }
      return freqHz;
    }

    _buildSnapshotCat() {
      const a = this._rxA;
      const b = this._rxB;
      const bn = (this._manifest && this._manifest.bandNumber) || '05';
      const title = (this._manifest && this._manifest.band ? `DEMO ${this._manifest.band.toUpperCase()}` : 'K4 DEMO');
      return [
        `ID${title};`,
        'OM AP-S----4---;',
        'RV.R-DEMO.1;',
        'K41;',
        'AI5;',
        'EM1;',
        `BN${bn};`,
        `BN$${bn};`,
        `FA${padInt(a.freqHz, 11)};`,
        `FB${padInt(b.freqHz, 11)};`,
        `MD${a.mode};`,
        `MD$${b.mode};`,
        `DT${a.dataSubMode};`,
        `DT$${b.dataSubMode};`,
        `BW${padInt(Math.round(a.bwHz / 10), 4)};`,
        `BW$${padInt(Math.round(b.bwHz / 10), 4)};`,
        `IS${padInt(Math.round(a.ifShiftHz / 10), 4)};`,
        `IS$${padInt(Math.round(b.ifShiftHz / 10), 4)};`,
        `CW${padInt(Math.round(this._cwPitchHz / 10), 2)};`,
        `VT${a.stepIdx}0;`,
        `VT$${b.stepIdx}0;`,
        `LK${a.locked ? 1 : 0};`,
        `LK$${b.locked ? 1 : 0};`,
        `SB${this._subRxEnabled ? 1 : 0};`,
        `FT${this._splitEnabled ? 1 : 0};`,
        `AG${padInt(a.afGain, 3)};`,
        `AG$${padInt(b.afGain, 3)};`,
        `RG${padInt(a.rfGainDb, 3)};`,
        `RG$${padInt(b.rfGainDb, 3)};`,
        `SQ${padInt(a.squelch, 3)};`,
        `SQ$${padInt(b.squelch, 3)};`,
        `PA${a.preamp};`,
        `PA$${b.preamp};`,
        `RA${padInt(a.attenDb, 2)};`,
        `RA$${padInt(b.attenDb, 2)};`,
        `NB${a.nbOn ? 1 : 0}${padInt(a.nbLevel, 2)};`,
        `NB$${b.nbOn ? 1 : 0}${padInt(b.nbLevel, 2)};`,
        `NR${a.nrOn ? 1 : 0}${padInt(a.nrLevel, 2)};`,
        `NR$${b.nrOn ? 1 : 0}${padInt(b.nrLevel, 2)};`,
        `GT${a.agc};`,
        `GT$${b.agc};`,
        `RT${a.ritOn ? 1 : 0};`,
        `RT$${b.ritOn ? 1 : 0};`,
        `RO${a.ritOffsetHz >= 0 ? '+' : '-'}${padInt(Math.abs(a.ritOffsetHz), 4)};`,
        `RO$${b.ritOffsetHz >= 0 ? '+' : '-'}${padInt(Math.abs(b.ritOffsetHz), 4)};`,
        `MX${this._audioMix};`,
        `#SPN${padInt(a.panSpanHz, 6)};`,
        `#SPN$${padInt(b.panSpanHz, 6)};`,
        `#REF${a.panRefDbm};`,
        `#REF$${b.panRefDbm};`,
        `#SCL${this._panScaleDb};`,
        `#AVG${this._panAvg};`,
        `#WBS${this._wfBlack};`,
        `#AR${this._autoRef ? 1 : 0};`,
        `#FXT${this._fixedTune ? 1 : 0};`,
        `#DPM${this._dualPanMode};`,
        `#MP${a.miniPan ? 1 : 0};`,
        `#MP$${b.miniPan ? 1 : 0};`,
        `#FRZ${this._freeze ? 1 : 0};`,
        `#WFH${this._wfHeight};`,
        'AN1;',
        'AT2;',
        'TD000;',
        'TD$000;',
      ].join('');
    }

    _handleClientPacket(payload) {
      const pkt = K4.BinaryPackets.parse(payload);
      if (!pkt || pkt.type !== 0) return; // Ignore outbound TX audio (strict RX-only)

      const cmds = K4.CatCodec.splitFrames(pkt.text);
      let reply = '';
      for (let i = 0; i < cmds.length; i++) {
        const raw = cmds[i].trim();
        if (!raw) continue;
        reply += this._execCat(raw);
      }
      if (reply) {
        this._emitCat(reply);
      }
    }

    _execCat(raw) {
      const cmd = raw.endsWith(';') ? raw.slice(0, -1) : raw;
      const up = cmd.toUpperCase();

      if (up === 'RDY') {
        this._bootstrapped = true;
        return this._buildSnapshotCat();
      }
      if (up.startsWith('PING')) {
        return 'PONG;';
      }
      if (up === 'RRN') {
        return '';
      }

      // Block TX / ATU / Keyer in demo mode
      if (/^(TX|TU|KY|PC|MOX|VOX|PB|TS|DARM|DAPM|SWT|SWH)/.test(up)) {
        return '';
      }

      // VFO A / B Frequency
      if (up.startsWith('FA')) {
        const arg = up.slice(2);
        if (arg) {
          const parsed = parseFreqDigits(arg);
          if (parsed !== null) {
            this._rxA.freqHz = this._clampDemoFreq(parsed);
          }
        }
        return `FA${padInt(this._rxA.freqHz, 11)};`;
      }
      if (up.startsWith('FB')) {
        const arg = up.slice(2);
        if (arg) {
          const parsed = parseFreqDigits(arg);
          if (parsed !== null) {
            this._rxB.freqHz = this._clampDemoFreq(parsed);
          }
        }
        return `FB${padInt(this._rxB.freqHz, 11)};`;
      }

      // Step Up / Down
      if (up === 'UP' || up === 'DN' || up === 'UPB' || up === 'DNB') {
        const isB = up.endsWith('B');
        const rx = isB ? this._rxB : this._rxA;
        const step = STEP_HZ[rx.stepIdx] || 100;
        const delta = up.startsWith('UP') ? step : -step;
        rx.freqHz = this._clampDemoFreq(rx.freqHz + delta);
        return isB ? `FB${padInt(rx.freqHz, 11)};` : `FA${padInt(rx.freqHz, 11)};`;
      }

      // VFO Copy / Swap (AB0..5)
      if (up.startsWith('AB')) {
        const code = Number(up.slice(2));
        if (code === 0 || code === 3) {
          this._rxB.freqHz = this._rxA.freqHz;
          if (code === 3) {
            this._rxB.mode = this._rxA.mode;
            this._rxB.bwHz = this._rxA.bwHz;
            this._rxB.ifShiftHz = this._rxA.ifShiftHz;
          }
        } else if (code === 2 || code === 5) {
          const tf = this._rxA.freqHz;
          this._rxA.freqHz = this._rxB.freqHz;
          this._rxB.freqHz = tf;
          if (code === 5) {
            const tm = this._rxA.mode;
            this._rxA.mode = this._rxB.mode;
            this._rxB.mode = tm;
          }
        }
        return `FA${padInt(this._rxA.freqHz, 11)};FB${padInt(this._rxB.freqHz, 11)};MD${this._rxA.mode};MD$${this._rxB.mode};`;
      }

      // Mode (MD / MD$)
      if (up.startsWith('MD')) {
        const isB = up.startsWith('MD$');
        const rx = isB ? this._rxB : this._rxA;
        const arg = up.slice(isB ? 3 : 2);
        if (arg) {
          const m = Number(arg);
          if ([1, 2, 3, 4, 5, 6, 7, 9].includes(m)) {
            rx.mode = m;
            if (m === 3 || m === 7) {
              rx.bwHz = Math.min(rx.bwHz, 500);
              rx.ifShiftHz = this._cwPitchHz;
            } else if (m === 1 || m === 2) {
              rx.bwHz = 2400;
              rx.ifShiftHz = 1500;
            } else if (m === 6 || m === 9) {
              rx.bwHz = 2800;
              rx.ifShiftHz = 1500;
            }
          }
        }
        const pfx = isB ? 'MD$' : 'MD';
        const bwPfx = isB ? 'BW$' : 'BW';
        const isPfx = isB ? 'IS$' : 'IS';
        return `${pfx}${rx.mode};${bwPfx}${padInt(Math.round(rx.bwHz / 10), 4)};${isPfx}${padInt(Math.round(rx.ifShiftHz / 10), 4)};`;
      }

      // Data submode (DT / DT$)
      if (up.startsWith('DT')) {
        const isB = up.startsWith('DT$');
        const rx = isB ? this._rxB : this._rxA;
        const arg = up.slice(isB ? 3 : 2);
        if (arg !== '') rx.dataSubMode = clamp(Number(arg) || 0, 0, 3);
        return `${isB ? 'DT$' : 'DT'}${rx.dataSubMode};`;
      }

      // Bandwidth (BW / BW$ in 10 Hz units)
      if (up.startsWith('BW')) {
        const isB = up.startsWith('BW$');
        const rx = isB ? this._rxB : this._rxA;
        const arg = up.slice(isB ? 3 : 2);
        if (arg) {
          const n = Number(arg);
          if (Number.isFinite(n) && n > 0) rx.bwHz = clamp(n * 10, 50, 4800);
        }
        return `${isB ? 'BW$' : 'BW'}${padInt(Math.round(rx.bwHz / 10), 4)};`;
      }

      // IF Shift (IS / IS$ in 10 Hz units)
      if (up.startsWith('IS')) {
        const isB = up.startsWith('IS$');
        const rx = isB ? this._rxB : this._rxA;
        const arg = up.slice(isB ? 3 : 2).trim();
        if (arg) {
          if (arg.startsWith('9')) {
            rx.ifShiftHz = rx.mode === 3 || rx.mode === 7 ? this._cwPitchHz : 1500;
          } else {
            const n = Number(arg);
            if (Number.isFinite(n)) rx.ifShiftHz = clamp(n * 10, 0, 3500);
          }
        }
        return `${isB ? 'IS$' : 'IS'}${padInt(Math.round(rx.ifShiftHz / 10), 4)};`;
      }

      // CW Pitch
      if (up.startsWith('CW')) {
        const arg = up.slice(2);
        if (arg) {
          const n = Number(arg);
          if (Number.isFinite(n)) this._cwPitchHz = clamp(n * 10, 300, 800);
        }
        return `CW${padInt(Math.round(this._cwPitchHz / 10), 2)};`;
      }

      // Tuning step (VT / VT$)
      if (up.startsWith('VT')) {
        const isB = up.startsWith('VT$');
        const rx = isB ? this._rxB : this._rxA;
        const arg = up.slice(isB ? 3 : 2);
        if (arg) rx.stepIdx = clamp(Number(arg[0]) || 0, 0, 6);
        return `${isB ? 'VT$' : 'VT'}${rx.stepIdx}0;`;
      }

      // Sub RX (SB)
      if (up.startsWith('SB')) {
        const arg = up.slice(2);
        if (arg === '/') this._subRxEnabled = !this._subRxEnabled;
        else if (arg === '0' || arg === '1') this._subRxEnabled = arg === '1';
        return `SB${this._subRxEnabled ? 1 : 0};`;
      }

      // AF Gain (AG / AG$)
      if (up.startsWith('AG')) {
        const isB = up.startsWith('AG$');
        const rx = isB ? this._rxB : this._rxA;
        const arg = up.slice(isB ? 3 : 2);
        if (arg) rx.afGain = clamp(Number(arg) || 0, 0, 60);
        return `${isB ? 'AG$' : 'AG'}${padInt(rx.afGain, 3)};`;
      }

      // Squelch (SQ / SQ$)
      if (up.startsWith('SQ')) {
        const isB = up.startsWith('SQ$');
        const rx = isB ? this._rxB : this._rxA;
        const arg = up.slice(isB ? 3 : 2);
        if (arg) rx.squelch = clamp(Number(arg) || 0, 0, 100);
        return `${isB ? 'SQ$' : 'SQ'}${padInt(rx.squelch, 3)};`;
      }

      // AGC (GT / GT$)
      if (up.startsWith('GT')) {
        const isB = up.startsWith('GT$');
        const rx = isB ? this._rxB : this._rxA;
        const arg = up.slice(isB ? 3 : 2);
        if (arg) rx.agc = clamp(Number(arg) || 0, 0, 2);
        return `${isB ? 'GT$' : 'GT'}${rx.agc};`;
      }

      // RIT (RT / RO)
      if (up.startsWith('RT')) {
        const isB = up.startsWith('RT$');
        const rx = isB ? this._rxB : this._rxA;
        const arg = up.slice(isB ? 3 : 2);
        if (arg === '/') rx.ritOn = !rx.ritOn;
        else if (arg === '0' || arg === '1') rx.ritOn = arg === '1';
        return `${isB ? 'RT$' : 'RT'}${rx.ritOn ? 1 : 0};`;
      }
      if (up.startsWith('RO')) {
        const isB = up.startsWith('RO$');
        const rx = isB ? this._rxB : this._rxA;
        const arg = up.slice(isB ? 3 : 2);
        if (arg) {
          const n = Number(arg);
          if (Number.isFinite(n)) rx.ritOffsetHz = clamp(Math.round(n), -9999, 9999);
        }
        return `${isB ? 'RO$' : 'RO'}${rx.ritOffsetHz >= 0 ? '+' : '-'}${padInt(Math.abs(rx.ritOffsetHz), 4)};`;
      }
      if (up === 'RC') {
        this._rxA.ritOffsetHz = 0;
        this._rxB.ritOffsetHz = 0;
        return 'RO+0000;RO$+0000;';
      }

      // Audio Mix (MX)
      if (up.startsWith('MX')) {
        const arg = up.slice(2);
        if (arg) this._audioMix = arg;
        return `MX${this._audioMix};`;
      }

      // Panadapter commands (#SPN, #REF, #SCL, #AVG, #WBS, #FXT, #MP, #FRZ, #DPM, #WFH, #AR)
      if (up.startsWith('#SPN')) {
        const isB = up.startsWith('#SPN$');
        const rx = isB ? this._rxB : this._rxA;
        const arg = up.slice(isB ? 5 : 4);
        if (arg) {
          const n = Number(arg);
          if (Number.isFinite(n) && n >= 1000) {
            rx.panSpanHz = clamp(Math.round(n), 6000, 368000);
          }
        }
        return `${isB ? '#SPN$' : '#SPN'}${padInt(rx.panSpanHz, 6)};`;
      }
      if (up.startsWith('#REF')) {
        const isB = up.startsWith('#REF$');
        const rx = isB ? this._rxB : this._rxA;
        const arg = up.slice(isB ? 5 : 4);
        if (arg) {
          const n = Number(arg);
          if (Number.isFinite(n)) rx.panRefDbm = clamp(Math.round(n), -160, -20);
        }
        return `${isB ? '#REF$' : '#REF'}${rx.panRefDbm};`;
      }
      if (up.startsWith('#SCL')) {
        const arg = up.slice(4);
        if (arg) this._panScaleDb = clamp(Number(arg) || 70, 20, 120);
        return `#SCL${this._panScaleDb};`;
      }
      if (up.startsWith('#AVG')) {
        const arg = up.slice(4);
        if (arg) this._panAvg = clamp(Number(arg) || 2, 1, 20);
        return `#AVG${this._panAvg};`;
      }
      if (up.startsWith('#WBS')) {
        const arg = up.slice(4);
        if (arg) this._wfBlack = clamp(Number(arg) || 10, 0, 100);
        return `#WBS${this._wfBlack};`;
      }
      if (up.startsWith('#FXT')) {
        const arg = up.slice(4);
        if (arg === '0' || arg === '1') this._fixedTune = arg === '1';
        return `#FXT${this._fixedTune ? 1 : 0};`;
      }
      if (up.startsWith('#MP')) {
        const isB = up.startsWith('#MP$');
        const rx = isB ? this._rxB : this._rxA;
        const arg = up.slice(isB ? 4 : 3);
        if (arg === '/') rx.miniPan = !rx.miniPan;
        else if (arg === '0' || arg === '1') rx.miniPan = arg === '1';
        return `${isB ? '#MP$' : '#MP'}${rx.miniPan ? 1 : 0};`;
      }
      if (up.startsWith('#FRZ')) {
        const arg = up.slice(4);
        if (arg === '/') this._freeze = !this._freeze;
        else if (arg === '0' || arg === '1') this._freeze = arg === '1';
        return `#FRZ${this._freeze ? 1 : 0};`;
      }
      if (up.startsWith('#DPM')) {
        const arg = up.slice(4);
        if (arg) this._dualPanMode = clamp(Number(arg) || 0, 0, 2);
        return `#DPM${this._dualPanMode};`;
      }
      if (up.startsWith('#WFH')) {
        const arg = up.slice(4);
        if (arg) this._wfHeight = clamp(Number(arg) || 50, 0, 100);
        return `#WFH${this._wfHeight};`;
      }
      if (up.startsWith('#AR')) {
        const arg = up.slice(3);
        if (arg === '0' || arg === '1') this._autoRef = arg === '1';
        return `#AR${this._autoRef ? 1 : 0};`;
      }

      // Band switch blocked gently in single-band demo
      if (up.startsWith('BN')) {
        const arg = up.slice(up.startsWith('BN$') ? 3 : 2);
        const curBn = (this._manifest && this._manifest.bandNumber) || '05';
        if (arg && arg !== curBn) {
          dispatchDemoEvent('k4-demo-notice', {
            message: `Single-band demo is locked to ${(this._manifest && this._manifest.band) || '20m'}`,
          });
        }
        return `BN${curBn};BN$${curBn};`;
      }

      return '';
    }

    close(code = 1000, reason = 'Closed') {
      if (this._closed) return;
      this._closed = true;
      this._stopStreaming();
      this.readyState = 3; // CLOSED
      if (typeof this.onclose === 'function') {
        this.onclose({ target: this, code, reason, wasClean: code === 1000 });
      }
    }
  }

  DemoSocket._lastManifest = null;
  K4.DemoSocket = DemoSocket;
})();
