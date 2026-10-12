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
	"github.com/tetratelabs/wazero/sys"

	"pomodorough/internal/sharedcore"
)

// closedCoreFailure returns the actual error from a created-then-closed
// shared runtime on a live context. Callers must not use substring
// matching; the sentinel is sharedcore.ErrClosed via errors.Is.
func closedCoreFailure(t *testing.T) error {
	t.Helper()
	live := context.Background()
	core, err := sharedcore.New(live)
	if err != nil {
		t.Fatal(err)
	}
	if err := core.Close(live); err != nil {
		t.Fatal(err)
	}
	_, err = core.Call(live, "timer.reduce.v1", []byte(`{}`))
	if err == nil {
		t.Fatal("closed core call = nil, want ErrClosed")
	}
	if !errors.Is(err, sharedcore.ErrClosed) {
		t.Fatalf("closed core error = %v, want ErrClosed chain", err)
	}
	return err
}

func assertSyncReportsOnce(t *testing.T, transport *sentry.MockTransport, failure error, wantCause string) {
	t.Helper()
	server := &Server{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	request, _ := newPIIRequest()
	response := httptest.NewRecorder()
	server.writeSyncMutationError(response, request, failure)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d for %v, want 500", response.Code, failure)
	}
	sentry.Flush(2 * time.Second)
	events := transport.Events()
	if len(events) != 1 {
		t.Fatalf("events = %d for %v, want 1 actionable", len(events), failure)
	}
	if events[0].Tags["error.operation"] != "sync account mutations" {
		t.Fatalf("error.operation = %q, want sync account mutations", events[0].Tags["error.operation"])
	}
	if events[0].Tags["error.cause"] != wantCause {
		t.Fatalf("error.cause = %q for %v, want %q", events[0].Tags["error.cause"], failure, wantCause)
	}
}

func assertSyncSuppressed(t *testing.T, transport *sentry.MockTransport, request *http.Request, failure error) {
	t.Helper()
	server := &Server{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	response := httptest.NewRecorder()
	server.writeSyncMutationError(response, request, failure)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d for %v, want 500", response.Code, failure)
	}
	sentry.Flush(2 * time.Second)
	if events := transport.Events(); len(events) != 0 {
		t.Fatalf("events = %d for %v, want 0 suppressed", len(events), failure)
	}
}

func TestR48S07LiveClosedRuntimeReports(t *testing.T) {
	transport := initMockSentry(t)
	failure := closedCoreFailure(t)
	live := context.Background()
	if isSyncCancellation(failure, live) {
		t.Fatalf("isSyncCancellation(%v, live) = true, want false", failure)
	}
	assertSyncReportsOnce(t, transport, failure, "runtime_closed")
}

func TestR48S07CanceledClosedRuntimeSuppressed(t *testing.T) {
	failure := closedCoreFailure(t)
	live := context.Background()
	canceled, cancel := context.WithCancel(live)
	cancel()
	defer cancel()
	if !isSyncCancellation(failure, canceled) {
		t.Fatalf("isSyncCancellation(closed, canceled) = false, want true")
	}
	expired, stop := context.WithDeadline(live, time.Now().Add(-time.Second))
	defer stop()
	if !isSyncCancellation(failure, expired) {
		t.Fatal("isSyncCancellation(closed, deadline) = false, want true")
	}
	transport := initMockSentry(t)
	request, _ := newPIIRequest()
	canceledRequest := request.WithContext(canceled)
	assertSyncSuppressed(t, transport, canceledRequest, failure)
	transport = initMockSentry(t)
	typedCanceled := fmt.Errorf("dispatch shared core operation %q: %w", "timer.reduce.v1", sys.NewExitError(sys.ExitCodeContextCanceled))
	if !isSyncCancellation(typedCanceled, live) {
		t.Fatalf("isSyncCancellation(typed canceled, live) = false, want true")
	}
	typedRequest, _ := newPIIRequest()
	assertSyncSuppressed(t, transport, typedRequest, typedCanceled)
}

func TestR48S07GenuineTrapAndSubstringReports(t *testing.T) {
	live := context.Background()
	genuine := fmt.Errorf("dispatch shared core operation %q: %w", "timer.reduce.v1", sys.NewExitError(2))
	if isSyncCancellation(genuine, live) {
		t.Fatalf("isSyncCancellation(genuine trap, live) = true, want false")
	}
	transport := initMockSentry(t)
	assertSyncReportsOnce(t, transport, genuine, "runtime_exit")
	substrings := []error{
		errors.New("module closed with context canceled"),
		errors.New("shared core is closed"),
		errors.New("read timer commands: context canceled"),
		errors.Join(errors.New("module closed with context canceled"), errors.New("store unavailable")),
	}
	for _, failure := range substrings {
		if isSyncCancellation(failure, live) {
			t.Fatalf("isSyncCancellation(%v, live) = true, want false", failure)
		}
		transport := initMockSentry(t)
		assertSyncReportsOnce(t, transport, failure, "internal")
	}
}

func TestR48S07CancellationUsesTypedEvidenceOnly(t *testing.T) {
	live := context.Background()
	canceled, cancel := context.WithCancel(live)
	cancel()
	defer cancel()
	for _, failure := range []error{
		context.Canceled,
		context.DeadlineExceeded,
		fmt.Errorf("reduce timer with shared core: %w", context.Canceled),
		fmt.Errorf("dispatch: %w", sys.NewExitError(sys.ExitCodeContextCanceled)),
		fmt.Errorf("dispatch: %w", sys.NewExitError(sys.ExitCodeDeadlineExceeded)),
	} {
		if !isSyncCancellation(failure, live) {
			t.Fatalf("isSyncCancellation(%v, live) = false, want true", failure)
		}
	}
	if !isSyncCancellation(errors.New("store unavailable"), canceled) {
		t.Fatal("isSyncCancellation with canceled context = false, want true")
	}
	for _, failure := range []error{
		errors.New("store unavailable"),
		errors.New("module closed with context canceled"),
		errors.New("shared core is closed"),
		errors.New(""),
		nil,
	} {
		if isSyncCancellation(failure, live) {
			t.Fatalf("isSyncCancellation(%v, live) = true, want false", failure)
		}
	}
}
