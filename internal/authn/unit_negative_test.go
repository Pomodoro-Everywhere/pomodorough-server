package authn

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestOpaqueTokenRejectsMalformedAndNonCanonicalValues(t *testing.T) {
	userID := UserID([]byte(strings.Repeat("s", 32)), googleIssuerForTest, "subject-123")
	token, _, err := NewOpaqueToken(userID)
	if err != nil {
		t.Fatal(err)
	}
	_, secret, _ := strings.Cut(token, ".")
	invalid := []string{
		"../users/admin." + secret,
		userID + "/../../admin." + secret,
		userID + "." + secret + ".extra",
		userID + ".not-base64!",
		userID + "." + secret + "=",
		strings.Repeat("A", UserIDLength-1) + "." + secret,
	}
	for _, candidate := range invalid {
		if _, _, err := ParseOpaqueToken(candidate); !errors.Is(err, ErrInvalidToken) {
			t.Errorf("ParseOpaqueToken(%q) error = %v, want ErrInvalidToken", candidate, err)
		}
	}
	if _, _, err := NewOpaqueToken("invalid"); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("NewOpaqueToken(invalid) error = %v, want ErrInvalidToken", err)
	}
}

func TestOAuthStateRejectsExpiredIncompleteFutureAndTamperedTokens(t *testing.T) {
	codec := newTestCodec(t)
	now := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	valid := OAuthState{State: "state", Nonce: "nonce", CodeVerifier: "verifier", ReturnTo: "/", ExpiresAt: now.Add(time.Minute).Unix()}

	sealed, err := codec.Seal("oauth-state", valid)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := codec.OpenOAuthState(sealed, now.Add(2*time.Minute)); !errors.Is(err, ErrExpired) {
		t.Fatalf("expired state error = %v, want ErrExpired", err)
	}

	farFuture := valid
	farFuture.ExpiresAt = now.Add(OAuthStateLifetime + 2*time.Minute).Unix()
	assertOAuthStateError(t, codec, farFuture, now, ErrExpired)
	for name, mutate := range map[string]func(*OAuthState){
		"state":       func(value *OAuthState) { value.State = "" },
		"nonce":       func(value *OAuthState) { value.Nonce = "" },
		"verifier":    func(value *OAuthState) { value.CodeVerifier = "" },
		"return path": func(value *OAuthState) { value.ReturnTo = "" },
	} {
		t.Run(name, func(t *testing.T) {
			value := valid
			mutate(&value)
			assertOAuthStateError(t, codec, value, now, ErrInvalidToken)
		})
	}

	tampered := sealed[:len(sealed)-1] + "A"
	if tampered == sealed {
		tampered = sealed[:len(sealed)-1] + "B"
	}
	if _, err := codec.OpenOAuthState(tampered, now); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("tampered state error = %v, want ErrInvalidToken", err)
	}

	wrongPurpose, err := codec.Seal("native-challenge", valid)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := codec.OpenOAuthState(wrongPurpose, now); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("wrong-purpose state error = %v, want ErrInvalidToken", err)
	}
}

func TestNativeChallengeRejectsInvalidLifetimeAndNonce(t *testing.T) {
	codec := newTestCodec(t)
	now := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	for name, value := range map[string]NativeChallenge{
		"expired":     {Nonce: "nonce", ExpiresAt: now.Unix()},
		"far future":  {Nonce: "nonce", ExpiresAt: now.Add(ChallengeLifetime + 2*time.Minute).Unix()},
		"empty nonce": {ExpiresAt: now.Add(time.Minute).Unix()},
	} {
		t.Run(name, func(t *testing.T) {
			sealed, err := codec.Seal("native-challenge", value)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := codec.OpenNativeChallenge(sealed, now); !errors.Is(err, ErrExpired) {
				t.Fatalf("OpenNativeChallenge() error = %v, want ErrExpired", err)
			}
		})
	}
}

func TestBearerTokenRejectsMalformedHeaders(t *testing.T) {
	for _, header := range []string{"", "Bearer", "Basic token", "Bearer one two", "Bearer token,other"} {
		if _, err := BearerToken(header); !errors.Is(err, ErrInvalidToken) {
			t.Errorf("BearerToken(%q) error = %v, want ErrInvalidToken", header, err)
		}
	}
}

func TestEqualityHelpersRejectDifferentAndInvalidValues(t *testing.T) {
	left := HashString("left")
	right := HashString("right")
	if EqualHash(left[:], right[:]) || EqualHash(left[:31], left[:31]) || EqualString("left", "right") || EqualString("left", "longer") {
		t.Fatal("equality helper accepted unequal or invalid values")
	}
}

func assertOAuthStateError(t *testing.T, codec *Codec, state OAuthState, now time.Time, want error) {
	t.Helper()
	sealed, err := codec.Seal("oauth-state", state)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := codec.OpenOAuthState(sealed, now); !errors.Is(err, want) {
		t.Fatalf("OpenOAuthState() error = %v, want %v", err, want)
	}
}
