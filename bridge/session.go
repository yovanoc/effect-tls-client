package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	http "github.com/bogdanfinn/fhttp"
	"github.com/bogdanfinn/fhttp/cookiejar"
	"github.com/bogdanfinn/fhttp/http2"
	tlsClient "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
	utls "github.com/bogdanfinn/utls"
	"golang.org/x/net/publicsuffix"

	"github.com/yovanoc/effect-tls-client/bridge/protocol"
)

type tlsSession struct {
	id                    string
	client                tlsClient.HttpClient
	redirectClient        tlsClient.HttpClient
	wsClient              tlsClient.HttpClient
	followRedirects       bool
	timeoutMs             int64
	identity              protocol.IdentityMeta
	clientBandwidthGate   chan struct{}
	redirectBandwidthGate chan struct{}
	proxyGate             *proxyGate
}

type trackedCookie struct {
	cookie     *http.Cookie
	origin     string
	hostOnly   bool
	persistent bool
	sameSite   http.SameSite
}

type cookieJarState struct {
	jar     *cookiejar.Jar
	strict  bool
	mu      sync.Mutex
	cookies map[string]trackedCookie
}

type sessionCookieJar struct {
	state *cookieJarState

	// fhttp asks the Jar for cookies before each redirect hop. This flag is
	// scoped to one client, so an explicit Cookie header can suppress automatic
	// Jar injection without disabling response Set-Cookie processing.
	skipMu        sync.Mutex
	skipAutomatic bool
}

func newSessionCookieJar(strict bool) (*sessionCookieJar, error) {
	jar, err := cookiejar.New(&cookiejar.Options{PublicSuffixList: publicsuffix.List})
	if err != nil {
		return nil, err
	}
	return &sessionCookieJar{
		state: &cookieJarState{
			jar:     jar,
			strict:  strict,
			cookies: make(map[string]trackedCookie),
		},
	}, nil
}

func (j *sessionCookieJar) clone() *sessionCookieJar {
	return &sessionCookieJar{state: j.state}
}

func (j *sessionCookieJar) skipAutomaticCookies() {
	j.skipMu.Lock()
	j.skipAutomatic = true
	j.skipMu.Unlock()
}

func (j *sessionCookieJar) clearAutomaticCookieSkip() {
	j.skipMu.Lock()
	j.skipAutomatic = false
	j.skipMu.Unlock()
}

func (j *sessionCookieJar) skipsAutomaticCookies() bool {
	j.skipMu.Lock()
	defer j.skipMu.Unlock()
	return j.skipAutomatic
}

func cloneCookie(cookie *http.Cookie) *http.Cookie {
	copy := *cookie
	return &copy
}

func defaultCookiePath(path string) string {
	if path == "" || path[0] != '/' {
		return "/"
	}
	lastSlash := strings.LastIndexByte(path, '/')
	if lastSlash <= 0 {
		return "/"
	}
	return path[:lastSlash]
}

func cookiePath(u *url.URL, cookie *http.Cookie) string {
	if cookie.Path == "" || cookie.Path[0] != '/' {
		return defaultCookiePath(u.Path)
	}
	return cookie.Path
}

func cookieDomain(u *url.URL, cookie *http.Cookie) string {
	if cookie.Domain == "" {
		return strings.ToLower(u.Hostname())
	}
	return strings.TrimPrefix(strings.ToLower(cookie.Domain), ".")
}

func cookieKey(cookie *http.Cookie) string {
	return strings.ToLower(cookie.Domain) + "\x00" + cookie.Path + "\x00" + cookie.Name
}

func cookieQueryURL(scheme, host, path string) *url.URL {
	return &url.URL{Scheme: scheme, Host: host, Path: path}
}

func (j *sessionCookieJar) actualCookieLocked(record trackedCookie) (*http.Cookie, bool) {
	scheme := "http"
	if record.cookie.Secure {
		scheme = "https"
	}
	selected := j.state.jar.Cookies(cookieQueryURL(scheme, record.origin, record.cookie.Path))
	key := cookieKey(record.cookie)
	for _, cookie := range selected {
		if cookieKey(cookie) == key {
			return cookie, true
		}
	}
	return nil, false
}

func exposeCookie(actual *http.Cookie, record *trackedCookie) *http.Cookie {
	result := cloneCookie(actual)
	if record == nil {
		return result
	}
	result.SameSite = record.sameSite
	result.MaxAge = 0
	if !record.persistent {
		result.Expires = time.Time{}
	}
	if record.hostOnly {
		result.Domain = ""
	}
	return result
}

func (j *sessionCookieJar) reconcileLocked() {
	for key, record := range j.state.cookies {
		actual, ok := j.actualCookieLocked(record)
		if !ok {
			delete(j.state.cookies, key)
			continue
		}
		record.cookie = actual
		j.state.cookies[key] = record
	}
}

func (j *sessionCookieJar) acceptedCookieLocked(u *url.URL, candidate *http.Cookie) (*http.Cookie, bool) {
	path := cookiePath(u, candidate)
	scheme := u.Scheme
	if candidate.Secure {
		scheme = "https"
	}
	selected := j.state.jar.Cookies(cookieQueryURL(scheme, u.Host, path))
	domain := cookieDomain(u, candidate)
	for _, cookie := range selected {
		if cookie.Name == candidate.Name &&
			cookie.Value == candidate.Value &&
			cookie.Domain == domain &&
			cookie.Path == path &&
			cookie.Secure == candidate.Secure &&
			cookie.HttpOnly == candidate.HttpOnly {
			return cookie, true
		}
	}
	return nil, false
}

func (j *sessionCookieJar) cookiesFor(u *url.URL) []*http.Cookie {
	if u == nil {
		return nil
	}
	j.state.mu.Lock()
	defer j.state.mu.Unlock()
	selected := j.state.jar.Cookies(u)
	result := make([]*http.Cookie, 0, len(selected))
	for _, cookie := range selected {
		record, ok := j.state.cookies[cookieKey(cookie)]
		if ok {
			result = append(result, exposeCookie(cookie, &record))
		} else {
			result = append(result, cloneCookie(cookie))
		}
	}
	return result
}

func (j *sessionCookieJar) Cookies(u *url.URL) []*http.Cookie {
	if u == nil {
		return nil
	}
	if j.skipsAutomaticCookies() {
		return []*http.Cookie{}
	}
	return j.cookiesFor(u)
}

func (j *sessionCookieJar) SetCookies(u *url.URL, cookies []*http.Cookie) {
	if u == nil || len(cookies) == 0 {
		return
	}
	accepted := make([]*http.Cookie, 0, len(cookies))
	for _, cookie := range cookies {
		if cookie == nil || (j.state.strict && cookie.Value == "") {
			continue
		}
		accepted = append(accepted, cookie)
	}
	if len(accepted) == 0 {
		return
	}
	j.state.mu.Lock()
	defer j.state.mu.Unlock()
	j.state.jar.SetCookies(u, accepted)
	j.reconcileLocked()
	for _, candidate := range accepted {
		actual, ok := j.acceptedCookieLocked(u, candidate)
		if !ok {
			continue
		}
		key := cookieKey(actual)
		j.state.cookies[key] = trackedCookie{
			cookie:     actual,
			origin:     strings.ToLower(u.Hostname()),
			hostOnly:   candidate.Domain == "",
			persistent: candidate.MaxAge > 0 || !candidate.Expires.IsZero(),
			sameSite:   candidate.SameSite,
		}
	}
}

func (j *sessionCookieJar) GetAllCookies() map[string][]*http.Cookie {
	j.state.mu.Lock()
	defer j.state.mu.Unlock()
	j.reconcileLocked()
	byOrigin := make(map[string][]*http.Cookie)
	for _, record := range j.state.cookies {
		cookie := exposeCookie(record.cookie, &record)
		byOrigin[record.origin] = append(byOrigin[record.origin], cookie)
	}
	for origin := range byOrigin {
		sort.Slice(byOrigin[origin], func(i, k int) bool {
			left, right := byOrigin[origin][i], byOrigin[origin][k]
			if left.Domain != right.Domain {
				return left.Domain < right.Domain
			}
			if left.Path != right.Path {
				return left.Path < right.Path
			}
			return left.Name < right.Name
		})
	}
	return byOrigin
}

