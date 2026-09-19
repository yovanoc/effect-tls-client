package main

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sync"
	"time"

	http "github.com/bogdanfinn/fhttp"
	"github.com/bogdanfinn/websocket"

	"github.com/yovanoc/effect-tls-client/bridge/protocol"
)

const websocketWriteWait = time.Second

type webSocketState struct {
	mu   sync.Mutex
	conn *websocket.Conn
}

func (s *webSocketState) set(conn *websocket.Conn) {
	s.mu.Lock()
	s.conn = conn
	s.mu.Unlock()
}

func (s *webSocketState) writeMessage(opcode int, body []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn == nil {
		return errors.New("websocket connection is closed")
	}
	return s.conn.WriteMessage(opcode, body)
}

func (s *webSocketState) writeClose(code int, reason string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn == nil {
		return errors.New("websocket connection is closed")
	}
	return s.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), time.Now().Add(websocketWriteWait))
}

func (s *webSocketState) close() {
	s.mu.Lock()
	conn := s.conn
	s.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
}

func (d *dispatcher) dispatchWebSocket(frame protocol.Frame) (bool, error) {
	switch frame.Kind {
	case protocol.KindWSConnect:
		if frame.ID == 0 {
			return false, writeProtocolError(d.writer, frame.ID, "ws.connect id 0 is reserved")
		}
		if err := d.ensureAvailable(frame.ID); err != nil {
			return false, err
		}
		if len(frame.Body) != 0 {
			return false, writeProtocolError(d.writer, frame.ID, "ws.connect does not accept a body")
		}
		var meta protocol.WSConnectMeta
		if err := protocol.DecodeObject(frame.Meta, &meta); err != nil {
			return false, writeProtocolError(d.writer, frame.ID, err.Error())
		}
		if meta.SessionID == "" || meta.URL == "" {
			return false, writeProtocolError(d.writer, frame.ID, "sessionId and url are required")
		}
		if err := validateHeaderPairs(meta.Headers); err != nil {
			return false, writeProtocolError(d.writer, frame.ID, err.Error())
		}
		if err := validateHeaderOrder(meta.HeaderOrder); err != nil {
			return false, writeProtocolError(d.writer, frame.ID, err.Error())
		}
		if err := d.start(frame.ID, true, meta.SessionID, func(ctx context.Context, op *operation) {
			op.ws = &webSocketState{}
			d.runWebSocket(ctx, op, meta)
		}); err != nil {
			return false, err
		}
		return false, nil

	case protocol.KindWSWrite:
		op := d.operation(frame.ID)
		if op == nil {
			return false, nil
		}
		if len(frame.Body) > protocol.MaxFrameLen-18 {
			return false, fmt.Errorf("%w: ws.write body is too large", protocol.ErrProtocol)
		}
		var meta protocol.WSWriteMeta
		if err := protocol.DecodeObject(frame.Meta, &meta); err != nil {
			return false, err
		}
		if meta.Opcode != websocket.TextMessage && meta.Opcode != websocket.BinaryMessage {
			return false, fmt.Errorf("%w: ws.write opcode must be text or binary", protocol.ErrProtocol)
		}
		if op.ws == nil {
			return false, fmt.Errorf("%w: ws.write received before ws.open", protocol.ErrProtocol)
		}
		if err := op.ws.writeMessage(meta.Opcode, frame.Body); err != nil {
			_ = d.finishError(op, protocol.ErrorKindWsWrite, err.Error())
			op.stop()
		}
		return false, nil

	case protocol.KindWSClose:
		op := d.operation(frame.ID)
		if op == nil {
			return false, nil
		}
		if len(frame.Body) != 0 {
			return false, fmt.Errorf("%w: ws.close does not accept a body", protocol.ErrProtocol)
		}
		var meta protocol.WSCloseMeta
		if err := protocol.DecodeObject(frame.Meta, &meta); err != nil {
			return false, err
		}
		if op.ws == nil {
			return false, fmt.Errorf("%w: ws.close received before ws.open", protocol.ErrProtocol)
		}
		code := websocket.CloseNormalClosure
		if meta.Code != nil {
			code = *meta.Code
		}
		reason := ""
		if meta.Reason != nil {
			reason = *meta.Reason
		}
		if err := op.ws.writeClose(code, reason); err != nil {
			op.stop()
			_ = d.finishError(op, protocol.ErrorKindWsWrite, err.Error())
			return false, nil
		}
		_ = d.finishWebSocketClosed(op, code, reason, "local")
		op.stop()
		return false, nil
	}
	return false, fmt.Errorf("%w: unsupported WebSocket frame 0x%02x", protocol.ErrProtocol, byte(frame.Kind))
}

