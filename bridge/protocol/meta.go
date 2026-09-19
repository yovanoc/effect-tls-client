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
