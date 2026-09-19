package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"github.com/bogdanfinn/fhttp/cookiejar"
	"io"
	"math"
	"net"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	http "github.com/bogdanfinn/fhttp"
	"github.com/bogdanfinn/fhttp/http2"
	tlsClient "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
	utls "github.com/bogdanfinn/utls"

	"github.com/yovanoc/effect-tls-client/bridge/protocol"
)

type tlsSession struct {
	id         string
	client     tlsClient.HttpClient
	identity   protocol.IdentityMeta
	redirectMu sync.Mutex
}

func (s *tlsSession) do(request *http.Request, followRedirects *bool) (*http.Response, error) {
	s.redirectMu.Lock()
	defer s.redirectMu.Unlock()
	if followRedirects != nil {
		previous := s.client.GetFollowRedirect()
		s.client.SetFollowRedirect(*followRedirects)
		defer s.client.SetFollowRedirect(previous)
	}
	return s.client.Do(request)
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

func (s *sessionStore) closeAll() {
	s.mu.Lock()
	sessions := make([]*tlsSession, 0, len(s.sessions))
	for id, session := range s.sessions {
		delete(s.sessions, id)
		sessions = append(sessions, session)
	}
	s.mu.Unlock()
	for _, session := range sessions {
		session.client.CloseIdleConnections()
	}
}

func (d *dispatcher) runSessionCreate(_ context.Context, op *operation, config protocol.SessionConfigMeta) {
	session, err := buildSession(config)
	if err != nil {
		_ = d.finishError(op, protocol.ErrorKindSessionConfig, err.Error())
		return
	}
	if err := d.sessions.add(session); err != nil {
		session.client.CloseIdleConnections()
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
	d.cancelSession(meta.SessionID)
	session.client.CloseIdleConnections()
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
	options := []tlsClient.HttpClientOption{
		tlsClient.WithClientProfile(clientProfile),
		tlsClient.WithTimeoutMilliseconds(int(timeoutMs)),
		tlsClient.WithBandwidthTracker(),
	}

	followRedirects := false
	if config.FollowRedirects != nil {
		followRedirects = *config.FollowRedirects
	}
	if !followRedirects {
		options = append(options, tlsClient.WithNotFollowRedirects())
	}
	if config.ProxyURL != "" {
		options = append(options, tlsClient.WithProxyUrl(config.ProxyURL))
	}
	if config.InsecureSkipVerify {
		options = append(options, tlsClient.WithInsecureSkipVerify())
	}
	if config.RandomTLSExtensionOrder {
		options = append(options, tlsClient.WithRandomTLSExtensionOrder())
	}
	if config.DisableSessionTickets {
		options = append(options, tlsClient.WithDisableSessionTickets())
	}
	if config.ForceHTTP1 {
		options = append(options, tlsClient.WithForceHttp1())
	}
	if config.DisableHTTP3 {
		options = append(options, tlsClient.WithDisableHttp3())
	}
	if config.ProtocolRacing {
		options = append(options, tlsClient.WithProtocolRacing())
	}
	if config.DisableIPv4 {
		options = append(options, tlsClient.WithDisableIPV4())
	}
	if config.DisableIPv6 {
		options = append(options, tlsClient.WithDisableIPV6())
	}
	if config.ServerName != "" {
		options = append(options, tlsClient.WithServerNameOverwrite(config.ServerName))
	}
	if len(config.CertificatePins) > 0 {
		options = append(options, tlsClient.WithCertificatePinning(config.CertificatePins, nil))
	}
	if config.LocalAddress != "" {
		address, err := net.ResolveTCPAddr("", config.LocalAddress)
		if err != nil {
			return nil, fmt.Errorf("localAddress: %w", err)
		}
		options = append(options, tlsClient.WithLocalAddr(*address))
	}
	if config.Transport != nil {
		transport, err := makeTransportOptions(*config.Transport)
		if err != nil {
			return nil, err
		}
		options = append(options, tlsClient.WithTransportOptions(transport))
	}

	jarMode := config.CookieJar
	if jarMode == "" || jarMode == "default" {
		jar, err := cookiejar.New(nil)
		if err != nil {
			return nil, fmt.Errorf("cookie jar: %w", err)
		}
		options = append(options, tlsClient.WithCookieJar(jar))
	} else if jarMode == "strict" {
		options = append(options, tlsClient.WithCookieJar(tlsClient.NewCookieJar()))
	}

	client, err := tlsClient.NewHttpClient(tlsClient.NewNoopLogger(), options...)
	if err != nil {
		return nil, err
	}
	identity := protocol.IdentityMeta{}
	if config.Identity != nil {
		identity = *config.Identity
	}
	return &tlsSession{id: config.SessionID, client: client, identity: identity}, nil
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
	if errors.As(err, &operationError) && strings.Contains(strings.ToLower(operationError.Op), "proxy") {
		return protocol.ErrorKindProxy
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "proxy") || strings.Contains(message, "socks") {
		return protocol.ErrorKindProxy
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

func (d *dispatcher) runRequest(ctx context.Context, op *operation, meta protocol.RequestMeta) {
	session, ok := d.sessions.get(meta.SessionID)
	if !ok {
		_ = d.finishErrorDetail(op, protocol.ErrorKindSessionNotFound, fmt.Sprintf("session %q was not found", meta.SessionID), map[string]interface{}{"sessionId": meta.SessionID})
		return
	}
	if meta.Method != "GET" && meta.Method != "" {
		_ = d.finishError(op, protocol.ErrorKindInvalidConfig, "issue #5 only supports GET requests")
		return
	}
	if meta.HasBody {
		_ = d.finishError(op, protocol.ErrorKindInvalidConfig, "request bodies are not implemented")
		return
	}
	if meta.TimeoutMs != nil && *meta.TimeoutMs < 0 {
		_ = d.finishError(op, protocol.ErrorKindInvalidConfig, "timeoutMs cannot be negative")
		return
	}
	if err := validateHeaderPairs(meta.Headers); err != nil {
		_ = d.finishError(op, protocol.ErrorKindInvalidConfig, err.Error())
		return
	}

	requestContext := ctx
	cancel := func() {}
	if meta.TimeoutMs != nil && *meta.TimeoutMs > 0 {
		if *meta.TimeoutMs > math.MaxInt64/int64(time.Millisecond) {
			_ = d.finishError(op, protocol.ErrorKindInvalidConfig, "timeoutMs is outside the supported range")
			return
		}
		requestContext, cancel = context.WithTimeout(ctx, time.Duration(*meta.TimeoutMs)*time.Millisecond)
	}
	defer cancel()

	parsedURL, err := url.Parse(meta.URL)
	if err != nil || parsedURL.Scheme == "" || parsedURL.Host == "" || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") {
		message := "request URL must be an absolute http or https URL"
		if err != nil {
			message = err.Error()
		}
		_ = d.finishError(op, protocol.ErrorKindInvalidUrl, message)
		return
	}
	req, err := http.NewRequestWithContext(requestContext, "GET", parsedURL.String(), nil)
	if err != nil {
		_ = d.finishError(op, protocol.ErrorKindInvalidUrl, err.Error())
		return
	}
	if requestHeaders, headerErr := requestHeaders(session.identity, meta); headerErr != nil {
		_ = d.finishError(op, protocol.ErrorKindInvalidConfig, headerErr.Error())
		return
	} else {
		req.Header = requestHeaders
	}
	if meta.HostOverride != "" {
		req.Host = meta.HostOverride
	}
	response, err := session.do(req, meta.FollowRedirects)
	if err != nil {
		kind := classifyRequestError(err)
		if requestContext.Err() != nil {
			kind = classifyRequestError(requestContext.Err())
		}
		_ = d.finishError(op, kind, err.Error())
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
		_ = d.finishError(op, protocol.ErrorKindInternal, err.Error())
		return
	}
	if !d.isCurrent(op) {
		return
	}
	if err := d.writer.Write(protocol.Frame{Kind: protocol.KindHeaders, ID: op.id, Meta: headersMeta}); err != nil {
		d.remove(op)
		return
	}

	var bytesRead uint64
	for {
		if requestContext.Err() != nil {
			_ = d.finishError(op, protocol.ErrorKindCancelled, "operation cancelled")
			return
		}
		requested, allowed := op.credits.reserve(requestContext, d.settings.chunkSize)
		if !allowed {
			_ = d.finishError(op, protocol.ErrorKindCancelled, "operation cancelled")
			return
		}
		buffer := make([]byte, requested)
		read, readErr := response.Body.Read(buffer)
		if read < int(requested) {
			op.credits.ack(requested - uint64(read))
		}
		if read > 0 {
			bytesRead += uint64(read)
			if !d.isCurrent(op) {
				return
			}
			if err := d.writer.Write(protocol.Frame{
				Kind: protocol.KindChunk,
				ID:   op.id,
				Meta: []byte(`{}`),
				Body: buffer[:read],
			}); err != nil {
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
			_ = d.finishError(op, kind, readErr.Error())
			return
		}
	}

	endMeta, err := protocol.EncodeMeta(protocol.EndMeta{
		Protocol:     protocolName,
		BytesRead:    bytesRead,
		BytesWritten: 0,
	})
	if err != nil {
		_ = d.finishError(op, protocol.ErrorKindInternal, err.Error())
		return
	}
	_ = d.finish(op, protocol.Frame{Kind: protocol.KindEnd, ID: op.id, Meta: endMeta})
}
