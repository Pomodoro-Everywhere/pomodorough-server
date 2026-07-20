package authn

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestOpaqueTokenRoundTripAndTraversalRejection(t *testing.T) {
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

	_, secret, _ := strings.Cut(token, ".")
	invalid := []string{
		"../users/admin." + secret,
		userID + "/../../admin." + secret,
		userID + "." + secret + ".extra",
		userID + ".not-base64!",
		strings.Repeat("A", UserIDLength-1) + "." + secret,
	}
	for _, candidate := range invalid {
		if _, _, err := ParseOpaqueToken(candidate); !errors.Is(err, ErrInvalidToken) {
			t.Errorf("ParseOpaqueToken(%q) error = %v, want ErrInvalidToken", candidate, err)
		}
	}
}

func TestOAuthStateCodecRoundTripAndExpiry(t *testing.T) {
	codec, err := NewCodec([]byte(strings.Repeat("k", 32)))
	if err != nil {
		t.Fatal(err)
	}
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
	if _, err := codec.OpenOAuthState(sealed, now.Add(2*time.Minute)); !errors.Is(err, ErrExpired) {
		t.Fatalf("expired state error = %v, want ErrExpired", err)
	}

	tampered := sealed[:len(sealed)-1] + "A"
	if tampered == sealed {
		tampered = sealed[:len(sealed)-1] + "B"
	}
	if _, err := codec.OpenOAuthState(tampered, now); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("tampered state error = %v, want ErrInvalidToken", err)
	}
}

const googleIssuerForTest = "https://accounts.google.com"