type proxyGate struct {
	mu             sync.Mutex
	readers        int
	writer         bool
	waitingWriters int
	changed        chan struct{}
}

func newProxyGate() *proxyGate {
	return &proxyGate{changed: make(chan struct{})}
}

func (g *proxyGate) signalLocked() {
	close(g.changed)
	g.changed = make(chan struct{})
}

func (g *proxyGate) acquireRead(ctx context.Context) (func(), error) {
	for {
		g.mu.Lock()
		if !g.writer && g.waitingWriters == 0 {
			g.readers++
			g.mu.Unlock()
			return func() { g.releaseRead() }, nil
		}
		changed := g.changed
		g.mu.Unlock()
		select {
		case <-changed:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

func (g *proxyGate) releaseRead() {
	g.mu.Lock()
	g.readers--
	if g.readers == 0 {
		g.signalLocked()
	}
	g.mu.Unlock()
}

func (g *proxyGate) acquireWrite(ctx context.Context) (func(), error) {
	g.mu.Lock()
	g.waitingWriters++
	for {
		if !g.writer && g.readers == 0 {
			g.waitingWriters--
			g.writer = true
			g.mu.Unlock()
			return func() { g.releaseWrite() }, nil
		}
		changed := g.changed
		g.mu.Unlock()
		select {
		case <-changed:
			g.mu.Lock()
		case <-ctx.Done():
			g.mu.Lock()
			g.waitingWriters--
			g.signalLocked()
			g.mu.Unlock()
			return nil, ctx.Err()
		}
	}
}

func (g *proxyGate) releaseWrite() {
	g.mu.Lock()
	g.writer = false
	g.signalLocked()
	g.mu.Unlock()
}

type uploadCredits struct {
	mu       sync.Mutex
	window   uint64
	received uint64
	acked    uint64
}

func (c *uploadCredits) reserve(size uint64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	outstanding := c.received - c.acked
	if size > c.window-outstanding {
		return false
	}
	c.received += size
	return true
}

func (c *uploadCredits) ack(size uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	outstanding := c.received - c.acked
	if size > outstanding {
		size = outstanding
	}
	c.acked += size
}

var errUploadResponse = errors.New("request upload aborted after response headers")

type requestUpload struct {
	ctx       context.Context
	id        uint32
	reader    *io.PipeReader
	writer    *io.PipeWriter
	credits   *uploadCredits
	chunkSize uint64
	window    uint64
	output    *protocol.Writer
	done      chan struct{}

	queueMu    sync.Mutex
	queueCond  *sync.Cond
	chunks     [][]byte
	queuedSize uint64
	closed     bool
	closeErr   error
	ended      bool
}

func newRequestUpload(ctx context.Context, output *protocol.Writer, id uint32, window, chunkSize uint64) *requestUpload {
	reader, writer := io.Pipe()
	upload := &requestUpload{
		ctx:       ctx,
		id:        id,
		reader:    reader,
		writer:    writer,
		credits:   &uploadCredits{window: window},
		chunkSize: chunkSize,
		window:    window,
		output:    output,
		done:      make(chan struct{}),
	}
	upload.queueCond = sync.NewCond(&upload.queueMu)
	go upload.watchContext()
	go upload.run()
	return upload
}

func (u *requestUpload) watchContext() {
	select {
	case <-u.ctx.Done():
		u.abort(u.ctx.Err())
	case <-u.done:
	}
}

func (u *requestUpload) next() ([]byte, error) {
	u.queueMu.Lock()
	defer u.queueMu.Unlock()
	for len(u.chunks) == 0 && !u.closed {
		u.queueCond.Wait()
	}
	if u.closed {
		return nil, u.closeErr
	}
	chunk := u.chunks[0]
	u.chunks[0] = nil
	u.chunks = u.chunks[1:]
	if chunk != nil {
		u.queuedSize -= uint64(len(chunk))
	}
	u.queueCond.Broadcast()
	return chunk, nil
}

func (u *requestUpload) run() {
	defer close(u.done)
	for {
		chunk, err := u.next()
		if err != nil {
			_ = u.writer.CloseWithError(err)
			return
		}
		if chunk == nil {
			_ = u.writer.Close()
			return
		}
		written, err := u.writer.Write(chunk)
		if err != nil {
			u.abort(err)
			return
		}
		if written == 0 {
			continue
		}
		u.credits.ack(uint64(written))
		meta, metaErr := protocol.EncodeMeta(protocol.AckMeta{Bytes: uint64(written)})
		if metaErr != nil {
			u.abort(metaErr)
			return
		}
		if err := u.output.Write(protocol.Frame{
			Kind: protocol.KindBodyAck,
			ID:   u.id,
			Meta: meta,
		}); err != nil {
			u.abort(err)
			return
		}
	}
}

func (u *requestUpload) accept(chunk []byte) error {
	if len(chunk) == 0 {
		return fmt.Errorf("%w: body.chunk cannot be empty", protocol.ErrProtocol)
	}
	if uint64(len(chunk)) > u.chunkSize {
		return fmt.Errorf("%w: body.chunk exceeds negotiated chunkSize", protocol.ErrProtocol)
	}
	if u.ctx.Err() != nil {
		return nil
	}
	chunkBytes := uint64(len(chunk))
	u.queueMu.Lock()
	closed := u.closed
	ended := u.ended
	u.queueMu.Unlock()
	if closed {
		return nil
	}
	if ended {
		return fmt.Errorf("%w: body.chunk received after body.end", protocol.ErrProtocol)
	}
	if !u.credits.reserve(chunkBytes) {
		return fmt.Errorf("%w: upload credit window exceeded", protocol.ErrProtocol)
	}

	u.queueMu.Lock()
	defer u.queueMu.Unlock()
	for !u.closed && (u.queuedSize > u.window || chunkBytes > u.window-u.queuedSize) {
		u.queueCond.Wait()
	}
	if u.closed || u.ctx.Err() != nil {
		return nil
	}
	if u.ended {
		return fmt.Errorf("%w: body.chunk received after body.end", protocol.ErrProtocol)
	}
	u.chunks = append(u.chunks, chunk)
	u.queuedSize += chunkBytes
	u.queueCond.Signal()
	return nil
}

func (u *requestUpload) end() error {
	if u.ctx.Err() != nil {
		return nil
	}
	u.queueMu.Lock()
	defer u.queueMu.Unlock()
	if u.closed {
		return nil
	}
	if u.ended {
		return fmt.Errorf("%w: duplicate body.end", protocol.ErrProtocol)
	}
	u.ended = true
	u.chunks = append(u.chunks, nil)
	u.queueCond.Signal()
	return nil
}

func (u *requestUpload) abort(err error) {
	if err == nil {
		err = io.ErrClosedPipe
	}
	u.queueMu.Lock()
	if !u.closed {
		u.closed = true
		u.closeErr = err
		u.chunks = nil
		u.queuedSize = 0
		u.queueCond.Broadcast()
	}
	u.queueMu.Unlock()
	_ = u.writer.CloseWithError(err)
}

func (u *requestUpload) abortIfIncomplete(err error) {
	if err == nil {
		err = io.ErrClosedPipe
	}
	u.queueMu.Lock()
	if u.closed || u.ended {
		u.queueMu.Unlock()
		return
	}
	u.closed = true
	u.closeErr = err
	u.chunks = nil
	u.queuedSize = 0
	u.queueCond.Broadcast()
	u.queueMu.Unlock()
	_ = u.writer.CloseWithError(err)
}

func (u *requestUpload) close() {
	u.abort(io.ErrClosedPipe)
	<-u.done
}

func (u *requestUpload) wait() {
	<-u.done
}

type bandwidthSnapshot struct {
	read    int64
	written int64
}

func snapshotBandwidth(client tlsClient.HttpClient) bandwidthSnapshot {
	tracker := client.GetBandwidthTracker()
	return bandwidthSnapshot{
		read:    tracker.GetReadBytes(),
		written: tracker.GetWriteBytes(),
	}
}

func aggregateBandwidth(clients ...tlsClient.HttpClient) bandwidthSnapshot {
	var result bandwidthSnapshot
	for _, client := range clients {
		snapshot := snapshotBandwidth(client)
		result.read += snapshot.read
		result.written += snapshot.written
	}
	return result
}

func bandwidthValue(value int64) uint64 {
	if value <= 0 {
		return 0
	}
	return uint64(value)
}

func bandwidthResult(snapshot bandwidthSnapshot) protocol.BandwidthResultMeta {
	return protocol.BandwidthResultMeta{
		Read:    bandwidthValue(snapshot.read),
		Written: bandwidthValue(snapshot.written),
	}
}

func bandwidthDelta(before, after int64) uint64 {
	if after <= before {
		return 0
	}
	return uint64(after - before)
}

// The pinned upstream tracker counts bytes for the whole client, so this gate
// spans Do through body EOF to keep each end delta attributable to one request.
// ponytail: same-client request bodies serialize; use upstream per-request counters when available.
func (s *tlsSession) beginTrackedRequest(ctx context.Context, followRedirects *bool) (tlsClient.HttpClient, bandwidthSnapshot, func(), error) {
	releaseProxy, err := s.proxyGate.acquireRead(ctx)
	if err != nil {
		return nil, bandwidthSnapshot{}, func() {}, err
	}
	client := s.client
	gate := s.clientBandwidthGate
	if followRedirects != nil && *followRedirects != s.followRedirects {
		client = s.redirectClient
		gate = s.redirectBandwidthGate
	}
	select {
	case gate <- struct{}{}:
		if err := ctx.Err(); err != nil {
			<-gate
			releaseProxy()
			return nil, bandwidthSnapshot{}, func() {}, err
		}
		return client, snapshotBandwidth(client), func() {
			<-gate
			releaseProxy()
		}, nil
	case <-ctx.Done():
		releaseProxy()
		return nil, bandwidthSnapshot{}, func() {}, ctx.Err()
	}
}

func validateProxyURL(proxyURL string) error {
	if proxyURL == "" {
		return nil
	}
	parsed, err := url.Parse(proxyURL)
	if err != nil {
		return fmt.Errorf("invalid proxy URL: %w", err)
	}
	if parsed.Host == "" || parsed.Hostname() == "" {
		return errors.New("proxy URL must include a host")
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https", "socks4", "socks5":
		return nil
	default:
		return fmt.Errorf("unsupported proxy scheme %q", parsed.Scheme)
	}
}

func (s *tlsSession) bandwidth(ctx context.Context) (protocol.BandwidthResultMeta, error) {
	releaseProxy, err := s.proxyGate.acquireRead(ctx)
	if err != nil {
		return protocol.BandwidthResultMeta{}, err
	}
	defer releaseProxy()
	return bandwidthResult(aggregateBandwidth(s.client, s.redirectClient, s.wsClient)), nil
}

func (s *tlsSession) resetBandwidth(ctx context.Context) error {
	releaseProxy, err := s.proxyGate.acquireWrite(ctx)
	if err != nil {
		return err
	}
	defer releaseProxy()
	s.client.GetBandwidthTracker().Reset()
	s.redirectClient.GetBandwidthTracker().Reset()
	s.wsClient.GetBandwidthTracker().Reset()
	return nil
}

func (s *tlsSession) setProxy(ctx context.Context, proxyURL string) error {
	if err := validateProxyURL(proxyURL); err != nil {
		return err
	}
	releaseProxy, err := s.proxyGate.acquireWrite(ctx)
	if err != nil {
		return err
	}
	defer releaseProxy()
	if err := ctx.Err(); err != nil {
		return err
	}
	previous := s.client.GetProxy()
	s.client.CloseIdleConnections()
	s.redirectClient.CloseIdleConnections()
	s.wsClient.CloseIdleConnections()
	if err := s.client.SetProxy(proxyURL); err != nil {
		return err
	}
	if err := s.redirectClient.SetProxy(proxyURL); err != nil {
		_ = s.client.SetProxy(previous)
		_ = s.redirectClient.SetProxy(previous)
		_ = s.wsClient.SetProxy(previous)
		return err
	}
	if err := s.wsClient.SetProxy(proxyURL); err != nil {
		_ = s.client.SetProxy(previous)
		_ = s.redirectClient.SetProxy(previous)
		_ = s.wsClient.SetProxy(previous)
		return err
	}
	s.client.CloseIdleConnections()
	s.redirectClient.CloseIdleConnections()
	s.wsClient.CloseIdleConnections()
	return nil
}

func (s *tlsSession) closeIdleConnections() {
	releaseProxy, err := s.proxyGate.acquireWrite(context.Background())
	if err != nil {
		return
	}
	defer releaseProxy()
	s.client.CloseIdleConnections()
	s.redirectClient.CloseIdleConnections()
	s.wsClient.CloseIdleConnections()
}

type sessionStore struct {
	mu       sync.RWMutex
	sessions map[string]*tlsSession
}

func newSessionStore() *sessionStore {
	return &sessionStore{sessions: make(map[string]*tlsSession)}
}

func (s *sessionStore) add(session *tlsSession) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.sessions[session.id]; ok {
		return fmt.Errorf("session %q already exists", session.id)
	}
	s.sessions[session.id] = session
	return nil
}

func (s *sessionStore) get(id string) (*tlsSession, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	session, ok := s.sessions[id]
	return session, ok
}

func (s *sessionStore) remove(id string) (*tlsSession, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok := s.sessions[id]
	if ok {
		delete(s.sessions, id)
	}
	return session, ok
}

func (s *sessionStore) all() []*tlsSession {
	s.mu.RLock()
	defer s.mu.RUnlock()
	sessions := make([]*tlsSession, 0, len(s.sessions))
	for _, session := range s.sessions {
		sessions = append(sessions, session)
	}
	return sessions
}

func (s *sessionStore) closeAll() []*tlsSession {
	s.mu.Lock()
	sessions := make([]*tlsSession, 0, len(s.sessions))
	for id, session := range s.sessions {
		delete(s.sessions, id)
		sessions = append(sessions, session)
	}
	s.mu.Unlock()
	for _, session := range sessions {
		session.closeIdleConnections()
	}
	return sessions
}

func (d *dispatcher) runSessionCreate(_ context.Context, op *operation, config protocol.SessionConfigMeta) {
	session, err := buildSession(config)
	if err != nil {
		_ = d.finishError(op, protocol.ErrorKindSessionConfig, err.Error())
		return
	}
	if err := d.sessions.add(session); err != nil {
		session.closeIdleConnections()
		_ = d.finishError(op, protocol.ErrorKindSessionConfig, err.Error())
		return
	}
	_ = d.finishOK(op)
}

func (d *dispatcher) runSessionDestroy(_ context.Context, op *operation, meta protocol.SessionIDMeta) {
	session, ok := d.sessions.remove(meta.SessionID)
	if !ok {
		_ = d.finishErrorDetail(op, protocol.ErrorKindSessionNotFound, fmt.Sprintf("session %q was not found", meta.SessionID), map[string]interface{}{"sessionId": meta.SessionID})
		return
	}
	for _, operation := range d.cancelSession(meta.SessionID, op) {
		<-operation.done
	}
	d.retireSession(session)
	session.closeIdleConnections()
	_ = d.finishOK(op)
}

func (d *dispatcher) finishResult(op *operation, value interface{}) error {
	meta, err := protocol.EncodeMeta(value)
	if err != nil {
		return err
	}
	return d.finish(op, protocol.Frame{Kind: protocol.KindOk, ID: op.id, Meta: meta})
}

func sessionNotFound(d *dispatcher, op *operation, sessionID string) {
	_ = d.finishErrorDetail(op, protocol.ErrorKindSessionNotFound, fmt.Sprintf("session %q was not found", sessionID), map[string]interface{}{"sessionId": sessionID})
}

func (d *dispatcher) runSessionProxy(ctx context.Context, op *operation, meta protocol.SessionProxyMeta) {
	if err := ctx.Err(); err != nil {
		_ = d.finishCancelled(op)
		return
	}
	session, ok := d.sessions.get(meta.SessionID)
	if !ok {
		sessionNotFound(d, op, meta.SessionID)
		return
	}
	proxyURL := ""
	if meta.ProxyURL != nil {
		proxyURL = *meta.ProxyURL
	}
	if err := session.setProxy(ctx, proxyURL); err != nil {
		if errors.Is(err, context.Canceled) {
			_ = d.finishCancelled(op)
		} else {
			_ = d.finishError(op, protocol.ErrorKindProxy, err.Error())
		}
		return
	}
	if err := ctx.Err(); err != nil {
		_ = d.finishCancelled(op)
		return
	}
	_ = d.finishOK(op)
}

func parseCookieURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		if err != nil {
			return nil, err
		}
		return nil, errors.New("cookie URL must be an absolute http or https URL")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, errors.New("cookie URL must use http or https")
	}
	parsed.Fragment = ""
	return parsed, nil
}

