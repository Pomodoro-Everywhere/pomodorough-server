package server

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
)

func TestInternalErrorRepeatBurstEmitsOneSampledEvent(t *testing.T) {
	transport := initMockSentry(t)
	server := &Server{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	for range 5 {
		request, _ := newPIIRequest()
		server.internalAPIError(httptest.NewRecorder(), request, "sync account mutations", errors.New("store unavailable"))
	}
	sentry.Flush(2 * time.Second)
	if events := transport.Events(); len(events) != 1 {
		t.Fatalf("events = %d, want 1 sampled error for the burst", len(events))
	}
}

func TestInternalErrorDistinctKeysReportSeparately(t *testing.T) {
	transport := initMockSentry(t)
	server := &Server{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	request, _ := newPIIRequest()
	server.internalAPIError(httptest.NewRecorder(), request, "sync account mutations", errors.New("boom"))
	server.internalAPIError(httptest.NewRecorder(), request, "read bootstrap snapshot", errors.New("boom"))
	sentry.Flush(2 * time.Second)
	if events := transport.Events(); len(events) != 2 {
		t.Fatalf("events = %d, want 2 for distinct operations", len(events))
	}
}

func TestInternalErrorKeyIgnoresRawPathAndQuery(t *testing.T) {
	transport := initMockSentry(t)
	server := &Server{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	first := httptest.NewRequest(http.MethodPost, "https://pomodorough.egigoka.me/api/v1/sync?token=a", nil)
	first.Pattern = "POST /api/v1/sync"
	second := httptest.NewRequest(http.MethodPost, "https://pomodorough.egigoka.me/api/v1/sync?token=b", nil)
	second.Pattern = "POST /api/v1/sync"
	server.internalAPIError(httptest.NewRecorder(), first, "sync account mutations", errors.New("boom"))
	server.internalAPIError(httptest.NewRecorder(), second, "sync account mutations", errors.New("boom"))
	sentry.Flush(2 * time.Second)
	if events := transport.Events(); len(events) != 1 {
		t.Fatalf("events = %d, want 1 when only raw path differs", len(events))
	}
}

func TestInternalErrorBackoffExpiryReportsAgain(t *testing.T) {
	transport := initMockSentry(t)
	now := time.Now()
	oldNow := errorSampleNow
	oldJitter := errorSampleJitter
	errorSampleNow = func() time.Time { return now }
	errorSampleJitter = func() float64 { return 0.5 }
	defer func() { errorSampleNow = oldNow; errorSampleJitter = oldJitter }()
	server := &Server{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	request, _ := newPIIRequest()
	server.internalAPIError(httptest.NewRecorder(), request, "sync account mutations", errors.New("boom"))
	request, _ = newPIIRequest()
	server.internalAPIError(httptest.NewRecorder(), request, "sync account mutations", errors.New("boom"))
	now = now.Add(errorRepeatMaxBackoff + time.Second)
	request, _ = newPIIRequest()
	server.internalAPIError(httptest.NewRecorder(), request, "sync account mutations", errors.New("boom"))
	sentry.Flush(2 * time.Second)
	if events := transport.Events(); len(events) != 2 {
		t.Fatalf("events = %d, want 2 across the backoff expiry", len(events))
	}
}

func TestInternalErrorBackoffStaysBoundedWithJitter(t *testing.T) {
	oldJitter := errorSampleJitter
	defer func() { errorSampleJitter = oldJitter }()
	errorSampleJitter = func() float64 { return 0 }
	low := internalErrorBackoff(0)
	errorSampleJitter = func() float64 { return 1 }
	high := internalErrorBackoff(0)
	if low < 24*time.Second || low > 30*time.Second {
		t.Fatalf("low backoff = %s, want within 24s..30s", low)
	}
	if high < 30*time.Second || high > 36*time.Second {
		t.Fatalf("high backoff = %s, want within 30s..36s", high)
	}
	if capped := internalErrorBackoff(99); capped < 8*time.Minute || capped > 12*time.Minute {
		t.Fatalf("capped backoff = %s, want near 10m", capped)
	}
}

func TestInternalAPIErrorEchoesIdempotencyKey(t *testing.T) {
	_ = initMockSentry(t)
	server := &Server{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	request, _ := newPIIRequest()
	request.Header.Set("Idempotency-Key", "key-123")
	response := httptest.NewRecorder()
	server.internalAPIError(response, request, "sync account mutations", errors.New("boom"))
	if got := response.Header().Get("Idempotency-Key"); got != "key-123" {
		t.Fatalf("Idempotency-Key echo = %q, want key-123", got)
	}
	sentry.Flush(2 * time.Second)
	plain, _ := newPIIRequest()
	response = httptest.NewRecorder()
	server.internalAPIError(response, plain, "read bootstrap snapshot", errors.New("boom"))
	if got := response.Header().Get("Idempotency-Key"); got != "" {
		t.Fatalf("Idempotency-Key echo = %q, want absent", got)
	}
}

func TestInternalErrorTagsIdempotencyPresenceOnly(t *testing.T) {
	transport := initMockSentry(t)
	server := &Server{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	request, _ := newPIIRequest()
	request.Header.Set("Idempotency-Key", "secret-key-999")
	server.internalAPIError(httptest.NewRecorder(), request, "sync account mutations", errors.New("boom"))
	sentry.Flush(2 * time.Second)
	events := transport.Events()
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1", len(events))
	}
	if events[0].Tags["http.idempotency_key"] != "present" {
		t.Fatalf("idempotency tag = %q, want present", events[0].Tags["http.idempotency_key"])
	}
	for _, value := range events[0].Tags {
		if value == "secret-key-999" {
			t.Fatal("idempotency key value leaked into tags")
		}
	}
}
