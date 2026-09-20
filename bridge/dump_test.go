package main

import (
	"bytes"
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"

	tlsClient "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
	"github.com/yovanoc/effect-tls-client/bridge/protocol"
)

func TestDumpIsDeterministicAndComplete(t *testing.T) {
	first, err := dumpJSON()
	if err != nil {
		t.Fatal(err)
	}
	second, err := dumpJSON()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, second) {
		t.Fatalf("dump changed between calls:\n%s\n%s", first, second)
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(first, &raw); err != nil {
		t.Fatal(err)
	}
	wantKeys := []string{
		"profiles",
		"customTlsClient",
		"h2Settings",
		"h3Settings",
		"supportedCurves",
		"supportedVersions",
		"supportedSignatureAlgorithms",
		"supportedDelegatedCredentialsAlgorithms",
		"kdfIds",
		"aeadIds",
		"certCompressionAlgos",
		"errorKinds",
	}
	if len(raw) != len(wantKeys) {
		t.Fatalf("dump keys = %v, want %v", sortedKeys(raw), wantKeys)
	}
	for _, key := range wantKeys {
		if _, ok := raw[key]; !ok {
			t.Fatalf("dump is missing %q", key)
		}
	}

	var dump dumpMetadata
	if err := json.Unmarshal(first, &dump); err != nil {
		t.Fatal(err)
	}
	arrays := map[string][]string{
		"profiles":                     dump.Profiles,
		"h2Settings":                   dump.H2Settings,
		"h3Settings":                   dump.H3Settings,
		"supportedCurves":              dump.SupportedCurves,
		"supportedVersions":            dump.SupportedVersions,
		"supportedSignatureAlgorithms": dump.SupportedSignatureAlgorithms,
		"supportedDelegatedCredentialsAlgorithms": dump.SupportedDelegatedCredentialsAlgorithms,
		"kdfIds":               dump.KDFIDs,
		"aeadIds":              dump.AEADIDs,
		"certCompressionAlgos": dump.CertCompressionAlgos,
		"errorKinds":           dump.ErrorKinds,
	}
	for name, values := range arrays {
		if !sort.StringsAreSorted(values) {
			t.Errorf("%s is not sorted: %v", name, values)
		}
	}
	if !sort.SliceIsSorted(dump.CustomTLSClient.Fields, func(i, j int) bool {
		return dump.CustomTLSClient.Fields[i].Name < dump.CustomTLSClient.Fields[j].Name
	}) {
		t.Fatal("customTlsClient.fields is not sorted")
	}

	wantFields := make(map[string]struct{})
	customProfileType := reflect.TypeOf(protocol.CustomProfileMeta{})
	for index := 0; index < customProfileType.NumField(); index++ {
		field := customProfileType.Field(index)
		name := strings.Split(field.Tag.Get("json"), ",")[0]
		if name == "" || name == "-" {
			t.Fatalf("CustomProfileMeta.%s has no JSON name", field.Name)
		}
		wantFields[name] = struct{}{}
	}
	gotFields := make(map[string]struct{}, len(dump.CustomTLSClient.Fields))
	for _, field := range dump.CustomTLSClient.Fields {
		if _, duplicate := gotFields[field.Name]; duplicate {
			t.Fatalf("duplicate custom profile field %q", field.Name)
		}
		gotFields[field.Name] = struct{}{}
		if field.Type == "" {
			t.Fatalf("custom profile field %q has no type", field.Name)
		}
	}
	if !reflect.DeepEqual(gotFields, wantFields) {
		t.Fatalf("custom profile fields = %v, want %v", sortedKeys(gotFields), sortedKeys(wantFields))
	}
}

func TestDumpUsesUpstreamExportedMapsAndPinnedEnums(t *testing.T) {
	dump := bridgeDump()
	if !stringSlicesEqual(dump.Profiles, sortedMapKeys(profiles.MappedTLSClients)) {
		t.Fatal("profiles dump does not match profiles.MappedTLSClients")
	}
	if !stringSlicesEqual(dump.H2Settings, sortedMapKeys(tlsClient.H2SettingsMap)) {
		t.Fatal("h2Settings dump does not match tls-client H2SettingsMap")
	}
	if !stringSlicesEqual(dump.H3Settings, sortedMapKeys(tlsClient.H3SettingsMap)) {
		t.Fatal("h3Settings dump does not match tls-client H3SettingsMap")
	}
	for name, values := range map[string][]string{
		"supportedCurves":                         pinnedSupportedCurves,
		"supportedVersions":                       pinnedSupportedVersions,
		"supportedSignatureAlgorithms":            pinnedSupportedSignatureAlgorithms,
		"supportedDelegatedCredentialsAlgorithms": pinnedSupportedDelegatedCredentialsAlgorithms,
		"kdfIds":               pinnedKDFIDs,
		"aeadIds":              pinnedAEADIDs,
		"certCompressionAlgos": pinnedCertCompressionAlgos,
		"errorKinds":           bridgeErrorKinds,
	} {
		if !stringSlicesEqual(dumpArray(dump, name), sortedStrings(values)) {
			t.Errorf("%s dump does not match pinned metadata", name)
		}
	}
}