func cookieMeta(cookie *http.Cookie) protocol.CookieMeta {
	var expires *int64
	if !cookie.Expires.IsZero() {
		value := cookie.Expires.Unix()
		expires = &value
	}
	sameSite := ""
	switch cookie.SameSite {
	case http.SameSiteLaxMode:
		sameSite = "Lax"
	case http.SameSiteStrictMode:
		sameSite = "Strict"
	case http.SameSiteNoneMode:
		sameSite = "None"
	}
	return protocol.CookieMeta{
		Name:     cookie.Name,
		Value:    cookie.Value,
		Domain:   cookie.Domain,
		Path:     cookie.Path,
		Expires:  expires,
		Secure:   cookie.Secure,
		HttpOnly: cookie.HttpOnly,
		SameSite: sameSite,
	}
}

func cookieMetas(cookies []*http.Cookie) []protocol.CookieMeta {
	result := make([]protocol.CookieMeta, 0, len(cookies))
	for _, cookie := range cookies {
		if cookie != nil {
			result = append(result, cookieMeta(cookie))
		}
	}
	sort.SliceStable(result, func(i, j int) bool {
		if result[i].Domain != result[j].Domain {
			return result[i].Domain < result[j].Domain
		}
		if result[i].Path != result[j].Path {
			return result[i].Path < result[j].Path
		}
		return result[i].Name < result[j].Name
	})
	return result
}

