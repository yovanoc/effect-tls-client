package main

import (
	"bytes"
	"io"
	"runtime"
	"testing"
	"time"

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
	if ackMeta.Window != protocol.DefaultWindow || ackMeta.ChunkSize != protocol.DefaultChunkSize {
		t.Fatalf("helloAck credits = %+v", ackMeta)
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

type frameWriter struct {
	frames chan protocol.Frame
}

func (w *frameWriter) Write(data []byte) (int, error) {
	frame, err := protocol.ReadFrame(bytes.NewReader(data))
	if err != nil {
		return 0, err
	}
	w.frames <- frame
	return len(data), nil
}

func newTestDispatcher() (*dispatcher, *frameWriter) {
	writer := &frameWriter{frames: make(chan protocol.Frame, 2048)}
	return newDispatcher(protocol.NewWriter(writer), bridgeSettings{
		window:    12,
		chunkSize: 4,
	}), writer
}

func nextTestFrame(t *testing.T, frames <-chan protocol.Frame) protocol.Frame {
	t.Helper()
	select {
	case frame := <-frames:
		return frame
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for frame")
		return protocol.Frame{}
	}
}

func assertNoTestFrame(t *testing.T, frames <-chan protocol.Frame) {
	t.Helper()
	select {
	case frame := <-frames:
		t.Fatalf("unexpected frame: %+v", frame)
	case <-time.After(20 * time.Millisecond):
	}
}

func TestDebugSleepCancelSendsOneCancelledTerminal(t *testing.T) {
	dispatcher, writer := newTestDispatcher()
	defer dispatcher.stop()

	sleepMeta, err := protocol.EncodeMeta(protocol.DebugSleepMeta{Ms: 1000})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dispatcher.dispatch(protocol.Frame{
		Kind: protocol.KindDebugSleep,
		ID:   1,
		Meta: sleepMeta,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := dispatcher.dispatch(protocol.Frame{
		Kind: protocol.KindCancel,
		ID:   1,
		Meta: []byte(`{}`),
	}); err != nil {
		t.Fatal(err)
	}

	terminal := nextTestFrame(t, writer.frames)
	if terminal.Kind != protocol.KindError || terminal.ID != 1 {
		t.Fatalf("terminal = %+v", terminal)
	}
	var errorMeta protocol.ErrorMeta
	if err := protocol.DecodeObject(terminal.Meta, &errorMeta); err != nil {
		t.Fatal(err)
	}
	if errorMeta.Kind != protocol.ErrorKindCancelled {
		t.Fatalf("error kind = %q, want %q", errorMeta.Kind, protocol.ErrorKindCancelled)
	}
	assertNoTestFrame(t, writer.frames)

	if _, err := dispatcher.dispatch(protocol.Frame{Kind: protocol.KindCancel, ID: 1, Meta: []byte(`{}`)}); err != nil {
		t.Fatal(err)
	}
	if _, err := dispatcher.dispatch(protocol.Frame{Kind: protocol.KindAck, ID: 1, Meta: []byte(`{"bytes":1}`)}); err != nil {
		t.Fatal(err)
	}
	assertNoTestFrame(t, writer.frames)
}

func TestDebugStreamCreditsAndCounters(t *testing.T) {
	dispatcher, writer := newTestDispatcher()
	defer dispatcher.stop()

	streamMeta, err := protocol.EncodeMeta(protocol.DebugStreamMeta{Chunks: 4, Size: 4})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dispatcher.dispatch(protocol.Frame{
		Kind: protocol.KindDebugStream,
		ID:   2,
		Meta: streamMeta,
	}); err != nil {
		t.Fatal(err)
	}

	first := nextTestFrame(t, writer.frames)
	second := nextTestFrame(t, writer.frames)
	third := nextTestFrame(t, writer.frames)
	if first.Kind != protocol.KindChunk || second.Kind != protocol.KindChunk || third.Kind != protocol.KindChunk {
		t.Fatalf("initial frames = %+v, %+v, %+v", first, second, third)
	}
	if !bytes.Equal(first.Body, []byte{0, 1, 2, 3}) || !bytes.Equal(second.Body, []byte{4, 5, 6, 7}) || !bytes.Equal(third.Body, []byte{8, 9, 10, 11}) {
		t.Fatalf("initial bodies = %v, %v, %v", first.Body, second.Body, third.Body)
	}
	assertNoTestFrame(t, writer.frames)

	if _, err := dispatcher.dispatch(protocol.Frame{
		Kind: protocol.KindAck,
		ID:   2,
		Meta: []byte(`{"bytes":4}`),
	}); err != nil {
		t.Fatal(err)
	}
	fourth := nextTestFrame(t, writer.frames)
	end := nextTestFrame(t, writer.frames)
	if fourth.Kind != protocol.KindChunk || !bytes.Equal(fourth.Body, []byte{12, 13, 14, 15}) {
		t.Fatalf("fourth frame = %+v", fourth)
	}
	if end.Kind != protocol.KindEnd || end.ID != 2 {
		t.Fatalf("end frame = %+v", end)
	}
	var endMeta protocol.EndMeta
	if err := protocol.DecodeObject(end.Meta, &endMeta); err != nil {
		t.Fatal(err)
	}
	if endMeta.BytesRead != 16 || endMeta.BytesWritten != 0 {
		t.Fatalf("end metadata = %+v", endMeta)
	}

	if _, err := dispatcher.dispatch(protocol.Frame{Kind: protocol.KindAck, ID: 2, Meta: []byte(`{"bytes":4}`)}); err != nil {
		t.Fatal(err)
	}
	if _, err := dispatcher.dispatch(protocol.Frame{Kind: protocol.KindCancel, ID: 2, Meta: []byte(`{}`)}); err != nil {
		t.Fatal(err)
	}
	assertNoTestFrame(t, writer.frames)
}

func TestConcurrentDebugOperationsKeepTheirIds(t *testing.T) {
	dispatcher, writer := newTestDispatcher()
	for id := uint32(1); id <= 1000; id++ {
		kind := protocol.KindDebugPing
		meta := []byte(`{}`)
		if id%2 == 0 {
			kind = protocol.KindDebugSleep
			var err error
			meta, err = protocol.EncodeMeta(protocol.DebugSleepMeta{Ms: 0})
			if err != nil {
				t.Fatal(err)
			}
		}
		if _, err := dispatcher.dispatch(protocol.Frame{Kind: kind, ID: id, Meta: meta}); err != nil {
			t.Fatal(err)
		}
	}
	defer dispatcher.stop()

	seen := make(map[uint32]bool, 1000)
	for index := 0; index < 1000; index++ {
		frame := nextTestFrame(t, writer.frames)
		if frame.Kind != protocol.KindOk || frame.ID == 0 || seen[frame.ID] {
			t.Fatalf("response %d = %+v", index, frame)
		}
		seen[frame.ID] = true
	}
	if len(seen) != 1000 {
		t.Fatalf("response ids = %d, want 1000", len(seen))
	}
	assertNoTestFrame(t, writer.frames)
}
