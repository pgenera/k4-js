package main

import (
	"fmt"
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

type RxState struct {
	FreqHz      int64
	Mode        int
	DataSubMode int
	BwHz        int
	IfShiftHz   int
	StepIdx     int
	Locked      bool
	Preamp      int
	PreampOn    bool
	AttenDb     int
	AttenOn     bool
	AfGain      int
	RfGainDb    int
	Squelch     int
	NbOn        bool
	NbLevel     int
	NrOn        bool
	NrLevel     int
	NotchOn     bool
	NotchHz     int
	Agc         int
	ApfOn       bool
	ApfBwIdx    int
	PanSpanHz   int
	PanRefDbm   int
	PanScaleDb  int
	WfBlack           int
	AutoRef           bool
	MiniPan           bool
	RitOn             bool
	RitOffsetHz       int
	PanCenterOffsetHz int64
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
	AudioMix         string
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
		StepIdx:     2,
		Preamp:      0,
		AttenDb:     0,
		AfGain:      30,
		RfGainDb:    0,
		Squelch:     0,
		NbLevel:     5,
		NrLevel:     4,
		NotchHz:     750,
		Agc:         1,
		PanSpanHz:   48000,
		PanRefDbm:   -50,
		PanScaleDb:  80,
		WfBlack:     14,
	}
	baseB := baseA
	baseB.FreqHz = 14025000
	baseB.Mode = ModeCW
	baseB.BwHz = 500
	baseB.IfShiftHz = 500

	return &Radio{
		RxA:              baseA,
		RxB:              baseB,
		CwPitchHz:        500,
		SubRxEnabled:     false,
		SplitEnabled:     false,
		VfoLinked:        false,
		PanAvg:           4,
		DualPanMode:      0,
		AudioMix:         "A.B",
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
	sb.WriteString(fmt.Sprintf("VT%d;", r.RxA.StepIdx))
	sb.WriteString(fmt.Sprintf("VT$%d;", r.RxB.StepIdx))
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
	sb.WriteString(fmt.Sprintf("NB%02d%d;", r.RxA.NbLevel, bool01(r.RxA.NbOn)))
	sb.WriteString(fmt.Sprintf("NB$%02d%d;", r.RxB.NbLevel, bool01(r.RxB.NbOn)))
	sb.WriteString(fmt.Sprintf("NR%02d%d;", r.RxA.NrLevel, bool01(r.RxA.NrOn)))
	sb.WriteString(fmt.Sprintf("NR$%02d%d;", r.RxB.NrLevel, bool01(r.RxB.NrOn)))
	sb.WriteString(fmt.Sprintf("NM%04d%d;", r.RxA.NotchHz, bool01(r.RxA.NotchOn)))
	sb.WriteString(fmt.Sprintf("NM$%04d%d;", r.RxB.NotchHz, bool01(r.RxB.NotchOn)))
	sb.WriteString(fmt.Sprintf("GT%d;", r.RxA.Agc))
	sb.WriteString(fmt.Sprintf("GT$%d;", r.RxB.Agc))
	sb.WriteString(fmt.Sprintf("SMH%+04d;", MeasurePassbandDbm(r.RxA, r.CwPitchHz, tSec)))
	sb.WriteString(fmt.Sprintf("SMH$%+04d;", MeasurePassbandDbm(r.RxB, r.CwPitchHz, tSec)))
	sb.WriteString(fmt.Sprintf("#SPN%d;", r.RxA.PanSpanHz))
	sb.WriteString(fmt.Sprintf("#SPN$%d;", r.RxB.PanSpanHz))
	sb.WriteString(fmt.Sprintf("#REF%d;", r.RxA.PanRefDbm))
	sb.WriteString(fmt.Sprintf("#REF$%d;", r.RxB.PanRefDbm))
	sb.WriteString(fmt.Sprintf("#SCL%d;", r.RxA.PanScaleDb))
	sb.WriteString(fmt.Sprintf("#SCL$%d;", r.RxB.PanScaleDb))
	sb.WriteString(fmt.Sprintf("#AVG%02d;", r.PanAvg))
	sb.WriteString(fmt.Sprintf("#WBS%d;", r.RxA.WfBlack))
	sb.WriteString(fmt.Sprintf("#WBS$%d;", r.RxB.WfBlack))
	sb.WriteString(fmt.Sprintf("#AR0000+00%d;", bool01(r.RxA.AutoRef)))
	sb.WriteString(fmt.Sprintf("#AR$0000+00%d;", bool01(r.RxB.AutoRef)))
	sb.WriteString(fmt.Sprintf("#DPM%d;", r.DualPanMode))
	sb.WriteString(fmt.Sprintf("#MP%d;", bool01(r.RxA.MiniPan)))
	sb.WriteString(fmt.Sprintf("#MP$%d;", bool01(r.RxB.MiniPan)))
	sb.WriteString(fmt.Sprintf("MX%s;", r.AudioMix))
	sb.WriteString(fmt.Sprintf("EM%d;", r.EncodeMode))
	sb.WriteString("IDK4-SIM;OMAP01;SN00421;")
	return sb.String()
}

func (r *Radio) execSingleLocked(orig, upper string, tSec float64) string {
	switch {
	case upper == "RDY":
		return r.fullSnapshotLocked(tSec)
	case upper == "RX":
		return ""
	case upper == "ID":
		return "IDK4-SIM;"
	case upper == "OM":
		return "OMAP01;"
	case upper == "SN":
		return "SN00421;"
	case upper == "RV":
		return "RV.M-01.00;RV.D-01.00;"
	case upper == "TQ":
		return "TQ0;"
	case upper == "IF":
		return fmt.Sprintf(
			"IF%011d     %+05d%d00000%d%d0%d0%d0;",
			r.RxA.FreqHz,
			r.RxA.RitOffsetHz,
			bool01(r.RxA.RitOn),
			r.RxA.Mode,
			bool01(r.SplitEnabled),
			r.RxA.DataSubMode,
			0,
		)
	case strings.HasPrefix(upper, "PING"):
		ts := strings.TrimPrefix(upper, "PING")
		if ts == "" {
			ts = "0"
		}
		return "PONG" + ts + ";"
	case strings.HasPrefix(upper, "K4"):
		arg := strings.TrimPrefix(upper, "K4")
		if arg == "0" || arg == "1" {
			r.K4Mode, _ = strconv.Atoi(arg)
		}
		return fmt.Sprintf("K4%d;", r.K4Mode)
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
		if v, err := strconv.Atoi(arg); err == nil && v >= 0 && v <= 5 {
			r.AiMode = v
		}
		return fmt.Sprintf("AI%d;", r.AiMode)
	case strings.HasPrefix(upper, "FA"):
		arg := strings.TrimPrefix(upper, "FA")
		if arg != "" {
			if hz, err := strconv.ParseInt(arg, 10, 64); err == nil {
				r.RxA.FreqHz = clampInt64(hz, 100000, 54000000)
			}
		}
		return fmt.Sprintf("FA%011d;", r.RxA.FreqHz)
	case strings.HasPrefix(upper, "FB"):
		arg := strings.TrimPrefix(upper, "FB")
		if arg != "" {
			if hz, err := strconv.ParseInt(arg, 10, 64); err == nil {
				r.RxB.FreqHz = clampInt64(hz, 100000, 54000000)
			}
		}
		return fmt.Sprintf("FB%011d;", r.RxB.FreqHz)
	case strings.HasPrefix(upper, "MD"):
		rx, prefix, arg := splitSubRx(upper, "MD")
		target := r.rxPtr(rx)
		if arg != "" {
			if m, err := strconv.Atoi(arg); err == nil && validMode(m) {
				target.Mode = m
			}
		}
		return fmt.Sprintf("%s%d;", prefix, target.Mode)
	case strings.HasPrefix(upper, "DT"):
		rx, prefix, arg := splitSubRx(upper, "DT")
		target := r.rxPtr(rx)
		if arg != "" {
			if d, err := strconv.Atoi(arg); err == nil && d >= 0 && d <= 3 {
				target.DataSubMode = d
			}
		}
		return fmt.Sprintf("%s%d;", prefix, target.DataSubMode)
	case strings.HasPrefix(upper, "BW"):
		rx, prefix, arg := splitSubRx(upper, "BW")
		target := r.rxPtr(rx)
		if arg != "" {
			if v, err := strconv.Atoi(arg); err == nil {
				target.BwHz = clampInt(v*10, 50, 5000)
			}
		}
		return fmt.Sprintf("%s%04d;", prefix, target.BwHz/10)
	case strings.HasPrefix(upper, "IS"):
		rx, prefix, arg := splitSubRx(upper, "IS")
		target := r.rxPtr(rx)
		arg = strings.TrimSpace(arg)
		if arg != "" {
			if v, err := strconv.Atoi(arg); err == nil {
				target.IfShiftHz = clampInt(v*10, 0, 5000)
			}
		}
		return fmt.Sprintf("%s%04d;", prefix, target.IfShiftHz/10)
	case strings.HasPrefix(upper, "CW"):
		arg := strings.TrimPrefix(upper, "CW")
		if arg != "" {
			if v, err := strconv.Atoi(arg); err == nil {
				r.CwPitchHz = clampInt(v*10, 250, 950)
			}
		}
		return fmt.Sprintf("CW%02d;", r.CwPitchHz/10)
	case strings.HasPrefix(upper, "VT"):
		rx, prefix, arg := splitSubRx(upper, "VT")
		target := r.rxPtr(rx)
		if len(arg) >= 1 {
			if idx, err := strconv.Atoi(arg[:1]); err == nil && idx >= 0 && idx <= 6 {
				target.StepIdx = idx
			}
		}
		return fmt.Sprintf("%s%d;", prefix, target.StepIdx)
	case strings.HasPrefix(upper, "LK"):
		rx, prefix, arg := splitSubRx(upper, "LK")
		target := r.rxPtr(rx)
		if arg == "0" || arg == "1" {
			target.Locked = arg == "1"
		}
		return fmt.Sprintf("%s%d;", prefix, bool01(target.Locked))
	case strings.HasPrefix(upper, "SB"):
		arg := strings.TrimPrefix(upper, "SB")
		if arg == "0" || arg == "1" {
			r.SubRxEnabled = arg == "1"
		}
		return fmt.Sprintf("SB%d;", bool01(r.SubRxEnabled))
	case upper == "SP0":
		return "SP0;"
	case strings.HasPrefix(upper, "SP"):
		// SP is SET-only in D4; bare SP; or invalid SP args return ?;
		return "?;"
	case strings.HasPrefix(upper, "DV"):
		arg := strings.TrimPrefix(upper, "DV")
		switch arg {
		case "0":
			r.DiversityEnabled = false
		case "1":
			r.DiversityEnabled = true
			r.SubRxEnabled = true
		case "/":
			r.DiversityEnabled = !r.DiversityEnabled
			if r.DiversityEnabled {
				r.SubRxEnabled = true
			}
		}
		return fmt.Sprintf("DV%d;", bool01(r.DiversityEnabled))
	case strings.HasPrefix(upper, "FC"):
		rx, _, arg := splitSubRx(upper, "FC")
		target := r.rxPtr(rx)
		if arg == "" {
			target.PanCenterOffsetHz = 0
		} else if off, err := strconv.ParseInt(arg, 10, 64); err == nil {
			target.PanCenterOffsetHz = clampInt64(off, -200000, 200000)
		}
		fiPrefix := "FI"
		if rx == 'B' {
			fiPrefix = "FI$"
		}
		return fmt.Sprintf("%s%011d;", fiPrefix, clampInt64(target.FreqHz+target.PanCenterOffsetHz, 100000, 54000000))
	case strings.HasPrefix(upper, "FI"):
		rx, prefix, _ := splitSubRx(upper, "FI")
		target := r.rxPtr(rx)
		return fmt.Sprintf("%s%011d;", prefix, clampInt64(target.FreqHz+target.PanCenterOffsetHz, 100000, 54000000))
	case strings.HasPrefix(upper, "RT"):
		rx, prefix, arg := splitSubRx(upper, "RT")
		target := r.rxPtr(rx)
		switch arg {
		case "0":
			target.RitOn = false
		case "1":
			target.RitOn = true
		case "/":
			target.RitOn = !target.RitOn
		}
		return fmt.Sprintf("%s%d;", prefix, bool01(target.RitOn))
	case strings.HasPrefix(upper, "RO"):
		rx, prefix, arg := splitSubRx(upper, "RO")
		target := r.rxPtr(rx)
		if arg != "" {
			if v, err := strconv.Atoi(arg); err == nil {
				target.RitOffsetHz = clampInt(v, -9999, 9999)
			}
		}
		return fmt.Sprintf("%s%+05d;", prefix, target.RitOffsetHz)
	case strings.HasPrefix(upper, "FT"):
		arg := strings.TrimPrefix(upper, "FT")
		if arg == "0" || arg == "1" {
			r.SplitEnabled = arg == "1"
		}
		return fmt.Sprintf("FT%d;", bool01(r.SplitEnabled))
	case strings.HasPrefix(upper, "LN"):
		arg := strings.TrimPrefix(upper, "LN")
		if arg == "0" || arg == "1" {
			r.VfoLinked = arg == "1"
		}
		return fmt.Sprintf("LN%d;", bool01(r.VfoLinked))
	case strings.HasPrefix(upper, "BN"):
		rx, prefix, arg := splitSubRx(upper, "BN")
		target := r.rxPtr(rx)
		bnCode := bandCodeForFreq(target.FreqHz)
		if arg != "" {
			if bn, err := strconv.Atoi(arg); err == nil {
				if hz, ok := bandDefaults[bn]; ok {
					target.FreqHz = hz
					bnCode = bn
				}
			}
		}
		vfo := "FA"
		if rx == 'B' {
			vfo = "FB"
		}
		return fmt.Sprintf("%s%02d;%s%011d;", prefix, bnCode, vfo, target.FreqHz)
	case strings.HasPrefix(upper, "PA"):
		rx, prefix, arg := splitSubRx(upper, "PA")
		target := r.rxPtr(rx)
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
		return formatPA(prefix, *target)
	case strings.HasPrefix(upper, "RA"):
		rx, prefix, arg := splitSubRx(upper, "RA")
		target := r.rxPtr(rx)
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
		return formatRA(prefix, *target)
	case strings.HasPrefix(upper, "AG"):
		rx, prefix, arg := splitSubRx(upper, "AG")
		target := r.rxPtr(rx)
		if arg != "" {
			if v, err := strconv.Atoi(arg); err == nil {
				target.AfGain = clampInt(v, 0, 60)
			}
		}
		return fmt.Sprintf("%s%03d;", prefix, target.AfGain)
	case strings.HasPrefix(upper, "RG"):
		rx, prefix, arg := splitSubRx(upper, "RG")
		target := r.rxPtr(rx)
		if arg != "" {
			if v, err := strconv.Atoi(arg); err == nil {
				target.RfGainDb = clampInt(v, -60, 0)
			}
		}
		return fmt.Sprintf("%s%03d;", prefix, target.RfGainDb)
	case strings.HasPrefix(upper, "SQ"):
		rx, prefix, arg := splitSubRx(upper, "SQ")
		target := r.rxPtr(rx)
		if arg != "" {
			if v, err := strconv.Atoi(arg); err == nil {
				target.Squelch = clampInt(v, 0, 40)
			}
		}
		return fmt.Sprintf("%s%03d;", prefix, target.Squelch)
	case strings.HasPrefix(upper, "NB"):
		rx, prefix, arg := splitSubRx(upper, "NB")
		target := r.rxPtr(rx)
		if len(arg) == 3 {
			lvl, err1 := strconv.Atoi(arg[:2])
			on, err2 := strconv.Atoi(arg[2:3])
			if err1 == nil && err2 == nil {
				target.NbLevel = clampInt(lvl, 0, 15)
				target.NbOn = on == 1
			}
		} else if len(arg) == 1 {
			target.NbOn = arg == "1"
		}
		return fmt.Sprintf("%s%02d%d;", prefix, target.NbLevel, bool01(target.NbOn))
	case strings.HasPrefix(upper, "NR"):
		rx, prefix, arg := splitSubRx(upper, "NR")
		target := r.rxPtr(rx)
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
		return fmt.Sprintf("%s%02d%d;", prefix, target.NrLevel, bool01(target.NrOn))
	case strings.HasPrefix(upper, "NM"):
		rx, prefix, arg := splitSubRx(upper, "NM")
		target := r.rxPtr(rx)
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
		return fmt.Sprintf("%s%04d%d;", prefix, target.NotchHz, bool01(target.NotchOn))
	case strings.HasPrefix(upper, "GT"):
		rx, prefix, arg := splitSubRx(upper, "GT")
		target := r.rxPtr(rx)
		if arg != "" {
			if v, err := strconv.Atoi(arg); err == nil && v >= 0 && v <= 2 {
				target.Agc = v
			}
		}
		return fmt.Sprintf("%s%d;", prefix, target.Agc)
	case strings.HasPrefix(upper, "AP"):
		rx, prefix, arg := splitSubRx(upper, "AP")
		target := r.rxPtr(rx)
		if len(arg) == 2 {
			on, err1 := strconv.Atoi(arg[:1])
			bw, err2 := strconv.Atoi(arg[1:2])
			if err1 == nil && err2 == nil {
				target.ApfOn = on == 1
				target.ApfBwIdx = clampInt(bw, 0, 2)
			}
		}
		return fmt.Sprintf("%s%d%d;", prefix, bool01(target.ApfOn), target.ApfBwIdx)
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
			if v, err := strconv.Atoi(arg); err == nil {
				if v < 1000 {
					v *= 1000
				}
				target.PanSpanHz = clampInt(v, 6000, 368000)
			}
		}
		return fmt.Sprintf("%s%d;", prefix, target.PanSpanHz)
	case strings.HasPrefix(upper, "#REF"):
		rx, prefix, arg := splitSubRx(upper, "#REF")
		target := r.rxPtr(rx)
		if arg != "" {
			if v, err := strconv.Atoi(arg); err == nil {
				target.PanRefDbm = clampInt(v, -200, 60)
			}
		}
		return fmt.Sprintf("%s%d;", prefix, target.PanRefDbm)
	case strings.HasPrefix(upper, "#SCL"):
		rx, prefix, arg := splitSubRx(upper, "#SCL")
		target := r.rxPtr(rx)
		if arg != "" {
			if v, err := strconv.Atoi(arg); err == nil {
				target.PanScaleDb = clampInt(v, 10, 150)
			}
		}
		return fmt.Sprintf("%s%d;", prefix, target.PanScaleDb)
	case strings.HasPrefix(upper, "#AVG"):
		arg := strings.TrimPrefix(upper, "#AVG")
		if arg != "" {
			if v, err := strconv.Atoi(arg); err == nil {
				r.PanAvg = clampInt(v, 1, 20)
			}
		}
		return fmt.Sprintf("#AVG%02d;", r.PanAvg)
	case strings.HasPrefix(upper, "#WBS"):
		rx, prefix, arg := splitSubRx(upper, "#WBS")
		target := r.rxPtr(rx)
		if arg != "" {
			if v, err := strconv.Atoi(arg); err == nil {
				target.WfBlack = clampInt(v, 5, 30)
			}
		}
		return fmt.Sprintf("%s%d;", prefix, target.WfBlack)
	case strings.HasPrefix(upper, "#AR"):
		rx, prefix, arg := splitSubRx(upper, "#AR")
		target := r.rxPtr(rx)
		if arg != "" {
			last := arg[len(arg)-1]
			if last == 'A' || last == '1' {
				target.AutoRef = true
			} else if last == 'M' || last == '0' {
				target.AutoRef = false
			}
		}
		return fmt.Sprintf("%s0000+00%d;", prefix, bool01(target.AutoRef))
	case strings.HasPrefix(upper, "#DPM"):
		arg := strings.TrimPrefix(upper, "#DPM")
		if arg != "" {
			if v, err := strconv.Atoi(arg); err == nil && v >= 0 && v <= 2 {
				r.DualPanMode = v
			}
		}
		return fmt.Sprintf("#DPM%d;", r.DualPanMode)
	case strings.HasPrefix(upper, "#MP"):
		rx, prefix, arg := splitSubRx(upper, "#MP")
		target := r.rxPtr(rx)
		if arg == "0" || arg == "1" {
			target.MiniPan = arg == "1"
		}
		return fmt.Sprintf("%s%d;", prefix, bool01(target.MiniPan))
	case strings.HasPrefix(upper, "#FRZ"):
		arg := strings.TrimPrefix(upper, "#FRZ")
		switch arg {
		case "0":
			r.PanFrozen = false
		case "1":
			r.PanFrozen = true
		case "/":
			r.PanFrozen = !r.PanFrozen
		}
		return fmt.Sprintf("#FRZ%d;", bool01(r.PanFrozen))
	case strings.HasPrefix(upper, "MX"):
		arg := strings.TrimPrefix(upper, "MX")
		if arg != "" && validAudioMixes[arg] {
			r.AudioMix = arg
		}
		return fmt.Sprintf("MX%s;", r.AudioMix)
	case strings.HasPrefix(upper, "EM"):
		arg := strings.TrimPrefix(upper, "EM")
		if arg != "" {
			if v, err := strconv.Atoi(arg); err == nil && v >= 0 && v <= 3 {
				// Simulator only synthesizes PCM (EM0/EM1); downgrade EM2/EM3 cleanly.
				if v >= 2 {
					v = 1
				}
				r.EncodeMode = v
			}
		}
		return fmt.Sprintf("EM%d;", r.EncodeMode)
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