func allSessionCookies(client tlsClient.HttpClient) []protocol.CookieMeta {
	jar, ok := client.GetCookieJar().(interface {
		GetAllCookies() map[string][]*http.Cookie
	})
	if !ok {
		return []protocol.CookieMeta{}
	}
	cookies := make([]protocol.CookieMeta, 0)
	for origin, entries := range jar.GetAllCookies() {
		for _, cookie := range entries {
			if cookie == nil {
				continue
			}
			meta := cookieMeta(cookie)
			if meta.Domain == "" {
				meta.Origin = origin
			}
			cookies = append(cookies, meta)
		}
	}
	sort.SliceStable(cookies, func(i, j int) bool {
		if cookies[i].Domain != cookies[j].Domain {
			return cookies[i].Domain < cookies[j].Domain
		}
		if cookies[i].Origin != cookies[j].Origin {
			return cookies[i].Origin < cookies[j].Origin
		}
		if cookies[i].Path != cookies[j].Path {
			return cookies[i].Path < cookies[j].Path
		}
		return cookies[i].Name < cookies[j].Name
	})
	return cookies
}

func importCookieURL(cookie protocol.CookieMeta) (*url.URL, error) {
	host := strings.TrimPrefix(cookie.Domain, ".")
	if host == "" {
		host = cookie.Origin
	}
	if host == "" {
		return nil, errors.New("cookie domain or origin is required for import")
	}
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		host = "[" + host + "]"
	}
	scheme := "http"
	if cookie.Secure {
		scheme = "https"
	}
	path := cookie.Path
	if path == "" {
		path = "/"
	}
	return parseCookieURL(scheme + "://" + host + path)
}

func (d *dispatcher) runCookiesGet(ctx context.Context, op *operation, meta protocol.CookiesGetMeta) {
	if err := ctx.Err(); err != nil {
		_ = d.finishCancelled(op)
		return
	}
	session, ok := d.sessions.get(meta.SessionID)
	if !ok {
		sessionNotFound(d, op, meta.SessionID)
		return
	}
	parsed, err := parseCookieURL(meta.URL)
	if err != nil {
		_ = d.finishError(op, protocol.ErrorKindInvalidUrl, err.Error())
		return
	}
	releaseProxy, acquireErr := session.proxyGate.acquireRead(ctx)
	if acquireErr != nil {
		_ = d.finishCancelled(op)
		return
	}
	var selected []*http.Cookie
	if jar, ok := session.client.GetCookieJar().(*sessionCookieJar); ok {
		selected = jar.cookiesFor(parsed)
	} else {
		selected = session.client.GetCookies(parsed)
	}
	cookies := cookieMetas(selected)
	releaseProxy()
	_ = d.finishResult(op, protocol.CookiesResultMeta{Cookies: cookies})
}

func (d *dispatcher) runCookiesSet(ctx context.Context, op *operation, meta protocol.CookiesSetMeta) {
	if err := ctx.Err(); err != nil {
		_ = d.finishCancelled(op)
		return
	}
	session, ok := d.sessions.get(meta.SessionID)
	if !ok {
		sessionNotFound(d, op, meta.SessionID)
		return
	}
	parsed, err := parseCookieURL(meta.URL)
	if err != nil {
		_ = d.finishError(op, protocol.ErrorKindInvalidUrl, err.Error())
		return
	}
	converted := make([]*http.Cookie, 0, len(meta.Cookies))
	for _, cookie := range meta.Cookies {
		convertedCookie, conversionErr := requestCookie(cookie)
		if conversionErr != nil {
			_ = d.finishError(op, protocol.ErrorKindInvalidConfig, conversionErr.Error())
			return
		}
		converted = append(converted, convertedCookie)
	}
	releaseProxy, acquireErr := session.proxyGate.acquireRead(ctx)
	if acquireErr != nil {
		_ = d.finishCancelled(op)
		return
	}
	session.client.SetCookies(parsed, converted)
	releaseProxy()
	_ = d.finishOK(op)
}

func (d *dispatcher) runCookiesExport(ctx context.Context, op *operation, meta protocol.CookiesExportMeta) {
	if err := ctx.Err(); err != nil {
		_ = d.finishCancelled(op)
		return
	}
	session, ok := d.sessions.get(meta.SessionID)
	if !ok {
		sessionNotFound(d, op, meta.SessionID)
		return
	}
	releaseProxy, acquireErr := session.proxyGate.acquireRead(ctx)
	if acquireErr != nil {
		_ = d.finishCancelled(op)
		return
	}
	cookies := allSessionCookies(session.client)
	releaseProxy()
	_ = d.finishResult(op, protocol.CookiesResultMeta{Cookies: cookies})
}

func (d *dispatcher) runCookiesImport(ctx context.Context, op *operation, meta protocol.CookiesImportMeta) {
	if err := ctx.Err(); err != nil {
		_ = d.finishCancelled(op)
		return
	}
	session, ok := d.sessions.get(meta.SessionID)
	if !ok {
		sessionNotFound(d, op, meta.SessionID)
		return
	}
	converted := make([]struct {
		url    *url.URL
		cookie *http.Cookie
	}, 0, len(meta.Cookies))
	for _, cookie := range meta.Cookies {
		parsed, parseErr := importCookieURL(cookie)
		if parseErr != nil {
			_ = d.finishError(op, protocol.ErrorKindInvalidConfig, parseErr.Error())
			return
		}
		convertedCookie, conversionErr := requestCookie(cookie)
		if conversionErr != nil {
			_ = d.finishError(op, protocol.ErrorKindInvalidConfig, conversionErr.Error())
			return
		}
		converted = append(converted, struct {
			url    *url.URL
			cookie *http.Cookie
		}{parsed, convertedCookie})
	}
	releaseProxy, acquireErr := session.proxyGate.acquireRead(ctx)
	if acquireErr != nil {
		_ = d.finishCancelled(op)
		return
	}
	for _, item := range converted {
		session.client.SetCookies(item.url, []*http.Cookie{item.cookie})
	}
	releaseProxy()
	_ = d.finishOK(op)
}

