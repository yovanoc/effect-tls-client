package protocol

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"testing"
)

func TestWriteReadRoundTrip(t *testing.T) {
	cases := []Frame{
		{Kind: KindHello, ID: 0, Meta: []byte(`{"protocolVersion":1}`), Body: nil},
		{Kind: KindDebugPing, ID: 7, Meta: []byte{}, Body: nil},
		{Kind: KindOk, ID: 5, Meta: []byte(`{}`)},
		{Kind: KindError, ID: 9, Meta: []byte(`{"kind":"Internal","message":"boom"}`)},
		{Kind: KindCancel, ID: 10, Meta: []byte(`{}`)},
		{Kind: KindAck, ID: 11, Meta: []byte(`{"bytes":3}`)},
		{Kind: KindChunk, ID: 12, Meta: []byte(`{}`), Body: []byte{1, 2, 3}},
		{Kind: KindEnd, ID: 12, Meta: []byte(`{"bytesRead":3,"bytesWritten":0}`)},
	}
	for _, c := range cases {
		var buf bytes.Buffer
		if err := WriteFrame(&buf, c); err != nil {
			t.Fatalf("WriteFrame: %v", err)
		}
		got, err := ReadFrame(&buf)
		if err != nil {
			t.Fatalf("ReadFrame: %v", err)
		}
		if got.Kind != c.Kind || got.ID != c.ID || !bytes.Equal(got.Meta, c.Meta) || !bytes.Equal(got.Body, c.Body) {
			t.Fatalf("round trip mismatch: got %+v, want %+v", got, c)
		}
	}
}

func TestReadFrameCleanEOF(t *testing.T) {
	_, err := ReadFrame(bytes.NewReader(nil))
	if !errors.Is(err, io.EOF) {
		t.Fatalf("expected io.EOF, got %v", err)
	}
}

func TestReadFrameTruncatedHeader(t *testing.T) {
	_, err := ReadFrame(bytes.NewReader([]byte{0, 0}))
	if !errors.Is(err, ErrProtocol) {
		t.Fatalf("expected ErrProtocol, got %v", err)
	}
}

func TestReadFrameTruncatedBody(t *testing.T) {
	_, err := ReadFrame(bytes.NewReader([]byte{0, 0, 0, 9, byte(KindOk), 0, 0, 0, 1, 0, 0, 0, 1}))
	if !errors.Is(err, ErrProtocol) {
		t.Fatalf("expected ErrProtocol, got %v", err)
	}
}

func TestReadFrameOversized(t *testing.T) {
	var lenBuf [4]byte
	binary.BigEndian.PutUint32(lenBuf[:], MaxFrameLen+1)
	_, err := ReadFrame(bytes.NewReader(lenBuf[:]))
	if !errors.Is(err, ErrProtocol) {
		t.Fatalf("expected ErrProtocol, got %v", err)
	}
}

func TestReadFrameTooSmallForHeader(t *testing.T) {
	var lenBuf [4]byte
	binary.BigEndian.PutUint32(lenBuf[:], 3) // smaller than headerLen (9)
	_, err := ReadFrame(bytes.NewReader(lenBuf[:]))
	if !errors.Is(err, ErrProtocol) {
		t.Fatalf("expected ErrProtocol, got %v", err)
	}
}

func TestReadFrameMetaLengthOverflow(t *testing.T) {
	var buf bytes.Buffer
	// length = 9 (bare header), but mlen claims 100 bytes of meta.
	binary.Write(&buf, binary.BigEndian, uint32(9))
	buf.WriteByte(byte(KindOk))
	binary.Write(&buf, binary.BigEndian, uint32(1))
	binary.Write(&buf, binary.BigEndian, uint32(100))
	_, err := ReadFrame(&buf)
	if !errors.Is(err, ErrProtocol) {
		t.Fatalf("expected ErrProtocol, got %v", err)
	}
}

func TestWriteFrameOversized(t *testing.T) {
	f := Frame{Kind: KindOk, ID: 1, Body: make([]byte, MaxFrameLen+1)}
	err := WriteFrame(io.Discard, f)
	if !errors.Is(err, ErrProtocol) {
		t.Fatalf("expected ErrProtocol, got %v", err)
	}
}
