package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"

	"pomodorough/internal/sharedcore"
)

type testSQLiteError struct {
	code int
	msg  string
}

func (e *testSQLiteError) Error() string { return e.msg }
func (e *testSQLiteError) Code() int     { return e.code }

func TestR48S06DistinctCausesSameRouteBothReport(t *testing.T) {
	transport := initMockSentry(t)
	server := &Server{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	busy := fmt.Errorf("read timer commands: %w", &testSQLiteError{code: 5, msg: "database is locked"})
	denied := fmt.Errorf("open store /data/account-secret-999: %w", os.ErrPermission)
	first, _ := newPIIRequest()
	server.internalAPIError(httptest.NewRecorder(), first, "sync account mutations", busy)
	second, _ := newPIIRequest()
	server.internalAPIError(httptest.NewRecorder(), second, "sync account mutations", denied)
	sentry.Flush(2 * time.Second)
	events := transport.Events()
	if len(events) != 2 {
		t.Fatalf("events = %d, want 2 distinct firsts", len(events))
	}
	got := map[string]bool{}
	for _, event := range events {
		got[event.Tags["error.cause"]] = true
	}
	if !got["sqlite_busy"] || !got["io_permission"] {
		t.Fatalf("causes = %v, want sqlite_busy and io_permission", got)
	}
}

func TestR48S06BoundedRepeatsSameCause(t *testing.T) {
	transport := initMockSentry(t)
	server := &Server{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	for range 5 {
		request, _ := newPIIRequest()
		failure := fmt.Errorf("commit: %w", &testSQLiteError{code: 5, msg: "busy"})
		server.internalAPIError(httptest.NewRecorder(), request, "sync account mutations", failure)
	}
	sentry.Flush(2 * time.Second)
	events := transport.Events()
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1 bounded repeat", len(events))
	}
	if events[0].Tags["error.cause"] != "sqlite_busy" {
		t.Fatalf("cause = %q, want sqlite_busy", events[0].Tags["error.cause"])
	}
}

func TestR48S06NestedSecretsStayOutWithCause(t *testing.T) {
	transport := initMockSentry(t)
	server := &Server{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	secrets := []string{
		"task-content-secret-321", "token-secret-xyz", "bearer-secret-123",
		"session-secret-456", "user@example.com", "/data/account-secret-999",
		"https://example.com/sync?token=token-secret-xyz",
	}
	inner := &testSQLiteError{code: 19, msg: "constraint failed for task-content-secret-321"}
	mid := fmt.Errorf("commit sync for user@example.com token token-secret-xyz: %w", inner)
	outer := errors.Join(mid, errors.New("path /data/account-secret-999 https://example.com/sync?token=token-secret-xyz"))
	request, _ := newPIIRequest()
	request.Header.Set("Authorization", "Bearer bearer-secret-123")
	server.internalAPIError(httptest.NewRecorder(), request, "sync account mutations", outer)
	sentry.Flush(2 * time.Second)
	events := transport.Events()
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1", len(events))
	}
	if events[0].Tags["error.cause"] != "sqlite_constraint" {
		t.Fatalf("cause = %q, want sqlite_constraint", events[0].Tags["error.cause"])
	}
	payload, err := json.Marshal(events[0])
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range secrets {
		if strings.Contains(string(payload), secret) {
			t.Fatalf("payload contains secret %q", secret)
		}
	}
	if !strings.Contains(string(payload), "sqlite_constraint") {
		t.Fatal("payload lost bounded cause class")
	}
	if !strings.Contains(string(payload), "sync account mutations") {
		t.Fatal("payload lost static operation")
	}
}

func TestR48S06CauseUsesTypedEvidenceOnly(t *testing.T) {
	closed := fmt.Errorf("dispatch: %w", sharedcore.ErrClosed)
	runtime := &requestRuntimeError{cause: errors.New("bad core output")}
	cases := map[error]string{
		context.Canceled:                         "request_canceled",
		context.DeadlineExceeded:                 "deadline_exceeded",
		closed:                                   "runtime_closed",
		runtime:                                  "runtime_output",
		&testSQLiteError{code: 11, msg: "x"}:     "sqlite_corrupt",
		fmt.Errorf("open: %w", os.ErrPermission): "io_permission",
	}
	for failure, want := range cases {
		if got := monitoringCause(failure); got != want {
			t.Fatalf("cause(%v) = %q, want %q", failure, got, want)
		}
	}
	for _, failure := range []error{
		errors.New("read timer commands: context canceled"),
		errors.New("shared core is closed"),
		errors.New("database is locked (SQLITE_BUSY)"),
		errors.New(""),
		nil,
	} {
		if got := monitoringCause(failure); got != "internal" {
			t.Fatalf("cause(%v) = %q, want internal", failure, got)
		}
	}
}
