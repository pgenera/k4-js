//go:build cgo && linux

package main

/*
#cgo linux LDFLAGS: -ldl
#include <dlfcn.h>
#include <stdint.h>
#include <stdlib.h>

typedef void* (*fn_opus_encoder_create)(int32_t fs, int channels, int application, int *error);
typedef void  (*fn_opus_encoder_destroy)(void *st);
typedef int   (*fn_opus_encode_float)(void *st, const float *pcm, int frame_size, unsigned char *data, int32_t max_data_bytes);
typedef int   (*fn_opus_encoder_ctl)(void *st, int request, ...);
typedef void* (*fn_opus_repacketizer_create)(void);
typedef void  (*fn_opus_repacketizer_destroy)(void *rp);
typedef void* (*fn_opus_repacketizer_init)(void *rp);
typedef int   (*fn_opus_repacketizer_cat)(void *rp, const unsigned char *data, int32_t len);
typedef int32_t (*fn_opus_repacketizer_out)(void *rp, unsigned char *data, int32_t max_len);

static void* call_opus_encoder_create(void *fn, int32_t fs, int channels, int app, int *err) {
	return ((fn_opus_encoder_create)fn)(fs, channels, app, err);
}

static void call_opus_encoder_destroy(void *fn, void *st) {
	((fn_opus_encoder_destroy)fn)(st);
}

static int call_opus_encode_float(void *fn, void *st, const float *pcm, int frame_size, unsigned char *data, int32_t max_bytes) {
	return ((fn_opus_encode_float)fn)(st, pcm, frame_size, data, max_bytes);
}

static int call_opus_encoder_ctl_int32(void *fn, void *st, int req, int32_t val) {
	return ((fn_opus_encoder_ctl)fn)(st, req, val);
}

static void* call_opus_repacketizer_create(void *fn) {
	return ((fn_opus_repacketizer_create)fn)();
}

static void call_opus_repacketizer_destroy(void *fn, void *rp) {
	((fn_opus_repacketizer_destroy)fn)(rp);
}

static void* call_opus_repacketizer_init(void *fn, void *rp) {
	return ((fn_opus_repacketizer_init)fn)(rp);
}

static int call_opus_repacketizer_cat(void *fn, void *rp, const unsigned char *data, int32_t len) {
	return ((fn_opus_repacketizer_cat)fn)(rp, data, len);
}

static int32_t call_opus_repacketizer_out(void *fn, void *rp, unsigned char *data, int32_t max_len) {
	return ((fn_opus_repacketizer_out)fn)(rp, data, max_len);
}
*/
import "C"

import (
	"errors"
	"fmt"
	"sync"
	"unsafe"
)

const (
	opusApplicationAudio   = 2049
	opusSetBitrateRequest  = 4002
	opusSetMaxBandwidthReq = 4004
	opusBandwidthWideband  = 1103
	opusSetSignalRequest   = 4024
	opusSignalMusic        = 3002

	opusRate48kHz          = 48000
	opusFrameSamplesPerCh  = 960 // 20 ms at 48 kHz
	opusMaxPacketPerFrame  = 1500
	opusMaxOutPacketBytes  = 9216
)

type opusDynLib struct {
	handle                   unsafe.Pointer
	encoderCreate            unsafe.Pointer
	encoderDestroy           unsafe.Pointer
	encodeFloat              unsafe.Pointer
	encoderCtl               unsafe.Pointer
	repacketizerCreate       unsafe.Pointer
	repacketizerDestroy      unsafe.Pointer
	repacketizerInit         unsafe.Pointer
	repacketizerCat          unsafe.Pointer
	repacketizerOut          unsafe.Pointer
	loadErr                  error
}

var (
	opusLibOnce sync.Once
	opusLib     opusDynLib
)