func (d *dispatcher) runBandwidthGet(ctx context.Context, op *operation, meta protocol.BandwidthMeta) {
	if err := ctx.Err(); err != nil {
		_ = d.finishCancelled(op)
		return
	}
	var result protocol.BandwidthResultMeta
	var err error
	if meta.SessionID == "" {
		result, err = d.processBandwidth(ctx)
	} else {
		session, ok := d.sessions.get(meta.SessionID)
		if !ok {
			sessionNotFound(d, op, meta.SessionID)
			return
		}
		result, err = session.bandwidth(ctx)
	}
	if err != nil {
		if errors.Is(err, context.Canceled) {
			_ = d.finishCancelled(op)
		} else {
			_ = d.finishError(op, protocol.ErrorKindInternal, err.Error())
		}
		return
	}
	_ = d.finishResult(op, result)
}

func (d *dispatcher) runBandwidthReset(ctx context.Context, op *operation, meta protocol.BandwidthMeta) {
	if err := ctx.Err(); err != nil {
		_ = d.finishCancelled(op)
		return
	}
	var err error
	if meta.SessionID == "" {
		err = d.resetProcessBandwidth(ctx)
	} else {
		session, ok := d.sessions.get(meta.SessionID)
		if !ok {
			sessionNotFound(d, op, meta.SessionID)
			return
		}
		err = session.resetBandwidth(ctx)
	}
	if err != nil {
		if errors.Is(err, context.Canceled) {
			_ = d.finishCancelled(op)
		} else {
			_ = d.finishError(op, protocol.ErrorKindInternal, err.Error())
		}
		return
	}
	_ = d.finishOK(op)
}

func validateSessionConfig(config protocol.SessionConfigMeta) error {
	if config.SessionID == "" {
		return errors.New("sessionId is required")
	}
	if (config.Profile == nil) == (config.CustomProfile == nil) {
		return errors.New("exactly one of profile or customProfile is required")
	}
	if config.Profile != nil {
		if _, ok := profiles.MappedTLSClients[*config.Profile]; !ok {
			return fmt.Errorf("unknown profile %q", *config.Profile)
		}
	}
	if config.DisableIPv4 && config.DisableIPv6 {
		return errors.New("cannot disable both IPv4 and IPv6")
	}
	if config.InsecureSkipVerify && len(config.CertificatePins) > 0 {
		return errors.New("certificate pinning cannot be used with insecure skip verify")
	}
	if config.ProtocolRacing && (config.ForceHTTP1 || config.DisableHTTP3) {
		return errors.New("protocol racing cannot be combined with forceHttp1 or disableHttp3")
	}
	if config.TimeoutMs != nil {
		if *config.TimeoutMs < 0 || *config.TimeoutMs > math.MaxInt64/int64(time.Millisecond) {
			return errors.New("timeoutMs is outside the supported range")
		}
	}
	if config.CookieJar != "" && config.CookieJar != "default" && config.CookieJar != "strict" && config.CookieJar != "none" {
		return fmt.Errorf("unknown cookieJar mode %q", config.CookieJar)
	}
	if config.Identity != nil {
		if err := validateHeaderPairs(config.Identity.Headers); err != nil {
			return fmt.Errorf("identity headers: %w", err)
		}
		if err := validateHeaderOrder(config.Identity.HeaderOrder); err != nil {
			return fmt.Errorf("identity header order: %w", err)
		}
	}
	if config.Transport != nil {
		if err := validateTransport(*config.Transport); err != nil {
			return err
		}
	}
	if config.CustomProfile != nil {
		if err := validateCustomProfile(*config.CustomProfile); err != nil {
			return err
		}
	}
	return nil
}

func validateTransport(transport protocol.TransportMeta) error {
	if transport.IdleConnTimeoutMs != nil && (*transport.IdleConnTimeoutMs < 0 || *transport.IdleConnTimeoutMs > math.MaxInt64/int64(time.Millisecond)) {
		return errors.New("transport.idleConnTimeoutMs is outside the supported range")
	}
	if transport.MaxIdleConns < 0 || transport.MaxIdleConnsPerHost < 0 || transport.MaxConnsPerHost < 0 ||
		transport.MaxResponseHeaderBytes < 0 || transport.WriteBufferSize < 0 || transport.ReadBufferSize < 0 {
		return errors.New("transport values cannot be negative")
	}
	return nil
}

func validateCustomProfile(profile protocol.CustomProfileMeta) error {
	if profile.Ja3String == "" {
		return errors.New("customProfile.ja3String is required")
	}
	for name := range profile.H2Settings {
		if _, ok := tlsClient.H2SettingsMap[name]; !ok {
			return fmt.Errorf("unknown HTTP/2 setting %q", name)
		}
	}
	for _, name := range profile.H2SettingsOrder {
		if _, ok := tlsClient.H2SettingsMap[name]; !ok {
			return fmt.Errorf("unknown HTTP/2 setting %q", name)
		}
	}
	for name := range profile.H3Settings {
		if _, ok := tlsClient.H3SettingsMap[name]; !ok {
			return fmt.Errorf("unknown HTTP/3 setting %q", name)
		}
	}
	for _, name := range profile.H3SettingsOrder {
		if _, ok := tlsClient.H3SettingsMap[name]; !ok {
			return fmt.Errorf("unknown HTTP/3 setting %q", name)
		}
	}
	if err := validatePinnedEnumValues("keyShareCurves value", profile.KeyShareCurves, pinnedSupportedCurves); err != nil {
		return err
	}
	if err := validatePinnedEnumValues("supportedVersions value", profile.SupportedVersions, pinnedSupportedVersions); err != nil {
		return err
	}
	if err := validatePinnedEnumValues("supportedSignatureAlgorithms value", profile.SupportedSignatureAlgorithms, pinnedSupportedSignatureAlgorithms); err != nil {
		return err
	}
	if err := validatePinnedEnumValues("supportedDelegatedCredentialsAlgorithms value", profile.SupportedDelegatedCredentialsAlgorithms, pinnedSupportedDelegatedCredentialsAlgorithms); err != nil {
		return err
	}
	if err := validatePinnedEnumValues("certCompressionAlgos value", profile.CertCompressionAlgos, pinnedCertCompressionAlgos); err != nil {
		return err
	}
	for _, suite := range profile.ECHCandidateCipherSuites {
		if !containsPinnedValue(pinnedKDFIDs, suite.KdfID) {
			return unknownCustomProfileEnum("ECHCandidateCipherSuites.kdfId value", suite.KdfID)
		}
		if !containsPinnedValue(pinnedAEADIDs, suite.AeadID) {
			return unknownCustomProfileEnum("ECHCandidateCipherSuites.aeadId value", suite.AeadID)
		}
	}
	return nil
}

func validateHeaderPairs(pairs []protocol.HeaderPair) error {
	for _, pair := range pairs {
		if strings.TrimSpace(pair[0]) == "" {
			return errors.New("header names cannot be empty")
		}
		if strings.EqualFold(pair[0], http.HeaderOrderKey) || strings.EqualFold(pair[0], http.PHeaderOrderKey) {
			return fmt.Errorf("reserved header name %q", pair[0])
		}
	}
	return nil
}