func (d *dispatcher) runWebSocket(ctx context.Context, op *operation, meta protocol.WSConnectMeta) {
	fail := func(kind protocol.ErrorKind, message string) {
		op.stop()
		_ = d.finishError(op, kind, message)
	}

	session, ok := d.sessions.get(meta.SessionID)
	if !ok {
		fail(protocol.ErrorKindSessionNotFound, fmt.Sprintf("session %q was not found", meta.SessionID))
		return
	}

	handshakeContext := ctx
	cancel := func() {}
	handshakeTimeout := session.timeoutMs
	if meta.HandshakeTimeoutMs != nil {
		if *meta.HandshakeTimeoutMs > uint64(math.MaxInt64/int64(time.Millisecond)) {
			fail(protocol.ErrorKindWsHandshake, "handshakeTimeoutMs is outside the supported range")
			return
		}
		handshakeTimeout = int64(*meta.HandshakeTimeoutMs)
	}
	if handshakeTimeout > 0 {
		if handshakeTimeout > math.MaxInt64/int64(time.Millisecond) {
			fail(protocol.ErrorKindWsHandshake, "handshakeTimeoutMs is outside the supported range")
			return
		}
		handshakeContext, cancel = context.WithTimeout(ctx, time.Duration(handshakeTimeout)*time.Millisecond)
	}
	defer cancel()

	releaseProxy, err := session.proxyGate.acquireRead(handshakeContext)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			fail(protocol.ErrorKindCancelled, "operation cancelled")
		} else {
			fail(protocol.ErrorKindWsHandshake, err.Error())
		}
		return
	}
	conn, response, err := session.dialWebSocket(handshakeContext, meta)
	releaseProxy()
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		if handshakeContext.Err() != nil {
			fail(classifyWebSocketContextError(handshakeContext), err.Error())
		} else {
			message := err.Error()
			if response != nil {
				message = fmt.Sprintf("WebSocket handshake returned HTTP status %d: %s", response.StatusCode, message)
			}
			fail(protocol.ErrorKindWsHandshake, message)
		}
		return
	}
	if conn == nil || response == nil {
		fail(protocol.ErrorKindWsHandshake, "WebSocket handshake returned no connection")
		return
	}
	op.ws.set(conn)
	if handshakeContext.Err() != nil {
		op.stop()
		_ = d.finishError(op, protocol.ErrorKindCancelled, "operation cancelled")
		return
	}

	openMeta, err := protocol.EncodeMeta(protocol.WSOpenMeta{
		Status:  response.StatusCode,
		Headers: responseHeaders(response),
	})
	if err != nil {
		fail(protocol.ErrorKindInternal, err.Error())
		return
	}
	if !d.isCurrent(op) {
		op.stop()
		return
	}
	if err := d.writer.Write(protocol.Frame{Kind: protocol.KindWSOpen, ID: op.id, Meta: openMeta}); err != nil {
		op.stop()
		d.remove(op)
		return
	}

	watchDone := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			op.ws.close()
		case <-watchDone:
		}
	}()
	defer close(watchDone)
	defer op.ws.close()

	for {
		opcode, body, readErr := conn.ReadMessage()
		if readErr != nil {
			if ctx.Err() != nil {
				if op.cancelled.Load() {
					_ = d.finishCancelled(op)
				} else {
					_ = d.finishWebSocketClosed(op, websocket.CloseNormalClosure, "", "local")
				}
				return
			}
			var closeErr *websocket.CloseError
			if errors.As(readErr, &closeErr) {
				_ = d.finishWebSocketClosed(op, closeErr.Code, closeErr.Text, "remote")
				return
			}
			_ = d.finishError(op, protocol.ErrorKindWsRead, readErr.Error())
			return
		}
		if opcode != websocket.TextMessage && opcode != websocket.BinaryMessage {
			continue
		}
		if uint64(len(body)) > d.settings.window {
			_ = d.finishError(op, protocol.ErrorKindWsRead, "WebSocket message exceeds the credit window")
			return
		}
		if len(body) > 0 {
			if !op.credits.reserveWhole(ctx, uint64(len(body))) {
				if op.cancelled.Load() {
					_ = d.finishCancelled(op)
				} else {
					_ = d.finishWebSocketClosed(op, websocket.CloseNormalClosure, "", "local")
				}
				return
			}
		}
		if !d.isCurrent(op) {
			return
		}
		frameMeta, encodeErr := protocol.EncodeMeta(protocol.WSFrameMeta{Opcode: opcode})
		if encodeErr != nil {
			_ = d.finishError(op, protocol.ErrorKindInternal, encodeErr.Error())
			return
		}
		if err := d.writer.Write(protocol.Frame{Kind: protocol.KindWSFrame, ID: op.id, Meta: frameMeta, Body: body}); err != nil {
			d.remove(op)
			return
		}
	}
}

