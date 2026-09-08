package server

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
)

func TestReportPanicToErrorMonitoringWithoutMonitoring(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/me", nil)
	request.Pattern = "GET /api/v1/me"
	reportPanicToErrorMonitoring(errors.New("boom"), request)
	reportPanicToErrorMonitoring("string panic", request)
	patternless := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/", nil)
	reportPanicToErrorMonitoring(errors.New("boom"), patternless)
}

func TestInternalAPIErrorReportsOnePatternTaggedEvent(t *testing.T) {
	transport := &sentry.MockTransport{}
	if err := sentry.Init(sentry.ClientOptions{Dsn: "https://public@example.com/1", Transport: transport}); err != nil {
		t.Fatal(err)
	}
	defer sentry.CurrentHub().BindClient(nil)
	server := &Server{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	request, secrets := newPIIRequest()
	response := httptest.NewRecorder()
	server.internalAPIError(response, request, "sync account mutations", errors.New("store unavailable"))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusInternalServerError)
	}
	sentry.Flush(2 * time.Second)
	events := transport.Events()
	if len(events) != 1 {
		t.Fatalf("events = %d, want exactly 1", len(events))
	}
	assertPatternTags(t, events[0])
	assertEventHasNoPII(t, events[0], secrets)
}

func newPIIRequest() (*http.Request, []string) {
	body := `{"refreshToken":"body-secret-789","invite":"invite-secret-abc"}`
	target := "https://pomodorough.egigoka.me/api/v1/sync" +
		"?invite=invite-secret-abc&token=token-secret-xyz&email=user@example.com"
	request := httptest.NewRequest(http.MethodPost, target, strings.NewReader(body))
	request.Pattern = "POST /api/v1/sync"
	request.Header.Set("Authorization", "Bearer bearer-secret-123")
	request.AddCookie(&http.Cookie{Name: "session", Value: "session-secret-456"})
	secrets := []string{
		"invite-secret-abc", "token-secret-xyz", "user@example.com",
		"bearer-secret-123", "session-secret-456", "body-secret-789",
	}
	return request, secrets
}

func assertPatternTags(t *testing.T, event *sentry.Event) {
	t.Helper()
	if event.Tags["http.method"] != http.MethodPost {
		t.Fatalf("http.method = %q, want POST", event.Tags["http.method"])
	}
	if event.Tags["http.route"] != "POST /api/v1/sync" {
		t.Fatalf("http.route = %q, want pattern", event.Tags["http.route"])
	}
	if event.Tags["error.operation"] != "sync account mutations" {
		t.Fatalf("error.operation = %q, want operation", event.Tags["error.operation"])
	}
}

func assertEventHasNoPII(t *testing.T, event *sentry.Event, secrets []string) {
	t.Helper()
	if event.Request != nil {
		t.Fatalf("event request = %+v, want nil", event.Request)
	}
	if !event.User.IsEmpty() {
		t.Fatalf("event user = %+v, want empty", event.User)
	}
	payload, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range secrets {
		if strings.Contains(string(payload), secret) {
			t.Fatalf("event payload contains PII %q", secret)
		}
	}
	for key, value := range event.Tags {
		for _, secret := range secrets {
			if strings.Contains(value, secret) {
				t.Fatalf("tag %q contains PII %q", key, secret)
			}
		}
	}
}

