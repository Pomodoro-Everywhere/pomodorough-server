package server

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"
)

func scanProtocolRevisions(ctx context.Context, body io.Reader, revisions chan<- int64) {
	defer close(revisions)
	scanner := bufio.NewScanner(body)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var event struct {
			Revision int64 `json:"revision"`
		}
		if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event) != nil {
			continue
		}
		select {
		case revisions <- event.Revision:
		case <-ctx.Done():
			return
		}
	}
}

func TestProtocolRevisionScannerCancellationReleasesRepeatedBackpressure(t *testing.T) {
	deadline := time.After(5 * time.Second)
	for iteration := range 100 {
		ctx, cancel := context.WithCancel(t.Context())
		done := make(chan struct{})
		go func() {
			defer close(done)
			scanProtocolRevisions(ctx, strings.NewReader("data: {\"revision\":1}\n\n"), make(chan int64))
		}()
		cancel()
		select {
		case <-done:
		case <-deadline:
			t.Fatalf("revision scanner %d remained blocked after cancellation", iteration)
		}
	}
}