func TestRunCommandDump(t *testing.T) {
	var output, diagnostics bytes.Buffer
	if code := runCommand([]string{"dump"}, nil, &output, &diagnostics); code != 0 {
		t.Fatalf("runCommand(dump) exit code = %d, diagnostics = %q", code, diagnostics.String())
	}
	if diagnostics.Len() != 0 {
		t.Fatalf("dump wrote diagnostics: %q", diagnostics.String())
	}
	var decoded dumpMetadata
	if err := json.Unmarshal(output.Bytes(), &decoded); err != nil {
		t.Fatalf("dump output is not JSON: %v", err)
	}
}

func TestRunCommandWithoutArgsUsesFramedProtocol(t *testing.T) {
	hello, err := protocol.EncodeMeta(protocol.HelloMeta{
		ProtocolVersion: protocolVersion,
		ClientVersion:   version,
	})
	if err != nil {
		t.Fatal(err)
	}
	empty, err := protocol.EncodeMeta(protocol.EmptyMeta{})
	if err != nil {
		t.Fatal(err)
	}
	var input bytes.Buffer
	for _, frame := range []protocol.Frame{
		{Kind: protocol.KindHello, ID: 0, Meta: hello},
		{Kind: protocol.KindShutdown, ID: 0, Meta: empty},
	} {
		if err := protocol.WriteFrame(&input, frame); err != nil {
			t.Fatal(err)
		}
	}
	var output bytes.Buffer
	if code := runCommand(nil, &input, &output, &bytes.Buffer{}); code != 0 {
		t.Fatalf("runCommand() exit code = %d", code)
	}
	if frame := readTestFrame(t, &output); frame.Kind != protocol.KindHelloAck {
		t.Fatalf("first framed response = %+v", frame)
	}
	if frame := readTestFrame(t, &output); frame.Kind != protocol.KindOk || frame.ID != 0 {
		t.Fatalf("shutdown framed response = %+v", frame)
	}
}

func TestValidateCustomProfileAcceptsKnownEnumValues(t *testing.T) {
	profile := knownCustomProfile()
	if err := validateCustomProfile(profile); err != nil {
		t.Fatalf("known custom profile rejected: %v", err)
	}
}

