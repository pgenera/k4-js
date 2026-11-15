package main

import (
	"encoding/binary"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
)

const (
	ModeLSB   = 1
	ModeUSB   = 2
	ModeCW    = 3
	ModeFM    = 4
	ModeAM    = 5
	ModeDATA  = 6
	ModeCWR   = 7
	ModeDATAR = 9
)

var StepHzTable = [7]int{1, 10, 100, 1000, 2500, 5000, 10000}
var SLFramesTable = [8]int{1, 2, 2, 3, 3, 3, 6, 6}

var bandDefaults = map[int]int64{
	0:  1840000,
	1:  3573000,
	2:  5357000,
	3:  7074000,
	4:  10136000,
	5:  14074000,
	6:  18100000,
	7:  21074000,
	8:  24915000,
	9:  28074000,
	10: 50313000,
}

var validAudioMixes = map[string]bool{
	"A.B":   true,
	"AB.AB": true,
	"A.-A":  true,
	"A.AB":  true,
	"AB.B":  true,
	"AB.A":  true,
	"B.AB":  true,
	"B.B":   true,
	"B.A":   true,
	"A.A":   true,
}

var permanentBlockedPrefixes = []string{
	"DARM", "DARS", "DAPM", "DAMP", "DARC",
	"#TX", "MOX", "VOX", "SWT", "SWH",
	"SP1", "SP2", "SP3",
	"RRP", "RRC", "RRT",
	"#CAL", "EE", "LB", "WM", "PS", "RS", "EC", "SW",
}

const (
	omOptionModuleStr    = "OM AP-S----4---;"
	autoRefNoiseFloorDbm = -115
	rvModulesStr         = "RV.DDC0-00.65 (0:35);RV.DUC-00.45 (1:18);RV.FP-03.57;RV.DSP-01.69;RV.RFB-00.78;RV.REF-00.20;RV.DAP-00.29;RV.KSRV-2016;RV.KUI-1801;RV.KUP-646;RV.KCFG-78;RV.R-R40.B1;"
	medfSampleStr     = "MEDF0001,Speaker%2C Internal,AUDIO,BIN,0,0,1,1,0,1,OFF,ON;" +
		"MEDF0002,TX ALC,TX,BIN,1,0,1,1,1,1,OFF,ON;" +
		"MEDF0004,KAT4 ATU Option,TX,DEC,1,0,3,2,2,1,NOT_INST,BYPASS,AUTO,TEST;" +
		"MEDF0005,KRX4 2ND RX Option,RX,BIN,1,0,1,0,0,1,NOT_INST,ENABLED;" +
		"MEDF0006,KPA4 PA Option,TX,DEC,1,0,2,2,2,1,NOT_INST,BYPASS,ENABLED;" +
		"MEDF0034,Radio Type,SYSTEM,DEC,2,0,2,0,0,1,K4,K4D,K4HD;" +
		"MEDF0105,RX Audio Mix with Sub ON,RX,DEC,1,0,9,0,0,1,L=A%2CR=B,L=AB%2CR=AB,L=A%2CR=-A,L=A%2CR=AB,L=AB%2CR=B,L=AB%2CR=A,L=B%2CR=AB,L=B%2CR=B,L=B%2CR=A,L=A%2CR=A,;" +
		"MEDF0113,RX Audio Gain Boost,RX,DEC,1,-10,6,0,0,1;" +
		"MEDF0000;"
)

type RxState struct {
	FreqHz            int64
	Mode              int
	DataSubMode       int
	BwHz              int
	IfShiftHz         int
	StepIdx           int
	StepMode          int
	Locked            bool
	Preamp            int
	PreampOn          bool
	AttenDb           int
	AttenOn           bool
	AfGain            int
	RfGainDb          int
	Squelch           int
	NbOn              bool
	NbLevel           int
	NrOn              bool
	NrLevel           int
	NotchOn           bool
	NotchHz           int
	Agc               int
	ApfOn             bool
	ApfBwIdx          int
	PanSpanHz         int
	PanTierKHz        int
	PanRefDbm         int
	PanScaleDb        int
	WfBlack             int
	AutoRef             bool
	FixedTune           bool
	MiniPan             bool
	PanNbMode           int
	PanNbLevel          int
	RitOn               bool
	RitOffsetHz         int
	PanCenterOffsetHz   int64
	TextDecodeMode      int
	TextDecodeThreshold int
	TextDecodeLines     int
}

type atuMatchKey struct {
	Band int
	Ant  int
}

type DebugStats struct {
	TotalConnections    int64   `json:"totalConnections"`
	AuthPassed          int64   `json:"authPassed"`
	AuthFailed          int64   `json:"authFailed"`
	TxBlockedViolations int64   `json:"txBlockedViolations"`
	LastBlockedTxCmd    string  `json:"lastBlockedTxCmd"`
	FaHz                int64   `json:"faHz"`
	FbHz                int64   `json:"fbHz"`
	ModeA               int     `json:"modeA"`
	ModeB               int     `json:"modeB"`
	TxCatCommands       int64   `json:"txCatCommands"`
	TxAudioPacketsIn    int64   `json:"txAudioPacketsIn"`
	TxActive            bool    `json:"txActive"`
	TxTestMode          bool    `json:"txTestMode"`
	AtuTuning           bool    `json:"atuTuning"`
	AtuMatched          bool    `json:"atuMatched"`
	LastFwdTenthsW      int     `json:"lastFwdTenthsW"`
	LastSwrTenths       int     `json:"lastSwrTenths"`
	LastAlcBars         int     `json:"lastAlcBars"`
	PowerWatts          float64 `json:"powerWatts"`
	PowerRange          string  `json:"powerRange"`
	TxAntenna           int     `json:"txAntenna"`
	AtuMode             int     `json:"atuMode"`
	OptionModules       string  `json:"optionModules"`
}

type Radio struct {
	mu sync.Mutex

	AllowTx       bool
	OptionModules string

	RxA                RxState
	RxB                RxState
	CwPitchHz          int
	SubRxEnabled       bool
	SplitEnabled       bool
	VfoLinked          bool
	PanAvg             int
	DualPanMode        int
	DiversityEnabled   bool
	PanFrozen          bool
	PanFPS             int
	DisplayMode        int
	WaterfallHeightPct int
	SiFpEnabled        bool
	SiRfEnabled        bool
	SiDaEnabled        bool
	SiDuEnabled        bool
	SiRcEnabled        bool
	AudioMix           string
	EncodeMode         int
	StreamingLatency   int
	AiMode             int
	ErMode             int
	K4Mode             int

	// TX / ATU / Keyer / Voice state
	TxActive         bool
	TxTestMode       bool
	TxInhibit        bool
	TmEnabled        bool
	PoEnabled        bool
	PowerWatts       float64
	PowerRange       string
	AtuMode          int
	AtuTuning        bool
	AtuTuneKind      int
	AtuTuneStartedAt float64
	AtuMatched       map[atuMatchKey]int
	TxAntenna        int
	TxAntennaShowAll bool
	TxAntennaMask    [3]bool
	AntennaNames     [6]string
	XitEnabled       bool
	MicGain          int
	CompLevel        int
	TxMonitor        [3]int
	MicInput         int
	MicSetup         string
	EssbEnabled      bool
	EssbBw100Hz      int
	DwRaw            string
	TxEq             string
	VoxCw            bool
	VoxVoice         bool
	VoxData          bool
	VoxGainVoice     int
	VoxGainData      int
	AntiVox          int
	QskFull          bool
	VoxDelayMode     byte
	VoxDelay10Ms     int
	DvrSlot          int
	CwSpeedWpm       int
	KeyerIambic      byte
	KeyerOrder       byte
	KeyerWeight      int
	KyQueue          string
	KyLastDrainAt    float64
	KyKeying         bool
	TxAudioEnv       float64
	TxAudioLastAt    float64
	TxStartedAt      float64

	// Electrical & thermal physics state
	PaTempC         float64
	LpaTempC        float64
	FpTempC         float64
	DucTempC        float64
	DapTempC        float64
	LastPhysicsTSec float64

	TotalConnections    int64
	AuthPassed          int64
	AuthFailed          int64
	TxBlockedViolations int64
	LastBlockedTxCmd    string
	TxCatCommands       int64
	TxAudioPacketsIn    int64
	LastFwdTenthsW      int
	LastSwrTenths       int
	LastAlcBars         int
}

func NewRadio() *Radio {
	baseA := RxState{
		FreqHz:      14074000,
		Mode:        ModeDATA,
		DataSubMode: 0,
		BwHz:        2700,
		IfShiftHz:   1500,
		StepIdx:     1,
		StepMode:    6,
		Preamp:      0,
		AttenDb:     0,
		AfGain:      30,
		RfGainDb:    0,
		Squelch:     0,
		NbLevel:     0,
		NrLevel:     4,
		NotchHz:     750,
		Agc:         1,
		PanSpanHz:           48000,
		PanTierKHz:          SpectrumTierKHzWithHysteresis(48000, 0),
		PanRefDbm:           autoRefNoiseFloorDbm,
		PanScaleDb:          80,
		WfBlack:             14,
		AutoRef:             true,
		FixedTune:           false,
		TextDecodeMode:      2,
		TextDecodeThreshold: 0,
		TextDecodeLines:     1,
	}
	baseB := baseA
	baseB.FreqHz = 14025000
	baseB.Mode = ModeCW
	baseB.BwHz = 500
	baseB.IfShiftHz = 500
	baseB.StepMode = 3
	baseB.TextDecodeMode = 0
	baseB.TextDecodeThreshold = 2
	baseB.TextDecodeLines = 0

	return &Radio{
		AllowTx:            true,
		OptionModules:      omOptionModuleStr,
		RxA:                baseA,
		RxB:                baseB,
		CwPitchHz:          500,
		SubRxEnabled:       false,
		SplitEnabled:       false,
		VfoLinked:          false,
		PanAvg:             4,
		DualPanMode:        0,
		PanFPS:             20,
		DisplayMode:        1,
		WaterfallHeightPct: 60,
		AudioMix:           "A.B",
		EncodeMode:         1,
		StreamingLatency:   2,
		AiMode:             5,
		ErMode:             1,
		K4Mode:             1,

		TmEnabled:     true,
		PoEnabled:     true,
		PowerWatts:    10.0,
		PowerRange:    "L",
		AtuMode:       2,
		AtuMatched:    make(map[atuMatchKey]int),
		TxAntenna:     1,
		TxAntennaMask: [3]bool{true, true, true},
		AntennaNames:  [6]string{"", "G5RV", "43' vert", "dummy", "RX1", "RX2"},
		MicGain:       15,
		TxMonitor:     [3]int{5, 5, 2},
		MicInput:      4,
		MicSetup:      "00000",
		EssbBw100Hz:   35,
		DwRaw:         "0",
		TxEq:          "+00+00+00+00+00+00+00+00",
		VoxCw:         true,
		VoxGainVoice:  20,
		VoxGainData:   20,
		AntiVox:       10,
		VoxDelayMode:  'C',
		VoxDelay10Ms:  15,
		CwSpeedWpm:    20,
		KeyerIambic:   'A',
		KeyerOrder:    'N',
		KeyerWeight:   110,
		PaTempC:       25.0,
		LpaTempC:      24.0,
		FpTempC:       25.4,
		DucTempC:      30.8,
		DapTempC:      31.2,
	}
}

// NewRxOnlyRadio returns a Radio with operational TX commands disabled for strict RX-only mode.
func NewRxOnlyRadio() *Radio {
	r := NewRadio()
	r.AllowTx = false
	return r
}

// SetModel configures option modules for "k4" (no KRX4), "k4d" (KRX4), or "k4hd" (KRX4+KHDR4).
func (r *Radio) SetModel(model string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	switch strings.ToLower(strings.TrimSpace(model)) {
	case "k4":
		r.OptionModules = "OM AP------4---;"
		r.DiversityEnabled = false
	case "k4hd":
		r.OptionModules = "OM AP-SH---4---;"
	default:
		r.OptionModules = omOptionModuleStr
	}
}

func (r *Radio) hasKrx4Locked() bool {
	body := strings.TrimSpace(strings.TrimPrefix(r.OptionModules, "OM"))
	return strings.Contains(strings.ToUpper(body), "S")
}

func (r *Radio) RecordConnectionAttempt() {
	r.mu.Lock()
	r.TotalConnections++
	r.mu.Unlock()
}

func (r *Radio) RecordAuthResult(passed bool) {
	r.mu.Lock()
	if passed {
		r.AuthPassed++
	} else {
		r.AuthFailed++
	}
	r.mu.Unlock()
}

func (r *Radio) Snapshot() (rxA, rxB RxState, subRx bool, cwPitchHz int, encodeMode int, sl int, dualPan int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.RxA, r.RxB, r.SubRxEnabled, r.CwPitchHz, r.EncodeMode, r.StreamingLatency, r.DualPanMode
}

func (r *Radio) PanStreamState() (fps int, frozen bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	fps = r.PanFPS
	if fps < 1 {
		fps = 1
	} else if fps > 30 {
		fps = 30
	}
	return fps, r.PanFrozen
}

func adcOverflowLocked(rx RxState) int {
	if rx.Preamp >= 2 && rx.AttenDb == 0 && rx.RfGainDb >= 0 {
		return 1
	}
	return 0
}

