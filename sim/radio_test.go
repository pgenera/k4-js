package main

import (
	"math/rand"
	"testing"
)

func assertSlicePanState(t *testing.T, r *Radio, rx byte, wantFreq, wantCenter, wantOffset int64) {
	t.Helper()
	rxA, rxB, _, cwPitch, _, _, _ := r.Snapshot()
	slice := rxA
	if rx == 'B' {
		slice = rxB
	}
	if slice.FreqHz != wantFreq {
		t.Fatalf("RX %c FreqHz = %d, want %d", rx, slice.FreqHz, wantFreq)
	}
	if slice.PanCenterOffsetHz != wantOffset {
		t.Fatalf("RX %c PanCenterOffsetHz = %d, want %d", rx, slice.PanCenterOffsetHz, wantOffset)
	}
	if got := slice.PanCenterHz(); got != wantCenter {
		t.Fatalf("RX %c PanCenterHz() = %d, want %d", rx, got, wantCenter)
	}
	centerHz, _, _, _ := SynthPAN(slice, cwPitch, 1.0, rand.New(rand.NewSource(42)))
	if centerHz != wantCenter {
		t.Fatalf("RX %c SynthPAN centerHz = %d, want %d", rx, centerHz, wantCenter)
	}
}

func TestAbFixedTuneInSpanSwapPreservesPanCenter(t *testing.T) {
	cases := []struct {
		name      string
		cmd       string
		checkMode bool
	}{
		{name: "AB2_freq_swap", cmd: "AB2;", checkMode: false},
		{name: "AB5_full_swap", cmd: "AB5;", checkMode: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := NewRadio()
			r.HandleCAT("#FXT1;#SPN48000;#SPN$48000;FA00014074000;FB00014084000;MD2;MD$3;", 0.5)
			r.HandleCAT("FI00014078000;FI$00014080000;", 0.6)

			r.HandleCAT(tc.cmd, 0.7)

			// 14078000 and 14084000 are 6 kHz apart (<= half-span 24 kHz): RX A stays fixed at 14078000.
			assertSlicePanState(t, r, 'A', 14084000, 14078000, -6000)
			// 14080000 and 14074000 are 6 kHz apart (<= half-span 24 kHz): RX B stays fixed at 14080000.
			assertSlicePanState(t, r, 'B', 14074000, 14080000, 6000)

			if tc.checkMode {
				rxA, rxB, _, _, _, _, _ := r.Snapshot()
				if rxA.Mode != ModeCW || rxB.Mode != ModeUSB {
					t.Fatalf("AB5 mode swap failed: rxA.Mode=%d rxB.Mode=%d", rxA.Mode, rxB.Mode)
				}
			}
		})
	}
}

func TestAbCrossBandSwapRecentersInFixedTune(t *testing.T) {
	cases := []struct {
		name string
		cmd  string
	}{
		{name: "AB2_cross_band", cmd: "AB2;"},
		{name: "AB5_cross_band", cmd: "AB5;"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := NewRadio()
			r.HandleCAT("#FXT1;#SPN48000;#SPN$48000;FA00014074000;FB00007074000;", 0.5)
			r.HandleCAT("FI00014080000;FI$00007068000;", 0.6)

			r.HandleCAT(tc.cmd, 0.7)

			// Cross-band jump (> half-span) must re-center onto new VFO frequencies (never +/-5 MHz clamp).
			assertSlicePanState(t, r, 'A', 7074000, 7074000, 0)
			assertSlicePanState(t, r, 'B', 14074000, 14074000, 0)
		})
	}
}

func TestAbTrackingModeRecentersPan(t *testing.T) {
	cmds := []string{"AB2;", "AB5;"}
	freqs := []struct {
		name  string
		freqA string
		freqB string
		wantA int64
		wantB int64
	}{
		{
			name:  "in_span",
			freqA: "FA00014074000;",
			freqB: "FB00014084000;",
			wantA: 14084000,
			wantB: 14074000,
		},
		{
			name:  "cross_band",
			freqA: "FA00014074000;",
			freqB: "FB00007074000;",
			wantA: 7074000,
			wantB: 14074000,
		},
	}

	for _, cmd := range cmds {
		for _, fq := range freqs {
			t.Run(cmd+"_"+fq.name, func(t *testing.T) {
				r := NewRadio()
				r.HandleCAT("#FXT0;#SPN48000;#SPN$48000;"+fq.freqA+fq.freqB, 0.5)
				r.HandleCAT(cmd, 0.6)

				assertSlicePanState(t, r, 'A', fq.wantA, fq.wantA, 0)
				assertSlicePanState(t, r, 'B', fq.wantB, fq.wantB, 0)
			})
		}
	}
}

