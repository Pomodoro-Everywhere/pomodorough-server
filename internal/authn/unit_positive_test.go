package authn

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

const googleIssuerForTest = "https://accounts.google.com"

func TestOpaqueTokenRoundTrip(t *testing.T) {
	userID := UserID([]byte(strings.Repeat("s", 32)), googleIssuerForTest, "subject-123")
	token, expectedHash, err := NewOpaqueToken(userID)
	if err != nil {
		t.Fatal(err)
	}
	parsedID, parsedHash, err := ParseOpaqueToken(token)
	if err != nil {
		t.Fatal(err)
	}
	if parsedID != userID || parsedHash != expectedHash {
		t.Fatalf("parsed token mismatch: id=%q", parsedID)
	}
}

func TestOAuthStateRoundTrip(t *testing.T) {
	codec := newTestCodec(t)
	now := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	state := OAuthState{
		State: "state", Nonce: "nonce", CodeVerifier: "verifier", ReturnTo: "/timer?view=today", ExpiresAt: now.Add(time.Minute).Unix(),
	}
	sealed, err := codec.Seal("oauth-state", state)
	if err != nil {
		t.Fatal(err)
	}
	opened, err := codec.OpenOAuthState(sealed, now)
	if err != nil {
		t.Fatal(err)
	}
	if opened != state {
		t.Fatalf("opened state = %#v, want %#v", opened, state)
	}
}

func TestNativeChallengeRoundTrip(t *testing.T) {
	codec := newTestCodec(t)
	now := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	want := NativeChallenge{Nonce: "nonce", ExpiresAt: now.Add(time.Minute).Unix()}
	sealed, err := codec.Seal("native-challenge", want)
	if err != nil {
		t.Fatal(err)
	}
	got, err := codec.OpenNativeChallenge(sealed, now)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("opened challenge = %#v, want %#v", got, want)
	}
}

func TestBearerTokenAcceptsCaseAndWhitespace(t *testing.T) {
	for _, header := range []string{"Bearer token", "bearer token", "BEARER\ttoken", "  Bearer   token  "} {
		t.Run(header, func(t *testing.T) {
			got, err := BearerToken(header)
			if err != nil {
				t.Fatal(err)
			}
			if got != "token" {
				t.Fatalf("BearerToken(%q) = %q, want token", header, got)
			}
		})
	}
}

func TestIdentityAndConstantTimeHelpers(t *testing.T) {
	secret := []byte(strings.Repeat("s", 32))
	first := UserID(secret, "issuer", "subject")
	if first != UserID(secret, "issuer", "subject") || !ValidateUserID(first) {
		t.Fatalf("UserID is not deterministic and valid: %q", first)
	}
	if first == UserID(secret, "issuer-2", "subject") || UserID(secret, "ab", "c") == UserID(secret, "a", "bc") {
		t.Fatal("UserID inputs are not domain separated")
	}

	hash := HashString("value")
	if !EqualHash(hash[:], hash[:]) || !EqualString("value", "value") {
		t.Fatal("equality helper rejected equal values")
	}

	random, err := RandomString(32)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(random)
	if err != nil || len(raw) != 32 {
		t.Fatalf("RandomString returned invalid encoding: value=%q err=%v bytes=%d", random, err, len(raw))
	}
}

func newTestCodec(t *testing.T) *Codec {
	t.Helper()
	codec, err := NewCodec([]byte(strings.Repeat("k", 32)))
	if err != nil {
		t.Fatal(err)
	}
	return codec
}
