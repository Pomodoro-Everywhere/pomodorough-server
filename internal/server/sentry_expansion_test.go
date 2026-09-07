package server

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
	"golang.org/x/oauth2"

	"pomodorough/internal/authn"
)

func TestReadinessFailureReportsCodePatternOnly(t *testing.T) {
	transport := initMockSentry(t)
	fixture := newReadinessTestFixture(t)
	if err := os.Remove(filepath.Join(fixture.webRoot, "index.html")); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/readyz?token=token-secret-xyz", nil)
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
	if events[0].Tags["error.operation"] != "readiness check web_unavailable" {
		t.Fatalf("error.operation = %q, want readiness code", events[0].Tags["error.operation"])
	}
	if events[0].Tags["http.method"] != http.MethodGet {
		t.Fatalf("http.method = %q, want GET", events[0].Tags["http.method"])
	}
	if events[0].Tags["http.route"] == "" {
		t.Fatal("http.route is empty, want route pattern")
	}
	assertEventHasNoPII(t, events[0], []string{"token-secret-xyz", "bearer-secret-123", "session-secret-456"})
}

func TestGoogleExchange502ReportsPatternOnly(t *testing.T) {
	transport := initMockSentry(t)
	fixture, sealed := newExchangeFixture(t, failingTokenServer(t))
	target := "https://pomodorough.egigoka.me/auth/google/callback?code=auth-code-secret&state=bound-state&token=token-secret-xyz"
	request := httptest.NewRequest(http.MethodGet, target, nil)
	request.Pattern = "GET /auth/google/callback"
	request.Header.Set("Authorization", "Bearer bearer-secret-123")
	request.AddCookie(&http.Cookie{Name: authn.OAuthStateCookie, Value: sealed})
	request.AddCookie(&http.Cookie{Name: "session", Value: "session-secret-456"})
	response := httptest.NewRecorder()
	fixture.application.handleGoogleCallback(response, request)
	if response.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", response.Code)
	}
	sentry.Flush(2 * time.Second)
	events := transport.Events()
	if len(events) != 1 {
		t.Fatalf("events = %d, want exactly 1", len(events))
	}
	if events[0].Tags["error.operation"] != "Google OAuth exchange failed" {
		t.Fatalf("error.operation = %q", events[0].Tags["error.operation"])
	}
	assertCallbackPattern(t, events[0])
	secrets := []string{"auth-code-secret", "token-secret-xyz", "bearer-secret-123", "session-secret-456"}
	assertEventHasNoPII(t, events[0], secrets)
}

func TestGoogleVerification401DoesNotReport(t *testing.T) {
	transport := initMockSentry(t)
	verifier, sign := testGoogleVerifier(t)
	now := time.Now()
	badClaims := testGoogleClaims("web-client", "wrong-nonce", now.Add(time.Hour))
	idToken := sign(badClaims)
	fixture, sealed := newExchangeFixture(t, succeedingTokenServer(t, idToken))
	request := httptest.NewRequest(http.MethodGet, "/auth/google/callback?code=authorization-code&state=bound-state", nil)
	request.Pattern = "GET /auth/google/callback"
	request.AddCookie(&http.Cookie{Name: authn.OAuthStateCookie, Value: sealed})
	fixture.application.webVerifier = verifier
	response := httptest.NewRecorder()
	fixture.application.handleGoogleCallback(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.Code)
	}
	sentry.Flush(2 * time.Second)
	if events := transport.Events(); len(events) != 0 {
		t.Fatalf("events = %d, want 0 for client-driven 401", len(events))
	}
}

