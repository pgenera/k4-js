package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net"
	"net/http"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

type ServerConfig struct {
	ListenAddr  string
	Password    string
	FPS         int
	ControlHTTP string
}

type SimServer struct {
	cfg      ServerConfig
	radio    *Radio
	listener net.Listener
	httpSrv  *http.Server
	startAt  time.Time
}

func NewSimServer(cfg ServerConfig) (*SimServer, error) {
	if cfg.FPS < 1 {
		cfg.FPS = 1
	}
	if cfg.FPS > 30 {
		cfg.FPS = 30
	}
	ln, err := net.Listen("tcp", cfg.ListenAddr)
	if err != nil {
		return nil, err
	}
	s := &SimServer{
		cfg:      cfg,
		radio:    NewRadio(),
		listener: ln,
		startAt:  time.Now(),
	}
	s.radio.PanFPS = cfg.FPS
	if cfg.ControlHTTP != "" {
		mux := http.NewServeMux()
		mux.HandleFunc("/debug/stats", s.handleDebugStats)
		s.httpSrv = &http.Server{
			Addr:              cfg.ControlHTTP,
			Handler:           mux,
			ReadHeaderTimeout: 3 * time.Second,
		}
		httpLn, err := net.Listen("tcp", cfg.ControlHTTP)
		if err != nil {
			_ = ln.Close()
			return nil, err
		}
		go func() {
			if err := s.httpSrv.Serve(httpLn); err != nil && err != http.ErrServerClosed {
				log.Printf("control http error: %v", err)
			}
		}()
	}
	return s, nil
}

func (s *SimServer) Addr() string {
	return s.listener.Addr().String()
}

func (s *SimServer) Radio() *Radio {
	return s.radio
}

func (s *SimServer) handleDebugStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	_ = json.NewEncoder(w).Encode(s.radio.Stats())
}

func (s *SimServer) Serve(ctx context.Context) error {
	var wg sync.WaitGroup
	go func() {
		<-ctx.Done()
		_ = s.Close()
	}()

	for {
		conn, err := s.listener.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				wg.Wait()
				return nil
			default:
			}
			return err
		}
		wg.Add(1)
		go func(c net.Conn) {
			defer wg.Done()
			s.handleConn(ctx, c)
		}(conn)
	}
}

func (s *SimServer) Close() error {
	var firstErr error
	if s.listener != nil {
		if err := s.listener.Close(); err != nil {
			firstErr = err
		}
	}
	if s.httpSrv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = s.httpSrv.Shutdown(ctx)
	}
	return firstErr
}

