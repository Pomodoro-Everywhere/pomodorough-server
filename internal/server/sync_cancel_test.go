package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
)

// POMODOROUGH-1J: shutdown/cancel noise on the sync mutation path must
// not reach Sentry. The production chain is fmt.wrapError "sync account
// mutations" -> "reduce timer with shared core" -> dispatch shared core
// operation timer.reduce.v1 "module closed with context canceled".
func TestSyncCancellationDoesNotReportToSentry(t *testing.T) {
	canceled := []error{
		context.Canceled,
		context.DeadlineExceeded,
		fmt.Errorf("reduce timer with shared core: %w", context.Canceled),
		fmt.Errorf("reduce timer with shared core: %w",
			fmt.Errorf("dispatch shared core operation %q: %w",
				"timer.reduce.v1", errors.New("module closed with context canceled"))),
		errors.New("shared core is closed"),
	}
	for _, failure := range canceled {
		transport := initMockSentry(t)
		server := &Server{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
		request, _ := newPIIRequest()
		response := httptest.NewRecorder()
		server.writeSyncMutationError(response, request, failure)
		if response.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d for %v, want 500", response.Code, failure)
		}
		sentry.Flush(2 * time.Second)
		if events := transport.Events(); len(events) != 0 {
			t.Fatalf("events = %d for %v, want 0", len(events), failure)
		}
	}
}

func TestSyncCancellationHonorsRequestContext(t *testing.T) {
	transport := initMockSentry(t)
	server := &Server{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	request, _ := newPIIRequest()
	canceled, cancel := context.WithCancel(request.Context())
	cancel()
	request = request.WithContext(canceled)
	response := httptest.NewRecorder()
	server.writeSyncMutationError(response, request, errors.New("read timer commands: context canceled"))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", response.Code)
	}
	sentry.Flush(2 * time.Second)
	if events := transport.Events(); len(events) != 0 {
		t.Fatalf("events = %d, want 0 for canceled request", len(events))
	}
}

func TestSyncGenuineFailureStillReportsToSentry(t *testing.T) {
	transport := initMockSentry(t)
	server := &Server{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	request, _ := newPIIRequest()
	response := httptest.NewRecorder()
	server.writeSyncMutationError(response, request, errors.New("store unavailable"))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", response.Code)
	}
	sentry.Flush(2 * time.Second)
	events := transport.Events()
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1 for genuine failure", len(events))
	}
	if events[0].Tags["error.operation"] != "sync account mutations" {
		t.Fatalf("error.operation = %q, want sync account mutations", events[0].Tags["error.operation"])
	}
}

func TestIsSyncCancellationKeepsRealErrors(t *testing.T) {
	for _, failure := range []error{
		errors.New("store unavailable"),
		errors.New("validate shared timer output: missing canonical"),
		errors.New("commit sync: database is locked"),
	} {
		if isSyncCancellation(failure, context.Background()) {
			t.Fatalf("isSyncCancellation(%v) = true, want false", failure)
		}
	}
}