func classifyWebSocketContextError(ctx context.Context) protocol.ErrorKind {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return protocol.ErrorKindWsHandshake
	}
	return protocol.ErrorKindCancelled
}

func (d *dispatcher) finishWebSocketClosed(op *operation, code int, reason, initiator string) error {
	if code == 0 {
		code = websocket.CloseNormalClosure
	}
	meta, err := protocol.EncodeMeta(protocol.WSClosedMeta{
		Code:      code,
		Reason:    reason,
		Initiator: initiator,
	})
	if err != nil {
		return d.finishError(op, protocol.ErrorKindInternal, err.Error())
	}
	return d.finish(op, protocol.Frame{Kind: protocol.KindWSClosed, ID: op.id, Meta: meta})
}

func (s *tlsSession) dialWebSocket(ctx context.Context, meta protocol.WSConnectMeta) (*websocket.Conn, *http.Response, error) {
	headers, err := websocketHeaders(s.identity, meta)
	if err != nil {
		return nil, nil, err
	}

	dialer := &websocket.Dialer{
		HandshakeTimeout:  websocketHandshakeTimeout(meta, s.timeoutMs),
		Jar:               s.wsClient.GetCookieJar(),
		NetDialContext:    s.wsClient.GetDialer().DialContext,
		NetDialTLSContext: s.wsClient.GetTLSDialer(),
		Subprotocols:      append([]string(nil), meta.Subprotocols...),
	}
	if meta.ReadBufferSize != nil {
		if *meta.ReadBufferSize > uint64(maxInt()) {
			return nil, nil, errors.New("readBufferSize is outside the supported range")
		}
		dialer.ReadBufferSize = int(*meta.ReadBufferSize)
	}
	if meta.WriteBufferSize != nil {
		if *meta.WriteBufferSize > uint64(maxInt()) {
			return nil, nil, errors.New("writeBufferSize is outside the supported range")
		}
		dialer.WriteBufferSize = int(*meta.WriteBufferSize)
	}
	return dialer.DialContext(ctx, meta.URL, headers)
}

func websocketHandshakeTimeout(meta protocol.WSConnectMeta, sessionTimeoutMs int64) time.Duration {
	if meta.HandshakeTimeoutMs != nil {
		if *meta.HandshakeTimeoutMs == 0 {
			return 0
		}
		return time.Duration(*meta.HandshakeTimeoutMs) * time.Millisecond
	}
	if sessionTimeoutMs <= 0 {
		return 0
	}
	return time.Duration(sessionTimeoutMs) * time.Millisecond
}

func websocketHeaders(identity protocol.IdentityMeta, meta protocol.WSConnectMeta) (http.Header, error) {
	merged, err := mergeHeaderPairs(identity.Headers, meta.Headers)
	if err != nil {
		return nil, err
	}
	if err := validateHeaderOrder(identity.HeaderOrder); err != nil {
		return nil, err
	}
	if err := validateHeaderOrder(meta.HeaderOrder); err != nil {
		return nil, err
	}
	headers := make(http.Header, len(merged)+1)
	for _, pair := range merged {
		key := http.CanonicalHeaderKey(pair[0])
		headers[key] = append(headers[key], pair[1])
	}
	order := meta.HeaderOrder
	if order == nil {
		order = identity.HeaderOrder
	}
	order = completeHeaderOrder(order, append(append([]protocol.HeaderPair(nil), merged...),
		protocol.HeaderPair{"Upgrade", "websocket"},
		protocol.HeaderPair{"Connection", "Upgrade"},
		protocol.HeaderPair{"Sec-WebSocket-Key", ""},
		protocol.HeaderPair{"Sec-WebSocket-Version", "13"},
	))
	if len(order) > 0 {
		headers[http.HeaderOrderKey] = lowerHeaderOrder(order)
	}
	return headers, nil
}

func maxInt() int {
	return int(^uint(0) >> 1)
}
