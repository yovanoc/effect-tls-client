// Command bridge implements the issue #4 protocol-v1 handshake, lifecycle,
// cancellation, and credited debug operations.
// It speaks frames only on stdout; diagnostics go to stderr.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"

	"github.com/yovanoc/effect-tls-client/bridge/protocol"

	// Keep the upstream dependency pinned in the bridge binary. Later tickets
	// use it for sessions and requests.
	_ "github.com/bogdanfinn/tls-client"
)

const protocolVersion = 1
const tlsClientModule = "github.com/bogdanfinn/tls-client"
const maxSleepMilliseconds = uint64(1<<63-1) / uint64(time.Millisecond)

// version is stamped by release builds with -ldflags -X main.version=.... The
// default matches the scaffold package version so local end-to-end builds can
// complete the handshake without release tooling.
var version = "0.0.0"

type bridgeSettings struct {
	window    uint64
	chunkSize uint64
}

type operation struct {
	id        uint32
	sessionID string
	cancel    context.CancelFunc
	credits   *credits
	upload    *requestUpload
	ws        *webSocketState
	cancelled atomic.Bool
}

type credits struct {
	mu     sync.Mutex
	window uint64
	sent   uint64
	acked  uint64
	wake   chan struct{}
}

func newCredits(window uint64) *credits {
	return &credits{window: window, wake: make(chan struct{})}
}

func (c *credits) ack(bytes uint64) {
	c.mu.Lock()
	outstanding := c.sent - c.acked
	if bytes > outstanding {
		bytes = outstanding
	}
	if bytes != 0 {
		c.acked += bytes
		close(c.wake)
		c.wake = make(chan struct{})
	}
	c.mu.Unlock()
}

func (c *credits) reserve(ctx context.Context, requested uint64) (uint64, bool) {
	for {
		c.mu.Lock()
		outstanding := c.sent - c.acked
		if outstanding < c.window {
			available := c.window - outstanding
			if requested > available {
				requested = available
			}
			c.sent += requested
			c.mu.Unlock()
			return requested, true
		}
		wake := c.wake
		c.mu.Unlock()

		select {
		case <-ctx.Done():
			return 0, false
		case <-wake:
		}
	}
}

func (c *credits) reserveWhole(ctx context.Context, requested uint64) bool {
	for {
		c.mu.Lock()
		outstanding := c.sent - c.acked
		if outstanding <= c.window && requested <= c.window-outstanding {
			c.sent += requested
			c.mu.Unlock()
			return true
		}
		wake := c.wake
		c.mu.Unlock()

		select {
		case <-ctx.Done():
			return false
		case <-wake:
		}
	}
}

type dispatcher struct {
	writer     *protocol.Writer
	settings   bridgeSettings
	sessions   *sessionStore
	mu         sync.Mutex
	operations map[uint32]*operation
	waitGroup  sync.WaitGroup
}

func newDispatcher(writer *protocol.Writer, settings bridgeSettings) *dispatcher {
	return &dispatcher{
		writer:     writer,
		settings:   settings,
		sessions:   newSessionStore(),
		operations: make(map[uint32]*operation),
	}
}

func (d *dispatcher) start(id uint32, credited bool, sessionID string, run func(context.Context, *operation)) error {
	return d.startWithSetup(id, credited, sessionID, nil, run)
}

func (d *dispatcher) startWithSetup(id uint32, credited bool, sessionID string, setup func(context.Context, *operation), run func(context.Context, *operation)) error {
	if id == 0 {
		return fmt.Errorf("operation id 0 is reserved")
	}
	ctx, cancel := context.WithCancel(context.Background())
	op := &operation{id: id, sessionID: sessionID, cancel: cancel}
	if credited {
		op.credits = newCredits(d.settings.window)
	}

	d.mu.Lock()
	if _, exists := d.operations[id]; exists {
		d.mu.Unlock()
		cancel()
		return fmt.Errorf("%w: operation id %d is already active", protocol.ErrProtocol, id)
	}
	d.operations[id] = op
	d.waitGroup.Add(1)
	d.mu.Unlock()

	if setup != nil {
		setup(ctx, op)
	}

	go func() {
		defer d.waitGroup.Done()
		run(ctx, op)
	}()
	return nil
}

