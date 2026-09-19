package protocol

import "testing"

func TestDecodeObjectIgnoresUnknownFields(t *testing.T) {
	var hello HelloMeta
	if err := DecodeObject([]byte(`{"protocolVersion":1,"clientVersion":"0.0.0","future":{"field":true}}`), &hello); err != nil {
		t.Fatal(err)
	}
	if hello.ProtocolVersion != 1 || hello.ClientVersion != "0.0.0" {
		t.Fatalf("decoded hello = %+v", hello)
	}
}

func TestDecodeObjectRejectsInvalidUTF8(t *testing.T) {
	var empty EmptyMeta
	if err := DecodeObject([]byte{'{', '"', 'x', '"', ':', '"', 0xff, '"', '}'}, &empty); err == nil {
		t.Fatal("expected invalid UTF-8 error")
	}
}

func TestDebugMetadataRejectsNegativeNumbers(t *testing.T) {
	var ack AckMeta
	if err := DecodeObject([]byte(`{"bytes":-1}`), &ack); err == nil {
		t.Fatal("expected negative ack bytes to be rejected")
	}
}

func TestHelloAckOptionalCreditMetadata(t *testing.T) {
	var ack HelloAckMeta
	if err := DecodeObject([]byte(`{"protocolVersion":1,"bridgeVersion":"0.0.0","tlsClientVersion":"fixture","goVersion":"go","future":true}`), &ack); err != nil {
		t.Fatal(err)
	}
	if ack.Window != 0 || ack.ChunkSize != 0 {
		t.Fatalf("legacy helloAck = %+v", ack)
	}
}
