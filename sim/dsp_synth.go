package main

import (
	"encoding/binary"
	"math"
	"math/rand"
)

const (
	PanBinsCount      = 1024
	PanByteOffset     = 162.0
	MiniPanByteOffset = 118.0
	AudioSampleRate   = 12000.0
	K4AudioBasePeak   = 900.0 // 900 / 32768 * 32 = 0.879 (just under 0.9 softClip)
)

type synthSignal struct {
	freqHz     float64
	peakDbm    float64
	sigmaHz    float64
	kind       string // "cw", "ft8", "rtty", "ssb"
	keyRateHz  float64
	shiftHz    float64
	phaseSeed  float64
}

var simSignals = func() []synthSignal {
	sigs := []synthSignal{
		// 20m CW beacon at 14.025 MHz (-58 dBm)
		{freqHz: 14025000, peakDbm: -58, sigmaHz: 75, kind: "cw", keyRateHz: 2.8, phaseSeed: 0.1},
		// 20m RTTY twin FSK peaks around 14.085 MHz (170 Hz shift)
		{freqHz: 14084915, peakDbm: -68, sigmaHz: 65, kind: "rtty", keyRateHz: 6.0, phaseSeed: 0.7},
		{freqHz: 14085085, peakDbm: -68, sigmaHz: 65, kind: "rtty", keyRateHz: 6.0, phaseSeed: 3.84159},
		// 20m SSB voice sideband humps around 14.225 MHz (2.4 kHz wide USB)
		{freqHz: 14225450, peakDbm: -74, sigmaHz: 180, kind: "ssb", keyRateHz: 1.7, phaseSeed: 0.3},
		{freqHz: 14226000, peakDbm: -70, sigmaHz: 280, kind: "ssb", keyRateHz: 2.3, phaseSeed: 1.4},
		{freqHz: 14226700, peakDbm: -72, sigmaHz: 320, kind: "ssb", keyRateHz: 3.1, phaseSeed: 2.6},
		{freqHz: 14227350, peakDbm: -76, sigmaHz: 210, kind: "ssb", keyRateHz: 2.9, phaseSeed: 4.1},
		// 40m CW beacon at 7.025 MHz (-60 dBm)
		{freqHz: 7025000, peakDbm: -60, sigmaHz: 75, kind: "cw", keyRateHz: 2.5, phaseSeed: 0.9},
	}
	// 20m FT8 multi-tone cluster: 14,074,000 - 14,076,500 Hz
	ft8Offsets20m := []float64{250, 460, 710, 940, 1180, 1410, 1660, 1890, 2120, 2380}
	ft8Levels := []float64{-66, -72, -68, -64, -74, -67, -70, -65, -73, -69}
	for i, off := range ft8Offsets20m {
		sigs = append(sigs, synthSignal{
			freqHz:    14074000 + off,
			peakDbm:   ft8Levels[i],
			sigmaHz:   60,
			kind:      "ft8",
			keyRateHz: 0.4 + 0.11*float64(i%4),
			phaseSeed: float64(i) * 0.85,
		})
	}
	// 40m FT8 multi-tone cluster: 7,074,000 - 7,076,500 Hz
	for i, off := range ft8Offsets20m {
		sigs = append(sigs, synthSignal{
			freqHz:    7074000 + off,
			peakDbm:   ft8Levels[i] - 2,
			sigmaHz:   60,
			kind:      "ft8",
			keyRateHz: 0.45 + 0.1*float64(i%3),
			phaseSeed: float64(i)*0.7 + 1.2,
		})
	}
	return sigs
}()

// SpectrumTierKHz picks the smallest K4 hardware sample-rate tier covering userSpanHz.
func SpectrumTierKHz(userSpanHz int) int {
	tiers := []int{24, 48, 96, 192, 384}
	for _, t := range tiers {
		if userSpanHz <= t*1000 {
			return t
		}
	}
	return 384
}

// DisplayMarkerHz computes the K4 panadapter center RF frequency for rxState.
func DisplayMarkerHz(freqHz int64, mode int, cwPitchHz int) int64 {
	switch mode {
	case ModeCW:
		return freqHz + int64(cwPitchHz)
	case ModeCWR:
		return freqHz - int64(cwPitchHz)
	default:
		return freqHz
	}
}

