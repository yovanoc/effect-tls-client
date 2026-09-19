package main

import (
	"context"
	"errors"
	"io"
	"net"
	nethttp "net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	http "github.com/bogdanfinn/fhttp"
	"github.com/yovanoc/effect-tls-client/bridge/protocol"
)

func TestValidateSessionConfig(t *testing.T) {
	profile := "chrome_146"
	tests := []struct {
		name   string
		config protocol.SessionConfigMeta
	}{
		{name: "missing profile", config: protocol.SessionConfigMeta{SessionID: "s"}},
		{name: "both profile forms", config: protocol.SessionConfigMeta{
			SessionID: "s", Profile: &profile, CustomProfile: &protocol.CustomProfileMeta{Ja3String: "771"},
		}},
		{name: "unknown profile", config: protocol.SessionConfigMeta{
			SessionID: "s", Profile: stringPointer("not-a-profile"),
		}},
		{name: "both address families disabled", config: protocol.SessionConfigMeta{
			SessionID: "s", Profile: &profile, DisableIPv4: true, DisableIPv6: true,
		}},
		{name: "pins with insecure verify", config: protocol.SessionConfigMeta{
			SessionID: "s", Profile: &profile, InsecureSkipVerify: true,
			CertificatePins: map[string][]string{"example.com": {"sha256/abc"}},
		}},
		{name: "racing conflicts with http1", config: protocol.SessionConfigMeta{
			SessionID: "s", Profile: &profile, ProtocolRacing: true, ForceHTTP1: true,
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := validateSessionConfig(test.config); err == nil {
				t.Fatal("validateSessionConfig() returned nil")
			}
		})
	}
}

