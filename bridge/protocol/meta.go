package protocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"unicode/utf8"
)

const (
	DefaultWindow    uint64 = 1024 * 1024
	DefaultChunkSize uint64 = 64 * 1024
)

// Plain structs with json tags intentionally use encoding/json's default
// unknown-field behavior: additive metadata is forward-compatible (D18).

// HelloMeta is the meta of a JS -> Go hello frame.
type HelloMeta struct {
	ProtocolVersion int    `json:"protocolVersion"`
	ClientVersion   string `json:"clientVersion"`
	Window          uint64 `json:"window,omitempty"`
	ChunkSize       uint64 `json:"chunkSize,omitempty"`
}

// HelloAckMeta is the meta of a Go -> JS helloAck frame.
type HelloAckMeta struct {
	ProtocolVersion  int    `json:"protocolVersion"`
	BridgeVersion    string `json:"bridgeVersion"`
	TlsClientVersion string `json:"tlsClientVersion"`
	GoVersion        string `json:"goVersion"`
	Window           uint64 `json:"window,omitempty"`
	ChunkSize        uint64 `json:"chunkSize,omitempty"`
}

// EmptyMeta is the metadata of frames with no payload.
type EmptyMeta struct{}

// HeaderPair is one ordered HTTP header name and value.
type HeaderPair [2]string

// CookieMeta is one cookie supplied with a request.
type CookieMeta struct {
	Name     string `json:"name"`
	Value    string `json:"value"`
	Domain   string `json:"domain"`
	Path     string `json:"path"`
	Origin   string `json:"origin,omitempty"`
	Expires  *int64 `json:"expires"`
	Secure   bool   `json:"secure"`
	HttpOnly bool   `json:"httpOnly"`
	SameSite string `json:"sameSite,omitempty"`
}

// IdentityMeta contains the fixed headers attached to every session request.
type IdentityMeta struct {
	Headers     []HeaderPair `json:"headers,omitempty"`
	HeaderOrder []string     `json:"headerOrder,omitempty"`
}

// PriorityParamMeta describes one HTTP/2 priority parameter.
type PriorityParamMeta struct {
	StreamDep uint32 `json:"streamDep"`
	Exclusive bool   `json:"exclusive"`
	Weight    uint8  `json:"weight"`
}

// PriorityFrameMeta describes one HTTP/2 priority frame in a custom profile.
type PriorityFrameMeta struct {
	PriorityParam PriorityParamMeta `json:"priorityParam"`
	StreamID      uint32            `json:"streamID"`
}

// CandidateCipherSuiteMeta describes one ECH candidate cipher suite.
type CandidateCipherSuiteMeta struct {
	KdfID  string `json:"kdfId"`
	AeadID string `json:"aeadId"`
}

// CustomProfileMeta mirrors tls-client's customTlsClient input.
type CustomProfileMeta struct {
	H2Settings                              map[string]uint32          `json:"h2Settings,omitempty"`
	H2SettingsOrder                         []string                   `json:"h2SettingsOrder,omitempty"`
	H3Settings                              map[string]uint64          `json:"h3Settings,omitempty"`
	H3SettingsOrder                         []string                   `json:"h3SettingsOrder,omitempty"`
	H3PseudoHeaderOrder                     []string                   `json:"h3PseudoHeaderOrder,omitempty"`
	HeaderPriority                          *PriorityParamMeta         `json:"headerPriority,omitempty"`
	CertCompressionAlgos                    []string                   `json:"certCompressionAlgos,omitempty"`
	Ja3String                               string                     `json:"ja3String,omitempty"`
	KeyShareCurves                          []string                   `json:"keyShareCurves,omitempty"`
	ALPNProtocols                           []string                   `json:"alpnProtocols,omitempty"`
	ALPSProtocols                           []string                   `json:"alpsProtocols,omitempty"`
	ECHCandidatePayloads                    []uint16                   `json:"ECHCandidatePayloads,omitempty"`
	ECHCandidateCipherSuites                []CandidateCipherSuiteMeta `json:"ECHCandidateCipherSuites,omitempty"`
	PriorityFrames                          []PriorityFrameMeta        `json:"priorityFrames,omitempty"`
	PseudoHeaderOrder                       []string                   `json:"pseudoHeaderOrder,omitempty"`
	SupportedDelegatedCredentialsAlgorithms []string                   `json:"supportedDelegatedCredentialsAlgorithms,omitempty"`
	SupportedSignatureAlgorithms            []string                   `json:"supportedSignatureAlgorithms,omitempty"`
	SupportedVersions                       []string                   `json:"supportedVersions,omitempty"`
	ConnectionFlow                          uint32                     `json:"connectionFlow,omitempty"`
	RecordSizeLimit                         uint16                     `json:"recordSizeLimit,omitempty"`
	StreamID                                uint32                     `json:"streamId,omitempty"`
	H3PriorityParam                         uint32                     `json:"h3PriorityParam,omitempty"`
	H3SendGreaseFrames                      bool                       `json:"h3SendGreaseFrames,omitempty"`
	AllowHTTP                               bool                       `json:"allowHttp,omitempty"`
}

