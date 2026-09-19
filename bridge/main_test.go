package main

import (
	"bytes"
	"io"
	"runtime"
	"testing"

	"github.com/yovanoc/effect-tls-client/bridge/protocol"
)

func TestVersionString(t *testing.T) {
	got := versionString()
	want := "effect-tls-client-bridge " + version

	if got != want {
		t.Fatalf("versionString() = %q, want %q", got, want)
	}
}

func TestTlsClientVersionFromBuildInfo(t *testing.T) {
	got := tlsClientVersion()
	if got == "" || got == "unknown" {
		t.Fatalf("tlsClientVersion() = %q, want the embedded module version", got)
	}
}

func TestRunHandshakePingShutdown(t *testing.T) {
	hello, err := protocol.EncodeMeta(protocol.HelloMeta{
		ProtocolVersion: protocolVersion,
		ClientVersion:   version,
	})
	if err != nil {
		t.Fatal(err)
	}
	ping, err := protocol.EncodeMeta(protocol.EmptyMeta{})
	if err != nil {
		t.Fatal(err)
	}

	var input bytes.Buffer
	if err := protocol.WriteFrame(&input, protocol.Frame{Kind: protocol.KindHello, ID: 0, Meta: hello}); err != nil {
		t.Fatal(err)
	}
	if err := protocol.WriteFrame(&input, protocol.Frame{Kind: protocol.KindDebugPing, ID: 1, Meta: ping}); err != nil {
		t.Fatal(err)
	}
	if err := protocol.WriteFrame(&input, protocol.Frame{Kind: protocol.KindShutdown, ID: 0, Meta: ping}); err != nil {
		t.Fatal(err)
	}

	var output bytes.Buffer
	if code := run(&input, &output, io.Discard); code != 0 {
		t.Fatalf("run() exit code = %d, want 0", code)
	}

	ack := readTestFrame(t, &output)
	if ack.Kind != protocol.KindHelloAck || ack.ID != 0 {
		t.Fatalf("helloAck = %+v", ack)
	}
	var ackMeta protocol.HelloAckMeta
	if err := protocol.DecodeObject(ack.Meta, &ackMeta); err != nil {
		t.Fatal(err)
	}
	if ackMeta.ProtocolVersion != protocolVersion || ackMeta.BridgeVersion != version || ackMeta.TlsClientVersion != tlsClientVersion() || ackMeta.GoVersion != runtime.Version() {
		t.Fatalf("helloAck metadata = %+v", ackMeta)
	}

	pong := readTestFrame(t, &output)
	if pong.Kind != protocol.KindOk || pong.ID != 1 {
		t.Fatalf("ping response = %+v", pong)
	}
	shutdown := readTestFrame(t, &output)
	if shutdown.Kind != protocol.KindOk || shutdown.ID != 0 {
		t.Fatalf("shutdown response = %+v", shutdown)
	}
	if output.Len() != 0 {
		t.Fatalf("unexpected trailing output: %d bytes", output.Len())
	}
}

func TestRunRejectsBadFirstFrame(t *testing.T) {
	meta, err := protocol.EncodeMeta(protocol.EmptyMeta{})
	if err != nil {
		t.Fatal(err)
	}
	var input bytes.Buffer
	if err := protocol.WriteFrame(&input, protocol.Frame{Kind: protocol.KindDebugPing, ID: 1, Meta: meta}); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if code := run(&input, &output, io.Discard); code != 2 {
		t.Fatalf("run() exit code = %d, want 2", code)
	}
	if output.Len() != 0 {
		t.Fatalf("bad first frame produced %d output bytes", output.Len())
	}
}

func TestRunEOFIsClean(t *testing.T) {
	var output bytes.Buffer
	if code := run(bytes.NewReader(nil), &output, io.Discard); code != 0 {
		t.Fatalf("run() exit code = %d, want 0", code)
	}
}

func TestRunRejectsUnknownKind(t *testing.T) {
	hello, err := protocol.EncodeMeta(protocol.HelloMeta{ProtocolVersion: protocolVersion, ClientVersion: version})
	if err != nil {
		t.Fatal(err)
	}
	empty, err := protocol.EncodeMeta(protocol.EmptyMeta{})
	if err != nil {
		t.Fatal(err)
	}
	var input bytes.Buffer
	for _, frame := range []protocol.Frame{
		{Kind: protocol.KindHello, ID: 0, Meta: hello},
		{Kind: 0x7f, ID: 2, Meta: empty},
	} {
		if err := protocol.WriteFrame(&input, frame); err != nil {
			t.Fatal(err)
		}
	}
	var output bytes.Buffer
	if code := run(&input, &output, io.Discard); code != 2 {
		t.Fatalf("run() exit code = %d, want 2", code)
	}
	ack := readTestFrame(t, &output)
	if ack.Kind != protocol.KindHelloAck || ack.ID != 0 {
		t.Fatalf("unexpected output before rejection = %+v", ack)
	}
	if output.Len() != 0 {
		t.Fatalf("unknown kind produced a response")
	}
}

func readTestFrame(t *testing.T, output *bytes.Buffer) protocol.Frame {
	t.Helper()
	frame, err := protocol.ReadFrame(output)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	return frame
}

func TestRunMalformedFrameExitsTwo(t *testing.T) {
	var input bytes.Buffer
	if _, err := input.Write([]byte{0, 0, 0, 9, byte(protocol.KindHello), 0, 0, 0, 0}); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if code := run(&input, &output, io.Discard); code != 2 {
		t.Fatalf("run() exit code = %d, want 2", code)
	}
}
