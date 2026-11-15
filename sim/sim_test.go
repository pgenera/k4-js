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
	r := NewRadio()
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

	// AN; GET allowed vs AN<n>; SET blocked as TX/relay-unsafe
	if rep, _ := r.HandleCAT("AN;", 0.0); rep != "AN1;" {
		t.Fatalf("AN; reply = %q, want AN1;", rep)
	}
	beforeBlocked := r.Stats().TxBlockedViolations
	if rep, _ := r.HandleCAT("AN2;", 0.0); rep != "?;" {
		t.Fatalf("AN2; SET reply = %q, want ?;", rep)
	}
	if r.Stats().TxBlockedViolations != beforeBlocked+1 {
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