func TestAbCopySingleDirectionFixedTune(t *testing.T) {
	t.Run("AB0_and_AB1_in_span_preserve_center", func(t *testing.T) {
		r := NewRadio()
		r.HandleCAT("#FXT1;#SPN48000;#SPN$48000;FA00014074000;FB00014084000;", 0.5)
		r.HandleCAT("AB0;", 0.6) // A -> B (14074000) within 24 kHz of B's 14084000
		assertSlicePanState(t, r, 'B', 14074000, 14084000, 10000)

		r.HandleCAT("FB00014090000;", 0.7) // B center stays 14084000 (offset -6000)
		r.HandleCAT("AB1;", 0.8)           // B -> A (14090000) within 24 kHz of A's 14074000
		assertSlicePanState(t, r, 'A', 14090000, 14074000, -16000)
	})

	t.Run("AB3_and_AB4_cross_band_recenter", func(t *testing.T) {
		r := NewRadio()
		r.HandleCAT("#FXT1;#SPN48000;#SPN$48000;FA00014074000;FB00007074000;", 0.5)
		r.HandleCAT("AB3;", 0.6) // A -> B full cross-band
		assertSlicePanState(t, r, 'B', 14074000, 14074000, 0)

		r.HandleCAT("FB00021074000;", 0.7)
		r.HandleCAT("AB4;", 0.8) // B -> A full cross-band
		assertSlicePanState(t, r, 'A', 21074000, 21074000, 0)
	})
}

func TestBandSwitchRecentersInFixedTune(t *testing.T) {
	r := NewRadio()
	r.HandleCAT("#FXT1;#SPN48000;FA00014074000;FI00014082000;", 0.5)
	r.HandleCAT("BN06;", 0.6) // Switch VFO A to 17m (18100000)
	assertSlicePanState(t, r, 'A', 18100000, 18100000, 0)
}

func TestFilterPresetAndNormalize(t *testing.T) {
	r := NewRadio()
	r.HandleCAT("MD3;BW0100;IS0120;FP2;", 0.1)
	if r.RxA.FilterPreset != 2 || r.RxA.BwHz != 250 {
		t.Fatalf("FP2 in MD3 should select preset 2 and 250 Hz BW, got fl=%d bw=%d", r.RxA.FilterPreset, r.RxA.BwHz)
	}
	r.HandleCAT("FP$3;", 0.2)
	if r.RxB.FilterPreset != 3 || r.RxA.FilterPreset != 2 {
		t.Fatalf("FP$3 should affect only RX B: A=%d B=%d", r.RxA.FilterPreset, r.RxB.FilterPreset)
	}
	r.HandleCAT("FP9;", 0.3)
	if r.RxA.FilterPreset != 2 {
		t.Fatalf("out-of-range preset must be ignored, got %d", r.RxA.FilterPreset)
	}
	r.HandleCAT("FP~;", 0.4)
	if r.RxA.BwHz != 500 || r.RxA.IfShiftHz != 500 || r.RxA.IfShiftHz != r.CwPitchHz || r.RxA.FilterPreset != 1 {
		t.Fatalf("FP~ should restore CW nominal passband: bw=%d is=%d fl=%d", r.RxA.BwHz, r.RxA.IfShiftHz, r.RxA.FilterPreset)
	}
	r.HandleCAT("MD2;IS0900;FP~;", 0.5)
	if r.RxA.BwHz != 2700 || r.RxA.IfShiftHz != 1500 || r.RxA.FilterPreset != 1 {
		t.Fatalf("FP~ in MD2 should restore USB nominal passband: bw=%d is=%d fl=%d", r.RxA.BwHz, r.RxA.IfShiftHz, r.RxA.FilterPreset)
	}
}
