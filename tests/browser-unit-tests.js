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
  test('RxOnlyGate blocks TX/tune/keyer/PC/SW and allows RX/display/audio', () => {
    const K4 = globalThis.K4;
    const gate = new K4.RxOnlyGate('rx-only');
    const blockedEvents = [];
    gate.on('blocked', (ev) => blockedEvents.push(ev));

    const mixed = gate.inspectCat('FA00014074000;MD3;TX;TU1;KY CQ;PC050;SW01;SW10;SP1;RX;SP0;#SPN48000;MXA.B;');
    assertDeepEqual(mixed.allowed, [
      'FA00014074000;',
      'MD3;',
      'RX;',
      'SP0;',
      '#SPN48000;',
      'MXA.B;',
    ], 'allowed RX commands');
    assertDeepEqual(mixed.blocked, [
      'TX;',
      'TU1;',
      'KY CQ;',
      'PC050;',
      'SW01;',
      'SW10;',
      'SP1;',
    ], 'blocked TX commands');
    assertEqual(mixed.sanitized, 'FA00014074000;MD3;RX;SP0;#SPN48000;MXA.B;', 'sanitized CAT');

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
      'SP;',
      'SP$3;',
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
      'D4 blocks bare SP/SP$, SET AN/FT/ID, RRP, TS, VC$'
    );
    assertEqual(blockedRes.sanitized, '', 'D4 blocked batch sanitized empty');

    const allowedCmds = [
      'SP0;',
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
    assertDeepEqual(allowedRes.blocked, [], 'D4 allowed GET/RX/display/pan commands must not be blocked');
    assertDeepEqual(allowedRes.allowed, allowedCmds, 'D4 allows SP0, GET AN/FT/FT0/ID/OM/SN/RV/IF/TQ/PP/PP05, VC, DV, FC, #FRZ, #FXT, RT$, RO$');

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
      inspector.selectDesktopTab('display');
      let s = inspState.getSnapshot();
      inspector.update(s);
      assertEqual(inspector._refs.dispBadge.textContent, 'PAN A', 'Single-Pan Main shows PAN A badge even when targetRx=B');
      assertEqual(inspector._refs.dpmBtns[1].disabled, true, '1x Sub (B) disabled when OM lacks S');
      assertEqual(inspector._refs.dpmBtns[2].disabled, true, '2x Dual disabled when OM lacks S');
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
