// Package protocol implements the Bridge wire protocol described in
// docs/design/03-protocol.md: a hand-rolled, big-endian, length-prefixed
// binary frame format multiplexed on stdio.
//
// Issue #4 adds cancellation and credit flow to the debug operations while
// keeping the rest of protocol v1 reserved for later stages.
package protocol

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// MaxFrameLen is the maximum value of the frame's len field (bytes after the
// length field itself), per protocol doc section 1.
const MaxFrameLen = 16 * 1024 * 1024 // 16 MiB

// headerLen is the size, in bytes, of the fixed part of a frame after len:
// kind(1) + id(4) + metadata length(4).
const headerLen = 1 + 4 + 4

// Kind identifies the type of a frame.
type Kind uint8

const (
	// JS -> Go.
	KindHello          Kind = 0x01
	KindShutdown       Kind = 0x02
	KindSessionCreate  Kind = 0x10
	KindSessionDestroy Kind = 0x11
	KindRequest        Kind = 0x20
	KindCancel         Kind = 0x40
	KindAck            Kind = 0x41
	KindDebugPing      Kind = 0xF0
	KindDebugSleep     Kind = 0xF1
	KindDebugStream    Kind = 0xF2

	// Go -> JS.
	KindHelloAck Kind = 0x80
	KindOk       Kind = 0x81
	KindError    Kind = 0x82
	KindHeaders  Kind = 0x90
	KindChunk    Kind = 0x91
	KindEnd      Kind = 0x92
)

// ErrProtocol is the sentinel wrapped by frame-level protocol violations.
var ErrProtocol = errors.New("protocol violation")

// Frame is a single decoded protocol frame.
type Frame struct {
	Kind Kind
	ID   uint32
	Meta []byte // UTF-8 JSON, may be empty
	Body []byte // raw bytes, may be empty
}

// IsKnownKind reports whether kind is implemented by this protocol-v1 Bridge.
func IsKnownKind(kind Kind) bool {
	switch kind {
	case KindHello, KindShutdown, KindSessionCreate, KindSessionDestroy, KindRequest,
		KindCancel, KindAck, KindDebugPing, KindDebugSleep, KindDebugStream,
		KindHelloAck, KindOk, KindError, KindHeaders, KindChunk, KindEnd:
		return true
	default:
		return false
	}
}

// ReadFrame reads exactly one frame from r. A clean EOF before any byte of a
// new frame is returned as io.EOF. A partial header or body is malformed.
func ReadFrame(r io.Reader) (Frame, error) {
	var lenBuf [4]byte
	n, err := io.ReadFull(r, lenBuf[:])
	if err != nil {
		if err == io.EOF && n == 0 {
			return Frame{}, io.EOF
		}
		return Frame{}, fmt.Errorf("%w: incomplete length prefix: %v", ErrProtocol, err)
	}

	length := binary.BigEndian.Uint32(lenBuf[:])
	if length > MaxFrameLen {
		return Frame{}, fmt.Errorf("%w: frame length %d exceeds max %d", ErrProtocol, length, MaxFrameLen)
	}
	if length < headerLen {
		return Frame{}, fmt.Errorf("%w: frame length %d smaller than header size %d", ErrProtocol, length, headerLen)
	}

	rest := make([]byte, int(length))
	if _, err := io.ReadFull(r, rest); err != nil {
		return Frame{}, fmt.Errorf("%w: incomplete frame: %v", ErrProtocol, err)
	}

	kind := Kind(rest[0])
	if !IsKnownKind(kind) {
		return Frame{}, fmt.Errorf("%w: unknown frame kind 0x%02x", ErrProtocol, byte(kind))
	}
	id := binary.BigEndian.Uint32(rest[1:5])
	mlen := binary.BigEndian.Uint32(rest[5:9])
	if uint64(headerLen)+uint64(mlen) > uint64(length) {
		return Frame{}, fmt.Errorf("%w: metadata length %d exceeds frame length %d", ErrProtocol, mlen, length)
	}

	metaEnd := headerLen + int(mlen)
	return Frame{
		Kind: kind,
		ID:   id,
		Meta: rest[headerLen:metaEnd],
		Body: rest[metaEnd:],
	}, nil
}

// WriteFrame serializes and writes a single frame to w.
func WriteFrame(w io.Writer, f Frame) error {
	length := uint64(headerLen) + uint64(len(f.Meta)) + uint64(len(f.Body))
	if length > MaxFrameLen {
		return fmt.Errorf("%w: frame length %d exceeds max %d", ErrProtocol, length, MaxFrameLen)
	}

	buf := make([]byte, 4+int(length))
	binary.BigEndian.PutUint32(buf[0:4], uint32(length))
	buf[4] = byte(f.Kind)
	binary.BigEndian.PutUint32(buf[5:9], f.ID)
	binary.BigEndian.PutUint32(buf[9:13], uint32(len(f.Meta)))
	copy(buf[13:13+len(f.Meta)], f.Meta)
	copy(buf[13+len(f.Meta):], f.Body)
	return writeAll(w, buf)
}

func writeAll(w io.Writer, p []byte) error {
	for len(p) > 0 {
		n, err := w.Write(p)
		if n > 0 {
			p = p[n:]
		}
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}