func buildSession(config protocol.SessionConfigMeta) (*tlsSession, error) {
	if err := validateSessionConfig(config); err != nil {
		return nil, err
	}

	clientProfile := profiles.ClientProfile{}
	if config.Profile != nil {
		clientProfile = profiles.MappedTLSClients[*config.Profile]
	} else {
		var err error
		clientProfile, err = buildCustomProfile(*config.CustomProfile)
		if err != nil {
			return nil, fmt.Errorf("customProfile: %w", err)
		}
	}

	timeoutMs := int64(30_000)
	if config.TimeoutMs != nil {
		timeoutMs = *config.TimeoutMs
	}
	clientOptions := []tlsClient.HttpClientOption{
		tlsClient.WithClientProfile(clientProfile),
		// Request contexts below own the deadline. tls-client's proxy CONNECT
		// dialer treats zero as an immediate deadline, so use a 32-bit-safe
		// upper bound rather than the unsafe 64-bit sentinel it previously used.
		tlsClient.WithTimeoutMilliseconds(1<<31 - 1),
		tlsClient.WithBandwidthTracker(),
	}
	if config.ProxyURL != "" {
		clientOptions = append(clientOptions, tlsClient.WithProxyUrl(config.ProxyURL))
	}
	if config.InsecureSkipVerify {
		clientOptions = append(clientOptions, tlsClient.WithInsecureSkipVerify())
	}
	if config.RandomTLSExtensionOrder {
		clientOptions = append(clientOptions, tlsClient.WithRandomTLSExtensionOrder())
	}
	if config.DisableSessionTickets {
		clientOptions = append(clientOptions, tlsClient.WithDisableSessionTickets())
	}
	if config.ForceHTTP1 {
		clientOptions = append(clientOptions, tlsClient.WithForceHttp1())
	}
	if config.DisableHTTP3 {
		clientOptions = append(clientOptions, tlsClient.WithDisableHttp3())
	}
	if config.ProtocolRacing {
		clientOptions = append(clientOptions, tlsClient.WithProtocolRacing())
	}
	if config.DisableIPv4 {
		clientOptions = append(clientOptions, tlsClient.WithDisableIPV4())
	}
	if config.DisableIPv6 {
		clientOptions = append(clientOptions, tlsClient.WithDisableIPV6())
	}
	if config.ServerName != "" {
		clientOptions = append(clientOptions, tlsClient.WithServerNameOverwrite(config.ServerName))
	}
	if len(config.CertificatePins) > 0 {
		clientOptions = append(clientOptions, tlsClient.WithCertificatePinning(config.CertificatePins, nil))
	}
	if config.LocalAddress != "" {
		address, err := net.ResolveTCPAddr("", config.LocalAddress)
		if err != nil {
			return nil, fmt.Errorf("localAddress: %w", err)
		}
		clientOptions = append(clientOptions, tlsClient.WithLocalAddr(*address))
	}
	if config.Transport != nil {
		transport, err := makeTransportOptions(*config.Transport)
		if err != nil {
			return nil, err
		}
		clientOptions = append(clientOptions, tlsClient.WithTransportOptions(transport))
	}

	jarMode := config.CookieJar
	var sessionJar *sessionCookieJar
	if jarMode == "" || jarMode == "default" || jarMode == "strict" {
		var err error
		sessionJar, err = newSessionCookieJar(jarMode == "strict")
		if err != nil {
			return nil, fmt.Errorf("cookie jar: %w", err)
		}
	}

	followRedirects := false
	if config.FollowRedirects != nil {
		followRedirects = *config.FollowRedirects
	}
	makeClient := func(follow, forceHTTP1 bool) (tlsClient.HttpClient, error) {
		options := append([]tlsClient.HttpClientOption(nil), clientOptions...)
		if forceHTTP1 {
			options = append(options, tlsClient.WithForceHttp1())
		}
		if sessionJar != nil {
			options = append(options, tlsClient.WithCookieJar(sessionJar.clone()))
		}
		if !follow {
			options = append(options, tlsClient.WithNotFollowRedirects())
		}
		return tlsClient.NewHttpClient(tlsClient.NewNoopLogger(), options...)
	}
	client, err := makeClient(followRedirects, false)
	if err != nil {
		return nil, err
	}
	redirectClient, err := makeClient(!followRedirects, false)
	if err != nil {
		client.CloseIdleConnections()
		return nil, err
	}
	wsClient, err := makeClient(false, true)
	if err != nil {
		client.CloseIdleConnections()
		redirectClient.CloseIdleConnections()
		return nil, err
	}
	identity := protocol.IdentityMeta{}
	if config.Identity != nil {
		identity = *config.Identity
	}
	return &tlsSession{
		id:                    config.SessionID,
		client:                client,
		redirectClient:        redirectClient,
		wsClient:              wsClient,
		followRedirects:       followRedirects,
		timeoutMs:             timeoutMs,
		identity:              identity,
		clientBandwidthGate:   make(chan struct{}, 1),
		redirectBandwidthGate: make(chan struct{}, 1),
		proxyGate:             newProxyGate(),
	}, nil
}

func makeTransportOptions(config protocol.TransportMeta) (*tlsClient.TransportOptions, error) {
	options := &tlsClient.TransportOptions{
		MaxIdleConns:           config.MaxIdleConns,
		MaxIdleConnsPerHost:    config.MaxIdleConnsPerHost,
		MaxConnsPerHost:        config.MaxConnsPerHost,
		MaxResponseHeaderBytes: config.MaxResponseHeaderBytes,
		WriteBufferSize:        config.WriteBufferSize,
		ReadBufferSize:         config.ReadBufferSize,
		DisableKeepAlives:      config.DisableKeepAlives,
		DisableCompression:     config.DisableCompression,
	}
	if config.IdleConnTimeoutMs != nil {
		if *config.IdleConnTimeoutMs > math.MaxInt64/int64(time.Millisecond) {
			return nil, errors.New("transport.idleConnTimeoutMs is outside the supported range")
		}
		duration := time.Duration(*config.IdleConnTimeoutMs) * time.Millisecond
		options.IdleConnTimeout = &duration
	}
	return options, nil
}

func buildCustomProfile(profile protocol.CustomProfileMeta) (profiles.ClientProfile, error) {
	if err := validateCustomProfile(profile); err != nil {
		return profiles.ClientProfile{}, err
	}
	candidateSuites := make([]tlsClient.CandidateCipherSuites, len(profile.ECHCandidateCipherSuites))
	for index, suite := range profile.ECHCandidateCipherSuites {
		candidateSuites[index] = tlsClient.CandidateCipherSuites{KdfId: suite.KdfID, AeadId: suite.AeadID}
	}
	specFactory, err := tlsClient.GetSpecFactoryFromJa3String(
		profile.Ja3String,
		profile.SupportedSignatureAlgorithms,
		profile.SupportedDelegatedCredentialsAlgorithms,
		profile.SupportedVersions,
		profile.KeyShareCurves,
		profile.ALPNProtocols,
		profile.ALPSProtocols,
		candidateSuites,
		profile.ECHCandidatePayloads,
		profile.CertCompressionAlgos,
		profile.RecordSizeLimit,
	)
	if err != nil {
		return profiles.ClientProfile{}, err
	}

	h2Settings := make(map[http2.SettingID]uint32, len(profile.H2Settings))
	for name, value := range profile.H2Settings {
		h2Settings[tlsClient.H2SettingsMap[name]] = value
	}
	h2SettingsOrder := make([]http2.SettingID, len(profile.H2SettingsOrder))
	for index, name := range profile.H2SettingsOrder {
		h2SettingsOrder[index] = tlsClient.H2SettingsMap[name]
	}
	var headerPriority *http2.PriorityParam
	if profile.HeaderPriority != nil {
		headerPriority = &http2.PriorityParam{
			StreamDep: profile.HeaderPriority.StreamDep,
			Exclusive: profile.HeaderPriority.Exclusive,
			Weight:    profile.HeaderPriority.Weight,
		}
	}
	priorityFrames := make([]http2.Priority, len(profile.PriorityFrames))
	for index, frame := range profile.PriorityFrames {
		priorityFrames[index] = http2.Priority{
			StreamID: frame.StreamID,
			PriorityParam: http2.PriorityParam{
				StreamDep: frame.PriorityParam.StreamDep,
				Exclusive: frame.PriorityParam.Exclusive,
				Weight:    frame.PriorityParam.Weight,
			},
		}
	}
	h3Settings := make(map[uint64]uint64, len(profile.H3Settings))
	for name, value := range profile.H3Settings {
		h3Settings[tlsClient.H3SettingsMap[name]] = value
	}
	h3SettingsOrder := make([]uint64, len(profile.H3SettingsOrder))
	for index, name := range profile.H3SettingsOrder {
		h3SettingsOrder[index] = tlsClient.H3SettingsMap[name]
	}
	clientHelloID := utls.ClientHelloID{
		Client:      "Custom",
		Version:     "1",
		SpecFactory: specFactory,
	}
	return profiles.NewClientProfile(
		clientHelloID,
		h2Settings,
		h2SettingsOrder,
		profile.PseudoHeaderOrder,
		profile.ConnectionFlow,
		priorityFrames,
		headerPriority,
		profile.StreamID,
		profile.AllowHTTP,
		h3Settings,
		h3SettingsOrder,
		profile.H3PriorityParam,
		profile.H3PseudoHeaderOrder,
		profile.H3SendGreaseFrames,
	), nil
}

