package server

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
	jose "github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

// R52-S03: malformed HTTP-200 provider key documents are infrastructure
// failures with the bounded provider diagnostic and one sampled report.
// Invalid client signatures stay expected 401 rejections with zero
// events. Every path fails closed and leaves the challenge unconsumed.

func TestR52S03MalformedKeyDocumentIsProviderOutage(t *testing.T) {
	for _, tc := range []struct {
		name        string
		body        string
		contentType string
		canary      string
	}{
		{"not JSON", "not JSON r52-s03-canary-plain", "text/plain; charset=utf-8", "r52-s03-canary-plain"},
		{"keys not array", `{"keys":"invalid","note":"r52-s03-canary-shape"}`, "application/json", "r52-s03-canary-shape"},
		{"oversized document", strings.Repeat("r52-s03-canary-padding-", 1<<16), "text/plain; charset=utf-8", "r52-s03-canary-padding-"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r52S03AssertMalformedDocumentOutage(t, tc.body, tc.contentType, tc.canary)
		})
	}
}

func r52S03AssertMalformedDocumentOutage(t *testing.T, body, contentType, canary string) {
	t.Helper()
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	logs := r49S08CaptureLogs(fixture.application)
	sign := r51S02EnableNative(t, &fixture)
	healthy := fixture.application.nativeVerifier
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", contentType)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(provider.Close)
	fixture.application.nativeVerifier = r51S02OutageVerifier(provider.URL)
	sealed := r51S02SealedChallenge(t, fixture, "bound-nonce")
	token := sign(testGoogleClaims("native-client", "bound-nonce", time.Now().Add(time.Hour)))
	before := r51S02NativeSessionCount(t, fixture)
	response := r51S02Exchange(t, fixture.application, token, sealed, nil)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s, want 401", response.Code, response.Body.String())
	}
	if body := response.Body.String(); body != "{\"error\":\"invalid Google token\"}\n" {
		t.Fatalf("body=%q, want exact invalid-token JSON", body)
	}
	r51S02AssertRejectWire(t, response)
	r52S03AssertOutageReport(t, transport, logs, sealed, canary)
	if got := r51S02NativeSessionCount(t, fixture); got != before {
		t.Fatalf("sessions=%d, want unchanged %d", got, before)
	}
	fixture.application.nativeVerifier = healthy
	if retry := r51S02Exchange(t, fixture.application, token, sealed, nil); retry.Code != http.StatusOK {
		t.Fatalf("retry status=%d body=%s, want 200 unconsumed challenge", retry.Code, retry.Body.String())
	}
}

func r52S03AssertOutageReport(t *testing.T, transport *sentry.MockTransport, logs *bytes.Buffer, sealed, canary string) {
	t.Helper()
	sentry.Flush(2 * time.Second)
	events := transport.Events()
	if len(events) != 1 {
		t.Fatalf("events=%d, want exactly 1 bounded outage report", len(events))
	}
	if got := events[0].Tags["error.operation"]; got != "native Google ID token verification failed" {
		t.Fatalf("error.operation=%q", got)
	}
	if got := events[0].Tags["error.cause"]; got != "internal" {
		t.Fatalf("error.cause=%q, want internal", got)
	}
	assertExchangePattern(t, events[0])
	assertEventHasNoPII(t, events[0], []string{sealed, canary})
	if !strings.Contains(logs.String(), "reason=provider_unavailable") {
		t.Fatalf("ERROR logs missing static provider reason: %s", logs.String())
	}
	for _, secret := range []string{sealed, canary} {
		if strings.Contains(logs.String(), secret) {
			t.Fatalf("logs contain secret %q", secret)
		}
	}
}

// TestR52S03UnknownKeyStaysClientRejection pins the neighboring control:
// a decodable key document that simply lacks the signing key remains an
// expected signature rejection with zero events, and the challenge stays
// unconsumed for a token the documented keys do verify.
func TestR52S03UnknownKeyStaysClientRejection(t *testing.T) {
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	logs := r49S08CaptureLogs(fixture.application)
	sign := r51S02EnableNative(t, &fixture)
	providerURL, signWithProviderKey := r52S03UnrelatedKeyProvider(t)
	fixture.application.nativeVerifier = r51S02OutageVerifier(providerURL)
	sealed := r51S02SealedChallenge(t, fixture, "bound-nonce")
	claims := testGoogleClaims("native-client", "bound-nonce", time.Now().Add(time.Hour))
	before := r51S02NativeSessionCount(t, fixture)
	if response := r51S02Exchange(t, fixture.application, sign(claims), sealed, nil); response.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s, want 401", response.Code, response.Body.String())
	}
	sentry.Flush(2 * time.Second)
	if events := transport.Events(); len(events) != 0 {
		t.Fatalf("events=%d, want 0 for unknown-key rejection", len(events))
	}
	if !strings.Contains(logs.String(), "reason=invalid_signature") {
		t.Fatalf("WARN logs missing static signature reason: %s", logs.String())
	}
	if strings.Contains(logs.String(), sealed) {
		t.Fatal("WARN logs contain sealed challenge")
	}
	if got := r51S02NativeSessionCount(t, fixture); got != before {
		t.Fatalf("sessions=%d, want unchanged %d", got, before)
	}
	if retry := r51S02Exchange(t, fixture.application, signWithProviderKey(claims), sealed, nil); retry.Code != http.StatusOK {
		t.Fatalf("retry status=%d body=%s, want 200 unconsumed challenge", retry.Code, retry.Body.String())
	}
}

// r52S03UnrelatedKeyProvider serves a decodable key document whose keys
// never signed the fixture token, isolating unknown-key classification
// from malformed-document handling.
func r52S03UnrelatedKeyProvider(t *testing.T) (string, func(map[string]any) string) {
	t.Helper()
	otherKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	otherSigner, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: otherKey}, (&jose.SignerOptions{}).WithType("JWT"))
	if err != nil {
		t.Fatal(err)
	}
	document, err := json.Marshal(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{
		{Key: &otherKey.PublicKey, KeyID: "unrelated", Algorithm: string(jose.RS256), Use: "sig"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(document)
	}))
	t.Cleanup(provider.Close)
	return provider.URL, func(claims map[string]any) string {
		t.Helper()
		token, err := jwt.Signed(otherSigner).Claims(claims).Serialize()
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
}
