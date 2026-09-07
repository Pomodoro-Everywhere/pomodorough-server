package server

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
)

func TestStaticServeFailuresReportPatternOnly(t *testing.T) {
	transport := &sentry.MockTransport{}
	if err := sentry.Init(sentry.ClientOptions{Dsn: "https://public@example.com/1", Transport: transport}); err != nil {
		t.Fatal(err)
	}
	defer sentry.CurrentHub().BindClient(nil)
	operations := []string{"open OpenAPI specification", "open SPA entrypoint", "open web entrypoint", "read web entrypoint"}
	request, secrets := newPIIRequest()
	for _, operation := range operations {
		reportInternalErrorToErrorMonitoring(errors.New("store unavailable"), request, operation)
	}
	sentry.Flush(2 * time.Second)
	events := transport.Events()
	if len(events) != len(operations) {
		t.Fatalf("events = %d, want %d", len(events), len(operations))
	}
	for i, operation := range operations {
		if events[i].Tags["error.operation"] != operation {
			t.Fatalf("event %d operation = %q, want %q", i, events[i].Tags["error.operation"], operation)
		}
		if events[i].Tags["http.method"] != http.MethodPost {
			t.Fatalf("event %d http.method = %q, want POST", i, events[i].Tags["http.method"])
		}
		if events[i].Tags["http.route"] != "POST /api/v1/sync" {
			t.Fatalf("event %d http.route = %q, want pattern", i, events[i].Tags["http.route"])
		}
		assertEventHasNoPII(t, events[i], secrets)
	}
}

func TestOpenAPISpecFailureReportsPatternTaggedEvent(t *testing.T) {
	transport := &sentry.MockTransport{}
	if err := sentry.Init(sentry.ClientOptions{Dsn: "https://public@example.com/1", Transport: transport}); err != nil {
		t.Fatal(err)
	}
	defer sentry.CurrentHub().BindClient(nil)
	fixture := newServerFixture(t)
	fixture.application.logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := os.Remove(filepath.Join(fixture.application.cfg.WebRoot, "openapi.yaml")); err != nil {
		t.Fatal(err)
	}
	target := "https://pomodorough.egigoka.me/openapi.yaml?token=token-secret-xyz"
	request := httptest.NewRequest(http.MethodGet, target, nil)
	request.Header.Set("Authorization", "Bearer bearer-secret-123")
	request.AddCookie(&http.Cookie{Name: "session", Value: "session-secret-456"})
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", response.Code)
	}
	sentry.Flush(2 * time.Second)
	events := transport.Events()
	if len(events) != 1 {
		t.Fatalf("events = %d, want exactly 1", len(events))
	}
	if events[0].Tags["error.operation"] != "open OpenAPI specification" {
		t.Fatalf("error.operation = %q, want open OpenAPI specification", events[0].Tags["error.operation"])
	}
	assertStaticPatternTags(t, events[0], http.MethodGet)
	secrets := []string{"token-secret-xyz", "bearer-secret-123", "session-secret-456"}
	assertEventHasNoPII(t, events[0], secrets)
}

func TestMissingAppEntrypointFailuresReportEvents(t *testing.T) {
	tests := []struct {
		name      string
		path      string
		operation string
	}{
		{name: "SPA entrypoint", path: "/app/missing-route", operation: "open SPA entrypoint"},
		{name: "web entrypoint", path: "/app", operation: "open web entrypoint"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assertMissingEntrypointReports(t, test.path, test.operation)
		})
	}
}

func assertMissingEntrypointReports(t *testing.T, path, operation string) {
	t.Helper()
	transport := &sentry.MockTransport{}
	if err := sentry.Init(sentry.ClientOptions{Dsn: "https://public@example.com/1", Transport: transport}); err != nil {
		t.Fatal(err)
	}
	defer sentry.CurrentHub().BindClient(nil)
	fixture := newServerFixture(t)
	fixture.application.logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := os.Remove(filepath.Join(fixture.application.cfg.WebRoot, "app.html")); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me"+path, nil)
	addWebAuthentication(request, fixture)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", response.Code)
	}
	sentry.Flush(2 * time.Second)
	events := transport.Events()
	if len(events) != 1 {
		t.Fatalf("events = %d, want exactly 1", len(events))
	}
	if events[0].Tags["error.operation"] != operation {
		t.Fatalf("error.operation = %q, want %q", events[0].Tags["error.operation"], operation)
	}
	assertStaticPatternTags(t, events[0], http.MethodGet)
	assertEventHasNoPII(t, events[0], nil)
}

func assertStaticPatternTags(t *testing.T, event *sentry.Event, method string) {
	t.Helper()
	if event.Tags["http.method"] != method {
		t.Fatalf("http.method = %q, want %q", event.Tags["http.method"], method)
	}
	if event.Tags["http.route"] == "" {
		t.Fatal("http.route is empty, want route pattern")
	}
}