func mergeHeaderPairs(identity, request []protocol.HeaderPair) ([]protocol.HeaderPair, error) {
	if err := validateHeaderPairs(request); err != nil {
		return nil, err
	}
	requestNames := make(map[string]struct{}, len(request))
	for _, pair := range request {
		requestNames[strings.ToLower(pair[0])] = struct{}{}
	}
	merged := make([]protocol.HeaderPair, 0, len(identity)+len(request))
	for _, pair := range identity {
		if _, overridden := requestNames[strings.ToLower(pair[0])]; !overridden {
			merged = append(merged, pair)
		}
	}
	return append(merged, request...), nil
}

func requestHeaders(identity protocol.IdentityMeta, request protocol.RequestMeta) (http.Header, error) {
	identityHeaders := identity.Headers
	merged, err := mergeHeaderPairs(identityHeaders, request.Headers)
	if err != nil {
		return nil, err
	}
	if err := validateHeaderOrder(request.HeaderOrder); err != nil {
		return nil, err
	}
	if err := validateHeaderOrder(identity.HeaderOrder); err != nil {
		return nil, err
	}
	headers := make(http.Header, len(merged)+1)
	for _, pair := range merged {
		key := http.CanonicalHeaderKey(pair[0])
		headers[key] = append(headers[key], pair[1])
	}
	order := request.HeaderOrder
	if order == nil {
		order = identity.HeaderOrder
	}
	order = completeHeaderOrder(order, merged)
	if len(order) > 0 {
		headers[http.HeaderOrderKey] = lowerHeaderOrder(order)
	}
	return headers, nil
}

func hasHeader(headers http.Header, name string) bool {
	for key := range headers {
		if strings.EqualFold(key, name) {
			return true
		}
	}
	return false
}

func headerOrder(pairs []protocol.HeaderPair) []string {
	seen := make(map[string]struct{}, len(pairs))
	order := make([]string, 0, len(pairs))
	for _, pair := range pairs {
		name := strings.ToLower(pair[0])
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		order = append(order, name)
	}
	return order
}

func lowerHeaderOrder(order []string) []string {
	lower := make([]string, len(order))
	for index, name := range order {
		lower[index] = strings.ToLower(name)
	}
	return lower
}

