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
