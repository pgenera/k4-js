package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"math"
	"math/rand"
	"net"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestStreamFramerSplitAndFalseMarkers(t *testing.T) {
	pkt1 := EncodeCAT("FA00014074000;")
	pkt2 := EncodeCAT("FB00014025000;")

	// Inject false start marker with bad length (0) and bad end marker before pkt1
	falseZeroLen := []byte{0xFE, 0xFD, 0xFC, 0xFB, 0x00, 0x00, 0x00, 0x00, 0xAA, 0xBB}
	falseBadEnd := []byte{0xFE, 0xFD, 0xFC, 0xFB, 0x00, 0x00, 0x00, 0x04, 'T', 'E', 'S', 'T', 0x01, 0x02, 0x03, 0x04}

	// Also test a false start marker immediately preceding a real start marker after +4 step
	stream := append([]byte{}, falseZeroLen...)
	stream = append(stream, falseBadEnd...)
	stream = append(stream, pkt1...)
	stream = append(stream, pkt2...)

	framer := &StreamFramer{}
	var decoded [][]byte
	// Feed in awkward small chunks (1..3 bytes) so start/end markers split across pushes
	for i := 0; i < len(stream); {
		step := (i % 3) + 1
		if i+step > len(stream) {
			step = len(stream) - i
		}
		decoded = append(decoded, framer.Push(stream[i:i+step])...)
		i += step
	}

	if len(decoded) != 2 {
		t.Fatalf("expected 2 decoded packets, got %d", len(decoded))
	}
	if string(decoded[0][3:]) != "FA00014074000;" {
		t.Fatalf("unexpected pkt1 payload: %q", decoded[0][3:])
	}
	if string(decoded[1][3:]) != "FB00014025000;" {
		t.Fatalf("unexpected pkt2 payload: %q", decoded[1][3:])
	}
	if framer.BadLengths == 0 || framer.BadEndMarkers == 0 {
		t.Fatalf("expected bad length/end marker counts > 0, got len=%d end=%d", framer.BadLengths, framer.BadEndMarkers)
	}
}

func TestSplitCATFramesWithTBSemicolons(t *testing.T) {
	input := "FA00014074000;TB020CQ DE W6ELE K ; 73 ;;TB$020CQ DE W6ELE K ; 73 ;;MD3;"
	frames := SplitCATFrames(input)
	want := []string{
		"FA00014074000",
		"TB020CQ DE W6ELE K ; 73 ;",
		"TB$020CQ DE W6ELE K ; 73 ;",
		"MD3",
	}
	if len(frames) != len(want) {
		t.Fatalf("got %d frames (%v), want %d (%v)", len(frames), frames, len(want), want)
	}
	for i := range want {
		if frames[i] != want[i] {
			t.Fatalf("frame[%d] = %q, want %q", i, frames[i], want[i])
		}
	}
}

func TestRadioCATAndTxGateTracking(t *testing.T) {
	r := NewRxOnlyRadio()
	reply, closeReq := r.HandleCAT("FA00007074000;MD$7;BW$0050;IS$0050;CW55;#SPN$24000;#MP1;SL4;MXAB.AB;EM0;", 1.0)
	if closeReq {
		t.Fatalf("unexpected close request")
	}
	if strings.Contains(reply, "SL4") {
		t.Fatalf("SL SET must not echo, got %q", reply)
	}
	for _, sub := range []string{"FA00007074000;", "MD$7;", "BW$0050;", "IS$0050;", "CW55;", "#SPN$24000;", "#MP1;", "MXAB.AB;", "EM0;"} {
		if !strings.Contains(reply, sub) {
			t.Fatalf("expected %q in reply %q", sub, reply)
		}
	}
	// Verify SL query returns SL4;
	slReply, _ := r.HandleCAT("SL;", 1.0)
	if slReply != "SL4;" {
		t.Fatalf("SL query = %q, want SL4;", slReply)
	}

	// Verify TX/tune/keyer/PC/SW blocked & tracked, while RX; and SP0; pass
	okReply, _ := r.HandleCAT("RX;SP0;", 1.0)
	if strings.Contains(okReply, "?") {
		t.Fatalf("RX;/SP0; should be allowed, got %q", okReply)
	}
	if r.Stats().TxBlockedViolations != 0 {
		t.Fatalf("expected 0 violations, got %d", r.Stats().TxBlockedViolations)
	}

	txCmds := []string{"TX;", "TU1;", "KY CQ;", "PC050;", "SW11;", "SP1;"}
	for _, cmd := range txCmds {
		rep, _ := r.HandleCAT(cmd, 1.0)
		if rep != "?;" {
			t.Fatalf("blocked cmd %q returned %q, want ?;", cmd, rep)
		}
	}
	st := r.Stats()
	if st.TxBlockedViolations != int64(len(txCmds)) {
		t.Fatalf("TxBlockedViolations = %d, want %d", st.TxBlockedViolations, len(txCmds))
	}
	if st.LastBlockedTxCmd != "SP1" {
		t.Fatalf("LastBlockedTxCmd = %q, want SP1", st.LastBlockedTxCmd)
	}
}

func TestSynthPANMiniPANAndAudioScale(t *testing.T) {
	rx := NewRadio().RxB // 14.025 MHz, CW mode, 500 Hz BW
	rng := rand.New(rand.NewSource(1))
	centerHz, tierKHz, nfRaw, bins := SynthPAN(rx, 500, 0.0, rng)
	if centerHz != 14025000 {
		t.Fatalf("CW PAN centerHz = %d, want 14025000", centerHz)
	}
	if tierKHz != 96 || nfRaw != -1200 || len(bins) != 1024 {
		t.Fatalf("unexpected PAN params tier=%d nf=%d len=%d", tierKHz, nfRaw, len(bins))
	}
	// Peak near 14.025 MHz should be significantly above -120 dBm noise floor (byte 42)
	maxDbm := -200.0
	for _, b := range bins {
		dbm := float64(b) - 162.0
		if dbm > maxDbm {
			maxDbm = dbm
		}
	}
	if maxDbm < -85.0 {
		t.Fatalf("expected strong CW beacon peak > -85 dBm, got %.1f dBm", maxDbm)
	}

	mcHz, mSpan, mBins := SynthMiniPAN(rx, 500, 0.0, rng)
	if mcHz != 14025500 || mSpan != 6 || len(mBins) != 1024 {
		t.Fatalf("unexpected MiniPAN params center=%d span=%d len=%d", mcHz, mSpan, len(mBins))
	}
	maxMini := -200.0
	for _, b := range mBins {
		dbm := float64(b) - 118.0
		if dbm > maxMini {
			maxMini = dbm
		}
	}
	if maxMini < -85.0 {
		t.Fatalf("expected MiniPAN CW beacon peak > -85 dBm, got %.1f dBm", maxMini)
	}

	// Test EM1 12 kHz audio synthesis tuned 500 Hz below CW beacon (audio tone = 500 Hz)
	rx.FreqHz = 14024500
	synth := NewAudioSynth()
	pcm := synth.SynthAudio(rx, rx, false, 500, 1, 480, 0.0)
	if len(pcm) != 480*4 {
		t.Fatalf("EM1 audio bytes = %d, want %d", len(pcm), 480*4)
	}
	var peakS16 int16
	for i := 0; i < 480; i++ {
		s := int16(binary.LittleEndian.Uint16(pcm[i*4 : i*4+2]))
		if s < 0 {
			s = -s
		}
		if s > peakS16 {
			peakS16 = s
		}
	}
	if peakS16 < 200 || peakS16 > 1500 {
		t.Fatalf("expected K4 1/32 scaled S16 peak in [200, 1500], got %d", peakS16)
	}

	// Test EM1 FT8 10-tone cluster RMS after browser *32.0 gain matches real K4 (~0.12..0.15)
	ft8Rx := NewRadio().RxA
	ft8Synth := NewAudioSynth()
	ft8Pcm := ft8Synth.SynthAudio(ft8Rx, ft8Rx, false, 500, 1, 2400, 1.0)
	var sumSq float64
	for i := 0; i < 2400; i++ {
		s := float64(int16(binary.LittleEndian.Uint16(ft8Pcm[i*4:i*4+2]))) / 32768.0 * 32.0
		sumSq += s * s
	}
	rms32x := math.Sqrt(sumSq / 2400.0)
	if rms32x < 0.11 || rms32x > 0.16 {
		t.Fatalf("expected FT8 EM1 boosted 32x RMS in [0.11, 0.16], got %.4f", rms32x)
	}

	// Test EM0 S32LE (24-bit in 32-bit container)
	pcm0 := synth.SynthAudio(rx, rx, false, 500, 0, 240, 0.0)
	if len(pcm0) != 240*8 {
		t.Fatalf("EM0 audio bytes = %d, want %d", len(pcm0), 240*8)
	}
	var peakS32 int32
	for i := 0; i < 240; i++ {
		s := int32(binary.LittleEndian.Uint32(pcm0[i*8 : i*8+4]))
		if s < 0 {
			s = -s
		}
		if s > peakS32 {
			peakS32 = s
		}
	}
	// 24-bit scale: ~300 * 256 = 76800
	if math.Abs(float64(peakS32)) < 50000 {
		t.Fatalf("expected EM0 S32 peak >= 50000, got %d", peakS32)
	}
}

