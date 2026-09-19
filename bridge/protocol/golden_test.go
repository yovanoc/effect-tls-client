package protocol

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestGoldenGoToTS(t *testing.T) {
	helloAck, err := EncodeMeta(HelloAckMeta{
		ProtocolVersion:  1,
		BridgeVersion:    "0.0.0",
		TlsClientVersion: "v1.16.0",
		GoVersion:        "go1.27.1",
	})
	if err != nil {
		t.Fatal(err)
	}
	errorMeta, err := json.Marshal(ErrorMeta{
		Kind:    ErrorKindProtocol,
		Message: "bad",
		Detail:  map[string]interface{}{"extra": map[string]interface{}{"ok": true}},
	})
	if err != nil {
		t.Fatal(err)
	}
	empty, err := EncodeMeta(EmptyMeta{})
	if err != nil {
		t.Fatal(err)
	}
	frames := []Frame{
		{Kind: KindHelloAck, ID: 0, Meta: helloAck},
		{Kind: KindOk, ID: 7, Meta: empty},
		{Kind: KindError, ID: 9, Meta: errorMeta},
		{Kind: KindOk, ID: ^uint32(0), Body: []byte{0, 0xff}},
	}
	goldens := readGolden(t, "../testdata/protocol/go-to-ts.hex")
	if len(frames) != len(goldens) {
		t.Fatalf("frame count = %d, want %d", len(frames), len(goldens))
	}
	for index, frame := range frames {
		var encoded bytes.Buffer
		if err := WriteFrame(&encoded, frame); err != nil {
			t.Fatal(err)
		}
		if got := encoded.Bytes(); !bytes.Equal(got, goldens[index].bytes) {
			t.Fatalf("golden %d (%s) = %x, want %x", index, goldens[index].name, got, goldens[index].bytes)
		}
	}
}

func TestGoldenTSToGo(t *testing.T) {
	goldens := readGolden(t, "../testdata/protocol/ts-to-go.hex")
	for _, golden := range goldens {
		frame, err := ReadFrame(bytes.NewReader(golden.bytes))
		if err != nil {
			t.Fatalf("decode %s: %v", golden.name, err)
		}
		var encoded bytes.Buffer
		if err := WriteFrame(&encoded, frame); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(encoded.Bytes(), golden.bytes) {
			t.Fatalf("re-encode %s changed bytes", golden.name)
		}
	}
}

type goldenFrame struct {
	name  string
	bytes []byte
}

func readGolden(t *testing.T, path string) []goldenFrame {
	t.Helper()
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var result []goldenFrame
	for _, line := range strings.Split(string(contents), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || strings.HasPrefix(fields[0], "#") {
			continue
		}
		if len(fields) != 2 {
			t.Fatalf("invalid golden line %q", line)
		}
		value, err := hex.DecodeString(fields[1])
		if err != nil {
			t.Fatalf("decode golden %s: %v", fields[0], err)
		}
		result = append(result, goldenFrame{name: fields[0], bytes: value})
	}
	return result
}
