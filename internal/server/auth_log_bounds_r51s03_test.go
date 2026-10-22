package server

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"

	"pomodorough/internal/authn"
)

func r51S03CaptureDebugLogs(app *Server) *bytes.Buffer {
	logs := &bytes.Buffer{}
	app.logger = slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	return logs
}

func r51S03HugeCanary(t *testing.T, prefix string) string {
	t.Helper()
	return prefix + strings.Repeat("x", 12000)
}

// r51S03MaxLogLine caps a single log line. The 8192 total bound alone
// could hide one long line carrying a split canary, so the per-line bound
// stays even if log volume grows.
const r51S03MaxLogLine = 2048

func r51S03AssertBoundedNoCanary(t *testing.T, output, canary string) {
	t.Helper()
	prefix := canary
	if len(prefix) > 32 {
		prefix = prefix[:32]
	}
	if strings.Contains(output, canary) {
		t.Fatalf("logs contain canary prefix %q in %d bytes", prefix, len(output))
	}
	if len(output) > 8192 {
		t.Fatalf("log size=%d, want bounded <8192", len(output))
	}
	for _, line := range strings.Split(output, "\n") {
		if len(line) > r51S03MaxLogLine {
			t.Fatalf("log line=%d bytes, want per-line bound <=%d", len(line), r51S03MaxLogLine)
		}
	}
}

func TestR51S03OversizedIssuerCapped(t *testing.T) {
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	logs := r49S08CaptureLogs(fixture.application)
	sign := r51S02EnableNative(t, &fixture)
	canary := r51S03HugeCanary(t, "r51-untrusted-issuer-canary-")
	claims := testGoogleClaims("native-client", "bound-nonce", time.Now().Add(time.Hour))
	claims["iss"] = canary
	sealed := r51S02SealedChallenge(t, fixture, "bound-nonce")
	response := r51S02Exchange(t, fixture.application, sign(claims), sealed, nil)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d, want 401", response.Code)
	}
	sentry.Flush(2 * time.Second)
	if events := transport.Events(); len(events) != 0 {
		t.Fatalf("events=%d, want 0", len(events))
	}
	output := logs.String()
	r51S03AssertBoundedNoCanary(t, output, canary)
	assertLogHasNoPII(t, output, []string{canary, sealed})
	if !strings.Contains(output, "reason=invalid_issuer") && !strings.Contains(output, "reason=invalid_signature") {
		t.Fatalf("missing bounded issuer reason: %s", output)
	}
}

func TestR51S03OversizedProviderBodyCapped(t *testing.T) {
	transport := initMockSentry(t)
	canary := "r51-provider-body-canary-" + strings.Repeat("y", 12000)
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, `{"error":"upstream","error_description":"`+canary+`"}`)
	}))
	t.Cleanup(tokenServer.Close)
	fixture, sealed := newExchangeFixture(t, tokenServer.URL)
	logs := r49S08CaptureLogs(fixture.application)
	target := "https://pomodorough.egigoka.me/auth/google/callback?code=auth-code&state=bound-state"
	request := httptest.NewRequest(http.MethodGet, target, nil)
	request.Pattern = "GET /auth/google/callback"
	request.AddCookie(&http.Cookie{Name: authn.OAuthStateCookie, Value: sealed})
	response := httptest.NewRecorder()
	fixture.application.handleGoogleCallback(response, request)
	if response.Code != http.StatusBadGateway {
		t.Fatalf("status=%d, want 502", response.Code)
	}
	sentry.Flush(2 * time.Second)
	events := transport.Events()
	if len(events) != 1 {
		t.Fatalf("events=%d, want 1 bounded outage report", len(events))
	}
	assertEventHasNoPII(t, events[0], []string{canary, "auth-code"})
	output := logs.String()
	r51S03AssertBoundedNoCanary(t, output, canary)
	assertLogHasNoPII(t, output, []string{canary, "auth-code", sealed})
	if !strings.Contains(output, "cause=") {
		t.Fatalf("missing bounded cause: %s", output)
	}
}

func TestR51S03RotationDebugStaticLine(t *testing.T) {
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	logs := r51S03CaptureDebugLogs(fixture.application)
	first := postRefresh(t, fixture, fixture.refreshToken)
	if first.Code != http.StatusOK {
		t.Fatalf("first rotation=%d, want 200", first.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(first.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	reuse := postRefresh(t, fixture, fixture.refreshToken)
	if reuse.Code != http.StatusUnauthorized {
		t.Fatalf("reuse=%d, want 401", reuse.Code)
	}
	sentry.Flush(2 * time.Second)
	if events := transport.Events(); len(events) != 0 {
		t.Fatalf("events=%d, want 0 for reuse", len(events))
	}
	output := logs.String()
	if !strings.Contains(output, "refresh rotation classified") || !strings.Contains(output, "reuse_detected") {
		t.Fatalf("missing rotation DEBUG static line: %s", output)
	}
	if !strings.Contains(output, "refresh token reuse revoked session family") {
		t.Fatalf("missing reuse WARN static line: %s", output)
	}
	r51S03AssertBoundedNoCanary(t, output, fixture.refreshToken)
	assertLogHasNoPII(t, output, []string{fixture.refreshToken, fixture.userID})
}

func TestR51S03AudienceDebugStaticLine(t *testing.T) {
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	logs := r51S03CaptureDebugLogs(fixture.application)
	sign := r51S02EnableNative(t, &fixture)
	claims := testGoogleClaims("other-client", "bound-nonce", time.Now().Add(time.Hour))
	sealed := r51S02SealedChallenge(t, fixture, "bound-nonce")
	response := r51S02Exchange(t, fixture.application, sign(claims), sealed, nil)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d, want 401", response.Code)
	}
	sentry.Flush(2 * time.Second)
	if events := transport.Events(); len(events) != 0 {
		t.Fatalf("events=%d, want 0", len(events))
	}
	output := logs.String()
	if !strings.Contains(output, "audience classified") || !strings.Contains(output, "invalid_audience") {
		t.Fatalf("missing audience DEBUG static line: %s", output)
	}
	r51S03AssertBoundedNoCanary(t, output, "other-client")
	assertLogHasNoPII(t, output, []string{"other-client", sealed})
}

func assertLogHasNoPII(t *testing.T, output string, secrets []string) {
	t.Helper()
	for _, secret := range secrets {
		if secret == "" {
			continue
		}
		if strings.Contains(output, secret) {
			t.Fatalf("log contains secret %q", secret)
		}
		if escaped, err := json.Marshal(secret); err == nil {
			if trimmed := strings.Trim(string(escaped), `"`); trimmed != secret && strings.Contains(output, trimmed) {
				t.Fatalf("log contains escaped secret %q", trimmed)
			}
		}
	}
}
