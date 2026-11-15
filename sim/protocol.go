package main

import (
	"crypto/sha512"
	"encoding/binary"
	"encoding/hex"
	"strings"
)

const (
	MaxPayloadSize = 262144

	TypeCAT     uint8 = 0x00
	TypeAudio   uint8 = 0x01
	TypePAN     uint8 = 0x02
	TypeMiniPAN uint8 = 0x03

	AudioSampleRate12k uint8 = 0
)

var (
	StartMarker = [4]byte{0xFE, 0xFD, 0xFC, 0xFB}
	EndMarker   = [4]byte{0xFB, 0xFC, 0xFD, 0xFE}
)

// ExpectedAuthHex returns the 96-char lowercase SHA-384 hex digest of password.
func ExpectedAuthHex(password string) string {
	sum := sha512.Sum384([]byte(password))
	return hex.EncodeToString(sum[:])
}

// ValidateAuthHex verifies that blob is exactly 96 lowercase hex ASCII bytes.
func ValidateAuthHex(blob []byte) (string, bool) {
	if len(blob) != 96 {
		return "", false
	}
	for _, b := range blob {
		if !((b >= '0' && b <= '9') || (b >= 'a' && b <= 'f')) {
			return "", false
		}
	}
	return string(blob), true
}

// EncodeFrame wraps a payload with K4 start/length/end markers.
func EncodeFrame(payload []byte) []byte {
	out := make([]byte, 12+len(payload))
	copy(out[0:4], StartMarker[:])
	binary.BigEndian.PutUint32(out[4:8], uint32(len(payload)))
	copy(out[8:8+len(payload)], payload)
	copy(out[8+len(payload):], EndMarker[:])
	return out
}

// EncodeCAT encodes an ASCII CAT string as a framed 0x00 payload.
func EncodeCAT(catText string) []byte {
	payload := make([]byte, 3+len(catText))
	payload[0] = TypeCAT
	copy(payload[3:], catText)
	return EncodeFrame(payload)
}

// EncodeAudio encodes an audio frame as a framed 0x01 payload with 7-byte header.
func EncodeAudio(seq uint8, encodeMode uint8, frameSamplesPerCh uint16, sampleRateCode uint8, audioData []byte) []byte {
	payload := make([]byte, 7+len(audioData))
	payload[0] = TypeAudio
	payload[1] = 0x01
	payload[2] = seq
	payload[3] = encodeMode
	binary.LittleEndian.PutUint16(payload[4:6], frameSamplesPerCh)
	payload[6] = sampleRateCode
	copy(payload[7:], audioData)
	return EncodeFrame(payload)
}

// EncodePAN encodes a 1024-bin PAN (0x02) or MiniPAN (0x03) framed packet.
// For 0x02 PAN, field23 carries noiseFloorRaw (e.g., -1200 for -120.0 dBm * 10);
// for 0x03 MiniPAN, field23 carries the positive K4 MiniPAN [23..26] field (~285).
func EncodePAN(packetType uint8, seq uint8, panType uint8, receiver uint8, centerFreqHz int64, spanOrRateKHz int32, field23 int32, bins []byte) []byte {
	payload := make([]byte, 27+len(bins))
	payload[0] = packetType
	payload[1] = 0x00
	payload[2] = seq
	payload[3] = panType
	payload[4] = receiver
	binary.LittleEndian.PutUint16(payload[5:7], uint16(len(bins)))
	binary.LittleEndian.PutUint32(payload[7:11], 0)
	binary.LittleEndian.PutUint64(payload[11:19], uint64(centerFreqHz))
	binary.LittleEndian.PutUint32(payload[19:23], uint32(spanOrRateKHz))
	binary.LittleEndian.PutUint32(payload[23:27], uint32(field23))
	copy(payload[27:], bins)
	return EncodeFrame(payload)
}

