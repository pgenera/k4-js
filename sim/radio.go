package main

import (
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

var blockedTxPrefixes = []string{
	"DARM", "DAPM", "DAMP", "DARC",
	"#TX", "MOX", "VOX", "SWT", "SWH",
	"SP1", "SP2", "SP3",
	"TX", "TU", "KY", "KZ", "PB", "PC", "EC", "EE",
	"LB", "PS", "SW", "VX", "CP", "MG", "ML",
	"KP", "KS", "ES", "DW", "DR", "AT",
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

type DebugStats struct {
	TotalConnections    int64  `json:"totalConnections"`
	AuthPassed          int64  `json:"authPassed"`
	AuthFailed          int64  `json:"authFailed"`
	TxBlockedViolations int64  `json:"txBlockedViolations"`
	LastBlockedTxCmd    string `json:"lastBlockedTxCmd"`
	FaHz                int64  `json:"faHz"`
	FbHz                int64  `json:"fbHz"`
	ModeA               int    `json:"modeA"`
	ModeB               int    `json:"modeB"`
}

type Radio struct {
	mu sync.Mutex

	RxA              RxState
	RxB              RxState
	CwPitchHz        int
	SubRxEnabled     bool
	SplitEnabled     bool
	VfoLinked        bool
	PanAvg           int
	DualPanMode      int
	DiversityEnabled bool
	PanFrozen        bool
	PanFPS             int
	DisplayMode        int
	WaterfallHeightPct int
	SiFpEnabled        bool
	SiRfEnabled        bool
	SiDaEnabled        bool
	AudioMix           string
	EncodeMode       int
	StreamingLatency int
	AiMode           int
	ErMode           int
	K4Mode           int

	TotalConnections    int64
	AuthPassed          int64
	AuthFailed          int64
	TxBlockedViolations int64
	LastBlockedTxCmd    string
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
		RxA:              baseA,
		RxB:              baseB,
		CwPitchHz:        500,
		SubRxEnabled:     false,
		SplitEnabled:     false,
		VfoLinked:        false,
		PanAvg:           4,
		DualPanMode:        0,
		PanFPS:             20,
		DisplayMode:        1,
		WaterfallHeightPct: 60,
		AudioMix:           "A.B",
		EncodeMode:       1,
		StreamingLatency: 2,
		AiMode:           5,
		ErMode:           1,
		K4Mode:           1,
	}
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

func (r *Radio) formatSystemInfoLocked(mod string, tSec float64) string {
	volts := 13.80 + 0.03*math.Sin(tSec*0.4)
	amps := 1.66 + 0.04*math.Cos(tSec*0.7)
	fpTemp := 25.4 + 0.3*math.Sin(tSec*0.15)
	cpu1 := 45.2 + 0.6*math.Sin(tSec*0.2)
	cpu2 := 43.1 + 0.5*math.Cos(tSec*0.25)
	cpu4 := 44.8 + 0.5*math.Sin(tSec*0.18)
	paTemp := 25.0 + 0.4*math.Sin(tSec*0.12)
	lpaTemp := 24.0 + 0.3*math.Cos(tSec*0.14)
	dapTemp := 31.2 + 0.3*math.Sin(tSec*0.16)

	switch mod {
	case "FP":
		return fmt.Sprintf(
			"SIFPVS:%.2f,IS:%.2f,V10:10.19,V8:8.09,V5:4.96,VL:2.02,VH:27.09,VD:3.29,VR:0.85,TF:%.1f;SICPT1:%.1f,T2:%.1f,T4:%.1f;",
			volts, amps, fpTemp, cpu1, cpu2, cpu4,
		)
	case "RF":
		return fmt.Sprintf("SIRFV8:8.0,V5:5.0,LT:%.0f,LM:0,PA:0.0,PM:0,PT:%.0f;", lpaTemp, paTemp)
	case "DA":
		return fmt.Sprintf("SIDAV5:4.9,V3A:3.3,V3D:3.3,V1P8:1.8,V1P2:1.1,VOSC:3.2,T:%.1f;", dapTemp)
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
	}
}

func isBlockedTxCommand(upper string) bool {
	// AN; is an allowed antenna-selected GET query, whereas AN<n>; switches relays and is blocked.
	if strings.HasPrefix(upper, "AN") && upper != "AN" {
		return true
	}
	for _, p := range blockedTxPrefixes {
		if strings.HasPrefix(upper, p) {
			return true
		}
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

	var sb strings.Builder
	for _, cmd := range cmds {
		trimmed := strings.TrimSpace(cmd)
		if trimmed == "" {
			continue
		}
		upper := strings.ToUpper(trimmed)

		if isBlockedTxCommand(upper) {
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
	sb.WriteString(omOptionModuleStr)
	sb.WriteString(rvModulesStr)
	sb.WriteString("SN00421;")
	sb.WriteString(fmt.Sprintf("SL%d;", r.StreamingLatency))
	sb.WriteString("AN1;")
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
		return ""
	case upper == "ID":
		return "IDK4-SIM;"
	case upper == "OM":
		return omOptionModuleStr
	case upper == "SN":
		return "SN00421;"
	case upper == "RV":
		return rvModulesStr
	case upper == "TQ":
		return "TQ0;"
	case upper == "TB":
		return "TB000;"
	case upper == "TB$":
		return "TB$000;"
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
	case upper == "AN":
		return "AN1;"
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
		case "DD", "DU", "RC":
			// Valid telemetry module subscription acknowledged cleanly.
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
			"IF%011d     %+05d%d0 000%d00%d0%d1 ;",
			r.RxA.FreqHz,
			ritOff,
			bool01(r.RxA.RitOn),
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
				r.RxA.FreqHz = clampInt64(hz, 100000, 54000000)
			}
		}
		resp = fmt.Sprintf("FA%011d;", r.RxA.FreqHz)
	case strings.HasPrefix(upper, "FB"):
		arg := strings.TrimPrefix(upper, "FB")
		if arg != "" {
			isSet = true
			if hz, err := strconv.ParseInt(arg, 10, 64); err == nil {
				r.RxB.FreqHz = clampInt64(hz, 100000, 54000000)
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
			if off, err := strconv.ParseInt(arg, 10, 64); err == nil {
				target.PanCenterOffsetHz = clampInt64(off, -200000, 200000)
			}
		}
		fiPrefix := "FI"
		if rx == 'B' {
			fiPrefix = "FI$"
		}
		resp = fmt.Sprintf("%s%011d;", fiPrefix, clampInt64(target.FreqHz+target.PanCenterOffsetHz, 100000, 54000000))
	case strings.HasPrefix(upper, "FI"):
		rx, prefix, _ := splitSubRx(upper, "FI")
		target := r.rxPtr(rx)
		return fmt.Sprintf("%s%011d;", prefix, clampInt64(target.FreqHz+target.PanCenterOffsetHz, 100000, 54000000))
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
		if arg == "0" || arg == "1" {
			isSet = true
			r.SplitEnabled = arg == "1"
		}
		resp = fmt.Sprintf("FT%d;", bool01(r.SplitEnabled))
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