// SessionConfigMeta is the metadata of a JS -> Go session.create frame.
type SessionConfigMeta struct {
	SessionID               string              `json:"sessionId"`
	Profile                 *string             `json:"profile,omitempty"`
	CustomProfile           *CustomProfileMeta  `json:"customProfile,omitempty"`
	Identity                *IdentityMeta       `json:"identity,omitempty"`
	TimeoutMs               *int64              `json:"timeoutMs,omitempty"`
	FollowRedirects         *bool               `json:"followRedirects,omitempty"`
	ProxyURL                string              `json:"proxyUrl,omitempty"`
	InsecureSkipVerify      bool                `json:"insecureSkipVerify,omitempty"`
	RandomTLSExtensionOrder bool                `json:"randomTlsExtensionOrder,omitempty"`
	DisableSessionTickets   bool                `json:"disableSessionTickets,omitempty"`
	ForceHTTP1              bool                `json:"forceHttp1,omitempty"`
	DisableHTTP3            bool                `json:"disableHttp3,omitempty"`
	ProtocolRacing          bool                `json:"protocolRacing,omitempty"`
	DisableIPv4             bool                `json:"disableIpv4,omitempty"`
	DisableIPv6             bool                `json:"disableIpv6,omitempty"`
	LocalAddress            string              `json:"localAddress,omitempty"`
	ServerName              string              `json:"serverName,omitempty"`
	CertificatePins         map[string][]string `json:"certificatePins,omitempty"`
	CookieJar               string              `json:"cookieJar,omitempty"`
	Transport               *TransportMeta      `json:"transport,omitempty"`
}

// TransportMeta contains the transport knobs accepted by tls-client.
type TransportMeta struct {
	IdleConnTimeoutMs      *int64 `json:"idleConnTimeoutMs,omitempty"`
	MaxIdleConns           int    `json:"maxIdleConns,omitempty"`
	MaxIdleConnsPerHost    int    `json:"maxIdleConnsPerHost,omitempty"`
	MaxConnsPerHost        int    `json:"maxConnsPerHost,omitempty"`
	MaxResponseHeaderBytes int64  `json:"maxResponseHeaderBytes,omitempty"`
	WriteBufferSize        int    `json:"writeBufferSize,omitempty"`
	ReadBufferSize         int    `json:"readBufferSize,omitempty"`
	DisableKeepAlives      bool   `json:"disableKeepAlives,omitempty"`
	DisableCompression     bool   `json:"disableCompression,omitempty"`
}

// SessionIDMeta identifies a session operation.
type SessionIDMeta struct {
	SessionID string `json:"sessionId"`
}

// SessionProxyMeta changes the live proxy for a session. A null proxyUrl
// clears proxy routing; the pointer distinguishes null from a missing field.
type SessionProxyMeta struct {
	SessionID string  `json:"sessionId"`
	ProxyURL  *string `json:"proxyUrl"`
}

// CookiesGetMeta reads cookies selected for a URL.
type CookiesGetMeta struct {
	SessionID string `json:"sessionId"`
	URL       string `json:"url"`
}

// CookiesSetMeta writes cookies selected for a URL.
type CookiesSetMeta struct {
	SessionID string       `json:"sessionId"`
	URL       string       `json:"url"`
	Cookies   []CookieMeta `json:"cookies"`
}

// CookiesExportMeta exports every cookie in a session Jar.
type CookiesExportMeta struct {
	SessionID string `json:"sessionId"`
}

// CookiesImportMeta imports every cookie in a session Jar.
type CookiesImportMeta struct {
	SessionID string       `json:"sessionId"`
	Cookies   []CookieMeta `json:"cookies"`
}

// CookiesResultMeta is the result of a cookies.get/export operation.
type CookiesResultMeta struct {
	Cookies []CookieMeta `json:"cookies"`
}

// RequestMeta is the metadata of a JS -> Go request frame.
type RequestMeta struct {
	SessionID       string             `json:"sessionId,omitempty"`
	Config          *SessionConfigMeta `json:"config,omitempty"`
	URL             string             `json:"url"`
	Method          string             `json:"method"`
	Headers         []HeaderPair       `json:"headers,omitempty"`
	HeaderOrder     []string           `json:"headerOrder,omitempty"`
	HasBody         bool               `json:"hasBody,omitempty"`
	ContentLength   *int64             `json:"contentLength,omitempty"`
	TimeoutMs       *int64             `json:"timeoutMs,omitempty"`
	FollowRedirects *bool              `json:"followRedirects,omitempty"`
	HostOverride    string             `json:"hostOverride,omitempty"`
	Cookies         []CookieMeta       `json:"cookies,omitempty"`
}