func (s *SimServer) handleConn(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	s.radio.RecordConnectionAttempt()

	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	authBuf := make([]byte, 96)
	if _, err := io.ReadFull(conn, authBuf); err != nil {
		s.radio.RecordAuthResult(false)
		return
	}
	hexStr, validHex := ValidateAuthHex(authBuf)
	if !validHex {
		s.radio.RecordAuthResult(false)
		return
	}
	if s.cfg.Password != "" {
		expected := ExpectedAuthHex(s.cfg.Password)
		if subtle.ConstantTimeCompare([]byte(hexStr), []byte(expected)) != 1 {
			s.radio.RecordAuthResult(false)
			return
		}
	}
	s.radio.RecordAuthResult(true)
	_ = conn.SetReadDeadline(time.Time{})

	var writeMu sync.Mutex
	writePacket := func(pkt []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
		_, err := conn.Write(pkt)
		return err
	}

	connCtx, cancelConn := context.WithCancel(ctx)
	defer cancelConn()

	// Send initial connection banner/ID packet so client confirms authentication immediately
	// even before RDY; finishes, or when RDY; arrives right after.
	_ = writePacket(EncodeCAT("IDK4-SIM;"))

	// Start PAN/MiniPAN, Audio, S-meter, and TB$ streaming loops
	var streamWg sync.WaitGroup
	streamWg.Add(3)

	// 1. PAN + MiniPAN loop at configured FPS (dynamically honors #FPS and #FRZ)
	go func() {
		defer streamWg.Done()
		curFPS, _ := s.radio.PanStreamState()
		ticker := time.NewTicker(time.Second / time.Duration(curFPS))
		defer ticker.Stop()
		rng := rand.New(rand.NewSource(42))
		var seqA, seqB uint8
		for {
			select {
			case <-connCtx.Done():
				return
			case now := <-ticker.C:
				nextFPS, frozen := s.radio.PanStreamState()
				if nextFPS != curFPS {
					curFPS = nextFPS
					ticker.Reset(time.Second / time.Duration(curFPS))
				}
				if frozen {
					continue
				}
				tSec := now.Sub(s.startAt).Seconds()
				rxA, rxB, subRx, cwPitchHz, _, _, dualPan := s.radio.Snapshot()

				cHz, tierKHz, nfRaw, bins := SynthPAN(rxA, cwPitchHz, tSec, rng)
				if err := writePacket(EncodePAN(TypePAN, seqA, 0, 0, cHz, tierKHz, nfRaw, bins)); err != nil {
					cancelConn()
					return
				}
				if rxA.MiniPan {
					mcHz, mSpanKHz, mBins := SynthMiniPAN(rxA, cwPitchHz, tSec, rng)
					if err := writePacket(EncodePAN(TypeMiniPAN, seqA, 0, 0, mcHz, mSpanKHz, 285, mBins)); err != nil {
						cancelConn()
						return
					}
				}
				seqA++

				if subRx || dualPan == 2 {
					cHzB, tierKHzB, nfRawB, binsB := SynthPAN(rxB, cwPitchHz, tSec, rng)
					if err := writePacket(EncodePAN(TypePAN, seqB, 0, 1, cHzB, tierKHzB, nfRawB, binsB)); err != nil {
						cancelConn()
						return
					}
					if rxB.MiniPan {
						mcHzB, mSpanKHzB, mBinsB := SynthMiniPAN(rxB, cwPitchHz, tSec, rng)
						if err := writePacket(EncodePAN(TypeMiniPAN, seqB, 0, 1, mcHzB, mSpanKHzB, 285, mBinsB)); err != nil {
							cancelConn()
							return
						}
					}
					seqB++
				}
			}
		}
	}()

	// 2. 12 kHz stereo PCM / 48 kHz Opus audio loop synced to SL tier
	go func() {
		defer streamWg.Done()
		audioSynth := NewAudioSynth()
		var opusEnc *OpusStreamEncoder
		defer func() {
			if opusEnc != nil {
				opusEnc.Close()
			}
		}()
		var audioSeq uint8
		for {
			rxA, rxB, subRx, cwPitchHz, encodeMode, sl, _ := s.radio.Snapshot()
			if sl < 0 || sl >= len(SLFramesTable) {
				sl = 2
			}
			frames := SLFramesTable[sl]
			samplesPerCh := frames * 240
			interval := time.Duration(frames*20) * time.Millisecond

			select {
			case <-connCtx.Done():
				return
			case now := <-time.After(interval):
				tSec := now.Sub(s.startAt).Seconds()
				f32 := audioSynth.SynthAudioFloat(rxA, rxB, subRx, cwPitchHz, samplesPerCh, tSec)

				outEM := uint8(1)
				var audioPayload []byte
				switch encodeMode {
				case 0:
					outEM = 0
					audioPayload = QuantizeFloatToPCM(f32, 0)
				case 2, 3:
					bitrate := 64000
					if encodeMode == 3 {
						bitrate = 96000
					}
					if OpusAvailable() {
						if opusEnc == nil {
							enc, err := NewOpusStreamEncoder(bitrate)
							if err == nil {
								opusEnc = enc
							}
						}
						if opusEnc != nil {
							pkt, err := opusEnc.Encode12kStereo(f32, bitrate)
							if err == nil {
								outEM = uint8(encodeMode)
								audioPayload = pkt
							}
						}
					}
					if audioPayload == nil {
						outEM = 1
						audioPayload = QuantizeFloatToPCM(f32, 1)
					}
				default:
					outEM = 1
					audioPayload = QuantizeFloatToPCM(f32, 1)
				}

				if err := writePacket(EncodeAudio(audioSeq, outEM, uint16(samplesPerCh), AudioSampleRate12k, audioPayload)); err != nil {
					cancelConn()
					return
				}
				audioSeq++
			}
		}
	}()

	// 3. Periodic S-meter, OV transition, SI* telemetry, and TB$ decoded text loop
	go func() {
		defer streamWg.Done()
		smTicker := time.NewTicker(250 * time.Millisecond)
		defer smTicker.Stop()
		var tickCount int
		lastOvA, lastOvB := s.radio.OverflowStatus()
		for {
			select {
			case <-connCtx.Done():
				return
			case now := <-smTicker.C:
				tickCount++
				tSec := now.Sub(s.startAt).Seconds()
				rxA, rxB, subRx, cwPitchHz, _, _, _ := s.radio.Snapshot()
				var sb strings.Builder
				sb.WriteString(fmt.Sprintf("SMH%+04d;", MeasurePassbandDbm(rxA, cwPitchHz, tSec)))
				if subRx {
					sb.WriteString(fmt.Sprintf("SMH$%+04d;", MeasurePassbandDbm(rxB, cwPitchHz, tSec)))
				}
				ovA, ovB := s.radio.OverflowStatus()
				if ovA != lastOvA {
					lastOvA = ovA
					sb.WriteString(fmt.Sprintf("OV%d0;", ovA))
				}
				if ovB != lastOvB {
					lastOvB = ovB
					sb.WriteString(fmt.Sprintf("OV$%d0;", ovB))
				}
				// Emit TB/TB$ quickly at startup (tick 2) and every 2.5s thereafter when near beacon
				if tickCount == 2 || tickCount%10 == 0 {
					if NearBeacon(rxA.FreqHz) {
						sb.WriteString("TB020CQ DE W6ELE K ; 73 ;;")
					}
					if NearBeacon(rxB.FreqHz) {
						sb.WriteString("TB$020CQ DE W6ELE K ; 73 ;;")
					}
					if siCat := s.radio.PeriodicSystemInfoCAT(tSec); siCat != "" {
						sb.WriteString(siCat)
					}
				}
				if err := writePacket(EncodeCAT(sb.String())); err != nil {
					cancelConn()
					return
				}
			}
		}
	}()

	// Reader loop: parse incoming framed CAT packets
	framer := &StreamFramer{}
	readBuf := make([]byte, 4096)
	for {
		n, err := conn.Read(readBuf)
		if n > 0 {
			payloads := framer.Push(readBuf[:n])
			tSec := time.Since(s.startAt).Seconds()
			for _, p := range payloads {
				if len(p) < 3 || p[0] != TypeCAT {
					continue
				}
				catASCII := string(p[3:])
				reply, closeRequested := s.radio.HandleCAT(catASCII, tSec)
				if reply != "" {
					if werr := writePacket(EncodeCAT(reply)); werr != nil {
						cancelConn()
						streamWg.Wait()
						return
					}
				}
				if closeRequested {
					cancelConn()
					streamWg.Wait()
					return
				}
			}
		}
		if err != nil {
			cancelConn()
			streamWg.Wait()
			return
		}
	}
}

func main() {
	listenAddr := flag.String("listen", "127.0.0.1:19205", "TCP listen address")
	password := flag.String("password", "", "Optional K4 network password")
	fps := flag.Int("fps", 20, "Panadapter frame rate (1..30)")
	controlHTTP := flag.String("control-http", "127.0.0.1:19206", "Optional HTTP debug stats address (empty disables)")
	flag.Parse()

	srv, err := NewSimServer(ServerConfig{
		ListenAddr:  *listenAddr,
		Password:    *password,
		FPS:         *fps,
		ControlHTTP: *controlHTTP,
	})
	if err != nil {
		log.Fatalf("failed to start k4sim: %v", err)
	}
	log.Printf("k4sim listening on tcp://%s (fps=%d, control-http=%q)", srv.Addr(), *fps, *controlHTTP)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := srv.Serve(ctx); err != nil {
		log.Fatalf("k4sim serve error: %v", err)
	}
}
