package server

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/getsentry/sentry-go"
	jose "github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"

	"pomodorough/internal/authn"
	"pomodorough/internal/store"
)

// R51-S02: native client rejection must fail closed as an expected 401
// with taxonomy and zero Sentry events. Only a genuine key-provider
// outage keeps the sampled Sentry report. Cancellation stays quiet with
// its own metric. The challenge stays unconsumed on every path.

func r51S02EnableNative(t *testing.T, fixture *serverFixture) func(map[string]any) string {
	t.Helper()
	fixture.application.cfg.GoogleNativeClientIDs = []string{"native-client"}
	fixture.application.cfg.GoogleNativeClientIDSet = map[string]struct{}{"native-client": {}}
	verifier, sign := testGoogleVerifier(t)
	fixture.application.nativeVerifier = verifier
	return sign
}

func r51S02SealedChallenge(t *testing.T, fixture serverFixture, nonce string) string {
	t.Helper()
	issuedAt := time.Now()
	expiresAt := issuedAt.Add(time.Minute)
	sealed, err := fixture.application.codec.Seal("native-challenge", authn.NativeChallenge{
		Nonce: nonce, ExpiresAt: expiresAt.Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	digest := store.HashNativeChallenge(nativeChallengeDomain, sealed)
	if err := fixture.userStore.CreateNativeChallenge(context.Background(), digest, nativeChallengeDomain, issuedAt, expiresAt); err != nil {
		t.Fatal(err)
	}
	return sealed
}

func r51S02Exchange(t *testing.T, app *Server, idToken, sealed string, ctx context.Context) *httptest.ResponseRecorder {
	t.Helper()
	request, response := newJSONRequest(t, http.MethodPost, "https://pomodorough.egigoka.me/api/v1/auth/google/exchange", map[string]string{
		"idToken": idToken, "challenge": sealed, "deviceId": "native-device", "platform": "ios",
	})
	if ctx != nil {
		request = request.WithContext(ctx)
	}
	request.Pattern = "POST /api/v1/auth/google/exchange"
	app.handleNativeExchange(response, request)
	return response
}

func r51S02NativeSessionCount(t *testing.T, fixture serverFixture) int {
	t.Helper()
	db, err := fixture.userStore.OpenExistingUser(context.Background(), fixture.userID)
	if err != nil {
		return 0
	}
	defer db.Close()
	var count int
	if err := db.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM auth_sessions`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func r51S02JWTPart(t *testing.T, payload string) string {
	t.Helper()
	return base64.RawURLEncoding.EncodeToString([]byte(payload))
}

func TestR51S02MalformedTokenMatrixDoesNotReport(t *testing.T) {
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	logs := r49S08CaptureLogs(fixture.application)
	sign := r51S02EnableNative(t, &fixture)
	_, otherSign := testGoogleVerifier(t)

	header := r51S02JWTPart(t, `{"alg":"RS256","typ":"JWT"}`)
	validPayload := r51S02JWTPart(t, `{"sub":"x"}`)
	validSig := r51S02JWTPart(t, "sig")
	sealed := r51S02SealedChallenge(t, fixture, "bound-nonce")
	before := r51S02NativeSessionCount(t, fixture)

	now := time.Now()
	valid := sign(testGoogleClaims("native-client", "bound-nonce", now.Add(time.Hour)))
	cases := []struct {
		name  string
		token string
	}{
		{"no segments", "not-a-jwt-secret-xyz"},
		{"two segments", "abc.def"},
		{"four segments", "a.b.c.d"},
		{"bad header encoding", "!!!." + validPayload + "." + validSig},
		{"bad payload encoding", header + ".!!!." + validSig},
		{"non-JSON payload", header + "." + r51S02JWTPart(t, "not json") + "." + validSig},
		{"empty signature", header + "." + validPayload + "."},
		{"bad signature encoding", header + "." + validPayload + ".!!!"},
		{"unknown key signature", otherSign(testGoogleClaims("native-client", "bound-nonce", now.Add(time.Hour)))},
		{"expired", sign(testGoogleClaims("native-client", "bound-nonce", now.Add(-time.Minute)))},
		{"wrong nonce", sign(testGoogleClaims("native-client", "other-nonce", now.Add(time.Hour)))},
		{"wrong audience", sign(testGoogleClaims("other-client", "bound-nonce", now.Add(time.Hour)))},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if response := r51S02Exchange(t, fixture.application, tc.token, sealed, nil); response.Code != http.StatusUnauthorized {
				t.Fatalf("status=%d body=%s, want 401", response.Code, response.Body.String())
			}
			sentry.Flush(2 * time.Second)
			if events := transport.Events(); len(events) != 0 {
				t.Fatalf("events=%d after %q, want 0 for client-driven 401", len(events), tc.name)
			}
		})
	}
	sentry.Flush(2 * time.Second)
	if events := transport.Events(); len(events) != 0 {
		t.Fatalf("events = %d, want 0 for client-driven 401s", len(events))
	}
	r51S02AssertMatrixAftermath(t, logs.String(), fixture, sealed, valid, before)
}

func r51S02AssertMatrixAftermath(t *testing.T, logs string, fixture serverFixture, sealed, valid string, before int) {
	t.Helper()
	for _, reason := range []string{"reason=malformed_token", "reason=invalid_signature", "reason=expired_token", "reason=invalid_nonce", "reason=invalid_audience"} {
		if !strings.Contains(logs, reason) {
			t.Fatalf("WARN logs missing static %q: %s", reason, logs)
		}
	}
	for _, secret := range []string{"not-a-jwt-secret-xyz", sealed} {
		if strings.Contains(logs, secret) {
			t.Fatalf("WARN logs contain secret %q", secret)
		}
	}
	if got := r51S02NativeSessionCount(t, fixture); got != before {
		t.Fatalf("sessions=%d, want unchanged %d", got, before)
	}
	if response := r51S02Exchange(t, fixture.application, valid, sealed, nil); response.Code != http.StatusOK {
		t.Fatalf("retry status=%d body=%s, want 200", response.Code, response.Body.String())
	}
}

// TestR51S02MalformedExchangeThroughMiddleware routes one client-driven
// 401 through the full mux plus recover/logging/security middleware. The
// request carries no preset Pattern: the mux must supply the route pattern
// so metrics and monitoring observe the pattern, never the raw path. Direct
// handleNativeExchange calls above stay as precise taxonomy units.
func TestR51S02MalformedExchangeThroughMiddleware(t *testing.T) {
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	logs := r49S08CaptureLogs(fixture.application)
	sign := r51S02EnableNative(t, &fixture)
	sealed := r51S02SealedChallenge(t, fixture, "bound-nonce")
	before := r51S02NativeSessionCount(t, fixture)

	request, response := newJSONRequest(t, http.MethodPost, "https://pomodorough.egigoka.me/api/v1/auth/google/exchange", map[string]string{
		"idToken": "not-a-jwt-secret-xyz", "challenge": sealed, "deviceId": "native-device", "platform": "ios",
	})
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s, want 401", response.Code, response.Body.String())
	}
	if body := response.Body.String(); body != "{\"error\":\"invalid Google token\"}\n" {
		t.Fatalf("body=%q, want exact invalid-token JSON", body)
	}
	r51S02AssertRejectWire(t, response)
	sentry.Flush(2 * time.Second)
	if events := transport.Events(); len(events) != 0 {
		t.Fatalf("events=%d, want 0 for middleware-routed 401", len(events))
	}
	if !strings.Contains(logs.String(), "reason=malformed_token") {
		t.Fatalf("WARN logs missing static malformed reason: %s", logs.String())
	}
	if strings.Contains(logs.String(), "not-a-jwt-secret-xyz") {
		t.Fatal("WARN logs contain raw token")
	}
	if got := r51S02NativeSessionCount(t, fixture); got != before {
		t.Fatalf("sessions=%d, want unchanged %d", got, before)
	}
	valid := sign(testGoogleClaims("native-client", "bound-nonce", time.Now().Add(time.Hour)))
	if retry := r51S02Exchange(t, fixture.application, valid, sealed, nil); retry.Code != http.StatusOK {
		t.Fatalf("retry status=%d body=%s, want 200 unconsumed challenge", retry.Code, retry.Body.String())
	}
}

func r51S02AssertRejectWire(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d, want 401", response.Code)
	}
	if got := response.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type=%q, want exact JSON value", got)
	}
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control=%q, want no-store", got)
	}
	if cookies := response.Header().Values("Set-Cookie"); len(cookies) != 0 {
		t.Fatalf("rejection changed cookies: %q", cookies)
	}
}

// TestR51S02ProdShapedVerifierKeepsTaxonomy pins the rejection taxonomy
// under a prod-shaped verifier. The matrix above runs under a test verifier
// with SkipClientIDCheck, SkipIssuerCheck, and SkipExpiryCheck all set, so
// it proves the app layer only. Prod New builds nativeVerifier with only
// SkipClientIDCheck: the multi-client allowlist is enforced in
// checkGoogleTokenClaims, while issuer and expiry stay with oidc. Prod must
// never add SkipIssuerCheck or SkipExpiryCheck, or forged-issuer and expired
// tokens bypass oidc before the taxonomy runs.
func TestR51S02ProdShapedVerifierKeepsTaxonomy(t *testing.T) {
	if newServerFixture(t).application.nativeVerifier == nil {
		t.Fatal("prod nativeVerifier not built")
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, (&jose.SignerOptions{}).WithType("JWT"))
	if err != nil {
		t.Fatal(err)
	}
	strict := oidc.NewVerifier(googleIssuer, &oidc.StaticKeySet{PublicKeys: []crypto.PublicKey{&key.PublicKey}}, &oidc.Config{
		SkipClientIDCheck: true,
	})
	sign := func(claims map[string]any) string {
		t.Helper()
		token, err := jwt.Signed(signer).Claims(claims).Serialize()
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
	allowed := map[string]struct{}{"native-client": {}}
	now := time.Now()
	for _, tc := range []struct {
		name   string
		claims map[string]any
		reason string
	}{
		{"expired", testGoogleClaims("native-client", "bound-nonce", now.Add(-time.Minute)), nativeTokenReasonExpired},
		{"wrong audience", testGoogleClaims("other-client", "bound-nonce", now.Add(time.Hour)), nativeTokenReasonAudience},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := newServerFixture(t).application.verifyGoogleIDToken(context.Background(), sign(tc.claims), strict, "bound-nonce", allowed)
			var clientErr *googleTokenClientError
			if !errors.As(err, &clientErr) {
				t.Fatalf("err=%v, want client-driven rejection", err)
			}
			if clientErr.reason != tc.reason {
				t.Fatalf("reason=%q, want %q under prod-shaped verifier", clientErr.reason, tc.reason)
			}
		})
	}
	if _, err := newServerFixture(t).application.verifyGoogleIDToken(context.Background(),
		sign(testGoogleClaims("native-client", "bound-nonce", now.Add(time.Hour))), strict, "bound-nonce", allowed); err != nil {
		t.Fatalf("valid token rejected under prod-shaped verifier: %v", err)
	}
}

func r51S02OutageVerifier(url string) *oidc.IDTokenVerifier {
	keyCtx := oidc.ClientContext(context.Background(), &http.Client{Timeout: 2 * time.Second, Transport: &keyProviderTransport{}})
	keySet := &observingKeySet{inner: oidc.NewRemoteKeySet(keyCtx, url)}
	return oidc.NewVerifier(googleIssuer, keySet, &oidc.Config{SkipClientIDCheck: true})
}

func TestR51S02VerifierOutageStillReports(t *testing.T) {
	for _, tc := range []struct {
		name      string
		serve     func(t *testing.T) string
		wantCause string
	}{
		{"transport refused", func(t *testing.T) string {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
			url := server.URL
			server.Close()
			return url
		}, "io_error"},
		{"status 500", func(t *testing.T) string {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusBadGateway)
				_, _ = w.Write(bytes.Repeat([]byte("r51-s02-provider-canary-"), 512))
			}))
			t.Cleanup(server.Close)
			return server.URL
		}, "internal"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			transport := initMockSentry(t)
			fixture := newServerFixture(t)
			logs := r49S08CaptureLogs(fixture.application)
			sign := r51S02EnableNative(t, &fixture)
			fixture.application.nativeVerifier = r51S02OutageVerifier(tc.serve(t))
			sealed := r51S02SealedChallenge(t, fixture, "bound-nonce")
			token := sign(testGoogleClaims("native-client", "bound-nonce", time.Now().Add(time.Hour)))
			before := r51S02NativeSessionCount(t, fixture)
			for range 2 {
				if response := r51S02Exchange(t, fixture.application, token, sealed, nil); response.Code != http.StatusUnauthorized {
					t.Fatalf("status=%d body=%s, want 401", response.Code, response.Body.String())
				}
			}
			sentry.Flush(2 * time.Second)
			events := transport.Events()
			if len(events) != 1 {
				t.Fatalf("events = %d, want exactly 1 bounded outage report", len(events))
			}
			if events[0].Tags["error.operation"] != "native Google ID token verification failed" {
				t.Fatalf("error.operation = %q", events[0].Tags["error.operation"])
			}
			if events[0].Tags["error.cause"] != tc.wantCause {
				t.Fatalf("error.cause = %q, want %q", events[0].Tags["error.cause"], tc.wantCause)
			}
			assertExchangePattern(t, events[0])
			assertEventHasNoPII(t, events[0], []string{sealed, "r51-s02-provider-canary-"})
			if !strings.Contains(logs.String(), "reason=provider_unavailable") {
				t.Fatalf("ERROR logs missing static provider reason: %s", logs.String())
			}
			for _, secret := range []string{sealed, "r51-s02-provider-canary-"} {
				if strings.Contains(logs.String(), secret) {
					t.Fatalf("logs contain secret %q", secret)
				}
			}
			if got := r51S02NativeSessionCount(t, fixture); got != before {
				t.Fatalf("sessions=%d, want unchanged %d", got, before)
			}
		})
	}
}

func TestR51S02CancellationDoesNotReport(t *testing.T) {
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	logs := r49S08CaptureLogs(fixture.application)
	sign := r51S02EnableNative(t, &fixture)
	hanging := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	t.Cleanup(hanging.Close)
	fixture.application.nativeVerifier = r51S02OutageVerifier(hanging.URL)
	sealed := r51S02SealedChallenge(t, fixture, "bound-nonce")
	token := sign(testGoogleClaims("native-client", "bound-nonce", time.Now().Add(time.Hour)))
	before := r51S02NativeSessionCount(t, fixture)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if response := r51S02Exchange(t, fixture.application, token, sealed, ctx); response.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s, want 401", response.Code, response.Body.String())
	}
	sentry.Flush(2 * time.Second)
	if events := transport.Events(); len(events) != 0 {
		t.Fatalf("events = %d, want 0 for cancellation", len(events))
	}
	if got := fixture.application.metrics.canceledCount(http.MethodPost, "POST /api/v1/auth/google/exchange"); got != 1 {
		t.Fatalf("canceled count=%d, want 1", got)
	}
	if !strings.Contains(logs.String(), "verification canceled") {
		t.Fatalf("missing INFO canceled log: %s", logs.String())
	}
	if strings.Contains(logs.String(), "level=ERROR") {
		t.Fatalf("cancellation logged at error level: %s", logs.String())
	}
	if got := r51S02NativeSessionCount(t, fixture); got != before {
		t.Fatalf("sessions=%d, want unchanged %d", got, before)
	}
}

func TestR51S02NativeRolloutFlagTransitions(t *testing.T) {
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	r49S08CaptureLogs(fixture.application)
	if fixture.application.cfg.NativeAuthEnabled() {
		t.Fatal("native auth enabled without client IDs")
	}
	challengeRequest := httptest.NewRequest(http.MethodPost, "https://pomodorough.egigoka.me/api/v1/auth/google/challenge", nil)
	challengeResponse := httptest.NewRecorder()
	fixture.application.handleNativeChallenge(challengeResponse, challengeRequest)
	if challengeResponse.Code != http.StatusServiceUnavailable {
		t.Fatalf("disabled challenge status=%d, want 503", challengeResponse.Code)
	}
	sealed := r51S02SealedChallenge(t, fixture, "bound-nonce")
	disabled := r51S02Exchange(t, fixture.application, "token", sealed, nil)
	if disabled.Code != http.StatusServiceUnavailable {
		t.Fatalf("disabled exchange status=%d, want 503", disabled.Code)
	}
	sign := r51S02EnableNative(t, &fixture)
	enabled := httptest.NewRecorder()
	fixture.application.handleNativeChallenge(enabled, httptest.NewRequest(http.MethodPost, "https://pomodorough.egigoka.me/api/v1/auth/google/challenge", nil))
	if enabled.Code != http.StatusOK {
		t.Fatalf("enabled challenge status=%d, want 200", enabled.Code)
	}
	fixture.application.cfg.GoogleNativeClientIDs = nil
	fixture.application.cfg.GoogleNativeClientIDSet = map[string]struct{}{}
	if fixture.application.cfg.NativeAuthEnabled() {
		t.Fatal("native auth still enabled after clearing client IDs")
	}
	revoked := r51S02Exchange(t, fixture.application, sign(testGoogleClaims("native-client", "bound-nonce", time.Now().Add(time.Hour))), sealed, nil)
	if revoked.Code != http.StatusServiceUnavailable {
		t.Fatalf("re-disabled exchange status=%d, want 503", revoked.Code)
	}
	sentry.Flush(2 * time.Second)
	if events := transport.Events(); len(events) != 0 {
		t.Fatalf("events = %d, want 0 across rollout transitions", len(events))
	}
}