func (r *Radio) OverflowStatus() (ovA int, ovB int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return adcOverflowLocked(r.RxA), adcOverflowLocked(r.RxB)
}

func (r *Radio) IsTxOrAtuActive() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.TxActive || r.AtuTuning
}

// ForceRx clears any active TX/ATU/DVR/keyer state safely (used on last socket disconnect).
func (r *Radio) ForceRx() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.TxActive = false
	r.AtuTuning = false
	r.AtuTuneKind = 0
	r.DvrSlot = 0
	r.KyQueue = ""
	r.KyKeying = false
	r.TxAudioEnv = 0
}

func (r *Radio) txVfoLocked() *RxState {
	if r.SplitEnabled {
		return &r.RxB
	}
	return &r.RxA
}

func rawUnmatchedSwrTenths(band, ant int) int {
	if ant == 3 {
		return 10
	}
	ant1Swr := [11]int{32, 27, 29, 28, 31, 28, 26, 29, 30, 27, 32}
	ant2Swr := [11]int{29, 26, 30, 27, 28, 31, 29, 26, 30, 28, 32}
	idx := clampInt(band, 0, 10)
	if ant == 2 {
		return ant2Swr[idx]
	}
	return ant1Swr[idx]
}

func (r *Radio) isCurrentBandAntMatchedLocked() bool {
	if r.TxAntenna == 3 {
		return true
	}
	band := bandCodeForFreq(r.txVfoLocked().FreqHz)
	swr, ok := r.AtuMatched[atuMatchKey{Band: band, Ant: r.TxAntenna}]
	return ok && swr <= 13
}

func (r *Radio) atuTargetDurationSec() float64 {
	if r.AtuTuneKind == 4 {
		return 1.15
	}
	return 1.05
}

func (r *Radio) currentLoadSwrTenthsLocked(tSec float64) int {
	band := bandCodeForFreq(r.txVfoLocked().FreqHz)
	raw := rawUnmatchedSwrTenths(band, r.TxAntenna)
	if r.AtuTuning && (r.AtuTuneKind == 3 || r.AtuTuneKind == 4) {
		target := 11
		if r.TxAntenna == 3 {
			target = 10
		}
		elapsed := clampFloat(tSec-r.AtuTuneStartedAt, 0.0, r.atuTargetDurationSec())
		progress := elapsed / r.atuTargetDurationSec()
		cur := raw - int(math.Round(float64(raw-target)*progress))
		return clampInt(cur, target, raw)
	}
	if r.AtuMode == 1 {
		return raw
	}
	if swr, ok := r.AtuMatched[atuMatchKey{Band: band, Ant: r.TxAntenna}]; ok {
		return swr
	}
	return raw
}

func (r *Radio) nominalTxMaxWattsLocked() float64 {
	if r.PowerRange == "X" {
		return r.PowerWatts * 0.001
	}
	return r.PowerWatts
}

func (r *Radio) effectiveAudioEnvLocked(tSec float64) float64 {
	if r.TxAudioEnv <= 0 {
		return 0
	}
	age := tSec - r.TxAudioLastAt
	if age < 0 {
		age = 0
	}
	if age <= 0.12 {
		return r.TxAudioEnv
	}
	if age >= 0.35 {
		return 0
	}
	return r.TxAudioEnv * (1.0 - (age-0.12)/0.23)
}

func (r *Radio) computeTxMetricsLocked(tSec float64) (alcBars, compDb int, fwdWatts float64, swrTenths int) {
	if !(r.TxActive || r.AtuTuning) {
		return 0, 0, 0, 0
	}
	swrTenths = r.currentLoadSwrTenthsLocked(tSec)
	if r.AtuTuning {
		switch r.AtuTuneKind {
		case 3, 4:
			fwdWatts = 18.0
		case 2:
			fwdWatts = 5.0
		default:
			fwdWatts = r.nominalTxMaxWattsLocked()
		}
		if r.TxTestMode {
			fwdWatts = 0.0
			swrTenths = 0
		}
		return 4, 0, fwdWatts, swrTenths
	}

	txRx := r.txVfoLocked()
	maxW := r.nominalTxMaxWattsLocked()
	isCarrier := txRx.Mode == ModeCW || txRx.Mode == ModeCWR || txRx.Mode == ModeFM ||
		((txRx.Mode == ModeDATA || txRx.Mode == ModeDATAR) && txRx.DataSubMode >= 2) ||
		r.KyKeying || r.DvrSlot > 0

	if isCarrier {
		alcBars = 4
		compDb = 0
		fwdWatts = maxW
	} else {
		env := r.effectiveAudioEnvLocked(tSec)
		micFactor := clampFloat(float64(r.MicGain)/15.0, 0.0, 2.0)
		drive := env * micFactor
		if drive <= 0.01 {
			alcBars = 0
			compDb = 0
			if txRx.Mode == ModeAM {
				fwdWatts = maxW * 0.25
			}
		} else {
			modRatio := clampFloat(math.Sqrt(drive/0.65), 0.15, 1.0)
			if r.CompLevel > 0 {
				modRatio = clampFloat(modRatio*(1.0+float64(r.CompLevel)*0.025), 0.0, 1.0)
			}
			switch {
			case drive <= 0.60:
				alcBars = clampInt(1+int(drive/0.15), 1, 4)
			case drive <= 2.50:
				alcBars = clampInt(4+int((drive-0.60)/1.20), 4, 5)
			default:
				alcBars = clampInt(6+int((drive-2.50)/2.50), 6, 7)
			}
			compDb = clampInt(int(math.Round(float64(r.CompLevel)*clampFloat(drive, 0.2, 1.0))), 0, 30)
			fwdWatts = maxW * modRatio
		}
	}

	if r.TxTestMode {
		fwdWatts = 0.0
		swrTenths = 0
	}
	return alcBars, compDb, fwdWatts, swrTenths
}

func (r *Radio) formatTmCmdLocked(alcBars, compDb int, fwdWatts float64, swrTenths int) string {
	fwdRaw := int(math.Round(fwdWatts))
	if r.PowerRange == "L" || r.PowerRange == "X" {
		fwdRaw = int(math.Round(fwdWatts * 10.0))
	}
	return fmt.Sprintf("TM%03d%03d%03d%03d;",
		clampInt(alcBars, 0, 9),
		clampInt(compDb, 0, 30),
		clampInt(fwdRaw, 0, 999),
		clampInt(swrTenths, 0, 999),
	)
}

func (r *Radio) formatPowerLocked(prefix string) string {
	switch r.PowerRange {
	case "H":
		return fmt.Sprintf("%s%03dH;", prefix, clampInt(int(math.Round(r.PowerWatts)), 1, 110))
	case "X":
		return fmt.Sprintf("%s%03dX;", prefix, clampInt(int(math.Round(r.PowerWatts*10.0)), 1, 100))
	default:
		return fmt.Sprintf("%s%03dL;", prefix, clampInt(int(math.Round(r.PowerWatts*10.0)), 1, 100))
	}
}

func (r *Radio) execPowerLocked(prefix, arg string) (string, bool) {
	if arg == "" {
		return r.formatPowerLocked(prefix), false
	}
	rangeCh := "L"
	numStr := arg
	last := arg[len(arg)-1]
	if last == 'L' || last == 'H' || last == 'X' {
		rangeCh = string(last)
		numStr = arg[:len(arg)-1]
	}
	v, err := strconv.Atoi(numStr)
	if err != nil {
		return "?;", false
	}
	r.TxCatCommands++
	r.PowerRange = rangeCh
	switch rangeCh {
	case "H":
		r.PowerWatts = float64(clampInt(v, 1, 110))
	case "X":
		r.PowerWatts = float64(clampInt(v, 1, 100)) / 10.0
	default:
		r.PowerWatts = float64(clampInt(v, 1, 100)) / 10.0
	}
	return r.formatPowerLocked(prefix), true
}

func (r *Radio) updatePhysicsLocked(tSec float64) (volts, supplyAmps, paAmps float64) {
	if tSec < r.LastPhysicsTSec {
		tSec = r.LastPhysicsTSec
	}
	dt := clampFloat(tSec-r.LastPhysicsTSec, 0.0, 5.0)
	r.LastPhysicsTSec = tSec

	_, _, fwdWatts, _ := r.computeTxMetricsLocked(tSec)
	txOn := r.TxActive || r.AtuTuning
	if txOn {
		if r.TxTestMode {
			supplyAmps = 3.20 + 0.03*math.Sin(tSec*1.3)
			paAmps = 0.80
		} else {
			supplyAmps = 3.20 + (fwdWatts/100.0)*15.30
			paAmps = 0.80 + (fwdWatts/100.0)*15.30
		}
	} else {
		supplyAmps = 1.66 + 0.04*math.Cos(tSec*0.7)
		paAmps = 0.0
	}
	sag := math.Max(0.0, supplyAmps-1.66) * (0.75 / 16.84)
	volts = 13.80 - sag + 0.01*math.Sin(tSec*0.4)

	if dt > 0 {
		if txOn {
			targetPA := 25.0 + 4.0 + fwdWatts*0.45
			targetLPA := 24.0 + 3.0 + fwdWatts*0.18
			targetFP := 25.4 + 1.5 + fwdWatts*0.03
			targetDUC := 30.8 + 3.5 + fwdWatts*0.04
			alpha := 1.0 - math.Exp(-0.22*dt)
			r.PaTempC += (targetPA - r.PaTempC) * alpha
			r.LpaTempC += (targetLPA - r.LpaTempC) * alpha
			r.FpTempC += (targetFP - r.FpTempC) * alpha
			r.DucTempC += (targetDUC - r.DucTempC) * alpha
			r.DapTempC += (32.0 - r.DapTempC) * (1.0 - math.Exp(-0.10*dt))
		} else {
			alpha := 1.0 - math.Exp(-0.08*dt)
			r.PaTempC += (25.0 - r.PaTempC) * alpha
			r.LpaTempC += (24.0 - r.LpaTempC) * alpha
			r.FpTempC += (25.4 - r.FpTempC) * alpha
			r.DucTempC += (30.8 - r.DucTempC) * alpha
			r.DapTempC += (31.2 - r.DapTempC) * alpha
		}
	}
	return volts, supplyAmps, paAmps
}

func (r *Radio) drainKeyerLocked(tSec float64) (finished bool) {
	if len(r.KyQueue) == 0 || tSec < r.KyLastDrainAt {
		return false
	}
	charPeriod := 1.2 / float64(clampInt(r.CwSpeedWpm, 8, 100))
	for len(r.KyQueue) > 0 && tSec-r.KyLastDrainAt >= charPeriod {
		r.KyQueue = r.KyQueue[1:]
		r.KyLastDrainAt += charPeriod
	}
	if len(r.KyQueue) == 0 && r.KyKeying {
		r.KyKeying = false
		if !r.AtuTuning {
			r.TxActive = false
		}
		return true
	}
	return false
}

func (r *Radio) advanceAtuLocked(tSec float64) (completed bool, finalSwr int) {
	if !r.AtuTuning || (r.AtuTuneKind != 3 && r.AtuTuneKind != 4) {
		return false, 0
	}
	if tSec-r.AtuTuneStartedAt < r.atuTargetDurationSec() {
		return false, 0
	}
	band := bandCodeForFreq(r.txVfoLocked().FreqHz)
	target := 11
	if r.TxAntenna == 3 {
		target = 10
	}
	r.AtuMatched[atuMatchKey{Band: band, Ant: r.TxAntenna}] = target
	r.LastSwrTenths = target
	r.LastFwdTenthsW = 180
	r.LastAlcBars = 4
	r.AtuTuning = false
	r.AtuTuneKind = 0
	r.TxActive = false
	return true, target
}

func (r *Radio) TxBufferDigitLocked() int {
	return clampInt(len(r.KyQueue), 0, 9)
}

func (r *Radio) TxBufferDigit() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.TxBufferDigitLocked()
}

// HandleInboundAudio parses an incoming framed 0x01 TypeAudio packet and updates TX modulator envelope.
func (r *Radio) HandleInboundAudio(payload []byte, tSec float64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.TxAudioPacketsIn++
	if !r.AllowTx || len(payload) < 9 {
		return
	}
	encodeMode := payload[3]
	audio := payload[7:]
	var sumSq float64
	var nSamples int
	if encodeMode == 0 {
		for i := 0; i+3 < len(audio); i += 4 {
			s := float64(int32(binary.LittleEndian.Uint32(audio[i:i+4])) >> 8)
			sumSq += s * s
			nSamples++
		}
	} else {
		for i := 0; i+1 < len(audio); i += 2 {
			s := float64(int16(binary.LittleEndian.Uint16(audio[i : i+2])))
			sumSq += s * s
			nSamples++
		}
	}
	if nSamples == 0 {
		return
	}
	rmsCounts := math.Sqrt(sumSq / float64(nSamples))
	drive := 0.0
	if rmsCounts >= 15.0 {
		boosted := (rmsCounts / 32768.0) * 32.0
		drive = clampFloat(boosted, 0.0, 4.0)
	}
	prev := r.effectiveAudioEnvLocked(tSec)
	if drive > prev {
		r.TxAudioEnv = drive
	} else {
		r.TxAudioEnv = prev
	}
	r.TxAudioLastAt = tSec
}