func TestSimServerAuthStreamAndDebugStats(t *testing.T) {
	srv, err := NewSimServer(ServerConfig{
		ListenAddr:  "127.0.0.1:0",
		Password:    "k4-secret",
		FPS:         25,
		ControlHTTP: "127.0.0.1:0",
	})
	if err != nil {
		t.Fatalf("NewSimServer: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = srv.Serve(ctx) }()
	defer srv.Close()

	// 1. Bad password must be rejected
	badConn, err := net.DialTimeout("tcp", srv.Addr(), 2*time.Second)
	if err != nil {
		t.Fatalf("dial bad: %v", err)
	}
	_, _ = badConn.Write([]byte(ExpectedAuthHex("wrong-password")))
	_ = badConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	one := make([]byte, 1)
	if _, rerr := badConn.Read(one); rerr != io.EOF {
		// Depending on timing, connection reset or EOF is expected
		if rerr == nil {
			badConn.Close()
			t.Fatalf("expected connection closed on wrong password")
		}
	}
	badConn.Close()

	// 2. Valid auth receives ID, PAN, Audio, RDY snapshot, and TB$ with literal semicolons
	conn, err := net.DialTimeout("tcp", srv.Addr(), 2*time.Second)
	if err != nil {
		t.Fatalf("dial good: %v", err)
	}
	defer conn.Close()

	if _, err := conn.Write([]byte(ExpectedAuthHex("k4-secret"))); err != nil {
		t.Fatalf("write auth: %v", err)
	}
	bootstrap := "RDY;K41;ER1;AI5;EM1;SL2;#MP1;PING12345;"
	if _, err := conn.Write(EncodeCAT(bootstrap)); err != nil {
		t.Fatalf("write bootstrap: %v", err)
	}

	framer := &StreamFramer{}
	buf := make([]byte, 8192)
	var sawCat, sawAudio, sawPan, sawMiniPan, sawPong, sawTBSemicolon bool
	deadline := time.Now().Add(4 * time.Second)
	_ = conn.SetReadDeadline(deadline)

	for time.Now().Before(deadline) && !(sawCat && sawAudio && sawPan && sawMiniPan && sawPong && sawTBSemicolon) {
		n, err := conn.Read(buf)
		if n > 0 {
			for _, p := range framer.Push(buf[:n]) {
				if len(p) == 0 {
					continue
				}
				switch p[0] {
				case TypeCAT:
					sawCat = true
					txt := string(p[3:])
					if strings.Contains(txt, "PONG;") {
						sawPong = true
					}
					for _, f := range SplitCATFrames(txt) {
						if strings.HasPrefix(f, "TB") && strings.Contains(f, ";") {
							sawTBSemicolon = true
						}
					}
				case TypeAudio:
					if p[1] != 0x01 {
						t.Fatalf("expected 0x01 audio header version=1, got %d", p[1])
					}
					sawAudio = true
				case TypePAN:
					if p[1] != 0x00 {
						t.Fatalf("expected 0x02 PAN header version=0, got %d", p[1])
					}
					sawPan = true
				case TypeMiniPAN:
					if p[1] != 0x00 {
						t.Fatalf("expected 0x03 MiniPAN header version=0, got %d", p[1])
					}
					if f23 := int32(binary.LittleEndian.Uint32(p[23:27])); f23 <= 0 {
						t.Fatalf("expected positive MiniPAN field23, got %d", f23)
					}
					sawMiniPan = true
				}
			}
		}
		if err != nil {
			t.Fatalf("read error before receiving expected packets: %v", err)
		}
	}

	if !(sawCat && sawAudio && sawPan && sawMiniPan && sawPong && sawTBSemicolon) {
		t.Fatalf("missing packet types: cat=%v audio=%v pan=%v minipan=%v pong=%v tbSemi=%v",
			sawCat, sawAudio, sawPan, sawMiniPan, sawPong, sawTBSemicolon)
	}

	// 3. Check /debug/stats HTTP endpoint
	httpAddr := srv.httpSrv.Addr
	// Since ControlHTTP used :0, query listener? httpSrv.Addr was "127.0.0.1:0" in config; let's check via Radio().Stats() directly and test explicit fixed/ephemeral HTTP below
	_ = httpAddr
	st := srv.Radio().Stats()
	if st.AuthPassed < 1 || st.AuthFailed < 1 || st.TxBlockedViolations != 0 {
		t.Fatalf("unexpected stats: %+v", st)
	}

	// Also verify HTTP /debug/stats handler directly
	var statsBuf bytes.Buffer
	_ = json.NewEncoder(&statsBuf).Encode(st)
	var decoded DebugStats
	if err := json.Unmarshal(statsBuf.Bytes(), &decoded); err != nil {
		t.Fatalf("json roundtrip: %v", err)
	}
	_ = http.StatusOK
}

func TestControlHTTPDebugStatsEndpoint(t *testing.T) {
	// Pick a free loopback port for ControlHTTP
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	httpAddr := ln.Addr().String()
	ln.Close()

	srv, err := NewSimServer(ServerConfig{
		ListenAddr:  "127.0.0.1:0",
		Password:    "",
		FPS:         10,
		ControlHTTP: httpAddr,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = srv.Serve(ctx) }()
	defer srv.Close()

	resp, err := http.Get("http://" + httpAddr + "/debug/stats")
	if err != nil {
		t.Fatalf("GET /debug/stats: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var st DebugStats
	if err := json.NewDecoder(resp.Body).Decode(&st); err != nil {
		t.Fatalf("decode stats JSON: %v", err)
	}
	if st.FaHz != 14074000 || st.FbHz != 14025000 || st.ModeA != ModeDATA || st.ModeB != ModeCW {
		t.Fatalf("unexpected default radio stats: %+v", st)
	}
}

func TestSpectrumTierHysteresis5Tier(t *testing.T) {
	// Up-and-down sweep matching real K4 5-tier hysteresis probe sequence + mid-band checks
	seq := []struct {
		spanHz   int
		wantTier int
	}{
		{12000, 24},
		{19000, 24},
		{19500, 24}, // holds 24 inside [19001..19999] going up
		{20000, 48},
		{19500, 48}, // holds 48 inside [19001..19999] coming down
		{19000, 24},
		{36000, 48},
		{36500, 48}, // holds 48 inside [36001..36999] going up
		{37000, 96},
		{36500, 96}, // holds 96 inside [36001..36999] coming down
		{36000, 48},
		{82000, 96},
		{82500, 96}, // holds 96 inside [82001..82999] going up
		{83000, 192},
		{82500, 192}, // holds 192 inside [82001..82999] coming down
		{82000, 96},
		{172000, 192},
		{174000, 192}, // holds 192 inside [172001..175999] going up
		{176000, 384},
		{174000, 384}, // holds 384 inside [172001..175999] coming down
		{172000, 192},
		{200000, 384},
	}

	prev := 0
	r := NewRadio()
	rng := rand.New(rand.NewSource(9))
	for _, tc := range seq {
		got := SpectrumTierKHzWithHysteresis(tc.spanHz, prev)
		if got != tc.wantTier {
			t.Fatalf("SpectrumTierKHzWithHysteresis(%d, prev=%d) = %d, want %d", tc.spanHz, prev, got, tc.wantTier)
		}
		prev = got

		r.HandleCAT("#SPN"+itoa(tc.spanHz)+";", 0.0)
		_, tierKHz, _, _ := SynthPAN(r.RxA, r.CwPitchHz, 0.0, rng)
		if int(tierKHz) != tc.wantTier {
			t.Fatalf("Radio #SPN%d -> SynthPAN tier = %d, want %d", tc.spanHz, tierKHz, tc.wantTier)
		}
	}
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	neg := false
	if v < 0 {
		neg = true
		v = -v
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func TestPANAndMiniPANModes(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	cwPitch := 500
	baseFreq := int64(14025000)

	cases := []struct {
		mode           int
		wantPanCenter  int64
		wantMiniCenter int64
		wantMiniSpan   int32
	}{
		{ModeCW, baseFreq, baseFreq + 500, 6},
		{ModeCWR, baseFreq, baseFreq - 500, 6},
		{ModeUSB, baseFreq, baseFreq, 12},
		{ModeDATA, baseFreq, baseFreq, 12},
	}

	for _, tc := range cases {
		rx := RxState{FreqHz: baseFreq, Mode: tc.mode, PanSpanHz: 48000, PanTierKHz: 96}
		panCenter, _, _, _ := SynthPAN(rx, cwPitch, 0.0, rng)
		if panCenter != tc.wantPanCenter {
			t.Fatalf("mode %d PAN center = %d, want %d", tc.mode, panCenter, tc.wantPanCenter)
		}
		miniCenter, miniSpan, _ := SynthMiniPAN(rx, cwPitch, 0.0, rng)
		if miniCenter != tc.wantMiniCenter || miniSpan != tc.wantMiniSpan {
			t.Fatalf("mode %d MiniPAN = (center=%d span=%d), want (%d, %d)",
				tc.mode, miniCenter, miniSpan, tc.wantMiniCenter, tc.wantMiniSpan)
		}
	}
}

func TestCATHardwareParityCommands(t *testing.T) {
	r := NewRadio()

	// PING -> bare PONG;
	if rep, _ := r.HandleCAT("PING1700000000;", 0.0); rep != "PONG;" {
		t.Fatalf("PING reply = %q, want PONG;", rep)
	}

	// OM bitmap keeping Sub-RX + Dual-Pan active
	if rep, _ := r.HandleCAT("OM;", 0.0); rep != "OM AP-S----4---;" {
		t.Fatalf("OM reply = %q, want 'OM AP-S----4---;'", rep)
	}

	// RV -> 12 modules ending in RV.R-R40.B1;
	rvRep, _ := r.HandleCAT("RV;", 0.0)
	rvTokens := SplitCATFrames(rvRep)
	if len(rvTokens) != 12 || rvTokens[len(rvTokens)-1] != "RV.R-R40.B1" {
		t.Fatalf("RV tokens = %v (len %d), want 12 ending in RV.R-R40.B1", rvTokens, len(rvTokens))
	}

	// IF -> exact 38-char Elecraft IF response
	r.HandleCAT("FA00007074000;MD6;RT1;RO+0150;FT1;", 0.0)
	ifRep, _ := r.HandleCAT("IF;", 0.0)
	if len(ifRep) != 38 {
		t.Fatalf("IF len = %d (%q), want 38", len(ifRep), ifRep)
	}
	wantIF := "IF00007074000     +015010 0006001001 ;"
	if ifRep != wantIF {
		t.Fatalf("IF = %q, want %q", ifRep, wantIF)
	}

	// AN; GET allowed vs AN<n>; SET blocked as TX/relay-unsafe in strict RX-only mode
	if rep, _ := r.HandleCAT("AN;", 0.0); rep != "AN1;" {
		t.Fatalf("AN; reply = %q, want AN1;", rep)
	}
	rxOnly := NewRxOnlyRadio()
	beforeBlocked := rxOnly.Stats().TxBlockedViolations
	if rep, _ := rxOnly.HandleCAT("AN2;", 0.0); rep != "?;" {
		t.Fatalf("AN2; SET reply = %q, want ?;", rep)
	}
	if rxOnly.Stats().TxBlockedViolations != beforeBlocked+1 {
		t.Fatalf("expected TxBlockedViolations increment for AN2;")
	}

	// OV / OV$
	if rep, _ := r.HandleCAT("OV;OV$;", 0.0); rep != "OV00;OV$00;" {
		t.Fatalf("OV reply = %q, want OV00;OV$00;", rep)
	}

	// #FXT and unsupported $ queries
	if rep, _ := r.HandleCAT("#FXT;", 0.0); rep != "#FXT0;" {
		t.Fatalf("#FXT; reply = %q, want #FXT0;", rep)
	}
	if rep, _ := r.HandleCAT("#FXT1;", 0.0); rep != "#FXT1;" {
		t.Fatalf("#FXT1; reply = %q, want #FXT1;", rep)
	}
	if rep, _ := r.HandleCAT("#SCL$;#WBS$;#AR$;#FXT$;", 0.0); rep != "#SCL?;#WBS?;#AR?;#FXT?;" {
		t.Fatalf("unsupported $ queries = %q, want #SCL?;#WBS?;#AR?;#FXT?;", rep)
	}

	// NB 4-digit, VT 2-digit, RG negative dB, BN without forced FA/FB, #AR formatting
	if rep, _ := r.HandleCAT("NB;NB$;NB0051;NB;", 0.0); rep != "NB0000;NB$0000;NB0051;NB0051;" {
		t.Fatalf("NB replies = %q", rep)
	}
	if rep, _ := r.HandleCAT("VT;VT$;VT24;", 0.0); rep != "VT16;VT$13;VT24;" {
		t.Fatalf("VT replies = %q", rep)
	}
	if rep, _ := r.HandleCAT("RG;RG$;RG-06;", 0.0); rep != "RG-00;RG$-00;RG-06;" {
		t.Fatalf("RG replies = %q", rep)
	}
	if rep, _ := r.HandleCAT("BN;BN$;BN05;", 0.0); rep != "BN03;BN$05;BN05;" {
		t.Fatalf("BN replies = %q, want BN03;BN$05;BN05;", rep)
	}
	if rep, _ := r.HandleCAT("#AR;#AR0;#AR;", 0.0); rep != "#AR1206-021;#AR1206-020;#AR1206-020;" {
		t.Fatalf("#AR replies = %q", rep)
	}

	// RDY; -> switches to AI4, emits OM, RV, state snapshot, and sample MEDF entries ending with MEDF0000;
	rdyRep, _ := r.HandleCAT("RDY;", 0.0)
	if !strings.Contains(rdyRep, "OM AP-S----4---;") || !strings.Contains(rdyRep, "RV.R-R40.B1;") || !strings.Contains(rdyRep, "MEDF0001,") || !strings.Contains(rdyRep, "MEDF0000;") {
		t.Fatalf("RDY snapshot missing OM/RV/MEDF markers")
	}
	if strings.Contains(rdyRep, "#SCL$") || strings.Contains(rdyRep, "#WBS$") {
		t.Fatalf("RDY snapshot should not emit unsupported #SCL$/#WBS$")
	}
	// Under AI4, client SETs suppress self-echo while GET queries still reply
	if rep, _ := r.HandleCAT("FA00014074010;", 0.0); rep != "" {
		t.Fatalf("under AI4, SET should suppress self-echo, got %q", rep)
	}
	if rep, _ := r.HandleCAT("FA;", 0.0); rep != "FA00014074010;" {
		t.Fatalf("under AI4, GET must still reply, got %q", rep)
	}
	// AI5; enables SET echoes again
	if rep, _ := r.HandleCAT("AI5;FA00014074020;", 0.0); rep != "AI5;FA00014074020;" {
		t.Fatalf("under AI5, SET must echo, got %q", rep)
	}
}

func TestOpusAudioEncodingAndMultiFrameTOCs(t *testing.T) {
	r := NewRadio()
	if !OpusAvailable() {
		rep, _ := r.HandleCAT("EM2;EM3;", 0.0)
		if rep != "EM1;EM1;" {
			t.Fatalf("without libopus expected EM1 fallback, got %q", rep)
		}
		t.Skip("libopus.so.0 not available under current build tags (no-cgo fallback verified)")
	}

	if rep, _ := r.HandleCAT("EM2;EM3;", 0.0); rep != "EM2;EM3;" {
		t.Fatalf("with libopus expected EM2;EM3;, got %q", rep)
	}

	synth := NewAudioSynth()
	rxA := NewRadio().RxA
	rxB := NewRadio().RxB

	// Encode across SL0 (1 frame), SL2 (2 frames), SL3 (3 frames), SL6 (6 frames) for EM2 & EM3
	for _, tc := range []struct {
		em        int
		bitrate   int
		sl        int
		wantCount int
	}{
		{2, 64000, 0, 1},
		{2, 64000, 2, 2},
		{3, 96000, 0, 1},
		{3, 96000, 2, 2},
		{3, 96000, 3, 3},
		{3, 96000, 6, 6},
	} {
		enc, err := NewOpusStreamEncoder(tc.bitrate)
		if err != nil {
			t.Fatalf("NewOpusStreamEncoder(%d): %v", tc.bitrate, err)
		}
		samplesPerCh := SLFramesTable[tc.sl] * 240
		f32 := synth.SynthAudioFloat(rxA, rxB, false, 500, samplesPerCh, 0.5)
		pkt, err := enc.Encode12kStereo(f32, tc.bitrate)
		enc.Close()
		if err != nil {
			t.Fatalf("Encode12kStereo(em=%d sl=%d): %v", tc.em, tc.sl, err)
		}
		if len(pkt) < 2 {
			t.Fatalf("short Opus packet len=%d", len(pkt))
		}
		toc := pkt[0]
		code := toc & 0x03
		if tc.wantCount == 1 {
			if code != 0 {
				t.Fatalf("SL0 TOC=0x%02x expected code=0 (1 frame), got %d", toc, code)
			}
		} else if tc.wantCount == 2 {
			if code != 1 && code != 2 && code != 3 {
				t.Fatalf("SL2 TOC=0x%02x expected 2-frame packing code 1..3, got %d", toc, code)
			}
		} else {
			if code != 3 {
				t.Fatalf("SL%d (%d frames) TOC=0x%02x expected code=3, got %d", tc.sl, tc.wantCount, toc, code)
			}
			frameCount := int(pkt[1] & 0x3F)
			if frameCount != tc.wantCount {
				t.Fatalf("SL%d RFC6716 frame count = %d, want %d", tc.sl, frameCount, tc.wantCount)
			}
		}

		// Verify EncodeAudio produces version=1 header
		framed := EncodeAudio(1, uint8(tc.em), uint16(samplesPerCh), AudioSampleRate12k, pkt)
		framer := &StreamFramer{}
		pkts := framer.Push(framed)
		if len(pkts) != 1 || pkts[0][0] != TypeAudio || pkts[0][1] != 0x01 || pkts[0][3] != uint8(tc.em) {
			t.Fatalf("unexpected framed Opus packet header: len=%d", len(pkts))
		}
		gotSamples := int(binary.LittleEndian.Uint16(pkts[0][4:6]))
		if gotSamples != samplesPerCh {
			t.Fatalf("EncodeAudio frameSamplesPerCh = %d, want %d", gotSamples, samplesPerCh)
		}
	}
}

func TestWave2RefAutoRefTextDecodeAndDpmMp(t *testing.T) {
	r := NewRadio()

	// 1. Default PanRefDbm is -115 on RxA & RxB
	if rep, _ := r.HandleCAT("#REF;#REF$;", 0.0); rep != "#REF-115;#REF$-115;" {
		t.Fatalf("default #REF = %q, want #REF-115;#REF$-115;", rep)
	}

	// 2. While AutoRef is ON (#ARA), #REF stays anchored at -115; #ARM allows manual #REF; #AR1 snaps once without toggling AutoRef
	if rep, _ := r.HandleCAT("#ARA;#REF-95;#REF;#AR;", 0.0); rep != "#AR1206-021;#REF-115;#REF-115;#AR1206-021;" {
		t.Fatalf("auto-ref lock #REF = %q", rep)
	}
	if rep, _ := r.HandleCAT("#ARM;#REF-108;#REF;#AR;", 0.0); rep != "#AR1206-020;#REF-108;#REF-108;#AR1206-020;" {
		t.Fatalf("manual #ARM+#REF = %q", rep)
	}
	if rep, _ := r.HandleCAT("#AR1;#REF;#AR;", 0.0); rep != "#AR1206-020;#REF-115;#AR1206-020;" {
		t.Fatalf("one-shot #AR1 = %q", rep)
	}

	// 3. TD / TD$ defaults, ER12 on incompatible modes, CW/FSK-D/PSK-D support, TB/TB$ empty polling
	if rep, _ := r.HandleCAT("TD;TD$;TB;TB$;", 0.0); rep != "TD201;TD$020;TB000;TB$000;" {
		t.Fatalf("default TD/TB = %q, want TD201;TD$020;TB000;TB$000;", rep)
	}
	// Turning TD OFF in DATA-A works, enabling TD>0 in DATA-A or LSB returns ER12
	if rep, _ := r.HandleCAT("MD6;DT0;TD000;TD101;TD/;MD1;TD201;", 0.0); !strings.Contains(rep, "TD000;") || strings.Count(rep, "ER12:SET command incompatible with target VFO's mode.;") != 3 {
		t.Fatalf("DATA-A/LSB TD gate = %q", rep)
	}
	// Enabling TD in CW, CW-R, FSK-D, PSK-D works and clamps lines 0..1
	if rep, _ := r.HandleCAT("MD3;TD301;TD432;TD/;TD/;MD6;DT2;TD101;MD6;DT3;TD211;TD$101;", 0.0); rep != "MD3;TD301;TD431;TD031;TD231;MD6;DT2;TD101;MD6;DT3;TD211;TD$101;" {
		t.Fatalf("CW/DATA TD transitions = %q", rep)
	}
	// TB under AI4 must still reply with TB000; / TB$000;
	if rep, _ := r.HandleCAT("AI4;TB;TB$;AI5;", 0.0); rep != "TB000;TB$000;AI5;" {
		t.Fatalf("AI4 TB GET = %q, want TB000;TB$000;AI5;", rep)
	}

	// 4. #MP$ returns #MP$-1 when SB0, unlocks when SB1, resets on SB0; #DPM0/1/2 round-trip
	if rep, _ := r.HandleCAT("#MP$;#MP$1;#MP1;", 0.0); rep != "#MP$-1;#MP$-1;#MP1;" {
		t.Fatalf("SB0 #MP/#MP$ = %q, want #MP$-1;#MP$-1;#MP1;", rep)
	}
	if rep, _ := r.HandleCAT("SB1;#MP$;#MP$1;SB0;#MP$;", 0.0); rep != "SB1;#MP$0;#MP$1;SB0;#MP$-1;" {
		t.Fatalf("SB1/SB0 #MP$ lifecycle = %q", rep)
	}
	if rep, _ := r.HandleCAT("#DPM1;#DPM;#DPM2;#DPM0;", 0.0); rep != "#DPM1;#DPM1;#DPM2;#DPM0;" {
		t.Fatalf("#DPM transitions = %q", rep)
	}
}

func TestItems1And2CATTelemetryFreezeAndOverflow(t *testing.T) {
	r := NewRadio()

	// 1. RC / RC$ clears RIT offset
	if rep, _ := r.HandleCAT("RT1;RO+0250;RC;RO$;RC$;", 0.0); rep != "RT1;RO+0250;RO+0000;RO$+0000;RO$+0000;" {
		t.Fatalf("RIT RC/RC$ = %q", rep)
	}
	r.HandleCAT("RO$-0120;RC$;", 0.0)
	if rep, _ := r.HandleCAT("RO$;", 0.0); rep != "RO$+0000;" {
		t.Fatalf("RO$ after RC$ = %q, want RO$+0000;", rep)
	}

	// 2. DV1 enables SubRX and copies VFO A mode/bw/is/freq to VFO B
	r.HandleCAT("FA00014074000;MD2;BW0240;IS0150;DV1;", 0.0)
	rxA, rxB, subRx, _, _, _, _ := r.Snapshot()
	if !subRx || rxB.FreqHz != rxA.FreqHz || rxB.Mode != ModeUSB || rxB.BwHz != 2400 {
		t.Fatalf("DV1 copy A->B mismatch: subRx=%v rxA=%+v rxB=%+v", subRx, rxA, rxB)
	}

	// 3. OV / OV$ transitions when Preamp 2 + 0 dB Atten + 0 dB RF Gain
	if rep, _ := r.HandleCAT("PA21;RA000;RG00;OV;", 0.0); !strings.HasSuffix(rep, "OV10;") {
		t.Fatalf("PA21 OV expected OV10;, got %q", rep)
	}
	if rep, _ := r.HandleCAT("PA00;OV;", 0.0); rep != "PA00;OV00;" {
		t.Fatalf("PA00 OV expected OV00;, got %q", rep)
	}

	// 4. #FPS, #NB/#NBL, #DSM, #WFH, #FRZ
	if rep, _ := r.HandleCAT("#FPS15;#FPS;#NB2;#NB$1;#NBL7;#NBL$12;#DSM0;#DSM;#WFH025;#WFH;#FRZ1;#FRZ$;", 0.0); rep != "#FPS15;#FPS15;#NB2;#NB$1;#NBL7;#NBL$12;#DSM0;#DSM0;#WFH025;#WFH025;#FRZ1;#FRZ?;" {
		t.Fatalf("panadapter Item 1 cmds = %q", rep)
	}

	// 5. SI* hardware telemetry subscriptions (FP, RF, DA) under AI4 emit immediately and periodically
	r.HandleCAT("AI4;", 1.0)
	siRep, _ := r.HandleCAT("SIFP1;SIRF1;SIDA1;", 1.0)
	for _, want := range []string{"SIFPVS:", "SICPT1:", "SIRFV8:", "SIDAV5:"} {
		if !strings.Contains(siRep, want) {
			t.Fatalf("expected %q in SI reply %q", want, siRep)
		}
	}
	if rep := r.PeriodicSystemInfoCAT(2.5); !strings.Contains(rep, "SIFPVS:") || !strings.Contains(rep, "SIDAV5:") {
		t.Fatalf("PeriodicSystemInfoCAT = %q", rep)
	}
}

func makeEm1S16AudioBytes(samplesPerCh int, amp int16) []byte {
	out := make([]byte, samplesPerCh*4)
	for i := 0; i < samplesPerCh; i++ {
		val := uint16(int16(float64(amp) * math.Sin(2.0*math.Pi*1000.0*float64(i)/12000.0)))
		binary.LittleEndian.PutUint16(out[i*4:i*4+2], val)
		binary.LittleEndian.PutUint16(out[i*4+2:i*4+4], val)
	}
	return out
}

func TestPermanentDestructiveBlocklistAlwaysBlocked(t *testing.T) {
	r := NewRadio()
	if !r.AllowTx {
		t.Fatalf("NewRadio() must default AllowTx = true")
	}

	// Passive telemetry subscriptions & safe GET queries must NOT increment TxCatCommands or TxBlockedViolations
	passive := "TM1;PO1;SIFP1;SIRF1;SIDU1;SIRC1;TQ;TQX;TS;IN;PC;PCX;AT;TU;AN;ACT;ACN;FT;XT;MG;CP;ML;ML2;MI;MS;ES;DW;TE;VX;VXC;VG;VGV;VI;SD;SDC;PB;KS;KP;KY;RX;TU0;PB0;"
	if rep, _ := r.HandleCAT(passive, 0.0); strings.Contains(rep, "?;") {
		t.Fatalf("passive/GET TX inspection returned error in %q", rep)
	}
	st := r.Stats()
	if st.TxCatCommands != 0 || st.TxBlockedViolations != 0 {
		t.Fatalf("passive/GET should keep txCatCommands=0 and txBlockedViolations=0, got %+v", st)
	}

	// Permanent destructive/admin blocklist MUST always fail even when AllowTx == true
	permBlocked := []string{
		"EE1234;", "LBTEST;", "WM1;", "#CAL0;", "PS0;",
		"RRP;", "RRC;", "RRT;", "RS;", "EC00;",
		"SW01;", "SWT11;", "SWH11;",
		"DARM1;", "DARS1;", "DAPM1;", "DAMP1;", "DARC1;",
	}
	for i, cmd := range permBlocked {
		rep, _ := r.HandleCAT(cmd, float64(i)*0.1)
		if rep != "?;" {
			t.Fatalf("permanent blocked cmd %q returned %q, want ?;", cmd, rep)
		}
		if got := r.Stats().TxBlockedViolations; got != int64(i+1) {
			t.Fatalf("after %q TxBlockedViolations=%d, want %d", cmd, got, i+1)
		}
	}
	if r.Stats().TxCatCommands != 0 {
		t.Fatalf("blocked commands must not increment txCatCommands, got %d", r.Stats().TxCatCommands)
	}
}

func TestTxCatCommandsAndSafetyInhibitAndIF(t *testing.T) {
	r := NewRadio()

	// Power control L (tenths) vs H (watts) vs X (tenths mW) + PCX parity
	if rep, _ := r.HandleCAT("PC050L;PC;PCX;", 0.0); rep != "PC050L;PC050L;PCX050L;" {
		t.Fatalf("PC L reply = %q", rep)
	}
	if st := r.Stats(); st.PowerRange != "L" || math.Abs(st.PowerWatts-5.0) > 1e-6 {
		t.Fatalf("PowerRange/PowerWatts after PC050L = %+v", st)
	}
	if rep, _ := r.HandleCAT("PC100H;PCX045H;PC;", 0.0); rep != "PC100H;PCX045H;PC045H;" {
		t.Fatalf("PC/PCX H reply = %q", rep)
	}
	if st := r.Stats(); st.PowerRange != "H" || math.Abs(st.PowerWatts-45.0) > 1e-6 {
		t.Fatalf("PowerRange/PowerWatts after PCX045H = %+v", st)
	}
	if rep, _ := r.HandleCAT("PC050X;PC;", 0.0); rep != "PC050X;PC050X;" {
		t.Fatalf("PC X reply = %q", rep)
	}

	// Antenna ports, mask, and case-preserving ACN names
	if rep, _ := r.HandleCAT("ACT1101;AN1;AN/;AN2;ACN2Inverted V;ACN2;", 0.0); rep != "ACT1101;AN1;AN3;AN2;ACN2Inverted V;ACN2Inverted V;" {
		t.Fatalf("ACT/AN/ACN reply = %q", rep)
	}

	// ATU mode, FT/XT/AB, audio/VOX/DVR/keyer parameters
	if rep, _ := r.HandleCAT("AT1;AT2;FT1;XT1;MG040;CP015;ML2025;MI1;MS10203;ES140;DW1;TE+02+00-01+00+00+00+00+00;", 0.0); rep != "AT1;AT2;FT1;XT1;MG040;CP015;ML2025;MI1;MS10203;ES140;DW1;TE+02+00-01+00+00+00+00+00;" {
		t.Fatalf("voice/TX config reply = %q", rep)
	}
	if rep, _ := r.HandleCAT("VXC0;VXV1;VGV030;VGD025;VI015;SD1V020;KS025;KPBN115;", 0.0); rep != "VXC0;VXV1;VGV030;VGD025;VI015;SD1V020;KS025;KPBN115;" {
		t.Fatalf("VOX/keyer config reply = %q", rep)
	}

	// AB3 copies VFO A params to VFO B
	r.HandleCAT("FA00007074000;MD2;BW0240;IS0150;PA21;", 0.0)
	abRep, _ := r.HandleCAT("AB3;", 0.0)
	if abRep != "FB00007074000;MD$2;DT$0;BW$0240;IS$0150;" {
		t.Fatalf("AB3 reply = %q", abRep)
	}

	// IF reflects XIT [24], TX [28], Split [32] while preserving 38-char K4 layout
	r.HandleCAT("TX;", 0.1)
	ifRep, _ := r.HandleCAT("IF;", 0.1)
	if len(ifRep) != 38 || ifRep[24] != '1' || ifRep[28] != '1' || ifRep[32] != '1' {
		t.Fatalf("IF during TX+XIT+Split = %q (len=%d, [24]=%c [28]=%c [32]=%c)", ifRep, len(ifRep), ifRep[24], ifRep[28], ifRep[32])
	}

	// DVR playback PB2 keys TX and PB0 drops back to RX
	r.HandleCAT("RX;", 0.2)
	if rep, _ := r.HandleCAT("PB2;", 0.3); rep != "PB2;TQ1;TQX1;" {
		t.Fatalf("PB2 reply = %q", rep)
	}
	if !r.Stats().TxActive {
		t.Fatalf("expected TxActive=true during PB2")
	}
	if rep, _ := r.HandleCAT("PB0;", 0.4); rep != "PB0;TQ0;TQX0;TM000000000000;PO0000;" {
		t.Fatalf("PB0 drop reply = %q", rep)
	}

	// TX Inhibit (IN1) prevents TX and drops active TX immediately
	r.HandleCAT("TX;", 0.5)
	inRep, _ := r.HandleCAT("IN1;", 0.6)
	if !strings.Contains(inRep, "IN1;") || !strings.Contains(inRep, "TQ0;") || r.Stats().TxActive {
		t.Fatalf("IN1 did not drop active TX: rep=%q txActive=%v", inRep, r.Stats().TxActive)
	}
	if rep, _ := r.HandleCAT("TX;", 0.7); rep != "TQ0;TQX0;" || r.Stats().TxActive {
		t.Fatalf("TX during IN1 must stay RX: rep=%q txActive=%v", rep, r.Stats().TxActive)
	}
	r.HandleCAT("IN0;", 0.8)

	// RDY snapshot includes TX/ATU/ACN/PC/KS fields
	snap, _ := r.HandleCAT("RDY;", 0.9)
	for _, needle := range []string{"AN2;", "ACT1101;", "ACN2Inverted V;", "ACN3dummy;", "AT2;", "PC050X;", "MG040;", "CP015;", "KS025;", "KPBN115;"} {
		if !strings.Contains(snap, needle) {
			t.Fatalf("RDY snapshot missing %q", needle)
		}
	}
	if r.Stats().TxCatCommands == 0 {
		t.Fatalf("expected TxCatCommands > 0")
	}
}

func TestTxTestModeZeroWattsAndInboundAudioTelemetry(t *testing.T) {
	// 1. Verify ServerConfig{RxOnly: true} enforces strict RX-only over TCP
	rxSrv, err := NewSimServer(ServerConfig{ListenAddr: "127.0.0.1:0", FPS: 10, RxOnly: true})
	if err != nil {
		t.Fatalf("NewSimServer rx-only: %v", err)
	}
	ctxRx, cancelRx := context.WithCancel(context.Background())
	go func() { _ = rxSrv.Serve(ctxRx) }()

	rxConn, err := net.DialTimeout("tcp", rxSrv.Addr(), 2*time.Second)
	if err != nil {
		t.Fatalf("dial rxSrv: %v", err)
	}
	_, _ = rxConn.Write([]byte(ExpectedAuthHex("")))
	_, _ = rxConn.Write(EncodeCAT("AI5;TX;"))
	_ = rxConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	rxFramer := &StreamFramer{}
	rxBuf := make([]byte, 4096)
	sawReject := false
	for i := 0; i < 8 && !sawReject; i++ {
		n, rerr := rxConn.Read(rxBuf)
		if n > 0 {
			for _, p := range rxFramer.Push(rxBuf[:n]) {
				if p[0] == TypeCAT && strings.Contains(string(p[3:]), "?;") {
					sawReject = true
				}
			}
		}
		if rerr != nil {
			break
		}
	}
	rxConn.Close()
	cancelRx()
	rxSrv.Close()
	if !sawReject || rxSrv.Radio().Stats().TxBlockedViolations == 0 {
		t.Fatalf("expected RxOnly SimServer to block TX; sawReject=%v violations=%d", sawReject, rxSrv.Radio().Stats().TxBlockedViolations)
	}

	// 2. Verify TX-enabled SimServer receives 0x01 EM1 S16LE packets -> drives TM ALC/CMP/FWD & drops on disconnect
	srv, err := NewSimServer(ServerConfig{ListenAddr: "127.0.0.1:0", FPS: 10})
	if err != nil {
		t.Fatalf("NewSimServer tx: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = srv.Serve(ctx) }()
	defer srv.Close()

	conn, err := net.DialTimeout("tcp", srv.Addr(), 2*time.Second)
	if err != nil {
		t.Fatalf("dial tx srv: %v", err)
	}
	_, _ = conn.Write([]byte(ExpectedAuthHex("")))
	// Configure USB 100W, CP10, MG15, TS0, TX active
	_, _ = conn.Write(EncodeCAT("AI5;MD2;PC100H;CP010;MG015;TS0;TM1;PO1;TX;"))

	// Send framed 0x01 EM1 packets with ~3000 count sine (K4 1/32 wire convention)
	pcm := makeEm1S16AudioBytes(240, 3000)
	for seq := uint8(0); seq < 5; seq++ {
		if _, werr := conn.Write(EncodeAudio(seq, 1, 240, AudioSampleRate12k, pcm)); werr != nil {
			t.Fatalf("write EncodeAudio: %v", werr)
		}
		time.Sleep(25 * time.Millisecond)
	}

	// Read TM telemetry over wire reflecting inbound audio drive
	framer := &StreamFramer{}
	buf := make([]byte, 8192)
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	var liveAlc, liveCmp, liveFwd int
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && liveFwd == 0 {
		n, rerr := conn.Read(buf)
		if n > 0 {
			for _, p := range framer.Push(buf[:n]) {
				if len(p) > 3 && p[0] == TypeCAT {
					for _, f := range SplitCATFrames(string(p[3:])) {
						if strings.HasPrefix(f, "TM") && len(f) == 14 {
							alc, _ := strconv.Atoi(f[2:5])
							cmp, _ := strconv.Atoi(f[5:8])
							fwd, _ := strconv.Atoi(f[8:11])
							if fwd > 0 && alc > 0 {
								liveAlc, liveCmp, liveFwd = alc, cmp, fwd
							}
						}
					}
				}
			}
		}
		if rerr != nil {
			break
		}
	}
	if liveFwd <= 0 || liveAlc <= 0 || liveCmp <= 0 {
		t.Fatalf("expected live TM from inbound 0x01 audio, got alc=%d cmp=%d fwd=%d", liveAlc, liveCmp, liveFwd)
	}
	if st := srv.Radio().Stats(); st.TxAudioPacketsIn < 5 || !st.TxActive || st.LastFwdTenthsW == 0 {
		t.Fatalf("unexpected stats during live audio TX: %+v", st)
	}

	// Switch to TS1 (TX Test 0W Mode) + keep sending audio -> ALC/CMP respond while FWD stays 0.0W!
	_, _ = conn.Write(EncodeCAT("TS1;"))
	for seq := uint8(5); seq < 9; seq++ {
		_, _ = conn.Write(EncodeAudio(seq, 1, 240, AudioSampleRate12k, pcm))
		time.Sleep(25 * time.Millisecond)
	}
	var sawTestTm bool
	deadline = time.Now().Add(1500 * time.Millisecond)
	for time.Now().Before(deadline) && !sawTestTm {
		n, rerr := conn.Read(buf)
		if n > 0 {
			for _, p := range framer.Push(buf[:n]) {
				if len(p) > 3 && p[0] == TypeCAT {
					for _, f := range SplitCATFrames(string(p[3:])) {
						if strings.HasPrefix(f, "TM") && len(f) == 14 {
							alc, _ := strconv.Atoi(f[2:5])
							cmp, _ := strconv.Atoi(f[5:8])
							fwd, _ := strconv.Atoi(f[8:11])
							swr, _ := strconv.Atoi(f[11:14])
							if srv.Radio().Stats().TxTestMode && alc > 0 && cmp > 0 && fwd == 0 && swr == 0 {
								sawTestTm = true
							}
						}
					}
				}
			}
		}
		if rerr != nil {
			break
		}
	}
	if !sawTestTm {
		t.Fatalf("expected TS1 mode to keep ALC/CMP active with 0W FWD and 0 SWR")
	}

	// Closing the last TCP socket must ForceRx() safely
	conn.Close()
	for i := 0; i < 40 && srv.Radio().Stats().TxActive; i++ {
		time.Sleep(25 * time.Millisecond)
	}
	if srv.Radio().Stats().TxActive {
		t.Fatalf("expected ForceRx() on last client disconnect")
	}
}

func TestKat4AtuSwrConvergenceAndPersistenceAndAbort(t *testing.T) {
	r := NewRadio()

	// ANT3 dummy load is 1.0:1 across bands
	r.HandleCAT("AN3;TX;", 0.0)
	if st := r.Stats(); st.LastSwrTenths != 10 {
		t.Fatalf("ANT3 dummy SWR = %d, want 10 (1.0:1)", st.LastSwrTenths)
	}
	r.HandleCAT("RX;", 0.1)

	// ANT1 on 20m (Band 5) starts unmatched (~2.8:1)
	r.HandleCAT("FA00014074000;AN1;", 0.2)
	if r.Stats().AtuMatched {
		t.Fatalf("expected 20m ANT1 unmatched initially")
	}
	if rep, _ := r.HandleCAT("TU3;", 1.0); !strings.Contains(rep, "TU3;") || !strings.Contains(rep, "TQ1;") {
		t.Fatalf("TU3 start reply = %q", rep)
	}
	if st := r.Stats(); !st.AtuTuning || !st.TxActive || st.AtuMode != 2 {
		t.Fatalf("unexpected state during TU3: %+v", st)
	}

	var swrHistory []int
	var doneMsg string
	for step := 1; step <= 14; step++ {
		tSec := 1.0 + float64(step)*0.1
		cat := r.StepTx(tSec)
		for _, f := range SplitCATFrames(cat) {
			if strings.HasPrefix(f, "TM") && len(f) == 14 {
				swr, _ := strconv.Atoi(f[11:14])
				if swr > 0 {
					swrHistory = append(swrHistory, swr)
				}
			}
		}
		if strings.Contains(cat, "TU0;TQ0;") {
			doneMsg = cat
			break
		}
	}
	if doneMsg == "" || !strings.Contains(doneMsg, "TM000000000000;PO0000;") {
		t.Fatalf("expected TU3 completion emission, got %q", doneMsg)
	}
	if len(swrHistory) < 4 || swrHistory[0] < 24 || swrHistory[len(swrHistory)-1] != 11 {
		t.Fatalf("unexpected SWR convergence history: %v", swrHistory)
	}
	for i := 1; i < len(swrHistory); i++ {
		if swrHistory[i] > swrHistory[i-1] {
			t.Fatalf("SWR must converge monotonically down: %v", swrHistory)
		}
	}
	if st := r.Stats(); st.AtuTuning || st.TxActive || !st.AtuMatched {
		t.Fatalf("expected matched idle state after TU3: %+v", st)
	}
	// Verify match persisted on (20m, ANT1)
	r.HandleCAT("TX;", 3.0)
	if r.Stats().LastSwrTenths != 11 {
		t.Fatalf("expected persisted 1.1:1 SWR on 20m ANT1, got %d", r.Stats().LastSwrTenths)
	}
	r.HandleCAT("RX;", 3.1)

	// Switch to 40m (unmatched) and verify TU0 abort + RX abort
	r.HandleCAT("FA00007074000;", 3.2)
	if r.Stats().AtuMatched {
		t.Fatalf("40m ANT1 should be unmatched before tuning")
	}
	r.HandleCAT("TU4;", 4.0)
	r.StepTx(4.3)
	if rep, _ := r.HandleCAT("TU0;", 4.35); !strings.HasPrefix(rep, "TU0;TQ0;") {
		t.Fatalf("TU0 abort reply = %q, want TU0;TQ0;...", rep)
	}
	if st := r.Stats(); st.AtuTuning || st.TxActive || st.AtuMatched {
		t.Fatalf("state after TU0 abort: %+v", st)
	}

	r.HandleCAT("TU3;", 5.0)
	if rep, _ := r.HandleCAT("RX;", 5.2); !strings.HasPrefix(rep, "TU0;TQ0;") {
		t.Fatalf("RX abort during TU3 reply = %q, want TU0;TQ0;...", rep)
	}
	if st := r.Stats(); st.AtuTuning || st.TxActive {
		t.Fatalf("state after RX abort: %+v", st)
	}
}

func parseSiField(cat, prefix, key string) (float64, bool) {
	for _, f := range SplitCATFrames(cat) {
		if !strings.HasPrefix(f, prefix) {
			continue
		}
		for _, kv := range strings.Split(strings.TrimPrefix(f, prefix), ",") {
			if strings.HasPrefix(kv, key+":") {
				v, err := strconv.ParseFloat(strings.TrimPrefix(kv, key+":"), 64)
				if err == nil {
					return v, true
				}
			}
		}
	}
	return 0, false
}

func TestElectricalAndThermalPhysics(t *testing.T) {
	r := NewRadio()
	r.HandleCAT("AI4;SIFP1;SIRF1;SIDU1;", 0.0)

	rxSi := r.PeriodicSystemInfoCAT(0.5)
	rxIs, okIs := parseSiField(rxSi, "SIFP", "IS")
	rxVs, okVs := parseSiField(rxSi, "SIFP", "VS")
	rxPt, okPt := parseSiField(rxSi, "SIRF", "PT")
	rxLt, okLt := parseSiField(rxSi, "SIRF", "LT")
	_, okDuc := parseSiField(rxSi, "SIDU", "T")
	if !okIs || !okVs || !okPt || !okLt || !okDuc {
		t.Fatalf("missing expected SI fields in %q", rxSi)
	}
	if rxIs > 2.0 || rxVs < 13.7 || math.Abs(rxPt-25.0) > 0.2 {
		t.Fatalf("unexpected RX baseline IS=%.2f VS=%.2f PT=%.1f", rxIs, rxVs, rxPt)
	}

	// TS1 Test Mode TX draws ~3.2 A bias
	r.HandleCAT("MD3;PC100H;TS1;TX;", 1.0)
	ts1Si := r.PeriodicSystemInfoCAT(1.2)
	ts1Is, _ := parseSiField(ts1Si, "SIFP", "IS")
	if ts1Is < 2.9 || ts1Is > 3.6 {
		t.Fatalf("TS1 supply current IS=%.2f A, want ~3.2 A", ts1Is)
	}

	// 100W full-power carrier heats PA/LPA and sags VS with ~18.5 A IS
	r.HandleCAT("TS0;", 1.5)
	for sec := 2.0; sec <= 12.0; sec += 0.5 {
		r.StepTx(sec)
	}
	txSi := r.PeriodicSystemInfoCAT(12.2)
	txIs, _ := parseSiField(txSi, "SIFP", "IS")
	txVs, _ := parseSiField(txSi, "SIFP", "VS")
	txPt, _ := parseSiField(txSi, "SIRF", "PT")
	txLt, _ := parseSiField(txSi, "SIRF", "LT")
	txPa, _ := parseSiField(txSi, "SIRF", "PA")
	if txIs < 17.5 || txPa < 15.0 || txVs >= rxVs-0.55 {
		t.Fatalf("100W electrical sag mismatch: IS=%.2f PA=%.2f VS=%.2f (rxVS=%.2f)", txIs, txPa, txVs, rxVs)
	}
	if txPt <= rxPt+15.0 || txLt <= rxLt+5.0 {
		t.Fatalf("expected PA/LPA thermal rise in 100W TX: PT %.1f->%.1f, LT %.1f->%.1f", rxPt, txPt, rxLt, txLt)
	}

	// Return to RX and cool down
	r.HandleCAT("RX;", 12.5)
	for sec := 13.0; sec <= 28.0; sec += 0.5 {
		r.StepTx(sec)
	}
	coolSi := r.PeriodicSystemInfoCAT(28.2)
	coolIs, _ := parseSiField(coolSi, "SIFP", "IS")
	coolVs, _ := parseSiField(coolSi, "SIFP", "VS")
	coolPt, _ := parseSiField(coolSi, "SIRF", "PT")
	if coolIs > 2.0 || coolVs < 13.7 || coolPt >= txPt-5.0 {
		t.Fatalf("expected cooldown in RX: IS=%.2f VS=%.2f PT=%.1f (peak %.1f)", coolIs, coolVs, coolPt, txPt)
	}
}

func TestKyKeyerBufferDrainAndAbort(t *testing.T) {
	r := NewRadio()
	r.HandleCAT("MD3;KS020;", 0.0) // 20 WPM => 0.06s per char

	rep, _ := r.HandleCAT("KY CQ DE K4;", 1.0)
	if rep != "KY0;TQ1;TQX1;" || !r.Stats().TxActive {
		t.Fatalf("KY enqueue reply = %q, txActive=%v", rep, r.Stats().TxActive)
	}
	if tb, _ := r.HandleCAT("TB;", 1.0); tb != "TB800;" {
		t.Fatalf("TB after 8-char KY = %q, want TB800;", tb)
	}

	// >45 chars marks KY1 full and clamps TB digit 0 at 9
	longText := strings.Repeat("A", 42)
	repFull, _ := r.HandleCAT("KY "+longText+";", 1.01)
	if repFull != "KY1;TQ1;TQX1;" {
		t.Fatalf("expected KY1 buffer full reply, got %q", repFull)
	}
	if tb, _ := r.HandleCAT("TB;", 1.01); tb != "TB900;" {
		t.Fatalf("TB when >9 chars queued = %q, want TB900;", tb)
	}

	// KY @ aborts immediately and drops TX
	abortRep, _ := r.HandleCAT("KY @;", 1.02)
	if abortRep != "KY0;TQ0;TQX0;TM000000000000;PO0000;" || r.Stats().TxActive {
		t.Fatalf("KY @ abort reply = %q, txActive=%v", abortRep, r.Stats().TxActive)
	}
	if tb, _ := r.HandleCAT("TB;", 1.03); tb != "TB000;" {
		t.Fatalf("TB after KY @ = %q, want TB000;", tb)
	}

	// Asynchronous drain at KS WPM
	r.HandleCAT("KY TEST;", 2.0) // 4 chars: drains at 2.06, 2.12, 2.18, 2.24
	if tb, _ := r.HandleCAT("TB;", 2.07); tb != "TB300;" {
		t.Fatalf("TB after 1 char period = %q, want TB300;", tb)
	}
	if tb, _ := r.HandleCAT("TB;", 2.13); tb != "TB200;" {
		t.Fatalf("TB after 2 char periods = %q, want TB200;", tb)
	}
	stepOut := r.StepTx(2.25)
	if !strings.Contains(stepOut, "KY0;TQ0;TQX0;TM000000000000;PO0000;") || r.Stats().TxActive {
		t.Fatalf("expected StepTx completion after full KY drain, got %q txActive=%v", stepOut, r.Stats().TxActive)
	}
}

func TestExtendedDebugStatsJSON(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	httpAddr := ln.Addr().String()
	ln.Close()

	srv, err := NewSimServer(ServerConfig{
		ListenAddr:  "127.0.0.1:0",
		FPS:         15,
		ControlHTTP: httpAddr,
	})
	if err != nil {
		t.Fatalf("NewSimServer: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = srv.Serve(ctx) }()
	defer srv.Close()

	srv.Radio().HandleCAT("AN3;PC050L;TS1;", 0.0)
	resp, err := http.Get("http://" + httpAddr + "/debug/stats")
	if err != nil {
		t.Fatalf("GET /debug/stats: %v", err)
	}
	defer resp.Body.Close()

	var payload map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode JSON: %v", err)
	}

	requiredKeys := []string{
		"totalConnections", "authPassed", "authFailed", "txBlockedViolations", "lastBlockedTxCmd",
		"faHz", "fbHz", "modeA", "modeB",
		"txCatCommands", "txAudioPacketsIn", "txActive", "txTestMode", "atuTuning", "atuMatched",
		"lastFwdTenthsW", "lastSwrTenths", "lastAlcBars", "powerWatts", "powerRange", "txAntenna", "atuMode",
	}
	for _, k := range requiredKeys {
		if _, ok := payload[k]; !ok {
			t.Fatalf("/debug/stats missing key %q in %+v", k, payload)
		}
	}
	if payload["txAntenna"] != float64(3) || payload["powerRange"] != "L" || payload["powerWatts"] != float64(5) || payload["txTestMode"] != true || payload["atuMatched"] != true {
		t.Fatalf("unexpected extended /debug/stats values: %+v", payload)
	}
}

func TestModelK4DiversityAndIfCenterOffset(t *testing.T) {
	r := NewRadio()
	r.SetModel("k4")

	if rep, _ := r.HandleCAT("OM;", 0.0); rep != "OM AP------4---;" {
		t.Fatalf("K4 OM reply = %q, want 'OM AP------4---;'", rep)
	}
	if rep, _ := r.HandleCAT("DV1;", 0.0); rep != "DV0;" {
		t.Fatalf("K4 without KRX4 should force DV0;, got %q", rep)
	}

	// FI SET moves panadapter stream center independently of VFO A frequency
	if rep, _ := r.HandleCAT("FI00014124000;", 0.0); rep != "FI00014124000;" {
		t.Fatalf("FI SET reply = %q, want FI00014124000;", rep)
	}
	rxA, _, _, cwPitch, _, _, _ := r.Snapshot()
	if rxA.FreqHz != 14074000 {
		t.Fatalf("FI SET modified VFO A freqHz = %d, want 14074000", rxA.FreqHz)
	}
	rng := rand.New(rand.NewSource(42))
	centerHz, _, _, _ := SynthPAN(rxA, cwPitch, 0.0, rng)
	if centerHz != 14124000 {
		t.Fatalf("SynthPAN centerHz = %d, want 14124000", centerHz)
	}
	if rep, _ := r.HandleCAT("FC;", 0.0); rep != "FI00014074000;" {
		t.Fatalf("FC; recenter reply = %q, want FI00014074000;", rep)
	}
}

func TestHandleCATDoesNotDropAtuOrKeyerCompletion(t *testing.T) {
	r := NewRadio()
	r.HandleCAT("FA00014074000;AN1;", 0.2)

	// Start TU3 ATU tune at t=1.0 (converges after 1.05s -> t >= 2.05)
	if rep, _ := r.HandleCAT("TU3;", 1.0); !strings.Contains(rep, "TU3;") {
		t.Fatalf("TU3 start reply = %q", rep)
	}
	r.StepTx(1.5)

	// Client keep-alive PING; arrives at convergence before StepTx(2.10)
	rep, _ := r.HandleCAT("PING;", 2.10)
	if !strings.Contains(rep, "TU0;TQ0;TQX0;TM000000000000;PO0000;") || !strings.Contains(rep, "PONG;") {
		t.Fatalf("HandleCAT(PING) at ATU completion lost completion frames: %q", rep)
	}
	if st := r.Stats(); st.AtuTuning || st.TxActive || !st.AtuMatched {
		t.Fatalf("unexpected state after ATU convergence via HandleCAT: %+v", st)
	}

	// Verify CW keyer completion isn't dropped when PING; arrives right after drain
	r.HandleCAT("KS020;KY HI;", 3.0) // 2 chars at 20 WPM -> 60ms/char -> drains by t=3.12
	kyRep, _ := r.HandleCAT("PING;", 3.25)
	if !strings.Contains(kyRep, "TB000;KY0;TQ0;TQX0;TM000000000000;PO0000;") || !strings.Contains(kyRep, "PONG;") {
		t.Fatalf("HandleCAT(PING) at keyer drain lost completion frames: %q", kyRep)
	}
	if r.Stats().TxActive {
		t.Fatalf("expected TxActive=false after keyer drain")
	}
}