// PassbandRangeHz returns the active RF passband [lowHz, highHz] matching Spec 03.
func PassbandRangeHz(rx RxState, cwPitchHz int) (float64, float64) {
	carrier := float64(rx.FreqHz)
	bw := float64(rx.BwHz)
	var center float64
	switch rx.Mode {
	case ModeUSB:
		center = carrier + float64(rx.IfShiftHz)
	case ModeDATA:
		switch rx.DataSubMode {
		case 0: // DATA-A
			center = carrier + float64(rx.IfShiftHz)
		case 1, 2: // AFSK-A, FSK-D
			center = carrier - 85
		default: // PSK-D
			center = carrier
		}
	case ModeDATAR:
		switch rx.DataSubMode {
		case 1, 2:
			center = carrier + 85
		default:
			center = carrier - float64(rx.IfShiftHz)
		}
	case ModeLSB:
		center = carrier - float64(rx.IfShiftHz)
	case ModeCW:
		shift := rx.IfShiftHz
		if shift == 0 {
			shift = cwPitchHz
		}
		center = carrier + float64(shift)
	case ModeCWR:
		shift := rx.IfShiftHz
		if shift == 0 {
			shift = cwPitchHz
		}
		center = carrier - float64(shift)
	default:
		center = carrier
	}
	return center - bw/2.0, center + bw/2.0
}

func signalEnvelope(sig synthSignal, tSec float64) float64 {
	switch sig.kind {
	case "cw":
		// Smooth Morse-like keying envelope keeping strong average energy
		w := 0.55 + 0.45*math.Sin(2*math.Pi*sig.keyRateHz*tSec+sig.phaseSeed) +
			0.25*math.Cos(2*math.Pi*sig.keyRateHz*1.7*tSec+sig.phaseSeed)
		if w < 0.15 {
			return 0.08
		}
		if w > 1.0 {
			return 1.0
		}
		return w
	case "rtty":
		s := math.Sin(2*math.Pi*sig.keyRateHz*tSec + sig.phaseSeed)
		if s >= 0 {
			return 1.0
		}
		return 0.15
	case "ssb":
		m := 0.55 + 0.35*math.Sin(2*math.Pi*sig.keyRateHz*tSec+sig.phaseSeed) +
			0.15*math.Sin(2*math.Pi*sig.keyRateHz*2.3*tSec)
		if m < 0.1 {
			m = 0.1
		}
		return m
	case "ft8":
		// FT8 active for ~12.6s of each 15s cycle; keep most tones visible continuously
		cycle := math.Mod(tSec+sig.phaseSeed*3.0, 15.0)
		if cycle > 13.8 {
			return 0.12
		}
		return 0.85 + 0.15*math.Sin(2*math.Pi*0.7*tSec+sig.phaseSeed)
	default:
		return 1.0
	}
}

func dbmToMw(dbm float64) float64 {
	return math.Pow(10.0, dbm/10.0)
}

func mwToDbm(mw float64) float64 {
	if mw < 1e-18 {
		return -180.0
	}
	return 10.0 * math.Log10(mw)
}

func clampByteDbm(dbm, offset float64) uint8 {
	v := math.Round(dbm + offset)
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return uint8(v)
}

func synthBins(centerHz int64, totalSpanHz float64, byteOffset float64, tSec float64, rng *rand.Rand) []byte {
	bins := make([]byte, PanBinsCount)
	baseNoiseDbm := -120.0
	binWidthHz := totalSpanHz / float64(PanBinsCount-1)
	startHz := float64(centerHz) - totalSpanHz/2.0
	endHz := startHz + totalSpanHz

	// Pre-filter signals intersecting this window
	var active []synthSignal
	var activeEnv []float64
	for _, s := range simSignals {
		margin := math.Max(s.sigmaHz*5.0, binWidthHz*4.0)
		if s.freqHz >= startHz-margin && s.freqHz <= endHz+margin {
			active = append(active, s)
			activeEnv = append(activeEnv, signalEnvelope(s, tSec))
		}
	}

	for i := 0; i < PanBinsCount; i++ {
		f := startHz + float64(i)*binWidthHz
		noiseDbm := baseNoiseDbm + (rng.Float64()*4.0 - 2.0)
		mw := dbmToMw(noiseDbm)

		for j, s := range active {
			sigma := math.Max(s.sigmaHz, binWidthHz*0.9)
			df := f - s.freqHz
			if math.Abs(df) > sigma*5.0 {
				continue
			}
			g := math.Exp(-0.5 * (df * df) / (sigma * sigma))
			sigDbm := s.peakDbm + 10.0*math.Log10(math.Max(0.05, activeEnv[j]))
			mw += dbmToMw(sigDbm) * g
		}
		bins[i] = clampByteDbm(mwToDbm(mw), byteOffset)
	}
	return bins
}