func (r *Radio) advanceAsyncCompletionLocked(tSec float64) string {
	kyDone := r.drainKeyerLocked(tSec)
	atuDone, finalSwr := r.advanceAtuLocked(tSec)

	var sb strings.Builder
	if atuDone {
		if r.TxTestMode {
			sb.WriteString(r.formatTmCmdLocked(4, 0, 0.0, 0))
			sb.WriteString("PO0000;TU0;TQ0;TQX0;TM000000000000;PO0000;")
		} else {
			sb.WriteString(r.formatTmCmdLocked(4, 0, 18.0, finalSwr))
			sb.WriteString("PO0180;TU0;TQ0;TQX0;TM000000000000;PO0000;")
		}
	}
	if kyDone {
		r.LastFwdTenthsW = 0
		r.LastSwrTenths = 0
		r.LastAlcBars = 0
		sb.WriteString("TB000;KY0;TQ0;TQX0;TM000000000000;PO0000;")
	}
	return sb.String()
}

// StepTx advances ATU convergence, CW keyer drain, electrical/thermal physics, and emits 10 Hz TM/PO CAT.
func (r *Radio) StepTx(tSec float64) string {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.updatePhysicsLocked(tSec)
	if doneCat := r.advanceAsyncCompletionLocked(tSec); doneCat != "" {
		return doneCat
	}

	var sb strings.Builder
	if !(r.TxActive || r.AtuTuning) {
		return ""
	}
	if r.KyKeying {
		sb.WriteString(fmt.Sprintf("TB%d00;KY%d;", r.TxBufferDigitLocked(), bool01(len(r.KyQueue) > 45)))
	}

	alcBars, compDb, fwdWatts, swrTenths := r.computeTxMetricsLocked(tSec)
	r.LastFwdTenthsW = int(math.Round(fwdWatts * 10.0))
	r.LastSwrTenths = swrTenths
	r.LastAlcBars = alcBars

	if r.TmEnabled {
		sb.WriteString(r.formatTmCmdLocked(alcBars, compDb, fwdWatts, swrTenths))
	}
	if r.PoEnabled {
		sb.WriteString(fmt.Sprintf("PO%04d;", clampInt(int(math.Round(fwdWatts*10.0)), 0, 9999)))
	}
	return sb.String()
}

func (r *Radio) formatSystemInfoLocked(mod string, tSec float64) string {
	volts, amps, paAmps := r.updatePhysicsLocked(tSec)
	cpu1 := 45.2 + 0.6*math.Sin(tSec*0.2)
	cpu2 := 43.1 + 0.5*math.Cos(tSec*0.25)
	cpu4 := 44.8 + 0.5*math.Sin(tSec*0.18)

	switch mod {
	case "FP":
		return fmt.Sprintf(
			"SIFPVS:%.2f,IS:%.2f,V10:10.19,V8:8.09,V5:4.96,VL:2.02,VH:27.09,VD:3.29,VR:0.85,TF:%.1f;SICPT1:%.1f,T2:%.1f,T4:%.1f;",
			volts, amps, r.FpTempC, cpu1, cpu2, cpu4,
		)
	case "RF":
		return fmt.Sprintf("SIRFV8:8.0,V5:5.0,V27:27.1,LT:%.1f,LM:0,PA:%.2f,PM:0,PT:%.1f;", r.LpaTempC, paAmps, r.PaTempC)
	case "DA":
		return fmt.Sprintf("SIDAV5:4.9,V3A:3.3,V3D:3.3,V1P8:1.8,V1P2:1.1,VOSC:3.2,T:%.1f;", r.DapTempC)
	case "DU":
		return fmt.Sprintf("SIDUV5:5.0,V3:3.3,T:%.1f;", r.DucTempC)
	case "RC":
		return "SIRCT:0;"
	default:
		return ""
	}
}

func (r *Radio) PeriodicSystemInfoCAT(tSec float64) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.AiMode < 4 {
		return ""
	}
	var sb strings.Builder
	if r.SiFpEnabled {
		sb.WriteString(r.formatSystemInfoLocked("FP", tSec))
	}
	if r.SiRfEnabled {
		sb.WriteString(r.formatSystemInfoLocked("RF", tSec))
	}
	if r.SiDaEnabled {
		sb.WriteString(r.formatSystemInfoLocked("DA", tSec))
	}
	if r.SiDuEnabled {
		sb.WriteString(r.formatSystemInfoLocked("DU", tSec))
	}
	if r.SiRcEnabled {
		sb.WriteString(r.formatSystemInfoLocked("RC", tSec))
	}
	return sb.String()
}

func (r *Radio) Stats() DebugStats {
	r.mu.Lock()
	defer r.mu.Unlock()
	return DebugStats{
		TotalConnections:    r.TotalConnections,
		AuthPassed:          r.AuthPassed,
		AuthFailed:          r.AuthFailed,
		TxBlockedViolations: r.TxBlockedViolations,
		LastBlockedTxCmd:    r.LastBlockedTxCmd,
		FaHz:                r.RxA.FreqHz,
		FbHz:                r.RxB.FreqHz,
		ModeA:               r.RxA.Mode,
		ModeB:               r.RxB.Mode,
		TxCatCommands:       r.TxCatCommands,
		TxAudioPacketsIn:    r.TxAudioPacketsIn,
		TxActive:            r.TxActive || r.AtuTuning,
		TxTestMode:          r.TxTestMode,
		AtuTuning:           r.AtuTuning,
		AtuMatched:          r.isCurrentBandAntMatchedLocked(),
		LastFwdTenthsW:      r.LastFwdTenthsW,
		LastSwrTenths:       r.LastSwrTenths,
		LastAlcBars:         r.LastAlcBars,
		PowerWatts:          r.PowerWatts,
		PowerRange:          r.PowerRange,
		TxAntenna:           r.TxAntenna,
		AtuMode:             r.AtuMode,
		OptionModules:       r.OptionModules,
	}
}

func isRxOnlyBlockedCommand(upper string) bool {
	switch {
	case strings.HasPrefix(upper, "TX"):
		return true
	case strings.HasPrefix(upper, "TU"):
		return upper != "TU" && upper != "TU0"
	case strings.HasPrefix(upper, "KY"), strings.HasPrefix(upper, "KZ"), strings.HasPrefix(upper, "AB"), strings.HasPrefix(upper, "DR"):
		return true
	case strings.HasPrefix(upper, "PB"):
		return upper != "PB" && upper != "PB0"
	case strings.HasPrefix(upper, "PCX"):
		return upper != "PCX"
	case strings.HasPrefix(upper, "PC"):
		return upper != "PC"
	case strings.HasPrefix(upper, "AT"):
		return upper != "AT"
	case strings.HasPrefix(upper, "ACT"):
		return upper != "ACT"
	case strings.HasPrefix(upper, "ACN"):
		if upper == "ACN" {
			return false
		}
		if len(upper) == 4 && upper[3] >= '1' && upper[3] <= '5' {
			return false
		}
		return true
	case strings.HasPrefix(upper, "AN"):
		return upper != "AN"
	case strings.HasPrefix(upper, "FT"):
		return upper != "FT" && upper != "FT0"
	case strings.HasPrefix(upper, "XT"):
		return upper != "XT"
	case strings.HasPrefix(upper, "TS"):
		return upper != "TS"
	case strings.HasPrefix(upper, "IN"):
		return upper != "IN"
	case strings.HasPrefix(upper, "MG"):
		return upper != "MG"
	case strings.HasPrefix(upper, "CP"):
		return upper != "CP"
	case strings.HasPrefix(upper, "ML"):
		return upper != "ML" && upper != "ML0" && upper != "ML1" && upper != "ML2"
	case strings.HasPrefix(upper, "MI"):
		return upper != "MI"
	case strings.HasPrefix(upper, "MS"):
		return upper != "MS"
	case strings.HasPrefix(upper, "ES"):
		return upper != "ES"
	case strings.HasPrefix(upper, "DW"):
		return upper != "DW"
	case strings.HasPrefix(upper, "TE"):
		return upper != "TE"
	case strings.HasPrefix(upper, "VX"):
		return upper != "VX" && upper != "VXC" && upper != "VXV" && upper != "VXD"
	case strings.HasPrefix(upper, "VG"):
		return upper != "VG" && upper != "VGV" && upper != "VGD"
	case strings.HasPrefix(upper, "VI"):
		return upper != "VI"
	case strings.HasPrefix(upper, "SD"):
		return upper != "SD" && upper != "SDC" && upper != "SDV" && upper != "SDD"
	case strings.HasPrefix(upper, "KS"):
		return upper != "KS"
	case strings.HasPrefix(upper, "KP"):
		return upper != "KP"
	}
	return false
}

func isBlockedTxCommand(upper string, allowTx bool) bool {
	for _, p := range permanentBlockedPrefixes {
		if strings.HasPrefix(upper, p) {
			return true
		}
	}
	if !allowTx {
		return isRxOnlyBlockedCommand(upper)
	}
	return false
}

