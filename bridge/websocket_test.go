package main

import (
	"context"
	"testing"
	"time"

	http "github.com/bogdanfinn/fhttp"
	"github.com/bogdanfinn/websocket"

	"github.com/yovanoc/effect-tls-client/bridge/protocol"
)

func TestWebSocketHeadersMergeIdentityAndRequest(t *testing.T) {
	headers, err := websocketHeaders(
		protocol.IdentityMeta{
			Headers:     []protocol.HeaderPair{{"X-Identity", "yes"}, {"User-Agent", "identity"}},
			HeaderOrder: []string{"x-identity", "user-agent"},
		},
		protocol.WSConnectMeta{
			Headers:     []protocol.HeaderPair{{"User-Agent", "request"}, {"X-Request", "yes"}},
			HeaderOrder: []string{"x-request", "user-agent"},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if got := headers.Get("X-Identity"); got != "yes" {
		t.Fatalf("identity header = %q", got)
	}
	if got := headers.Get("User-Agent"); got != "request" {
		t.Fatalf("overridden header = %q", got)
	}
	if got := headers.Get("X-Request"); got != "yes" {
		t.Fatalf("request header = %q", got)
	}
	if got := headers[http.HeaderOrderKey]; len(got) < 2 || got[0] != "x-request" || got[1] != "user-agent" {
		t.Fatalf("header order = %#v", got)
	}
}

func TestCreditsReserveWholeDoesNotPartiallyReserve(t *testing.T) {
	credits := newCredits(4)
	if !credits.reserveWhole(context.Background(), 4) {
		t.Fatal("initial reservation failed")
	}
	result := make(chan bool, 1)
	go func() { result <- credits.reserveWhole(context.Background(), 2) }()
	select {
	case <-result:
		t.Fatal("reservation completed before an acknowledgement")
	case <-time.After(10 * time.Millisecond):
	}
	credits.ack(4)
	select {
	case ok := <-result:
		if !ok {
			t.Fatal("reservation failed after acknowledgement")
		}
	case <-time.After(time.Second):
		t.Fatal("reservation did not resume")
	}
}

func TestWebSocketStateWritesAndCloses(t *testing.T) {
	state := &webSocketState{}
	if err := state.writeMessage(websocket.TextMessage, []byte("hello")); err == nil {
		t.Fatal("expected a write on an unconnected state to fail")
	}
	if err := state.writeClose(websocket.CloseNormalClosure, ""); err == nil {
		t.Fatal("expected a close on an unconnected state to fail")
	}
}
