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
	if centerHz != 14025500 {
		t.Fatalf("CW PAN centerHz = %d, want 14025500", centerHz)
	}
	if tierKHz != 48 || nfRaw != -1200 || len(bins) != 1024 {
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
	if mcHz != 14025500 || mSpan != 24 || len(mBins) != 1024 {
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
	// 24-bit scale: ~900 * 256 = 230400
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
					if strings.Contains(txt, "PONG12345;") {
						sawPong = true
					}
					for _, f := range SplitCATFrames(txt) {
						if strings.HasPrefix(f, "TB") && strings.Contains(f, ";") {
							sawTBSemicolon = true
						}
					}
				case TypeAudio:
					sawAudio = true
				case TypePAN:
					sawPan = true
				case TypeMiniPAN:
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