func completeHeaderOrder(order []string, pairs []protocol.HeaderPair) []string {
	result := make([]string, 0, len(pairs))
	seen := make(map[string]struct{}, len(pairs))
	for _, name := range order {
		name = strings.ToLower(name)
		if name == "" {
			continue
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		result = append(result, name)
	}
	for _, name := range headerOrder(pairs) {
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		result = append(result, name)
	}
	return result
}

func validateHeaderOrder(order []string) error {
	for _, name := range order {
		if strings.TrimSpace(name) == "" {
			return errors.New("header order names cannot be empty")
		}
		if strings.EqualFold(name, http.HeaderOrderKey) || strings.EqualFold(name, http.PHeaderOrderKey) {
			return fmt.Errorf("reserved header name %q", name)
		}
	}
	return nil
}

func responseHeaders(response *http.Response) []protocol.HeaderPair {
	orderedKeys := make([]string, 0, len(response.Header))
	seen := make(map[string]struct{}, len(response.Header))
	for _, ordered := range response.Header[http.HeaderOrderKey] {
		for key := range response.Header {
			if strings.EqualFold(key, ordered) {
				if _, ok := seen[key]; !ok {
					seen[key] = struct{}{}
					orderedKeys = append(orderedKeys, key)
				}
				break
			}
		}
	}
	remaining := make([]string, 0, len(response.Header))
	for key := range response.Header {
		if key == http.HeaderOrderKey || key == http.PHeaderOrderKey {
			continue
		}
		if _, ok := seen[key]; !ok {
			remaining = append(remaining, key)
		}
	}
	sort.SliceStable(remaining, func(i, j int) bool { return strings.ToLower(remaining[i]) < strings.ToLower(remaining[j]) })
	orderedKeys = append(orderedKeys, remaining...)
	pairs := make([]protocol.HeaderPair, 0)
	for _, key := range orderedKeys {
		for _, value := range response.Header[key] {
			pairs = append(pairs, protocol.HeaderPair{key, value})
		}
	}
	return pairs
}

func responseURL(response *http.Response) string {
	if response.Request == nil || response.Request.URL == nil {
		return ""
	}
	result := *response.Request.URL
	result.Fragment = ""
	return result.String()
}

func responseProtocol(response *http.Response) string {
	switch response.Proto {
	case "HTTP/1.1", "HTTP/2.0", "HTTP/3.0":
		return response.Proto
	default:
		if response.ProtoMajor == 2 {
			return "HTTP/2.0"
		}
		if response.ProtoMajor == 3 {
			return "HTTP/3.0"
		}
		return "HTTP/1.1"
	}
}

func classifyRequestError(err error) protocol.ErrorKind {
	if err == nil {
		return protocol.ErrorKindUnknown
	}
	if errors.Is(err, context.Canceled) {
		return protocol.ErrorKindCancelled
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return protocol.ErrorKindTimeout
	}
	if errors.Is(err, tlsClient.ErrBadPinDetected) {
		return protocol.ErrorKindPinning
	}
	var dnsError *net.DNSError
	if errors.As(err, &dnsError) {
		return protocol.ErrorKindDns
	}
	var certificateError x509.CertificateInvalidError
	if errors.As(err, &certificateError) {
		return protocol.ErrorKindTls
	}
	var unknownAuthority x509.UnknownAuthorityError
	if errors.As(err, &unknownAuthority) {
		return protocol.ErrorKindTls
	}
	var recordHeader tls.RecordHeaderError
	if errors.As(err, &recordHeader) {
		return protocol.ErrorKindTls
	}
	var protocolError *http.ProtocolError
	if errors.As(err, &protocolError) {
		return protocol.ErrorKindHttp
	}
	var operationError *net.OpError
	if errors.As(err, &operationError) {
		operation := strings.ToLower(operationError.Op)
		if operation == "proxyconnect" || strings.HasPrefix(operation, "socks ") {
			return protocol.ErrorKindProxy
		}
	}
	var networkError net.Error
	if errors.As(err, &networkError) {
		if networkError.Timeout() {
			return protocol.ErrorKindTimeout
		}
		return protocol.ErrorKindConnect
	}
	var urlError *url.Error
	if errors.As(err, &urlError) {
		return protocol.ErrorKindConnect
	}
	return protocol.ErrorKindUnknown
}

func closeRequestUpload(op *operation) {
	if op.upload != nil {
		op.upload.close()
	}
}

func waitRequestUpload(op *operation) {
	if op.upload != nil {
		op.upload.wait()
	}
}

func requestCookie(cookie protocol.CookieMeta) (*http.Cookie, error) {
	if cookie.Name == "" {
		return nil, errors.New("cookie name is required")
	}
	result := &http.Cookie{
		Name:     cookie.Name,
		Value:    cookie.Value,
		Domain:   cookie.Domain,
		Path:     cookie.Path,
		Secure:   cookie.Secure,
		HttpOnly: cookie.HttpOnly,
	}
	if result.String() == "" {
		return nil, errors.New("cookie name is invalid")
	}
	if cookie.Expires != nil {
		result.Expires = time.Unix(*cookie.Expires, 0).UTC()
	}
	switch cookie.SameSite {
	case "", "Lax":
		if cookie.SameSite == "Lax" {
			result.SameSite = http.SameSiteLaxMode
		}
	case "Strict":
		result.SameSite = http.SameSiteStrictMode
	case "None":
		result.SameSite = http.SameSiteNoneMode
	default:
		return nil, fmt.Errorf("unknown cookie sameSite %q", cookie.SameSite)
	}
	return result, nil
}

func setRequestCookies(client tlsClient.HttpClient, parsedURL *url.URL, cookies []protocol.CookieMeta) error {
	if len(cookies) == 0 {
		return nil
	}
	converted := make([]*http.Cookie, 0, len(cookies))
	for _, cookie := range cookies {
		convertedCookie, err := requestCookie(cookie)
		if err != nil {
			return err
		}
		converted = append(converted, convertedCookie)
	}
	client.SetCookies(parsedURL, converted)
	return nil
}

func (d *dispatcher) runRequest(ctx context.Context, op *operation, meta protocol.RequestMeta) {
	var session *tlsSession
	ephemeral := false
	retired := false
	retireEphemeral := func() {
		if ephemeral && session != nil && !retired {
			d.retireSession(session)
			retired = true
		}
	}
	fail := func(kind protocol.ErrorKind, message string) {
		closeRequestUpload(op)
		retireEphemeral()
		_ = d.finishError(op, kind, message)
	}
	if meta.SessionID != "" {
		var ok bool
		session, ok = d.sessions.get(meta.SessionID)
		if !ok {
			fail(protocol.ErrorKindSessionNotFound, fmt.Sprintf("session %q was not found", meta.SessionID))
			return
		}
	} else {
		if meta.Config == nil {
			fail(protocol.ErrorKindInvalidConfig, "sessionId or config is required")
			return
		}
		config := *meta.Config
		config.SessionID = fmt.Sprintf("request-%d", op.id)
		var err error
		session, err = buildSession(config)
		if err != nil {
			fail(protocol.ErrorKindSessionConfig, err.Error())
			return
		}
		ephemeral = true
		defer session.closeIdleConnections()
		defer retireEphemeral()
	}
	if meta.TimeoutMs != nil && *meta.TimeoutMs < 0 {
		fail(protocol.ErrorKindInvalidConfig, "timeoutMs cannot be negative")
		return
	}
	if meta.ContentLength != nil && *meta.ContentLength < 0 {
		fail(protocol.ErrorKindInvalidConfig, "contentLength cannot be negative")
		return
	}
	if !meta.HasBody && meta.ContentLength != nil && *meta.ContentLength != 0 {
		fail(protocol.ErrorKindInvalidConfig, "contentLength requires a request body")
		return
	}
	if meta.HasBody && op.upload == nil {
		fail(protocol.ErrorKindInvalidConfig, "request body upload is not initialized")
		return
	}
	if err := validateHeaderPairs(meta.Headers); err != nil {
		fail(protocol.ErrorKindInvalidConfig, err.Error())
		return
	}

	timeoutMs := session.timeoutMs
	if meta.TimeoutMs != nil {
		timeoutMs = *meta.TimeoutMs
	}
	requestContext := ctx
	cancel := func() {}
	if timeoutMs > 0 {
		if timeoutMs > math.MaxInt64/int64(time.Millisecond) {
			fail(protocol.ErrorKindInvalidConfig, "timeoutMs is outside the supported range")
			return
		}
		requestContext, cancel = context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	}
	defer cancel()

	parsedURL, err := url.Parse(meta.URL)
	if err != nil || parsedURL.Scheme == "" || parsedURL.Host == "" || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") {
		message := "request URL must be an absolute http or https URL"
		if err != nil {
			message = err.Error()
		}
		fail(protocol.ErrorKindInvalidUrl, message)
		return
	}
	method := meta.Method
	if method == "" {
		method = http.MethodGet
	}
	var body io.Reader
	if op.upload != nil {
		body = op.upload.reader
	}
	req, err := http.NewRequestWithContext(requestContext, method, parsedURL.String(), body)
	if err != nil {
		fail(protocol.ErrorKindInvalidUrl, err.Error())
		return
	}
	if meta.ContentLength != nil {
		req.ContentLength = *meta.ContentLength
	}
	if requestHeaders, headerErr := requestHeaders(session.identity, meta); headerErr != nil {
		fail(protocol.ErrorKindInvalidConfig, headerErr.Error())
		return
	} else {
		req.Header = requestHeaders
	}
	if contentLengthHeader := req.Header.Get("Content-Length"); contentLengthHeader != "" {
		contentLength, parseErr := strconv.ParseInt(contentLengthHeader, 10, 64)
		if parseErr != nil || contentLength < 0 {
			fail(protocol.ErrorKindInvalidConfig, "content-length must be a non-negative integer")
			return
		}
		if meta.ContentLength != nil && *meta.ContentLength != contentLength {
			fail(protocol.ErrorKindInvalidConfig, "content-length header does not match contentLength")
			return
		}
		if !meta.HasBody && contentLength != 0 {
			fail(protocol.ErrorKindInvalidConfig, "content-length requires a request body")
			return
		}
		if meta.ContentLength == nil {
			req.ContentLength = contentLength
		}
		req.Header.Del("Content-Length")
	}
	if meta.HostOverride != "" {
		req.Host = meta.HostOverride
	}
	client, bandwidthBefore, releaseBandwidth, acquireErr := session.beginTrackedRequest(requestContext, meta.FollowRedirects)
	if acquireErr != nil {
		fail(classifyRequestError(acquireErr), acquireErr.Error())
		return
	}
	defer releaseBandwidth()
	if err := setRequestCookies(client, parsedURL, meta.Cookies); err != nil {
		fail(protocol.ErrorKindInvalidConfig, err.Error())
		return
	}
	if hasHeader(req.Header, "Cookie") {
		if jar, ok := client.GetCookieJar().(*sessionCookieJar); ok {
			jar.skipAutomaticCookies()
			defer jar.clearAutomaticCookieSkip()
		}
	}
	response, err := client.Do(req)
	if err != nil {
		kind := classifyRequestError(err)
		if requestContext.Err() != nil {
			kind = classifyRequestError(requestContext.Err())
		}
		fail(kind, err.Error())
		return
	}
	defer response.Body.Close()

	protocolName := responseProtocol(response)
	headersMeta, err := protocol.EncodeMeta(protocol.ResponseHeadersMeta{
		Status:   response.StatusCode,
		URL:      responseURL(response),
		Headers:  responseHeaders(response),
		Protocol: protocolName,
	})
	if err != nil {
		fail(protocol.ErrorKindInternal, err.Error())
		return
	}
	if op.upload != nil {
		op.upload.abortIfIncomplete(errUploadResponse)
	}
	if !d.isCurrent(op) {
		closeRequestUpload(op)
		return
	}
	if err := d.writer.Write(protocol.Frame{Kind: protocol.KindHeaders, ID: op.id, Meta: headersMeta}); err != nil {
		closeRequestUpload(op)
		d.remove(op)
		return
	}

	for {
		if requestErr := requestContext.Err(); requestErr != nil {
			fail(classifyRequestError(requestErr), requestErr.Error())
			return
		}
		requested, allowed := op.credits.reserve(requestContext, d.settings.chunkSize)
		if !allowed {
			requestErr := requestContext.Err()
			if requestErr == nil {
				requestErr = context.Canceled
			}
			fail(classifyRequestError(requestErr), requestErr.Error())
			return
		}
		buffer := make([]byte, requested)
		read, readErr := response.Body.Read(buffer)
		if read < int(requested) {
			op.credits.ack(requested - uint64(read))
		}
		if read > 0 {
			if !d.isCurrent(op) {
				closeRequestUpload(op)
				return
			}
			if err := d.writer.Write(protocol.Frame{
				Kind: protocol.KindChunk,
				ID:   op.id,
				Meta: []byte(`{}`),
				Body: buffer[:read],
			}); err != nil {
				closeRequestUpload(op)
				d.remove(op)
				return
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			kind := classifyRequestError(readErr)
			if requestContext.Err() != nil {
				kind = classifyRequestError(requestContext.Err())
			}
			fail(kind, readErr.Error())
			return
		}
	}

	waitRequestUpload(op)
	bandwidthAfter := snapshotBandwidth(client)
	endMeta, err := protocol.EncodeMeta(protocol.EndMeta{
		Protocol:     protocolName,
		BytesRead:    bandwidthDelta(bandwidthBefore.read, bandwidthAfter.read),
		BytesWritten: bandwidthDelta(bandwidthBefore.written, bandwidthAfter.written),
	})
	if err != nil {
		fail(protocol.ErrorKindInternal, err.Error())
		return
	}
	retireEphemeral()
	_ = d.finish(op, protocol.Frame{Kind: protocol.KindEnd, ID: op.id, Meta: endMeta})
}
