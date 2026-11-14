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
    const wfRow = K4.WaterfallRowMapper.mapRow(new Float32Array([-200, -50, 0]), {
      refDbm: -50,
      scaleDb: 80,
      wfBlack: 14,
    });
    assertEqual(wfRow[0], 1, 'Waterfall min bin mapped to 1 (never 0)');
    assertEqual(wfRow[1], 255, 'Waterfall ref bin mapped to 255');
    assertEqual(wfRow[2], 255, 'Waterfall clipped max bin mapped to 255');

    // Varying WBS (wfBlack 5 vs 30) shifts black-level floor while staying within 1..255
    const sampleBins = new Float32Array([-200, -75, -55, 0]);
    const wfWbs5 = K4.WaterfallRowMapper.mapRow(sampleBins, { refDbm: -50, scaleDb: 80, wfBlack: 5 });
    const wfWbs30 = K4.WaterfallRowMapper.mapRow(sampleBins, { refDbm: -50, scaleDb: 80, wfBlack: 30 });
    assertEqual(wfWbs5[0], 1, 'WBS=5 clamps floor bin to 1');
    assertEqual(wfWbs30[0], 1, 'WBS=30 clamps floor bin to 1');
    assertEqual(wfWbs5[3], 255, 'WBS=5 clamps max bin to 255');
    assertEqual(wfWbs30[3], 255, 'WBS=30 clamps max bin to 255');
    assertEqual(wfWbs5[1], 1, 'WBS=5 maps -75 dBm (below -60 floor) to 1');
    assert(wfWbs30[1] > wfWbs5[1] && wfWbs30[1] < 255, 'WBS=30 widens dynamic range at -75 dBm');
    assert(wfWbs30[2] > wfWbs5[2] && wfWbs30[2] < 255, 'WBS=30 raises normalized brightness at -55 dBm');
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
