'use strict';
(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const K4_GAIN_BOOST = 32.0;

  function fallbackSoftClip(x) {
    if (!Number.isFinite(x)) return 0;
    const ax = Math.abs(x);
    if (ax <= 0.9) return x;
    const mag = Math.min(0.9999999, 0.9 + 0.1 * Math.tanh((ax - 0.9) / 0.1));
    return Math.sign(x) * mag;
  }

  function extractOpusBytes(audioPkt) {
    if (!audioPkt) return null;
    if (audioPkt instanceof Uint8Array) return audioPkt;
    if (ArrayBuffer.isView(audioPkt) && !(audioPkt instanceof DataView)) {
      return new Uint8Array(audioPkt.buffer, audioPkt.byteOffset, audioPkt.byteLength);
    }
    if (audioPkt instanceof ArrayBuffer) {
      return new Uint8Array(audioPkt);
    }
    if (audioPkt.data instanceof Uint8Array) return audioPkt.data;
    if (audioPkt.dataView instanceof DataView) {
      const dv = audioPkt.dataView;
      return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    }
    const buf = audioPkt.audioData || audioPkt.bytes || audioPkt.payload;
    if (buf instanceof Uint8Array) return buf;
    if (buf instanceof DataView) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
    return null;
  }

  function copyAudioChannels(audioData, fmt, frames, channels, left, right) {
    if (fmt === 'f32-planar') {
      audioData.copyTo(left, { planeIndex: 0 });
      if (channels >= 2) {
        audioData.copyTo(right, { planeIndex: 1 });
      } else {
        right.set(left);
      }
      return;
    }

    if (fmt === 's16-planar') {
      const tmp = new Int16Array(frames);
      audioData.copyTo(tmp, { planeIndex: 0 });
      for (let i = 0; i < frames; i++) left[i] = tmp[i] / 32768.0;
      if (channels >= 2) {
        audioData.copyTo(tmp, { planeIndex: 1 });
        for (let i = 0; i < frames; i++) right[i] = tmp[i] / 32768.0;
      } else {
        right.set(left);
      }
      return;
    }

    if (fmt === 's32-planar') {
      const tmp = new Int32Array(frames);
      audioData.copyTo(tmp, { planeIndex: 0 });
      for (let i = 0; i < frames; i++) left[i] = tmp[i] / 2147483648.0;
      if (channels >= 2) {
        audioData.copyTo(tmp, { planeIndex: 1 });
        for (let i = 0; i < frames; i++) right[i] = tmp[i] / 2147483648.0;
      } else {
        right.set(left);
      }
      return;
    }

    if (fmt === 'u8-planar') {
      const tmp = new Uint8Array(frames);
      audioData.copyTo(tmp, { planeIndex: 0 });
      for (let i = 0; i < frames; i++) left[i] = (tmp[i] - 128) / 128.0;
      if (channels >= 2) {
        audioData.copyTo(tmp, { planeIndex: 1 });
        for (let i = 0; i < frames; i++) right[i] = (tmp[i] - 128) / 128.0;
      } else {
        right.set(left);
      }
      return;
    }

    if (fmt === 'f32') {
      const tmp = new Float32Array(frames * channels);
      audioData.copyTo(tmp, { planeIndex: 0 });
      for (let i = 0; i < frames; i++) {
        const base = i * channels;
        left[i] = tmp[base];
        right[i] = channels >= 2 ? tmp[base + 1] : tmp[base];
      }
      return;
    }

    if (fmt === 's16') {
      const tmp = new Int16Array(frames * channels);
      audioData.copyTo(tmp, { planeIndex: 0 });
      for (let i = 0; i < frames; i++) {
        const base = i * channels;
        left[i] = tmp[base] / 32768.0;
        right[i] = channels >= 2 ? tmp[base + 1] / 32768.0 : left[i];
      }
      return;
    }

    if (fmt === 's32') {
      const tmp = new Int32Array(frames * channels);
      audioData.copyTo(tmp, { planeIndex: 0 });
      for (let i = 0; i < frames; i++) {
        const base = i * channels;
        left[i] = tmp[base] / 2147483648.0;
        right[i] = channels >= 2 ? tmp[base + 1] / 2147483648.0 : left[i];
      }
      return;
    }

    if (fmt === 'u8') {
      const tmp = new Uint8Array(frames * channels);
      audioData.copyTo(tmp, { planeIndex: 0 });
      for (let i = 0; i < frames; i++) {
        const base = i * channels;
        left[i] = (tmp[base] - 128) / 128.0;
        right[i] = channels >= 2 ? (tmp[base + 1] - 128) / 128.0 : left[i];
      }
      return;
    }

    // Fallback: ask WebCodecs to convert to f32-planar if format string is non-standard.
    audioData.copyTo(left, { planeIndex: 0, format: 'f32-planar' });
    if (channels >= 2) {
      audioData.copyTo(right, { planeIndex: 1, format: 'f32-planar' });
    } else {
      right.set(left);
    }
  }

  /**
   * WebCodecs Opus decoder for K4 EM2/EM3 packets.
   * Configures without `description` per W3C WebCodecs for raw RFC 6716 Opus frames.
   */
  class OpusPacketDecoder {
    static isSupported() {
      return typeof globalThis.AudioDecoder === 'function';
    }

    constructor(opts = {}) {
      this._onOutput = typeof opts.onOutput === 'function'
        ? opts.onOutput
        : (typeof opts.output === 'function' ? opts.output : null);
      this._onError = typeof opts.onError === 'function'
        ? opts.onError
        : (typeof opts.error === 'function' ? opts.error : null);
      this._decoder = null;
      this._timestampUs = 0;
      this._packetsIn = 0;
      this._framesOut = 0;
      this._errors = 0;
    }

    setCallbacks({ onOutput, onError } = {}) {
      if (typeof onOutput === 'function') this._onOutput = onOutput;
      if (typeof onError === 'function') this._onError = onError;
    }

    configure() {
      if (!OpusPacketDecoder.isSupported()) return false;
      try {
        if (!this._decoder || this._decoder.state === 'closed') {
          this._decoder = new globalThis.AudioDecoder({
            output: (audioData) => this._handleAudioData(audioData),
            error: (err) => this._handleError(err),
          });
        }
        if (this._decoder.state === 'unconfigured') {
          this._decoder.configure({
            codec: 'opus',
            sampleRate: 48000,
            numberOfChannels: 2,
          });
        }
        return this._decoder.state === 'configured';
      } catch (err) {
        this._handleError(err);
        return false;
      }
    }

    decode(audioPkt) {
      const bytes = extractOpusBytes(audioPkt);
      if (!bytes || bytes.byteLength === 0) return false;
      if (!this.configure()) return false;
      if (typeof globalThis.EncodedAudioChunk !== 'function') return false;

      try {
        const chunk = new globalThis.EncodedAudioChunk({
          type: 'key',
          timestamp: this._timestampUs,
          data: bytes,
        });
        this._decoder.decode(chunk);
        this._timestampUs += 20000;
        this._packetsIn += 1;
        return true;
      } catch (err) {
        this._handleError(err);
        return false;
      }
    }

    _handleAudioData(audioData) {
      try {
        if (!audioData) return;
        const frames = audioData.numberOfFrames | 0;
        if (frames <= 0) return;

        const channels = Math.max(1, audioData.numberOfChannels | 0);
        const sampleRate = audioData.sampleRate || 48000;
        const fmt = audioData.format || 'f32-planar';

        const left = new Float32Array(frames);
        const right = new Float32Array(frames);
        copyAudioChannels(audioData, fmt, frames, channels, left, right);

        const pcm = K4.PcmDecoder;
        const boost = (pcm && pcm.K4_GAIN_BOOST) || K4_GAIN_BOOST;
        const clip = (pcm && pcm.softClip) || fallbackSoftClip;
        for (let i = 0; i < frames; i++) {
          left[i] = clip(left[i] * boost);
          right[i] = clip(right[i] * boost);
        }

        this._framesOut += frames;
        if (this._onOutput) {
          this._onOutput({ left, right, sampleRate });
        }
      } finally {
        try {
          if (audioData && typeof audioData.close === 'function') {
            audioData.close();
          }
        } catch (_) {}
      }
    }

    _handleError(err) {
      this._errors += 1;
      if (this._onError) {
        try {
          this._onError(err);
        } catch (_) {}
      }
    }

    flush() {
      if (this._decoder && this._decoder.state === 'configured' && typeof this._decoder.flush === 'function') {
        return this._decoder.flush().catch((err) => this._handleError(err));
      }
      return Promise.resolve();
    }

    reset() {
      this._timestampUs = 0;
      if (!this._decoder) return;
      try {
        if (this._decoder.state !== 'closed') {
          this._decoder.reset();
        }
      } catch (_) {}
      this.configure();
    }

    close() {
      if (!this._decoder) return;
      try {
        if (this._decoder.state !== 'closed') {
          this._decoder.close();
        }
      } catch (_) {}
      this._decoder = null;
    }

    getStats() {
      return {
        supported: OpusPacketDecoder.isSupported(),
        state: this._decoder ? this._decoder.state : 'uninitialized',
        packetsIn: this._packetsIn,
        framesOut: this._framesOut,
        errors: this._errors,
      };
    }
  }

  K4.OpusPacketDecoder = OpusPacketDecoder;
})();
