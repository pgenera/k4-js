'use strict';
(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const K4_GAIN_BOOST = 32.0;
  const S16_SCALE = K4_GAIN_BOOST / 32768.0;
  const S24_SCALE = K4_GAIN_BOOST / 8388608.0;

  /**
   * Smooth C1-continuous soft limiter above |x| > 0.9.
   * Preserves exact linearity inside [-0.9, 0.9] while saturating cleanly < 1.0.
   */
  function softClip(x) {
    if (!Number.isFinite(x)) return 0;
    const ax = Math.abs(x);
    if (ax <= 0.9) return x;
    const mag = Math.min(0.9999999, 0.9 + 0.1 * Math.tanh((ax - 0.9) / 0.1));
    return Math.sign(x) * mag;
  }

  function resolveSampleRate(sampleRateCode, explicitRate) {
    if (typeof explicitRate === 'number' && Number.isFinite(explicitRate) && explicitRate > 0) {
      return explicitRate;
    }
    if (sampleRateCode === 1) return 24000;
    if (sampleRateCode === 2) return 48000;
    return 12000;
  }

  /**
   * Extract a DataView covering the PCM audio samples (starting after the 7-byte header).
   * Never creates Int16Array/Int32Array directly over an unaligned byteOffset (e.g. 7).
   */
  function extractPacketView(audioPkt) {
    if (audioPkt instanceof Uint8Array || (ArrayBuffer.isView(audioPkt) && !(audioPkt instanceof DataView))) {
      const u8 = audioPkt instanceof Uint8Array
        ? audioPkt
        : new Uint8Array(audioPkt.buffer, audioPkt.byteOffset, audioPkt.byteLength);
      if (u8.byteLength < 7 || u8[0] !== 0x01) {
        throw new RangeError('PcmDecoder expected raw 0x01 K4 audio packet with >= 7 header bytes');
      }
      const hdr = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      return {
        encodeMode: u8[3],
        frameSamplesPerCh: hdr.getUint16(4, true),
        sampleRate: resolveSampleRate(u8[6], null),
        dv: new DataView(u8.buffer, u8.byteOffset + 7, u8.byteLength - 7),
      };
    }

    const encodeMode = audioPkt.encodeMode !== undefined ? audioPkt.encodeMode : 1;
    const frameSamplesPerCh = audioPkt.frameSamplesPerCh || 0;
    const sampleRate = resolveSampleRate(audioPkt.sampleRateCode || 0, audioPkt.sampleRate);

    let dv = null;
    if (audioPkt.dataView instanceof DataView) {
      dv = audioPkt.dataView;
    } else {
      const buf = audioPkt.data || audioPkt.audioData || audioPkt.bytes || audioPkt.payload;
      if (buf instanceof DataView) {
        dv = buf;
      } else if (ArrayBuffer.isView(buf)) {
        dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      } else if (buf instanceof ArrayBuffer) {
        dv = new DataView(buf);
      } else if (audioPkt.raw instanceof Uint8Array && audioPkt.raw.byteLength >= 7) {
        dv = new DataView(audioPkt.raw.buffer, audioPkt.raw.byteOffset + 7, audioPkt.raw.byteLength - 7);
      }
    }

    return { encodeMode, frameSamplesPerCh, sampleRate, dv };
  }

  function emptyResult(sampleRate, scratch) {
    if (scratch) {
      const left = scratch.left instanceof Float32Array ? scratch.left.subarray(0, 0) : new Float32Array(0);
      const right = scratch.right instanceof Float32Array ? scratch.right.subarray(0, 0) : new Float32Array(0);
      return { left, right, sampleRate };
    }
    return { left: new Float32Array(0), right: new Float32Array(0), sampleRate };
  }

  function decodeCore(audioPkt, scratch) {
    if (!audioPkt) {
      return emptyResult(12000, scratch);
    }

    const { encodeMode, frameSamplesPerCh, sampleRate, dv } = extractPacketView(audioPkt);

    if (encodeMode !== 0 && encodeMode !== 1) {
      throw new RangeError('K4.PcmDecoder supports encodeMode 0 (S24_LE) or 1 (S16_LE), got: ' + encodeMode);
    }

    if (!dv || dv.byteLength === 0) {
      return emptyResult(sampleRate, scratch);
    }

    const bytesPerFrame = encodeMode === 0 ? 8 : 4;
    const availableFrames = Math.floor(dv.byteLength / bytesPerFrame);
    const frameCount = frameSamplesPerCh > 0
      ? Math.min(frameSamplesPerCh, availableFrames)
      : availableFrames;

    if (frameCount === 0) {
      return emptyResult(sampleRate, scratch);
    }

    let leftBuf;
    let rightBuf;
    if (scratch) {
      if (!(scratch.left instanceof Float32Array) || scratch.left.length < frameCount) {
        scratch.left = new Float32Array(frameCount);
      }
      if (!(scratch.right instanceof Float32Array) || scratch.right.length < frameCount) {
        scratch.right = new Float32Array(frameCount);
      }
      leftBuf = scratch.left;
      rightBuf = scratch.right;
    } else {
      leftBuf = new Float32Array(frameCount);
      rightBuf = new Float32Array(frameCount);
    }

    if (encodeMode === 1) {
      for (let i = 0, pos = 0; i < frameCount; i++, pos += 4) {
        const vl = dv.getInt16(pos, true) * S16_SCALE;
        const vr = dv.getInt16(pos + 2, true) * S16_SCALE;
        leftBuf[i] = vl >= -0.9 && vl <= 0.9 ? vl : softClip(vl);
        rightBuf[i] = vr >= -0.9 && vr <= 0.9 ? vr : softClip(vr);
      }
    } else {
      for (let i = 0, pos = 0; i < frameCount; i++, pos += 8) {
        const vl = dv.getInt32(pos, true) * S24_SCALE;
        const vr = dv.getInt32(pos + 4, true) * S24_SCALE;
        leftBuf[i] = vl >= -0.9 && vl <= 0.9 ? vl : softClip(vl);
        rightBuf[i] = vr >= -0.9 && vr <= 0.9 ? vr : softClip(vr);
      }
    }

    return scratch
      ? { left: leftBuf.subarray(0, frameCount), right: rightBuf.subarray(0, frameCount), sampleRate }
      : { left: leftBuf, right: rightBuf, sampleRate };
  }

  /**
   * Decode a K4 0x01 PCM audio packet (EM0 24-bit-in-S32LE or EM1 S16LE) into
   * newly allocated calibrated float32 stereo buffers with 32x boost and soft limiting.
   */
  function decode(audioPkt) {
    return decodeCore(audioPkt, null);
  }

  /**
   * Zero-alloc decode path reusing preallocated `scratch.left` / `scratch.right` Float32Arrays
   * (growing only when `frameCount > capacity`) and returning `.subarray(0, frameCount)` views.
   */
  function decodeInto(audioPkt, scratch) {
    const target = scratch && typeof scratch === 'object' ? scratch : {};
    return decodeCore(audioPkt, target);
  }

  K4.PcmDecoder = {
    K4_GAIN_BOOST,
    S16_SCALE,
    S24_SCALE,
    softClip,
    decode,
    decodeInto,
  };
})();