func loadOpusLib() *opusDynLib {
	opusLibOnce.Do(func() {
		name := C.CString("libopus.so.0")
		defer C.free(unsafe.Pointer(name))

		handle := C.dlopen(name, C.RTLD_LAZY)
		if handle == nil {
			opusLib.loadErr = errors.New("dlopen(libopus.so.0) failed")
			return
		}
		opusLib.handle = handle

		lookup := func(sym string) (unsafe.Pointer, error) {
			cs := C.CString(sym)
			defer C.free(unsafe.Pointer(cs))
			ptr := C.dlsym(handle, cs)
			if ptr == nil {
				return nil, fmt.Errorf("dlsym(%s) failed", sym)
			}
			return ptr, nil
		}

		syms := []struct {
			name string
			dst  *unsafe.Pointer
		}{
			{"opus_encoder_create", &opusLib.encoderCreate},
			{"opus_encoder_destroy", &opusLib.encoderDestroy},
			{"opus_encode_float", &opusLib.encodeFloat},
			{"opus_encoder_ctl", &opusLib.encoderCtl},
			{"opus_repacketizer_create", &opusLib.repacketizerCreate},
			{"opus_repacketizer_destroy", &opusLib.repacketizerDestroy},
			{"opus_repacketizer_init", &opusLib.repacketizerInit},
			{"opus_repacketizer_cat", &opusLib.repacketizerCat},
			{"opus_repacketizer_out", &opusLib.repacketizerOut},
		}
		for _, s := range syms {
			ptr, err := lookup(s.name)
			if err != nil {
				opusLib.loadErr = err
				return
			}
			*s.dst = ptr
		}
	})
	return &opusLib
}

// OpusAvailable reports whether libopus.so.0 loaded cleanly via dlopen/dlsym.
func OpusAvailable() bool {
	return loadOpusLib().loadErr == nil
}

// OpusStreamEncoder encodes 12 kHz stereo float PCM into 48 kHz RFC 6716 Opus packets.
type OpusStreamEncoder struct {
	lib          *opusDynLib
	enc          unsafe.Pointer
	rp           unsafe.Pointer
	bitrateBps   int
	upsamplePrev [2]float32
}

// NewOpusStreamEncoder creates a stereo 48 kHz Opus encoder and repacketizer via libopus.so.0.
func NewOpusStreamEncoder(bitrateBps int) (*OpusStreamEncoder, error) {
	lib := loadOpusLib()
	if lib.loadErr != nil {
		return nil, lib.loadErr
	}
	if bitrateBps <= 0 {
		bitrateBps = 64000
	}

	var cerr C.int
	enc := C.call_opus_encoder_create(lib.encoderCreate, opusRate48kHz, 2, opusApplicationAudio, &cerr)
	if enc == nil || cerr != 0 {
		return nil, fmt.Errorf("opus_encoder_create failed: %d", int(cerr))
	}

	rp := C.call_opus_repacketizer_create(lib.repacketizerCreate)
	if rp == nil {
		C.call_opus_encoder_destroy(lib.encoderDestroy, enc)
		return nil, errors.New("opus_repacketizer_create failed")
	}

	e := &OpusStreamEncoder{
		lib: lib,
		enc: enc,
		rp:  rp,
	}
	if err := e.configure(bitrateBps); err != nil {
		e.Close()
		return nil, err
	}
	return e, nil
}

func (e *OpusStreamEncoder) configure(bitrateBps int) error {
	if rc := C.call_opus_encoder_ctl_int32(e.lib.encoderCtl, e.enc, opusSetMaxBandwidthReq, opusBandwidthWideband); rc != 0 {
		return fmt.Errorf("opus OPUS_SET_MAX_BANDWIDTH failed: %d", int(rc))
	}
	if rc := C.call_opus_encoder_ctl_int32(e.lib.encoderCtl, e.enc, opusSetSignalRequest, opusSignalMusic); rc != 0 {
		return fmt.Errorf("opus OPUS_SET_SIGNAL failed: %d", int(rc))
	}
	if rc := C.call_opus_encoder_ctl_int32(e.lib.encoderCtl, e.enc, opusSetBitrateRequest, C.int32_t(bitrateBps)); rc != 0 {
		return fmt.Errorf("opus OPUS_SET_BITRATE(%d) failed: %d", bitrateBps, int(rc))
	}
	e.bitrateBps = bitrateBps
	return nil
}