func TestRequestHeadersPreserveOrderAndOverrideIdentity(t *testing.T) {
	headers, err := requestHeaders(
		protocol.IdentityMeta{
			Headers:     []protocol.HeaderPair{{"X-Identity", "identity"}, {"X-Replace", "identity"}},
			HeaderOrder: []string{"x-identity", "x-replace"},
		},
		protocol.RequestMeta{
			Headers:     []protocol.HeaderPair{{"X-Replace", "request"}, {"X-Request", "request"}},
			HeaderOrder: []string{"x-request", "x-replace"},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if got := headers.Get("X-Replace"); got != "request" {
		t.Fatalf("X-Replace = %q, want request", got)
	}
	wantOrder := []string{"x-request", "x-replace", "x-identity"}
	if got := headers[http.HeaderOrderKey]; !slicesEqual(got, wantOrder) {
		t.Fatalf("header order = %#v, want %#v", got, wantOrder)
	}
}

func TestClassifyProxyErrors(t *testing.T) {
	err := &net.OpError{Op: "proxyconnect", Err: errors.New("connection refused")}
	if got := classifyRequestError(err); got != protocol.ErrorKindProxy {
		t.Fatalf("classifyRequestError() = %q, want %q", got, protocol.ErrorKindProxy)
	}

	socksErr := &net.OpError{Op: "socks connect", Err: errors.New("connection refused")}
	if got := classifyRequestError(socksErr); got != protocol.ErrorKindProxy {
		t.Fatalf("classifyRequestError() = %q, want %q", got, protocol.ErrorKindProxy)
	}
}

func TestClassifyErrorMessageDoesNotImplyProxy(t *testing.T) {
	if got := classifyRequestError(errors.New("proxy connection refused")); got != protocol.ErrorKindUnknown {
		t.Fatalf("classifyRequestError() = %q, want %q", got, protocol.ErrorKindUnknown)
	}

	dialErr := &net.OpError{Op: "dial", Err: errors.New("SOCKS server refused the connection")}
	if got := classifyRequestError(dialErr); got != protocol.ErrorKindConnect {
		t.Fatalf("classifyRequestError() = %q, want %q", got, protocol.ErrorKindConnect)
	}
}

func TestRequestHeadersKeepRepeatedRequestValues(t *testing.T) {
	headers, err := requestHeaders(
		protocol.IdentityMeta{Headers: []protocol.HeaderPair{{"X-Token", "identity"}}},
		protocol.RequestMeta{Headers: []protocol.HeaderPair{{"X-Token", "one"}, {"X-Token", "two"}}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if got := headers.Values("X-Token"); !slicesEqual(got, []string{"one", "two"}) {
		t.Fatalf("X-Token values = %#v, want [one two]", got)
	}
}

func TestResponseHeadersKeepWireOrder(t *testing.T) {
	response := &http.Response{Header: http.Header{
		http.HeaderOrderKey: {"set-cookie", "x-first"},
		"Set-Cookie":        {"a=1"},
		"X-First":           {"one"},
		"X-Last":            {"last"},
	}}
	got := responseHeaders(response)
	want := []protocol.HeaderPair{{"Set-Cookie", "a=1"}, {"X-First", "one"}, {"X-Last", "last"}}
	if len(got) != len(want) {
		t.Fatalf("headers = %#v, want %#v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("headers = %#v, want %#v", got, want)
		}
	}
}

func TestBuildSessionWithKnownProfile(t *testing.T) {
	session, err := buildSession(protocol.SessionConfigMeta{
		SessionID: "session",
		Profile:   stringPointer("chrome_146"),
	})
	if err != nil {
		t.Fatal(err)
	}
	session.closeIdleConnections()
}

func TestTrackedRequestsSerializeSnapshotsPerClient(t *testing.T) {
	session, err := buildSession(protocol.SessionConfigMeta{
		SessionID: "bandwidth-gate",
		Profile:   stringPointer("chrome_146"),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer session.closeIdleConnections()

	_, _, releaseFirst, err := session.beginTrackedRequest(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	acquired := make(chan struct{})
	secondDone := make(chan error, 1)
	go func() {
		_, _, releaseSecond, secondErr := session.beginTrackedRequest(context.Background(), nil)
		if secondErr == nil {
			close(acquired)
			releaseSecond()
		}
		secondDone <- secondErr
	}()

	select {
	case <-acquired:
		t.Fatal("second request acquired the same bandwidth tracker before the first ended")
	case <-time.After(20 * time.Millisecond):
	}
	releaseFirst()
	select {
	case secondErr := <-secondDone:
		if secondErr != nil {
			t.Fatal(secondErr)
		}
	case <-time.After(time.Second):
		t.Fatal("second request did not acquire the bandwidth tracker")
	}
}

func TestIntegrationLocalHTTP1(t *testing.T) {
	if os.Getenv("TLS_CLIENT_INTEGRATION") != "1" {
		t.Skip("set TLS_CLIENT_INTEGRATION=1 to run local tls-client integration tests")
	}
	server := httptest.NewServer(nethttp.HandlerFunc(func(writer nethttp.ResponseWriter, request *nethttp.Request) {
		writer.Header().Set("Set-Cookie", "integration=one; Path=/")
		_, _ = writer.Write([]byte("http/1.1"))
	}))
	defer server.Close()

	session, err := buildSession(protocol.SessionConfigMeta{
		SessionID:  "http1",
		Profile:    stringPointer("chrome_146"),
		ForceHTTP1: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer session.closeIdleConnections()
	request, err := http.NewRequest("GET", server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := session.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "http/1.1" || response.Proto != "HTTP/1.1" {
		t.Fatalf("response = %q over %s", body, response.Proto)
	}
}

func TestIntegrationLocalTLSHTTP2(t *testing.T) {
	if os.Getenv("TLS_CLIENT_INTEGRATION") != "1" {
		t.Skip("set TLS_CLIENT_INTEGRATION=1 to run local tls-client integration tests")
	}
	server := httptest.NewUnstartedServer(nethttp.HandlerFunc(func(writer nethttp.ResponseWriter, request *nethttp.Request) {
		_, _ = writer.Write([]byte("https/2"))
	}))
	server.EnableHTTP2 = true
	server.StartTLS()
	defer server.Close()

	session, err := buildSession(protocol.SessionConfigMeta{
		SessionID:          "http2",
		Profile:            stringPointer("chrome_146"),
		InsecureSkipVerify: true,
		DisableHTTP3:       true,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer session.closeIdleConnections()
	request, err := http.NewRequest("GET", server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	bandwidthBefore := snapshotBandwidth(session.client)
	response, err := session.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "https/2" || response.Proto != "HTTP/2.0" {
		t.Fatalf("response = %q over %s", body, response.Proto)
	}
	bandwidthAfter := snapshotBandwidth(session.client)
	readDelta := bandwidthDelta(bandwidthBefore.read, bandwidthAfter.read)
	writeDelta := bandwidthDelta(bandwidthBefore.written, bandwidthAfter.written)
	if readDelta == 0 || writeDelta == 0 {
		t.Fatalf("bandwidth delta = read %d, write %d, want nonzero values", readDelta, writeDelta)
	}
	if readDelta < uint64(len(body)) {
		t.Fatalf("tracked read bytes = %d, want at least body length %d", readDelta, len(body))
	}
}

func TestIntegrationRedirectOverridesDoNotSerializeRequests(t *testing.T) {
	if os.Getenv("TLS_CLIENT_INTEGRATION") != "1" {
		t.Skip("set TLS_CLIENT_INTEGRATION=1 to run local tls-client integration tests")
	}

	slowStarted := make(chan struct{})
	releaseSlow := make(chan struct{})
	var releaseOnce sync.Once
	server := httptest.NewServer(nethttp.HandlerFunc(func(writer nethttp.ResponseWriter, request *nethttp.Request) {
		switch request.URL.Path {
		case "/redirect":
			nethttp.Redirect(writer, request, "/slow", nethttp.StatusFound)
		case "/slow":
			close(slowStarted)
			<-releaseSlow
			_, _ = writer.Write([]byte("slow"))
		case "/fast":
			_, _ = writer.Write([]byte("fast"))
		}
	}))
	defer func() {
		releaseOnce.Do(func() { close(releaseSlow) })
		server.Close()
	}()

	session, err := buildSession(protocol.SessionConfigMeta{
		SessionID:       "redirect-concurrency",
		Profile:         stringPointer("chrome_146"),
		ForceHTTP1:      true,
		FollowRedirects: boolPointer(false),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer session.closeIdleConnections()

	slowRequest, err := http.NewRequest("GET", server.URL+"/redirect", nil)
	if err != nil {
		t.Fatal(err)
	}
	slowDone := make(chan error, 1)
	go func() {
		follow := true
		response, _, _, requestErr := session.do(slowRequest, &follow)
		if response != nil {
			_ = response.Body.Close()
		}
		slowDone <- requestErr
	}()
	<-slowStarted

	fastRequest, err := http.NewRequest("GET", server.URL+"/fast", nil)
	if err != nil {
		t.Fatal(err)
	}
	fastDone := make(chan error, 1)
	go func() {
		follow := false
		response, _, _, requestErr := session.do(fastRequest, &follow)
		if response != nil {
			_ = response.Body.Close()
		}
		fastDone <- requestErr
	}()

	select {
	case requestErr := <-fastDone:
		if requestErr != nil {
			t.Fatal(requestErr)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("request with the session default redirect policy was serialized behind another request")
	}

	releaseOnce.Do(func() { close(releaseSlow) })
	if requestErr := <-slowDone; requestErr != nil {
		t.Fatal(requestErr)
	}
}

func boolPointer(value bool) *bool {
	return &value
}

func stringPointer(value string) *string {
	return &value
}

func slicesEqual(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if !strings.EqualFold(left[index], right[index]) {
			return false
		}
	}
	return true
}
