package main

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"

	tlsClient "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"

	"github.com/yovanoc/effect-tls-client/bridge/protocol"
)

type dumpField struct {
	Name      string `json:"name"`
	Type      string `json:"type"`
	KeySet    string `json:"keySet,omitempty"`
	ValueType string `json:"valueType,omitempty"`
}

type dumpCustomProfile struct {
	Fields []dumpField `json:"fields"`
}

type dumpMetadata struct {
	Profiles                                []string          `json:"profiles"`
	CustomTLSClient                         dumpCustomProfile `json:"customTlsClient"`
	H2Settings                              []string          `json:"h2Settings"`
	H3Settings                              []string          `json:"h3Settings"`
	SupportedCurves                         []string          `json:"supportedCurves"`
	SupportedVersions                       []string          `json:"supportedVersions"`
	SupportedSignatureAlgorithms            []string          `json:"supportedSignatureAlgorithms"`
	SupportedDelegatedCredentialsAlgorithms []string          `json:"supportedDelegatedCredentialsAlgorithms"`
	KDFIDs                                  []string          `json:"kdfIds"`
	AEADIDs                                 []string          `json:"aeadIds"`
	CertCompressionAlgos                    []string          `json:"certCompressionAlgos"`
	ErrorKinds                              []string          `json:"errorKinds"`
}

// These names mirror the unexported curves, tlsVersions,
// signatureAlgorithms, delegatedCredentialsAlgorithms, kdfIds, aeadIds, and
// certCompression maps in tls-client v1.16.0's mapper.go. Keep them pinned to
// that module version: numeric fallback is deliberately not part of the
// Bridge's CustomProfile contract.
var pinnedSupportedCurves = []string{
	"GREASE",
	"P256",
	"P384",
	"P521",
	"X25519",
	"P256Kyber768",
	"X25519Kyber512D",
	"X25519Kyber768",
	"X25519Kyber768Old",
	"X25519MLKEM768",
}

var pinnedSupportedVersions = []string{
	"GREASE",
	"1.3",
	"1.2",
	"1.1",
	"1.0",
}

var pinnedSupportedSignatureAlgorithms = []string{
	"PKCS1WithSHA256",
	"PKCS1WithSHA384",
	"PKCS1WithSHA512",
	"PSSWithSHA256",
	"PSSWithSHA384",
	"PSSWithSHA512",
	"ECDSAWithP256AndSHA256",
	"ECDSAWithP384AndSHA384",
	"ECDSAWithP521AndSHA512",
	"PKCS1WithSHA1",
	"ECDSAWithSHA1",
	"Ed25519",
	"SHA224_RSA",
	"SHA224_ECDSA",
}

var pinnedSupportedDelegatedCredentialsAlgorithms = []string{
	"PKCS1WithSHA256",
	"PKCS1WithSHA384",
	"PKCS1WithSHA512",
	"PSSWithSHA256",
	"PSSWithSHA384",
	"PSSWithSHA512",
	"ECDSAWithP256AndSHA256",
	"ECDSAWithP384AndSHA384",
	"ECDSAWithP521AndSHA512",
	"PKCS1WithSHA1",
	"ECDSAWithSHA1",
	"Ed25519",
	"SHA224_RSA",
	"SHA224_ECDSA",
}

var pinnedKDFIDs = []string{
	"HKDF_SHA256",
	"HKDF_SHA384",
	"HKDF_SHA512",
}

var pinnedAEADIDs = []string{
	"AEAD_AES_128_GCM",
	"AEAD_AES_256_GCM",
	"AEAD_CHACHA20_POLY1305",
}

var pinnedCertCompressionAlgos = []string{
	"zlib",
	"brotli",
	"zstd",
}