func (d *dispatcher) operation(id uint32) *operation {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.operations[id]
}

func (d *dispatcher) ensureAvailable(id uint32) error {
	if d.operation(id) != nil {
		return fmt.Errorf("%w: operation id %d is already active", protocol.ErrProtocol, id)
	}
	return nil
}

func (d *dispatcher) isCurrent(op *operation) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.operations[op.id] == op
}

func (d *dispatcher) remove(op *operation) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.operations[op.id] != op {
		return false
	}
	delete(d.operations, op.id)
	return true
}

func (d *dispatcher) cancel(id uint32) {
	op := d.operation(id)
	if op != nil {
		op.cancelled.Store(true)
		op.stop()
	}
}

func (op *operation) stop() {
	op.cancel()
	if op.ws != nil {
		op.ws.close()
	}
}

func (d *dispatcher) cancelSession(sessionID string) {
	d.mu.Lock()
	operations := make([]*operation, 0)
	for _, op := range d.operations {
		if op.sessionID == sessionID {
			operations = append(operations, op)
		}
	}
	d.mu.Unlock()
	for _, op := range operations {
		op.stop()
	}
}

func (d *dispatcher) cancelAll() {
	d.mu.Lock()
	operations := make([]*operation, 0, len(d.operations))
	for _, op := range d.operations {
		operations = append(operations, op)
	}
	d.mu.Unlock()
	for _, op := range operations {
		op.stop()
	}
}

func (d *dispatcher) stop() {
	d.cancelAll()
	d.waitGroup.Wait()
}

func (d *dispatcher) finish(op *operation, frame protocol.Frame) error {
	if !d.remove(op) {
		return nil
	}
	return d.writer.Write(frame)
}

func (d *dispatcher) finishOK(op *operation) error {
	meta, err := protocol.EncodeMeta(protocol.EmptyMeta{})
	if err != nil {
		return err
	}
	return d.finish(op, protocol.Frame{Kind: protocol.KindOk, ID: op.id, Meta: meta})
}

func (d *dispatcher) finishError(op *operation, kind protocol.ErrorKind, message string) error {
	return d.finishErrorDetail(op, kind, message, nil)
}

func (d *dispatcher) finishErrorDetail(op *operation, kind protocol.ErrorKind, message string, detail map[string]interface{}) error {
	meta, err := protocol.EncodeMeta(protocol.ErrorMeta{Kind: kind, Message: message, Detail: detail})
	if err != nil {
		return err
	}
	return d.finish(op, protocol.Frame{Kind: protocol.KindError, ID: op.id, Meta: meta})
}

func (d *dispatcher) finishCancelled(op *operation) error {
	return d.finishError(op, protocol.ErrorKindCancelled, "operation cancelled")
}

func (d *dispatcher) runSleep(ctx context.Context, op *operation, meta protocol.DebugSleepMeta) {
	timer := time.NewTimer(time.Duration(meta.Ms) * time.Millisecond)
	defer timer.Stop()
	select {
	case <-timer.C:
		_ = d.finishOK(op)
	case <-ctx.Done():
		_ = d.finishCancelled(op)
	}
}

