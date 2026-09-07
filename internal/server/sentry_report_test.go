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