var customProfileFieldMetadata = []dumpField{
	{Name: "h2Settings", Type: "map", KeySet: "h2Settings", ValueType: "uint32"},
	{Name: "h2SettingsOrder", Type: "array", KeySet: "h2Settings", ValueType: "string"},
	{Name: "h3Settings", Type: "map", KeySet: "h3Settings", ValueType: "uint64"},
	{Name: "h3SettingsOrder", Type: "array", KeySet: "h3Settings", ValueType: "string"},
	{Name: "h3PseudoHeaderOrder", Type: "array", ValueType: "string"},
	{Name: "headerPriority", Type: "object"},
	{Name: "certCompressionAlgos", Type: "array", KeySet: "certCompressionAlgos", ValueType: "string"},
	{Name: "ja3String", Type: "string"},
	{Name: "keyShareCurves", Type: "array", KeySet: "supportedCurves", ValueType: "string"},
	{Name: "alpnProtocols", Type: "array", ValueType: "string"},
	{Name: "alpsProtocols", Type: "array", ValueType: "string"},
	{Name: "ECHCandidatePayloads", Type: "array", ValueType: "uint16"},
	{Name: "ECHCandidateCipherSuites", Type: "array", ValueType: "CandidateCipherSuiteMeta"},
	{Name: "priorityFrames", Type: "array", ValueType: "PriorityFrameMeta"},
	{Name: "pseudoHeaderOrder", Type: "array", ValueType: "string"},
	{Name: "supportedDelegatedCredentialsAlgorithms", Type: "array", KeySet: "supportedDelegatedCredentialsAlgorithms", ValueType: "string"},
	{Name: "supportedSignatureAlgorithms", Type: "array", KeySet: "supportedSignatureAlgorithms", ValueType: "string"},
	{Name: "supportedVersions", Type: "array", KeySet: "supportedVersions", ValueType: "string"},
	{Name: "connectionFlow", Type: "uint32"},
	{Name: "recordSizeLimit", Type: "uint16"},
	{Name: "streamId", Type: "uint32"},
	{Name: "h3PriorityParam", Type: "uint32"},
	{Name: "h3SendGreaseFrames", Type: "boolean"},
	{Name: "allowHttp", Type: "boolean"},
}

var bridgeErrorKinds = []string{
	string(protocol.ErrorKindInvalidConfig),
	string(protocol.ErrorKindInvalidUrl),
	string(protocol.ErrorKindDns),
	string(protocol.ErrorKindConnect),
	string(protocol.ErrorKindTls),
	string(protocol.ErrorKindProxy),
	string(protocol.ErrorKindTimeout),
	string(protocol.ErrorKindCancelled),
	string(protocol.ErrorKindHttp),
	string(protocol.ErrorKindBody),
	string(protocol.ErrorKindPinning),
	string(protocol.ErrorKindSessionNotFound),
	string(protocol.ErrorKindSessionConfig),
	string(protocol.ErrorKindWsHandshake),
	string(protocol.ErrorKindWsRead),
	string(protocol.ErrorKindWsWrite),
	string(protocol.ErrorKindProtocol),
	string(protocol.ErrorKindInternal),
	string(protocol.ErrorKindUnknown),
}

func sortedStrings(values []string) []string {
	result := append([]string(nil), values...)
	sort.Strings(result)
	return result
}

func sortedMapKeys[T any](values map[string]T) []string {
	result := make([]string, 0, len(values))
	for key := range values {
		result = append(result, key)
	}
	sort.Strings(result)
	return result
}

func sortedDumpFields(values []dumpField) []dumpField {
	result := append([]dumpField(nil), values...)
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result
}

func bridgeDump() dumpMetadata {
	return dumpMetadata{
		Profiles: sortedMapKeys(profiles.MappedTLSClients),
		CustomTLSClient: dumpCustomProfile{
			Fields: sortedDumpFields(customProfileFieldMetadata),
		},
		H2Settings:                              sortedMapKeys(tlsClient.H2SettingsMap),
		H3Settings:                              sortedMapKeys(tlsClient.H3SettingsMap),
		SupportedCurves:                         sortedStrings(pinnedSupportedCurves),
		SupportedVersions:                       sortedStrings(pinnedSupportedVersions),
		SupportedSignatureAlgorithms:            sortedStrings(pinnedSupportedSignatureAlgorithms),
		SupportedDelegatedCredentialsAlgorithms: sortedStrings(pinnedSupportedDelegatedCredentialsAlgorithms),
		KDFIDs:                                  sortedStrings(pinnedKDFIDs),
		AEADIDs:                                 sortedStrings(pinnedAEADIDs),
		CertCompressionAlgos:                    sortedStrings(pinnedCertCompressionAlgos),
		ErrorKinds:                              sortedStrings(bridgeErrorKinds),
	}
}

func dumpJSON() ([]byte, error) {
	data, err := json.Marshal(bridgeDump())
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

func writeDump(output io.Writer) error {
	data, err := dumpJSON()
	if err != nil {
		return err
	}
	n, err := output.Write(data)
	if err != nil {
		return err
	}
	if n != len(data) {
		return io.ErrShortWrite
	}
	return nil
}

func containsPinnedValue(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

func validatePinnedEnumValues(field string, values, allowed []string) error {
	for _, value := range values {
		if !containsPinnedValue(allowed, value) {
			return unknownCustomProfileEnum(field, value)
		}
	}
	return nil
}

func unknownCustomProfileEnum(field, value string) error {
	return fmt.Errorf("unknown %s %q", field, value)
}