func (d *dispatcher) runStream(ctx context.Context, op *operation, meta protocol.DebugStreamMeta) {
	var total uint64
	for chunk := uint64(0); chunk < meta.Chunks; chunk++ {
		remaining := meta.Size
		for remaining > 0 {
			requested := remaining
			if requested > d.settings.chunkSize {
				requested = d.settings.chunkSize
			}
			size, ok := op.credits.reserve(ctx, requested)
			if !ok || ctx.Err() != nil {
				_ = d.finishCancelled(op)
				return
			}

			body := make([]byte, size)
			for index := range body {
				body[index] = byte(total % 256)
				total++
			}
			if !d.isCurrent(op) {
				return
			}
			if err := d.writer.Write(protocol.Frame{
				Kind: protocol.KindChunk,
				ID:   op.id,
				Meta: []byte(`{}`),
				Body: body,
			}); err != nil {
				d.remove(op)
				return
			}
			remaining -= size
		}
	}

	metaBytes, err := protocol.EncodeMeta(protocol.EndMeta{
		BytesRead:    total,
		BytesWritten: 0,
	})
	if err != nil {
		_ = d.finishError(op, protocol.ErrorKindInternal, err.Error())
		return
	}
	_ = d.finish(op, protocol.Frame{Kind: protocol.KindEnd, ID: op.id, Meta: metaBytes})
}

func main() {
	os.Exit(run(os.Stdin, os.Stdout, os.Stderr))
}

func run(input io.Reader, output io.Writer, diagnostics io.Writer) int {
	first, err := protocol.ReadFrame(input)
	if errors.Is(err, io.EOF) {
		return 0
	}
	if err != nil {
		logProtocolError(diagnostics, err)
		return 2
	}
	hello, err := decodeHello(first)
	if err != nil {
		logProtocolError(diagnostics, err)
		return 2
	}
	settings, err := negotiateHello(hello)
	if err != nil {
		logProtocolError(diagnostics, err)
		return 2
	}

	writer := protocol.NewWriter(output)
	if err := writeHelloAckWithSettings(writer, settings); err != nil {
		fmt.Fprintf(diagnostics, "write helloAck: %v\n", err)
		return 2
	}
	d := newDispatcher(writer, settings)
	defer d.stop()

	for {
		frame, err := protocol.ReadFrame(input)
		if errors.Is(err, io.EOF) {
			return 0
		}
		if err != nil {
			logProtocolError(diagnostics, err)
			return 2
		}

		done, err := d.dispatch(frame)
		if err != nil {
			logProtocolError(diagnostics, err)
			return 2
		}
		if done {
			return 0
		}
	}
}

func decodeHello(frame protocol.Frame) (protocol.HelloMeta, error) {
	if frame.Kind != protocol.KindHello || frame.ID != 0 || len(frame.Body) != 0 {
		return protocol.HelloMeta{}, fmt.Errorf("%w: first frame must be hello with id 0 and no body", protocol.ErrProtocol)
	}
	var meta protocol.HelloMeta
	if err := protocol.DecodeObject(frame.Meta, &meta); err != nil {
		return protocol.HelloMeta{}, err
	}
	if meta.ProtocolVersion != protocolVersion {
		return protocol.HelloMeta{}, fmt.Errorf("%w: unsupported protocol version %d", protocol.ErrProtocol, meta.ProtocolVersion)
	}
	if meta.ClientVersion == "" {
		return protocol.HelloMeta{}, fmt.Errorf("%w: clientVersion is required", protocol.ErrProtocol)
	}
	return meta, nil
}

func negotiateHello(meta protocol.HelloMeta) (bridgeSettings, error) {
	settings := bridgeSettings{window: protocol.DefaultWindow, chunkSize: protocol.DefaultChunkSize}
	if meta.Window != 0 {
		settings.window = meta.Window
	}
	if meta.ChunkSize != 0 {
		settings.chunkSize = meta.ChunkSize
	}
	if settings.chunkSize > uint64(protocol.MaxFrameLen-11) {
		return bridgeSettings{}, fmt.Errorf("%w: chunkSize %d exceeds frame limit", protocol.ErrProtocol, settings.chunkSize)
	}
	return settings, nil
}

func writeHelloAckWithSettings(writer *protocol.Writer, settings bridgeSettings) error {
	meta, err := protocol.EncodeMeta(protocol.HelloAckMeta{
		ProtocolVersion:  protocolVersion,
		BridgeVersion:    version,
		TlsClientVersion: tlsClientVersion(),
		GoVersion:        runtime.Version(),
		Window:           settings.window,
		ChunkSize:        settings.chunkSize,
	})
	if err != nil {
		return err
	}
	return writer.Write(protocol.Frame{Kind: protocol.KindHelloAck, ID: 0, Meta: meta})
}

