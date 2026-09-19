package main

import "testing"

func TestVersionString(t *testing.T) {
	got := versionString()
	want := "effect-tls-client-bridge " + version

	if got != want {
		t.Fatalf("versionString() = %q, want %q", got, want)
	}
}