// SynthPAN builds a 1024-bin 0x02 PAN spectrum around rx's display center.
func SynthPAN(rx RxState, cwPitchHz int, tSec float64, rng *rand.Rand) (centerHz int64, tierKHz int32, noiseFloorRaw int32, bins []byte) {
	centerHz = DisplayMarkerHz(rx.FreqHz, rx.Mode, cwPitchHz)
	tier := SpectrumTierKHz(rx.PanSpanHz)
	tierKHz = int32(tier)
	noiseFloorRaw = -1200 // -120.0 dBm * 10
	bins = synthBins(centerHz, float64(tier)*1000.0, PanByteOffset, tSec, rng)
	return
}

// SynthMiniPAN builds a 1024-bin 0x03 MiniPAN zoomed loupe spectrum.
func SynthMiniPAN(rx RxState, cwPitchHz int, tSec float64, rng *rand.Rand) (centerHz int64, spanKHz int32, bins []byte) {
	centerHz = DisplayMarkerHz(rx.FreqHz, rx.Mode, cwPitchHz)
	span := rx.PanSpanHz / 1000
	if span > 24 {
		span = 24
	}
	if span < 6 {
		span = 6
	}
	spanKHz = int32(span)
	bins = synthBins(centerHz, float64(span)*1000.0, MiniPanByteOffset, tSec, rng)
	return
}

// MeasurePassbandDbm computes realistic S-meter dBm for signals inside rx's passband.
func MeasurePassbandDbm(rx RxState, cwPitchHz int, tSec float64) int {
	lowHz, highHz := PassbandRangeHz(rx, cwPitchHz)
	mw := dbmToMw(-115.0)
	for _, s := range simSignals {
		margin := s.sigmaHz * 2.5
		if s.freqHz >= lowHz-margin && s.freqHz <= highHz+margin {
			env := signalEnvelope(s, tSec)
			att := 1.0
			if s.freqHz < lowHz {
				d := (lowHz - s.freqHz) / math.Max(1.0, margin)
				att = math.Max(0.0, 1.0-d)
			} else if s.freqHz > highHz {
				d := (s.freqHz - highHz) / math.Max(1.0, margin)
				att = math.Max(0.0, 1.0-d)
			}
			mw += dbmToMw(s.peakDbm) * env * att
		}
	}
	dbm := int(math.Round(mwToDbm(mw)))
	if dbm < -127 {
		return -127
	}
	if dbm > 10 {
		return 10
	}
	return dbm
}

// NearBeacon reports whether rxFreqHz is within 5 kHz of any simulated CW/FT8 beacon.
func NearBeacon(rxFreqHz int64) bool {
	beacons := []int64{14025000, 14074000, 7025000, 7074000}
	for _, b := range beacons {
		diff := rxFreqHz - b
		if diff < 0 {
			diff = -diff
		}
		if diff <= 5000 {
			return true
		}
	}
	return false
}

// AudioSynth maintains continuous oscillator phase across 12 kHz audio packets.
type AudioSynth struct {
	phasesA []float64
	phasesB []float64
	noise   uint64
}

func NewAudioSynth() *AudioSynth {
	return &AudioSynth{
		phasesA: make([]float64, len(simSignals)),
		phasesB: make([]float64, len(simSignals)),
		noise:   0x9e3779b97f4a7c15,
	}
}

func (a *AudioSynth) nextNoise() float64 {
	// xorshift64* fast deterministic noise in [-1, 1]
	x := a.noise
	x ^= x >> 12
	x ^= x << 25
	x ^= x >> 27
	a.noise = x
	v := float64(int64(x*0x2545F4914F6CDD1D)>>40) / float64(1<<23)
	return v
}