func (d *dispatcher) dispatch(frame protocol.Frame) (bool, error) {
	switch frame.Kind {
	case protocol.KindDebugPing:
		if frame.ID == 0 {
			return false, writeProtocolError(d.writer, frame.ID, "debug.ping id 0 is reserved")
		}
		if err := d.ensureAvailable(frame.ID); err != nil {
			return false, err
		}
		if err := protocol.DecodeEmpty(frame.Meta); err != nil {
			return false, writeProtocolError(d.writer, frame.ID, err.Error())
		}
		if len(frame.Body) != 0 {
			return false, writeProtocolError(d.writer, frame.ID, "debug.ping does not accept a body")
		}
		if err := d.start(frame.ID, false, "", func(ctx context.Context, op *operation) {
			_ = d.finishOK(op)
		}); err != nil {
			return false, err
		}
		return false, nil

	case protocol.KindDebugSleep:
		if frame.ID == 0 {
			return false, writeProtocolError(d.writer, frame.ID, "debug.sleep id 0 is reserved")
		}
		if err := d.ensureAvailable(frame.ID); err != nil {
			return false, err
		}
		if len(frame.Body) != 0 {
			return false, writeProtocolError(d.writer, frame.ID, "debug.sleep does not accept a body")
		}
		var meta protocol.DebugSleepMeta
		if err := protocol.DecodeObject(frame.Meta, &meta); err != nil {
			return false, writeProtocolError(d.writer, frame.ID, err.Error())
		}
		if meta.Ms > maxSleepMilliseconds {
			return false, writeProtocolError(d.writer, frame.ID, "debug.sleep ms is too large")
		}
		if err := d.start(frame.ID, false, "", func(ctx context.Context, op *operation) {
			d.runSleep(ctx, op, meta)
		}); err != nil {
			return false, err
		}
		return false, nil

	case protocol.KindDebugStream:
		if frame.ID == 0 {
			return false, writeProtocolError(d.writer, frame.ID, "debug.stream id 0 is reserved")
		}
		if err := d.ensureAvailable(frame.ID); err != nil {
			return false, err
		}
		if len(frame.Body) != 0 {
			return false, writeProtocolError(d.writer, frame.ID, "debug.stream does not accept a body")
		}
		var meta protocol.DebugStreamMeta
		if err := protocol.DecodeObject(frame.Meta, &meta); err != nil {
			return false, writeProtocolError(d.writer, frame.ID, err.Error())
		}
		if meta.Size != 0 && meta.Chunks > ^uint64(0)/meta.Size {
			return false, writeProtocolError(d.writer, frame.ID, "debug.stream byte count overflows")
		}
		if err := d.start(frame.ID, true, "", func(ctx context.Context, op *operation) {
			d.runStream(ctx, op, meta)
		}); err != nil {
			return false, err
		}
		return false, nil

	case protocol.KindSessionCreate:
		if frame.ID == 0 {
			return false, writeProtocolError(d.writer, frame.ID, "session.create id 0 is reserved")
		}
		if err := d.ensureAvailable(frame.ID); err != nil {
			return false, err
		}
		if len(frame.Body) != 0 {
			return false, writeProtocolError(d.writer, frame.ID, "session.create does not accept a body")
		}
		var meta protocol.SessionConfigMeta
		if err := protocol.DecodeObject(frame.Meta, &meta); err != nil {
			return false, writeProtocolError(d.writer, frame.ID, err.Error())
		}
		if err := d.start(frame.ID, false, meta.SessionID, func(ctx context.Context, op *operation) {
			d.runSessionCreate(ctx, op, meta)
		}); err != nil {
			return false, err
		}
		return false, nil

	case protocol.KindSessionDestroy:
		if frame.ID == 0 {
			return false, writeProtocolError(d.writer, frame.ID, "session.destroy id 0 is reserved")
		}
		if err := d.ensureAvailable(frame.ID); err != nil {
			return false, err
		}
		if len(frame.Body) != 0 {
			return false, writeProtocolError(d.writer, frame.ID, "session.destroy does not accept a body")
		}
		var meta protocol.SessionIDMeta
		if err := protocol.DecodeObject(frame.Meta, &meta); err != nil {
			return false, writeProtocolError(d.writer, frame.ID, err.Error())
		}
		if meta.SessionID == "" {
			return false, writeProtocolError(d.writer, frame.ID, "sessionId is required")
		}
		if err := d.start(frame.ID, false, meta.SessionID, func(ctx context.Context, op *operation) {
			d.runSessionDestroy(ctx, op, meta)
		}); err != nil {
			return false, err
		}
		return false, nil

	case protocol.KindSessionProxy:
		if frame.ID == 0 {
			return false, writeProtocolError(d.writer, frame.ID, "session.proxy id 0 is reserved")
		}
		if err := d.ensureAvailable(frame.ID); err != nil {
			return false, err
		}
		if len(frame.Body) != 0 {
			return false, writeProtocolError(d.writer, frame.ID, "session.proxy does not accept a body")
		}
		var meta protocol.SessionProxyMeta
		if err := protocol.DecodeObject(frame.Meta, &meta); err != nil {
			return false, writeProtocolError(d.writer, frame.ID, err.Error())
		}
		if meta.SessionID == "" {
			return false, writeProtocolError(d.writer, frame.ID, "sessionId is required")
		}
		if err := d.start(frame.ID, false, meta.SessionID, func(ctx context.Context, op *operation) {
			d.runSessionProxy(ctx, op, meta)
		}); err != nil {
			return false, err
		}
		return false, nil

	case protocol.KindCookiesGet:
		if frame.ID == 0 {
			return false, writeProtocolError(d.writer, frame.ID, "cookies.get id 0 is reserved")
		}
		if err := d.ensureAvailable(frame.ID); err != nil {
			return false, err
		}
		if len(frame.Body) != 0 {
			return false, writeProtocolError(d.writer, frame.ID, "cookies.get does not accept a body")
		}
		var meta protocol.CookiesGetMeta
		if err := protocol.DecodeObject(frame.Meta, &meta); err != nil {
			return false, writeProtocolError(d.writer, frame.ID, err.Error())
		}
		if meta.SessionID == "" || meta.URL == "" {
			return false, writeProtocolError(d.writer, frame.ID, "sessionId and url are required")
		}
		if err := d.start(frame.ID, false, meta.SessionID, func(ctx context.Context, op *operation) {
			d.runCookiesGet(ctx, op, meta)
		}); err != nil {
			return false, err
		}
		return false, nil

	case protocol.KindCookiesSet:
		if frame.ID == 0 {
			return false, writeProtocolError(d.writer, frame.ID, "cookies.set id 0 is reserved")
		}
		if err := d.ensureAvailable(frame.ID); err != nil {
			return false, err
		}
		if len(frame.Body) != 0 {
			return false, writeProtocolError(d.writer, frame.ID, "cookies.set does not accept a body")
		}
		var meta protocol.CookiesSetMeta
		if err := protocol.DecodeObject(frame.Meta, &meta); err != nil {
			return false, writeProtocolError(d.writer, frame.ID, err.Error())
		}
		if meta.SessionID == "" || meta.URL == "" {
			return false, writeProtocolError(d.writer, frame.ID, "sessionId and url are required")
		}
		if err := d.start(frame.ID, false, meta.SessionID, func(ctx context.Context, op *operation) {
			d.runCookiesSet(ctx, op, meta)
		}); err != nil {
			return false, err
		}
		return false, nil

	case protocol.KindCookiesExport:
		if frame.ID == 0 {
			return false, writeProtocolError(d.writer, frame.ID, "cookies.export id 0 is reserved")
		}
		if err := d.ensureAvailable(frame.ID); err != nil {
			return false, err
		}
		if len(frame.Body) != 0 {
			return false, writeProtocolError(d.writer, frame.ID, "cookies.export does not accept a body")
		}
		var meta protocol.CookiesExportMeta
		if err := protocol.DecodeObject(frame.Meta, &meta); err != nil {
			return false, writeProtocolError(d.writer, frame.ID, err.Error())
		}
		if meta.SessionID == "" {
			return false, writeProtocolError(d.writer, frame.ID, "sessionId is required")
		}
		if err := d.start(frame.ID, false, meta.SessionID, func(ctx context.Context, op *operation) {
			d.runCookiesExport(ctx, op, meta)
		}); err != nil {
			return false, err
		}
		return false, nil

	case protocol.KindCookiesImport:
		if frame.ID == 0 {
			return false, writeProtocolError(d.writer, frame.ID, "cookies.import id 0 is reserved")
		}
		if err := d.ensureAvailable(frame.ID); err != nil {
			return false, err
		}
		if len(frame.Body) != 0 {
			return false, writeProtocolError(d.writer, frame.ID, "cookies.import does not accept a body")
		}
		var meta protocol.CookiesImportMeta
		if err := protocol.DecodeObject(frame.Meta, &meta); err != nil {
			return false, writeProtocolError(d.writer, frame.ID, err.Error())
		}
		if meta.SessionID == "" {
			return false, writeProtocolError(d.writer, frame.ID, "sessionId is required")
		}
		if err := d.start(frame.ID, false, meta.SessionID, func(ctx context.Context, op *operation) {
			d.runCookiesImport(ctx, op, meta)
		}); err != nil {
			return false, err
		}
		return false, nil

	case protocol.KindRequest:
		if frame.ID == 0 {
			return false, writeProtocolError(d.writer, frame.ID, "request id 0 is reserved")
		}
		if err := d.ensureAvailable(frame.ID); err != nil {
			return false, err
		}
		if len(frame.Body) != 0 {
			return false, writeProtocolError(d.writer, frame.ID, "request does not accept a body")
		}
		var meta protocol.RequestMeta
		if err := protocol.DecodeObject(frame.Meta, &meta); err != nil {
			return false, writeProtocolError(d.writer, frame.ID, err.Error())
		}
		if (meta.SessionID == "") == (meta.Config == nil) {
			return false, writeProtocolError(d.writer, frame.ID, "exactly one of sessionId or config is required")
		}
		setup := func(ctx context.Context, op *operation) {
			if !meta.HasBody {
				return
			}
			op.upload = newRequestUpload(ctx, d.writer, op.id, d.settings.window, d.settings.chunkSize)
		}
		if err := d.startWithSetup(frame.ID, true, meta.SessionID, setup, func(ctx context.Context, op *operation) {
			d.runRequest(ctx, op, meta)
		}); err != nil {
			return false, err
		}
		return false, nil

	case protocol.KindBodyChunk:
		if frame.ID == 0 {
			return false, writeProtocolError(d.writer, frame.ID, "body.chunk id 0 is reserved")
		}
		op := d.operation(frame.ID)
		if op == nil {
			return false, nil
		}
		if len(frame.Body) == 0 {
			return false, fmt.Errorf("%w: body.chunk cannot be empty", protocol.ErrProtocol)
		}
		if err := protocol.DecodeEmpty(frame.Meta); err != nil {
			return false, err
		}
		if op.upload == nil {
			return false, fmt.Errorf("%w: body.chunk is not valid for this operation", protocol.ErrProtocol)
		}
		if err := op.upload.accept(frame.Body); err != nil {
			return false, err
		}
		return false, nil

	case protocol.KindBodyEnd:
		if frame.ID == 0 {
			return false, writeProtocolError(d.writer, frame.ID, "body.end id 0 is reserved")
		}
		op := d.operation(frame.ID)
		if op == nil {
			return false, nil
		}
		if err := protocol.DecodeEmpty(frame.Meta); err != nil {
			return false, err
		}
		if len(frame.Body) != 0 {
			return false, fmt.Errorf("%w: body.end does not accept a body", protocol.ErrProtocol)
		}
		if op.upload == nil {
			return false, fmt.Errorf("%w: body.end is not valid for this operation", protocol.ErrProtocol)
		}
		if err := op.upload.end(); err != nil {
			return false, err
		}
		return false, nil

	case protocol.KindWSConnect, protocol.KindWSWrite, protocol.KindWSClose:
		return d.dispatchWebSocket(frame)

	case protocol.KindCancel:
		if frame.ID == 0 {
			return false, writeProtocolError(d.writer, frame.ID, "cancel id 0 is reserved")
		}
		if d.operation(frame.ID) == nil {
			return false, nil
		}
		if err := protocol.DecodeEmpty(frame.Meta); err != nil {
			return false, err
		}
		if len(frame.Body) != 0 {
			return false, fmt.Errorf("%w: cancel does not accept a body", protocol.ErrProtocol)
		}
		d.cancel(frame.ID)
		return false, nil

	case protocol.KindAck:
		if frame.ID == 0 {
			return false, writeProtocolError(d.writer, frame.ID, "ack id 0 is reserved")
		}
		op := d.operation(frame.ID)
		if op == nil {
			return false, nil
		}
		if len(frame.Body) != 0 {
			return false, fmt.Errorf("%w: ack does not accept a body", protocol.ErrProtocol)
		}
		var meta protocol.AckMeta
		if err := protocol.DecodeObject(frame.Meta, &meta); err != nil {
			return false, err
		}
		if op.credits != nil {
			op.credits.ack(meta.Bytes)
		}
		return false, nil

	case protocol.KindShutdown:
		if frame.ID != 0 {
			return false, writeProtocolError(d.writer, frame.ID, "shutdown id must be 0")
		}
		if err := protocol.DecodeEmpty(frame.Meta); err != nil {
			return false, writeProtocolError(d.writer, frame.ID, err.Error())
		}
		if len(frame.Body) != 0 {
			return false, writeProtocolError(d.writer, frame.ID, "shutdown does not accept a body")
		}
		d.stop()
		d.sessions.closeAll()
		return true, writeEmptyResponse(d.writer, protocol.KindOk, 0)

	case protocol.KindHello:
		return false, writeProtocolError(d.writer, frame.ID, "hello was already completed")
	case protocol.KindHelloAck, protocol.KindOk, protocol.KindError:
		return false, writeProtocolError(d.writer, frame.ID, "frame kind is not valid from the client")
	default:
		return false, writeProtocolError(d.writer, frame.ID, fmt.Sprintf("frame kind 0x%02x is not implemented", byte(frame.Kind)))
	}
}

func writeEmptyResponse(writer *protocol.Writer, kind protocol.Kind, id uint32) error {
	meta, err := protocol.EncodeMeta(protocol.EmptyMeta{})
	if err != nil {
		return err
	}
	return writer.Write(protocol.Frame{Kind: kind, ID: id, Meta: meta})
}

func writeProtocolError(writer *protocol.Writer, id uint32, message string) error {
	meta, err := protocol.EncodeMeta(protocol.ErrorMeta{
		Kind:    protocol.ErrorKindProtocol,
		Message: message,
	})
	if err != nil {
		return err
	}
	return writer.Write(protocol.Frame{Kind: protocol.KindError, ID: id, Meta: meta})
}

func logProtocolError(diagnostics io.Writer, err error) {
	fmt.Fprintf(diagnostics, "protocol error: %v\n", err)
}

func tlsClientVersion() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "unknown"
	}
	for _, dependency := range info.Deps {
		if dependency.Path != tlsClientModule {
			continue
		}
		if dependency.Replace != nil {
			return dependency.Replace.Version
		}
		return dependency.Version
	}
	return "unknown"
}

func versionString() string {
	return "effect-tls-client-bridge " + version
}
