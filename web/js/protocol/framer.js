'use strict';

(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const START_MARKER = new Uint8Array([0xfe, 0xfd, 0xfc, 0xfb]);
  const END_MARKER = new Uint8Array([0xfb, 0xfc, 0xfd, 0xfe]);
  const HEADER_SIZE = 4;
  const LENGTH_SIZE = 4;
  const FOOTER_SIZE = 4;
  const OVERHEAD = HEADER_SIZE + LENGTH_SIZE + FOOTER_SIZE; // 12
  const MAX_PAYLOAD_SIZE = 262144;

  const PacketConstants = Object.freeze({
    START_MARKER,
    END_MARKER,
    HEADER_SIZE,
    LENGTH_SIZE,
    FOOTER_SIZE,
    OVERHEAD,
    MAX_PAYLOAD_SIZE,
    TYPE_CAT: 0,
    TYPE_AUDIO: 1,
    TYPE_PAN: 2,
    TYPE_MINIPAN: 3,
  });

  function toUint8(chunk) {
    if (chunk instanceof Uint8Array) return chunk;
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    if (ArrayBuffer.isView(chunk)) {
      return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    throw new TypeError('Expected Uint8Array, ArrayBuffer, or ArrayBufferView');
  }

  function findStartMarker(buf, start, end) {
    const limit = end - 4;
    for (let i = start; i <= limit; i++) {
      if (
        buf[i] === 0xfe &&
        buf[i + 1] === 0xfd &&
        buf[i + 2] === 0xfc &&
        buf[i + 3] === 0xfb
      ) {
        return i;
      }
    }
    return -1;
  }

  function hasEndMarker(buf, offset) {
    return (
      buf[offset] === 0xfb &&
      buf[offset + 1] === 0xfc &&
      buf[offset + 2] === 0xfd &&
      buf[offset + 3] === 0xfe
    );
  }

  /**
   * Stateful K4 stream framer handling split WebSocket/TCP chunks and false marker recovery.
   */
  class PacketFramer {
    /**
     * @param {Function|Object} [onPacketOrOpts]
     */
    constructor(onPacketOrOpts) {
      if (typeof onPacketOrOpts === 'function') {
        this._onPacket = onPacketOrOpts;
      } else if (onPacketOrOpts && typeof onPacketOrOpts.onPacket === 'function') {
        this._onPacket = onPacketOrOpts.onPacket;
      } else {
        this._onPacket = null;
      }
      this._buf = new Uint8Array(8192);
      this._len = 0;
      this._stats = {
        packetsDecoded: 0,
        badLengths: 0,
        badEndMarkers: 0,
        bytesDecoded: 0,
        bytesDropped: 0,
      };
    }

    /**
     * Reset buffered bytes and decoder counters.
     */
    reset() {
      this._len = 0;
      this._stats.packetsDecoded = 0;
      this._stats.badLengths = 0;
      this._stats.badEndMarkers = 0;
      this._stats.bytesDecoded = 0;
      this._stats.bytesDropped = 0;
    }

    /**
     * Return a snapshot of framer statistics.
     * @returns {Object}
     */
    getStats() {
      return {
        packetsDecoded: this._stats.packetsDecoded,
        badLengths: this._stats.badLengths,
        badEndMarkers: this._stats.badEndMarkers,
        bytesDecoded: this._stats.bytesDecoded,
        bytesDropped: this._stats.bytesDropped,
        bufferedBytes: this._len,
      };
    }

    /**
     * Append a received chunk and extract any complete K4 packets.
     * @param {Uint8Array|ArrayBuffer|ArrayBufferView} chunk
     * @returns {Uint8Array[]} Decoded payload frames
     */
    push(chunk) {
      const decoded = [];
      if (!chunk) return decoded;
      const bytes = toUint8(chunk);
      if (bytes.byteLength === 0) return decoded;

      const needed = this._len + bytes.byteLength;
      if (needed > this._buf.length) {
        let nextCap = this._buf.length || 8192;
        while (nextCap < needed) {
          nextCap *= 2;
        }
        const grown = new Uint8Array(nextCap);
        if (this._len > 0) {
          grown.set(this._buf.subarray(0, this._len), 0);
        }
        this._buf = grown;
      }
      this._buf.set(bytes, this._len);
      this._len = needed;

      const buf = this._buf;
      let cursor = 0;

      while (this._len - cursor >= 4) {
        const markerIdx = findStartMarker(buf, cursor, this._len);
        if (markerIdx === -1) {
          // Retain up to 3 trailing bytes in case START_MARKER straddles the next chunk.
          const remaining = this._len - cursor;
          const keep = Math.min(remaining, 3);
          this._stats.bytesDropped += remaining - keep;
          if (keep > 0) {
            buf.copyWithin(0, this._len - keep, this._len);
          }
          this._len = keep;
          return decoded;
        }

        if (markerIdx > cursor) {
          this._stats.bytesDropped += markerIdx - cursor;
          cursor = markerIdx;
        }

        const available = this._len - cursor;
        if (available < OVERHEAD) {
          break;
        }

        const payloadLength =
          ((buf[cursor + 4] << 24) |
            (buf[cursor + 5] << 16) |
            (buf[cursor + 6] << 8) |
            buf[cursor + 7]) >>>
          0;

        if (payloadLength === 0 || payloadLength > MAX_PAYLOAD_SIZE) {
          this._stats.badLengths++;
          this._stats.bytesDropped += 4;
          cursor += 4;
          continue;
        }

        if (available < OVERHEAD + payloadLength) {
          break;
        }

        const endOffset = cursor + 8 + payloadLength;
        if (!hasEndMarker(buf, endOffset)) {
          this._stats.badEndMarkers++;
          this._stats.bytesDropped += 4;
          cursor += 4;
          continue;
        }

        const payload = buf.slice(cursor + 8, endOffset);
        this._stats.packetsDecoded++;
        this._stats.bytesDecoded += payloadLength;
        decoded.push(payload);
        if (this._onPacket) {
          this._onPacket(payload);
        }
        cursor = endOffset + FOOTER_SIZE;
      }

      const tail = this._len - cursor;
      if (tail > 0 && cursor > 0) {
        buf.copyWithin(0, cursor, this._len);
      }
      this._len = tail;

      if (this._len === 0 && this._buf.length > 65536) {
        this._buf = new Uint8Array(8192);
      }

      return decoded;
    }

    /**
     * Wrap a raw payload byte array in K4 start/length/end framing bytes.
     * @param {Uint8Array|ArrayBuffer|ArrayBufferView} payloadUint8
     * @returns {Uint8Array}
     */
    static encodePacket(payloadUint8) {
      const payload = toUint8(payloadUint8);
      const len = payload.byteLength;
      if (len < 1 || len > MAX_PAYLOAD_SIZE) {
        throw new RangeError(`K4 payload length ${len} out of range 1..${MAX_PAYLOAD_SIZE}`);
      }
      const out = new Uint8Array(OVERHEAD + len);
      out.set(START_MARKER, 0);
      out[4] = (len >>> 24) & 0xff;
      out[5] = (len >>> 16) & 0xff;
      out[6] = (len >>> 8) & 0xff;
      out[7] = len & 0xff;
      out.set(payload, 8);
      out.set(END_MARKER, 8 + len);
      return out;
    }

    /**
     * Wrap an ASCII/Latin-1 CAT command string as a framed 0x00 CAT packet.
     * @param {string} catAscii
     * @returns {Uint8Array}
     */
    static encodeCatPacket(catAscii) {
      const str = String(catAscii);
      const payload = new Uint8Array(3 + str.length);
      payload[0] = PacketConstants.TYPE_CAT;
      payload[1] = 0x00;
      payload[2] = 0x00;
      for (let i = 0; i < str.length; i++) {
        payload[3 + i] = str.charCodeAt(i) & 0xff;
      }
      return PacketFramer.encodePacket(payload);
    }
  }

  K4.PacketConstants = PacketConstants;
  K4.PacketFramer = PacketFramer;
})();