func rxAudioFreqHz(rx RxState, rfHz float64) (float64, bool) {
	dial := float64(rx.FreqHz)
	var audioHz float64
	switch rx.Mode {
	case ModeLSB, ModeCWR:
		audioHz = dial - rfHz
	default:
		audioHz = rfHz - dial
	}
	if audioHz < 80 || audioHz > 4200 {
		return 0, false
	}
	return audioHz, true
}

func signalAudioGain(peakDbm float64) float64 {
	// Map -110..-50 dBm to smooth audible amplitude
	norm := (peakDbm + 110.0) / 55.0
	if norm < 0.05 {
		norm = 0.05
	}
	if norm > 1.0 {
		norm = 1.0
	}
	return norm * 0.75
}

// SynthAudio synthesizes 12 kHz stereo PCM audio at K4 1/32 scale (EM1 S16LE or EM0 S32LE).
func (a *AudioSynth) SynthAudio(rxA, rxB RxState, subRxEnabled bool, cwPitchHz int, encodeMode uint8, samplesPerCh int, tSec float64) []byte {
	type activeTone struct {
		idx     int
		audioHz float64
		amp     float64
	}
	lowA, highA := PassbandRangeHz(rxA, cwPitchHz)
	var tonesA []activeTone
	for idx, s := range simSignals {
		if s.freqHz >= lowA-150 && s.freqHz <= highA+150 {
			if af, ok := rxAudioFreqHz(rxA, s.freqHz); ok {
				tonesA = append(tonesA, activeTone{
					idx:     idx,
					audioHz: af,
					amp:     signalAudioGain(s.peakDbm) * signalEnvelope(s, tSec),
				})
			}
		}
	}

	var tonesB []activeTone
	if subRxEnabled {
		lowB, highB := PassbandRangeHz(rxB, cwPitchHz)
		for idx, s := range simSignals {
			if s.freqHz >= lowB-150 && s.freqHz <= highB+150 {
				if af, ok := rxAudioFreqHz(rxB, s.freqHz); ok {
					tonesB = append(tonesB, activeTone{
						idx:     idx,
						audioHz: af,
						amp:     signalAudioGain(s.peakDbm) * signalEnvelope(s, tSec),
					})
				}
			}
		}
	}

	bytesPerFrame := 4
	if encodeMode == 0 {
		bytesPerFrame = 8
	}
	out := make([]byte, samplesPerCh*bytesPerFrame)

	for i := 0; i < samplesPerCh; i++ {
		sampleA := a.nextNoise() * 0.04
		for _, t := range tonesA {
			sampleA += math.Sin(a.phasesA[t.idx]) * t.amp
			a.phasesA[t.idx] += 2.0 * math.Pi * t.audioHz / AudioSampleRate
			if a.phasesA[t.idx] > 2.0*math.Pi {
				a.phasesA[t.idx] -= 2.0 * math.Pi
			}
		}

		var sampleB float64
		if subRxEnabled {
			sampleB = a.nextNoise() * 0.04
			for _, t := range tonesB {
				sampleB += math.Sin(a.phasesB[t.idx]) * t.amp
				a.phasesB[t.idx] += 2.0 * math.Pi * t.audioHz / AudioSampleRate
				if a.phasesB[t.idx] > 2.0*math.Pi {
					a.phasesB[t.idx] -= 2.0 * math.Pi
				}
			}
		}

		// Scale at K4 1/32 amplitude (~900 peak in S16LE)
		valA := int32(math.Round(clampFloat(sampleA, -1.0, 1.0) * K4AudioBasePeak))
		valB := int32(math.Round(clampFloat(sampleB, -1.0, 1.0) * K4AudioBasePeak))

		if encodeMode == 0 {
			off := i * 8
			binary.LittleEndian.PutUint32(out[off:off+4], uint32(valA<<8))
			binary.LittleEndian.PutUint32(out[off+4:off+8], uint32(valB<<8))
		} else {
			off := i * 4
			binary.LittleEndian.PutUint16(out[off:off+2], uint16(int16(valA)))
			binary.LittleEndian.PutUint16(out[off+2:off+4], uint16(int16(valB)))
		}
	}
	return out
}

func clampFloat(x, lo, hi float64) float64 {
	if x < lo {
		return lo
	}
	if x > hi {
		return hi
	}
	return x
}
