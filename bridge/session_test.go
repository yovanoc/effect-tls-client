package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	nethttp "net/http"
	"net/http/httptest"
	"net/url"
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

func TestRequestHeadersOmitCredentials(t *testing.T) {
	headers, err := requestHeaders(
		protocol.IdentityMeta{Headers: []protocol.HeaderPair{
			{"Authorization", "identity-token"},
			{"Proxy-Authorization", "proxy-token"},
			{"Cookie", "identity-cookie"},
			{"X-Identity", "identity"},
		}},
		protocol.RequestMeta{
			OmitCredentials: true,
			Headers: []protocol.HeaderPair{
				{"Authorization", "request-token"},
				{"Cookie", "request-cookie"},
				{"X-Request", "request"},
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"Authorization", "Proxy-Authorization", "Cookie"} {
		if hasHeader(headers, name) {
			t.Errorf("credential header %q was not omitted", name)
		}
	}
	if headers.Get("X-Identity") != "identity" || headers.Get("X-Request") != "request" {
		t.Fatalf("non-credential headers were not preserved: %#v", headers)
	}
}

func TestCookieJarOmitsCredentialsInBothDirections(t *testing.T) {
	jar, err := newSessionCookieJar(false)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse("https://example.test/path")
	if err != nil {
		t.Fatal(err)
	}
	jar.storeCookies(u, []*http.Cookie{{Name: "session", Value: "kept", Path: "/"}})
	jar.beginCredentialOmission()
	if got := jar.Cookies(u); len(got) != 0 {
		t.Fatalf("outbound cookies = %#v, want none", got)
	}
	jar.SetCookies(u, []*http.Cookie{{Name: "response", Value: "ignored", Path: "/"}})
	jar.endCredentialOmission()
	if got := jar.cookiesFor(u); len(got) != 1 || got[0].Name != "session" {
		t.Fatalf("stored cookies = %#v, want only the pre-existing session cookie", got)
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

func TestResponseHeadersUseDeterministicRepresentationOrder(t *testing.T) {
	response := &http.Response{Header: http.Header{
		"Set-Cookie": {"a=1"},
		"X-First":    {"one"},
		"X-Last":     {"last"},
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

func TestRequestUploadStreamsThroughPipeAndAcksConsumedBytes(t *testing.T) {
	dispatcher, writer := newTestDispatcher()
	defer dispatcher.stop()

	upload := newRequestUpload(context.Background(), dispatcher.writer, 7, 12, 4)
	readDone := make(chan []byte, 1)
	go func() {
		body, err := io.ReadAll(upload.reader)
		if err != nil {
			t.Errorf("read upload: %v", err)
		}
		readDone <- body
	}()
	if err := upload.accept([]byte{1, 2, 3, 4}); err != nil {
		t.Fatal(err)
	}
	if err := upload.accept([]byte{5, 6}); err != nil {
		t.Fatal(err)
	}
	if err := upload.end(); err != nil {
		t.Fatal(err)
	}

	body := <-readDone
	upload.close()
	if !bytes.Equal(body, []byte{1, 2, 3, 4, 5, 6}) {
		t.Fatalf("uploaded body = %v", body)
	}
	firstAck := nextTestFrame(t, writer.frames)
	secondAck := nextTestFrame(t, writer.frames)
	for index, frame := range []protocol.Frame{firstAck, secondAck} {
		if frame.Kind != protocol.KindBodyAck || frame.ID != 7 {
			t.Fatalf("ack %d = %+v", index, frame)
		}
		var meta protocol.AckMeta
		if err := protocol.DecodeObject(frame.Meta, &meta); err != nil {
			t.Fatal(err)
		}
		if meta.Bytes == 0 {
			t.Fatalf("ack %d was empty", index)
		}
	}
	assertNoTestFrame(t, writer.frames)
}

func TestRequestUploadAcceptsManySmallChunksWithinByteWindow(t *testing.T) {
	dispatcher, _ := newTestDispatcher()
	defer dispatcher.stop()

	const (
		chunkCount = 100
		chunkSize  = 1024
	)
	upload := newRequestUpload(context.Background(), dispatcher.writer, 8, chunkCount*chunkSize, 64*1024)
	defer upload.close()
	for index := 0; index < chunkCount; index++ {
		if err := upload.accept(make([]byte, chunkSize)); err != nil {
			t.Fatalf("small upload chunk %d: %v", index, err)
		}
	}
}

func TestRequestUploadCloseWakesIdlePump(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dispatcher, _ := newTestDispatcher()
	defer dispatcher.stop()

	upload := newRequestUpload(ctx, dispatcher.writer, 9, 12, 4)
	closed := make(chan struct{})
	go func() {
		upload.close()
		close(closed)
	}()
	select {
	case <-closed:
	case <-time.After(time.Second):
		cancel()
		<-closed
		t.Fatal("upload.close did not wake an idle pump")
	}
}

func TestRequestUploadRejectsBytesBeyondWindow(t *testing.T) {
	dispatcher, _ := newTestDispatcher()
	defer dispatcher.stop()

	upload := newRequestUpload(context.Background(), dispatcher.writer, 8, 4, 4)
	if err := upload.accept([]byte{1, 2, 3, 4}); err != nil {
		t.Fatal(err)
	}
	if err := upload.accept([]byte{5}); !errors.Is(err, protocol.ErrProtocol) {
		t.Fatalf("second upload chunk error = %v, want protocol violation", err)
	}
	upload.close()
}

func TestRequestUploadAbortClosesPipeWithExplicitError(t *testing.T) {
	dispatcher, _ := newTestDispatcher()
	defer dispatcher.stop()

	upload := newRequestUpload(context.Background(), dispatcher.writer, 10, 12, 4)
	readErr := make(chan error, 1)
	go func() {
		_, err := io.ReadAll(upload.reader)
		readErr <- err
	}()
	upload.abortIfIncomplete(errUploadResponse)
	upload.wait()
	if err := <-readErr; !errors.Is(err, errUploadResponse) {
		t.Fatalf("upload read error = %v, want %v", err, errUploadResponse)
	}
}

func TestRequestFailureClosesIdleUploadAndEmitsTerminal(t *testing.T) {
	dispatcher, writer := newTestDispatcher()
	defer dispatcher.stop()

	meta, err := protocol.EncodeMeta(protocol.RequestMeta{
		SessionID: "missing",
		URL:       "http://example.test/",
		Method:    "POST",
		HasBody:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dispatcher.dispatch(protocol.Frame{
		Kind: protocol.KindRequest,
		ID:   11,
		Meta: meta,
	}); err != nil {
		t.Fatal(err)
	}
	terminal := nextTestFrame(t, writer.frames)
	if terminal.Kind != protocol.KindError || terminal.ID != 11 {
		t.Fatalf("terminal = %+v", terminal)
	}
	var errorMeta protocol.ErrorMeta
	if err := protocol.DecodeObject(terminal.Meta, &errorMeta); err != nil {
		t.Fatal(err)
	}
	if errorMeta.Kind != protocol.ErrorKindSessionNotFound {
		t.Fatalf("error kind = %q, want %q", errorMeta.Kind, protocol.ErrorKindSessionNotFound)
	}
}

func TestIntegrationSessionlessRequestDoesNotRetainSession(t *testing.T) {
	if os.Getenv("TLS_CLIENT_INTEGRATION") != "1" {
		t.Skip("set TLS_CLIENT_INTEGRATION=1 to run local tls-client integration tests")
	}
	server := httptest.NewServer(nethttp.HandlerFunc(func(writer nethttp.ResponseWriter, request *nethttp.Request) {
		_, _ = writer.Write([]byte("ok"))
	}))
	defer server.Close()

	dispatcher, writer := newTestDispatcher()
	defer dispatcher.stop()
	profile := "chrome_146"
	meta, err := protocol.EncodeMeta(protocol.RequestMeta{
		Config:  &protocol.SessionConfigMeta{Profile: &profile, ForceHTTP1: true},
		URL:     server.URL,
		Method:  "GET",
		HasBody: false,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dispatcher.dispatch(protocol.Frame{Kind: protocol.KindRequest, ID: 12, Meta: meta}); err != nil {
		t.Fatal(err)
	}
	for {
		if frame := nextTestFrame(t, writer.frames); frame.Kind == protocol.KindEnd {
			break
		}
	}
	if _, retained := dispatcher.sessions.sessions["request-12"]; retained {
		t.Fatal("sessionless request retained its ephemeral session")
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
		client, _, release, requestErr := session.beginTrackedRequest(context.Background(), &follow)
		if requestErr != nil {
			slowDone <- requestErr
			return
		}
		defer release()
		response, requestErr := client.Do(slowRequest)
		if response != nil {
			_, bodyErr := io.ReadAll(response.Body)
			closeErr := response.Body.Close()
			if requestErr == nil {
				requestErr = bodyErr
			}
			if requestErr == nil {
				requestErr = closeErr
			}
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
		client, _, release, requestErr := session.beginTrackedRequest(context.Background(), &follow)
		if requestErr != nil {
			fastDone <- requestErr
			return
		}
		defer release()
		response, requestErr := client.Do(fastRequest)
		if response != nil {
			_, bodyErr := io.ReadAll(response.Body)
			closeErr := response.Body.Close()
			if requestErr == nil {
				requestErr = bodyErr
			}
			if requestErr == nil {
				requestErr = closeErr
			}
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

type localProxy struct {
	listener net.Listener
	scheme   string
	hits     chan struct{}
}

func startLocalProxy(t *testing.T, scheme string) *localProxy {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	proxy := &localProxy{
		listener: listener,
		scheme:   scheme,
		hits:     make(chan struct{}, 16),
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			connection, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			go proxy.handle(connection)
		}
	}()
	return proxy
}

func (p *localProxy) URL() string {
	return p.scheme + "://" + p.listener.Addr().String()
}

func (p *localProxy) handle(connection net.Conn) {
	defer connection.Close()
	select {
	case p.hits <- struct{}{}:
	default:
	}
	if p.scheme == "socks5" {
		p.handleSocks5(connection)
		return
	}
	p.handleConnect(connection)
}

func (p *localProxy) handleConnect(connection net.Conn) {
	reader := bufio.NewReader(connection)
	line, err := reader.ReadString('\n')
	if err != nil {
		return
	}
	fields := strings.Fields(line)
	if len(fields) < 2 || fields[0] != "CONNECT" {
		return
	}
	for {
		line, err = reader.ReadString('\n')
		if err != nil {
			return
		}
		if strings.TrimSpace(line) == "" {
			break
		}
	}
	target, err := net.Dial("tcp", fields[1])
	if err != nil {
		_, _ = io.WriteString(connection, "HTTP/1.1 502 Bad Gateway\r\n\r\n")
		return
	}
	defer target.Close()
	if _, err := io.WriteString(connection, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}
	proxyConnections(connection, target)
}

func (p *localProxy) handleSocks5(connection net.Conn) {
	var greeting [2]byte
	if _, err := io.ReadFull(connection, greeting[:]); err != nil || greeting[0] != 5 {
		return
	}
	methods := make([]byte, int(greeting[1]))
	if _, err := io.ReadFull(connection, methods); err != nil {
		return
	}
	if _, err := connection.Write([]byte{5, 0}); err != nil {
		return
	}
	var header [4]byte
	if _, err := io.ReadFull(connection, header[:]); err != nil || header[0] != 5 || header[1] != 1 {
		return
	}
	var host string
	switch header[3] {
	case 1:
		address := make([]byte, net.IPv4len)
		if _, err := io.ReadFull(connection, address); err != nil {
			return
		}
		host = net.IP(address).String()
	case 3:
		var length [1]byte
		if _, err := io.ReadFull(connection, length[:]); err != nil {
			return
		}
		address := make([]byte, int(length[0]))
		if _, err := io.ReadFull(connection, address); err != nil {
			return
		}
		host = string(address)
	case 4:
		address := make([]byte, net.IPv6len)
		if _, err := io.ReadFull(connection, address); err != nil {
			return
		}
		host = net.IP(address).String()
	default:
		return
	}
	var portBytes [2]byte
	if _, err := io.ReadFull(connection, portBytes[:]); err != nil {
		return
	}
	target, err := net.Dial("tcp", net.JoinHostPort(host, stringPort(binary.BigEndian.Uint16(portBytes[:]))))
	if err != nil {
		_, _ = connection.Write([]byte{5, 5, 0, 1, 0, 0, 0, 0, 0, 0})
		return
	}
	defer target.Close()
	if _, err := connection.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0}); err != nil {
		return
	}
	proxyConnections(connection, target)
}

func stringPort(port uint16) string {
	if port < 10 {
		return string([]byte{'0' + byte(port)})
	}
	return fmt.Sprintf("%d", port)
}

func proxyConnections(left, right net.Conn) {
	copyDone := make(chan struct{})
	go func() {
		_, _ = io.Copy(right, left)
		close(copyDone)
	}()
	_, _ = io.Copy(left, right)
	<-copyDone
}

func TestRunCookiesGetBypassesAutomaticCookieSuppression(t *testing.T) {
	profile := "chrome_146"
	session, err := buildSession(protocol.SessionConfigMeta{SessionID: "cookies-get", Profile: &profile})
	if err != nil {
		t.Fatal(err)
	}
	defer session.closeIdleConnections()

	dispatcher, writer := newTestDispatcher()
	defer dispatcher.stop()
	if err := dispatcher.sessions.add(session); err != nil {
		t.Fatal(err)
	}
	cookieURL, err := url.Parse("https://example.com/account")
	if err != nil {
		t.Fatal(err)
	}
	session.client.SetCookies(cookieURL, []*http.Cookie{{Name: "session", Value: "one", Path: "/"}})
	jar, ok := session.client.GetCookieJar().(*sessionCookieJar)
	if !ok {
		t.Fatal("session does not use a session cookie jar")
	}
	jar.skipAutomaticCookies()
	defer jar.clearAutomaticCookieSkip()
	if got := jar.Cookies(cookieURL); len(got) != 0 {
		t.Fatalf("automatic cookies = %#v, want suppressed cookies", got)
	}

	meta := protocol.CookiesGetMeta{SessionID: session.id, URL: cookieURL.String()}
	if err := dispatcher.start(1, false, session.id, func(ctx context.Context, op *operation) {
		dispatcher.runCookiesGet(ctx, op, meta)
	}); err != nil {
		t.Fatal(err)
	}
	frame := nextTestFrame(t, writer.frames)
	if frame.Kind != protocol.KindOk || frame.ID != 1 {
		t.Fatalf("cookies.get result = %+v", frame)
	}
	var result protocol.CookiesResultMeta
	if err := protocol.DecodeObject(frame.Meta, &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Cookies) != 1 || result.Cookies[0].Name != "session" || result.Cookies[0].Value != "one" {
		t.Fatalf("cookies.get result = %#v, want session=one", result.Cookies)
	}
}

func TestSessionCookieJarUsesRFCStateForExportAndExpiry(t *testing.T) {
	jar, err := newSessionCookieJar(false)
	if err != nil {
		t.Fatal(err)
	}
	cookieURL, err := url.Parse("https://sub.example.com/account")
	if err != nil {
		t.Fatal(err)
	}
	jar.SetCookies(cookieURL, []*http.Cookie{
		{Name: "host", Value: "one", Path: "/"},
		{Name: "cross", Value: "bad", Domain: "other.example", Path: "/"},
		{Name: "public", Value: "bad", Domain: "com", Path: "/"},
		{Name: "invalid", Value: "bad", Domain: ".", Path: "/"},
	})

	exported := jar.GetAllCookies()
	entries := exported["sub.example.com"]
	if len(entries) != 1 || entries[0].Name != "host" || entries[0].Domain != "" {
		t.Fatalf("exported cookies = %#v", exported)
	}
	if len(exported["other.example"]) != 0 {
		t.Fatalf("cross-domain cookie was exported: %#v", exported)
	}

	jar.SetCookies(cookieURL, []*http.Cookie{{
		Name: "max-age", Value: "one", Path: "/", MaxAge: 60,
	}})
	selected := jar.Cookies(cookieURL)
	var maxAgeCookie *http.Cookie
	for _, cookie := range selected {
		if cookie.Name == "max-age" {
			maxAgeCookie = cookie
		}
	}
	if maxAgeCookie == nil {
		t.Fatal("Max-Age cookie was not selected")
	}
	if maxAgeCookie.MaxAge != 0 || maxAgeCookie.Expires.Before(time.Now().Add(50*time.Second)) {
		t.Fatalf("Max-Age cookie = %#v, want absolute expiry", maxAgeCookie)
	}

	jar.SetCookies(cookieURL, []*http.Cookie{{
		Name: "expired", Value: "gone", Path: "/", MaxAge: 1,
	}})
	time.Sleep(1100 * time.Millisecond)
	for _, cookie := range jar.Cookies(cookieURL) {
		if cookie.Name == "expired" {
			t.Fatalf("expired cookie was selected: %#v", cookie)
		}
	}
	for _, entries := range jar.GetAllCookies() {
		for _, cookie := range entries {
			if cookie.Name == "expired" {
				t.Fatalf("expired cookie was exported: %#v", cookie)
			}
		}
	}
}

func TestSessionCookieJarScriptCookiesProtectsHttpOnlyTuples(t *testing.T) {
	jar, err := newSessionCookieJar(false)
	if err != nil {
		t.Fatal(err)
	}
	privateURL, err := url.Parse("https://example.test/private/page")
	if err != nil {
		t.Fatal(err)
	}
	rootURL, err := url.Parse("https://example.test/")
	if err != nil {
		t.Fatal(err)
	}
	jar.SetCookies(privateURL, []*http.Cookie{
		{Name: "protected", Value: "hidden", Path: "/private", HttpOnly: true},
		{Name: "visible", Value: "one", Path: "/"},
	})
	if got := jar.scriptCookieHeader(privateURL, nil); got != "visible=one" {
		t.Fatalf("script cookie read = %q, want visible=one", got)
	}

	got := jar.scriptCookieHeader(privateURL, []string{
		"protected=overwritten; Path=/private",
		"protected=allowed; Path=/",
		"script-only=hidden; Path=/; HttpOnly",
	})
	if strings.Contains(got, "protected=hidden") || strings.Contains(got, "protected=overwritten") {
		t.Fatalf("script cookie header = %q, want HttpOnly hidden and overwrite values filtered", got)
	}
	if !strings.Contains(got, "protected=allowed") {
		t.Fatalf("script cookie header = %q, want same-name different-path cookie", got)
	}
	if root := jar.scriptCookieHeader(rootURL, nil); !strings.Contains(root, "protected=allowed") {
		t.Fatalf("root script cookie header = %q, want path-scoped script cookie", root)
	}
	var protected, allowed bool
	for _, cookie := range jar.cookiesFor(privateURL) {
		if cookie.Name == "protected" && cookie.Path == "/private" {
			protected = cookie.Value == "hidden" && cookie.HttpOnly
		}
		if cookie.Name == "protected" && cookie.Path == "/" {
			allowed = cookie.Value == "allowed" && !cookie.HttpOnly
		}
		if cookie.Name == "script-only" {
			t.Fatalf("script created an HttpOnly cookie: %#v", cookie)
		}
	}
	if !protected || !allowed {
		t.Fatalf("protected cookies after script write: protected=%t allowed=%t", protected, allowed)
	}
}

func TestSessionCookieJarScriptCookiesHonorsSecureAndDomainRules(t *testing.T) {
	jar, err := newSessionCookieJar(false)
	if err != nil {
		t.Fatal(err)
	}
	secureURL, err := url.Parse("https://example.test/private/page")
	if err != nil {
		t.Fatal(err)
	}
	httpURL, err := url.Parse("http://example.test/private/page")
	if err != nil {
		t.Fatal(err)
	}
	subdomainURL, err := url.Parse("https://sub.example.test/private/page")
	if err != nil {
		t.Fatal(err)
	}
	jar.SetCookies(secureURL, []*http.Cookie{
		{Name: "secure-protected", Value: "hidden", Path: "/private", Secure: true, HttpOnly: true},
		{Name: "domain-protected", Value: "hidden", Domain: "example.test", Path: "/private", HttpOnly: true},
	})

	jar.scriptCookieHeader(httpURL, []string{
		"secure-protected=overwritten; Path=/private",
		"new-secure=ignored; Path=/; Secure",
	})
	secure := jar.cookiesFor(secureURL)
	for _, cookie := range secure {
		if cookie.Name == "secure-protected" && cookie.Value != "hidden" {
			t.Fatalf("secure HttpOnly cookie was overwritten: %#v", cookie)
		}
		if cookie.Name == "new-secure" {
			t.Fatalf("secure cookie was created from an HTTP script origin: %#v", cookie)
		}
	}

	jar.scriptCookieHeader(subdomainURL, []string{
		"domain-protected=overwritten; Domain=example.test; Path=/private",
	})
	for _, cookie := range jar.cookiesFor(secureURL) {
		if cookie.Name == "domain-protected" && cookie.Value != "hidden" {
			t.Fatalf("domain HttpOnly cookie was overwritten: %#v", cookie)
		}
	}
}

func TestSessionCookieJarScriptCookiesCanonicalizesTrailingDotAndIDNA(t *testing.T) {
	jar, err := newSessionCookieJar(false)
	if err != nil {
		t.Fatal(err)
	}
	canonicalURL, err := url.Parse("https://example.test/")
	if err != nil {
		t.Fatal(err)
	}
	trailingDotURL, err := url.Parse("https://example.test./")
	if err != nil {
		t.Fatal(err)
	}
	jar.SetCookies(canonicalURL, []*http.Cookie{{
		Name: "secret", Value: "hidden", Path: "/", HttpOnly: true,
	}})
	if got := jar.scriptCookieHeader(trailingDotURL, []string{"secret=overwritten; Path=/"}); got != "" {
		t.Fatalf("trailing-dot script cookie header = %q, want empty", got)
	}
	cookies := jar.cookiesFor(canonicalURL)
	if len(cookies) != 1 || cookies[0].Name != "secret" || cookies[0].Value != "hidden" || !cookies[0].HttpOnly {
		t.Fatalf("trailing-dot write changed protected cookie: %#v", cookies)
	}

	idnaURL, err := url.Parse("https://bücher.example.test/")
	if err != nil {
		t.Fatal(err)
	}
	asciiIDNAURL, err := url.Parse("https://xn--bcher-kva.example.test./")
	if err != nil {
		t.Fatal(err)
	}
	jar.SetCookies(idnaURL, []*http.Cookie{{
		Name: "idna-secret", Value: "hidden", Path: "/", HttpOnly: true,
	}})
	if got := jar.scriptCookieHeader(asciiIDNAURL, []string{"idna-secret=overwritten; Path=/"}); got != "" {
		t.Fatalf("IDNA script cookie header = %q, want empty", got)
	}
	cookies = jar.cookiesFor(idnaURL)
	var found bool
	for _, cookie := range cookies {
		if cookie.Name == "idna-secret" {
			found = cookie.Value == "hidden" && cookie.HttpOnly
		}
	}
	if !found {
		t.Fatalf("IDNA write changed protected cookie: %#v", cookies)
	}
}

func TestSessionCookieJarScriptCookiesDoesNotOverlaySecureFromHTTP(t *testing.T) {
	jar, err := newSessionCookieJar(false)
	if err != nil {
		t.Fatal(err)
	}
	httpsURL, err := url.Parse("https://example.test/private/page")
	if err != nil {
		t.Fatal(err)
	}
	httpURL, err := url.Parse("http://example.test/private/page")
	if err != nil {
		t.Fatal(err)
	}
	jar.SetCookies(httpsURL, []*http.Cookie{{
		Name: "secure", Value: "hidden", Path: "/private", Secure: true,
	}})
	if got := jar.scriptCookieHeader(httpURL, []string{"secure=overwritten; Path=/private"}); got != "" {
		t.Fatalf("HTTP script cookie header = %q, want empty", got)
	}
	if got := jar.scriptCookieHeader(httpsURL, nil); got != "secure=hidden" {
		t.Fatalf("secure cookie after HTTP script write = %q, want secure=hidden", got)
	}

	// A different path is a different cookie tuple and remains writable.
	if got := jar.scriptCookieHeader(httpURL, []string{"secure=shadow; Path=/"}); got != "secure=shadow" {
		t.Fatalf("HTTP script cookie header for different path = %q, want secure=shadow", got)
	}
	if got := jar.scriptCookieHeader(httpsURL, nil); got != "secure=hidden; secure=shadow" {
		t.Fatalf("HTTPS script cookie header after different-path write = %q, want both cookies", got)
	}
	if got := jar.scriptCookieHeader(httpsURL, []string{"secure=updated; Path=/private; Secure"}); got != "secure=updated; secure=shadow" {
		t.Fatalf("HTTPS script cookie header after Secure write = %q, want updated Secure cookie", got)
	}
}

func TestSessionCookieJarScriptCookiesBlocksOverlappingSecureCookies(t *testing.T) {
	tests := []struct {
		name         string
		secureURL    string
		scriptURL    string
		probeURL     string
		secureDomain string
		securePath   string
		write        string
		want         string
	}{
		{
			name:       "narrower path",
			secureURL:  "https://example.test/private/page",
			scriptURL:  "http://example.test/private/page",
			probeURL:   "https://example.test/private/nested/page",
			securePath: "/private",
			write:      "token=shadow; Path=/private/nested",
			want:       "token=trusted",
		},
		{
			name:         "secure parent domain and child host-only cookie",
			secureURL:    "https://example.test/private/page",
			scriptURL:    "http://sub.example.test/private/page",
			probeURL:     "https://sub.example.test/private/page",
			secureDomain: "example.test",
			securePath:   "/private",
			write:        "token=shadow; Path=/private",
			want:         "token=trusted",
		},
		{
			name:       "secure child host-only and parent domain cookie",
			secureURL:  "https://sub.example.test/private/page",
			scriptURL:  "http://sub.example.test/private/page",
			probeURL:   "https://sub.example.test/private/page",
			securePath: "/private",
			write:      "token=shadow; Domain=example.test; Path=/private",
			want:       "token=trusted",
		},
		{
			name:       "non-overlapping path",
			secureURL:  "https://example.test/private/page",
			scriptURL:  "http://example.test/private/page",
			probeURL:   "https://example.test/privateish/page",
			securePath: "/private",
			write:      "token=shadow; Path=/privateish",
			want:       "token=shadow",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			jar, err := newSessionCookieJar(false)
			if err != nil {
				t.Fatal(err)
			}
			secureURL, err := url.Parse(test.secureURL)
			if err != nil {
				t.Fatal(err)
			}
			jar.SetCookies(secureURL, []*http.Cookie{{
				Name: "token", Value: "trusted", Domain: test.secureDomain,
				Path: test.securePath, Secure: true,
			}})
			scriptURL, err := url.Parse(test.scriptURL)
			if err != nil {
				t.Fatal(err)
			}
			jar.scriptCookieHeader(scriptURL, []string{test.write})
			probeURL, err := url.Parse(test.probeURL)
			if err != nil {
				t.Fatal(err)
			}
			if got := jar.scriptCookieHeader(probeURL, nil); got != test.want {
				t.Fatalf("HTTPS cookie header = %q, want %q", got, test.want)
			}
		})
	}
}

func TestSessionCookieJarScriptCookiesSerializesWithHTTPWrites(t *testing.T) {
	server := httptest.NewServer(nethttp.HandlerFunc(func(writer nethttp.ResponseWriter, request *nethttp.Request) {
		writer.Header().Set("Set-Cookie", "protected=server; Path=/private; HttpOnly")
		_, _ = writer.Write([]byte("ok"))
	}))
	defer server.Close()

	profile := "chrome_146"
	session, err := buildSession(protocol.SessionConfigMeta{
		SessionID:  "script-cookie-concurrency",
		Profile:    &profile,
		ForceHTTP1: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer session.closeIdleConnections()
	cookieURL, err := url.Parse(server.URL + "/private/page")
	if err != nil {
		t.Fatal(err)
	}
	session.client.SetCookies(cookieURL, []*http.Cookie{{
		Name: "protected", Value: "initial", Path: "/private", HttpOnly: true,
	}})
	jar, ok := session.client.GetCookieJar().(*sessionCookieJar)
	if !ok {
		t.Fatal("session does not use a session cookie jar")
	}

	const iterations = 32
	errorsFound := make(chan error, iterations)
	var wait sync.WaitGroup
	for index := 0; index < iterations; index++ {
		wait.Add(2)
		go func() {
			defer wait.Done()
			request, requestErr := http.NewRequest("GET", server.URL+"/set", nil)
			if requestErr != nil {
				errorsFound <- requestErr
				return
			}
			response, requestErr := session.client.Do(request)
			if requestErr != nil {
				errorsFound <- requestErr
				return
			}
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
		}()
		go func() {
			defer wait.Done()
			jar.scriptCookieHeader(cookieURL, []string{"protected=script; Path=/private"})
		}()
	}
	wait.Wait()
	close(errorsFound)
	for requestErr := range errorsFound {
		t.Fatal(requestErr)
	}
	for _, cookie := range jar.cookiesFor(cookieURL) {
		if cookie.Name == "protected" {
			if cookie.Value != "server" || !cookie.HttpOnly {
				t.Fatalf("concurrent script write changed protected cookie: %#v", cookie)
			}
			return
		}
	}
	t.Fatal("protected cookie was lost during concurrent HTTP writes")
}

func TestSessionProxyWaitIsCancellable(t *testing.T) {
	profile := "chrome_146"
	session, err := buildSession(protocol.SessionConfigMeta{SessionID: "proxy-cancel", Profile: &profile})
	if err != nil {
		t.Fatal(err)
	}
	defer session.closeIdleConnections()

	release, err := session.proxyGate.acquireRead(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	proxyDone := make(chan error, 1)
	go func() {
		proxyDone <- session.setProxy(ctx, "http://127.0.0.1:1")
	}()
	cancel()
	select {
	case proxyErr := <-proxyDone:
		if !errors.Is(proxyErr, context.Canceled) {
			t.Fatalf("setProxy() error = %v, want context.Canceled", proxyErr)
		}
	case <-time.After(time.Second):
		t.Fatal("setProxy() did not observe cancellation while waiting for a request")
	}
	release()
}

func TestValidateProxyURL(t *testing.T) {
	for _, scheme := range []string{"http", "https", "socks4", "socks5"} {
		if err := validateProxyURL(scheme + "://127.0.0.1:8080"); err != nil {
			t.Fatalf("%s proxy rejected: %v", scheme, err)
		}
	}
	for _, proxyURL := range []string{"ftp://127.0.0.1:8080", "http://", "not a url"} {
		if err := validateProxyURL(proxyURL); err == nil {
			t.Fatalf("invalid proxy %q was accepted", proxyURL)
		}
	}
}

func TestIntegrationCookiesRedirectExportImportAndStrictJar(t *testing.T) {
	if os.Getenv("TLS_CLIENT_INTEGRATION") != "1" {
		t.Skip("set TLS_CLIENT_INTEGRATION=1 to run local tls-client integration tests")
	}
	server := httptest.NewServer(nethttp.HandlerFunc(func(writer nethttp.ResponseWriter, request *nethttp.Request) {
		switch request.URL.Path {
		case "/set":
			writer.Header().Add("Set-Cookie", "jar=one; Path=/; Expires=Wed, 01 Jan 2030 00:00:00 GMT; HttpOnly; SameSite=Strict")
			_, _ = writer.Write([]byte("set"))
		case "/redirect-start":
			writer.Header().Add("Set-Cookie", "redirect=one; Path=/")
			nethttp.Redirect(writer, request, "/redirect-final", nethttp.StatusFound)
		case "/redirect-final", "/echo":
			_, _ = writer.Write([]byte(request.Header.Get("Cookie")))
		case "/empty":
			writer.Header().Add("Set-Cookie", "empty=; Path=/")
			_, _ = writer.Write([]byte("empty"))
		}
	}))
	defer server.Close()

	profile := "chrome_146"
	session, err := buildSession(protocol.SessionConfigMeta{
		SessionID:       "cookies",
		Profile:         &profile,
		ForceHTTP1:      true,
		FollowRedirects: boolPointer(true),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer session.closeIdleConnections()
	request, err := http.NewRequest("GET", server.URL+"/set", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := session.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()

	parsed, _ := url.Parse(server.URL + "/echo")
	cookies := session.client.GetCookies(parsed)
	if len(cookies) != 1 || cookies[0].Name != "jar" || cookies[0].Value != "one" || cookies[0].Path != "/" || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatalf("cookies = %#v", cookies)
	}
	request, _ = http.NewRequest("GET", server.URL+"/redirect-start", nil)
	response, err = session.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil || !strings.Contains(string(body), "redirect=one") {
		t.Fatalf("redirect body = %q, err = %v", body, err)
	}

	exported := allSessionCookies(session.client)
	if len(exported) != 2 {
		t.Fatalf("exported cookies = %#v", exported)
	}
	fresh, err := buildSession(protocol.SessionConfigMeta{SessionID: "cookies-fresh", Profile: &profile, ForceHTTP1: true})
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.closeIdleConnections()
	for _, cookie := range exported {
		cookieURL, importErr := importCookieURL(cookie)
		if importErr != nil {
			t.Fatal(importErr)
		}
		converted, conversionErr := requestCookie(cookie)
		if conversionErr != nil {
			t.Fatal(conversionErr)
		}
		fresh.client.SetCookies(cookieURL, []*http.Cookie{converted})
	}
	request, _ = http.NewRequest("GET", server.URL+"/echo", nil)
	response, err = fresh.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(response.Body)
	_ = response.Body.Close()
	if !strings.Contains(string(body), "jar=one") || !strings.Contains(string(body), "redirect=one") {
		t.Fatalf("imported cookie body = %q", body)
	}

	strict, err := buildSession(protocol.SessionConfigMeta{SessionID: "cookies-strict", Profile: &profile, ForceHTTP1: true, CookieJar: "strict"})
	if err != nil {
		t.Fatal(err)
	}
	defer strict.closeIdleConnections()
	request, _ = http.NewRequest("GET", server.URL+"/empty", nil)
	response, err = strict.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	if got := strict.client.GetCookies(parsed); len(got) != 0 {
		t.Fatalf("strict jar retained empty cookie: %#v", got)
	}
}

func TestIntegrationLiveProxySwitchPreservesJar(t *testing.T) {
	if os.Getenv("TLS_CLIENT_INTEGRATION") != "1" {
		t.Skip("set TLS_CLIENT_INTEGRATION=1 to run local tls-client integration tests")
	}
	server := httptest.NewServer(nethttp.HandlerFunc(func(writer nethttp.ResponseWriter, request *nethttp.Request) {
		if request.URL.Path == "/set" {
			writer.Header().Set("Set-Cookie", "proxy-jar=survives; Path=/")
		}
		_, _ = writer.Write([]byte(request.Header.Get("Cookie")))
	}))
	defer server.Close()
	profile := "chrome_146"
	session, err := buildSession(protocol.SessionConfigMeta{SessionID: "proxy", Profile: &profile, ForceHTTP1: true})
	if err != nil {
		t.Fatal(err)
	}
	defer session.closeIdleConnections()
	request, _ := http.NewRequest("GET", server.URL+"/set", nil)
	response, err := session.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()

	for _, scheme := range []string{"http", "socks5"} {
		proxy := startLocalProxy(t, scheme)
		if err := session.setProxy(context.Background(), proxy.URL()); err != nil {
			t.Fatalf("set %s proxy: %v", scheme, err)
		}
		request, _ = http.NewRequest("GET", server.URL+"/echo", nil)
		response, err = session.client.Do(request)
		if err != nil {
			t.Fatalf("request through %s proxy: %v", scheme, err)
		}
		body, readErr := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if readErr != nil || !strings.Contains(string(body), "proxy-jar=survives") {
			t.Fatalf("%s proxy body = %q, err = %v", scheme, body, readErr)
		}
		select {
		case <-proxy.hits:
		case <-time.After(time.Second):
			t.Fatalf("%s proxy did not receive a connection", scheme)
		}
	}
	if err := session.setProxy(context.Background(), "ftp://127.0.0.1:1"); err == nil {
		t.Fatal("invalid proxy was accepted")
	}
	if err := session.setProxy(context.Background(), ""); err != nil {
		t.Fatal(err)
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
