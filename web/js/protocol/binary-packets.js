'use strict';

(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const PAN_BYTE_OFFSET = 162.0;
  const MINIPAN_BYTE_OFFSET = 118.0;

  function toUint8(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    return null;
  }

  function decodeLatin1(bytes, start) {
    const end = bytes.byteLength;
    if (start >= end) return '';
    const CHUNK = 4096;
    if (end - start <= CHUNK) {
      return String.fromCharCode.apply(null, bytes.subarray(start));
    }
    let out = '';
    for (let i = start; i < end; i += CHUNK) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(end, i + CHUNK)));
    }
    return out;
  }

  function readInt64LE(dv, offset) {
    if (typeof dv.getBigInt64 === 'function') {
      return Number(dv.getBigInt64(offset, true));
    }
    const lo = dv.getUint32(offset, true);
    const hi = dv.getInt32(offset + 4, true);
    return hi * 4294967296 + lo;
  }

  function sampleRateForCode(code) {
    if (code === 0) return 12000;
    if (code === 1) return 24000;
    if (code === 2) return 48000;
    return 12000;
  }

  /**
   * Parse a 0x00 CAT payload into { type: 0, version, text }.
   * @param {Uint8Array|ArrayBuffer|ArrayBufferView} payload
   * @returns {Object|null}
   */
  function parseCat(payload) {
    const u8 = toUint8(payload);
    if (!u8 || u8.byteLength < 3 || u8[0] !== 0x00) return null;
    return {
      type: 0,
      version: u8[1],
      text: decodeLatin1(u8, 3),
    };
  }

  /**
   * Parse a 0x01 Audio payload with odd-aligned offset-7 DataView.
   * @param {Uint8Array|ArrayBuffer|ArrayBufferView} payload
   * @returns {Object|null}
   */
  function parseAudio(payload) {
    const u8 = toUint8(payload);
    if (!u8 || u8.byteLength < 7 || u8[0] !== 0x01) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const frameSamplesPerCh = dv.getUint16(4, true);
    const sampleRateCode = u8[6];
    const data = u8.subarray(7);
    const dataView = new DataView(u8.buffer, u8.byteOffset + 7, u8.byteLength - 7);
    return {
      type: 1,
      version: u8[1],
      seq: u8[2],
      encodeMode: u8[3],
      frameSamplesPerCh,
      sampleRateCode,
      sampleRate: sampleRateForCode(sampleRateCode),
      data,
      dataView,
    };
  }

  /**
   * Encode an outbound 0x01 TX audio packet with a 7-byte K4 ver=0x01 header.
   * Uses DataView for header fields and byte copies for odd offset 7 safety.
   * @param {Object} [opts]
   * @returns {Uint8Array}
   */
  function encodeAudio(opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const seq = Number.isFinite(Number(o.seq)) ? Number(o.seq) : 0;
    const encodeMode = Number.isFinite(Number(o.encodeMode)) ? Number(o.encodeMode) : 1;
    const sampleRateCode = Number.isFinite(Number(o.sampleRateCode)) ? Number(o.sampleRateCode) : 0;
    const audioU8 = (o.audioBytes ? toUint8(o.audioBytes) : null) || new Uint8Array(0);
    const frameSamplesPerCh = Number.isFinite(Number(o.frameSamplesPerCh))
      ? Math.max(0, Math.floor(Number(o.frameSamplesPerCh)))
      : (audioU8.byteLength >>> 1);

    const out = new Uint8Array(7 + audioU8.byteLength);
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    dv.setUint8(0, 0x01);
    dv.setUint8(1, 0x01);
    dv.setUint8(2, seq & 0xff);
    dv.setUint8(3, encodeMode & 0xff);
    dv.setUint16(4, frameSamplesPerCh & 0xffff, true);
    dv.setUint8(6, sampleRateCode & 0xff);
    if (audioU8.byteLength > 0) {
      out.set(audioU8, 7);
    }
    return out;
  }

  /**
   * Parse a 0x02 PAN spectrum payload (27-byte LE header + bin bytes).
   * @param {Uint8Array|ArrayBuffer|ArrayBufferView} payload
   * @returns {Object|null}
   */
  function parsePan(payload) {
    const u8 = toUint8(payload);
    if (!u8 || u8.byteLength < 27 || u8[0] !== 0x02) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const dataLen = dv.getUint16(5, true);
    const rx = u8[4] === 1 ? 'B' : 'A';
    const centerFreqHz = readInt64LE(dv, 11);
    const sampleRateKHz = dv.getInt32(19, true);
    const noiseFloorDbm = dv.getInt32(23, true) / 10.0;
    const bins =
      dataLen > 0 && 27 + dataLen <= u8.byteLength
        ? u8.subarray(27, 27 + dataLen)
        : u8.subarray(27);
    return {
      type: 2,
      version: u8[1],
      rx,
      seq: u8[2],
      panType: u8[3],
      dataLen,
      centerFreqHz,
      sampleRateKHz,
      noiseFloorDbm,
      bins,
    };
  }

  /**
   * Parse a 0x03 MiniPAN payload (27-byte LE header + bin bytes).
   * @param {Uint8Array|ArrayBuffer|ArrayBufferView} payload
   * @returns {Object|null}
   */
  function parseMiniPan(payload) {
    const u8 = toUint8(payload);
    if (!u8 || u8.byteLength < 27 || u8[0] !== 0x03) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const dataLen = dv.getUint16(5, true);
    const rx = u8[4] === 1 ? 'B' : 'A';
    const centerFreqHz = readInt64LE(dv, 11);
    const spanKHz = dv.getInt32(19, true);
    const bins =
      dataLen > 0 && 27 + dataLen <= u8.byteLength
        ? u8.subarray(27, 27 + dataLen)
        : u8.subarray(27);
    return {
      type: 3,
      version: u8[1],
      rx,
      seq: u8[2],
      panType: u8[3],
      dataLen,
      centerFreqHz,
      spanKHz,
      noiseFloorDbm: null,
      bins,
    };
  }

  /**
   * Dispatch a framed payload to the matching K4 packet parser.
   * @param {Uint8Array|ArrayBuffer|ArrayBufferView} payload
   * @returns {Object|null}
   */
  function parse(payload) {
    const u8 = toUint8(payload);
    if (!u8 || u8.byteLength === 0) return null;
    switch (u8[0]) {
      case 0x00:
        return parseCat(u8);
      case 0x01:
        return parseAudio(u8);
      case 0x02:
        return parsePan(u8);
      case 0x03:
        return parseMiniPan(u8);
      default:
        return null;
    }
  }

  function panBinToDbm(byteVal) {
    return byteVal - PAN_BYTE_OFFSET;
  }

  function miniPanBinToDbm(byteVal) {
    return byteVal - MINIPAN_BYTE_OFFSET;
  }

  K4.BinaryPackets = {
    PAN_BYTE_OFFSET,
    MINIPAN_BYTE_OFFSET,
    parse,
    parseCat,
    parseAudio,
    encodeAudio,
    parsePan,
    parseMiniPan,
    panBinToDbm,
    miniPanBinToDbm,
  };
})();
