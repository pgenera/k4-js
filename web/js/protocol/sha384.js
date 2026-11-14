'use strict';

(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const MASK64 = 0xffffffffffffffffn;

  // FIPS 180-4 Section 5.3.4 SHA-384 initial hash values.
  const IV384 = [
    0xcbbb9d5dc1059ed8n,
    0x629a292a367cd507n,
    0x9159015a3070dd17n,
    0x152fecd8f70e5939n,
    0x67332667ffc00b31n,
    0x8eb44a8768581511n,
    0xdb0c2e0d64f98fa7n,
    0x47b5481dbefa4fa4n,
  ];

  // FIPS 180-4 Section 4.2.3 SHA-384/512 round constants.
  const K = [
    0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn, 0xe9b5dba58189dbbcn,
    0x3956c25bf348b538n, 0x59f111f1b605d019n, 0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n,
    0xd807aa98a3030242n, 0x12835b0145706fben, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n,
    0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n, 0xc19bf174cf692694n,
    0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n, 0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n,
    0x2de92c6f592b0275n, 0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n,
    0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn, 0xbf597fc7beef0ee4n,
    0xc6e00bf33da88fc2n, 0xd5a79147930aa725n, 0x06ca6351e003826fn, 0x142929670a0e6e70n,
    0x27b70a8546d22ffcn, 0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn,
    0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n, 0x92722c851482353bn,
    0xa2bfe8a14cf10364n, 0xa81a664bbc423001n, 0xc24b8b70d0f89791n, 0xc76c51a30654be30n,
    0xd192e819d6ef5218n, 0xd69906245565a910n, 0xf40e35855771202an, 0x106aa07032bbd1b8n,
    0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n, 0x34b0bcb5e19b48a8n,
    0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn, 0x5b9cca4f7763e373n, 0x682e6ff3d6b2b8a3n,
    0x748f82ee5defb2fcn, 0x78a5636f43172f60n, 0x84c87814a1f0ab72n, 0x8cc702081a6439ecn,
    0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n, 0xc67178f2e372532bn,
    0xca273eceea26619cn, 0xd186b8c721c0c207n, 0xeada7dd6cde0eb1en, 0xf57d4f7fee6ed178n,
    0x06f067aa72176fban, 0x0a637dc5a2c898a6n, 0x113f9804bef90daen, 0x1b710b35131c471bn,
    0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9bebcn, 0x431d67c49c100d4cn,
    0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an, 0x5fcb6fab3ad6faecn, 0x6c44198c4a475817n,
  ];

  const textEncoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

  function toBytes(input) {
    if (input instanceof Uint8Array) {
      return input;
    }
    if (input instanceof ArrayBuffer) {
      return new Uint8Array(input);
    }
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    const str = input === undefined || input === null ? '' : String(input);
    if (textEncoder) {
      return textEncoder.encode(str);
    }
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      let cp = str.codePointAt(i);
      if (cp > 0xffff) i++;
      if (cp <= 0x7f) {
        bytes.push(cp);
      } else if (cp <= 0x7ff) {
        bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
      } else if (cp <= 0xffff) {
        bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        bytes.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f)
        );
      }
    }
    return new Uint8Array(bytes);
  }

  function rotr64(x, n) {
    const shift = BigInt(n);
    const inv = BigInt(64 - n);
    return ((x >> shift) | (x << inv)) & MASK64;
  }

  /**
   * Compute a synchronous FIPS 180-4 SHA-384 digest using BigInt arithmetic.
   * Safe on file:// origins where crypto.subtle is unavailable.
   * @param {string|Uint8Array|ArrayBuffer|ArrayBufferView} input
   * @returns {string} 96-character lowercase hex digest
   */
  function sha384HexSync(input) {
    const msg = toBytes(input);
    const msgLen = msg.byteLength;
    const bitLen = BigInt(msgLen) * 8n;

    // Pad with 0x80, zero bytes, and 128-bit big-endian bit length to a 128-byte boundary.
    const rem = (msgLen + 17) % 128;
    const padZeros = rem === 0 ? 0 : 128 - rem;
    const totalLen = msgLen + 1 + padZeros + 16;
    const padded = new Uint8Array(totalLen);
    padded.set(msg, 0);
    padded[msgLen] = 0x80;

    const lenView = new DataView(padded.buffer, totalLen - 16, 16);
    lenView.setBigUint64(0, (bitLen >> 64n) & MASK64, false);
    lenView.setBigUint64(8, bitLen & MASK64, false);

    let h0 = IV384[0];
    let h1 = IV384[1];
    let h2 = IV384[2];
    let h3 = IV384[3];
    let h4 = IV384[4];
    let h5 = IV384[5];
    let h6 = IV384[6];
    let h7 = IV384[7];

    const W = new Array(80);
    const view = new DataView(padded.buffer);

    for (let offset = 0; offset < totalLen; offset += 128) {
      for (let t = 0; t < 16; t++) {
        W[t] = view.getBigUint64(offset + t * 8, false);
      }
      for (let t = 16; t < 80; t++) {
        const w15 = W[t - 15];
        const w2 = W[t - 2];
        const s0 = rotr64(w15, 1) ^ rotr64(w15, 8) ^ (w15 >> 7n);
        const s1 = rotr64(w2, 19) ^ rotr64(w2, 61) ^ (w2 >> 6n);
        W[t] = (s1 + W[t - 7] + s0 + W[t - 16]) & MASK64;
      }

      let a = h0;
      let b = h1;
      let c = h2;
      let d = h3;
      let e = h4;
      let f = h5;
      let g = h6;
      let h = h7;

      for (let t = 0; t < 80; t++) {
        const S1 = rotr64(e, 14) ^ rotr64(e, 18) ^ rotr64(e, 41);
        const ch = (e & f) ^ ((~e & MASK64) & g);
        const temp1 = (h + S1 + ch + K[t] + W[t]) & MASK64;
        const S0 = rotr64(a, 28) ^ rotr64(a, 34) ^ rotr64(a, 39);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (S0 + maj) & MASK64;

        h = g;
        g = f;
        f = e;
        e = (d + temp1) & MASK64;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) & MASK64;
      }

      h0 = (h0 + a) & MASK64;
      h1 = (h1 + b) & MASK64;
      h2 = (h2 + c) & MASK64;
      h3 = (h3 + d) & MASK64;
      h4 = (h4 + e) & MASK64;
      h5 = (h5 + f) & MASK64;
      h6 = (h6 + g) & MASK64;
      h7 = (h7 + h) & MASK64;
    }

    return (
      h0.toString(16).padStart(16, '0') +
      h1.toString(16).padStart(16, '0') +
      h2.toString(16).padStart(16, '0') +
      h3.toString(16).padStart(16, '0') +
      h4.toString(16).padStart(16, '0') +
      h5.toString(16).padStart(16, '0')
    );
  }

  /**
   * Async SHA-384 wrapper returning the deterministic pure-BigInt digest as a Promise.
   * @param {string|Uint8Array|ArrayBuffer|ArrayBufferView} input
   * @returns {Promise<string>}
   */
  function sha384Hex(input) {
    return Promise.resolve(sha384HexSync(input));
  }

  K4.sha384HexSync = sha384HexSync;
  K4.sha384Hex = sha384Hex;
})();
