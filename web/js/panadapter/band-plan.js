'use strict';

(() => {
  const K4 = (globalThis.K4 = globalThis.K4 || {});

  const CATEGORIES = {
    CW: { id: 'CW', label: 'CW', color: '#38BDF8' },
    Digital: { id: 'Digital', label: 'Digital', color: '#A78BFA' },
    SSB: { id: 'SSB', label: 'Phone / SSB', color: '#10B981' },
    Beacon: { id: 'Beacon', label: 'Beacons', color: '#F59E0B' },
  };

  const FALLBACK_BANDS = [
    { bn: '00', id: '160m', label: '160m', defaultHz: 1840000, startHz: 1800000, endHz: 2000000 },
    { bn: '01', id: '80m', label: '80m', defaultHz: 3573000, startHz: 3500000, endHz: 4000000 },
    { bn: '02', id: '60m', label: '60m', defaultHz: 5357000, startHz: 5330500, endHz: 5405000 },
    { bn: '03', id: '40m', label: '40m', defaultHz: 7074000, startHz: 7000000, endHz: 7300000 },
    { bn: '04', id: '30m', label: '30m', defaultHz: 10136000, startHz: 10100000, endHz: 10150000 },
    { bn: '05', id: '20m', label: '20m', defaultHz: 14074000, startHz: 14000000, endHz: 14350000 },
    { bn: '06', id: '17m', label: '17m', defaultHz: 18100000, startHz: 18068000, endHz: 18168000 },
    { bn: '07', id: '15m', label: '15m', defaultHz: 21074000, startHz: 21000000, endHz: 21450000 },
    { bn: '08', id: '12m', label: '12m', defaultHz: 24915000, startHz: 24890000, endHz: 24990000 },
    { bn: '09', id: '10m', label: '10m', defaultHz: 28074000, startHz: 28000000, endHz: 29700000 },
    { bn: '10', id: '6m', label: '6m', defaultHz: 50313000, startHz: 50000000, endHz: 54000000 },
  ];

  function seg(band, startHz, endHz, mode, label) {
    const cat = CATEGORIES[mode] || CATEGORIES.CW;
    return {
      band,
      startHz,
      endHz,
      mode: cat.id,
      label,
      color: cat.color,
    };
  }

  /** IARU Region 2 HF + 6m segment metadata ordered ascending by frequency. */
  const SEGMENTS = [
    // 160m (1.800 - 2.000 MHz)
    seg('160m', 1800000, 1810000, 'Digital', '160m Digital / CW'),
    seg('160m', 1810000, 1838000, 'CW', '160m CW'),
    seg('160m', 1838000, 1843000, 'Digital', '160m Narrowband Digital / FT8'),
    seg('160m', 1843000, 2000000, 'SSB', '160m Phone / SSB'),

    // 80m (3.500 - 4.000 MHz)
    seg('80m', 3500000, 3570000, 'CW', '80m CW'),
    seg('80m', 3570000, 3600000, 'Digital', '80m Digital (FT8 / RTTY / PSK)'),
    seg('80m', 3600000, 4000000, 'SSB', '80m Phone / LSB'),

    // 60m (5.3305 - 5.405 MHz)
    seg('60m', 5330500, 5351500, 'SSB', '60m Channelized USB'),
    seg('60m', 5351500, 5354000, 'CW', '60m CW / Narrowband'),
    seg('60m', 5354000, 5366000, 'Digital', '60m Digital (FT8 5357)'),
    seg('60m', 5366000, 5405000, 'SSB', '60m Phone / USB'),

    // 40m (7.000 - 7.300 MHz)
    seg('40m', 7000000, 7040000, 'CW', '40m CW'),
    seg('40m', 7040000, 7125000, 'Digital', '40m Digital (FT8 / RTTY / PSK)'),
    seg('40m', 7125000, 7300000, 'SSB', '40m Phone / LSB'),

    // 30m (10.100 - 10.150 MHz)
    seg('30m', 10100000, 10130000, 'CW', '30m CW'),
    seg('30m', 10130000, 10150000, 'Digital', '30m Digital (FT8 / RTTY)'),

    // 20m (14.000 - 14.350 MHz)
    seg('20m', 14000000, 14070000, 'CW', '20m CW'),
    seg('20m', 14070000, 14099000, 'Digital', '20m Digital (FT8 / RTTY / PSK)'),
    seg('20m', 14099000, 14101000, 'Beacon', '20m IBP / NCDXF Beacons'),
    seg('20m', 14101000, 14112000, 'Digital', '20m Digital / Data'),
    seg('20m', 14112000, 14350000, 'SSB', '20m Phone / USB'),

    // 17m (18.068 - 18.168 MHz)
    seg('17m', 18068000, 18095000, 'CW', '17m CW'),
    seg('17m', 18095000, 18109000, 'Digital', '17m Digital (FT8 / RTTY)'),
    seg('17m', 18109000, 18111000, 'Beacon', '17m IBP / NCDXF Beacons'),
    seg('17m', 18111000, 18168000, 'SSB', '17m Phone / USB'),

    // 15m (21.000 - 21.450 MHz)
    seg('15m', 21000000, 21070000, 'CW', '15m CW'),
    seg('15m', 21070000, 21149000, 'Digital', '15m Digital (FT8 / RTTY)'),
    seg('15m', 21149000, 21151000, 'Beacon', '15m IBP / NCDXF Beacons'),
    seg('15m', 21151000, 21450000, 'SSB', '15m Phone / USB'),

    // 12m (24.890 - 24.990 MHz)
    seg('12m', 24890000, 24915000, 'CW', '12m CW'),
    seg('12m', 24915000, 24929000, 'Digital', '12m Digital (FT8 / RTTY)'),
    seg('12m', 24929000, 24931000, 'Beacon', '12m IBP / NCDXF Beacons'),
    seg('12m', 24931000, 24990000, 'SSB', '12m Phone / USB'),

    // 10m (28.000 - 29.700 MHz)
    seg('10m', 28000000, 28070000, 'CW', '10m CW'),
    seg('10m', 28070000, 28190000, 'Digital', '10m Digital (FT8 / RTTY)'),
    seg('10m', 28190000, 28300000, 'Beacon', '10m IBP & Propagation Beacons'),
    seg('10m', 28300000, 29700000, 'SSB', '10m Phone / SSB / FM'),

    // 6m (50.000 - 54.000 MHz)
    seg('6m', 50000000, 50060000, 'CW', '6m CW / Weak Signal'),
    seg('6m', 50060000, 50080000, 'Beacon', '6m Propagation Beacons'),
    seg('6m', 50080000, 50100000, 'CW', '6m CW'),
    seg('6m', 50100000, 50300000, 'SSB', '6m SSB DX Calling'),
    seg('6m', 50300000, 50400000, 'Digital', '6m Digital (FT8 50.313)'),
    seg('6m', 50400000, 54000000, 'SSB', '6m Phone / AM / FM'),
  ];

  function getSegmentsInRange(lowHz, highHz) {
    if (!Number.isFinite(lowHz) || !Number.isFinite(highHz) || highHz <= lowHz) {
      return [];
    }
    const out = [];
    for (let i = 0; i < SEGMENTS.length; i++) {
      const s = SEGMENTS[i];
      if (s.endHz <= lowHz) continue;
      if (s.startHz >= highHz) break;
      out.push(s);
    }
    return out;
  }

  function findSegmentAt(freqHz) {
    if (!Number.isFinite(freqHz)) return null;
    for (let i = 0; i < SEGMENTS.length; i++) {
      const s = SEGMENTS[i];
      if (freqHz >= s.startHz && freqHz < s.endHz) {
        return s;
      }
    }
    for (let i = 0; i < SEGMENTS.length; i++) {
      const s = SEGMENTS[i];
      if (freqHz === s.endHz) {
        return s;
      }
    }
    return null;
  }

  function getBandForFreq(freqHz) {
    if (!Number.isFinite(freqHz)) return null;
    const bands = Array.isArray(K4.BANDS) && K4.BANDS.length ? K4.BANDS : FALLBACK_BANDS;
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      if (freqHz >= b.startHz && freqHz <= b.endHz) {
        return b;
      }
    }
    return null;
  }

  function getCategoryColor(mode) {
    const cat = CATEGORIES[mode];
    return cat ? cat.color : '#64748B';
  }

  K4.BandPlan = {
    REGION: 'IARU-R2',
    CATEGORIES,
    SEGMENTS,
    getSegmentsInRange,
    findSegmentAt,
    getBandForFreq,
    getCategoryColor,
  };
})();