func TestUnknownCustomProfileEnumsUseSessionConfigError(t *testing.T) {
	dispatcher, writer := newTestDispatcher()
	defer dispatcher.stop()

	profile := knownCustomProfile()
	profile.H2Settings = map[string]uint32{"UNKNOWN": 1}
	meta, err := protocol.EncodeMeta(protocol.SessionConfigMeta{
		SessionID:     "unknown-enum",
		CustomProfile: &profile,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dispatcher.dispatch(protocol.Frame{
		Kind: protocol.KindSessionCreate,
		ID:   1,
		Meta: meta,
	}); err != nil {
		t.Fatal(err)
	}
	frame := nextTestFrame(t, writer.frames)
	if frame.Kind != protocol.KindError || frame.ID != 1 {
		t.Fatalf("session create response = %+v", frame)
	}
	var errorMeta protocol.ErrorMeta
	if err := protocol.DecodeObject(frame.Meta, &errorMeta); err != nil {
		t.Fatal(err)
	}
	if errorMeta.Kind != protocol.ErrorKindSessionConfig {
		t.Fatalf("error kind = %q, want %q", errorMeta.Kind, protocol.ErrorKindSessionConfig)
	}
}

func TestBuildSessionRejectsUnknownCustomProfileEnums(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*protocol.CustomProfileMeta)
	}{
		{
			name: "h2 setting map",
			mutate: func(profile *protocol.CustomProfileMeta) {
				profile.H2Settings = map[string]uint32{"UNKNOWN": 1}
			},
		},
		{
			name: "h2 setting order",
			mutate: func(profile *protocol.CustomProfileMeta) {
				profile.H2SettingsOrder = []string{"UNKNOWN"}
			},
		},
		{
			name: "h3 setting map",
			mutate: func(profile *protocol.CustomProfileMeta) {
				profile.H3Settings = map[string]uint64{"UNKNOWN": 1}
			},
		},
		{
			name: "h3 setting order",
			mutate: func(profile *protocol.CustomProfileMeta) {
				profile.H3SettingsOrder = []string{"UNKNOWN"}
			},
		},
		{
			name: "key share curve",
			mutate: func(profile *protocol.CustomProfileMeta) {
				profile.KeyShareCurves = []string{"0x1234"}
			},
		},
		{
			name: "supported version",
			mutate: func(profile *protocol.CustomProfileMeta) {
				profile.SupportedVersions = []string{"0x0304"}
			},
		},
		{
			name: "signature algorithm",
			mutate: func(profile *protocol.CustomProfileMeta) {
				profile.SupportedSignatureAlgorithms = []string{"0403"}
			},
		},
		{
			name: "delegated credentials algorithm",
			mutate: func(profile *protocol.CustomProfileMeta) {
				profile.SupportedDelegatedCredentialsAlgorithms = []string{"0403"}
			},
		},
		{
			name: "certificate compression",
			mutate: func(profile *protocol.CustomProfileMeta) {
				profile.CertCompressionAlgos = []string{"0xff"}
			},
		},
		{
			name: "ech kdf",
			mutate: func(profile *protocol.CustomProfileMeta) {
				profile.ECHCandidateCipherSuites[0].KdfID = "0x0010"
			},
		},
		{
			name: "ech aead",
			mutate: func(profile *protocol.CustomProfileMeta) {
				profile.ECHCandidateCipherSuites[0].AeadID = "0x0001"
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			profile := knownCustomProfile()
			test.mutate(&profile)
			_, err := buildSession(protocol.SessionConfigMeta{
				SessionID:     "unknown-enum",
				CustomProfile: &profile,
			})
			if err == nil {
				t.Fatal("buildSession accepted an unknown enum")
			}
		})
	}
}

func knownCustomProfile() protocol.CustomProfileMeta {
	h2 := sortedMapKeys(tlsClient.H2SettingsMap)[0]
	h3 := sortedMapKeys(tlsClient.H3SettingsMap)[0]
	return protocol.CustomProfileMeta{
		Ja3String:                               "771",
		H2Settings:                              map[string]uint32{h2: 1},
		H2SettingsOrder:                         []string{h2},
		H3Settings:                              map[string]uint64{h3: 1},
		H3SettingsOrder:                         []string{h3},
		KeyShareCurves:                          []string{pinnedSupportedCurves[0]},
		SupportedVersions:                       []string{pinnedSupportedVersions[0]},
		SupportedSignatureAlgorithms:            []string{pinnedSupportedSignatureAlgorithms[0]},
		SupportedDelegatedCredentialsAlgorithms: []string{pinnedSupportedDelegatedCredentialsAlgorithms[0]},
		CertCompressionAlgos:                    []string{pinnedCertCompressionAlgos[0]},
		ECHCandidateCipherSuites: []protocol.CandidateCipherSuiteMeta{{
			KdfID:  pinnedKDFIDs[0],
			AeadID: pinnedAEADIDs[0],
		}},
	}
}

func sortedKeys[T any](values map[string]T) []string {
	result := make([]string, 0, len(values))
	for key := range values {
		result = append(result, key)
	}
	sort.Strings(result)
	return result
}

func stringSlicesEqual(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func dumpArray(dump dumpMetadata, name string) []string {
	switch name {
	case "supportedCurves":
		return dump.SupportedCurves
	case "supportedVersions":
		return dump.SupportedVersions
	case "supportedSignatureAlgorithms":
		return dump.SupportedSignatureAlgorithms
	case "supportedDelegatedCredentialsAlgorithms":
		return dump.SupportedDelegatedCredentialsAlgorithms
	case "kdfIds":
		return dump.KDFIDs
	case "aeadIds":
		return dump.AEADIDs
	case "certCompressionAlgos":
		return dump.CertCompressionAlgos
	case "errorKinds":
		return dump.ErrorKinds
	default:
		return nil
	}
}