func TestNativeVerificationFailureReportsPatternOnly(t *testing.T) {
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	fixture.application.cfg.GoogleNativeClientIDs = []string{"native-client"}
	fixture.application.cfg.GoogleNativeClientIDSet = map[string]struct{}{"native-client": {}}
	verifier, _ := testGoogleVerifier(t)
	fixture.application.nativeVerifier = verifier
	sealed, err := fixture.application.codec.Seal("native-challenge", authn.NativeChallenge{
		Nonce: "bound-nonce", ExpiresAt: time.Now().Add(time.Minute).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	payload := map[string]string{
		"idToken": "not-a-jwt-secret-xyz", "challenge": sealed,
		"deviceId": "native-device", "platform": "ios",
	}
	body, _ := json.Marshal(payload)
	target := "https://pomodorough.egigoka.me/api/v1/auth/google/exchange?token=token-secret-xyz"
	request := httptest.NewRequest(http.MethodPost, target, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Pattern = "POST /api/v1/auth/google/exchange"
	request.Header.Set("Authorization", "Bearer bearer-secret-123")
	request.AddCookie(&http.Cookie{Name: "session", Value: "session-secret-456"})
	response := httptest.NewRecorder()
	fixture.application.handleNativeExchange(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.Code)
	}
	sentry.Flush(2 * time.Second)
	events := transport.Events()
	if len(events) != 1 {
		t.Fatalf("events = %d, want exactly 1", len(events))
	}
	if events[0].Tags["error.operation"] != "native Google ID token verification failed" {
		t.Fatalf("error.operation = %q", events[0].Tags["error.operation"])
	}
	assertExchangePattern(t, events[0])
	secrets := []string{"not-a-jwt-secret-xyz", sealed, "token-secret-xyz", "bearer-secret-123", "session-secret-456"}
	assertEventHasNoPII(t, events[0], secrets)
}

func TestWriteRateLimitLogsPatternNotRawPath(t *testing.T) {
	var logs bytes.Buffer
	server := &Server{logger: slog.New(slog.NewTextHandler(&logs, nil))}
	request := httptest.NewRequest(http.MethodPost, "https://pomodorough.egigoka.me/api/v1/auth/google/exchange", nil)
	request.Pattern = "POST /api/v1/auth/google/exchange"
	response := httptest.NewRecorder()
	server.writeRateLimit(response, request, "ip", time.Minute)
	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", response.Code)
	}
	output := logs.String()
	if !strings.Contains(output, "route=/api/v1/auth/google/exchange") && !strings.Contains(output, "route=\"/api/v1/auth/google/exchange\"") {
		t.Fatalf("rate-limit log missing route pattern: %s", output)
	}
	if strings.Contains(output, "path=") {
		t.Fatalf("rate-limit log uses raw path, want route pattern: %s", output)
	}
}

func initMockSentry(t *testing.T) *sentry.MockTransport {
	t.Helper()
	transport := &sentry.MockTransport{}
	if err := sentry.Init(sentry.ClientOptions{Dsn: "https://public@example.com/1", Transport: transport}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sentry.CurrentHub().BindClient(nil) })
	return transport
}

func newExchangeFixture(t *testing.T, tokenURL string) (serverFixture, string) {
	t.Helper()
	fixture := newServerFixture(t)
	fixture.application.cfg.GoogleWebClientID = "web-client"
	fixture.application.cfg.GoogleWebClientSecret = "web-secret"
	fixture.application.oauthConfig.ClientID = "web-client"
	fixture.application.oauthConfig.ClientSecret = "web-secret"
	fixture.application.oauthConfig.Endpoint = oauth2.Endpoint{TokenURL: tokenURL, AuthStyle: oauth2.AuthStyleInParams}
	sealed := sealBoundOAuthState(t, fixture)
	return fixture, sealed
}

func sealBoundOAuthState(t *testing.T, fixture serverFixture) string {
	t.Helper()
	state := authn.OAuthState{State: "bound-state", Nonce: "bound-nonce", CodeVerifier: "pkce-verifier", ReturnTo: "/app", ExpiresAt: time.Now().Add(time.Minute).Unix()}
	sealed, err := fixture.application.codec.Seal("oauth-state", state)
	if err != nil {
		t.Fatal(err)
	}
	return sealed
}

func failingTokenServer(t *testing.T) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, `{"error":"upstream"}`)
	}))
	t.Cleanup(server.Close)
	return server.URL
}

func succeedingTokenServer(t *testing.T, idToken string) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "provider-access", "token_type": "Bearer", "id_token": idToken})
	}))
	t.Cleanup(server.Close)
	return server.URL
}

func assertCallbackPattern(t *testing.T, event *sentry.Event) {
	t.Helper()
	if event.Tags["http.method"] != http.MethodGet {
		t.Fatalf("http.method = %q, want GET", event.Tags["http.method"])
	}
	if event.Tags["http.route"] != "GET /auth/google/callback" {
		t.Fatalf("http.route = %q, want pattern", event.Tags["http.route"])
	}
}

func assertExchangePattern(t *testing.T, event *sentry.Event) {
	t.Helper()
	if event.Tags["http.method"] != http.MethodPost {
		t.Fatalf("http.method = %q, want POST", event.Tags["http.method"])
	}
	if event.Tags["http.route"] != "POST /api/v1/auth/google/exchange" {
		t.Fatalf("http.route = %q, want pattern", event.Tags["http.route"])
	}
}
