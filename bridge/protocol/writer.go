package protocol

import (
	"io"
	"sync"
)

// Writer serializes concurrent writers onto a single underlying io.Writer, per
// protocol doc §1 ("Go writes frames from a single writer goroutine").
type Writer struct {
	mu sync.Mutex
	w  io.Writer
}

// NewWriter wraps w with the single-writer discipline.
func NewWriter(w io.Writer) *Writer {
	return &Writer{w: w}
}

// Write serializes and writes a single frame, safe for concurrent callers.
func (fw *Writer) Write(f Frame) error {
	fw.mu.Lock()
	defer fw.mu.Unlock()
	return WriteFrame(fw.w, f)
}
