//go:build !cgo || !linux

package main

import "errors"

// OpusAvailable reports whether dynamic libopus.so.0 encoding is available.
func OpusAvailable() bool {
	return false
}

// OpusStreamEncoder is a stub when built without CGO on Linux.
type OpusStreamEncoder struct{}

// NewOpusStreamEncoder returns an error when CGO/Linux libopus support is disabled.
func NewOpusStreamEncoder(bitrateBps int) (*OpusStreamEncoder, error) {
	return nil, errors.New("opus unavailable: requires cgo on linux")
}

// Encode12kStereo returns an error in no-CGO builds.
func (e *OpusStreamEncoder) Encode12kStereo(pcm12k []float32, bitrateBps int) ([]byte, error) {
	return nil, errors.New("opus unavailable: requires cgo on linux")
}

// Close releases encoder resources (no-op in stub).
func (e *OpusStreamEncoder) Close() {}