// HandleCAT processes one or more CAT commands and returns the combined ASCII response.
func (r *Radio) HandleCAT(raw string, tSec float64) (reply string, closeConn bool) {
	cmds := SplitCATFrames(raw)
	if len(cmds) == 0 {
		return "", false
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	r.updatePhysicsLocked(tSec)

	var sb strings.Builder
	if doneCat := r.advanceAsyncCompletionLocked(tSec); doneCat != "" {
		sb.WriteString(doneCat)
	}
	for _, cmd := range cmds {
		trimmed := strings.TrimSpace(cmd)
		if trimmed == "" {
			continue
		}
		upper := strings.ToUpper(trimmed)

		if isBlockedTxCommand(upper, r.AllowTx) {
			r.TxBlockedViolations++
			r.LastBlockedTxCmd = trimmed
			sb.WriteString("?;")
			continue
		}

		if upper == "RRN" {
			closeConn = true
			continue
		}

		resp := r.execSingleLocked(trimmed, upper, tSec)
		sb.WriteString(resp)
	}
	return sb.String(), closeConn
}

func (r *Radio) fullSnapshotLocked(tSec float64) string {
	var sb strings.Builder
	sb.WriteString("IDK4-SIM;")
	if r.OptionModules != "" {
		sb.WriteString(r.OptionModules)
	} else {
		sb.WriteString(omOptionModuleStr)
	}
	sb.WriteString(rvModulesStr)
	sb.WriteString("SN00421;")
	sb.WriteString(fmt.Sprintf("SL%d;", r.StreamingLatency))
	sb.WriteString(fmt.Sprintf("AN%d;", r.TxAntenna))
	sb.WriteString(fmt.Sprintf("OV%d0;OV$%d0;", adcOverflowLocked(r.RxA), adcOverflowLocked(r.RxB)))
	sb.WriteString(fmt.Sprintf("FA%011d;", r.RxA.FreqHz))
	sb.WriteString(fmt.Sprintf("FB%011d;", r.RxB.FreqHz))
	sb.WriteString(fmt.Sprintf("MD%d;", r.RxA.Mode))
	sb.WriteString(fmt.Sprintf("MD$%d;", r.RxB.Mode))
	sb.WriteString(fmt.Sprintf("DT%d;", r.RxA.DataSubMode))
	sb.WriteString(fmt.Sprintf("DT$%d;", r.RxB.DataSubMode))
	sb.WriteString(fmt.Sprintf("BW%04d;", r.RxA.BwHz/10))
	sb.WriteString(fmt.Sprintf("BW$%04d;", r.RxB.BwHz/10))
	sb.WriteString(fmt.Sprintf("IS%04d;", r.RxA.IfShiftHz/10))
	sb.WriteString(fmt.Sprintf("IS$%04d;", r.RxB.IfShiftHz/10))
	sb.WriteString(fmt.Sprintf("CW%02d;", r.CwPitchHz/10))
	sb.WriteString(fmt.Sprintf("VT%d%d;", r.RxA.StepIdx, r.RxA.StepMode))
	sb.WriteString(fmt.Sprintf("VT$%d%d;", r.RxB.StepIdx, r.RxB.StepMode))
	sb.WriteString(fmt.Sprintf("LK%d;", bool01(r.RxA.Locked)))
	sb.WriteString(fmt.Sprintf("LK$%d;", bool01(r.RxB.Locked)))
	sb.WriteString(fmt.Sprintf("SB%d;", bool01(r.SubRxEnabled)))
	sb.WriteString("SP0;")
	sb.WriteString(fmt.Sprintf("FT%d;", bool01(r.SplitEnabled)))
	sb.WriteString(fmt.Sprintf("LN%d;", bool01(r.VfoLinked)))
	sb.WriteString(formatPA("PA", r.RxA))
	sb.WriteString(formatPA("PA$", r.RxB))
	sb.WriteString(formatRA("RA", r.RxA))
	sb.WriteString(formatRA("RA$", r.RxB))
	sb.WriteString(fmt.Sprintf("AG%03d;", r.RxA.AfGain))
	sb.WriteString(fmt.Sprintf("AG$%03d;", r.RxB.AfGain))
	sb.WriteString(fmt.Sprintf("RG-%02d;", -r.RxA.RfGainDb))
	sb.WriteString(fmt.Sprintf("RG$-%02d;", -r.RxB.RfGainDb))
	sb.WriteString(fmt.Sprintf("SQ%03d;", r.RxA.Squelch))
	sb.WriteString(fmt.Sprintf("SQ$%03d;", r.RxB.Squelch))
	sb.WriteString(fmt.Sprintf("NB%03d%d;", r.RxA.NbLevel, bool01(r.RxA.NbOn)))
	sb.WriteString(fmt.Sprintf("NB$%03d%d;", r.RxB.NbLevel, bool01(r.RxB.NbOn)))
	sb.WriteString(fmt.Sprintf("NR%02d%d;", r.RxA.NrLevel, bool01(r.RxA.NrOn)))
	sb.WriteString(fmt.Sprintf("NR$%02d%d;", r.RxB.NrLevel, bool01(r.RxB.NrOn)))
	sb.WriteString(fmt.Sprintf("NM%04d%d;", r.RxA.NotchHz, bool01(r.RxA.NotchOn)))
	sb.WriteString(fmt.Sprintf("NM$%04d%d;", r.RxB.NotchHz, bool01(r.RxB.NotchOn)))
	sb.WriteString(fmt.Sprintf("GT%d;", r.RxA.Agc))
	sb.WriteString(fmt.Sprintf("GT$%d;", r.RxB.Agc))
	sb.WriteString(fmt.Sprintf("AP%d%d;", bool01(r.RxA.ApfOn), r.RxA.ApfBwIdx))
	sb.WriteString(fmt.Sprintf("AP$%d%d;", bool01(r.RxB.ApfOn), r.RxB.ApfBwIdx))
	sb.WriteString(fmt.Sprintf("RT%d;", bool01(r.RxA.RitOn)))
	sb.WriteString(fmt.Sprintf("RT$%d;", bool01(r.RxB.RitOn)))
	sb.WriteString(fmt.Sprintf("RO%+05d;", r.RxA.RitOffsetHz))
	sb.WriteString(fmt.Sprintf("RO$%+05d;", r.RxB.RitOffsetHz))
	sb.WriteString(fmt.Sprintf("DV%d;", bool01(r.DiversityEnabled)))
	sb.WriteString(fmt.Sprintf("SMH%+04d;", MeasurePassbandDbm(r.RxA, r.CwPitchHz, tSec)))
	sb.WriteString(fmt.Sprintf("SMH$%+04d;", MeasurePassbandDbm(r.RxB, r.CwPitchHz, tSec)))
	sb.WriteString(fmt.Sprintf("#SPN%d;", r.RxA.PanSpanHz))
	sb.WriteString(fmt.Sprintf("#SPN$%d;", r.RxB.PanSpanHz))
	sb.WriteString(fmt.Sprintf("#REF%d;", r.RxA.PanRefDbm))
	sb.WriteString(fmt.Sprintf("#REF$%d;", r.RxB.PanRefDbm))
	sb.WriteString(fmt.Sprintf("#SCL%d;", r.RxA.PanScaleDb))
	sb.WriteString(fmt.Sprintf("#AVG%02d;", r.PanAvg))
	sb.WriteString(fmt.Sprintf("#WBS%d;", r.RxA.WfBlack))
	sb.WriteString(fmt.Sprintf("#AR1206-02%d;", bool01(r.RxA.AutoRef)))
	sb.WriteString(fmt.Sprintf("#FXT%d;", bool01(r.RxA.FixedTune)))
	sb.WriteString(fmt.Sprintf("TD%d%d%d;", r.RxA.TextDecodeMode, r.RxA.TextDecodeThreshold, r.RxA.TextDecodeLines))
	sb.WriteString(fmt.Sprintf("TD$%d%d%d;", r.RxB.TextDecodeMode, r.RxB.TextDecodeThreshold, r.RxB.TextDecodeLines))
	sb.WriteString(fmt.Sprintf("#DPM%d;", r.DualPanMode))
	sb.WriteString(fmt.Sprintf("#MP%d;", bool01(r.RxA.MiniPan)))
	if !r.SubRxEnabled {
		sb.WriteString("#MP$-1;")
	} else {
		sb.WriteString(fmt.Sprintf("#MP$%d;", bool01(r.RxB.MiniPan)))
	}
	sb.WriteString(fmt.Sprintf("#FRZ%d;", bool01(r.PanFrozen)))
	sb.WriteString(fmt.Sprintf("#FPS%02d;", r.PanFPS))
	sb.WriteString(fmt.Sprintf("#NB%d;", r.RxA.PanNbMode))
	sb.WriteString(fmt.Sprintf("#NB$%d;", r.RxB.PanNbMode))
	sb.WriteString(fmt.Sprintf("#NBL%d;", r.RxA.PanNbLevel))
	sb.WriteString(fmt.Sprintf("#NBL$%d;", r.RxB.PanNbLevel))
	sb.WriteString(fmt.Sprintf("#DSM%d;", r.DisplayMode))
	sb.WriteString(fmt.Sprintf("#WFH%03d;", r.WaterfallHeightPct))
	sb.WriteString(fmt.Sprintf("MX%s;", r.AudioMix))
	sb.WriteString(fmt.Sprintf("EM%d;", r.EncodeMode))
	sb.WriteString(fmt.Sprintf("ACT%d%d%d%d;", bool01(r.TxAntennaShowAll), bool01(r.TxAntennaMask[0]), bool01(r.TxAntennaMask[1]), bool01(r.TxAntennaMask[2])))
	for p := 1; p <= 5; p++ {
		sb.WriteString(fmt.Sprintf("ACN%d%s;", p, r.AntennaNames[p]))
	}
	sb.WriteString(fmt.Sprintf("AT%d;", r.AtuMode))
	if r.AtuTuning {
		sb.WriteString(fmt.Sprintf("TU%d;", r.AtuTuneKind))
	} else {
		sb.WriteString("TU0;")
	}
	sb.WriteString(fmt.Sprintf("TQ%d;TQX%d;", bool01(r.TxActive || r.AtuTuning), bool01(r.TxActive || r.AtuTuning)))
	sb.WriteString(fmt.Sprintf("IN%d;", bool01(r.TxInhibit)))
	sb.WriteString(fmt.Sprintf("TS%d;", bool01(r.TxTestMode)))
	sb.WriteString(r.formatPowerLocked("PC"))
	sb.WriteString(fmt.Sprintf("XT%d;", bool01(r.XitEnabled)))
	sb.WriteString(fmt.Sprintf("MG%03d;", r.MicGain))
	sb.WriteString(fmt.Sprintf("CP%03d;", r.CompLevel))
	sb.WriteString(fmt.Sprintf("ML0%03d;ML1%03d;ML2%03d;", r.TxMonitor[0], r.TxMonitor[1], r.TxMonitor[2]))
	sb.WriteString(fmt.Sprintf("MI%d;", r.MicInput))
	sb.WriteString(fmt.Sprintf("MS%s;", r.MicSetup))
	sb.WriteString(fmt.Sprintf("ES%d%02d;", bool01(r.EssbEnabled), r.EssbBw100Hz))
	sb.WriteString(fmt.Sprintf("VXC%d;VXV%d;VXD%d;", bool01(r.VoxCw), bool01(r.VoxVoice), bool01(r.VoxData)))
	sb.WriteString(fmt.Sprintf("VGV%03d;VGD%03d;", r.VoxGainVoice, r.VoxGainData))
	sb.WriteString(fmt.Sprintf("VI%03d;", r.AntiVox))
	sb.WriteString(fmt.Sprintf("SD%d%c%03d;", bool01(r.QskFull), r.VoxDelayMode, r.VoxDelay10Ms))
	sb.WriteString(fmt.Sprintf("PB%d;", r.DvrSlot))
	sb.WriteString(fmt.Sprintf("KS%03d;", r.CwSpeedWpm))
	sb.WriteString(fmt.Sprintf("KP%c%c%03d;", r.KeyerIambic, r.KeyerOrder, r.KeyerWeight))
	sb.WriteString(fmt.Sprintf("KY%d;", bool01(len(r.KyQueue) > 45)))
	sb.WriteString(medfSampleStr)
	return sb.String()
}

func (r *Radio) execSingleLocked(orig, upper string, tSec float64) string {
	var resp string
	var isSet bool

	switch {
	case upper == "RDY":
		r.AiMode = 4
		return r.fullSnapshotLocked(tSec)
	case upper == "RX":
		wasActive := r.TxActive || r.AtuTuning || r.KyKeying || r.DvrSlot > 0
		if !wasActive {
			return ""
		}
		wasAtu := r.AtuTuning
		r.TxActive = false
		r.AtuTuning = false
		r.AtuTuneKind = 0
		r.KyQueue = ""
		r.KyKeying = false
		r.DvrSlot = 0
		r.LastFwdTenthsW = 0
		r.LastSwrTenths = 0
		r.LastAlcBars = 0
		r.TxCatCommands++
		if wasAtu {
			return "TU0;TQ0;TQX0;TM000000000000;PO0000;"
		}
		return "RX;TQ0;TQX0;TM000000000000;PO0000;"
	case upper == "TX":
		r.TxCatCommands++
		if r.TxInhibit {
			return "TQ0;TQX0;"
		}
		r.TxActive = true
		r.TxStartedAt = tSec
		alcBars, compDb, fwdWatts, swrTenths := r.computeTxMetricsLocked(tSec)
		r.LastFwdTenthsW = int(math.Round(fwdWatts * 10.0))
		r.LastSwrTenths = swrTenths
		r.LastAlcBars = alcBars
		var sb strings.Builder
		sb.WriteString("TQ1;TQX1;")
		if r.TmEnabled {
			sb.WriteString(r.formatTmCmdLocked(alcBars, compDb, fwdWatts, swrTenths))
		}
		if r.PoEnabled {
			sb.WriteString(fmt.Sprintf("PO%04d;", clampInt(int(math.Round(fwdWatts*10.0)), 0, 9999)))
		}
		return sb.String()
	case upper == "ID":
		return "IDK4-SIM;"
	case upper == "OM":
		if r.OptionModules != "" {
			return r.OptionModules
		}
		return omOptionModuleStr
	case upper == "SN":
		return "SN00421;"
	case upper == "RV":
		return rvModulesStr
	case upper == "TQX":
		return fmt.Sprintf("TQX%d;", bool01(r.TxActive || r.AtuTuning))
	case upper == "TQ":
		return fmt.Sprintf("TQ%d;", bool01(r.TxActive || r.AtuTuning))
	case upper == "TB":
		return fmt.Sprintf("TB%d00;", r.TxBufferDigitLocked())
	case upper == "TB$":
		return fmt.Sprintf("TB$%d00;", r.TxBufferDigitLocked())
	case strings.HasPrefix(upper, "TS"):
		arg := strings.TrimPrefix(upper, "TS")
		switch arg {
		case "":
			return fmt.Sprintf("TS%d;", bool01(r.TxTestMode))
		case "0", "1", "/":
			isSet = true
			r.TxCatCommands++
			if arg == "/" {
				r.TxTestMode = !r.TxTestMode
			} else {
				r.TxTestMode = arg == "1"
			}
			resp = fmt.Sprintf("TS%d;", bool01(r.TxTestMode))
		default:
			return "?;"
		}
	case strings.HasPrefix(upper, "IN"):
		arg := strings.TrimPrefix(upper, "IN")
		switch arg {
		case "":
			return fmt.Sprintf("IN%d;", bool01(r.TxInhibit))
		case "0", "1", "/":
			isSet = true
			r.TxCatCommands++
			if arg == "/" {
				r.TxInhibit = !r.TxInhibit
			} else {
				r.TxInhibit = arg == "1"
			}
			var prefixDrop string
			if r.TxInhibit && (r.TxActive || r.AtuTuning || r.KyKeying || r.DvrSlot > 0) {
				r.TxActive = false
				r.AtuTuning = false
				r.AtuTuneKind = 0
				r.KyQueue = ""
				r.KyKeying = false
				r.DvrSlot = 0
				r.LastFwdTenthsW = 0
				r.LastSwrTenths = 0
				r.LastAlcBars = 0
				prefixDrop = "TU0;TQ0;TQX0;TM000000000000;PO0000;"
			}
			if prefixDrop != "" {
				return fmt.Sprintf("IN%d;%s", bool01(r.TxInhibit), prefixDrop)
			}
			resp = fmt.Sprintf("IN%d;", bool01(r.TxInhibit))
		default:
			return "?;"
		}
	case strings.HasPrefix(upper, "TM"):
		arg := strings.TrimPrefix(upper, "TM")
		switch arg {
		case "":
			alcBars, compDb, fwdWatts, swrTenths := r.computeTxMetricsLocked(tSec)
			return r.formatTmCmdLocked(alcBars, compDb, fwdWatts, swrTenths)
		case "0", "1":
			isSet = true
			r.TmEnabled = arg == "1"
			resp = fmt.Sprintf("TM%d;", bool01(r.TmEnabled))
		default:
			return "?;"
		}
	case strings.HasPrefix(upper, "PO"):
		arg := strings.TrimPrefix(upper, "PO")
		switch arg {
		case "":
			_, _, fwdWatts, _ := r.computeTxMetricsLocked(tSec)
			return fmt.Sprintf("PO%04d;", clampInt(int(math.Round(fwdWatts*10.0)), 0, 9999))
		case "0", "1":
			isSet = true
			r.PoEnabled = arg == "1"
			resp = fmt.Sprintf("PO%d;", bool01(r.PoEnabled))
		default:
			return "?;"
		}
	case strings.HasPrefix(upper, "PCX"):
		arg := strings.TrimPrefix(upper, "PCX")
		rStr, sFlag := r.execPowerLocked("PCX", arg)
		if rStr == "?;" {
			return "?;"
		}
		resp = rStr
		isSet = sFlag
	case strings.HasPrefix(upper, "PC"):
		arg := strings.TrimPrefix(upper, "PC")
		rStr, sFlag := r.execPowerLocked("PC", arg)
		if rStr == "?;" {
			return "?;"
		}
		resp = rStr
		isSet = sFlag
	case strings.HasPrefix(upper, "TD"):
		rx, prefix, arg := splitSubRx(upper, "TD")
		target := r.rxPtr(rx)
		if arg != "" {
			if arg == "/" {
				if target.TextDecodeMode > 0 {
					target.TextDecodeMode = 0
					isSet = true
				} else {
					if !isTextDecodeCompatible(*target) {
						return "ER12:SET command incompatible with target VFO's mode.;"
					}
					target.TextDecodeMode = 2
					isSet = true
				}
			} else {
				m, err := strconv.Atoi(arg[:1])
				if err != nil {
					return "?;"
				}
				if m > 0 && !isTextDecodeCompatible(*target) {
					return "ER12:SET command incompatible with target VFO's mode.;"
				}
				target.TextDecodeMode = clampInt(m, 0, 4)
				if len(arg) >= 2 {
					if th, err := strconv.Atoi(arg[1:2]); err == nil {
						target.TextDecodeThreshold = clampInt(th, 0, 9)
					}
				}
				if len(arg) >= 3 {
					if ln, err := strconv.Atoi(arg[2:3]); err == nil {
						target.TextDecodeLines = clampInt(ln, 0, 1)
					}
				}
				isSet = true
			}
		}
		resp = fmt.Sprintf("%s%d%d%d;", prefix, target.TextDecodeMode, target.TextDecodeThreshold, target.TextDecodeLines)
	case strings.HasPrefix(upper, "ACT"):
		arg := strings.TrimPrefix(upper, "ACT")
		if arg == "" {
			return fmt.Sprintf("ACT%d%d%d%d;", bool01(r.TxAntennaShowAll), bool01(r.TxAntennaMask[0]), bool01(r.TxAntennaMask[1]), bool01(r.TxAntennaMask[2]))
		}
		if len(arg) != 4 {
			return "?;"
		}
		for i := 0; i < 4; i++ {
			if arg[i] != '0' && arg[i] != '1' {
				return "?;"
			}
		}
		isSet = true
		r.TxCatCommands++
		r.TxAntennaShowAll = arg[0] == '1'
		r.TxAntennaMask[0] = arg[1] == '1'
		r.TxAntennaMask[1] = arg[2] == '1'
		r.TxAntennaMask[2] = arg[3] == '1'
		resp = fmt.Sprintf("ACT%d%d%d%d;", bool01(r.TxAntennaShowAll), bool01(r.TxAntennaMask[0]), bool01(r.TxAntennaMask[1]), bool01(r.TxAntennaMask[2]))
	case strings.HasPrefix(upper, "ACN"):
		argOrig := orig[3:]
		if argOrig == "" {
			var sb strings.Builder
			for p := 1; p <= 5; p++ {
				sb.WriteString(fmt.Sprintf("ACN%d%s;", p, r.AntennaNames[p]))
			}
			return sb.String()
		}
		if argOrig[0] < '1' || argOrig[0] > '5' {
			return "?;"
		}
		port := int(argOrig[0] - '0')
		if len(argOrig) == 1 {
			return fmt.Sprintf("ACN%d%s;", port, r.AntennaNames[port])
		}
		isSet = true
		r.TxCatCommands++
		r.AntennaNames[port] = strings.TrimSpace(argOrig[1:])
		resp = fmt.Sprintf("ACN%d%s;", port, r.AntennaNames[port])
	case strings.HasPrefix(upper, "AT"):
		arg := strings.TrimPrefix(upper, "AT")
		switch arg {
		case "":
			return fmt.Sprintf("AT%d;", r.AtuMode)
		case "0", "1", "2":
			isSet = true
			r.TxCatCommands++
			r.AtuMode = int(arg[0] - '0')
			resp = fmt.Sprintf("AT%d;", r.AtuMode)
		case "/":
			isSet = true
			r.TxCatCommands++
			if r.AtuMode == 1 {
				r.AtuMode = 2
			} else {
				r.AtuMode = 1
			}
			resp = fmt.Sprintf("AT%d;", r.AtuMode)
		default:
			return "?;"
		}
	case strings.HasPrefix(upper, "TU"):
		arg := strings.TrimPrefix(upper, "TU")
		switch arg {
		case "":
			if r.AtuTuning {
				return fmt.Sprintf("TU%d;", r.AtuTuneKind)
			}
			return "TU0;"
		case "0":
			wasTuning := r.AtuTuning
			r.AtuTuning = false
			r.AtuTuneKind = 0
			if wasTuning {
				r.TxActive = false
				r.LastFwdTenthsW = 0
				r.LastSwrTenths = 0
				r.LastAlcBars = 0
				r.TxCatCommands++
				return "TU0;TQ0;TQX0;TM000000000000;PO0000;"
			}
			isSet = true
			resp = "TU0;"
		case "1", "2", "3", "4":
			kind := int(arg[0] - '0')
			r.TxCatCommands++
			if r.TxInhibit {
				return "TU0;TQ0;TQX0;"
			}
			if kind == 3 || kind == 4 {
				r.AtuMode = 2
			}
			r.AtuTuning = true
			r.AtuTuneKind = kind
			r.AtuTuneStartedAt = tSec
			r.TxActive = true
			r.TxStartedAt = tSec
			alcBars, compDb, fwdWatts, swrTenths := r.computeTxMetricsLocked(tSec)
			r.LastFwdTenthsW = int(math.Round(fwdWatts * 10.0))
			r.LastSwrTenths = swrTenths
			r.LastAlcBars = alcBars
			var sb strings.Builder
			if kind == 3 || kind == 4 {
				sb.WriteString("AT2;")
			}
			sb.WriteString(fmt.Sprintf("TU%d;TQ1;TQX1;", kind))
			if r.TmEnabled {
				sb.WriteString(r.formatTmCmdLocked(alcBars, compDb, fwdWatts, swrTenths))
			}
			if r.PoEnabled {
				sb.WriteString(fmt.Sprintf("PO%04d;", clampInt(int(math.Round(fwdWatts*10.0)), 0, 9999)))
			}
			return sb.String()
		default:
			return "?;"
		}
	case strings.HasPrefix(upper, "AN"):
		arg := strings.TrimPrefix(upper, "AN")
		switch arg {
		case "":
			return fmt.Sprintf("AN%d;", r.TxAntenna)
		case "1", "2", "3":
			isSet = true
			r.TxCatCommands++
			r.TxAntenna = int(arg[0] - '0')
			resp = fmt.Sprintf("AN%d;", r.TxAntenna)
		case "/":
			isSet = true
			r.TxCatCommands++
			next := r.TxAntenna
			for step := 1; step <= 3; step++ {
				cand := ((r.TxAntenna - 1 + step) % 3) + 1
				if r.TxAntennaMask[cand-1] {
					next = cand
					break
				}
			}
			r.TxAntenna = next
			resp = fmt.Sprintf("AN%d;", r.TxAntenna)
		default:
			return "?;"
		}
	case upper == "OV":
		return fmt.Sprintf("OV%d0;", adcOverflowLocked(r.RxA))
	case upper == "OV$":
		return fmt.Sprintf("OV$%d0;", adcOverflowLocked(r.RxB))
	case strings.HasPrefix(upper, "SI") && len(upper) == 5 && (upper[4] == '0' || upper[4] == '1'):
		mod := upper[2:4]
		on := upper[4] == '1'
		switch mod {
		case "FP":
			r.SiFpEnabled = on
		case "RF":
			r.SiRfEnabled = on
		case "DA":
			r.SiDaEnabled = on
		case "DU":
			r.SiDuEnabled = on
		case "RC":
			r.SiRcEnabled = on
		default:
			return "?;"
		}
		if on {
			return r.formatSystemInfoLocked(mod, tSec)
		}
		return ""
	case upper == "IF":
		ritOff := clampInt(r.RxA.RitOffsetHz, -9999, 9999)
		dataSub := 0
		if r.RxA.Mode == ModeDATA {
			dataSub = r.RxA.DataSubMode
		}
		return fmt.Sprintf(
			"IF%011d     %+05d%d%d 00%d%d00%d0%d1 ;",
			r.RxA.FreqHz,
			ritOff,
			bool01(r.RxA.RitOn),
			bool01(r.XitEnabled),
			bool01(r.TxActive || r.AtuTuning),
			r.RxA.Mode,
			bool01(r.SplitEnabled),
			dataSub,
		)
	case strings.HasPrefix(upper, "PING"):
		return "PONG;"
	case strings.HasPrefix(upper, "K4"):
		arg := strings.TrimPrefix(upper, "K4")
		if arg == "0" || arg == "1" {
			isSet = true
			r.K4Mode, _ = strconv.Atoi(arg)
		}
		resp = fmt.Sprintf("K4%d;", r.K4Mode)
	case strings.HasPrefix(upper, "ER"):
		arg := strings.TrimPrefix(upper, "ER")
		if arg == "0" || arg == "1" {
			r.ErMode, _ = strconv.Atoi(arg)
			// In K4 CAT, ERn; sets error mode silently; ERnn:msg; is an error notification.
			return ""
		}
		return fmt.Sprintf("ER%d;", r.ErMode)
	case strings.HasPrefix(upper, "AI"):
		arg := strings.TrimPrefix(upper, "AI")
		if arg != "" {
			isSet = true
			if v, err := strconv.Atoi(arg); err == nil && v >= 0 && v <= 5 {
				r.AiMode = v
			}
		}
		resp = fmt.Sprintf("AI%d;", r.AiMode)
	case strings.HasPrefix(upper, "FA"):
		arg := strings.TrimPrefix(upper, "FA")
		if arg != "" {
			isSet = true
			if hz, err := strconv.ParseInt(arg, 10, 64); err == nil {
				oldCenter := r.RxA.FreqHz + r.RxA.PanCenterOffsetHz
				r.RxA.FreqHz = clampInt64(hz, 100000, 54000000)
				if r.RxA.FixedTune {
					r.RxA.PanCenterOffsetHz = clampInt64(oldCenter-r.RxA.FreqHz, -5000000, 5000000)
				}
			}
		}
		resp = fmt.Sprintf("FA%011d;", r.RxA.FreqHz)
	case strings.HasPrefix(upper, "FB"):
		arg := strings.TrimPrefix(upper, "FB")
		if arg != "" {
			isSet = true
			if hz, err := strconv.ParseInt(arg, 10, 64); err == nil {
				oldCenter := r.RxB.FreqHz + r.RxB.PanCenterOffsetHz
				r.RxB.FreqHz = clampInt64(hz, 100000, 54000000)
				if r.RxA.FixedTune {
					r.RxB.PanCenterOffsetHz = clampInt64(oldCenter-r.RxB.FreqHz, -5000000, 5000000)
				}
			}
		}
		resp = fmt.Sprintf("FB%011d;", r.RxB.FreqHz)
	case strings.HasPrefix(upper, "MD"):
		rx, prefix, arg := splitSubRx(upper, "MD")
		target := r.rxPtr(rx)
		if arg != "" {
			isSet = true
			if m, err := strconv.Atoi(arg); err == nil && validMode(m) {
				target.Mode = m
			}
		}
		resp = fmt.Sprintf("%s%d;", prefix, target.Mode)
	case strings.HasPrefix(upper, "DT"):
		rx, prefix, arg := splitSubRx(upper, "DT")
		target := r.rxPtr(rx)
		if arg != "" {
			isSet = true
			if d, err := strconv.Atoi(arg); err == nil && d >= 0 && d <= 3 {
				target.DataSubMode = d
			}
		}
		resp = fmt.Sprintf("%s%d;", prefix, target.DataSubMode)
	case strings.HasPrefix(upper, "BW"):
		rx, prefix, arg := splitSubRx(upper, "BW")
		target := r.rxPtr(rx)
		if arg != "" {
			isSet = true
			if v, err := strconv.Atoi(arg); err == nil {
				target.BwHz = clampInt(v*10, 50, 5000)
			}
		}
		resp = fmt.Sprintf("%s%04d;", prefix, target.BwHz/10)
	case strings.HasPrefix(upper, "IS"):
		rx, prefix, arg := splitSubRx(upper, "IS")
		target := r.rxPtr(rx)
		arg = strings.TrimSpace(arg)
		if arg != "" {
			isSet = true
			if v, err := strconv.Atoi(arg); err == nil {
				target.IfShiftHz = clampInt(v*10, 0, 5000)
			}
		}
		resp = fmt.Sprintf("%s%04d;", prefix, target.IfShiftHz/10)
	case strings.HasPrefix(upper, "CW"):
		arg := strings.TrimPrefix(upper, "CW")
		if arg != "" {
			isSet = true
			if v, err := strconv.Atoi(arg); err == nil {
				r.CwPitchHz = clampInt(v*10, 250, 950)
			}
		}
		resp = fmt.Sprintf("CW%02d;", r.CwPitchHz/10)
	case strings.HasPrefix(upper, "VT"):
		rx, prefix, arg := splitSubRx(upper, "VT")
		target := r.rxPtr(rx)
		if arg != "" {
			isSet = true
			if idx, err := strconv.Atoi(arg[:1]); err == nil && idx >= 0 && idx <= 6 {
				target.StepIdx = idx
			}
			if len(arg) >= 2 {
				if mode, err := strconv.Atoi(arg[1:2]); err == nil && mode >= 0 && mode <= 9 {
					target.StepMode = mode
				}
			}
		}
		resp = fmt.Sprintf("%s%d%d;", prefix, target.StepIdx, target.StepMode)
	case strings.HasPrefix(upper, "LK"):
		rx, prefix, arg := splitSubRx(upper, "LK")
		target := r.rxPtr(rx)
		if arg == "0" || arg == "1" {
			isSet = true
			target.Locked = arg == "1"
		}
		resp = fmt.Sprintf("%s%d;", prefix, bool01(target.Locked))
	case strings.HasPrefix(upper, "SB"):
		arg := strings.TrimPrefix(upper, "SB")
		if arg == "0" || arg == "1" {
			isSet = true
			r.SubRxEnabled = arg == "1"
			if !r.SubRxEnabled {
				r.RxB.MiniPan = false
			}
		}
		resp = fmt.Sprintf("SB%d;", bool01(r.SubRxEnabled))
	case upper == "SP0":
		return "SP0;"
	case strings.HasPrefix(upper, "SP"):
		// SP is SET-only in D4; bare SP; or invalid SP args return ?;
		return "?;"
	case strings.HasPrefix(upper, "DV"):
		arg := strings.TrimPrefix(upper, "DV")
		if arg != "" {
			isSet = true
		}
		if !r.hasKrx4Locked() {
			r.DiversityEnabled = false
			resp = "DV0;"
			break
		}
		copyAtoB := func() {
			r.SubRxEnabled = true
			r.RxB.FreqHz = r.RxA.FreqHz
			r.RxB.Mode = r.RxA.Mode
			r.RxB.DataSubMode = r.RxA.DataSubMode
			r.RxB.BwHz = r.RxA.BwHz
			r.RxB.IfShiftHz = r.RxA.IfShiftHz
		}
		switch arg {
		case "0":
			r.DiversityEnabled = false
		case "1":
			r.DiversityEnabled = true
			copyAtoB()
		case "/":
			r.DiversityEnabled = !r.DiversityEnabled
			if r.DiversityEnabled {
				copyAtoB()
			}
		}
		resp = fmt.Sprintf("DV%d;", bool01(r.DiversityEnabled))
	case strings.HasPrefix(upper, "FC"):
		rx, _, arg := splitSubRx(upper, "FC")
		target := r.rxPtr(rx)
		if arg == "" {
			target.PanCenterOffsetHz = 0
		} else {
			isSet = true
			if r.RxA.FixedTune {
				if off, err := strconv.ParseInt(arg, 10, 64); err == nil {
					target.PanCenterOffsetHz = clampInt64(off, -5000000, 5000000)
				}
			}
		}
		fiPrefix := "FI"
		if rx == 'B' {
			fiPrefix = "FI$"
		}
		resp = fmt.Sprintf("%s%011d;", fiPrefix, clampInt64(target.FreqHz+target.PanCenterOffsetHz, 100000, 54000000))
	case strings.HasPrefix(upper, "FI"):
		rx, prefix, arg := splitSubRx(upper, "FI")
		target := r.rxPtr(rx)
		if arg != "" {
			isSet = true
			if r.RxA.FixedTune {
				if centerHz, err := strconv.ParseInt(arg, 10, 64); err == nil {
					clampedCenter := clampInt64(centerHz, 100000, 54000000)
					target.PanCenterOffsetHz = clampInt64(clampedCenter-target.FreqHz, -5000000, 5000000)
				}
			}
		}
		resp = fmt.Sprintf("%s%011d;", prefix, clampInt64(target.FreqHz+target.PanCenterOffsetHz, 100000, 54000000))
	case strings.HasPrefix(upper, "RT"):
		rx, prefix, arg := splitSubRx(upper, "RT")
		target := r.rxPtr(rx)
		if arg != "" {
			isSet = true
		}
		switch arg {
		case "0":
			target.RitOn = false
		case "1":
			target.RitOn = true
		case "/":
			target.RitOn = !target.RitOn
		}
		resp = fmt.Sprintf("%s%d;", prefix, bool01(target.RitOn))
	case strings.HasPrefix(upper, "RO"):
		rx, prefix, arg := splitSubRx(upper, "RO")
		target := r.rxPtr(rx)
		if arg != "" {
			isSet = true
			if v, err := strconv.Atoi(arg); err == nil {
				target.RitOffsetHz = clampInt(v, -9999, 9999)
			}
		}
		resp = fmt.Sprintf("%s%+05d;", prefix, target.RitOffsetHz)
	case upper == "RC" || upper == "RC$":
		rx, _, _ := splitSubRx(upper, "RC")
		target := r.rxPtr(rx)
		isSet = true
		target.RitOffsetHz = 0
		roPrefix := "RO"
		if rx == 'B' {
			roPrefix = "RO$"
		}
		resp = fmt.Sprintf("%s+0000;", roPrefix)
	case strings.HasPrefix(upper, "FT"):
		arg := strings.TrimPrefix(upper, "FT")
		switch arg {
		case "":
			return fmt.Sprintf("FT%d;", bool01(r.SplitEnabled))
		case "0", "1":
			isSet = true
			r.TxCatCommands++
			r.SplitEnabled = arg == "1"
		case "/":
			isSet = true
			r.TxCatCommands++
			r.SplitEnabled = !r.SplitEnabled
		default:
			return "?;"
		}
		resp = fmt.Sprintf("FT%d;", bool01(r.SplitEnabled))
	case strings.HasPrefix(upper, "AB"):
		arg := strings.TrimPrefix(upper, "AB")
		if len(arg) != 1 || arg[0] < '0' || arg[0] > '5' {
			return "?;"
		}
		isSet = true
		r.TxCatCommands++
		kind := arg[0] - '0'
		if kind == 0 || kind == 1 || kind == 2 || kind == 3 || kind == 5 {
			r.RxB.FreqHz = r.RxA.FreqHz
		}
		if kind == 1 || kind == 2 || kind == 3 || kind == 5 {
			r.RxB.Mode = r.RxA.Mode
			r.RxB.DataSubMode = r.RxA.DataSubMode
		}
		if kind == 2 || kind == 3 || kind == 4 || kind == 5 {
			r.RxB.BwHz = r.RxA.BwHz
			r.RxB.IfShiftHz = r.RxA.IfShiftHz
		}
		if kind == 3 {
			r.RxB.Preamp = r.RxA.Preamp
			r.RxB.PreampOn = r.RxA.PreampOn
			r.RxB.AttenDb = r.RxA.AttenDb
			r.RxB.AttenOn = r.RxA.AttenOn
			r.RxB.Agc = r.RxA.Agc
			r.RxB.NbOn = r.RxA.NbOn
			r.RxB.NbLevel = r.RxA.NbLevel
			r.RxB.NrOn = r.RxA.NrOn
			r.RxB.NrLevel = r.RxA.NrLevel
			r.RxB.NotchOn = r.RxA.NotchOn
			r.RxB.NotchHz = r.RxA.NotchHz
			r.RxB.ApfOn = r.RxA.ApfOn
			r.RxB.ApfBwIdx = r.RxA.ApfBwIdx
		}
		resp = fmt.Sprintf(
			"FB%011d;MD$%d;DT$%d;BW$%04d;IS$%04d;",
			r.RxB.FreqHz, r.RxB.Mode, r.RxB.DataSubMode, r.RxB.BwHz/10, r.RxB.IfShiftHz/10,
		)
	case strings.HasPrefix(upper, "XT"):
		arg := strings.TrimPrefix(upper, "XT")
		switch arg {
		case "":
			return fmt.Sprintf("XT%d;", bool01(r.XitEnabled))
		case "0", "1", "/":
			isSet = true
			r.TxCatCommands++
			if arg == "/" {
				r.XitEnabled = !r.XitEnabled
			} else {
				r.XitEnabled = arg == "1"
			}
			resp = fmt.Sprintf("XT%d;", bool01(r.XitEnabled))
		default:
			return "?;"
		}
	case strings.HasPrefix(upper, "MG"):
		arg := strings.TrimPrefix(upper, "MG")
		if arg == "" {
			return fmt.Sprintf("MG%03d;", r.MicGain)
		}
		v, err := strconv.Atoi(arg)
		if err != nil {
			return "?;"
		}
		isSet = true
		r.TxCatCommands++
		r.MicGain = clampInt(v, 0, 80)
		resp = fmt.Sprintf("MG%03d;", r.MicGain)
	case strings.HasPrefix(upper, "CP"):
		arg := strings.TrimPrefix(upper, "CP")
		if arg == "" {
			return fmt.Sprintf("CP%03d;", r.CompLevel)
		}
		v, err := strconv.Atoi(arg)
		if err != nil {
			return "?;"
		}
		isSet = true
		r.TxCatCommands++
		r.CompLevel = clampInt(v, 0, 30)
		resp = fmt.Sprintf("CP%03d;", r.CompLevel)
	case strings.HasPrefix(upper, "ML"):
		arg := strings.TrimPrefix(upper, "ML")
		if arg == "" {
			return fmt.Sprintf("ML0%03d;ML1%03d;ML2%03d;", r.TxMonitor[0], r.TxMonitor[1], r.TxMonitor[2])
		}
		if arg[0] < '0' || arg[0] > '2' {
			return "?;"
		}
		ch := int(arg[0] - '0')
		if len(arg) == 1 {
			return fmt.Sprintf("ML%d%03d;", ch, r.TxMonitor[ch])
		}
		v, err := strconv.Atoi(arg[1:])
		if err != nil {
			return "?;"
		}
		isSet = true
		r.TxCatCommands++
		r.TxMonitor[ch] = clampInt(v, 0, 100)
		resp = fmt.Sprintf("ML%d%03d;", ch, r.TxMonitor[ch])
	case strings.HasPrefix(upper, "MI"):
		arg := strings.TrimPrefix(upper, "MI")
		if arg == "" {
			return fmt.Sprintf("MI%d;", r.MicInput)
		}
		v, err := strconv.Atoi(arg)
		if err != nil || v < 0 || v > 4 {
			return "?;"
		}
		isSet = true
		r.TxCatCommands++
		r.MicInput = v
		resp = fmt.Sprintf("MI%d;", r.MicInput)
	case strings.HasPrefix(upper, "MS"):
		arg := strings.TrimPrefix(upper, "MS")
		if arg == "" {
			return fmt.Sprintf("MS%s;", r.MicSetup)
		}
		if len(arg) != 5 {
			return "?;"
		}
		isSet = true
		r.TxCatCommands++
		r.MicSetup = arg
		resp = fmt.Sprintf("MS%s;", r.MicSetup)
	case strings.HasPrefix(upper, "ES"):
		arg := strings.TrimPrefix(upper, "ES")
		if arg == "" {
			return fmt.Sprintf("ES%d%02d;", bool01(r.EssbEnabled), r.EssbBw100Hz)
		}
		if arg[0] != '0' && arg[0] != '1' {
			return "?;"
		}
		isSet = true
		r.TxCatCommands++
		r.EssbEnabled = arg[0] == '1'
		if len(arg) >= 3 {
			if bw, err := strconv.Atoi(arg[1:]); err == nil {
				r.EssbBw100Hz = clampInt(bw, 30, 45)
			}
		}
		resp = fmt.Sprintf("ES%d%02d;", bool01(r.EssbEnabled), r.EssbBw100Hz)
	case strings.HasPrefix(upper, "DW"):
		arg := orig[2:]
		if arg == "" {
			return fmt.Sprintf("DW%s;", r.DwRaw)
		}
		isSet = true
		r.TxCatCommands++
		r.DwRaw = arg
		resp = fmt.Sprintf("DW%s;", r.DwRaw)
	case strings.HasPrefix(upper, "TE"):
		arg := orig[2:]
		if arg == "" {
			return fmt.Sprintf("TE%s;", r.TxEq)
		}
		isSet = true
		r.TxCatCommands++
		r.TxEq = arg
		resp = fmt.Sprintf("TE%s;", r.TxEq)
	case strings.HasPrefix(upper, "VX"):
		arg := strings.TrimPrefix(upper, "VX")
		if arg == "" {
			return fmt.Sprintf("VXC%d;VXV%d;VXD%d;", bool01(r.VoxCw), bool01(r.VoxVoice), bool01(r.VoxData))
		}
		modeCh := arg[0]
		if modeCh != 'C' && modeCh != 'V' && modeCh != 'D' {
			return "?;"
		}
		getVox := func(m byte) bool {
			switch m {
			case 'C':
				return r.VoxCw
			case 'V':
				return r.VoxVoice
			default:
				return r.VoxData
			}
		}
		setVox := func(m byte, v bool) {
			switch m {
			case 'C':
				r.VoxCw = v
			case 'V':
				r.VoxVoice = v
			case 'D':
				r.VoxData = v
			}
		}
		if len(arg) == 1 {
			return fmt.Sprintf("VX%c%d;", modeCh, bool01(getVox(modeCh)))
		}
		sub := arg[1:]
		if sub != "0" && sub != "1" && sub != "/" {
			return "?;"
		}
		isSet = true
		r.TxCatCommands++
		if sub == "/" {
			setVox(modeCh, !getVox(modeCh))
		} else {
			setVox(modeCh, sub == "1")
		}
		resp = fmt.Sprintf("VX%c%d;", modeCh, bool01(getVox(modeCh)))
	case strings.HasPrefix(upper, "VG"):
		arg := strings.TrimPrefix(upper, "VG")
		if arg == "" {
			return fmt.Sprintf("VGV%03d;VGD%03d;", r.VoxGainVoice, r.VoxGainData)
		}
		if arg[0] != 'V' && arg[0] != 'D' {
			return "?;"
		}
		if len(arg) == 1 {
			if arg[0] == 'V' {
				return fmt.Sprintf("VGV%03d;", r.VoxGainVoice)
			}
			return fmt.Sprintf("VGD%03d;", r.VoxGainData)
		}
		v, err := strconv.Atoi(arg[1:])
		if err != nil {
			return "?;"
		}
		isSet = true
		r.TxCatCommands++
		clamped := clampInt(v, 0, 60)
		if arg[0] == 'V' {
			r.VoxGainVoice = clamped
		} else {
			r.VoxGainData = clamped
		}
		resp = fmt.Sprintf("VG%c%03d;", arg[0], clamped)
	case strings.HasPrefix(upper, "VI"):
		arg := strings.TrimPrefix(upper, "VI")
		if arg == "" {
			return fmt.Sprintf("VI%03d;", r.AntiVox)
		}
		v, err := strconv.Atoi(arg)
		if err != nil {
			return "?;"
		}
		isSet = true
		r.TxCatCommands++
		r.AntiVox = clampInt(v, 0, 60)
		resp = fmt.Sprintf("VI%03d;", r.AntiVox)
	case strings.HasPrefix(upper, "SD"):
		arg := strings.TrimPrefix(upper, "SD")
		if arg == "" {
			return fmt.Sprintf("SD%d%c%03d;", bool01(r.QskFull), r.VoxDelayMode, r.VoxDelay10Ms)
		}
		if len(arg) == 1 && (arg[0] == 'C' || arg[0] == 'V' || arg[0] == 'D') {
			return fmt.Sprintf("SD%d%c%03d;", bool01(r.QskFull), arg[0], r.VoxDelay10Ms)
		}
		if len(arg) < 2 || (arg[0] != '0' && arg[0] != '1') || (arg[1] != 'C' && arg[1] != 'V' && arg[1] != 'D') {
			return "?;"
		}
		isSet = true
		r.TxCatCommands++
		r.QskFull = arg[0] == '1'
		r.VoxDelayMode = arg[1]
		if len(arg) > 2 {
			if v, err := strconv.Atoi(arg[2:]); err == nil {
				r.VoxDelay10Ms = clampInt(v, 0, 255)
			}
		}
		resp = fmt.Sprintf("SD%d%c%03d;", bool01(r.QskFull), r.VoxDelayMode, r.VoxDelay10Ms)
	case strings.HasPrefix(upper, "PB"):
		arg := strings.TrimPrefix(upper, "PB")
		if arg == "" {
			return fmt.Sprintf("PB%d;", r.DvrSlot)
		}
		if len(arg) != 1 || arg[0] < '0' || arg[0] > '8' {
			return "?;"
		}
		slot := int(arg[0] - '0')
		if slot == 0 {
			wasDvr := r.DvrSlot > 0
			r.DvrSlot = 0
			if wasDvr {
				r.TxCatCommands++
				if !r.AtuTuning && !r.KyKeying {
					r.TxActive = false
					r.LastFwdTenthsW = 0
					r.LastSwrTenths = 0
					r.LastAlcBars = 0
					return "PB0;TQ0;TQX0;TM000000000000;PO0000;"
				}
			}
			isSet = true
			resp = "PB0;"
		} else {
			r.TxCatCommands++
			if r.TxInhibit {
				return "PB0;TQ0;TQX0;"
			}
			r.DvrSlot = slot
			r.TxActive = true
			r.TxStartedAt = tSec
			return fmt.Sprintf("PB%d;TQ1;TQX1;", r.DvrSlot)
		}
	case strings.HasPrefix(upper, "KS"):
		arg := strings.TrimPrefix(upper, "KS")
		if arg == "" {
			return fmt.Sprintf("KS%03d;", r.CwSpeedWpm)
		}
		v, err := strconv.Atoi(arg)
		if err != nil {
			return "?;"
		}
		isSet = true
		r.TxCatCommands++
		r.CwSpeedWpm = clampInt(v, 8, 100)
		resp = fmt.Sprintf("KS%03d;", r.CwSpeedWpm)
	case strings.HasPrefix(upper, "KP"):
		arg := strings.TrimPrefix(upper, "KP")
		if arg == "" {
			return fmt.Sprintf("KP%c%c%03d;", r.KeyerIambic, r.KeyerOrder, r.KeyerWeight)
		}
		if len(arg) < 2 || (arg[0] != 'A' && arg[0] != 'B') || (arg[1] != 'N' && arg[1] != 'R') {
			return "?;"
		}
		isSet = true
		r.TxCatCommands++
		r.KeyerIambic = arg[0]
		r.KeyerOrder = arg[1]
		if len(arg) > 2 {
			if w, err := strconv.Atoi(arg[2:]); err == nil {
				r.KeyerWeight = clampInt(w, 90, 125)
			}
		}
		resp = fmt.Sprintf("KP%c%c%03d;", r.KeyerIambic, r.KeyerOrder, r.KeyerWeight)
	case strings.HasPrefix(upper, "KY"):
		argOrig := orig[2:]
		if argOrig == "" {
			return fmt.Sprintf("KY%d;", bool01(len(r.KyQueue) > 45))
		}
		if strings.Contains(argOrig, "@") {
			r.TxCatCommands++
			wasKeying := r.KyKeying
			r.KyQueue = ""
			r.KyKeying = false
			if wasKeying && !r.AtuTuning && r.DvrSlot == 0 {
				r.TxActive = false
				r.LastFwdTenthsW = 0
				r.LastSwrTenths = 0
				r.LastAlcBars = 0
				return "KY0;TQ0;TQX0;TM000000000000;PO0000;"
			}
			return "KY0;"
		}
		text := argOrig
		if len(text) > 0 && text[0] == ' ' {
			text = text[1:]
		}
		if text == "" {
			return fmt.Sprintf("KY%d;", bool01(len(r.KyQueue) > 45))
		}
		r.TxCatCommands++
		if r.TxInhibit {
			return fmt.Sprintf("KY%d;TQ0;TQX0;", bool01(len(r.KyQueue) > 45))
		}
		if len(r.KyQueue) == 0 {
			r.KyLastDrainAt = tSec
		}
		r.KyQueue += text
		r.KyKeying = true
		r.TxActive = true
		r.TxStartedAt = tSec
		return fmt.Sprintf("KY%d;TQ1;TQX1;", bool01(len(r.KyQueue) > 45))
	case strings.HasPrefix(upper, "LN"):
		arg := strings.TrimPrefix(upper, "LN")
		if arg == "0" || arg == "1" {
			isSet = true
			r.VfoLinked = arg == "1"
		}
		resp = fmt.Sprintf("LN%d;", bool01(r.VfoLinked))
	case strings.HasPrefix(upper, "BN"):
		rx, prefix, arg := splitSubRx(upper, "BN")
		target := r.rxPtr(rx)
		bnCode := bandCodeForFreq(target.FreqHz)
		if arg != "" {
			isSet = true
			if bn, err := strconv.Atoi(arg); err == nil {
				if hz, ok := bandDefaults[bn]; ok {
					target.FreqHz = hz
					bnCode = bn
				}
			}
		}
		resp = fmt.Sprintf("%s%02d;", prefix, bnCode)
	case strings.HasPrefix(upper, "PA"):
		rx, prefix, arg := splitSubRx(upper, "PA")
		target := r.rxPtr(rx)
		if arg != "" {
			isSet = true
			if len(arg) == 2 {
				lvl, err1 := strconv.Atoi(arg[:1])
				on, err2 := strconv.Atoi(arg[1:2])
				if err1 == nil && err2 == nil {
					target.PreampOn = on == 1 && lvl > 0
					if target.PreampOn {
						target.Preamp = clampInt(lvl, 0, 3)
					} else {
						target.Preamp = 0
					}
				}
			}
		}
		resp = formatPA(prefix, *target)
	case strings.HasPrefix(upper, "RA"):
		rx, prefix, arg := splitSubRx(upper, "RA")
		target := r.rxPtr(rx)
		if arg != "" {
			isSet = true
			if len(arg) == 3 {
				db, err1 := strconv.Atoi(arg[:2])
				on, err2 := strconv.Atoi(arg[2:3])
				if err1 == nil && err2 == nil {
					target.AttenOn = on == 1 && db > 0
					if target.AttenOn {
						target.AttenDb = clampInt(db, 0, 21)
					} else {
						target.AttenDb = 0
					}
				}
			}
		}
		resp = formatRA(prefix, *target)
	case strings.HasPrefix(upper, "AG"):
		rx, prefix, arg := splitSubRx(upper, "AG")
		target := r.rxPtr(rx)
		if arg != "" {
			isSet = true
			if v, err := strconv.Atoi(arg); err == nil {
				target.AfGain = clampInt(v, 0, 60)
			}
		}
		resp = fmt.Sprintf("%s%03d;", prefix, target.AfGain)
	case strings.HasPrefix(upper, "RG"):
		rx, prefix, arg := splitSubRx(upper, "RG")
		target := r.rxPtr(rx)
		if arg != "" {
			isSet = true
			if v, err := strconv.Atoi(arg); err == nil {
				if v > 0 {
					v = -v
				}
				target.RfGainDb = clampInt(v, -60, 0)
			}
		}
		resp = fmt.Sprintf("%s-%02d;", prefix, -target.RfGainDb)
	case strings.HasPrefix(upper, "SQ"):
		rx, prefix, arg := splitSubRx(upper, "SQ")
		target := r.rxPtr(rx)
		if arg != "" {
			isSet = true
			if v, err := strconv.Atoi(arg); err == nil {
				target.Squelch = clampInt(v, 0, 40)
			}
		}
		resp = fmt.Sprintf("%s%03d;", prefix, target.Squelch)
	case strings.HasPrefix(upper, "NB"):
		rx, prefix, arg := splitSubRx(upper, "NB")
		target := r.rxPtr(rx)
		if arg != "" {
			isSet = true
			switch len(arg) {
			case 4:
				lvl, err1 := strconv.Atoi(arg[:3])
				on, err2 := strconv.Atoi(arg[3:4])
				if err1 == nil && err2 == nil {
					target.NbLevel = clampInt(lvl, 0, 15)
					target.NbOn = on == 1
				}
			case 3:
				lvl, err1 := strconv.Atoi(arg[:2])
				on, err2 := strconv.Atoi(arg[2:3])
				if err1 == nil && err2 == nil {
					target.NbLevel = clampInt(lvl, 0, 15)
					target.NbOn = on == 1
				}
			case 1:
				target.NbOn = arg == "1"
			}
		}
		resp = fmt.Sprintf("%s%03d%d;", prefix, target.NbLevel, bool01(target.NbOn))
	case strings.HasPrefix(upper, "NR"):
		rx, prefix, arg := splitSubRx(upper, "NR")
		target := r.rxPtr(rx)
		if arg != "" {
			isSet = true
			if len(arg) == 3 {
				lvl, err1 := strconv.Atoi(arg[:2])
				on, err2 := strconv.Atoi(arg[2:3])
				if err1 == nil && err2 == nil {
					target.NrLevel = clampInt(lvl, 0, 10)
					target.NrOn = on == 1
				}
			} else if len(arg) == 1 {
				target.NrOn = arg == "1"
			}
		}
		resp = fmt.Sprintf("%s%02d%d;", prefix, target.NrLevel, bool01(target.NrOn))
	case strings.HasPrefix(upper, "NM"):
		rx, prefix, arg := splitSubRx(upper, "NM")
		target := r.rxPtr(rx)
		if arg != "" {
			isSet = true
			if len(arg) == 5 {
				hz, err1 := strconv.Atoi(arg[:4])
				on, err2 := strconv.Atoi(arg[4:5])
				if err1 == nil && err2 == nil {
					target.NotchHz = clampInt(hz, 150, 5000)
					target.NotchOn = on == 1
				}
			} else if len(arg) == 1 {
				target.NotchOn = arg == "1"
			}
		}
		resp = fmt.Sprintf("%s%04d%d;", prefix, target.NotchHz, bool01(target.NotchOn))
	case strings.HasPrefix(upper, "GT"):
		rx, prefix, arg := splitSubRx(upper, "GT")
		target := r.rxPtr(rx)
		if arg != "" {
			isSet = true
			if v, err := strconv.Atoi(arg); err == nil && v >= 0 && v <= 2 {
				target.Agc = v
			}
		}
		resp = fmt.Sprintf("%s%d;", prefix, target.Agc)
	case strings.HasPrefix(upper, "AP"):
		rx, prefix, arg := splitSubRx(upper, "AP")
		target := r.rxPtr(rx)
		if arg != "" {
			isSet = true
			if len(arg) == 2 {
				on, err1 := strconv.Atoi(arg[:1])
				bw, err2 := strconv.Atoi(arg[1:2])
				if err1 == nil && err2 == nil {
					target.ApfOn = on == 1
					target.ApfBwIdx = clampInt(bw, 0, 2)
				}
			}
		}
		resp = fmt.Sprintf("%s%d%d;", prefix, bool01(target.ApfOn), target.ApfBwIdx)
	case strings.HasPrefix(upper, "SMH"):
		rx, prefix, _ := splitSubRx(upper, "SMH")
		target := r.rxPtr(rx)
		return fmt.Sprintf("%s%+04d;", prefix, MeasurePassbandDbm(*target, r.CwPitchHz, tSec))
	case strings.HasPrefix(upper, "SM"):
		rx, prefix, _ := splitSubRx(upper, "SM")
		target := r.rxPtr(rx)
		dbm := MeasurePassbandDbm(*target, r.CwPitchHz, tSec)
		bars := clampInt((dbm+127)*42/114, 0, 42)
		return fmt.Sprintf("%s%02d;", prefix, bars)
	case strings.HasPrefix(upper, "#SPN"):
		rx, prefix, arg := splitSubRx(upper, "#SPN")
		target := r.rxPtr(rx)
		if arg != "" {
			isSet = true
			if v, err := strconv.Atoi(arg); err == nil {
				if v < 1000 {
					v *= 1000
				}
				target.PanSpanHz = clampInt(v, 6000, 368000)
				target.PanTierKHz = SpectrumTierKHzWithHysteresis(target.PanSpanHz, target.PanTierKHz)
			}
		}
		resp = fmt.Sprintf("%s%d;", prefix, target.PanSpanHz)
	case strings.HasPrefix(upper, "#REF"):
		rx, prefix, arg := splitSubRx(upper, "#REF")
		target := r.rxPtr(rx)
		if arg != "" {
			isSet = true
			if r.RxA.AutoRef {
				target.PanRefDbm = autoRefNoiseFloorDbm
			} else if v, err := strconv.Atoi(arg); err == nil {
				target.PanRefDbm = clampInt(v, -200, 60)
			}
		} else if r.RxA.AutoRef {
			target.PanRefDbm = autoRefNoiseFloorDbm
		}
		resp = fmt.Sprintf("%s%d;", prefix, target.PanRefDbm)
	case strings.HasPrefix(upper, "#SCL$"):
		return "#SCL?;"
	case strings.HasPrefix(upper, "#SCL"):
		arg := strings.TrimPrefix(upper, "#SCL")
		if arg != "" {
			isSet = true
			if v, err := strconv.Atoi(arg); err == nil {
				r.RxA.PanScaleDb = clampInt(v, 10, 150)
			}
		}
		resp = fmt.Sprintf("#SCL%d;", r.RxA.PanScaleDb)
	case strings.HasPrefix(upper, "#AVG"):
		arg := strings.TrimPrefix(upper, "#AVG")
		if arg != "" {
			isSet = true
			if v, err := strconv.Atoi(arg); err == nil {
				r.PanAvg = clampInt(v, 1, 20)
			}
		}
		resp = fmt.Sprintf("#AVG%02d;", r.PanAvg)
	case strings.HasPrefix(upper, "#WBS$"):
		return "#WBS?;"
	case strings.HasPrefix(upper, "#WBS"):
		arg := strings.TrimPrefix(upper, "#WBS")
		if arg != "" {
			isSet = true
			if v, err := strconv.Atoi(arg); err == nil {
				r.RxA.WfBlack = clampInt(v, 5, 30)
			}
		}
		resp = fmt.Sprintf("#WBS%d;", r.RxA.WfBlack)
	case strings.HasPrefix(upper, "#AR$"):
		return "#AR?;"
	case strings.HasPrefix(upper, "#AR"):
		arg := strings.TrimPrefix(upper, "#AR")
		if arg != "" {
			isSet = true
			switch {
			case arg == "A" || arg == "9":
				r.RxA.AutoRef = true
				r.RxA.PanRefDbm = autoRefNoiseFloorDbm
				r.RxB.PanRefDbm = autoRefNoiseFloorDbm
			case arg == "1":
				r.RxA.PanRefDbm = autoRefNoiseFloorDbm
				r.RxB.PanRefDbm = autoRefNoiseFloorDbm
			case arg == "M" || arg == "0":
				r.RxA.AutoRef = false
			case arg == "/":
				r.RxA.AutoRef = !r.RxA.AutoRef
				if r.RxA.AutoRef {
					r.RxA.PanRefDbm = autoRefNoiseFloorDbm
					r.RxB.PanRefDbm = autoRefNoiseFloorDbm
				}
			default:
				last := arg[len(arg)-1]
				if last == 'A' || last == '1' {
					r.RxA.AutoRef = true
					r.RxA.PanRefDbm = autoRefNoiseFloorDbm
					r.RxB.PanRefDbm = autoRefNoiseFloorDbm
				} else if last == 'M' || last == '0' {
					r.RxA.AutoRef = false
				}
			}
		}
		resp = fmt.Sprintf("#AR1206-02%d;", bool01(r.RxA.AutoRef))
	case strings.HasPrefix(upper, "#FXT$"):
		return "#FXT?;"
	case strings.HasPrefix(upper, "#FXT"):
		arg := strings.TrimPrefix(upper, "#FXT")
		if arg != "" {
			isSet = true
			if arg == "0" || arg == "1" {
				r.RxA.FixedTune = arg == "1"
				if !r.RxA.FixedTune {
					r.RxA.PanCenterOffsetHz = 0
					r.RxB.PanCenterOffsetHz = 0
				}
			}
		}
		resp = fmt.Sprintf("#FXT%d;", bool01(r.RxA.FixedTune))
	case strings.HasPrefix(upper, "#DPM"):
		arg := strings.TrimPrefix(upper, "#DPM")
		if arg != "" {
			isSet = true
			if v, err := strconv.Atoi(arg); err == nil && v >= 0 && v <= 2 {
				r.DualPanMode = v
			}
		}
		resp = fmt.Sprintf("#DPM%d;", r.DualPanMode)
	case strings.HasPrefix(upper, "#MP"):
		rx, prefix, arg := splitSubRx(upper, "#MP")
		target := r.rxPtr(rx)
		if rx == 'B' && !r.SubRxEnabled {
			if arg == "0" || arg == "1" {
				isSet = true
			}
			resp = "#MP$-1;"
		} else {
			if arg == "0" || arg == "1" {
				isSet = true
				target.MiniPan = arg == "1"
			}
			resp = fmt.Sprintf("%s%d;", prefix, bool01(target.MiniPan))
		}
	case upper == "#FRZ$":
		return "#FRZ?;"
	case strings.HasPrefix(upper, "#FRZ"):
		arg := strings.TrimPrefix(upper, "#FRZ")
		if arg != "" {
			isSet = true
		}
		switch arg {
		case "0":
			r.PanFrozen = false
		case "1":
			r.PanFrozen = true
		case "/":
			r.PanFrozen = !r.PanFrozen
		}
		resp = fmt.Sprintf("#FRZ%d;", bool01(r.PanFrozen))
	case upper == "#FPS$":
		return "#FPS?;"
	case strings.HasPrefix(upper, "#FPS"):
		arg := strings.TrimPrefix(upper, "#FPS")
		if arg != "" {
			isSet = true
			if v, err := strconv.Atoi(arg); err == nil {
				r.PanFPS = clampInt(v, 1, 30)
			}
		}
		resp = fmt.Sprintf("#FPS%02d;", r.PanFPS)
	case strings.HasPrefix(upper, "#NBL"):
		rx, prefix, arg := splitSubRx(upper, "#NBL")
		target := r.rxPtr(rx)
		if arg != "" {
			isSet = true
			if v, err := strconv.Atoi(arg); err == nil {
				target.PanNbLevel = clampInt(v, 0, 14)
			}
		}
		resp = fmt.Sprintf("%s%d;", prefix, target.PanNbLevel)
	case strings.HasPrefix(upper, "#NB"):
		rx, prefix, arg := splitSubRx(upper, "#NB")
		target := r.rxPtr(rx)
		if arg != "" {
			isSet = true
			if v, err := strconv.Atoi(arg); err == nil {
				target.PanNbMode = clampInt(v, 0, 2)
			}
		}
		resp = fmt.Sprintf("%s%d;", prefix, target.PanNbMode)
	case upper == "#DSM$":
		return "#DSM?;"
	case strings.HasPrefix(upper, "#DSM"):
		arg := strings.TrimPrefix(upper, "#DSM")
		if arg != "" {
			isSet = true
			if v, err := strconv.Atoi(arg); err == nil {
				if v == 0 || v == 2 {
					r.DisplayMode = 0
				} else {
					r.DisplayMode = 1
				}
			}
		}
		resp = fmt.Sprintf("#DSM%d;", r.DisplayMode)
	case upper == "#WFH$":
		return "#WFH?;"
	case strings.HasPrefix(upper, "#WFH"):
		arg := strings.TrimPrefix(upper, "#WFH")
		if arg != "" {
			isSet = true
			if v, err := strconv.Atoi(arg); err == nil {
				r.WaterfallHeightPct = clampInt(v, 0, 100)
			}
		}
		resp = fmt.Sprintf("#WFH%03d;", r.WaterfallHeightPct)
	case strings.HasPrefix(upper, "MX"):
		arg := strings.TrimPrefix(upper, "MX")
		if arg != "" {
			isSet = true
			if validAudioMixes[arg] {
				r.AudioMix = arg
			}
		}
		resp = fmt.Sprintf("MX%s;", r.AudioMix)
	case strings.HasPrefix(upper, "EM"):
		arg := strings.TrimPrefix(upper, "EM")
		if arg != "" {
			isSet = true
			if v, err := strconv.Atoi(arg); err == nil && v >= 0 && v <= 3 {
				if v >= 2 && !OpusAvailable() {
					v = 1
				}
				r.EncodeMode = v
			}
		}
		resp = fmt.Sprintf("EM%d;", r.EncodeMode)
	case strings.HasPrefix(upper, "SL"):
		arg := strings.TrimPrefix(upper, "SL")
		if arg == "" {
			return fmt.Sprintf("SL%d;", r.StreamingLatency)
		}
		if v, err := strconv.Atoi(arg); err == nil && v >= 0 && v <= 7 {
			r.StreamingLatency = v
		}
		// Hardware K4 does not echo SL<n>; SET commands.
		return ""
	default:
		return "?;"
	}

	if isSet && r.AiMode != 5 {
		return ""
	}
	return resp
}

func bandCodeForFreq(hz int64) int {
	ranges := []struct {
		bn    int
		start int64
		end   int64
	}{
		{0, 1800000, 2000000},
		{1, 3500000, 4000000},
		{2, 5330500, 5405000},
		{3, 7000000, 7300000},
		{4, 10100000, 10150000},
		{5, 14000000, 14350000},
		{6, 18068000, 18168000},
		{7, 21000000, 21450000},
		{8, 24890000, 24990000},
		{9, 28000000, 29700000},
		{10, 50000000, 54000000},
	}
	for _, b := range ranges {
		if hz >= b.start && hz <= b.end {
			return b.bn
		}
	}
	return 5
}

func (r *Radio) rxPtr(rx byte) *RxState {
	if rx == 'B' {
		return &r.RxB
	}
	return &r.RxA
}

func splitSubRx(upper, base string) (rx byte, prefix string, arg string) {
	rest := strings.TrimPrefix(upper, base)
	if strings.HasPrefix(rest, "$") {
		return 'B', base + "$", strings.TrimPrefix(rest, "$")
	}
	return 'A', base, rest
}

func formatPA(prefix string, s RxState) string {
	if s.PreampOn && s.Preamp > 0 {
		return fmt.Sprintf("%s%d1;", prefix, s.Preamp)
	}
	return fmt.Sprintf("%s00;", prefix)
}

func formatRA(prefix string, s RxState) string {
	if s.AttenOn && s.AttenDb > 0 {
		return fmt.Sprintf("%s%02d1;", prefix, s.AttenDb)
	}
	return fmt.Sprintf("%s000;", prefix)
}

func validMode(m int) bool {
	return (m >= 1 && m <= 7) || m == 9
}

func isTextDecodeCompatible(rx RxState) bool {
	if rx.Mode == ModeCW || rx.Mode == ModeCWR {
		return true
	}
	if rx.Mode == ModeDATA || rx.Mode == ModeDATAR {
		return rx.DataSubMode == 2 || rx.DataSubMode == 3
	}
	return false
}

func bool01(b bool) int {
	if b {
		return 1
	}
	return 0
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func clampInt64(v, lo, hi int64) int64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
