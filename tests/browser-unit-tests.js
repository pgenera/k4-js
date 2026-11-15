'use strict';
(() => {
  const tests = [];

  function test(name, fn) {
    tests.push({ name, fn });
  }

  function assert(cond, msg) {
    if (!cond) {
      throw new Error(msg || 'Assertion failed');
    }
  }

  function assertEqual(actual, expected, label) {
    if (actual !== expected) {
      throw new Error(`${label || 'Expected equality'}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
  }

  function assertApprox(actual, expected, tol, label) {
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > tol) {
      throw new Error(`${label || 'Expected approx'}: got ${actual}, expected ${expected} (+/-${tol})`);
    }
  }

  function assertDeepEqual(actual, expected, label) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
      throw new Error(`${label || 'Expected deep equality'}: got ${a}, expected ${b}`);
    }
  }

  // 1. NIST SHA-384 Vectors (sync & async on file:// without crypto.subtle)
  test('SHA-384 NIST vectors (sha384HexSync & sha384Hex)', async () => {
    const K4 = globalThis.K4;
    assert(typeof K4.sha384HexSync === 'function', 'K4.sha384HexSync missing');
    assert(typeof K4.sha384Hex === 'function', 'K4.sha384Hex missing');

    const vectors = [
      [
        '',
        '38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe76f65fbd51ad2f14898b95b',
      ],
      [
        'abc',
        'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7',
      ],
      [
        'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
        '3391fdddfc8dc7393707a65b1b4709397cf8b1d162af05abfe8f450de5f36bc6b0455a8520bc4e6f5fe95b1fe3c8452b',
      ],
      [
        'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
        '09330c33f71147e83d192fc782cd1b4753111b173b3b05d22fa08086e3b0f712fcc7c71a557e2db966c3e9fa91746039',
      ],
    ];

    for (const [input, expected] of vectors) {
      const syncOut = K4.sha384HexSync(input);
      assertEqual(syncOut, expected, `sha384HexSync(${JSON.stringify(input)})`);
      assertEqual(syncOut.length, 96, 'SHA-384 hex length');
      const asyncOut = await K4.sha384Hex(input);
      assertEqual(asyncOut, expected, `sha384Hex(${JSON.stringify(input)})`);
    }
  });

  // 2. PacketFramer split chunks, 1..3 trailing bytes, and false marker recovery
  test('PacketFramer handles split chunks and false markers', () => {
    const K4 = globalThis.K4;
    const pktA = K4.PacketFramer.encodeCatPacket('FA00014074000;');
    const pktB = K4.PacketFramer.encodeCatPacket('FB00014025000;');

    // False marker with length = 0, then false marker with oversized length, then false marker with bad end marker
    const falseZero = new Uint8Array([0xfe, 0xfd, 0xfc, 0xfb, 0, 0, 0, 0]);
    const falseHuge = new Uint8Array([0xfe, 0xfd, 0xfc, 0xfb, 0x00, 0x10, 0x00, 0x00]);
    const falseEnd = new Uint8Array([
      0xfe, 0xfd, 0xfc, 0xfb, 0, 0, 0, 4,
      0x41, 0x42, 0x43, 0x44,
      0xaa, 0xbb, 0xcc, 0xdd,
    ]);
    // Embedded real start marker right after a 4-byte false start marker (tests cursor += 4)
    const adjacentFalse = new Uint8Array([0xfe, 0xfd, 0xfc, 0xfb]);

    const parts = [falseZero, falseHuge, falseEnd, adjacentFalse, pktA, pktB];
    let totalLen = 0;
    for (const p of parts) totalLen += p.length;
    const stream = new Uint8Array(totalLen);
    let off = 0;
    for (const p of parts) {
      stream.set(p, off);
      off += p.length;
    }

    const framer = new K4.PacketFramer();
    const out = [];
    // Feed in 1, 2, 3 byte chunks so START_MARKER splits across boundaries
    let pos = 0;
    let stepIdx = 0;
    while (pos < stream.length) {
      const step = (stepIdx % 3) + 1;
      stepIdx++;
      const chunk = stream.subarray(pos, Math.min(stream.length, pos + step));
      pos += chunk.length;
      const decoded = framer.push(chunk);
      for (const d of decoded) out.push(d);
    }

    assertEqual(out.length, 2, 'decoded packet count');
    assertEqual(K4.BinaryPackets.parseCat(out[0]).text, 'FA00014074000;', 'pktA CAT');
    assertEqual(K4.BinaryPackets.parseCat(out[1]).text, 'FB00014025000;', 'pktB CAT');
    const stats = framer.getStats();
    assert(stats.badLengths >= 2, `expected badLengths >= 2, got ${stats.badLengths}`);
    assert(stats.badEndMarkers >= 1, `expected badEndMarkers >= 1, got ${stats.badEndMarkers}`);
  });

  // 3. CatCodec TB/TB$ literal semicolons & Sub-RX $ longest-prefix matching
  test('CatCodec TB$ literal semicolons & $ Sub-RX longest-prefix', () => {
    const K4 = globalThis.K4;
    const raw = 'FA00014074000;TB020CQ DE W6ELE K ; 73 ;;TB$020CQ DE W6ELE K ; 73 ;;SMH$-091;MD$3;BW$0050;#SPN$24000;#SPN46;MXAB.AB;';
    const frames = K4.CatCodec.splitFrames(raw);
    assertDeepEqual(frames, [
      'FA00014074000',
      'TB020CQ DE W6ELE K ; 73 ;',
      'TB$020CQ DE W6ELE K ; 73 ;',
      'SMH$-091',
      'MD$3',
      'BW$0050',
      '#SPN$24000',
      '#SPN46',
      'MXAB.AB',
    ], 'splitFrames TB$ & $');

    const tbA = K4.CatCodec.parseCommand(frames[1]);
    assertEqual(tbA.kind, 'decodedText', 'TB kind');
    assertEqual(tbA.rx, 'A', 'TB rx');
    assertEqual(tbA.text, 'CQ DE W6ELE K ; 73 ;', 'TB literal semicolons preserved');

    const tbB = K4.CatCodec.parseCommand(frames[2]);
    assertEqual(tbB.kind, 'decodedText', 'TB$ kind');
    assertEqual(tbB.rx, 'B', 'TB$ rx');
    assertEqual(tbB.text, 'CQ DE W6ELE K ; 73 ;', 'TB$ literal semicolons preserved');

    const smhB = K4.CatCodec.parseCommand('SMH$-091;');
    assertEqual(smhB.kind, 'smeterDbm', 'SMH$ longest-prefix kind');
    assertEqual(smhB.rx, 'B', 'SMH$ rx');
    assertEqual(smhB.dBm, -91, 'SMH$ dBm');

    const mdB = K4.CatCodec.parseCommand('MD$3;');
    assertEqual(mdB.kind, 'mode', 'MD$ kind');
    assertEqual(mdB.rx, 'B', 'MD$ rx');
    assertEqual(mdB.modeCode, 3, 'MD$ code');

    const bwB = K4.CatCodec.parseCommand('BW$0050;');
    assertEqual(bwB.kind, 'bw', 'BW$ kind');
    assertEqual(bwB.rx, 'B', 'BW$ rx');
    assertEqual(bwB.bwHz, 500, 'BW$ Hz');

    const spnB = K4.CatCodec.parseCommand('#SPN$24000;');
    assertEqual(spnB.kind, 'panSpan', '#SPN$ kind');
    assertEqual(spnB.rx, 'B', '#SPN$ rx');
    assertEqual(spnB.spanHz, 24000, '#SPN$ Hz');

    const spnShort = K4.CatCodec.parseCommand('#SPN46;');
    assertEqual(spnShort.spanHz, 46000, '#SPN46 * 1000 Hz');

    assertEqual(K4.CatCodec.builders.freq('B', 14025000), 'FB00014025000;', 'builder freq B');
    assertEqual(K4.CatCodec.builders.mode('B', 3), 'MD$3;', 'builder mode B');
    assertEqual(K4.CatCodec.builders.bw('B', 500), 'BW$0050;', 'builder bw B');
  });

  // 4. RxOnlyGate TX rejection vs RX pass
  test('RxOnlyGate blocks TX/tune/keyer/PC/SW and allows RX/SP/display/audio', () => {
    const K4 = globalThis.K4;
    const gate = new K4.RxOnlyGate('rx-only');
    const blockedEvents = [];
    gate.on('blocked', (ev) => blockedEvents.push(ev));

    const mixed = gate.inspectCat('FA00014074000;MD3;TX;TU1;KY CQ;PC050;SW01;SW10;SP1;TS1;RX;SP0;#SPN48000;MXA.B;');
    assertDeepEqual(mixed.allowed, [
      'FA00014074000;',
      'MD3;',
      'SP1;',
      'RX;',
      'SP0;',
      '#SPN48000;',
      'MXA.B;',
    ], 'allowed RX/SP commands');
    assertDeepEqual(mixed.blocked, [
      'TX;',
      'TU1;',
      'KY CQ;',
      'PC050;',
      'SW01;',
      'SW10;',
      'TS1;',
    ], 'blocked TX commands');
    assertEqual(mixed.sanitized, 'FA00014074000;MD3;SP1;RX;SP0;#SPN48000;MXA.B;', 'sanitized CAT');

    assertEqual(gate.inspectBinary(0x00), true, 'CAT binary 0x00 allowed');
    assertEqual(gate.inspectBinary(0x01), false, 'TX Audio binary 0x01 blocked');

    const stats = gate.getStats();
    assertEqual(stats.blockedCatCount, 7, 'blockedCatCount');
    assertEqual(stats.blockedBinaryCount, 1, 'blockedBinaryCount');
    assertEqual(blockedEvents.length, 8, 'blocked events emitted');
  });

  // 5. BinaryPackets parsing (PAN 0x02, MiniPAN 0x03, Audio 0x01)
  test('BinaryPackets parses PAN (0x02), MiniPAN (0x03), Audio (0x01)', () => {
    const K4 = globalThis.K4;

    const panBuf = new Uint8Array(27 + 4);
    const pdv = new DataView(panBuf.buffer);
    panBuf[0] = 0x02;
    panBuf[4] = 1; // B
    pdv.setUint16(5, 4, true);
    pdv.setBigInt64(11, 14025500n, true);
    pdv.setInt32(19, 48, true);
    pdv.setInt32(23, -1205, true);
    panBuf.set([42, 100, 162, 200], 27);

    const pan = K4.BinaryPackets.parse(panBuf);
    assertEqual(pan.type, 2, 'PAN type');
    assertEqual(pan.rx, 'B', 'PAN rx');
    assertEqual(pan.centerFreqHz, 14025500, 'PAN centerFreqHz');
    assertEqual(pan.sampleRateKHz, 48, 'PAN sampleRateKHz');
    assertApprox(pan.noiseFloorDbm, -120.5, 1e-6, 'PAN noiseFloorDbm');
    assertEqual(pan.bins.length, 4, 'PAN bins len');

    const miniBuf = new Uint8Array(27 + 2);
    const mdv = new DataView(miniBuf.buffer);
    miniBuf[0] = 0x03;
    miniBuf[4] = 0; // A
    mdv.setUint16(5, 2, true);
    mdv.setBigInt64(11, 14074000n, true);
    mdv.setInt32(19, 12, true);
    miniBuf.set([0, 118], 27);

    const mini = K4.BinaryPackets.parse(miniBuf);
    assertEqual(mini.type, 3, 'MiniPAN type');
    assertEqual(mini.rx, 'A', 'MiniPAN rx');
    assertEqual(mini.spanKHz, 12, 'MiniPAN spanKHz');
    assertEqual(mini.noiseFloorDbm, null, 'MiniPAN noiseFloorDbm null');
  });

  // 6. DSP: SpectrumScale, SpectrumGeometry, PowerAverager, WaterfallRowMapper, CW click-to-tune
  test('Panadapter DSP math (scale, crop, CW click-to-tune, linear PowerAverager, WaterfallRowMapper)', () => {
    const K4 = globalThis.K4;

    const panDbm = K4.SpectrumScale.decodePanBins(new Uint8Array([42, 162]));
    assertApprox(panDbm[0], -120, 1e-6, 'PAN byte 42 -> -120 dBm');
    assertApprox(panDbm[1], 0, 1e-6, 'PAN byte 162 -> 0 dBm');

    const miniDbm = K4.SpectrumScale.decodeMiniPanBins(new Uint8Array([18, 118]));
    assertApprox(miniDbm[0], -100, 1e-6, 'MiniPAN byte 18 -> -100 dBm');
    assertApprox(miniDbm[1], 0, 1e-6, 'MiniPAN byte 118 -> 0 dBm');

    const crop = K4.SpectrumGeometry.computeCrop(24000, 48);
    assertApprox(crop.spanRatio, 0.5, 1e-6, 'crop spanRatio');
    assertApprox(crop.leftRatio, 0.25, 1e-6, 'crop leftRatio');

    // CW mode (+500 Hz display marker) and click-to-tune reversal (-500 Hz)
    const cwMarker = K4.SpectrumGeometry.displayMarkerHz({ freqHz: 14024500, mode: 3 }, 500);
    assertEqual(cwMarker, 14025000, 'CW displayMarkerHz');
    const cwrMarker = K4.SpectrumGeometry.displayMarkerHz({ freqHz: 14025500, mode: 7 }, 500);
    assertEqual(cwrMarker, 14025000, 'CW-R displayMarkerHz');

    // Clicking center of panadapter centered on 14025000 Hz in CW mode (500 Hz pitch) -> dial 14024500 Hz
    const dialCw = K4.SpectrumGeometry.dialFreqFromClick({
      xPx: 500,
      plotLeftPx: 100,
      plotWidthPx: 800,
      panCenterHz: 14025000,
      userSpanHz: 48000,
      mode: 3,
      cwPitchHz: 500,
      stepHz: 100,
      fine: false,
    });
    assertEqual(dialCw, 14024500, 'CW click-to-tune center reverses +500 Hz pitch');

    // Clicking at 25% right of center (+12000 Hz) in CW mode -> 14025000 + 12000 - 500 = 14036500 Hz
    const dialCwOffset = K4.SpectrumGeometry.dialFreqFromClick({
      xPx: 700,
      plotLeftPx: 100,
      plotWidthPx: 800,
      panCenterHz: 14025000,
      userSpanHz: 48000,
      mode: 3,
      cwPitchHz: 500,
      stepHz: 100,
      fine: false,
    });
    assertEqual(dialCwOffset, 14036500, 'CW click-to-tune offset reverses +500 Hz pitch');

    // CW-R (mode 7) click-to-tune adds +cwPitchHz offset, and fine=false snaps to stepHz
    const dialCwr = K4.SpectrumGeometry.dialFreqFromClick({
      xPx: 500,
      plotLeftPx: 100,
      plotWidthPx: 800,
      panCenterHz: 14025000,
      userSpanHz: 48000,
      mode: 7,
      cwPitchHz: 500,
      stepHz: 100,
      fine: false,
    });
    assertEqual(dialCwr, 14025500, 'CW-R click-to-tune center adds +500 Hz pitch');

    // Non-fine stepHz snapping: x = 100 + 800 * (0.5 + 40/48000) -> +40 Hz snaps down to 14025000; +60 Hz snaps up to 14025100
    const snapDown = K4.SpectrumGeometry.dialFreqFromClick({
      xPx: 100 + 800 * (0.5 + 40 / 48000),
      plotLeftPx: 100,
      plotWidthPx: 800,
      panCenterHz: 14025000,
      userSpanHz: 48000,
      mode: 2,
      stepHz: 100,
      fine: false,
    });
    assertEqual(snapDown, 14025000, 'non-fine stepHz=100 snaps +40 Hz down to 14025000');

    const snapUp = K4.SpectrumGeometry.dialFreqFromClick({
      xPx: 100 + 800 * (0.5 + 60 / 48000),
      plotLeftPx: 100,
      plotWidthPx: 800,
      panCenterHz: 14025000,
      userSpanHz: 48000,
      mode: 2,
      stepHz: 100,
      fine: false,
    });
    assertEqual(snapUp, 14025100, 'non-fine stepHz=100 snaps +60 Hz up to 14025100');

    // PowerAverager MUST average in linear mW, not arithmetic dB
    const avg = new K4.PowerAverager(2, 2);
    avg.push(new Float32Array([-60, -100]), 2);
    const res = avg.push(new Float32Array([-70, -100]), 2);
    const expectedLinearDbm = 10 * Math.log10((Math.pow(10, -6) + Math.pow(10, -7)) / 2);
    assertApprox(res.avgDbm[0], expectedLinearDbm, 1e-4, 'linear mW average');
    avg.clear();
    const afterClear = avg.push(new Float32Array([-80, -80]), 2);
    assertApprox(afterClear.avgDbm[0], -80, 1e-4, 'PowerAverager.clear resets history');

    // WaterfallRowMapper reserves 0 for blank rows, mapping valid bins to 1..255
    // Bottom-referenced K4 #REF convention: lowDbm = refDbm - scaleDb * (wbs / 40)
    const wfRow = K4.WaterfallRowMapper.mapRow(new Float32Array([-200, -110, -58, 0]), {
      refDbm: -110,
      scaleDb: 80,
      wfBlack: 14,
    });
    assertEqual(wfRow[0], 1, 'Waterfall min bin mapped to 1 (never 0)');
    assertEqual(wfRow[1], 90, 'Waterfall bottom ref bin (-110 dBm at WBS=14) maps above floor');
    assertEqual(wfRow[2], 255, 'Waterfall top bin (-58 dBm) mapped to 255');
    assertEqual(wfRow[3], 255, 'Waterfall clipped max bin mapped to 255');

    // Varying WBS (wfBlack 5 vs 30) shifts black-level floor while staying within 1..255
    const sampleBins = new Float32Array([-200, -135, -100, 0]);
    const wfWbs5 = K4.WaterfallRowMapper.mapRow(sampleBins, { refDbm: -110, scaleDb: 80, wfBlack: 5 });
    const wfWbs30 = K4.WaterfallRowMapper.mapRow(sampleBins, { refDbm: -110, scaleDb: 80, wfBlack: 30 });
    assertEqual(wfWbs5[0], 1, 'WBS=5 clamps floor bin to 1');
    assertEqual(wfWbs30[0], 1, 'WBS=30 clamps floor bin to 1');
    assertEqual(wfWbs5[3], 255, 'WBS=5 clamps max bin to 255');
    assertEqual(wfWbs30[3], 255, 'WBS=30 clamps max bin to 255');
    assertEqual(wfWbs5[1], 1, 'WBS=5 maps -135 dBm (below -120 floor) to 1');
    assert(wfWbs30[1] > wfWbs5[1] && wfWbs30[1] < 255, 'WBS=30 widens dynamic range at -135 dBm');
    assert(wfWbs30[2] > wfWbs5[2] && wfWbs30[2] < 255, 'WBS=30 raises normalized brightness at -100 dBm');
  });

  // 7. Audio: PcmDecoder at odd byte offset 7 (EM1 S16LE & EM0 S32LE) + mixStereoSample
  test('PcmDecoder decodes unaligned offset-7 EM1/EM0 at 32x boost & softClip', () => {
    const K4 = globalThis.K4;

    // Put packet starting at byteOffset=1 inside backing ArrayBuffer so payload+7 is byteOffset=8 or odd=7
    const pkt1 = new Uint8Array(7 + 8); // 2 stereo S16LE frames
    pkt1[0] = 0x01;
    pkt1[2] = 7;
    pkt1[3] = 1; // EM1 S16LE
    new DataView(pkt1.buffer).setUint16(4, 2, true);
    pkt1[6] = 0; // 12000 Hz
    const dv1 = new DataView(pkt1.buffer, 7, 8);
    dv1.setInt16(0, 512, true);    // 512 * 32 / 32768 = 0.5
    dv1.setInt16(2, -512, true);   // -0.5
    dv1.setInt16(4, 1024, true);   // 1.0 -> softClip(1.0) in (0.9, 1.0)
    dv1.setInt16(6, -1024, true);  // -1.0 -> softClip(-1.0) in (-1.0, -0.9)

    const parsed1 = K4.BinaryPackets.parseAudio(pkt1);
    assertEqual(parsed1.dataView.byteOffset, 7, 'offset-7 DataView alignment');
    const dec1 = K4.PcmDecoder.decode(parsed1);
    assertEqual(dec1.sampleRate, 12000, 'EM1 sampleRate');
    assertApprox(dec1.left[0], 0.5, 1e-5, 'EM1 left[0] = 0.5');
    assertApprox(dec1.right[0], -0.5, 1e-5, 'EM1 right[0] = -0.5');
    assert(dec1.left[1] > 0.9 && dec1.left[1] < 1.0, 'EM1 softClip upper');
    assert(dec1.right[1] < -0.9 && dec1.right[1] > -1.0, 'EM1 softClip lower');

    // EM0 24-bit in S32LE at odd byte offset 7
    const pkt0 = new Uint8Array(7 + 8);
    pkt0[0] = 0x01;
    pkt0[3] = 0; // EM0
    new DataView(pkt0.buffer).setUint16(4, 1, true);
    const dv0 = new DataView(pkt0.buffer, 7, 8);
    dv0.setInt32(0, 131072, true);  // 131072 * 32 / 8388608 = 0.5
    dv0.setInt32(4, -131072, true); // -0.5

    const dec0 = K4.PcmDecoder.decode(pkt0);
    assertApprox(dec0.left[0], 0.5, 1e-5, 'EM0 left[0] = 0.5');
    assertApprox(dec0.right[0], -0.5, 1e-5, 'EM0 right[0] = -0.5');

    assertEqual(K4.PcmDecoder.softClip(0.9), 0.9, 'softClip linear <= 0.9');
    assert(K4.PcmDecoder.softClip(10.0) < 1.0, 'softClip saturates < 1.0');

    // Zero-alloc decodeInto matches decode() sample-for-sample and reuses backing buffers across calls
    const scratch = { left: new Float32Array(4), right: new Float32Array(4) };
    const origLeftBuf = scratch.left.buffer;
    const origRightBuf = scratch.right.buffer;
    const into1 = K4.PcmDecoder.decodeInto(parsed1, scratch);
    assertEqual(into1.sampleRate, dec1.sampleRate, 'decodeInto sampleRate matches decode');
    assertEqual(into1.left.length, dec1.left.length, 'decodeInto length matches frameCount');
    for (let i = 0; i < dec1.left.length; i++) {
      assertApprox(into1.left[i], dec1.left[i], 1e-7, `decodeInto left[${i}] matches decode`);
      assertApprox(into1.right[i], dec1.right[i], 1e-7, `decodeInto right[${i}] matches decode`);
    }
    assertEqual(into1.left.buffer, origLeftBuf, 'decodeInto reuses scratch left ArrayBuffer');
    assertEqual(into1.right.buffer, origRightBuf, 'decodeInto reuses scratch right ArrayBuffer');
    const into1b = K4.PcmDecoder.decodeInto(parsed1, scratch);
    assertEqual(into1b.left.buffer, origLeftBuf, 'repeat decodeInto call keeps same scratch left buffer');
    assertEqual(into1b.right.buffer, origRightBuf, 'repeat decodeInto call keeps same scratch right buffer');
    // Verify growth only when packet exceeds current capacity
    const dec0Into = K4.PcmDecoder.decodeInto(pkt0, scratch);
    assertApprox(dec0Into.left[0], dec0.left[0], 1e-7, 'decodeInto EM0 left[0] matches decode');
    assertEqual(dec0Into.left.buffer, origLeftBuf, 'decodeInto EM0 smaller frame reuses same buffer');

    // Verify mixStereoSample gates Sub when subRxEnabled === false
    const monoGated = K4.mixStereoSample(0.4, 0.9, {
      subRxEnabled: false,
      muted: false,
      mixMode: 'A.B',
      gainA: 1.0,
      gainB: 1.0,
      balance: 0,
    });
    assertApprox(monoGated.left, 0.4, 1e-5, 'Sub gated left');
    assertApprox(monoGated.right, 0.4, 1e-5, 'Sub gated right (dual-mono A)');

    const binaural = K4.mixStereoSample(0.4, -0.3, {
      subRxEnabled: true,
      muted: false,
      mixMode: 'A.B',
      gainA: 1.0,
      gainB: 1.0,
      balance: 0,
    });
    assertApprox(binaural.left, 0.4, 1e-5, 'Binaural A.B left');
    assertApprox(binaural.right, -0.3, 1e-5, 'Binaural A.B right');
  });

  // 8. RadioState hydration & storage/events sanity
  test('RadioState updates from parsed CAT & storage/events work on file://', () => {
    const K4 = globalThis.K4;
    const state = new K4.RadioState();
    let changeCount = 0;
    state.on('change', () => { changeCount++; });

    const cmds = K4.CatCodec.splitFrames('FA00007074000;MD$7;TB$020CQ DE W6ELE K ; 73 ;;');
    for (const c of cmds) {
      const parsed = K4.CatCodec.parseCommand(c);
      if (parsed && typeof state.applyParsedCat === 'function') {
        state.applyParsedCat(parsed);
      }
    }
    const snap = state.getSnapshot();
    assertEqual(snap.rxA.freqHz, 7074000, 'RadioState FA updated');
    assertEqual(snap.rxB.mode, 7, 'RadioState MD$ updated');
    assert(snap.decodedText.length >= 1, 'RadioState decodedText updated');
    assertEqual(snap.decodedText[snap.decodedText.length - 1].text, 'CQ DE W6ELE K ; 73 ;', 'RadioState TB$ semicolon text');
    assert(changeCount >= 3, 'RadioState emitted change events');

    K4.storage.set('k4.testKey', { ok: 1 });
    assertDeepEqual(K4.storage.get('k4.testKey', null), { ok: 1 }, 'K4.storage set/get');
    K4.storage.remove('k4.testKey');
  });

  // 9. AudioEngine: capabilities/file:// Opus detection, SL0..SL7 targets, MX presets & state sync
  test('AudioEngine detects capabilities, maps SL0..SL7 targets, and switches MX presets', () => {
    const K4 = globalThis.K4;
    const expectedOpusSupported = typeof globalThis.AudioDecoder === 'function';
    assertEqual(K4.OpusPacketDecoder.isSupported(), expectedOpusSupported, 'OpusPacketDecoder.isSupported matches AudioDecoder');
    assertEqual(new K4.OpusPacketDecoder().getStats().supported, expectedOpusSupported, 'OpusPacketDecoder stats.supported matches');

    const workletUrl = K4.createWorkletDataUrl();
    assert(typeof workletUrl === 'string' && workletUrl.startsWith('data:text/javascript;base64,'), 'createWorkletDataUrl returns text/javascript base64 data URL');

    const state = new K4.RadioState();
    const engine = new K4.AudioEngine({ state });
    try {
      // Simulate non-secure LAN HTTP or browser without WebCodecs AudioDecoder
      const audioDecDesc = Object.getOwnPropertyDescriptor(globalThis, 'AudioDecoder');
      const opusErrors = [];
      engine.on('error', (err) => opusErrors.push(err));
      try {
        Object.defineProperty(globalThis, 'AudioDecoder', {
          value: undefined,
          configurable: true,
          writable: true,
        });
        assertEqual(K4.OpusPacketDecoder.isSupported(), false, 'OpusPacketDecoder.isSupported false when AudioDecoder absent');
        const dec = new K4.OpusPacketDecoder();
        assertEqual(dec.getStats().supported, false, 'OpusPacketDecoder stats.supported false when AudioDecoder absent');
        assertEqual(dec.configure(), false, 'OpusPacketDecoder.configure returns false cleanly when unsupported');
        engine.pushPacket({ seq: 0, encodeMode: 2, dataView: new DataView(new ArrayBuffer(8)), frameCount: 2 });
        assertEqual(opusErrors.length, 1, 'AudioEngine emits error on Opus packet when AudioDecoder unavailable');
      } finally {
        if (audioDecDesc) {
          Object.defineProperty(globalThis, 'AudioDecoder', audioDecDesc);
        } else {
          delete globalThis.AudioDecoder;
        }
      }

      const emClient = new K4.Client({ state });
      try {
        Object.defineProperty(globalThis, 'AudioDecoder', { value: function MockAudioDecoder() {}, configurable: true, writable: true });
        assertEqual(K4.OpusPacketDecoder.isSupported(), true, 'OpusPacketDecoder.isSupported true when AudioDecoder present');
        assertEqual(emClient._resolveEncodeMode('auto'), 1, 'Client._resolveEncodeMode(auto) defaults to EM1 when Opus supported');
        assertEqual(emClient._resolveEncodeMode(undefined), 1, 'Client._resolveEncodeMode(undefined) defaults to EM1');
        assertEqual(emClient._resolveEncodeMode('bogus'), 1, 'Client._resolveEncodeMode(bogus) falls back to EM1');
        assertEqual(emClient._resolveEncodeMode(0), 0, 'Client._resolveEncodeMode(0) keeps EM0');
        assertEqual(emClient._resolveEncodeMode('1'), 1, 'Client._resolveEncodeMode("1") keeps EM1');
        assertEqual(emClient._resolveEncodeMode(3), 3, 'Client._resolveEncodeMode(3) keeps EM3 when Opus supported');
        assertEqual(emClient._resolveEncodeMode('2'), 2, 'Client._resolveEncodeMode("2") keeps EM2 when Opus supported');

        Object.defineProperty(globalThis, 'AudioDecoder', { value: undefined, configurable: true, writable: true });
        assertEqual(K4.OpusPacketDecoder.isSupported(), false, 'OpusPacketDecoder.isSupported false when AudioDecoder undefined');
        assertEqual(emClient._resolveEncodeMode('auto'), 1, 'Client._resolveEncodeMode(auto) returns EM1 without Opus');
        assertEqual(emClient._resolveEncodeMode(3), 1, 'Client._resolveEncodeMode(3) falls back to EM1 without Opus');
        assertEqual(emClient._resolveEncodeMode('2'), 1, 'Client._resolveEncodeMode("2") falls back to EM1 without Opus');
        assertEqual(emClient._resolveEncodeMode(0), 0, 'Client._resolveEncodeMode(0) keeps EM0 without Opus');
      } finally {
        if (audioDecDesc) {
          Object.defineProperty(globalThis, 'AudioDecoder', audioDecDesc);
        } else {
          delete globalThis.AudioDecoder;
        }
      }

      const expectedTargets = [35, 60, 75, 95, 115, 140, 180, 240];
      assertDeepEqual(Array.from(K4.SL_TARGET_MS), expectedTargets, 'SL_TARGET_MS table');
      for (let tier = 0; tier < expectedTargets.length; tier++) {
        engine.setLatencyTier(tier);
        assertEqual(engine.getLatencyTier(), tier, `SL${tier} tier`);
        assertEqual(engine.getDiagnostics().targetMs, expectedTargets[tier], `SL${tier} targetMs`);
      }
      engine.setLatencyTier(99);
      assertEqual(engine.getLatencyTier(), 7, 'SL clamped upper bound to 7');

      for (const preset of ['A.B', 'AB.AB', 'A.-A', 'B.B']) {
        engine.setMixMode(preset);
        assertEqual(engine.getMixMode(), preset, `MX preset ${preset}`);
      }
      engine.setMixMode('INVALID.MIX');
      assertEqual(engine.getMixMode(), 'B.B', 'invalid MX preset ignored');

      // RadioState CAT SL / MX updates synchronize into AudioEngine
      state.applyParsedCat(K4.CatCodec.parseCommand('SL4;'));
      state.applyParsedCat(K4.CatCodec.parseCommand('MXAB.AB;'));
      assertEqual(engine.getLatencyTier(), 4, 'state SL4 syncs engine tier');
      assertEqual(engine.getDiagnostics().targetMs, 115, 'state SL4 targetMs = 115');
      assertEqual(engine.getMixMode(), 'AB.AB', 'state MXAB.AB syncs engine mixMode');

      // Verify mixStereoSample across MX presets with Sub-RX enabled
      const baseOpts = { subRxEnabled: true, muted: false, gainA: 1.0, gainB: 1.0, balance: 0 };
      const ab = K4.mixStereoSample(0.6, -0.2, { ...baseOpts, mixMode: 'A.B' });
      assertApprox(ab.left, 0.6, 1e-5, 'MX A.B left');
      assertApprox(ab.right, -0.2, 1e-5, 'MX A.B right');

      const abab = K4.mixStereoSample(0.6, -0.2, { ...baseOpts, mixMode: 'AB.AB' });
      assertApprox(abab.left, 0.2, 1e-5, 'MX AB.AB left');
      assertApprox(abab.right, 0.2, 1e-5, 'MX AB.AB right');

      const aNegA = K4.mixStereoSample(0.6, -0.2, { ...baseOpts, mixMode: 'A.-A' });
      assertApprox(aNegA.left, 0.6, 1e-5, 'MX A.-A left');
      assertApprox(aNegA.right, -0.6, 1e-5, 'MX A.-A right');

      const bb = K4.mixStereoSample(0.6, -0.2, { ...baseOpts, mixMode: 'B.B' });
      assertApprox(bb.left, -0.2, 1e-5, 'MX B.B left');
      assertApprox(bb.right, -0.2, 1e-5, 'MX B.B right');
    } finally {
      engine.destroy();
    }
  });

  // 10. D4 + QK4 authoritative reconciliation: RxOnlyGate, CatCodec builders/parsers, RadioState
  test('D4 + QK4 rules: GET-only RxOnlyGate, FC/FI/OV/DV/#FRZ/RT/RO parsers, builders, and RadioState', () => {
    const K4 = globalThis.K4;

    const gate = new K4.RxOnlyGate('rx-only');
    const blockedCmds = [
      'AN1;',
      'AN/;',
      'FT1;',
      'FT/;',
      'IDW6ELE;',
      'RRPsecret;',
      'TS1;',
      'VC$12;',
    ];
    const blockedRes = gate.inspectCat(blockedCmds.join(''));
    assertDeepEqual(blockedRes.allowed, [], 'D4 blocked commands must not pass allowed');
    assertDeepEqual(
      blockedRes.blocked,
      blockedCmds.map((c) => c.toUpperCase()),
      'D4 blocks SET AN/FT/ID, RRP, TS, VC$'
    );
    assertEqual(blockedRes.sanitized, '', 'D4 blocked batch sanitized empty');

    const allowedCmds = [
      'SP;',
      'SP$3;',
      'SP0;',
      'SP1;',
      'SP3;',
      'AN;',
      'FT;',
      'FT0;',
      'ID;',
      'OM;',
      'SN;',
      'RV;',
      'IF;',
      'TQ;',
      'PP;',
      'PP05;',
      'VC32;',
      'DV1;',
      'FC;',
      'FC$-250;',
      '#FRZ1;',
      '#FXT1;',
      'RT$1;',
      'RO$-0050;',
    ];
    const allowedRes = gate.inspectCat(allowedCmds.join(''));
    assertDeepEqual(allowedRes.blocked, [], 'D4 allowed GET/RX/SP/display/pan commands must not be blocked');
    assertDeepEqual(allowedRes.allowed, allowedCmds, 'D4 allows SP/SP$3/SP0..3, GET AN/FT/FT0/ID/OM/SN/RV/IF/TQ/PP/PP05, VC, DV, FC, #FRZ, #FXT, RT$, RO$');

    // Verify builders
    assertEqual(K4.CatCodec.builders.centerPan('A'), 'FC;', 'builder centerPan A');
    assertEqual(K4.CatCodec.builders.centerPan('B', -250), 'FC$-250;', 'builder centerPan B -250');
    assertEqual(K4.CatCodec.builders.centerPan('A', 250), 'FC+250;', 'builder centerPan A +250');
    assertEqual(K4.CatCodec.builders.rit('B', true), 'RT$1;', 'builder rit B true');
    assertEqual(K4.CatCodec.builders.ritOffset('B', -50), 'RO$-0050;', 'builder ritOffset B -50');

    // Verify CatCodec parsing & RadioState hydration
    const state = new K4.RadioState();
    const frames = K4.CatCodec.splitFrames('OV$10;DV1;FI00014074000;#FRZ1;RT$1;RO$-0120;');
    assertEqual(frames.length, 6, 'splitFrames count for D4/D5 commands');

    const parsedList = frames.map((f) => K4.CatCodec.parseCommand(f));
    assertEqual(parsedList[0].kind, 'adcOverflow', 'OV$ kind');
    assertEqual(parsedList[0].rx, 'B', 'OV$ rx');
    assertEqual(parsedList[0].adcOverflow, true, 'OV$10 adcOverflow true');
    assertEqual(parsedList[0].cor, false, 'OV$10 cor false');
    assertEqual(parsedList[1].kind, 'diversity', 'DV kind');
    assertEqual(parsedList[1].diversityEnabled, true, 'DV1 diversityEnabled');
    assertEqual(parsedList[2].kind, 'ifCenter', 'FI kind');
    assertEqual(parsedList[2].rx, 'A', 'FI rx A');
    assertEqual(parsedList[2].ifCenterHz, 14074000, 'FI ifCenterHz');
    assertEqual(parsedList[3].kind, 'panFrozen', '#FRZ kind');
    assertEqual(parsedList[3].panFrozen, true, '#FRZ1 panFrozen');
    assertEqual(parsedList[4].kind, 'rit', 'RT$ kind');
    assertEqual(parsedList[4].rx, 'B', 'RT$ rx B');
    assertEqual(parsedList[4].ritOn, true, 'RT$1 ritOn');
    assertEqual(parsedList[5].kind, 'ritOffset', 'RO$ kind');
    assertEqual(parsedList[5].rx, 'B', 'RO$ rx B');
    assertEqual(parsedList[5].ritOffsetHz, -120, 'RO$-0120 ritOffsetHz');

    for (const p of parsedList) {
      state.applyParsedCat(p);
    }
    const snap = state.getSnapshot();
    assertEqual(snap.rxB.adcOverflow, true, 'RadioState rxB.adcOverflow');
    assertEqual(snap.diversityEnabled, true, 'RadioState diversityEnabled');
    assertEqual(snap.rxA.ifCenterHz, 14074000, 'RadioState rxA.ifCenterHz');
    assertEqual(snap.panFrozen, true, 'RadioState panFrozen');
    assertEqual(snap.rxB.ritOn, true, 'RadioState rxB.ritOn');
    assertEqual(snap.rxB.ritOffsetHz, -120, 'RadioState rxB.ritOffsetHz');
  });

  test('11. Sanitized K4 hardware CAT parsing & RadioState', () => {
    const sn = K4.CatCodec.parseCommand('SN00999;');
    assertEqual(sn && sn.kind, 'serial', 'SN parses as serial');
    assertEqual(sn && sn.serial, '00999', 'SN serial extracted');

    const omNoSub = K4.CatCodec.parseCommand('OM AP------4---;');
    assertEqual(omNoSub && omNoSub.kind, 'optionModule', 'OM parses');
    assertEqual(omNoSub && omNoSub.optionModules, 'AP------4---', 'OM modules field');
    assertEqual(omNoSub && omNoSub.hasSubRx, false, 'OM hasSubRx false when no S');

    const omSub = K4.CatCodec.parseCommand('OM AP-----S4---;');
    assertEqual(omSub && omSub.hasSubRx, true, 'OM hasSubRx true when S present');

    const barePong = K4.CatCodec.parseCommand('PONG;');
    assertEqual(barePong && barePong.kind, 'pong', 'Bare PONG parses');
    assertEqual(barePong && barePong.rx, null, 'Bare PONG rx null');
    assertEqual(barePong && barePong.epoch, null, 'Bare PONG epoch null');

    const numPong = K4.CatCodec.parseCommand('PONG12345;');
    assertEqual(numPong && numPong.kind, 'pong', 'Numeric PONG parses');
    assertEqual(numPong && numPong.epoch, 12345, 'Numeric PONG epoch parsed');

    const nbA4 = K4.CatCodec.parseCommand('NB0000;');
    assertEqual(nbA4 && nbA4.kind, 'nb', '4-digit NB0000 parses');
    assertEqual(nbA4 && nbA4.rx, 'A', 'NB0000 rx A');
    assertEqual(nbA4 && nbA4.nbLevel, 0, 'NB0000 level 0');
    assertEqual(nbA4 && nbA4.nbOn, false, 'NB0000 off');

    const nbB4 = K4.CatCodec.parseCommand('NB$0121;');
    assertEqual(nbB4 && nbB4.rx, 'B', 'NB$0121 rx B');
    assertEqual(nbB4 && nbB4.nbLevel, 12, 'NB$0121 level 12');
    assertEqual(nbB4 && nbB4.nbOn, true, 'NB$0121 on');

    const nbB0 = K4.CatCodec.parseCommand('NB$0000;');
    assertEqual(nbB0 && nbB0.rx, 'B', 'NB$0000 rx B');
    assertEqual(nbB0 && nbB0.nbLevel, 0, 'NB$0000 level 0');
    assertEqual(nbB0 && nbB0.nbOn, false, 'NB$0000 off');

    const nbA1 = K4.CatCodec.parseCommand('NB1;');
    assertEqual(nbA1 && nbA1.nbLevel, null, '1-digit NB1 level null');
    assertEqual(nbA1 && nbA1.nbOn, true, '1-digit NB1 on');

    const vtA = K4.CatCodec.parseCommand('VT16;');
    assertEqual(vtA && vtA.kind, 'step', 'VT16 parses');
    assertEqual(vtA && vtA.rx, 'A', 'VT16 rx A');
    assertEqual(vtA && vtA.stepIdx, 1, 'VT16 stepIdx 1');
    assertEqual(vtA && vtA.stepHz, 10, 'VT16 stepHz 10');
    assertEqual(vtA && vtA.modeCode, 6, 'VT16 modeCode 6');

    const vtB = K4.CatCodec.parseCommand('VT$13;');
    assertEqual(vtB && vtB.rx, 'B', 'VT$13 rx B');
    assertEqual(vtB && vtB.stepIdx, 1, 'VT$13 stepIdx 1');
    assertEqual(vtB && vtB.modeCode, 3, 'VT$13 modeCode 3');

    const arExtOn = K4.CatCodec.parseCommand('#AR1206-021;');
    assertEqual(arExtOn && arExtOn.kind, 'autoRef', '#AR1206-021 parses');
    assertEqual(arExtOn && arExtOn.autoRef, true, '#AR1206-021 autoRef true');
    assertEqual(K4.CatCodec.parseCommand('#AR1206-020;').autoRef, false, '#AR1206-020 autoRef false');
    assertEqual(K4.CatCodec.parseCommand('#ARA;').autoRef, true, '#ARA autoRef true');
    assertEqual(K4.CatCodec.parseCommand('#ARM;').autoRef, false, '#ARM autoRef false');
    assertEqual(K4.CatCodec.parseCommand('#AR0;').autoRef, false, '#AR0 autoRef false');
    assertEqual(K4.CatCodec.parseCommand('#AR1;').autoRef, true, '#AR1 autoRef true');
    assertEqual(K4.CatCodec.parseCommand('#AR9;').autoRef, true, '#AR9 autoRef true');

    const rgNeg = K4.CatCodec.parseCommand('RG-06;');
    assertEqual(rgNeg && rgNeg.kind, 'rfGain', 'RG-06 parses');
    assertEqual(rgNeg && rgNeg.rfGainDb, -6, 'RG-06 rfGainDb -6');

    const mpOff = K4.CatCodec.parseCommand('#MP$-1;');
    assert(mpOff !== null && mpOff.rx === 'B', '#MP$-1 parses for RX B');

    const state = new K4.RadioState();
    const frames = K4.CatCodec.splitFrames(
      'SN00999;OM AP------4---;FA00014025000;MD3;CW0500;NB0000;NB$0000;VT16;VT$13;RG-06;#AR1206-021;#MP$-1;'
    );
    for (const f of frames) {
      const parsed = K4.CatCodec.parseCommand(f);
      if (parsed) state.applyParsedCat(parsed);
    }
    const snap = state.getSnapshot();
    assertEqual(snap.rxA.freqHz, 14025000, 'Golden batch FA applied');
    assertEqual(snap.rxA.mode, 3, 'Golden batch MD3 applied');
    assertEqual(snap.rxA.nbOn, false, 'Golden batch NB0000 applied');
    assertEqual(snap.rxA.stepIdx, 1, 'Golden batch VT16 applied');
    assertEqual(snap.rxA.rfGainDb, -6, 'Golden batch RG-06 applied');
    assertEqual(snap.rxA.autoRef, true, 'Golden batch #AR1206-021 applied');
  });

  test('12. RxOnlyGate # command allowlist blocks #TX/#CAL/unknown', () => {
    const gate = new K4.RxOnlyGate('rx-only');
    const allowedHashCmds = [
      '#SPN;',
      '#SPN$00500;',
      '#REF;',
      '#HREF$;',
      '#SCL0;',
      '#AVG10;',
      '#WBS0;',
      '#HWBS1;',
      '#WFC0;',
      '#HWFC1;',
      '#WFH0;',
      '#HWFH1;',
      '#AR1206-021;',
      '#ARA;',
      '#ARM;',
      '#DPM0;',
      '#HDPM0;',
      '#MP$-1;',
      '#FRZ0;',
      '#FXT0;',
      '#FXA0;',
      '#FSL0;',
      '#PKM0;',
      '#FPS30;',
      '#CWT0;',
      '#VFA;',
      '#VFB;',
      '#MKA0;',
      '#MKB0;',
      '#DSM0;',
      '#HDM0;',
      '#HDS0;',
      '#UNM0;',
      '#NB0;',
      '#NBL0;',
      '#SFL0;',
    ];
    for (const cmd of allowedHashCmds) {
      const res = gate.inspectCat(cmd);
      assertEqual(res.allowed.length, 1, `Allowed hash cmd accepted: ${cmd}`);
      assertEqual(res.blocked.length, 0, `Allowed hash cmd not blocked: ${cmd}`);
    }

    const blockedHashCmds = ['#TX1;', '#TX$;', '#CAL1;', '#CAL$;', '#ZZZ1;', '#QSY1;', '#;'];
    for (const cmd of blockedHashCmds) {
      const res = gate.inspectCat(cmd);
      assertEqual(res.allowed.length, 0, `Blocked hash cmd denied: ${cmd}`);
      assertEqual(res.blocked.length, 1, `Blocked hash cmd recorded: ${cmd}`);
    }

    const mixed = gate.inspectCat('#TX1;#CAL1;#ZZZ1;#SPN$;#AR1206-021;');
    assertEqual(mixed.blocked.length, 3, 'Mixed # batch blocks TX/CAL/ZZZ');
    assertEqual(mixed.allowed.length, 2, 'Mixed # batch keeps #SPN$/#AR');
    assertEqual(mixed.sanitized, '#SPN$;#AR1206-021;', 'Mixed # batch sanitized');
  });

  test('13. OpusPacketDecoder variable duration timestamps', () => {
    const hadAudioDecoder = Object.prototype.hasOwnProperty.call(globalThis, 'AudioDecoder');
    const hadEncodedAudioChunk = Object.prototype.hasOwnProperty.call(globalThis, 'EncodedAudioChunk');
    const origAudioDecoder = globalThis.AudioDecoder;
    const origEncodedAudioChunk = globalThis.EncodedAudioChunk;
    const chunks = [];

    try {
      globalThis.EncodedAudioChunk = function MockEncodedAudioChunk(init) {
        return { type: init.type, timestamp: init.timestamp, data: init.data };
      };
      globalThis.AudioDecoder = class MockAudioDecoder {
        constructor() {
          this.state = 'unconfigured';
        }
        static async isConfigSupported() {
          return { supported: true };
        }
        configure() {
          this.state = 'configured';
        }
        decode(chunk) {
          chunks.push(chunk);
        }
        async flush() {}
        close() {
          this.state = 'closed';
        }
      };

      const dec = new K4.OpusPacketDecoder();
      assertEqual(
        dec.decode({ frameSamplesPerCh: 240, sampleRate: 12000, data: new Uint8Array([0xbc, 1]) }),
        true,
        'SL0 decodes'
      );
      assertEqual(chunks[0].timestamp, 0, 'SL0 chunk starts at 0us');
      assertEqual(dec._timestampUs, 20000, 'SL0 advances timestamp by 20000us');

      assertEqual(
        dec.decode({ frameSamplesPerCh: 480, sampleRate: 12000, data: new Uint8Array([0xbd, 2]) }),
        true,
        'SL2 decodes'
      );
      assertEqual(chunks[1].timestamp, 20000, 'SL2 chunk starts at 20000us');
      assertEqual(dec._timestampUs, 60000, 'SL2 advances timestamp by 40000us');

      assertEqual(
        dec.decode({ frameSamplesPerCh: 720, sampleRate: 12000, data: new Uint8Array([0xbe, 3]) }),
        true,
        'SL3 decodes'
      );
      assertEqual(chunks[2].timestamp, 60000, 'SL3 chunk starts at 60000us');
      assertEqual(dec._timestampUs, 120000, 'SL3 advances timestamp by 60000us');

      assertEqual(dec.decode(new Uint8Array([0xbc, 4])), true, 'Raw Uint8Array decodes');
      assertEqual(chunks[3].timestamp, 120000, 'Raw chunk starts at 120000us');
      assertEqual(dec._timestampUs, 140000, 'Raw Uint8Array advances fallback 20000us');

      const rawPkt = new Uint8Array(10);
      rawPkt[0] = 1;
      rawPkt[1] = 0;
      rawPkt[2] = 7;
      rawPkt[3] = 2; // EM2 Opus
      rawPkt[4] = 480 & 0xff;
      rawPkt[5] = (480 >> 8) & 0xff;
      rawPkt[6] = 0; // 12000 Hz
      rawPkt.set([0xbd, 5, 6], 7);
      const parsedAudio = K4.BinaryPackets.parseAudio(rawPkt);
      assertEqual(dec.decode(parsedAudio), true, 'BinaryPackets.parseAudio result decodes');
      assertEqual(chunks[4].timestamp, 140000, 'Parsed EM2 SL2 chunk starts at 140000us');
      assertEqual(dec._timestampUs, 180000, 'Parsed EM2 SL2 advances timestamp by 40000us');
      assertEqual(dec.getStats().packetsIn, 5, 'Total 5 Opus chunks decoded');
    } finally {
      if (hadAudioDecoder) globalThis.AudioDecoder = origAudioDecoder;
      else delete globalThis.AudioDecoder;
      if (hadEncodedAudioChunk) globalThis.EncodedAudioChunk = origEncodedAudioChunk;
      else delete globalThis.EncodedAudioChunk;
    }
  });

  test('14. PanadapterInteraction click near passband edge tunes VFO without edge drag', () => {
    const listeners = {};
    const surface = {
      style: {},
      clientWidth: 1120,
      clientHeight: 400,
      getBoundingClientRect() {
        return { left: 0, top: 0, width: 1120, height: 400 };
      },
      addEventListener(type, fn) {
        listeners[type] = fn;
      },
      removeEventListener(type, fn) {
        if (listeners[type] === fn) delete listeners[type];
      },
      setPointerCapture() {},
      releasePointerCapture() {},
    };

    const snapshot = {
      cwPitchHz: 500,
      dualPanMode: 0,
      subRxEnabled: false,
      rxA: {
        freqHz: 14086000,
        mode: 3,
        bwHz: 2700,
        ifShiftHz: 1500,
        panCenterHz: 14086000,
        panSpanHz: 48000,
        stepHz: 100,
      },
      rxB: {
        freqHz: 14074000,
        mode: 2,
        bwHz: 2400,
        ifShiftHz: 1500,
        panCenterHz: 14074000,
        panSpanHz: 48000,
        stepHz: 100,
      },
    };

    const layouts = [
      {
        rx: 'A',
        paneRect: { x: 0, y: 0, w: 1120, h: 400 },
        specRect: { x: 0, y: 0, w: 1120, h: 200 },
        axisRect: { x: 0, y: 200, w: 1120, h: 24 },
      },
    ];
    const tunes = [];
    const filterEdits = [];
    const hoverStates = [];
    let lastClickFreqHz = null;

    const view = {
      getTargetRx: () => 'A',
      getFrameState: () => ({
        snapshot,
        dualPanMode: 0,
        panes: { A: { panCenterHz: 14086000, userSpanHz: 48000 } },
      }),
      setHoverState: (s) => hoverStates.push(s),
      setLastClickFreqHz: (hz) => {
        lastClickFreqHz = hz;
      },
    };
    const renderer = { getLayouts: () => layouts };
    const state = { getSnapshot: () => snapshot };
    const client = {
      tune: (rx, hz) => tunes.push({ rx, hz }),
      setFilter: (rx, patch) => filterEdits.push({ rx, patch }),
    };

    const interaction = new K4.PanadapterInteraction({ surface, renderer, view, state, client });
    try {
      // Zero-drag left-click at center x=560 (3.5px from CW passband lowHz=14086150 -> within EDGE_HIT_PX=6)
      listeners.pointerdown({
        type: 'pointerdown',
        pointerId: 1,
        pointerType: 'mouse',
        button: 0,
        clientX: 560,
        clientY: 100,
        shiftKey: false,
        altKey: false,
      });
      // Small <=5px jitter must not convert click into an edge drag
      listeners.pointermove({
        type: 'pointermove',
        pointerId: 1,
        pointerType: 'mouse',
        button: 0,
        clientX: 562,
        clientY: 101,
        shiftKey: false,
        altKey: false,
      });
      listeners.pointerup({
        type: 'pointerup',
        pointerId: 1,
        pointerType: 'mouse',
        button: 0,
        clientX: 560,
        clientY: 100,
        shiftKey: false,
        altKey: false,
      });

      assertEqual(filterEdits.length, 0, 'No-drag click near passband edge does not mutate filter');
      assertEqual(tunes.length, 1, 'No-drag click near passband edge tunes target VFO');
      assertEqual(tunes[0].rx, 'A', 'Tuned VFO is RX A');
      assertEqual(tunes[0].hz, 14085500, 'CW center click snaps to freqHz - cwPitchHz');
      assertEqual(lastClickFreqHz, 14085500, 'Last click frequency recorded');

      // Drag > DRAG_THRESHOLD_PX (5px) starting on the edge edits filter without tuning VFO
      listeners.pointerdown({
        type: 'pointerdown',
        pointerId: 2,
        pointerType: 'mouse',
        button: 0,
        clientX: 563,
        clientY: 100,
        shiftKey: false,
        altKey: false,
      });
      listeners.pointermove({
        type: 'pointermove',
        pointerId: 2,
        pointerType: 'mouse',
        button: 0,
        clientX: 590,
        clientY: 100,
        shiftKey: false,
        altKey: false,
      });
      listeners.pointerup({
        type: 'pointerup',
        pointerId: 2,
        pointerType: 'mouse',
        button: 0,
        clientX: 590,
        clientY: 100,
        shiftKey: false,
        altKey: false,
      });

      assertEqual(tunes.length, 1, 'Edge drag (>5px) does not tune VFO');
      assert(filterEdits.length >= 1, 'Edge drag (>5px) applies filter edit');
    } finally {
      interaction.destroy();
    }
  });

  // 15. Wave 2: Global #SCL/#WBS/#AR, #FXT, #ARM before manual #REF, and #HDSM/#SPM gate
  test('Wave 2: global #SCL/#WBS/#AR, #FXT, #ARM before #REF, and RxOnlyGate #HDSM/#SPM', () => {
    const K4 = globalThis.K4;

    assertEqual(K4.CatCodec.builders.panScale(50), '#SCL50;', '1-arg global panScale');
    assertEqual(K4.CatCodec.builders.panScale('B', 60), '#SCL60;', '2-arg compat panScale strips $');
    assertEqual(K4.CatCodec.builders.wfBlack(11), '#WBS11;', '1-arg global wfBlack');
    assertEqual(K4.CatCodec.builders.wfBlack('B', 14), '#WBS14;', '2-arg compat wfBlack strips $');
    assertEqual(K4.CatCodec.builders.autoRef(true), '#ARA;', '1-arg global autoRef ON');
    assertEqual(K4.CatCodec.builders.autoRef('B', false), '#ARM;', '2-arg compat autoRef OFF strips $');
    assertEqual(K4.CatCodec.builders.autoRefOneShot(), '#AR1;', 'builder autoRefOneShot');

    const fxt = K4.CatCodec.parseCommand('#FXT1;');
    assertEqual(fxt && fxt.kind, 'fixedTune', '#FXT1 kind');
    assertEqual(fxt && fxt.fixedTune, true, '#FXT1 fixedTune true');

    const state = new K4.RadioState();
    assertEqual(state.getSnapshot().rxA.panRefDbm, -110, 'Default rxA panRefDbm is -110');
    assertEqual(state.getSnapshot().rxB.panRefDbm, -110, 'Default rxB panRefDbm is -110');

    for (const frame of K4.CatCodec.splitFrames('#SCL50;#WBS11;#ARA;#FXT1;OMAP;')) {
      const p = K4.CatCodec.parseCommand(frame);
      if (p) state.applyParsedCat(p);
    }
    let snap = state.getSnapshot();
    assertEqual(snap.rxA.panScaleDb, 50, 'Global #SCL50 updates rxA.panScaleDb');
    assertEqual(snap.rxB.panScaleDb, 50, 'Global #SCL50 updates rxB.panScaleDb');
    assertEqual(snap.rxA.wfBlack, 11, 'Global #WBS11 updates rxA.wfBlack');
    assertEqual(snap.rxB.wfBlack, 11, 'Global #WBS11 updates rxB.wfBlack');
    assertEqual(snap.rxA.autoRef, true, 'Global #ARA updates rxA.autoRef');
    assertEqual(snap.rxB.autoRef, true, 'Global #ARA updates rxB.autoRef');
    assertEqual(snap.fixedTune, true, '#FXT1 sets fixedTune true');
    assertEqual(snap.hasSubRx, false, 'OMAP clears hasSubRx');
    assertEqual(snap.optionModules, 'AP', 'OMAP stores optionModules');

    state.applyParsedCat(K4.CatCodec.parseCommand('OMAPS;'));
    assertEqual(state.getSnapshot().hasSubRx, true, 'OMAPS sets hasSubRx true');

    const client = new K4.Client({ state });
    try {
      const refWhileAuto = client.setDisplay('A', { panRefDbm: -108 });
      assertEqual(refWhileAuto.sanitized, '#ARM;#REF-108;', 'Manual #REF while Auto-Ref active prepends #ARM;');
      snap = state.getSnapshot();
      assertEqual(snap.rxA.autoRef, false, 'Manual #REF clears rxA.autoRef');
      assertEqual(snap.rxB.autoRef, false, 'Manual #REF clears rxB.autoRef');

      assertEqual(
        client.setDisplay('A', { autoRef: true }).sanitized,
        '#ARA;#AR1;#REF;#REF$;',
        'autoRef:true sends #ARA;#AR1;#REF;#REF$;'
      );
      assertEqual(
        client.setDisplay('A', { autoRef: false }).sanitized,
        '#ARM;#REF;#REF$;',
        'autoRef:false sends #ARM;#REF;#REF$;'
      );
      assertEqual(
        client.applyAutoRefNow().sanitized,
        '#AR1;#REF;#REF$;',
        'applyAutoRefNow sends #AR1;#REF;#REF$;'
      );
      assertEqual(
        client.setDisplay('A', { miniPan: true }).sanitized,
        '#MP1;#MP;',
        'miniPan A sends #MP1;#MP;'
      );
      assertEqual(
        client.setDisplay('B', { miniPan: true }).sanitized,
        '#MP$1;#MP$;',
        'miniPan B sends #MP$1;#MP$;'
      );
    } finally {
      client._stopKeepalive();
    }

    const gate = new K4.RxOnlyGate('rx-only');
    const allowRes = gate.inspectCat('#HDSM1;#SPM0;#AR1;#FXT1;TD201;TB;');
    assertDeepEqual(allowRes.blocked, [], 'RxOnlyGate allows #HDSM, #SPM, #AR1, #FXT, TD, TB');
    assertEqual(allowRes.allowed.length, 6, 'All 6 Wave 2 commands allowed');
    const blockRes = gate.inspectCat('#TX1;#CAL1;');
    assertEqual(blockRes.allowed.length, 0, 'RxOnlyGate still blocks #TX1 and #CAL1');
  });

  // 16. Wave 2: Single-Pan dispRx routing, pinch/wheel hit.paneRx, Mini-Pan non-flicker, and k4 LUT
  test('Wave 2: Single-Pan dispRx routing, Mini-Pan non-flicker, and k4 LUT', () => {
    const K4 = globalThis.K4;

    assertEqual(K4.CatCodec.resolveDisplayRx({ dualPanMode: 0 }, 'B'), 'A', 'Single-Pan Main resolves B->A');
    assertEqual(K4.CatCodec.resolveDisplayRx({ dualPanMode: 1 }, 'A'), 'B', 'Single-Pan Sub resolves A->B');
    assertEqual(K4.CatCodec.resolveDisplayRx({ dualPanMode: 2 }, 'B'), 'B', 'Dual-Pan preserves targetRx B');

    // Interaction: wheel span zoom & pinch must target hit.paneRx even if targetRx is B
    const listeners = {};
    const surface = {
      style: {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 320 }),
      addEventListener: (t, fn) => { listeners[t] = fn; },
      removeEventListener: (t, fn) => { if (listeners[t] === fn) delete listeners[t]; },
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
    };
    const spanCalls = [];
    const snapshot = {
      cwPitchHz: 500,
      dualPanMode: 0,
      subRxEnabled: true,
      rxA: { freqHz: 14074000, mode: 2, bwHz: 2400, ifShiftHz: 1500, panCenterHz: 14074000, panSpanHz: 48000, stepHz: 100 },
      rxB: { freqHz: 14025000, mode: 3, bwHz: 500, ifShiftHz: 500, panCenterHz: 14025000, panSpanHz: 96000, stepHz: 100 },
    };
    const viewStub = {
      getTargetRx: () => 'B',
      getFrameState: () => ({ snapshot, dualPanMode: 0, panes: { A: { panCenterHz: 14074000, userSpanHz: 48000 } } }),
      setHoverState: () => {},
      setLastClickFreqHz: () => {},
    };
    const rendererStub = {
      getLayouts: () => [{ rx: 'A', paneRect: { x: 0, y: 0, w: 800, h: 320 }, specRect: { x: 0, y: 0, w: 800, h: 180 }, axisRect: { x: 0, y: 180, w: 800, h: 24 } }],
    };
    const interaction = new K4.PanadapterInteraction({
      surface,
      renderer: rendererStub,
      view: viewStub,
      state: { getSnapshot: () => snapshot },
      client: { setDisplay: (rx, patch) => spanCalls.push({ rx, patch }) },
    });
    try {
      listeners.wheel({
        preventDefault: () => {},
        clientX: 400,
        clientY: 100,
        deltaX: 0,
        deltaY: -100,
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      });
      assertEqual(spanCalls.length, 1, 'ctrl+wheel emits setDisplay');
      assertEqual(spanCalls[0].rx, 'A', 'ctrl+wheel zooms visible pane A even when targetRx is B');

      listeners.pointerdown({ type: 'pointerdown', pointerId: 11, pointerType: 'touch', button: 0, clientX: 300, clientY: 100 });
      listeners.pointerdown({ type: 'pointerdown', pointerId: 12, pointerType: 'touch', button: 0, clientX: 500, clientY: 100 });
      listeners.pointermove({ type: 'pointermove', pointerId: 12, pointerType: 'touch', button: 0, clientX: 700, clientY: 100 });
      listeners.pointerup({ type: 'pointerup', pointerId: 11, pointerType: 'touch', button: 0, clientX: 300, clientY: 100 });
      listeners.pointerup({ type: 'pointerup', pointerId: 12, pointerType: 'touch', button: 0, clientX: 700, clientY: 100 });
      assert(spanCalls.length >= 2 && spanCalls[spanCalls.length - 1].rx === 'A', 'Pinch zooms visible pane A even when targetRx is B');
    } finally {
      interaction.destroy();
    }

    // Mini-Pan non-flicker gating
    const host = document.createElement('div');
    host.style.width = '640px';
    host.style.height = '320px';
    document.body.appendChild(host);
    const mpState = new K4.RadioState();
    const view = new K4.PanadapterView({ container: host, state: mpState, renderer: '2d' });
    try {
      const mpPktA = { type: 3, rx: 'A', centerFreqHz: 14074000, spanKHz: 10, bins: new Uint8Array([20, 40, 60, 80]) };
      view.pushMiniPanPacket(mpPktA);
      view._renderNow(false);
      assertEqual(view.getMetrics().miniPanActive, false, '0x03 packets do not activate Mini-Pan when #MP0');
      assertEqual(view.getFrameState().miniPan.active, false, 'FrameState miniPan.active stays false when #MP0');
      const mpBox = host.querySelector('.k4-minipan-box');
      assertEqual(mpBox && mpBox.style.display, 'none', 'Mini-Pan canvas stays hidden when #MP0');

      mpState.applyParsedCat(K4.CatCodec.parseCommand('#MP1;'));
      view._renderNow(false);
      assertEqual(view.getMetrics().miniPanActive, true, 'Mini-Pan activates when #MP1');
      assertEqual(view.getFrameState().miniPan.dbmBins.length, 4, 'Buffered 0x03 bins shown immediately on #MP1');
      assert(mpBox && mpBox.style.display !== 'none', 'Mini-Pan canvas becomes visible on #MP1');

      for (const f of K4.CatCodec.splitFrames('#MP0;#MP$1;')) {
        mpState.applyParsedCat(K4.CatCodec.parseCommand(f));
      }
      assertEqual(view.getMetrics().miniPanActive, false, 'Mini-Pan B gated when subRxEnabled=false');
      for (const f of K4.CatCodec.splitFrames('SB1;#MP$-1;')) {
        mpState.applyParsedCat(K4.CatCodec.parseCommand(f));
      }
      assertEqual(view.getMetrics().miniPanActive, false, 'Mini-Pan B gated when #MP$-1');
    } finally {
      view.destroy();
      host.remove();
    }

    // K4 Classic LUT
    assert(K4.WaterfallLuts.list().includes('k4'), 'k4 LUT registered');
    assertEqual(K4.WaterfallLuts.DEFAULT, 'obsidian', 'Obsidian remains default LUT');
    assertEqual(K4.WaterfallLuts.LABELS.k4, 'K4 Classic', 'k4 LUT label is K4 Classic');
    const k4Lut = K4.WaterfallLuts.get('k4');
    assertEqual(k4Lut[0], 9, 'k4 LUT index 0 R=9');
    assertEqual(k4Lut[1], 11, 'k4 LUT index 0 G=11');
    assertEqual(k4Lut[2], 16, 'k4 LUT index 0 B=16');
    assertEqual(k4Lut[255 * 4], 255, 'k4 LUT top bin R=255');
    assertEqual(k4Lut[255 * 4 + 1], 0, 'k4 LUT top bin G=0');
  });

  // 17. Wave 2: TD/TD$ text decode, empty TB000, conditional TB polling, and InspectorPanels dispRx/OM
  test('Wave 2: TD/TD$ text decode, TB000 ignore, conditional TB polling, and InspectorPanels', () => {
    const K4 = globalThis.K4;

    const tdA = K4.CatCodec.parseCommand('TD020;');
    assertEqual(tdA && tdA.kind, 'textDecode', 'TD020 kind');
    assertEqual(tdA && tdA.mode, 0, 'TD020 mode 0');
    assertEqual(tdA && tdA.threshold, 2, 'TD020 threshold 2');
    assertEqual(tdA && tdA.lines, 0, 'TD020 lines 0');
    assertEqual(tdA && tdA.enabled, false, 'TD020 enabled false');

    const tdB = K4.CatCodec.parseCommand('TD$201;');
    assertEqual(tdB && tdB.rx, 'B', 'TD$201 rx B');
    assertEqual(tdB && tdB.mode, 2, 'TD$201 mode 2');
    assertEqual(tdB && tdB.enabled, true, 'TD$201 enabled true');

    const state = new K4.RadioState();
    for (const cmd of ['TD020;', 'TD$201;', 'TB000;', 'TB$000;']) {
      state.applyParsedCat(K4.CatCodec.parseCommand(cmd));
    }
    const snap = state.getSnapshot();
    assertEqual(snap.decodedText.length, 0, 'Empty TB000;/TB$000; do not append decodedText');
    assertEqual(snap.rxB.textDecodeEnabled, true, 'rxB.textDecodeEnabled true');

    assertEqual(K4.CatCodec.describeTextDecode({ mode: 3, dataSubMode: 0 }).supported, true, 'CW supports decode');
    assertEqual(K4.CatCodec.describeTextDecode({ mode: 7, dataSubMode: 0 }).thresholdSupported, true, 'CW-R supports threshold');
    assertEqual(K4.CatCodec.describeTextDecode({ mode: 6, dataSubMode: 2 }).supported, true, 'FSK-D supports decode');
    assertEqual(K4.CatCodec.describeTextDecode({ mode: 9, dataSubMode: 3 }).supported, true, 'PSK-D supports decode');
    assertEqual(K4.CatCodec.describeTextDecode({ mode: 6, dataSubMode: 0 }).supported, false, 'DATA-A disables decode (ER12 on HW)');
    assertEqual(K4.CatCodec.describeTextDecode({ mode: 2, dataSubMode: 0 }).supported, false, 'USB disables decode');

    const sentFrames = [];
    const client = new K4.Client({ state });
    try {
      client._ws = { readyState: 1, send: (pkt) => sentFrames.push(pkt) };
      state.applyParsedCat(K4.CatCodec.parseCommand('TD$020;'));
      assertEqual(client._tbPollTimer, null, 'No TB poll timer when TD=0 on both RX');

      const resOn = client.setTextDecode('A', { mode: 2, threshold: 3, lines: 1 });
      assertEqual(resOn.sanitized, 'TD231;TD;TB;', 'setTextDecode A sends TD231;TD;TB;');
      assert(client._tbPollTimer !== null, 'Enabling TD starts 350ms TB poll timer');

      const resOff = client.setTextDecode('A', { mode: 0 });
      assertEqual(resOff.sanitized, 'TD030;TD;TB;', 'setTextDecode OFF preserves threshold & sets mode 0');
      assertEqual(client._tbPollTimer, null, 'Disabling TD stops TB poll timer');

      client.setTextDecode('B', { mode: 1 });
      assert(client._tbPollTimer !== null, 'Enabling TD$ starts TB poll timer');
      state.applyParsedCat(K4.CatCodec.parseCommand('TD$000;'));
      assertEqual(client._tbPollTimer, null, 'Incoming TD$000 stops TB poll timer');
    } finally {
      client._ws = null;
      client._stopKeepalive();
    }

    // InspectorPanels dispRx & OM hasSubRx checks
    const drawer = document.createElement('div');
    const mobileNav = document.createElement('div');
    const sheet = document.createElement('div');
    document.body.appendChild(drawer);
    document.body.appendChild(mobileNav);
    document.body.appendChild(sheet);
    const inspCalls = [];
    const inspState = new K4.RadioState();
    for (const c of ['OMAP;', '#SPN24000;', '#SPN$96000;', '#REF-112;', '#REF$-95;']) {
      inspState.applyParsedCat(K4.CatCodec.parseCommand(c));
    }
    const inspector = new K4.InspectorPanels({
      drawerEl: drawer,
      mobileNavEl: mobileNav,
      mobileSheetEl: sheet,
      state: inspState,
      client: { setDisplay: (rx, patch) => inspCalls.push({ rx, patch }) },
      gate: new K4.RxOnlyGate('rx-only'),
      getTargetRx: () => 'B',
      getPalette: () => 'obsidian',
      getPeakHold: () => false,
    });
    try {
      inspector.selectDesktopTab('band-mode');
      let s = inspState.getSnapshot();
      inspector.update(s);
      assertEqual(inspector._refs.divSwitch.row.hidden, true, 'Diversity RX hidden when OM lacks S');
      assertEqual(inspector._refs.divSwitch.btn.disabled, true, 'Diversity RX disabled when OM lacks S');

      inspector.selectDesktopTab('display');
      assertEqual(inspector._refs.dispBadge.textContent, 'PAN A', 'Single-Pan Main shows PAN A badge even when targetRx=B');
      assertEqual(inspector._refs.dpmBtns[1].disabled, false, '1x Sub (B) remains enabled on base K4 when OM lacks S');
      assertEqual(inspector._refs.dpmBtns[2].disabled, false, '2x Dual remains enabled on base K4 when OM lacks S');
      assert(inspector._refs.refSlider.row.textContent.includes('-112 dBm'), 'Spectrum Geometry shows PAN A #REF (-112), not B (-95)');
      inspector._refs.spanBtns[0].btn.click();
      assertEqual(inspCalls[0].rx, 'A', 'Span preset button routes to dispRx A');

      for (const c of ['OMAPS;', '#DPM1;']) {
        inspState.applyParsedCat(K4.CatCodec.parseCommand(c));
      }
      s = inspState.getSnapshot();
      inspector.update(s);
      assertEqual(inspector._refs.dpmBtns[1].disabled, false, '1x Sub (B) enabled when OM includes S');
      assertEqual(inspector._refs.dispBadge.textContent, 'PAN B', 'Single-Pan Sub (#DPM1) shows PAN B badge');
      inspector._refs.spanBtns[0].btn.click();
      assertEqual(inspCalls[1].rx, 'B', 'Span preset button routes to dispRx B in #DPM1');

      inspector.selectDesktopTab('band-mode');
      assertEqual(inspector._refs.divSwitch.row.hidden, false, 'Diversity RX visible after switching to Band & Mode tab when OM includes S');
    } finally {
      drawer.remove();
      mobileNav.remove();
      sheet.remove();
    }
  });

  // 18. Item 1 & 2 CAT codecs, RxOnlyGate SI*, RadioState telemetry, and Client helpers
  test('18. Item 1 & 2 CatCodec, RxOnlyGate SI*, RadioState telemetry, and Client helpers', () => {
    const K4 = globalThis.K4;
    const b = K4.CatCodec.builders;
    assertEqual(b.panFps(15), '#FPS15;', 'builder panFps');
    assertEqual(b.displayMode(0), '#DSM0;', 'builder displayMode 0');
    assertEqual(b.displayMode(1), '#DSM1;', 'builder displayMode 1');
    assertEqual(b.waterfallHeight(40), '#WFH040;', 'builder waterfallHeight');
    assertEqual(b.panNb('A', 2), '#NB2;', 'builder panNb A Auto');
    assertEqual(b.panNbLevel('B', 7), '#NBL$7;', 'builder panNbLevel B');
    assertEqual(b.ritClear('B'), 'RC$;', 'builder ritClear B');
    assertEqual(b.systemInfoSub('FP', true), 'SIFP1;', 'builder systemInfoSub');

    const gate = new K4.RxOnlyGate('rx-only');
    assertEqual(gate.inspectCat('SIFP1;SIRF1;SIDA1;').blocked.length, 0, 'SI* sub commands allowed in rx-only');
    assertEqual(gate.inspectCat('XT1;').blocked.length, 1, 'XT1 remains blocked in rx-only');

    const state = new K4.RadioState();
    const batch =
      '#FPS12;#DSM0;#WFH025;#NB2;#NBL09;OV11;' +
      'SIFPVS:13.80,IS:1.08,TF:34.2;SICPT1:39.0,T2:37.5,T4:38.2;SIRFPT:38.5,LT:36.0;SIDAT:31.2;';
    const frames = K4.CatCodec.splitFrames(batch);
    for (const f of frames) {
      const parsed = K4.CatCodec.parseCommand(f);
      if (parsed) state.applyParsedCat(parsed);
    }
    const snap = state.getSnapshot();
    assertEqual(snap.panFps, 12, 'RadioState panFps');
    assertEqual(snap.displayMode, 0, 'RadioState displayMode');
    assertEqual(snap.waterfallHeightPct, 25, 'RadioState waterfallHeightPct');
    assertEqual(snap.rxA.panNbMode, 2, 'RadioState rxA panNbMode');
    assertEqual(snap.rxA.panNbLevel, 9, 'RadioState rxA panNbLevel');
    assertEqual(snap.rxA.adcOverflow, true, 'RadioState rxA adcOverflow');
    assertEqual(snap.rxA.cor, true, 'RadioState rxA cor');
    assertApprox(snap.telemetry.supplyVolts, 13.8, 0.05, 'RadioState telemetry VS');
    assertApprox(snap.telemetry.supplyAmps, 1.08, 0.02, 'RadioState telemetry IS');
    assertApprox(snap.telemetry.fpTempC, 34.2, 0.1, 'RadioState telemetry fpTempC');
    assertApprox(snap.telemetry.paTempC, 38.5, 0.1, 'RadioState telemetry paTempC');
    assertApprox(snap.telemetry.lpaTempC, 36.0, 0.1, 'RadioState telemetry lpaTempC');
    assertApprox(snap.telemetry.cpuTempC, 39.0, 0.1, 'RadioState telemetry cpuTempC');
    assertApprox(snap.telemetry.dapTempC, 31.2, 0.1, 'RadioState telemetry dapTempC');

    const sent = [];
    const client = new K4.Client({ state, gate });
    client.sendCat = (cmd) => {
      sent.push(cmd);
      return true;
    };
    client.setRit('A', { on: true, offsetHz: -120 });
    client.clearRit('B');
    client.setApf('A', { on: true, bwIdx: 2 });
    client.setSquelch('B', 15);
    client.setDiversity(true);
    client.setDisplay('A', { panFrozen: true, panFps: 15, displayMode: 0, waterfallHeightPct: 35, panNbMode: 1, panNbLevel: 6 });

    const joined = sent.join('');
    assert(joined.includes('RT1;'), 'setRit sends RT1');
    assert(joined.includes('RO-0120;'), 'setRit sends RO-0120');
    assert(joined.includes('RC$;'), 'clearRit sends RC$');
    assert(joined.includes('AP1;') || joined.includes('AP12;'), 'setApf sends AP');
    assert(joined.includes('SQ$015;'), 'setSquelch sends SQ$015');
    assert(joined.includes('DV1;'), 'setDiversity sends DV1');
    assert(joined.includes('#FRZ1;'), 'setDisplay sends #FRZ1');
    assert(joined.includes('#FPS15;'), 'setDisplay sends #FPS15');
    assert(joined.includes('#DSM0;'), 'setDisplay sends #DSM0');
    assert(joined.includes('#WFH035;'), 'setDisplay sends #WFH035');
    assert(joined.includes('#NB1;'), 'setDisplay sends #NB1');
    assert(joined.includes('#NBL6;') || joined.includes('#NBL06;'), 'setDisplay sends #NBL6');
  });

  // 19. Panadapter layouts (#DSM0, #WFH) and #FRZ1 freeze gating
  test('19. computePaneLayouts honors #DSM and #WFH, and PanadapterView honors #FRZ', () => {
    const K4 = globalThis.K4;
    const specOnly = K4._computePanLayouts(1000, 600, 0, 42, { displayMode: 0, waterfallHeightPct: 60 });
    assertEqual(specOnly[0].wfRect.h, 0, '#DSM0 sets waterfall height to 0');
    assert(specOnly[0].specRect.h > 450, '#DSM0 expands spectrum height');

    const shortWf = K4._computePanLayouts(1000, 600, 0, 42, { displayMode: 1, waterfallHeightPct: 25 });
    const tallWf = K4._computePanLayouts(1000, 600, 0, 42, { displayMode: 1, waterfallHeightPct: 75 });
    assert(tallWf[0].wfRect.h > shortWf[0].wfRect.h * 2, '#WFH scales waterfall height split');

    const state = new K4.RadioState();
    const container = document.createElement('div');
    container.style.width = '640px';
    container.style.height = '320px';
    document.body.appendChild(container);
    let view = null;
    try {
      view = new K4.PanadapterView({ container, state });
      const pkt = {
        rx: 'A',
        bins: new Uint8Array(128).fill(80),
        sampleRateKHz: 48,
        centerFreqHz: 7074000,
        noiseFloorDbm: -128,
      };
      state.update({ panFrozen: true }, 'panFrozen');
      view.pushPanPacket(pkt);
      const frozenReady = Boolean(view._panes && view._panes.A && view._panes.A.binsReady);

      state.update({ panFrozen: false }, 'panFrozen');
      view.pushPanPacket(pkt);
      const liveReady = Boolean(view._panes && view._panes.A && view._panes.A.binsReady);
      assertEqual(frozenReady, false, '#FRZ1 drops incoming pan packets');
      assertEqual(liveReady, true, '#FRZ0 accepts incoming pan packets');
    } finally {
      if (view && typeof view.destroy === 'function') view.destroy();
      container.remove();
    }
  });

  // 20. AudioEngine AF Scope FFT + WAV PCM16 Recorder + K4.BookmarkStore
  test('20. AudioEngine getAfSpectrum, WAV PCM16 recorder, and BookmarkStore CRUD', () => {
    const K4 = globalThis.K4;

    // 1. K4.encodeWavPcm16 RIFF header & byte length check
    const chunk = new Int16Array(1200 * 2);
    const wavBytes = K4.encodeWavPcm16([chunk], 1200, 12000, 2);
    assertEqual(wavBytes.byteLength, 44 + 1200 * 4, 'WAV size = 44 + 4800 bytes');
    const dv = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    const wave = String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11));
    assertEqual(magic, 'RIFF', 'WAV RIFF header');
    assertEqual(wave, 'WAVE', 'WAV WAVE format');
    assertEqual(dv.getUint16(22, true), 2, 'WAV 2 channels');
    assertEqual(dv.getUint32(24, true), 12000, 'WAV 12 kHz sample rate');
    assertEqual(dv.getUint16(34, true), 16, 'WAV 16-bit PCM');

    // 2. AudioEngine 700 Hz FFT peak & stereo recording without AudioContext resume
    const state = new K4.RadioState();
    const engine = new K4.AudioEngine({ state });
    try {
      engine.startRecording({ rx: 'A', freqHz: 7074000 });
      const framesPerPkt = 240;
      let sampleIdx = 0;
      for (let p = 0; p < 6; p++) {
        const buf = new ArrayBuffer(framesPerPkt * 4);
        const view = new DataView(buf);
        for (let i = 0; i < framesPerPkt; i++) {
          const s = Math.round(16000 * Math.sin((2 * Math.PI * 700 * sampleIdx) / 12000));
          view.setInt16(i * 4, s, true);
          view.setInt16(i * 4 + 2, s, true);
          sampleIdx++;
        }
        engine.pushPacket({ seq: p, encodeMode: 1, dataView: view, frameCount: framesPerPkt });
      }

      const spec = engine.getAfSpectrum(3200);
      assert(spec && spec.binsDb && spec.binsDb.length > 20, 'getAfSpectrum returns binsDb');
      let maxIdx = 0;
      let maxVal = -Infinity;
      for (let i = 0; i < spec.binsDb.length; i++) {
        if (spec.binsDb[i] > maxVal) {
          maxVal = spec.binsDb[i];
          maxIdx = i;
        }
      }
      const peakHz = maxIdx * spec.binHz;
      assertApprox(peakHz, 700, 120, 'AF FFT peak detects 700 Hz synthetic tone');

      const rec = engine.stopRecording();
      const wavLen = rec && rec.wavBytes ? rec.wavBytes.byteLength : 0;
      assert(wavLen >= 44 + 6 * framesPerPkt * 4, 'stopRecording produced complete WAV');
      assert(rec.blob instanceof Blob, 'stopRecording produced Blob');
    } finally {
      engine.destroy();
    }

    // 3. K4.BookmarkStore CRUD
    K4.BookmarkStore.resetDefaults();
    const initialCount = K4.BookmarkStore.list().length;
    assert(initialCount >= 4, 'BookmarkStore seeds defaults');
    const added = K4.BookmarkStore.add({ label: 'Test Beacon', freqHz: 14100000, mode: 3, bwHz: 400 });
    assert(added && added.id, 'BookmarkStore.add returns bookmark with id');
    assertEqual(K4.BookmarkStore.list().length, initialCount + 1, 'BookmarkStore list grew by 1');
    K4.BookmarkStore.remove(added.id);
    assertEqual(K4.BookmarkStore.list().length, initialCount, 'BookmarkStore remove restores count');
    K4.BookmarkStore.resetDefaults();
  });

  // 21. K4 Panadapter mouse controls: Left=A/Right=B, Left-Only pane mode, middle-click RIT wheel, and LK1 lock guard
  test('21. K4 Panadapter mouse controls: Left=A/Right=B, Left-Only, RIT wheel, and LK1 lock guard', () => {
    const listeners = {};
    const surface = {
      style: {},
      clientWidth: 1000,
      clientHeight: 400,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 400 }),
      addEventListener: (t, fn) => { listeners[t] = fn; },
      removeEventListener: (t, fn) => { if (listeners[t] === fn) delete listeners[t]; },
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
    };

    const snapshot = {
      cwPitchHz: 500,
      dualPanMode: 1,
      subRxEnabled: true,
      rxA: { freqHz: 14074000, mode: 2, bwHz: 2400, ifShiftHz: 1500, panCenterHz: 14074000, panSpanHz: 48000, stepHz: 100, locked: false, ritOn: false, ritOffsetHz: 0 },
      rxB: { freqHz: 14025000, mode: 2, bwHz: 2400, ifShiftHz: 1500, panCenterHz: 14025000, panSpanHz: 48000, stepHz: 100, locked: false, ritOn: false, ritOffsetHz: 0 },
    };

    let targetRx = 'B';
    let mouseQsyMode = 'lr';
    let wheelRitMode = false;
    const tunes = [];
    const steps = [];
    const ritEdits = [];
    const notices = [];
    const selectedTargets = [];

    const view = {
      getTargetRx: () => targetRx,
      setTargetRx: (rx) => { targetRx = rx === 'B' ? 'B' : 'A'; },
      getMouseQsyMode: () => mouseQsyMode,
      getWheelRitMode: () => wheelRitMode,
      toggleWheelRitMode: () => { wheelRitMode = !wheelRitMode; },
      selectTargetFromMouse: (rx) => {
        wheelRitMode = false;
        targetRx = rx === 'B' ? 'B' : 'A';
        selectedTargets.push(targetRx);
      },
      notify: (msg, level) => notices.push({ msg, level }),
      getFrameState: () => ({
        snapshot,
        dualPanMode: snapshot.dualPanMode,
        panes: {
          A: { panCenterHz: snapshot.rxA.panCenterHz, userSpanHz: 48000 },
          B: { panCenterHz: snapshot.rxB.panCenterHz, userSpanHz: 48000 },
        },
      }),
      setHoverState: () => {},
      setLastClickFreqHz: () => {},
    };
    let paneRx = 'B';
    const renderer = {
      getLayouts: () => [
        { rx: paneRx, paneRect: { x: 0, y: 0, w: 1000, h: 400 }, specRect: { x: 0, y: 0, w: 1000, h: 200 }, axisRect: { x: 0, y: 200, w: 1000, h: 24 } },
      ],
    };
    const client = {
      tune: (rx, hz) => {
        tunes.push({ rx, hz });
        snapshot[rx === 'B' ? 'rxB' : 'rxA'].freqHz = hz;
      },
      stepFrequency: (rx, s, stepHz) => {
        steps.push({ rx, s, stepHz });
      },
      setRit: (rx, patch) => {
        ritEdits.push({ rx, patch });
        if (typeof patch.offsetHz === 'number') {
          snapshot[rx === 'B' ? 'rxB' : 'rxA'].ritOffsetHz = patch.offsetHz;
        }
        if (typeof patch.on === 'boolean') {
          snapshot[rx === 'B' ? 'rxB' : 'rxA'].ritOn = patch.on;
        }
      },
    };

    const interaction = new K4.PanadapterInteraction({
      surface,
      renderer,
      view,
      state: { getSnapshot: () => snapshot },
      client,
    });
    try {
      // 1) In default 'lr' mode, even if targetRx starts 'B' and paneRx is 'B' (#DPM1), left-click QSYs VFO A and switches target to 'A'
      listeners.pointerdown({ type: 'pointerdown', pointerId: 1, pointerType: 'mouse', button: 0, clientX: 600, clientY: 100, shiftKey: false, altKey: false });
      listeners.pointerup({ type: 'pointerup', pointerId: 1, pointerType: 'mouse', button: 0, clientX: 600, clientY: 100, shiftKey: false, altKey: false });
      assertEqual(tunes[tunes.length - 1].rx, 'A', 'Left-click in lr mode tunes VFO A despite targetRx=B and paneRx=B');
      assertEqual(targetRx, 'A', 'Left-click selects VFO A as wheel target');

      // Right-click QSYs VFO B and switches target to 'B'
      listeners.pointerdown({ type: 'pointerdown', pointerId: 2, pointerType: 'mouse', button: 2, clientX: 400, clientY: 100, shiftKey: false, altKey: false });
      assertEqual(tunes[tunes.length - 1].rx, 'B', 'Right-click in lr mode tunes VFO B');
      assertEqual(targetRx, 'B', 'Right-click selects VFO B as wheel target');

      // Normal wheel tunes targetRx ('B'), even if paneRx is switched to 'A'
      paneRx = 'A';
      listeners.wheel({ preventDefault: () => {}, clientX: 400, clientY: 100, deltaX: 0, deltaY: -100, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false });
      assertEqual(steps[steps.length - 1].rx, 'B', 'Wheel steps targetRx B rather than hovered paneRx A');

      // Middle-click toggles RIT wheel mode, and wheel adjusts RIT instead of frequency
      listeners.pointerdown({ type: 'pointerdown', pointerId: 3, pointerType: 'mouse', button: 1, clientX: 400, clientY: 100, preventDefault: () => {} });
      assertEqual(wheelRitMode, true, 'Middle-click enters RIT wheel mode');
      const stepsBeforeRit = steps.length;
      listeners.wheel({ preventDefault: () => {}, clientX: 400, clientY: 100, deltaX: 0, deltaY: -100, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false });
      assertEqual(steps.length, stepsBeforeRit, 'Wheel in RIT mode does not step VFO frequency');
      assertEqual(ritEdits[ritEdits.length - 1].rx, 'B', 'Wheel in RIT mode adjusts targetRx B RIT');
      assertEqual(ritEdits[ritEdits.length - 1].patch.offsetHz, 10, 'Wheel up adds +10 Hz RIT');

      // Shift+left-click in lr mode tunes VFO B (and exits RIT wheel mode)
      const tunesBeforeShift = tunes.length;
      listeners.pointerdown({ type: 'pointerdown', pointerId: 4, pointerType: 'mouse', button: 0, clientX: 550, clientY: 100, shiftKey: true, altKey: false });
      listeners.pointerup({ type: 'pointerup', pointerId: 4, pointerType: 'mouse', button: 0, clientX: 550, clientY: 100, shiftKey: true, altKey: false });
      assertEqual(tunes.length, tunesBeforeShift + 1, 'Shift+left-click triggers tune');
      assertEqual(tunes[tunes.length - 1].rx, 'B', 'Shift+left-click tunes VFO B');
      assertEqual(wheelRitMode, false, 'Click-to-QSY clears RIT wheel mode');

      // 2) In 'pane' (Left Only) mode, right-click does NOT QSY, while left-click QSYs clicked paneRx
      mouseQsyMode = 'pane';
      paneRx = 'A';
      const tunesBeforeRight = tunes.length;
      listeners.pointerdown({ type: 'pointerdown', pointerId: 5, pointerType: 'mouse', button: 2, clientX: 300, clientY: 100, shiftKey: false, altKey: false });
      assertEqual(tunes.length, tunesBeforeRight, 'Right-click in Left-Only mode does not QSY');
      paneRx = 'B';
      listeners.pointerdown({ type: 'pointerdown', pointerId: 6, pointerType: 'mouse', button: 0, clientX: 350, clientY: 100, shiftKey: false, altKey: false });
      listeners.pointerup({ type: 'pointerup', pointerId: 6, pointerType: 'mouse', button: 0, clientX: 350, clientY: 100, shiftKey: false, altKey: false });
      assertEqual(tunes[tunes.length - 1].rx, 'B', 'Left-click in Pan B tunes VFO B in Left-Only mode');

      // 3) LK1 Lock Guard in 'lr' mode: VFO A locked -> left-click blocks tune, selects A, notifies; right-click still tunes VFO B
      mouseQsyMode = 'lr';
      snapshot.rxA.locked = true;
      const tunesBeforeLocked = tunes.length;
      listeners.pointerdown({ type: 'pointerdown', pointerId: 7, pointerType: 'mouse', button: 0, clientX: 700, clientY: 100, shiftKey: false, altKey: false });
      listeners.pointerup({ type: 'pointerup', pointerId: 7, pointerType: 'mouse', button: 0, clientX: 700, clientY: 100, shiftKey: false, altKey: false });
      assertEqual(tunes.length, tunesBeforeLocked, 'LK1 blocks left-click panadapter QSY of VFO A');
      assertEqual(targetRx, 'A', 'Left-click still updates wheel target to A');
      assert(notices.length >= 1 && notices[notices.length - 1].level === 'warn', 'Locked VFO A click triggers warning toast');

      listeners.pointerdown({ type: 'pointerdown', pointerId: 8, pointerType: 'mouse', button: 2, clientX: 750, clientY: 100, shiftKey: false, altKey: false });
      assertEqual(tunes.length, tunesBeforeLocked + 1, 'Right-click still QSYs unlocked VFO B while VFO A is locked');
      assertEqual(tunes[tunes.length - 1].rx, 'B', 'Right-click tunes VFO B');
    } finally {
      interaction.destroy();
    }
  });

  test('22. Map-style cursor-anchored Ctrl+wheel & 2-finger pinch zoom preserve anchor RF without detuning VFO', () => {
    const host = document.createElement('div');
    host.style.width = '800px';
    host.style.height = '360px';
    document.body.appendChild(host);

    const state = new K4.RadioState();
    const spanCalls = [];
    const tunes = [];
    const cats = [];
    const client = {
      setDisplay: (rx, patch) => {
        spanCalls.push({ rx, patch });
        if (patch && Number.isFinite(patch.panSpanHz)) {
          state.updateRx(rx, { panSpanHz: patch.panSpanHz }, rx === 'B' ? 'rxB.display' : 'rxA.display');
        }
      },
      tune: (rx, hz) => tunes.push({ rx, hz }),
      sendCat: (cmd) => cats.push(cmd),
    };

    const view = new K4.PanadapterView({ container: host, state, client, renderer: '2d' });
    try {
      const bins = new Uint8Array(1024).fill(42);
      // Place a peak tone at +12 kHz from 14074000 Hz => 14086000 Hz (u = 0.75 of 48 kHz tier)
      bins[768] = 110;
      view.pushPanPacket({
        type: 2,
        rx: 'A',
        centerFreqHz: 14074000,
        sampleRateKHz: 48,
        bins,
      });
      view._renderNow(false);

      const surface = host.querySelector('.k4-pan-surface');
      const rect = surface.getBoundingClientRect();
      const layouts = view._renderer.getLayouts();
      const specRect = layouts[0].specRect;

      // 1) Ctrl+wheel zoom in at u = 0.75 (14,086,000 Hz)
      const anchorX = rect.left + specRect.x + specRect.w * 0.75;
      const anchorY = rect.top + specRect.y + specRect.h * 0.5;
      const preRf = K4.SpectrumGeometry.rfFreqFromX(
        specRect.x + specRect.w * 0.75,
        specRect.x,
        specRect.w,
        view.getFrameState().panes.A.panCenterHz,
        view.getFrameState().panes.A.userSpanHz
      );
      assert(Math.abs(preRf - 14086000) < 5, `Pre-zoom RF at u=0.75 is 14086000 (got ${preRf})`);

      surface.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -120,
          clientX: anchorX,
          clientY: anchorY,
        })
      );

      assertEqual(tunes.length, 0, 'Ctrl+wheel map zoom must NOT detune VFO A/B');
      assertEqual(state.getSnapshot().rxA.freqHz, 14074000, 'VFO A freqHz stays unchanged');
      assert(spanCalls.length >= 1, 'Ctrl+wheel requested updated #SPN coverage');

      const frameAfterWheel = view.getFrameState().panes.A;
      assert(frameAfterWheel.userSpanHz < 48000, `Expected zoomed span < 48000, got ${frameAfterWheel.userSpanHz}`);
      assert(view.isViewportOffset('A'), 'Off-center zoom marks viewport offset');

      const postRf = K4.SpectrumGeometry.rfFreqFromX(
        specRect.x + specRect.w * 0.75,
        specRect.x,
        specRect.w,
        frameAfterWheel.panCenterHz,
        frameAfterWheel.userSpanHz
      );
      assert(
        Math.abs(postRf - preRf) <= 30,
        `Anchor RF at cursor u=0.75 stayed pinned (before=${preRf}, after=${postRf})`
      );

      const sentSpan = spanCalls[spanCalls.length - 1].patch.panSpanHz;
      const neededSpan =
        frameAfterWheel.userSpanHz + 2 * Math.abs(frameAfterWheel.panCenterHz - 14074000);
      assert(
        sentSpan >= neededSpan - 2,
        `Requested #SPN (${sentSpan}) covers full offset viewport (>= ${neededSpan})`
      );

      // Verify async K4 #SPN echo preserves custom viewport
      state.applyParsedCat(K4.CatCodec.parseCommand(`#SPN${sentSpan};`));
      assertEqual(
        view.getVisibleSpanHz('A'),
        frameAfterWheel.userSpanHz,
        '#SPN echo preserves custom zoomed span'
      );
      assert(
        Math.abs(view.getFrameState().panes.A.panCenterHz - frameAfterWheel.panCenterHz) <= 1,
        '#SPN echo preserves custom off-center centerHz'
      );

      // Verify computeViewportCrop places the 14086000 Hz FFT bin (uTier = 768/1023) at uView ~ 0.75
      const crop = K4.SpectrumGeometry.computeViewportCrop(
        frameAfterWheel.panCenterHz,
        frameAfterWheel.userSpanHz,
        frameAfterWheel.streamCenterHz,
        48
      );
      const peakUView = (0.75 - crop.leftRatio) / crop.spanRatio;
      assert(
        Math.abs(peakUView - 0.75) < 0.01,
        `computeViewportCrop projects 14086000 Hz bin back to cursor u=0.75 (got ${peakUView.toFixed(4)})`
      );

      // 2) Two-finger touch pinch spread + simultaneous midpoint pan
      const midRfBeforePinch = K4.SpectrumGeometry.rfFreqFromX(
        specRect.x + specRect.w * 0.5,
        specRect.x,
        specRect.w,
        frameAfterWheel.panCenterHz,
        frameAfterWheel.userSpanHz
      );
      surface.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          pointerId: 31,
          pointerType: 'touch',
          clientX: rect.left + specRect.x + specRect.w * 0.375,
          clientY: anchorY,
        })
      );
      surface.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          pointerId: 32,
          pointerType: 'touch',
          clientX: rect.left + specRect.x + specRect.w * 0.625,
          clientY: anchorY,
        })
      );
      // Double spread (0.25 -> 0.50) and pan midpoint from u=0.50 -> u=0.65
      surface.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          pointerId: 31,
          pointerType: 'touch',
          clientX: rect.left + specRect.x + specRect.w * 0.4,
          clientY: anchorY,
        })
      );
      surface.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          pointerId: 32,
          pointerType: 'touch',
          clientX: rect.left + specRect.x + specRect.w * 0.9,
          clientY: anchorY,
        })
      );

      const frameAfterPinch = view.getFrameState().panes.A;
      assert(
        frameAfterPinch.userSpanHz < frameAfterWheel.userSpanHz,
        `2-finger pinch spread zooms further in (${frameAfterPinch.userSpanHz} < ${frameAfterWheel.userSpanHz})`
      );
      const rfAtMovedMid = K4.SpectrumGeometry.rfFreqFromX(
        specRect.x + specRect.w * 0.65,
        specRect.x,
        specRect.w,
        frameAfterPinch.panCenterHz,
        frameAfterPinch.userSpanHz
      );
      assert(
        Math.abs(rfAtMovedMid - midRfBeforePinch) <= 50,
        `Pinch tracks translated midpoint RF (expected=${midRfBeforePinch}, got=${rfAtMovedMid})`
      );
      surface.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          pointerId: 31,
          pointerType: 'touch',
          clientX: rect.left + specRect.x + specRect.w * 0.4,
          clientY: anchorY,
        })
      );
      surface.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          pointerId: 32,
          pointerType: 'touch',
          clientX: rect.left + specRect.x + specRect.w * 0.9,
          clientY: anchorY,
        })
      );
      assertEqual(tunes.length, 0, '2-finger pinch + pan never detunes VFO');

      // 3) External preset #SPN change (non-echo) clears custom viewport
      state.applyParsedCat(K4.CatCodec.parseCommand('#SPN72000;'));
      assertEqual(view.getVisibleSpanHz('A'), 72000, 'External #SPN72000 overrides custom zoom');
      assertEqual(view.isViewportOffset('A'), false, 'External #SPN re-centers viewport');

      // 4) Zoom again then resetViewport sends FC;
      view.applyMapZoom('A', { targetSpanHz: 18000, anchorFrac: 0.75 });
      assertEqual(view.isViewportOffset('A'), true, 'applyMapZoom off-center sets offset');
      view.resetViewport('A', { syncRadioSpan: true });
      assertEqual(view.isViewportOffset('A'), false, 'resetViewport clears offset');
      assertEqual(view.getMetrics().panCenterHz, 14074000, 'resetViewport returns center to stream center');
      assert(cats.includes('FC;'), 'resetViewport sends FC;');
    } finally {
      view.destroy();
      host.remove();
    }
  });

  // 23. BinaryPackets: encodeAudio + odd-offset parseAudio roundtrip
  test('BinaryPackets.encodeAudio & odd-offset parseAudio roundtrip', () => {
    const K4 = globalThis.K4;
    const frames = 240;
    const pcmBytes = new Uint8Array(frames * 4);
    const srcDv = new DataView(pcmBytes.buffer);
    for (let i = 0; i < frames; i++) {
      const l = ((i * 257) % 30000) - 15000;
      const r = -(((i * 193) % 28000) - 14000);
      srcDv.setInt16(i * 4, l, true);
      srcDv.setInt16(i * 4 + 2, r, true);
    }

    const encoded = K4.BinaryPackets.encodeAudio({
      seq: 0xab,
      encodeMode: 1,
      frameSamplesPerCh: frames,
      sampleRateCode: 0,
      audioBytes: pcmBytes,
    });
    assertEqual(encoded.byteLength, 7 + frames * 4, 'encoded 0x01 length');
    assertEqual(encoded[0], 0x01, 'header packet type 0x01');
    assertEqual(encoded[1], 0x01, 'header version 0x01');
    assertEqual(encoded[2], 0xab, 'header seq');
    assertEqual(encoded[3], 0x01, 'header encodeMode EM1');
    assertEqual(new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength).getUint16(4, true), frames, 'header frameSamplesPerCh');
    assertEqual(encoded[6], 0x00, 'header sampleRateCode 12kHz');

    // Place encoded packet at odd offsets (both u8.byteOffset=1 and u8.byteOffset+7=9)
    for (const offset of [1, 2, 3]) {
      const backing = new Uint8Array(offset + encoded.byteLength + 5);
      backing.set(encoded, offset);
      const subview = backing.subarray(offset, offset + encoded.byteLength);
      const parsed = K4.BinaryPackets.parse(subview);
      assert(parsed !== null, `parse(subview) at offset=${offset}`);
      assertEqual(parsed.type, 1, 'parsed.type');
      assertEqual(parsed.version, 1, 'parsed.version');
      assertEqual(parsed.seq, 0xab, 'parsed.seq');
      assertEqual(parsed.encodeMode, 1, 'parsed.encodeMode');
      assertEqual(parsed.frameSamplesPerCh, frames, 'parsed.frameSamplesPerCh');
      assertEqual(parsed.sampleRateCode, 0, 'parsed.sampleRateCode');
      assertEqual(parsed.sampleRate, 12000, 'parsed.sampleRate');
      assertEqual(parsed.data.byteLength, frames * 4, 'parsed.data.byteLength');
      assertEqual(parsed.dataView.byteOffset, offset + 7, 'parsed.dataView.byteOffset');
      assertEqual(parsed.dataView.getInt16(0, true), srcDv.getInt16(0, true), `sample 0L @ offset=${offset}`);
      assertEqual(parsed.dataView.getInt16(2, true), srcDv.getInt16(2, true), `sample 0R @ offset=${offset}`);
      assertEqual(parsed.dataView.getInt16((frames - 1) * 4, true), srcDv.getInt16((frames - 1) * 4, true), `sample lastL @ offset=${offset}`);
      assertEqual(parsed.dataView.getInt16((frames - 1) * 4 + 2, true), srcDv.getInt16((frames - 1) * 4 + 2, true), `sample lastR @ offset=${offset}`);
    }
  });

  // 24. CatCodec: TX, ATU, Voice, CW, Option Module & Sensor parsers & builders
  test('CatCodec parses & builds TX/ATU/Voice/CW/OM/SIRF/SIDU CAT commands', () => {
    const { parseCommand, splitFrames, builders } = globalThis.K4.CatCodec;

    // TX/RX/TQ/TQX/IN/TS
    assertDeepEqual(parseCommand('TX;'), { kind: 'txState', rx: null, txActive: true }, 'TX;');
    assertDeepEqual(parseCommand('RX;'), { kind: 'txState', rx: null, txActive: false }, 'RX;');
    assertDeepEqual(parseCommand('TQ1;'), { kind: 'txState', rx: null, txActive: true }, 'TQ1;');
    assertDeepEqual(parseCommand('TQX0;'), { kind: 'txState', rx: null, txActive: false }, 'TQX0;');
    assertDeepEqual(parseCommand('IN1;'), { kind: 'txInhibit', rx: null, txInhibit: true }, 'IN1;');
    assertDeepEqual(parseCommand('IN0;'), { kind: 'txInhibit', rx: null, txInhibit: false }, 'IN0;');
    assertDeepEqual(parseCommand('TS1;'), { kind: 'txTest', rx: null, txTestMode: true }, 'TS1;');
    assertEqual(builders.tx(), 'TX;', 'builders.tx');
    assertEqual(builders.rx(), 'RX;', 'builders.rx');
    assertEqual(builders.txQuery(true), 'TQX;', 'builders.txQuery(true)');
    assertEqual(builders.txQuery(false), 'TQ;', 'builders.txQuery(false)');
    assertEqual(builders.txInhibitQuery(), 'IN;', 'builders.txInhibitQuery');
    assertEqual(builders.txTest(true), 'TS1;', 'builders.txTest(true)');

    // IF: 38-char K4 D4 layout ([23]=rit, [24]=xit, [25]=' ', [28]=tx, [29]=mode, [32]=split) & compact fallback
    const ifD4 = parseCommand('IF00014074000     +015011 0012001001 ;');
    assertEqual(ifD4.kind, 'ifInfo', 'IF D4 kind');
    assertEqual(ifD4.freqHz, 14074000, 'IF D4 freqHz');
    assertEqual(ifD4.ritOn, true, 'IF D4 ritOn');
    assertEqual(ifD4.xitEnabled, true, 'IF D4 xitEnabled');
    assertEqual(ifD4.txActive, true, 'IF D4 txActive');
    assertEqual(ifD4.modeCode, 2, 'IF D4 modeCode USB');
    assertEqual(ifD4.splitEnabled, true, 'IF D4 splitEnabled');

    const ifCompact = parseCommand('IF00007074000     +0000001301;');
    assertEqual(ifCompact.kind, 'ifInfo', 'IF compact kind');
    assertEqual(ifCompact.freqHz, 7074000, 'IF compact freqHz');
    assertEqual(ifCompact.txActive, true, 'IF compact txActive');
    assertEqual(ifCompact.modeCode, 3, 'IF compact modeCode CW');
    assertEqual(ifCompact.splitEnabled, true, 'IF compact splitEnabled');

    // TM & PO disambiguation (0/1 toggles vs telemetry digits)
    assertDeepEqual(parseCommand('TM1;'), { kind: 'txMetersAuto', rx: null, enabled: true }, 'TM1;');
    assertDeepEqual(parseCommand('TM0;'), { kind: 'txMetersAuto', rx: null, enabled: false }, 'TM0;');
    const tm = parseCommand('TM004012055013;');
    assertEqual(tm.kind, 'txMeters', 'TM 12-digit kind');
    assertEqual(tm.alcBars, 4, 'TM alcBars');
    assertEqual(tm.compDb, 12, 'TM compDb');
    assertEqual(tm.fwdRaw, 55, 'TM fwdRaw');
    assertEqual(tm.swrTenths, 13, 'TM swrTenths');
    assertApprox(tm.swr, 1.3, 1e-6, 'TM swr');
    assertEqual(builders.txMeters(true), 'TM1;', 'builders.txMeters');

    assertDeepEqual(parseCommand('PO1;'), { kind: 'powerOutAuto', rx: null, enabled: true }, 'PO1;');
    assertDeepEqual(parseCommand('PO0;'), { kind: 'powerOutAuto', rx: null, enabled: false }, 'PO0;');
    const po = parseCommand('PO0255;');
    assertEqual(po.kind, 'powerOut', 'PO 4-digit kind');
    assertApprox(po.powerOutWatts, 25.5, 1e-6, 'PO tenths watts');
    assertEqual(builders.powerOutAuto(true), 'PO1;', 'builders.powerOutAuto');

    // PC & PCX L tenths vs H whole watts
    const pcL = parseCommand('PC055L;');
    assertApprox(pcL.powerWatts, 5.5, 1e-6, 'PC055L watts');
    assertEqual(pcL.powerRange, 'L', 'PC055L range');
    const pcH = parseCommand('PC085H;');
    assertEqual(pcH.powerWatts, 85, 'PC085H watts');
    assertEqual(pcH.powerRange, 'H', 'PC085H range');
    const pcxL = parseCommand('PCX100L;');
    assertApprox(pcxL.powerWatts, 10.0, 1e-6, 'PCX100L watts');
    assertEqual(pcxL.powerRange, 'L', 'PCX100L range');
    const pcxH = parseCommand('PCX100H;');
    assertEqual(pcxH.powerWatts, 100, 'PCX100H watts');
    assertEqual(pcxH.powerRange, 'H', 'PCX100H range');
    assertEqual(builders.power(5.5, 'L'), 'PC055L;', 'builders.power L');
    assertEqual(builders.power(55, 'H'), 'PC055H;', 'builders.power H');

    // AT, TU, AN, ACT, ACN, FT, AB, XT
    assertEqual(parseCommand('AT0;').atuMode, 0, 'AT0');
    assertEqual(parseCommand('AT2;').atuMode, 2, 'AT2');
    assertEqual(builders.atuMode(1), 'AT1;', 'builders.atuMode bypass');
    assertEqual(builders.atuMode(2), 'AT2;', 'builders.atuMode auto');
    assertDeepEqual(parseCommand('TU3;'), { kind: 'atuTune', rx: null, tuneState: 3, tuning: true }, 'TU3;');
    assertDeepEqual(parseCommand('TU0;'), { kind: 'atuTune', rx: null, tuneState: 0, tuning: false }, 'TU0;');
    assertEqual(builders.atuTune(3), 'TU3;', 'builders.atuTune(3)');
    assertEqual(builders.atuTune(4), 'TU4;', 'builders.atuTune(4)');
    assertEqual(builders.atuTune(0), 'TU0;', 'builders.atuTune(0)');
    assertEqual(parseCommand('AN2;').antenna, 2, 'AN2;');
    assertEqual(builders.txAntenna(3), 'AN3;', 'builders.txAntenna(3)');
    assertDeepEqual(parseCommand('ACT1101;'), { kind: 'txAntennaMask', rx: null, showAll: true, mask: [true, false, true] }, 'ACT1101;');
    assertEqual(builders.txAntennaMaskQuery(), 'ACT;', 'builders.txAntennaMaskQuery');
    assertDeepEqual(parseCommand('ACN2Dipole 40m ;'), { kind: 'antennaName', rx: null, port: 2, name: 'Dipole 40m' }, 'ACN2 mixed-case trimmed');
    assertEqual(builders.antennaName(2, 'HexBeam'), 'ACN2HexBeam;', 'builders.antennaName');
    assertEqual(parseCommand('FT1;').splitEnabled, true, 'FT1;');
    assertEqual(builders.split(true), 'FT1;', 'builders.split(true)');
    assertEqual(parseCommand('AB3;').mode, 3, 'AB3;');
    assertEqual(builders.vfoCopy(3), 'AB3;', 'builders.vfoCopy(3)');
    assertEqual(parseCommand('XT1;').xitEnabled, true, 'XT1;');
    assertEqual(builders.xit(true), 'XT1;', 'builders.xit(true)');

    // MG, CP, ML, MI, PB, KS, KP, KY (including mixed-case KY text)
    assertEqual(parseCommand('MG035;').micGain, 35, 'MG035;');
    assertEqual(builders.micGain(35), 'MG035;', 'builders.micGain');
    assertEqual(parseCommand('CP012;').compDbSet, 12, 'CP012;');
    assertEqual(builders.compLevel(12), 'CP012;', 'builders.compLevel');
    assertDeepEqual(parseCommand('ML1045;'), { kind: 'txMonitor', rx: null, channel: 1, level: 45 }, 'ML1045;');
    assertEqual(builders.txMonitor(1, 45), 'ML1045;', 'builders.txMonitor');
    assertEqual(parseCommand('MI2;').micInput, 2, 'MI2;');
    assertEqual(builders.micInput(2), 'MI2;', 'builders.micInput');
    assertDeepEqual(parseCommand('PB3;'), { kind: 'dvrPlayback', rx: null, slot: 3, playing: true }, 'PB3;');
    assertDeepEqual(parseCommand('PB0;'), { kind: 'dvrPlayback', rx: null, slot: 0, playing: false }, 'PB0;');
    assertEqual(builders.dvrPlay(3), 'PB3;', 'builders.dvrPlay');
    assertEqual(parseCommand('KS028;').wpm, 28, 'KS028;');
    assertEqual(builders.cwSpeed(28), 'KS028;', 'builders.cwSpeed');
    assertDeepEqual(parseCommand('KPBN115;'), { kind: 'keyerPaddle', rx: null, iambic: 'B', paddleOrder: 'N', weight: 115 }, 'KPBN115;');
    assertEqual(builders.keyerPaddle('B', 'N', 115), 'KPBN115;', 'builders.keyerPaddle');
    assertDeepEqual(parseCommand('KY1;'), { kind: 'keyerStatus', rx: null, bufferFull: true }, 'KY1;');
    assertDeepEqual(parseCommand('KY Cq Test De K4;'), { kind: 'keyerText', rx: null, mode: ' ', text: 'Cq Test De K4' }, 'KY mixed-case');
    assertDeepEqual(parseCommand('KYWHello K4;'), { kind: 'keyerText', rx: null, mode: 'W', text: 'Hello K4' }, 'KYW mixed-case');
    assertEqual(builders.keyerText('Cq De K4', ' '), 'KY Cq De K4;', 'builders.keyerText');
    assertEqual(builders.keyerAbort(), 'KY @;', 'builders.keyerAbort');

    // OM, SIRF, SIDU
    const om = parseCommand('OMAPSHL;');
    assertEqual(om.kind, 'optionModule', 'OM kind');
    assertEqual(om.hasAtu, true, 'OM hasAtu');
    assertEqual(om.hasKpa4, true, 'OM hasKpa4');
    assertEqual(om.hasSubRx, true, 'OM hasSubRx');
    assertEqual(om.hasHdr, true, 'OM hasHdr');
    assertEqual(om.hasLinearAmp, true, 'OM hasLinearAmp');

    const sirf = parseCommand('SIRFV8:8.0,V5:5.0,V27:27.1,LT:31.2,LM:0,PA:9.75,PM:0,PT:46.8;');
    assertEqual(sirf.kind, 'systemInfo', 'SIRF kind');
    assertEqual(sirf.module, 'RF', 'SIRF module');
    assertApprox(sirf.fields.LT, 31.2, 1e-6, 'SIRF LT');
    assertApprox(sirf.fields.PA, 9.75, 1e-6, 'SIRF PA');
    assertApprox(sirf.fields.PT, 46.8, 1e-6, 'SIRF PT');

    const sidu = parseCommand('SIDUV5:5.0,V3:3.3,T:34.2;');
    assertEqual(sidu.kind, 'systemInfo', 'SIDU kind');
    assertEqual(sidu.module, 'DU', 'SIDU module');
    assertApprox(sidu.fields.T, 34.2, 1e-6, 'SIDU T');

    // splitFrames preserves TX/TU tokens without breaking
    assertDeepEqual(splitFrames('TX;TM004000018011;RX;'), ['TX', 'TM004000018011', 'RX'], 'splitFrames TX batch');
  });

  // 25. RxOnlyGate: policy transitions, 0x01 TX audio gating, permanent blocklist, mixed-case KY
  test('RxOnlyGate policy transitions, 0x01 audio gating, permanent blocklist & mixed-case KY', () => {
    const gate = new globalThis.K4.RxOnlyGate();
    assertEqual(gate.getPolicy(), 'rx-only', 'default policy is rx-only');
    assertEqual(gate.isTxAudioAllowed(), false, 'default txAudioAllowed is false');

    // In rx-only, 0x01 audio is blocked even if setTxAudioAllowed(true) was attempted
    gate.setTxAudioAllowed(true);
    assertEqual(gate.inspectBinary(0x00), true, '0x00 CAT binary always allowed');
    assertEqual(gate.inspectBinary(0x01), false, '0x01 audio blocked in rx-only');

    // In rx-only, operational TX commands are blocked
    const rxBlocked = gate.inspectCat('TX;TU3;KY CQ;PC050L;PB1;FA00014074000;');
    assertDeepEqual(rxBlocked.allowed, ['FA00014074000;'], 'rx-only allows FA');
    assertDeepEqual(rxBlocked.blocked, ['TX;', 'TU3;', 'KY CQ;', 'PC050L;', 'PB1;'], 'rx-only blocks TX cmds');
    assertEqual(rxBlocked.sanitized, 'FA00014074000;', 'rx-only sanitized');

    // Transition to tx-enabled keeps txAudioAllowed=false until explicitly armed
    gate.setPolicy('tx-enabled');
    gate.setTxAudioAllowed(false);
    assertEqual(gate.getPolicy(), 'tx-enabled', 'policy switched to tx-enabled');
    assertEqual(gate.inspectBinary(0x01), false, '0x01 blocked while txAudioAllowed=false');

    gate.setTxAudioAllowed(true);
    assertEqual(gate.isTxAudioAllowed(), true, 'txAudioAllowed=true');
    assertEqual(gate.inspectBinary(0x01), true, '0x01 allowed when tx-enabled & txAudioAllowed');
    assertEqual(gate.inspectBinary(0x04), false, 'unknown binary 0x04 always blocked');

    // Operational TX commands + mixed-case KY / ACN preserved in tx-enabled
    const txRes = gate.inspectCat('tx;rx;TS1;TU3;AT2;AN2;PC050H;MG025;CP010;ML0020;MI1;KS024;KPAR110;PB1;FT1;AB3;XT1;DW0;TE+0+0;ky Cq Test De K4;acn2Dipole 40m;');
    assertEqual(txRes.blocked.length, 0, 'tx-enabled allows full operational TX set');
    assert(txRes.allowed.includes('KY Cq Test De K4;'), 'KY mixed-case preserved');
    assert(txRes.allowed.includes('ACN2Dipole 40m;'), 'ACN mixed-case preserved');
    assert(txRes.sanitized.includes('KY Cq Test De K4;'), 'KY mixed-case in sanitized');

    // Permanent destructive/admin blocklist MUST stay blocked even in tx-enabled
    const permCmds = ['EE0;', 'LB1;', 'WM0;', '#CAL1;', 'PS0;', 'RRP1;', 'EC1;', 'SW1;', 'DARM1;'];
    const permRes = gate.inspectCat('TX;' + permCmds.join('') + 'RX;');
    assertEqual(permRes.blocked.length, permCmds.length, 'all 9 permanent blocklist commands blocked in tx-enabled');
    assertDeepEqual(permRes.blocked, permCmds, 'exact permanent blocked list');
    assertEqual(permRes.sanitized, 'TX;RX;', 'destructive cmds stripped around TX;RX;');

    // Disarm back to rx-only clears txAudioAllowed and re-blocks TX
    gate.setPolicy('rx-only');
    assertEqual(gate.getPolicy(), 'rx-only', 'disarmed to rx-only');
    assertEqual(gate.isTxAudioAllowed(), false, 'disarm clears txAudioAllowed');
    assertEqual(gate.inspectBinary(0x01), false, '0x01 re-blocked after disarm');
    assertEqual(gate.inspectCat('TX;').blocked.length, 1, 'TX; re-blocked after disarm');

    // Client.setTxPosture('tx-test') uses native TS1; without altering PC, and disarming sends TS0; first
    const client = new globalThis.K4.Client();
    const wireFramer = new globalThis.K4.PacketFramer();
    const wireCats = [];
    client._ws = {
      readyState: 1,
      send(chunk) {
        const pkts = wireFramer.push(chunk);
        for (const p of pkts) {
          wireCats.push(globalThis.K4.BinaryPackets.parseCat(p).text);
        }
      },
    };
    const enterTest = client.setTxPosture('tx-test');
    assertEqual(enterTest.sent, true, 'tx-test posture sent CAT');
    assertEqual(wireCats[0], 'TS1;TM1;PO1;', 'tx-test emits TS1; without PC changes');
    assert(!wireCats.some((c) => /PC\d/.test(c)), 'tx-test never changes PC output power');

    client.setTxPosture('rx-only');
    assertEqual(client.gate.getPolicy(), 'rx-only', 'rx-only re-locks gate after tx-test');
    assertEqual(client.state.getSnapshot().txTestMode, false, 'rx-only clears txTestMode');
    assertEqual(wireCats[1], 'TS0;', 'leaving tx-test -> rx-only emits TS0; before locking gate');

    // Independent K4 [TEST] toggle while tx-armed preserves armed posture
    client.setTxPosture('tx-armed');
    assertEqual(wireCats[2], 'TS0;TM1;PO1;', 'tx-armed emits TS0;TM1;PO1;');
    client.setTxTest(true);
    assertEqual(client.getTxPosture(), 'tx-armed', 'setTxTest(true) preserves tx-armed');
    assertEqual(client.state.getSnapshot().txTestMode, true, 'setTxTest(true) enables txTestMode');
    assertEqual(wireCats[3], 'TS1;', 'setTxTest(true) while armed emits TS1;');
    client.setTxTest(false);
    assertEqual(client.getTxPosture(), 'tx-armed', 'setTxTest(false) preserves tx-armed');
    assertEqual(client.state.getSnapshot().txTestMode, false, 'setTxTest(false) clears txTestMode');
    assertEqual(wireCats[4], 'TS0;', 'setTxTest(false) while armed emits TS0;');

    // Passive rx-only client seeing remote TS1; must not overwrite hardware TS1; on disarm
    const countBeforePassive = wireCats.length;
    client.setTxPosture('rx-only');
    client.state.applyParsedCat(globalThis.K4.CatCodec.parseCommand('TS1;'));
    client.setTxPosture('rx-only');
    assertEqual(wireCats.length, countBeforePassive, 'passive rx-only client does not send TS0;');
  });

  // 26. RadioState: TX/ATU/sensor transitions (TM L/H scaling, TX->RX peakHold, SIFP/SIRF/SIDU, atuMatchedSwr)
  test('RadioState handles TM L/H scaling, TX->RX peakHold, sensors & atuMatchedSwr', () => {
    const state = new globalThis.K4.RadioState();
    const { parseCommand } = globalThis.K4.CatCodec;

    // TM scaling in L (tenths of watt) vs H (whole watts)
    state.applyParsedCat(parseCommand('PC055L;'));
    state.applyParsedCat(parseCommand('TX;'));
    state.applyParsedCat(parseCommand('TM003005045014;'));
    let snap = state.getSnapshot();
    assertEqual(snap.powerRange, 'L', 'powerRange L');
    assertApprox(snap.txMeters.fwdWatts, 4.5, 1e-6, 'TM L tenths W');
    assertApprox(snap.txMeters.swr, 1.4, 1e-6, 'TM swr');
    assertEqual(snap.txMeters.alcBars, 3, 'TM alcBars');
    assertEqual(snap.txMeters.compDb, 5, 'TM compDb');
    assertApprox(snap.txMeters.peakFwdWatts, 4.5, 1e-6, 'peakFwdWatts in L');
    assertApprox(snap.txMeters.peakSwr, 1.4, 1e-6, 'peakSwr in L');

    state.applyParsedCat(parseCommand('PC075H;'));
    state.applyParsedCat(parseCommand('TM005012075018;'));
    snap = state.getSnapshot();
    assertEqual(snap.powerRange, 'H', 'powerRange H');
    assertEqual(snap.txMeters.fwdWatts, 75, 'TM H integer W');
    assertApprox(snap.txMeters.swr, 1.8, 1e-6, 'TM H swr');
    assertEqual(snap.txMeters.peakFwdWatts, 75, 'peakFwdWatts updated in H');
    assertApprox(snap.txMeters.peakSwr, 1.8, 1e-6, 'peakSwr updated in H');

    // TX -> RX resets live TX meters while preserving peakHold
    state.applyParsedCat(parseCommand('RX;'));
    snap = state.getSnapshot();
    assertEqual(snap.txActive, false, 'RX clears txActive');
    assertEqual(snap.txMeters.fwdWatts, 0, 'RX resets live fwdWatts');
    assertEqual(snap.txMeters.swr, 0, 'RX resets live swr');
    assertEqual(snap.txMeters.alcBars, 0, 'RX resets live alcBars');
    assertEqual(snap.txMeters.compDb, 0, 'RX resets live compDb');
    assertEqual(snap.txMeters.peakFwdWatts, 75, 'RX keeps peakFwdWatts hold');
    assertApprox(snap.txMeters.peakSwr, 1.8, 1e-6, 'RX keeps peakSwr hold');

    // SIFP rxBaselineVolts / txVoltDrop & peakSupplyAmps
    state.applyParsedCat(parseCommand('SIFPVS:13.80,IS:1.65,TF:26.0;'));
    snap = state.getSnapshot();
    assertApprox(snap.telemetry.rxBaselineVolts, 13.80, 1e-6, 'idle rxBaselineVolts');
    assertApprox(snap.telemetry.txVoltDrop, 0, 1e-6, 'idle txVoltDrop = 0');

    state.applyParsedCat(parseCommand('TX;'));
    state.applyParsedCat(parseCommand('SIFPVS:13.15,IS:18.40,TF:27.5;'));
    state.applyParsedCat(parseCommand('SIFPVS:13.25,IS:12.00,TF:27.8;'));
    snap = state.getSnapshot();
    assertApprox(snap.telemetry.rxBaselineVolts, 13.80, 1e-6, 'baseline preserved during TX');
    assertApprox(snap.telemetry.txVoltDrop, 0.55, 1e-6, 'txVoltDrop = baseline - supplyVolts');
    assertApprox(snap.telemetry.peakSupplyAmps, 18.40, 1e-6, 'peakSupplyAmps retains max');
    assertApprox(snap.telemetry.fpTempC, 27.8, 1e-6, 'fpTempC updated');

    // SIRF & SIDU/SID0 sensors
    state.applyParsedCat(parseCommand('SIRFV8:8.0,V5:5.0,V27:27.1,LT:31.2,LM:0,PA:12.50,PM:0,PT:48.5;'));
    state.applyParsedCat(parseCommand('SIDUV5:5.0,V3:3.3,T:36.8,DV:58.0;'));
    snap = state.getSnapshot();
    assertApprox(snap.telemetry.paTempC, 48.5, 1e-6, 'paTempC');
    assertApprox(snap.telemetry.lpaTempC, 31.2, 1e-6, 'lpaTempC');
    assertApprox(snap.telemetry.paAmps, 12.5, 1e-6, 'paAmps');
    assertApprox(snap.telemetry.ducTempC, 36.8, 1e-6, 'ducTempC');
    assertApprox(snap.telemetry.ducDrive, 58.0, 1e-6, 'ducDrive');
    state.applyParsedCat(parseCommand('SID0V12:12.6,ID:0,DV:0.0;'));
    assertApprox(state.getSnapshot().telemetry.ducDrive, 0.0, 1e-6, 'ducDrive clears on SID0');

    // ATU tune capture: TU3 -> non-zero SWR -> TU0 captures atuMatchedSwr
    state.applyParsedCat(parseCommand('RX;'));
    state.applyParsedCat(parseCommand('FA00014200000;'));
    state.applyParsedCat(parseCommand('TU3;'));
    assertEqual(state.getSnapshot().atuTuning, true, 'atuTuning active on TU3');
    state.applyParsedCat(parseCommand('TM004000018011;'));
    state.applyParsedCat(parseCommand('TU0;'));
    snap = state.getSnapshot();
    assertEqual(snap.atuTuning, false, 'atuTuning cleared on TU0');
    assertApprox(snap.atuMatchedSwr, 1.1, 1e-6, 'atuMatchedSwr captured from tune');
    assertEqual(snap.atuLastTunedFreqHz, 14200000, 'atuLastTunedFreqHz');
  });

  // 27. AudioEngine: TX sources ('two-tone', 'tone-1k', 'wav') -> EM1 12kHz S16LE 240-sample 0x01 packets
  test('AudioEngine generates EM1 12kHz 240-sample 0x01 packets for two-tone, tone-1k & wav', async () => {
    const K4 = globalThis.K4;
    const engine = new K4.AudioEngine({ latencyMs: 75 });
    const packets = [];
    engine.setTxPacketHandler((pkt, meta) => {
      packets.push({ pkt: new Uint8Array(pkt), meta });
    });

    const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      const expectedMicAvail = Boolean(
        globalThis.isSecureContext &&
          typeof navigator !== 'undefined' &&
          navigator.mediaDevices &&
          typeof navigator.mediaDevices.getUserMedia === 'function'
      );
      assertEqual(engine.isMicSecureContextAvailable(), expectedMicAvail, 'isMicSecureContextAvailable');
      const devices = await engine.listAudioInputs();
      assert(Array.isArray(devices), 'listAudioInputs resolves an Array');

      // 'two-tone'
      packets.length = 0;
      const d1 = await engine.startTxCapture({ source: 'two-tone' });
      assertEqual(d1.active, true, 'two-tone active');
      assertEqual(d1.source, 'two-tone', 'two-tone source');
      assertEqual(d1.sampleRate, 12000, 'two-tone 12kHz');
      assertEqual(d1.frameSamplesPerCh, 240, 'two-tone 240 samples');
      assert(packets.length >= 1, 'two-tone emitted initial packet');
      assert(engine.getTxInputLevel() > 0, 'two-tone input level > 0');
      assertEqual(engine.getDiagnostics().txActive, true, 'diagnostics txActive=true');

      const parsedTwoTone = K4.BinaryPackets.parseAudio(packets[0].pkt);
      assert(parsedTwoTone !== null, 'parseAudio(two-tone)');
      assertEqual(parsedTwoTone.encodeMode, 1, 'two-tone EM1');
      assertEqual(parsedTwoTone.sampleRate, 12000, 'two-tone 12000 Hz');
      assertEqual(parsedTwoTone.frameSamplesPerCh, 240, 'two-tone 240 frames');
      assertEqual(parsedTwoTone.data.byteLength, 960, 'two-tone stereo S16LE byteLength=960');
      const decTwoTone = K4.PcmDecoder.decode(parsedTwoTone);
      assert(decTwoTone.left.some((v) => Math.abs(v) > 0.01), 'two-tone non-silent PCM');
      engine.stopTxCapture();
      assertEqual(engine.getTxInputLevel(), 0, 'stopTxCapture resets input level');
      assertEqual(engine.getDiagnostics().txActive, false, 'stopTxCapture sets txActive=false');

      // 'tone-1k'
      packets.length = 0;
      const d2 = await engine.startTxCapture({ source: 'tone-1k' });
      assertEqual(d2.source, 'tone-1k', 'tone-1k source');
      assert(packets.length >= 1, 'tone-1k emitted packet');
      assert(engine.getTxInputLevel() > 0, 'tone-1k input level > 0');
      const parsedTone1k = K4.BinaryPackets.parseAudio(packets[0].pkt);
      assertEqual(parsedTone1k.encodeMode, 1, 'tone-1k EM1');
      assertEqual(parsedTone1k.frameSamplesPerCh, 240, 'tone-1k 240 frames');
      assertEqual(parsedTone1k.data.byteLength, 960, 'tone-1k 960 bytes');
      engine.stopTxCapture();

      // 'wav' + verify interval emission and clean stopTxCapture halt
      const wavSamples = new Float32Array(480);
      for (let i = 0; i < wavSamples.length; i++) {
        wavSamples[i] = 0.45 * Math.sin((2 * Math.PI * 800 * i) / 12000);
      }
      engine.setTxWaveBuffer(wavSamples, 12000);
      packets.length = 0;
      const d3 = await engine.startTxCapture({ source: 'wav' });
      assertEqual(d3.source, 'wav', 'wav source');
      await sleepMs(60);
      assert(packets.length >= 2, `wav timer emitted multiple packets (got ${packets.length})`);
      assert(engine.getTxInputLevel() > 0, 'wav input level > 0');
      const parsedWav = K4.BinaryPackets.parseAudio(packets[0].pkt);
      assertEqual(parsedWav.encodeMode, 1, 'wav EM1');
      assertEqual(parsedWav.frameSamplesPerCh, 240, 'wav 240 frames');
      const decWav = K4.PcmDecoder.decode(parsedWav);
      assert(decWav.left.some((v) => Math.abs(v) > 0.01), 'wav decoded energy > 0');

      engine.stopTxCapture();
      const countAtStop = packets.length;
      await sleepMs(60);
      assertEqual(packets.length, countAtStop, 'stopTxCapture cleanly stops further packets');
      assertEqual(engine.getTxInputLevel(), 0, 'stopTxCapture clears wav input level');
    } finally {
      engine.destroy();
    }
  });

  // 28. SpectrumGeometry.computeTxOverlay: Split VFO B + XIT offset + CW pitch
  test('SpectrumGeometry.computeTxOverlay computes Split VFO B, XIT offset & CW pitch', () => {
    const geom = globalThis.K4.SpectrumGeometry;
    assert(typeof geom.computeTxOverlay === 'function', 'computeTxOverlay exists');

    // Simplex VFO A USB
    const simplex = geom.computeTxOverlay({
      splitEnabled: false,
      xitEnabled: false,
      cwPitchHz: 500,
      txActive: true,
      txTestMode: false,
      rxA: { freqHz: 14200000, mode: 2, bwHz: 2400, ifShiftHz: 0, ritOffsetHz: 300 },
      rxB: { freqHz: 14205000, mode: 2, bwHz: 2400, ifShiftHz: 0, ritOffsetHz: 900 },
    });
    assertEqual(simplex.txVfo, 'A', 'simplex txVfo=A');
    assertEqual(simplex.carrierHz, 14200000, 'simplex ignores ritOffsetHz when XIT off');
    assertEqual(simplex.centerHz, 14200000, 'simplex USB centerHz');
    assertEqual(simplex.lowHz, 14198800, 'simplex USB lowHz');
    assertEqual(simplex.highHz, 14201200, 'simplex USB highHz');
    assertEqual(simplex.isSplitOrXit, false, 'simplex isSplitOrXit=false');
    assertEqual(simplex.active, true, 'simplex active=true');
    assertEqual(simplex.txTestMode, false, 'simplex txTestMode=false');

    // Split VFO B + XIT offset + CW pitch
    const splitXitCw = geom.computeTxOverlay({
      splitEnabled: true,
      xitEnabled: true,
      cwPitchHz: 600,
      txActive: false,
      atuTuning: true,
      txTestMode: true,
      rxA: { freqHz: 14020000, mode: 3, bwHz: 400, ifShiftHz: 0, ritOffsetHz: 100 },
      rxB: { freqHz: 14025000, mode: 3, bwHz: 400, ifShiftHz: 0, ritOffsetHz: 1200 },
    });
    assertEqual(splitXitCw.txVfo, 'B', 'split txVfo=B');
    assertEqual(splitXitCw.carrierHz, 14026200, 'split VFO B + XIT carrierHz = 14025000 + 1200');
    assertEqual(splitXitCw.centerHz, 14026800, 'CW pitch +600 centerHz = 14026800');
    assertEqual(splitXitCw.lowHz, 14026600, 'CW lowHz');
    assertEqual(splitXitCw.highHz, 14027000, 'CW highHz');
    assertEqual(splitXitCw.isSplitOrXit, true, 'isSplitOrXit=true');
    assertEqual(splitXitCw.active, true, 'atuTuning activates overlay');
    assertEqual(splitXitCw.txTestMode, true, 'txTestMode propagated');
  });

  // 29. Base K4 OM capabilities, FI builder, PB0/TS0 safe gate, & RadioState sensor history
  test('CatCodec K4 vs K4D OM, ifCenter, PB5, RxOnlyGate PB0/TS0 & RadioState sensor history', async () => {
    const K4 = globalThis.K4;

    const omK4 = K4.CatCodec.parseCommand('OM AP------4---;');
    assert(omK4 !== null, 'parse OM K4');
    assertEqual(omK4.hasKrx4, false, 'K4 OM hasKrx4=false');
    assertEqual(omK4.hasDiversity, false, 'K4 OM hasDiversity=false');
    assertEqual(omK4.hasSubRx, false, 'K4 OM hasSubRx=false');
    assertEqual(omK4.radioModel, 'K4', 'K4 radioModel=K4');
    assertEqual(omK4.hasAtu, true, 'K4 OM hasAtu=true');
    assertEqual(omK4.hasKpa4, true, 'K4 OM hasKpa4=true');

    const omK4D = K4.CatCodec.parseCommand('OM AP-----S4---;');
    assert(omK4D !== null, 'parse OM K4D');
    assertEqual(omK4D.hasKrx4, true, 'K4D OM hasKrx4=true');
    assertEqual(omK4D.hasDiversity, true, 'K4D OM hasDiversity=true');
    assertEqual(omK4D.radioModel, 'K4D', 'K4D radioModel=K4D');

    const pb5 = K4.CatCodec.parseCommand('PB5;');
    assert(pb5 !== null && pb5.kind === 'dvrPlayback', 'PB5 parsed as dvrPlayback');
    assertEqual(pb5.slot, 5, 'PB5 slot=5');
    assertEqual(pb5.playing, true, 'PB5 playing=true');
    const pb0 = K4.CatCodec.parseCommand('PB0;');
    assertEqual(pb0 && pb0.slot, 0, 'PB0 slot=0');
    assertEqual(pb0 && pb0.playing, false, 'PB0 playing=false');

    assertEqual(K4.CatCodec.builders.ifCenter('A', 14250000), 'FI00014250000;', 'ifCenter A builder');
    assertEqual(K4.CatCodec.builders.ifCenter('B', 7100000), 'FI$00007100000;', 'ifCenter B builder');

    const gate = new K4.RxOnlyGate({ policy: 'rx-only' });
    const safeRes = gate.inspectCat('PB0;TS0;');
    assertEqual(safeRes.sanitized, 'PB0;TS0;', 'PB0;TS0; sanitized intact in rx-only');
    assertEqual(safeRes.allowed.length, 2, 'PB0;TS0; both allowed in rx-only');
    assertEqual(safeRes.blocked.length, 0, 'PB0;TS0; has zero blocked frames');
    const txRes = gate.inspectCat('PB1;TU1;TS1;');
    assertEqual(txRes.blocked.length, 3, 'PB1;TU1;TS1; all blocked in rx-only');

    const state = new K4.RadioState();
    state.applyParsedCat(K4.CatCodec.parseCommand('OM AP------4---;'));
    assertEqual(state.getSnapshot().radioModel, 'K4', 'RadioState tracks K4 radioModel');
    assertEqual(state.getSnapshot().hasDiversity, false, 'RadioState tracks hasDiversity=false on K4');

    state.applyParsedCat(K4.CatCodec.parseCommand('SIRF PT:41.2,LT:36.0,PA:4.5;'));
    state.recordSensorTick();
    await new Promise((r) => setTimeout(r, 230));
    state.applyParsedCat(K4.CatCodec.parseCommand('SIRF PT:44.5,LT:37.2,PA:8.0;'));
    state.recordSensorTick();
    const hist = state.getSensorHistory('pt', 180);
    assert(hist.points.length >= 2, `Sensor history recorded >= 2 samples (got ${hist.points.length})`);
    assertApprox(hist.min, 41.2, 0.05, 'Sensor history min PT=41.2');
    assertApprox(hist.max, 44.5, 0.05, 'Sensor history max PT=44.5');
    assertApprox(hist.current, 44.5, 0.05, 'Sensor history current PT=44.5');
  });

  // 30. PanadapterInteraction: horizontal drag pans viewport & emits FI at max span without tuning VFO
  test('PanadapterInteraction drag pans viewport & emits FI without tuning VFO', () => {
    const K4 = globalThis.K4;
    const host = document.createElement('div');
    host.style.width = '1120px';
    host.style.height = '400px';
    document.body.appendChild(host);

    const state = new K4.RadioState();
    for (const f of K4.CatCodec.splitFrames('FA00014200000;MD2;#SPN48000;')) {
      const p = K4.CatCodec.parseCommand(f);
      if (p) state.applyParsedCat(p);
    }
    const tunes = [];
    const displays = [];
    const cats = [];
    const client = {
      tune: (rx, hz) => tunes.push({ rx, hz }),
      setDisplay: (rx, patch) => displays.push({ rx, patch }),
      sendCat: (cmd) => cats.push(cmd),
    };
    const panView = new K4.PanadapterView({ container: host, state, client, renderer: '2d' });

    const listeners = {};
    const surface = {
      style: {},
      clientWidth: 1120,
      clientHeight: 400,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1120, height: 400 }),
      addEventListener: (t, fn) => { listeners[t] = fn; },
      removeEventListener: (t, fn) => { if (listeners[t] === fn) delete listeners[t]; },
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
    };
    const rendererStub = {
      getLayouts: () => [{ rx: 'A', paneRect: { x: 0, y: 0, w: 1120, h: 400 }, specRect: { x: 0, y: 0, w: 1120, h: 200 }, axisRect: { x: 0, y: 200, w: 1120, h: 24 } }],
    };
    const interaction = new K4.PanadapterInteraction({ surface, renderer: rendererStub, view: panView, state, client });
    try {
      panView.pushPanPacket({
        type: 2,
        rx: 'A',
        centerFreqHz: 14200000,
        spanHz: 48000,
        refDbm: -110,
        scaleDb: 80,
        bins: new Uint8Array(512),
      });

      // Drag left 280px at 48 kHz span (away from passband edges around x=560)
      listeners.pointerdown({ type: 'pointerdown', pointerId: 1, pointerType: 'mouse', button: 0, clientX: 700, clientY: 80, shiftKey: false, altKey: false });
      listeners.pointermove({ type: 'pointermove', pointerId: 1, pointerType: 'mouse', button: 0, clientX: 420, clientY: 80, shiftKey: false, altKey: false });
      listeners.pointerup({ type: 'pointerup', pointerId: 1, pointerType: 'mouse', button: 0, clientX: 420, clientY: 80, shiftKey: false, altKey: false });

      assertEqual(tunes.length, 0, 'Drag on panadapter must NOT tune VFO');
      const postCenterHz = panView.getFrameState().panes.A.panCenterHz;
      assert(postCenterHz > 14205000, `Drag left should pan center higher than 14200000 (got ${postCenterHz})`);
      assertEqual(panView.isViewportOffset('A'), true, 'Dragged viewport is marked offset from VFO');
      assert(displays.length >= 1, 'Sub-span drag emits setDisplay span expansion');

      // At full 368 kHz span (maxOffsetHz = 0), dragging emits FI CAT recenter without tuning VFO
      state.applyParsedCat(K4.CatCodec.parseCommand('#SPN368000;'));
      panView.resetViewport('A', { syncRadioSpan: false });
      panView.pushPanPacket({
        type: 2,
        rx: 'A',
        centerFreqHz: 14200000,
        spanHz: 368000,
        refDbm: -110,
        scaleDb: 80,
        bins: new Uint8Array(512),
      });
      cats.length = 0;
      displays.length = 0;
      listeners.pointerdown({ type: 'pointerdown', pointerId: 2, pointerType: 'mouse', button: 0, clientX: 700, clientY: 80, shiftKey: false, altKey: false });
      listeners.pointermove({ type: 'pointermove', pointerId: 2, pointerType: 'mouse', button: 0, clientX: 420, clientY: 80, shiftKey: false, altKey: false });
      listeners.pointerup({ type: 'pointerup', pointerId: 2, pointerType: 'mouse', button: 0, clientX: 420, clientY: 80, shiftKey: false, altKey: false });
      assertEqual(tunes.length, 0, 'Full-span drag must NOT tune VFO');
      assert(displays.some((d) => d.patch && d.patch.fixedTune === true), `Full-span drag enables #FXT1 (got ${JSON.stringify(displays)})`);
      assert(cats.some((c) => c.startsWith('FI000')), `Full-span drag emits FI CAT (got ${JSON.stringify(cats)})`);

      // Zero-drag click still tunes VFO A
      listeners.pointerdown({ type: 'pointerdown', pointerId: 3, pointerType: 'mouse', button: 0, clientX: 800, clientY: 80, shiftKey: false, altKey: false });
      listeners.pointerup({ type: 'pointerup', pointerId: 3, pointerType: 'mouse', button: 0, clientX: 800, clientY: 80, shiftKey: false, altKey: false });
      assertEqual(tunes.length, 1, 'Zero-drag click still tunes VFO');
      assertEqual(tunes[0].rx, 'A', 'Zero-drag click tunes VFO A');

      // Recentering after auto-#FXT1 drag clears fixedTune (#FXT0) and sends FC;
      displays.length = 0;
      cats.length = 0;
      panView.resetViewport('A', { syncRadioSpan: true });
      assert(displays.some((d) => d.patch && d.patch.fixedTune === false), `Center resets #FXT0 after drag (got ${JSON.stringify(displays)})`);
      assert(cats.includes('FC;'), `Center emits FC; (got ${JSON.stringify(cats)})`);
    } finally {
      interaction.destroy();
      panView.destroy();
      host.remove();
    }
  });

  // 31. AudioEngine: standby mic lifecycle on file:// (insecure) and SecureContext (http://localhost)
  test('AudioEngine standby mic lifecycle across file:// and SecureContext', async () => {
    const K4 = globalThis.K4;
    const engine = new K4.AudioEngine({ latencyMs: 75 });
    const packets = [];
    engine.setTxPacketHandler((pkt, meta) => {
      packets.push({ pkt: new Uint8Array(pkt), meta });
    });
    const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      if (!globalThis.isSecureContext) {
        const st = await engine.ensureMicReady({ voiceProcessing: false });
        assertEqual(st.state, 'insecure', 'file:// reports insecure mic state');
        return;
      }
      if (
        !globalThis.navigator ||
        !globalThis.navigator.mediaDevices ||
        typeof globalThis.navigator.mediaDevices.getUserMedia !== 'function'
      ) {
        const st = await engine.ensureMicReady({ voiceProcessing: false });
        assertEqual(st.state, 'unavailable', 'No mediaDevices reports unavailable');
        return;
      }

      const ready = await engine.ensureMicReady({ voiceProcessing: false });
      assertEqual(ready.state, 'ready', `Expected standby mic ready on SecureContext (got ${JSON.stringify(ready)})`);
      const stream = engine._standbyMicStream;
      assert(stream !== null, 'Standby MediaStream stored on engine');
      const tracks = stream.getAudioTracks();
      assert(tracks.length >= 1 && tracks[0].readyState === 'live', 'Standby mic track is live');

      const cap = await engine.startTxCapture({ source: 'mic', voiceProcessing: false });
      assertEqual(cap.active, true, 'Mic TX capture started');
      assertEqual(cap.source, 'mic', 'TX source=mic');
      assertEqual(engine.getMicStatus().state, 'capturing', 'Mic state=capturing during PTT');
      await sleepMs(140);

      engine.stopTxCapture();
      assertEqual(engine.getDiagnostics().txActive, false, 'stopTxCapture stops txActive');
      assertEqual(engine.getMicStatus().state, 'ready', 'Standby mic stays ready across PTT release');
      assertEqual(tracks[0].readyState, 'live', 'Standby track stays live across PTT release');

      engine.releaseMicStandby();
      assertEqual(engine.getMicStatus().state, 'idle', 'releaseMicStandby sets mic state=idle');
      assertEqual(tracks[0].readyState, 'ended', 'releaseMicStandby ends audio track');
    } finally {
      engine.destroy();
    }
  });

  // 32. NR / SSNR CAT codec, RxOnlyGate, RadioState mutual exclusivity, Client.setNr & Client.setSubRx
  test('NR / SSNR CatCodec, RxOnlyGate, RadioState mutual exclusivity & Client.setNr/setSubRx', () => {
    const K4 = globalThis.K4;

    // CatCodec parsing: NR000, NR041, NR042, NRS052, NRS051, NRS$121
    const p0 = K4.CatCodec.parseCommand('NR000;');
    assertEqual(p0 && p0.kind, 'nr', 'NR000 kind');
    assertEqual(p0.nrKind, 'lms', 'NR000 nrKind');
    assertEqual(p0.rx, 'A', 'NR000 rx');
    assertEqual(p0.modeDigit, 0, 'NR000 modeDigit');
    assertEqual(p0.level, 0, 'NR000 level');
    assertEqual(p0.nrOn, false, 'NR000 nrOn');
    assertEqual(p0.lastUsed, false, 'NR000 lastUsed');

    const pLmsOn = K4.CatCodec.parseCommand('NR041;');
    assertEqual(pLmsOn.nrKind, 'lms', 'NR041 nrKind');
    assertEqual(pLmsOn.level, 4, 'NR041 level');
    assertEqual(pLmsOn.nrOn, true, 'NR041 nrOn');

    const pLmsLast = K4.CatCodec.parseCommand('NR042;');
    assertEqual(pLmsLast.modeDigit, 2, 'NR042 modeDigit');
    assertEqual(pLmsLast.level, 4, 'NR042 level');
    assertEqual(pLmsLast.nrOn, false, 'NR042 nrOn');
    assertEqual(pLmsLast.lastUsed, true, 'NR042 lastUsed');

    const pSsnrLast = K4.CatCodec.parseCommand('NRS052;');
    assertEqual(pSsnrLast.nrKind, 'ssnr', 'NRS052 nrKind');
    assertEqual(pSsnrLast.modeDigit, 2, 'NRS052 modeDigit');
    assertEqual(pSsnrLast.level, 5, 'NRS052 level');
    assertEqual(pSsnrLast.nrOn, false, 'NRS052 nrOn');
    assertEqual(pSsnrLast.lastUsed, true, 'NRS052 lastUsed');

    const pSsnrOn = K4.CatCodec.parseCommand('NRS051;');
    assertEqual(pSsnrOn.nrKind, 'ssnr', 'NRS051 nrKind');
    assertEqual(pSsnrOn.level, 5, 'NRS051 level');
    assertEqual(pSsnrOn.nrOn, true, 'NRS051 nrOn');

    const pSsnrB = K4.CatCodec.parseCommand('NRS$121;');
    assertEqual(pSsnrB.rx, 'B', 'NRS$121 rx');
    assertEqual(pSsnrB.nrKind, 'ssnr', 'NRS$121 nrKind');
    assertEqual(pSsnrB.level, 12, 'NRS$121 level');
    assertEqual(pSsnrB.nrOn, true, 'NRS$121 nrOn');

    // Builders never emit NR001 / NRS001 / NR$001 / NRS$001 when turning ON
    assertEqual(K4.CatCodec.builders.nr('A', 0, true), 'NR041;', 'builders.nr(A,0,true) falls back to NR041;');
    assertEqual(K4.CatCodec.builders.nr('B', -1, true), 'NR$041;', 'builders.nr(B,-1,true) falls back to NR$041;');
    assertEqual(K4.CatCodec.builders.ssnr('A', 0, true), 'NRS051;', 'builders.ssnr(A,0,true) falls back to NRS051;');
    assertEqual(K4.CatCodec.builders.ssnr('B', 0, true), 'NRS$051;', 'builders.ssnr(B,0,true) falls back to NRS$051;');
    assertEqual(K4.CatCodec.builders.nr('A', 0, false), 'NR000;', 'builders.nr(A,0,false)');
    assertEqual(K4.CatCodec.builders.ssnr('A', 0, false), 'NRS000;', 'builders.ssnr(A,0,false)');
    assertEqual(K4.CatCodec.builders.nrToggle('A'), 'NR/;', 'builders.nrToggle');
    assertEqual(K4.CatCodec.builders.ssnrToggle('B'), 'NRS$/;');

    // RxOnlyGate allows NRS / NRS$ reads and sets in rx-only posture
    const gate = new K4.RxOnlyGate({ policy: 'rx-only' });
    for (const cmd of ['NRS;', 'NRS$;', 'NRS051;', 'NRS$121;', 'NR041;']) {
      const check = gate.inspectCat(cmd);
      assertEqual(check.blocked.length, 0, `RxOnlyGate allows ${cmd}`);
      assertEqual(check.allowed.length, 1, `RxOnlyGate returns allowed token for ${cmd}`);
    }

    // RadioState NR000;NRS052; baseline, NR041; -> LMS active, NRS051; -> SSNR active (mutually exclusive)
    const state = new K4.RadioState();
    state.applyParsedCat(K4.CatCodec.parseCommand('NR000;'));
    state.applyParsedCat(K4.CatCodec.parseCommand('NRS052;'));
    let rxA = state.getSnapshot().rxA;
    assertEqual(rxA.nrOn, false, 'NR000+NRS052 nrOn false');
    assertEqual(rxA.ssnrLastUsed, true, 'NR000+NRS052 ssnrLastUsed true');
    assertEqual(rxA.ssnrLevel, 5, 'NR000+NRS052 ssnrLevel 5');
    assertEqual(rxA.nrMode, 'ssnr', 'NR000+NRS052 defaults nrMode to ssnr');

    state.applyParsedCat(K4.CatCodec.parseCommand('NR041;'));
    rxA = state.getSnapshot().rxA;
    assertEqual(rxA.lmsNrOn, true, 'NR041 lmsNrOn true');
    assertEqual(rxA.ssnrOn, false, 'NR041 ssnrOn false');
    assertEqual(rxA.nrMode, 'lms', 'NR041 nrMode lms');
    assertEqual(rxA.nrOn, true, 'NR041 nrOn true');
    assertEqual(rxA.nrLevel, 4, 'NR041 nrLevel 4');

    state.applyParsedCat(K4.CatCodec.parseCommand('NRS051;'));
    rxA = state.getSnapshot().rxA;
    assertEqual(rxA.ssnrOn, true, 'NRS051 ssnrOn true');
    assertEqual(rxA.lmsNrOn, false, 'NRS051 lmsNrOn false');
    assertEqual(rxA.nrMode, 'ssnr', 'NRS051 nrMode ssnr');
    assertEqual(rxA.nrOn, true, 'NRS051 nrOn true');
    assertEqual(rxA.nrLevel, 5, 'NRS051 nrLevel 5');

    // Client.setNr and Client.setSubRx(true)
    const sent = [];
    const client = new K4.Client({ state, gate });
    client.sendCat = (cmd) => {
      sent.push(cmd);
      return true;
    };
    state.applyParsedCat(K4.CatCodec.parseCommand('NR000;'));
    state.applyParsedCat(K4.CatCodec.parseCommand('NRS052;'));
    sent.length = 0;
    client.setNr('A', { on: true });
    assertEqual(sent[0], 'NRS051;NR;NR$;NRS;NRS$;', 'setNr({on:true}) from NRS052 sends NRS051 + poll');
    assert(!sent[0].includes('NR001') && !sent[0].includes('NRS001'), 'setNr never emits NR001/NRS001');

    client.setNr('A', { mode: 'lms', level: 0 });
    assertEqual(sent[1], 'NR041;NR;NR$;NRS;NRS$;', 'setNr({mode:lms,level:0}) while ON substitutes default 4');

    client.setSubRx(true);
    assert(
      sent[2].includes('SB1;') &&
      sent[2].includes('SMH;') &&
      sent[2].includes('SMH$;') &&
      sent[2].includes('NRS$;') &&
      sent[2].includes('NR$;'),
      `setSubRx(true) queries dual-RX SMH/NR/NRS, got ${sent[2]}`
    );
  });

  // 33. PanadapterView defaults peakHold to false on fresh startup (Note 5)
  test('PanadapterView defaults _peakHold to false on fresh startup', () => {
    const K4 = globalThis.K4;
    const state = new K4.RadioState();
    const container = document.createElement('div');
    container.style.width = '640px';
    container.style.height = '320px';
    document.body.appendChild(container);
    let view = null;
    try {
      view = new K4.PanadapterView({ container, state, renderer: '2d' });
      assertEqual(view._peakHold, false, 'PanadapterView._peakHold defaults to false');
    } finally {
      if (view && typeof view.destroy === 'function') view.destroy();
      container.remove();
    }
  });

  // 34. RadioState coalesces streaming CW/TB decodedText chunks per RX & isolates snapshots
  test('RadioState coalesces streaming TB/TB$ chunks per RX and keeps snapshots immutable', () => {
    const K4 = globalThis.K4;
    const state = new K4.RadioState();

    for (const ch of ['C', 'Q', ' ', 'D', 'E', ' ', 'K']) {
      state.applyParsedCat(K4.CatCodec.parseCommand(`TB001${ch};`));
    }
    let snap1 = state.getSnapshot();
    assertEqual(snap1.decodedText.length, 1, '7 single-char TB packets coalesce into 1 line');
    assertEqual(snap1.decodedText[0].rx, 'A', 'Coalesced RX A');
    assertEqual(snap1.decodedText[0].text, 'CQ DE K', 'Coalesced text matches CQ DE K');
    assertEqual(snap1.decodedText[0].closed, false, 'Open line has closed=false');

    // Interleaved RX B stream should not split RX A's line
    state.applyParsedCat(K4.CatCodec.parseCommand('TB$001T;'));
    state.applyParsedCat(K4.CatCodec.parseCommand('TB001 ;'));
    state.applyParsedCat(K4.CatCodec.parseCommand('TB$001U;'));
    state.applyParsedCat(K4.CatCodec.parseCommand('TB0017;'));
    state.applyParsedCat(K4.CatCodec.parseCommand('TB0013;'));

    const snap2 = state.getSnapshot();
    assertEqual(snap2.decodedText.length, 2, 'Interleaved RX A/B streams maintain 2 open lines');
    assertEqual(snap2.decodedText[0].text, 'CQ DE K 73', 'RX A kept coalescing across RX B');
    assertEqual(snap2.decodedText[1].text, 'TU', 'RX B coalesced independently');

    // Prior snapshot object was cloned and must remain untouched by later updates
    assertEqual(snap1.decodedText[0].text, 'CQ DE K', 'Prior snapshot decodedText entry immutable');

    // CRLF/LF closes the line and starts a fresh open line
    state.applyParsedCat(K4.CatCodec.parseCommand('TB006\r\nNEXT;'));
    const snap3 = state.getSnapshot();
    assertEqual(snap3.decodedText.length, 3, 'Newline opens next RX A decodedText line');
    assertEqual(snap3.decodedText[0].closed, true, 'Previous RX A line closed after newline');
    assertEqual(snap3.decodedText[2].text, 'NEXT', 'New RX A line started with NEXT');
    assertEqual(snap3.decodedText[2].closed, false, 'New RX A line remains open');
  });

  // 35. Direct TX boot posture (tx-enabled/tx-armed), sticky arming, panicAbortTx, and permanent blocklist
  test('Direct TX boot posture defaults to tx-enabled/tx-armed while permanent blocklist stays enforced', () => {
    const K4 = globalThis.K4;
    const state = new K4.RadioState();
    assertEqual(state.getSnapshot().txPosture, 'tx-armed', 'RadioState defaults txPosture to tx-armed');

    const gate = new K4.RxOnlyGate('tx-enabled');
    assertEqual(gate.getPolicy(), 'tx-enabled', 'RxOnlyGate accepts tx-enabled constructor arg');

    const sentRaw = [];
    const client = new K4.Client({ state, gate });
    assertEqual(client.getTxPosture(), 'tx-armed', 'Client defaults txPosture to tx-armed');
    client._ws = { readyState: 1, send: (buf) => sentRaw.push(buf) };
    state.updateConnection({ status: 'connected', authStatus: 'authenticated' });

    try {
      // TX, ATU, Power, Antenna commands pass directly without modal arming
      const txRes = client.sendCat('TX;TU3;PC050H;AN2;');
      assertDeepEqual(txRes.blocked, [], 'Direct TX/ATU/Power/Ant allowed in default tx-enabled posture');
      assertEqual(txRes.allowed.length, 4, '4 TX commands allowed');

      // Permanent admin/hardware-destructive blocklist stays blocked even in tx-enabled
      const permRes = client.sendCat('#CAL0;EE;RRPsecret;PS0;SWT09;DARM1;');
      assertDeepEqual(permRes.allowed, [], 'Permanent dangerous prefixes remain blocked in tx-enabled');
      assertEqual(permRes.blocked.length, 6, 'All 6 permanent blocklist prefixes rejected');

      // panicAbortTx aborts TX/ATU/keyer while keeping txPosture armed
      state.update({ txActive: true, atuTuning: true }, 'txActive');
      const abortRes = client.panicAbortTx('escape');
      assertEqual(abortRes.sanitized, 'PB0;TU0;KY @;RX;TS0;', 'panicAbortTx sends full abort macro');
      assertEqual(client.getTxPosture(), 'tx-armed', 'panicAbortTx keeps txPosture in tx-armed');

      // Simulated disconnect keeps txPosture in tx-armed
      client.disconnect();
      assertEqual(client.getTxPosture(), 'tx-armed', 'Disconnect keeps txPosture in tx-armed');
    } finally {
      client._ws = null;
      client._stopKeepalive();
    }
  });

  // 36. Stage 1 protocol/client overhaul: Auto Spot, single ATU 3->4 tap, continuous PC L/H, ANT cycle, AB0..5, QuickSplit
  test('Client & CatCodec support SP3/SP$3 Auto Spot, TU3->TU4 ATU double-tap, continuous PC L/H, ANT cycle, and AB0..5', () => {
    const K4 = globalThis.K4;
    const b = K4.CatCodec.builders;
    assertEqual(b.spot(3, 'A'), 'SP3;', 'builder spot 3 A');
    assertEqual(b.spot(3, 'B'), 'SP$3;', 'builder spot 3 B');
    assertEqual(b.spot(1, 'A'), 'SP1;', 'builder spot 1 A');
    assertEqual(b.power(0.1), 'PC001L;', 'builder power 0.1W -> PC001L;');
    assertEqual(b.power(5.5), 'PC055L;', 'builder power 5.5W -> PC055L;');
    assertEqual(b.power(10), 'PC100L;', 'builder power 10.0W -> PC100L;');
    assertEqual(b.power(11), 'PC011H;', 'builder power 11W -> PC011H;');
    assertEqual(b.power(110), 'PC110H;', 'builder power 110W -> PC110H;');
    assertEqual(b.vfoCopy(0), 'AB0;', 'builder vfoCopy 0');
    assertEqual(b.vfoCopy(3), 'AB3;', 'builder vfoCopy 3');
    assertEqual(b.vfoCopy(5), 'AB5;', 'builder vfoCopy 5');

    const pLow = K4.CatCodec.parseCommand('PC055L;');
    assertEqual(pLow.kind, 'powerControl', 'PC055L kind');
    assertApprox(pLow.powerWatts, 5.5, 0.01, 'PC055L powerWatts');
    assertEqual(pLow.powerRange, 'L', 'PC055L powerRange');

    const pHigh = K4.CatCodec.parseCommand('PC045H;');
    assertApprox(pHigh.powerWatts, 45, 0.01, 'PC045H powerWatts');
    assertEqual(pHigh.powerRange, 'H', 'PC045H powerRange');

    const state = new K4.RadioState();
    const client = new K4.Client({ state, gate: new K4.RxOnlyGate('tx-enabled') });
    const sent = [];
    client.sendCat = (cmd) => {
      const inspected = client.gate.inspectCat(cmd);
      if (inspected.sanitized) sent.push(inspected.sanitized);
      return { sent: true, allowed: inspected.allowed, blocked: inspected.blocked, sanitized: inspected.sanitized };
    };

    // Auto Spot & Spot Tone + K4 Rev D4 SP$ parity
    assertEqual(K4.CatCodec.parseCommand('SP$0;'), null, 'SP$0 invalid on Sub-RX');
    assertEqual(K4.CatCodec.parseCommand('SP$1;'), null, 'SP$1 invalid on Sub-RX');
    assertEqual(K4.CatCodec.parseCommand('SP$2;'), null, 'SP$2 invalid on Sub-RX');
    const spSub = K4.CatCodec.parseCommand('SP$3;');
    assert(spSub && spSub.kind === 'spot' && spSub.rx === 'B' && spSub.mode === 3, 'SP$3 parses on Sub-RX');
    assertEqual(K4.CatCodec.builders.spot(0, 'B'), 'SP$3;', 'builders.spot enforces SP$3 on Sub-RX');
    assertEqual(K4.CatCodec.builders.spot(1, 'B'), 'SP$3;', 'builders.spot(1, B) enforces SP$3');
    assertEqual(K4.CatCodec.builders.spot(2, 'B'), 'SP$3;', 'builders.spot(2, B) enforces SP$3');
    assertEqual(K4.CatCodec.builders.spot(1, 'A'), 'SP1;', 'builders.spot(1, A) builds SP1');

    // Shared K4 formatting & mix weight helpers
    assertEqual(K4.formatFreqMHz(14074000), '14.074.000', 'shared formatFreqMHz');
    assertEqual(K4.quantizePowerWatts(5.54), 5.5, 'quantizePowerWatts L step 0.1');
    assertEqual(K4.quantizePowerWatts(44.6), 45, 'quantizePowerWatts H step 1');
    assertEqual(
      K4.formatTxAntenna({ txAntenna: 2, antennaNames: { 2: 'Hexbeam' } }).label,
      'ANT 2 · Hexbeam',
      'shared formatTxAntenna custom label'
    );
    const mixW = new Float64Array(4);
    K4.computeLinearMixWeights(1.0, 0.5, true, 0.0, 'A.B', mixW);
    assertApprox(mixW[0], 1.0, 0.001, 'shared computeLinearMixWeights wLA');
    assertApprox(mixW[3], 0.5, 0.001, 'shared computeLinearMixWeights wRB');

    client.setTargetRx('A');
    client.autoSpot();
    assertEqual(sent[sent.length - 1], 'SP3;FA;', 'autoSpot A sends SP3;FA;');
    client.setTargetRx('B');
    client.autoSpot();
    assertEqual(sent[sent.length - 1], 'SP$3;FB;', 'autoSpot B sends SP$3;FB;');
    client.setSpotTone(1);
    assertEqual(sent[sent.length - 1], 'SP1;', 'setSpotTone(1) sends SP1;');
    assertEqual(state.getSnapshot().spotTone, 1, 'spotTone 1 after SP1');
    client.setSpotTone(0);
    assertEqual(state.getSnapshot().spotTone, 0, 'spotTone 0 after SP0');

    // Single ATU button: 1st tap -> TU3; opening 5s window, 2nd tap -> TU4;
    client.startAtuTune();
    assertEqual(sent[sent.length - 1], 'TU3;TM1;PO1;', '1st ATU tap sends TU3');
    assertEqual(state.getSnapshot().atuTuneKind, 3, '1st tap records atuTuneKind=3');
    assert(state.getSnapshot().atuSearchWindowUntil > Date.now(), '1st tap opens 5s Full Search window');
    client.startAtuTune();
    assertEqual(sent[sent.length - 1], 'TU4;TM1;PO1;', '2nd ATU tap within 5s upgrades to TU4');
    assertEqual(state.getSnapshot().atuTuneKind, 4, '2nd tap records atuTuneKind=4');
    assertEqual(state.getSnapshot().atuSearchWindowUntil, 0, '2nd tap consumes Full Search window');
    client.stopAtuTune();
    assertEqual(sent[sent.length - 1], 'TU0;RX;', 'stopAtuTune sends TU0;RX;');

    // Continuous power slider auto L/H boundary
    client.setPowerWatts(5.5);
    assertEqual(sent[sent.length - 1], 'PC055L;PC;', '5.5W sends PC055L;');
    assertApprox(state.getSnapshot().powerWatts, 5.5, 0.01, 'state powerWatts 5.5');
    assertEqual(state.getSnapshot().powerRange, 'L', 'state powerRange L');
    client.setPowerWatts(45);
    assertEqual(sent[sent.length - 1], 'PC045H;PC;', '45W sends PC045H;');
    assertEqual(state.getSnapshot().powerWatts, 45, 'state powerWatts 45');
    assertEqual(state.getSnapshot().powerRange, 'H', 'state powerRange H');

    // Antenna cycle 1 -> 2 -> 3 -> 1
    client.cycleTxAntenna();
    assertEqual(sent[sent.length - 1], 'AN2;AN;', 'cycleTxAntenna 1->2');
    client.cycleTxAntenna();
    assertEqual(sent[sent.length - 1], 'AN3;AN;', 'cycleTxAntenna 2->3');
    client.cycleTxAntenna();
    assertEqual(sent[sent.length - 1], 'AN1;AN;', 'cycleTxAntenna 3->1');

    // VFO AB cluster copy & Quick Split
    client.vfoCopy(0);
    assertEqual(sent[sent.length - 1], 'AB0;FA;FB;', 'vfoCopy(0) copies freq + polls FA;FB;');
    client.vfoCopy(3);
    assert(sent[sent.length - 1].startsWith('AB3;FA;FB;MD;'), 'vfoCopy(3) copies all + polls modes/filters');
    client.setupQuickSplit(2000);
    assert(sent[sent.length - 1].includes('AB3;FB00014076000;FT1;'), 'setupQuickSplit sets +2kHz & FT1');
  });

  // 37. AudioEngine E2E latency breakdown, MediaMetadata dedup, mute events, and AF FFT skip counters
  test('AudioEngine computes E2E latency, deduplicates MediaMetadata, and tracks _perf skips', async () => {
    const K4 = globalThis.K4;
    const state = new K4.RadioState();
    state.applyParsedCat(K4.CatCodec.parseCommand('FA00014074000;'));
    state.applyParsedCat(K4.CatCodec.parseCommand('MD2;'));
    const audio = new K4.AudioEngine({ state });

    try {
      // MediaSession metadata deduplication (test before audio.start() which also calls updateMediaMetadata)
      const snap = state.getSnapshot();
      const first = audio.updateMediaMetadata(snap);
      if (typeof globalThis.MediaMetadata === 'function' && globalThis.navigator && globalThis.navigator.mediaSession) {
        assertEqual(first, true, 'First updateMediaMetadata populates MediaMetadata');
        const updatesBefore = audio._perf.mediaMetaUpdates;
        const skipsBefore = audio._perf.mediaMetaSkips;
        const second = audio.updateMediaMetadata(snap);
        assertEqual(second, false, 'Identical snapshot updateMediaMetadata is skipped');
        assertEqual(audio._perf.mediaMetaUpdates, updatesBefore, 'mediaMetaUpdates unchanged on dedup');
        assertEqual(audio._perf.mediaMetaSkips, skipsBefore + 1, 'mediaMetaSkips incremented on dedup');

        state.applyParsedCat(K4.CatCodec.parseCommand('FA00007074000;'));
        const third = audio.updateMediaMetadata(state.getSnapshot());
        assertEqual(third, true, 'Freq change updates MediaMetadata');
        assert(globalThis.navigator.mediaSession.metadata.title.includes('7.074'), 'MediaMetadata title reflects 7.074 MHz');
      }

      audio.updateNetworkRtt(42);
      const stoppedBrk = audio.getLatencyBreakdown(42);
      assertEqual(stoppedBrk.rttMs, 42, 'latency breakdown rttMs');
      assertEqual(stoppedBrk.rxNetHalfRttMs, 21, 'latency breakdown rxNetHalfRttMs');
      assertEqual(stoppedBrk.e2eRxMs, null, 'latency breakdown e2eRxMs null when stopped/muted');
      assert(Number.isFinite(stoppedBrk.localPipelineMs) && stoppedBrk.localPipelineMs >= 20, 'localPipelineMs >= 20');
      assert(Number.isFinite(stoppedBrk.e2eTxMs) && stoppedBrk.e2eTxMs >= 21, 'latency breakdown e2eTxMs >= half RTT');
      assertEqual(audio.getDiagnostics().rttMs, 42, 'getDiagnostics reports updated rttMs');

      const startRes = await audio.start();
      if (startRes && startRes.started) {
        audio.setMuted(false);
        const activeBrk = audio.getLatencyBreakdown(42);
        assert(Number.isFinite(activeBrk.e2eRxMs) && activeBrk.e2eRxMs >= 41, 'active unmuted e2eRxMs >= 41ms');
      }

      // Mute listener fires cleanly
      const muteEvents = [];
      audio.on('mute', (ev) => muteEvents.push(ev));
      audio.setMuted(false);
      audio.setMuted(true);
      assert(muteEvents.length >= 1, 'AudioEngine emits mute events on transitions');

      // AF FFT skip accounting when audio buffer generation is unchanged
      audio.getAfSpectrum(3200);
      const skips0 = audio._perf.afFftSkips;
      audio.getAfSpectrum(3200);
      assertEqual(audio._perf.afFftSkips, skips0 + 1, '_perf.afFftSkips increments on repeated getAfSpectrum call');
    } finally {
      await audio.stop();
    }
  });

  // 38. InspectorPanels Item 2/4/5/6/7/8/9/10 labels & controls + lazy dirty-tab skip efficiency
  test('InspectorPanels exposes overhaul controls and skips off-tab updates in __k4UiPerf', () => {
    const K4 = globalThis.K4;
    const state = new K4.RadioState();
    const audio = new K4.AudioEngine({ state });
    audio.updateNetworkRtt(36);
    const client = new K4.Client({ state, gate: new K4.RxOnlyGate('tx-enabled') });

    const drawer = document.createElement('div');
    const mobileNav = document.createElement('div');
    const sheet = document.createElement('div');
    document.body.appendChild(drawer);
    document.body.appendChild(mobileNav);
    document.body.appendChild(sheet);

    const inspector = new K4.InspectorPanels({
      drawerEl: drawer,
      mobileNavEl: mobileNav,
      mobileSheetEl: sheet,
      state,
      client,
      audio,
      getTargetRx: () => 'A',
      getPalette: () => 'obsidian',
      getPeakHold: () => false,
    });

    try {
      inspector.selectDesktopTab('tx');
      const txPane = inspector._panes.tx;
      inspector.update(state.getSnapshot());

      // Item 7: Single continuous TX power slider 0.1..110, zero L/H range segment buttons
      const pwrSlider = txPane.querySelector('[data-testid="tx-power-slider"]');
      assert(Boolean(pwrSlider), 'tx-power-slider present');
      assertEqual(pwrSlider.min, '0.1', 'tx-power-slider min 0.1');
      assertEqual(pwrSlider.max, '110', 'tx-power-slider max 110');
      assert(!txPane.querySelector('[data-testid="tx-power-range"]'), 'No L/H range segmented group');

      // Item 4 & 6: Single ATU TUNE button, no atu-full-btn, single ATU & Antenna card + single KAT4 card badge
      assert(Boolean(txPane.querySelector('[data-testid="atu-tune-btn"]')), 'atu-tune-btn present');
      assert(!txPane.querySelector('[data-testid="atu-full-btn"]'), 'atu-full-btn absent');
      const txText = txPane.textContent || '';
      assertEqual((txText.match(/ATU & Antenna/g) || []).length, 1, 'Exactly one ATU & Antenna header');
      const katBadges = Array.from(txPane.querySelectorAll('.k4-card-badge')).filter((el) => el.textContent.trim() === 'KAT4');
      assertEqual(katBadges.length, 1, 'Exactly one KAT4 badge in TX pane');

      // Item 8 & 9: tx-antenna-btn present, tx-antenna-select & Mic Input (MI) removed
      assert(Boolean(txPane.querySelector('[data-testid="tx-antenna-btn"]')), 'tx-antenna-btn present');
      assert(!txPane.querySelector('[data-testid="tx-antenna-select"]'), 'tx-antenna-select removed');
      assert(!txText.includes('Mic Input'), 'Physical Mic Input selector removed');

      // Item 2: Keyer buttons Send / Stop (never Send KY / Abort KY @)
      const kySend = txPane.querySelector('[data-testid="cw-ky-send"]');
      const kyAbort = txPane.querySelector('[data-testid="cw-ky-abort"]');
      assertEqual(kySend.textContent.trim(), 'Send', 'Keyer send button labeled Send');
      assertEqual(kyAbort.textContent.trim(), 'Stop', 'Keyer abort button labeled Stop');
      assert(!txText.includes('Transmit Lock') && !txText.includes('Arm live RF'), 'No Transmit Lock copy in TX tab');

      // Item 3: Auto Spot & CW Spot buttons enabled in CW, disabled in USB
      inspector.selectDesktopTab('dsp');
      const dspPane = inspector._panes.dsp;
      const autoSpotBtn = dspPane.querySelector('[data-testid="auto-spot-btn"]');
      const cwSpotBtn = dspPane.querySelector('[data-testid="cw-spot-btn"]');
      assert(Boolean(autoSpotBtn) && Boolean(cwSpotBtn), 'auto-spot-btn & cw-spot-btn present in DSP tab');
      state.applyParsedCat(K4.CatCodec.parseCommand('MD2;'));
      inspector.update(state.getSnapshot());
      assertEqual(autoSpotBtn.disabled, true, 'Auto Spot disabled in USB');
      state.applyParsedCat(K4.CatCodec.parseCommand('MD3;'));
      inspector.update(state.getSnapshot());
      assertEqual(autoSpotBtn.disabled, false, 'Auto Spot enabled in CW');

      // Item 5: Audio tab diag-e2eLatency
      inspector.selectDesktopTab('audio');
      const e2eEl = inspector._panes.audio.querySelector('[data-testid="diag-e2eLatency"]');
      assert(Boolean(e2eEl), 'diag-e2eLatency present in Audio tab');
      assert(e2eEl.textContent.includes('ms'), `diag-e2eLatency formatted with ms, got ${e2eEl.textContent}`);

      // CPU efficiency: updating tx/audio keys on display tab increments inspectorTabSkips & afScopeSkips
      inspector.selectDesktopTab('display');
      const perfBefore = Object.assign({}, globalThis.__k4UiPerf || {});
      state.update({ powerWatts: 25 }, 'powerWatts');
      inspector.update(state.getSnapshot(), ['powerWatts', 'telemetry']);
      const perfAfter = globalThis.__k4UiPerf;
      assert(perfAfter.inspectorTabSkips > perfBefore.inspectorTabSkips, 'Off-tab tx/audio update skipped via inspectorTabSkips');
      assert(perfAfter.afScopeSkips > perfBefore.afScopeSkips, 'AF scope update skipped when Audio tab hidden');
      assert(inspector._dirtyTabs.has('tx'), 'tx tab marked dirty for lazy update');
      inspector.selectDesktopTab('tx');
      assert(!inspector._dirtyTabs.has('tx'), 'tx tab flushed when selected');
    } finally {
      inspector.destroy();
      drawer.remove();
      mobileNav.remove();
      sheet.remove();
    }
  });

  // 39. RadioState.batch() coalescing + PanadapterView Dual Mini-Pan & __k4Perf zero-reflow/overlay-skip invariants
  test('RadioState.batch() coalesces CAT frames and PanadapterView manages dual Mini-Pans & __k4Perf', async () => {
    const K4 = globalThis.K4;
    const state = new K4.RadioState();
    const perf0 = state.getPerf();
    let emitCount = 0;
    let lastKeys = null;
    state.on('change', (_snap, _key, keys) => {
      emitCount += 1;
      lastKeys = keys;
    });

    state.batch(() => {
      for (const cmd of ['FA00014074000;', 'FB00014025000;', 'MD2;', 'MD$3;', 'FT1;', 'SB1;', 'AN2;', 'PC045H;']) {
        state.applyParsedCat(K4.CatCodec.parseCommand(cmd));
      }
    });
    const perf1 = state.getPerf();
    assertEqual(emitCount, 1, '8 CAT commands inside batch() emit exactly 1 change event');
    assertEqual(perf1.batchedEmits, perf0.batchedEmits + 1, 'getPerf().batchedEmits incremented');
    assert(perf1.suppressedEmits >= perf0.suppressedEmits + 7, 'getPerf().suppressedEmits recorded intermediate suppression');
    assert(lastKeys && lastKeys.has('rxA.freqHz') && lastKeys.has('powerWatts'), 'batched changedKeys preserved');

    // Dual Mini-Pan + __k4Perf
    const container = document.createElement('div');
    container.style.width = '800px';
    container.style.height = '420px';
    container.style.position = 'relative';
    document.body.appendChild(container);
    const viewCalls = [];
    let view = null;
    try {
      if (K4.storage) {
        K4.storage.remove('k4.minipan.pos.a');
        K4.storage.remove('k4.minipan.pos.b');
      }
      state.applyParsedCat(K4.CatCodec.parseCommand('#MP1;'));
      state.applyParsedCat(K4.CatCodec.parseCommand('#MP$1;'));
      state.applyParsedCat(K4.CatCodec.parseCommand('SB1;'));

      view = new K4.PanadapterView({
        container,
        state,
        client: {
          setPanCenter: (rx, hz) => viewCalls.push({ fn: 'center', rx, hz }),
          setDisplay: (rx, patch) => viewCalls.push({ fn: 'display', rx, patch }),
        },
        renderer: '2d',
      });

      const boxA = container.querySelector('[data-testid="minipan-box-a"]');
      const boxB = container.querySelector('[data-testid="minipan-box-b"]');
      assert(Boolean(boxA) && Boolean(boxB), 'Both minipan-box-a and minipan-box-b mounted in container');

      const pktA = new Float32Array(256).fill(-110);
      view.pushMiniPanPacket({ rx: 'A', spanHz: 10000, bins: pktA, sampleRateHz: 10000 });
      view.pushMiniPanPacket({ rx: 'B', spanHz: 10000, bins: pktA, sampleRateHz: 10000 });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      assertEqual(boxA.style.display, 'flex', 'minipan-box-a visible after #MP1 + packet');
      assertEqual(boxB.style.display, 'flex', 'minipan-box-b visible after #MP$1 + SB1 + packet');

      // Perf counters: __k4Perf initialized with hudMeasures & overlaySkips
      const panPerf = view.getPerf ? view.getPerf() : (globalThis.__k4Perf || {});
      assert(typeof panPerf.hudMeasures === 'number', '__k4Perf.hudMeasures tracked');
      assert(typeof panPerf.overlaySkips === 'number', '__k4Perf.overlaySkips tracked');

      // closeMiniPan('A') sends setDisplay(A, { miniPan: false }) & hides boxA while leaving boxB active
      view.closeMiniPan('A');
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      assertEqual(viewCalls.some((c) => c.fn === 'display' && c.rx === 'A' && c.patch && c.patch.miniPan === false), true, 'closeMiniPan A invokes setDisplay(A, {miniPan:false})');
      assertEqual(boxA.style.display, 'none', 'minipan-box-a hidden after close');
      assertEqual(boxB.style.display, 'flex', 'minipan-box-b remains open when A closes');
    } finally {
      if (view && typeof view.destroy === 'function') view.destroy();
      container.remove();
    }
  });

  async function runAll() {
    const resultsEl = document.getElementById('results');
    const summaryEl = document.getElementById('summary');
    const failures = [];
    let passed = 0;

    for (const t of tests) {
      const row = document.createElement('div');
      row.className = 'test-row';
      const left = document.createElement('div');
      const title = document.createElement('div');
      title.textContent = t.name;
      left.appendChild(title);

      const badge = document.createElement('span');
      badge.className = 'badge';
      try {
        await t.fn();
        passed++;
        badge.classList.add('pass');
        badge.textContent = 'PASS';
      } catch (err) {
        const msg = err && err.stack ? err.stack : String(err);
        failures.push({ name: t.name, error: err && err.message ? err.message : String(err) });
        row.classList.add('is-fail');
        badge.classList.add('fail');
        badge.textContent = 'FAIL';
        const pre = document.createElement('div');
        pre.className = 'err-msg';
        pre.textContent = msg;
        left.appendChild(pre);
      }
      row.appendChild(left);
      row.appendChild(badge);
      if (resultsEl) resultsEl.appendChild(row);
    }

    const report = {
      total: tests.length,
      passed,
      failed: failures.length,
      failures,
    };
    globalThis.__K4_TEST_RESULTS__ = report;

    if (summaryEl) {
      summaryEl.textContent = `${passed}/${tests.length} passed (${failures.length} failed)`;
      summaryEl.className = `summary ${failures.length === 0 ? 'pass' : 'fail'}`;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { void runAll(); });
  } else {
    void runAll();
  }
})();