// BodyChunkMeta is the metadata of a JS -> Go body.chunk frame.
type BodyChunkMeta struct{}

// BodyEndMeta is the metadata of a JS -> Go body.end frame.
type BodyEndMeta struct{}

// ResponseHeadersMeta is the first response frame for a request.
type ResponseHeadersMeta struct {
	Status   int          `json:"status"`
	URL      string       `json:"url"`
	Headers  []HeaderPair `json:"headers"`
	Protocol string       `json:"protocol"`
}

// CancelMeta is the metadata of a JS -> Go cancel frame.
type CancelMeta struct{}

// AckMeta is the metadata of a JS -> Go credit acknowledgement.
type AckMeta struct {
	Bytes uint64 `json:"bytes"`
}

// DebugSleepMeta is the metadata of the cancellable debug.sleep operation.
type DebugSleepMeta struct {
	Ms uint64 `json:"ms"`
}

// DebugStreamMeta is the metadata of the credited debug.stream operation.
type DebugStreamMeta struct {
	Chunks uint64 `json:"chunks"`
	Size   uint64 `json:"size"`
}

// ChunkMeta is the metadata of a raw Go -> JS chunk frame.
type ChunkMeta struct{}

// EndMeta is the terminal metadata for a streamed operation.
type EndMeta struct {
	Protocol     string `json:"protocol,omitempty"`
	BytesRead    uint64 `json:"bytesRead"`
	BytesWritten uint64 `json:"bytesWritten"`
}

// ErrorKind is the closed set of error classifications from protocol v1.
type ErrorKind string

const (
	ErrorKindInvalidConfig   ErrorKind = "InvalidConfig"
	ErrorKindInvalidUrl      ErrorKind = "InvalidUrl"
	ErrorKindDns             ErrorKind = "Dns"
	ErrorKindConnect         ErrorKind = "Connect"
	ErrorKindTls             ErrorKind = "Tls"
	ErrorKindProxy           ErrorKind = "Proxy"
	ErrorKindTimeout         ErrorKind = "Timeout"
	ErrorKindCancelled       ErrorKind = "Cancelled"
	ErrorKindHttp            ErrorKind = "Http"
	ErrorKindBody            ErrorKind = "Body"
	ErrorKindPinning         ErrorKind = "Pinning"
	ErrorKindSessionNotFound ErrorKind = "SessionNotFound"
	ErrorKindSessionConfig   ErrorKind = "SessionConfig"
	ErrorKindWsHandshake     ErrorKind = "WsHandshake"
	ErrorKindWsRead          ErrorKind = "WsRead"
	ErrorKindWsWrite         ErrorKind = "WsWrite"
	ErrorKindProtocol        ErrorKind = "Protocol"
	ErrorKindInternal        ErrorKind = "Internal"
	ErrorKindUnknown         ErrorKind = "Unknown"
)

// ErrorMeta is the meta of a Go -> JS error frame.
type ErrorMeta struct {
	Kind    ErrorKind              `json:"kind"`
	Message string                 `json:"message"`
	Detail  map[string]interface{} `json:"detail,omitempty"`
}

// DecodeObject decodes a JSON object while preserving encoding/json's
// forward-compatible unknown-field behavior. It rejects empty, null, arrays,
// and trailing data so malformed metadata cannot reach the dispatcher.
func DecodeObject(data []byte, destination interface{}) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return fmt.Errorf("%w: metadata is empty", ErrProtocol)
	}
	if trimmed[0] != '{' {
		return fmt.Errorf("%w: metadata must be a JSON object", ErrProtocol)
	}
	if !utf8.Valid(trimmed) {
		return fmt.Errorf("%w: metadata is not valid UTF-8", ErrProtocol)
	}
	if err := json.Unmarshal(trimmed, destination); err != nil {
		return fmt.Errorf("%w: invalid metadata JSON: %v", ErrProtocol, err)
	}
	return nil
}

// DecodeEmpty accepts either the contract's {} object or an omitted metadata
// value (the frame format permits mlen=0).
func DecodeEmpty(data []byte) error {
	if len(data) == 0 {
		return nil
	}
	var empty EmptyMeta
	return DecodeObject(data, &empty)
}

// EncodeMeta keeps all Go-generated metadata compact and deterministic.
func EncodeMeta(value interface{}) ([]byte, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("encode metadata: %w", err)
	}
	return data, nil
}
