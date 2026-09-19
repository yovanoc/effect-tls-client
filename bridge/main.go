// Command bridge implements the issue #3 protocol-v1 handshake and lifecycle.
// It speaks frames only on stdout; diagnostics go to stderr.
package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"runtime/debug"

	"github.com/yovanoc/effect-tls-client/bridge/protocol"

	// Keep the upstream dependency pinned in the bridge binary. Later tickets
	// use it for sessions and requests.
	_ "github.com/bogdanfinn/tls-client"
)

const protocolVersion = 1
const tlsClientModule = "github.com/bogdanfinn/tls-client"

// version is stamped by release builds with -ldflags -X main.version=.... The
// default matches the scaffold package version so local end-to-end builds can
// complete the handshake without release tooling.
var version = "0.0.0"

func main() {
	os.Exit(run(os.Stdin, os.Stdout, os.Stderr))
}

func run(input io.Reader, output io.Writer, diagnostics io.Writer) int {
	first, err := protocol.ReadFrame(input)
	if errors.Is(err, io.EOF) {
		return 0
	}
	if err != nil {
		logProtocolError(diagnostics, err)
		return 2
	}
	if err := validateHello(first); err != nil {
		logProtocolError(diagnostics, err)
		return 2
	}

	writer := protocol.NewWriter(output)
	if err := writeHelloAck(writer); err != nil {
		fmt.Fprintf(diagnostics, "write helloAck: %v\n", err)
		return 2
	}

	for {
		frame, err := protocol.ReadFrame(input)
		if errors.Is(err, io.EOF) {
			return 0
		}
		if err != nil {
			logProtocolError(diagnostics, err)
			return 2
		}

		done, err := dispatch(writer, frame)
		if err != nil {
			fmt.Fprintf(diagnostics, "write response: %v\n", err)
			return 2
		}
		if done {
			return 0
		}
	}
}

func validateHello(frame protocol.Frame) error {
	if frame.Kind != protocol.KindHello || frame.ID != 0 || len(frame.Body) != 0 {
		return fmt.Errorf("%w: first frame must be hello with id 0 and no body", protocol.ErrProtocol)
	}
	var meta protocol.HelloMeta
	if err := protocol.DecodeObject(frame.Meta, &meta); err != nil {
		return err
	}
	if meta.ProtocolVersion != protocolVersion {
		return fmt.Errorf("%w: unsupported protocol version %d", protocol.ErrProtocol, meta.ProtocolVersion)
	}
	if meta.ClientVersion == "" {
		return fmt.Errorf("%w: clientVersion is required", protocol.ErrProtocol)
	}
	return nil
}

func writeHelloAck(writer *protocol.Writer) error {
	meta, err := protocol.EncodeMeta(protocol.HelloAckMeta{
		ProtocolVersion:  protocolVersion,
		BridgeVersion:    version,
		TlsClientVersion: tlsClientVersion(),
		GoVersion:        runtime.Version(),
	})
	if err != nil {
		return err
	}
	return writer.Write(protocol.Frame{Kind: protocol.KindHelloAck, ID: 0, Meta: meta})
}

func dispatch(writer *protocol.Writer, frame protocol.Frame) (bool, error) {
	switch frame.Kind {
	case protocol.KindDebugPing:
		if frame.ID == 0 {
			return false, writeProtocolError(writer, frame.ID, "debug.ping id 0 is reserved")
		}
		if err := protocol.DecodeEmpty(frame.Meta); err != nil {
			return false, writeProtocolError(writer, frame.ID, err.Error())
		}
		if len(frame.Body) != 0 {
			return false, writeProtocolError(writer, frame.ID, "debug.ping does not accept a body")
		}
		return false, writeEmptyResponse(writer, protocol.KindOk, frame.ID)

	case protocol.KindShutdown:
		if frame.ID != 0 {
			return false, writeProtocolError(writer, frame.ID, "shutdown id must be 0")
		}
		if err := protocol.DecodeEmpty(frame.Meta); err != nil {
			return false, writeProtocolError(writer, frame.ID, err.Error())
		}
		if len(frame.Body) != 0 {
			return false, writeProtocolError(writer, frame.ID, "shutdown does not accept a body")
		}
		return true, writeEmptyResponse(writer, protocol.KindOk, 0)

	case protocol.KindHello:
		return false, writeProtocolError(writer, frame.ID, "hello was already completed")
	case protocol.KindHelloAck, protocol.KindOk, protocol.KindError:
		return false, writeProtocolError(writer, frame.ID, "frame kind is not valid from the client")
	default:
		return false, writeProtocolError(writer, frame.ID, fmt.Sprintf("unknown frame kind 0x%02x", byte(frame.Kind)))
	}
}

func writeEmptyResponse(writer *protocol.Writer, kind protocol.Kind, id uint32) error {
	meta, err := protocol.EncodeMeta(protocol.EmptyMeta{})
	if err != nil {
		return err
	}
	return writer.Write(protocol.Frame{Kind: kind, ID: id, Meta: meta})
}

func writeProtocolError(writer *protocol.Writer, id uint32, message string) error {
	meta, err := protocol.EncodeMeta(protocol.ErrorMeta{
		Kind:    protocol.ErrorKindProtocol,
		Message: message,
	})
	if err != nil {
		return err
	}
	return writer.Write(protocol.Frame{Kind: protocol.KindError, ID: id, Meta: meta})
}

func logProtocolError(diagnostics io.Writer, err error) {
	fmt.Fprintf(diagnostics, "protocol error: %v\n", err)
}

func tlsClientVersion() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "unknown"
	}
	for _, dependency := range info.Deps {
		if dependency.Path != tlsClientModule {
			continue
		}
		if dependency.Replace != nil {
			return dependency.Replace.Version
		}
		return dependency.Version
	}
	return "unknown"
}

func versionString() string {
	return "effect-tls-client-bridge " + version
}