// StreamFramer parses K4 binary stream frames across arbitrary chunk boundaries.
type StreamFramer struct {
	buf            []byte
	PacketsDecoded uint64
	BadLengths     uint64
	BadEndMarkers  uint64
}

// Push appends chunk and returns all complete payloads extracted so far.
func (f *StreamFramer) Push(chunk []byte) [][]byte {
	if len(chunk) > 0 {
		f.buf = append(f.buf, chunk...)
	}
	var out [][]byte
	cursor := 0
	n := len(f.buf)

	for n-cursor >= 4 {
		idx := findStartMarker(f.buf, cursor)
		if idx < 0 {
			keep := min(n-cursor, 3)
			cursor = n - keep
			break
		}
		cursor = idx
		avail := n - cursor
		if avail < 12 {
			break
		}
		payloadLen := binary.BigEndian.Uint32(f.buf[cursor+4 : cursor+8])
		if payloadLen == 0 || payloadLen > MaxPayloadSize {
			f.BadLengths++
			cursor += 4
			continue
		}
		totalLen := 12 + int(payloadLen)
		if avail < totalLen {
			break
		}
		endOffset := cursor + 8 + int(payloadLen)
		if f.buf[endOffset] != EndMarker[0] ||
			f.buf[endOffset+1] != EndMarker[1] ||
			f.buf[endOffset+2] != EndMarker[2] ||
			f.buf[endOffset+3] != EndMarker[3] {
			f.BadEndMarkers++
			cursor += 4
			continue
		}
		payload := make([]byte, payloadLen)
		copy(payload, f.buf[cursor+8:endOffset])
		out = append(out, payload)
		f.PacketsDecoded++
		cursor += totalLen
	}

	if cursor > 0 {
		remaining := n - cursor
		if remaining > 0 {
			copy(f.buf[0:remaining], f.buf[cursor:n])
		}
		f.buf = f.buf[:remaining]
	}
	return out
}

func findStartMarker(b []byte, start int) int {
	limit := len(b) - 4
	for i := start; i <= limit; i++ {
		if b[i] == StartMarker[0] && b[i+1] == StartMarker[1] && b[i+2] == StartMarker[2] && b[i+3] == StartMarker[3] {
			return i
		}
	}
	return -1
}

// SplitCATFrames splits semicolon-terminated CAT commands while preserving
// byte-counted TBtrrs; / TB$trrs; payloads containing literal semicolons.
func SplitCATFrames(ascii string) []string {
	var cmds []string
	i := 0
	n := len(ascii)
	for i < n {
		for i < n && (ascii[i] == ';' || ascii[i] == '\r' || ascii[i] == '\n' || ascii[i] == ' ' || ascii[i] == '\t') {
			i++
		}
		if i >= n {
			break
		}
		if strings.HasPrefix(ascii[i:], "TB") {
			hdrLen := 2
			if i+2 < n && ascii[i+2] == '$' {
				hdrLen = 3
			}
			if i+hdrLen+3 <= n {
				tChar := ascii[i+hdrLen]
				r1 := ascii[i+hdrLen+1]
				r2 := ascii[i+hdrLen+2]
				if tChar >= '0' && tChar <= '9' && r1 >= '0' && r1 <= '9' && r2 >= '0' && r2 <= '9' {
					textLen := int(r1-'0')*10 + int(r2-'0')
					end := i + hdrLen + 3 + textLen
					if end > n {
						end = n
					}
					cmds = append(cmds, ascii[i:end])
					i = end
					if i < n && ascii[i] == ';' {
						i++
					}
					continue
				}
			}
		}
		semi := strings.IndexByte(ascii[i:], ';')
		if semi < 0 {
			tail := strings.TrimSpace(ascii[i:])
			if tail != "" {
				cmds = append(cmds, tail)
			}
			break
		}
		cmd := strings.TrimSpace(ascii[i : i+semi])
		if cmd != "" {
			cmds = append(cmds, cmd)
		}
		i += semi + 1
	}
	return cmds
}
