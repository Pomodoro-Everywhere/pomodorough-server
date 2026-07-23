package authn

import (
	"bytes"
	"encoding/base64"
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

func TestOpaqueTokenRejectsAlternateNonZeroPadBits(t *testing.T) {
	userID := UserID([]byte(strings.Repeat("s", 32)), googleIssuerForTest, "subject-123")
	token, _, err := NewOpaqueToken(userID)
	if err != nil {
		t.Fatal(err)
	}
	_, secret, _ := strings.Cut(token, ".")
	nonCanonical := alternateNonZeroPadBits(t, secret)
	if _, _, err := ParseOpaqueToken(userID + "." + nonCanonical); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("alternate-pad-bit opaque token error = %v, want ErrInvalidToken", err)
	}
}

func TestSealedTokenRejectsAlternateNonZeroPadBits(t *testing.T) {
	codec := newTestCodec(t)
	var sealed string
	for length := 1; ; length++ {
		var err error
		sealed, err = codec.Seal("pad-bit-test", strings.Repeat("x", length))
		if err != nil {
			t.Fatal(err)
		}
		raw, err := base64.RawURLEncoding.DecodeString(sealed)
		if err != nil {
			t.Fatal(err)
		}
		if len(raw)%3 != 0 {
			break
		}
	}
	nonCanonical := alternateNonZeroPadBits(t, sealed)
	var output string
	if err := codec.Open("pad-bit-test", nonCanonical, &output); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("alternate-pad-bit sealed token error = %v, want ErrInvalidToken", err)
	}
}

func alternateNonZeroPadBits(t *testing.T, encoded string) string {
	t.Helper()
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	mask := 0
	switch len(raw) % 3 {
	case 1:
		mask = 0x0f
	case 2:
		mask = 0x03
	default:
		t.Fatal("encoding has no unused pad bits")
	}
	index := strings.IndexByte(alphabet, encoded[len(encoded)-1])
	if index < 0 || index&mask != 0 {
		t.Fatalf("canonical final base64url digit index = %d", index)
	}
	result := encoded[:len(encoded)-1] + string(alphabet[index|1])
	decoded, err := base64.RawURLEncoding.DecodeString(result)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(decoded, raw) || result == encoded {
		t.Fatalf("alternate pad bits changed decoded bytes: canonical=%q alternate=%q", encoded, result)
	}
	return result
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