func TestWriteJSONEncodeFailureReportsPatternOnly(t *testing.T) {
	transport := &sentry.MockTransport{}
	if err := sentry.Init(sentry.ClientOptions{Dsn: "https://public@example.com/1", Transport: transport}); err != nil {
		t.Fatal(err)
	}
	defer sentry.CurrentHub().BindClient(nil)
	target := "https://pomodorough.egigoka.me/api/v1/me?token=token-secret-xyz"
	request := httptest.NewRequest(http.MethodGet, target, nil)
	request.Pattern = "GET /api/v1/me"
	request.Header.Set("Authorization", "Bearer bearer-secret-123")
	response := httptest.NewRecorder()
	writeJSON(response, request, http.StatusOK, map[string]any{"bad": func() {}})
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	sentry.Flush(2 * time.Second)
	events := transport.Events()
	if len(events) != 1 {
		t.Fatalf("events = %d, want exactly 1", len(events))
	}
	if events[0].Tags["error.operation"] != "encode JSON response" {
		t.Fatalf("error.operation = %q, want encode JSON response", events[0].Tags["error.operation"])
	}
	if events[0].Tags["http.method"] != http.MethodGet {
		t.Fatalf("http.method = %q, want GET", events[0].Tags["http.method"])
	}
	if events[0].Tags["http.route"] != "GET /api/v1/me" {
		t.Fatalf("http.route = %q, want pattern", events[0].Tags["http.route"])
	}
	assertEventHasNoPII(t, events[0], []string{"token-secret-xyz", "bearer-secret-123"})
}

func TestWriteJSONSuccessDoesNotReport(t *testing.T) {
	transport := initMockSentry(t)
	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/healthz", nil)
	request.Pattern = "GET /healthz"
	writeJSON(httptest.NewRecorder(), request, http.StatusOK, map[string]string{"status": "ok"})
	sentry.Flush(2 * time.Second)
	if events := transport.Events(); len(events) != 0 {
		t.Fatalf("events = %d, want 0 for encodable payload", len(events))
	}
}

type metricsFailingWriter struct {
	header http.Header
	status int
	err    error
}

func (w *metricsFailingWriter) Header() http.Header { return w.header }

func (w *metricsFailingWriter) WriteHeader(status int) { w.status = status }

func (w *metricsFailingWriter) Write([]byte) (int, error) { return 0, w.err }

func TestMetricsWriteFailureReportsPatternOnly(t *testing.T) {
	transport := initMockSentry(t)
	server := &Server{logger: slog.New(slog.NewTextHandler(io.Discard, nil)), metrics: newRequestMetrics()}
	server.metrics.observe(http.MethodGet, "GET /healthz", http.StatusOK, time.Millisecond)
	target := "https://pomodorough.egigoka.me/metrics?token=token-secret-xyz"
	request := httptest.NewRequest(http.MethodGet, target, nil)
	request.Pattern = "GET /metrics"
	request.Header.Set("Authorization", "Bearer bearer-secret-123")
	writer := &metricsFailingWriter{header: make(http.Header), err: errors.New("metrics write failed")}
	server.handleMetrics(writer, request)
	if writer.status != http.StatusOK {
		t.Fatalf("status = %d, want 200", writer.status)
	}
	sentry.Flush(2 * time.Second)
	events := transport.Events()
	if len(events) != 1 {
		t.Fatalf("events = %d, want exactly 1", len(events))
	}
	if events[0].Tags["error.operation"] != "write metrics response" {
		t.Fatalf("error.operation = %q, want write metrics response", events[0].Tags["error.operation"])
	}
	if events[0].Tags["http.method"] != http.MethodGet {
		t.Fatalf("http.method = %q, want GET", events[0].Tags["http.method"])
	}
	if events[0].Tags["http.route"] != "GET /metrics" {
		t.Fatalf("http.route = %q, want pattern", events[0].Tags["http.route"])
	}
	assertEventHasNoPII(t, events[0], []string{"token-secret-xyz", "bearer-secret-123"})
}

func TestMetricsWriteSuccessDoesNotReport(t *testing.T) {
	transport := initMockSentry(t)
	server := &Server{logger: slog.New(slog.NewTextHandler(io.Discard, nil)), metrics: newRequestMetrics()}
	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/metrics", nil)
	request.Pattern = "GET /metrics"
	server.handleMetrics(httptest.NewRecorder(), request)
	sentry.Flush(2 * time.Second)
	if events := transport.Events(); len(events) != 0 {
		t.Fatalf("events = %d, want 0 for successful metrics write", len(events))
	}
}