// Close destroys the native Opus encoder and repacketizer handles.
func (e *OpusStreamEncoder) Close() {
	if e == nil || e.lib == nil {
		return
	}
	if e.rp != nil {
		C.call_opus_repacketizer_destroy(e.lib.repacketizerDestroy, e.rp)
		e.rp = nil
	}
	if e.enc != nil {
		C.call_opus_encoder_destroy(e.lib.encoderDestroy, e.enc)
		e.enc = nil
	}
}

// Encode12kStereo upsamples 12 kHz interleaved stereo float PCM 4x to 48 kHz and
// encodes it into a single-frame or repacketized multi-frame RFC 6716 Opus packet.
func (e *OpusStreamEncoder) Encode12kStereo(pcm12k []float32, bitrateBps int) ([]byte, error) {
	if e == nil || e.enc == nil || e.rp == nil {
		return nil, errors.New("opus encoder is closed")
	}
	if bitrateBps > 0 && bitrateBps != e.bitrateBps {
		if rc := C.call_opus_encoder_ctl_int32(e.lib.encoderCtl, e.enc, opusSetBitrateRequest, C.int32_t(bitrateBps)); rc != 0 {
			return nil, fmt.Errorf("opus OPUS_SET_BITRATE(%d) failed: %d", bitrateBps, int(rc))
		}
		e.bitrateBps = bitrateBps
	}

	samples12kPerCh := len(pcm12k) / 2
	if samples12kPerCh <= 0 || samples12kPerCh%240 != 0 {
		return nil, fmt.Errorf("expected multiple of 240 stereo 12kHz samples, got %d", samples12kPerCh)
	}
	numFrames := samples12kPerCh / 240

	var upsampled []float32
	upsampled, e.upsamplePrev = Upsample4xStereo(pcm12k, e.upsamplePrev)

	// Each frame buffer must stay valid until opus_repacketizer_out copies the frames.
	frameBufs := make([][opusMaxPacketPerFrame]byte, numFrames)
	frameLens := make([]int, numFrames)

	for i := 0; i < numFrames; i++ {
		pcmStart := i * opusFrameSamplesPerCh * 2
		pcmPtr := (*C.float)(unsafe.Pointer(&upsampled[pcmStart]))
		outPtr := (*C.uchar)(unsafe.Pointer(&frameBufs[i][0]))
		n := int(C.call_opus_encode_float(
			e.lib.encodeFloat,
			e.enc,
			pcmPtr,
			opusFrameSamplesPerCh,
			outPtr,
			opusMaxPacketPerFrame,
		))
		if n <= 0 {
			return nil, fmt.Errorf("opus_encode_float frame %d failed: %d", i, n)
		}
		frameLens[i] = n
	}

	if numFrames == 1 {
		out := make([]byte, frameLens[0])
		copy(out, frameBufs[0][:frameLens[0]])
		return out, nil
	}

	C.call_opus_repacketizer_init(e.lib.repacketizerInit, e.rp)
	for i := 0; i < numFrames; i++ {
		ptr := (*C.uchar)(unsafe.Pointer(&frameBufs[i][0]))
		if rc := C.call_opus_repacketizer_cat(e.lib.repacketizerCat, e.rp, ptr, C.int32_t(frameLens[i])); rc != 0 {
			return nil, fmt.Errorf("opus_repacketizer_cat frame %d failed: %d", i, int(rc))
		}
	}

	out := make([]byte, opusMaxOutPacketBytes)
	outPtr := (*C.uchar)(unsafe.Pointer(&out[0]))
	total := int(C.call_opus_repacketizer_out(e.lib.repacketizerOut, e.rp, outPtr, opusMaxOutPacketBytes))
	if total <= 0 {
		return nil, fmt.Errorf("opus_repacketizer_out failed: %d", total)
	}
	return out[:total], nil
}
