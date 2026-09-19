// Command bridge is the effect-tls-client Bridge sidecar.
//
// This is a Stage 0 scaffold: it only prints its version and exits. The
// framed stdio protocol (docs/adr/0002) lands in a later ticket.
package main

import (
	"fmt"

	// Pinned upstream dependency (D18/D17): not yet called from Stage 0. Real
	// usage lands with the protocol core in a later ticket.
	_ "github.com/bogdanfinn/tls-client"
)

// version is the Bridge's own release version, stamped at build time via
// `-ldflags -X main.version=...` in later tickets. It intentionally has no
// relation to the pinned tls-client module version.
var version = "0.0.0-dev"

func main() {
	fmt.Println(versionString())
}

func versionString() string {
	return "effect-tls-client-bridge " + version
}
