package authn

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"
)

const (
	UserIDLength       = 32
	WebSessionCookie   = "__Host-pomodorough_session"
	CSRFCookie         = "__Host-pomodorough_csrf"
	OAuthStateCookie   = "pomodorough_oauth_state"
	OAuthStateLifetime = 10 * time.Minute
	ChallengeLifetime  = 5 * time.Minute
)

var userIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{32}$`)

var (
	ErrInvalidToken = errors.New("invalid token")
	ErrExpired      = errors.New("transient token expired")
)

type OAuthState struct {
	State        string `json:"state"`
	Nonce        string `json:"nonce"`
	CodeVerifier string `json:"codeVerifier"`
	ReturnTo     string `json:"returnTo"`
	ExpiresAt    int64  `json:"expiresAt"`
}

type NativeChallenge struct {
	Nonce     string `json:"nonce"`
	ExpiresAt int64  `json:"expiresAt"`
}

type Codec struct {
	aead cipher.AEAD
}

func NewCodec(secret []byte) (*Codec, error) {
	keyMAC := hmac.New(sha256.New, secret)
	_, _ = keyMAC.Write([]byte("pomodorough transient tokens v1"))
	block, err := aes.NewCipher(keyMAC.Sum(nil))
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Codec{aead: aead}, nil
}

func UserID(secret []byte, issuer, subject string) string {
	mac := hmac.New(sha256.New, secret)
	_, _ = io.WriteString(mac, issuer)
	_, _ = mac.Write([]byte{0})
	_, _ = io.WriteString(mac, subject)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))[:UserIDLength]
}

func ValidateUserID(id string) bool {
	return userIDPattern.MatchString(id)
}

func NewOpaqueToken(userID string) (token string, hash [sha256.Size]byte, err error) {
	if !ValidateUserID(userID) {
		return "", hash, ErrInvalidToken
	}
	secret, err := RandomString(32)
	if err != nil {
		return "", hash, err
	}
	token = userID + "." + secret
	hash = sha256.Sum256([]byte(secret))
	return token, hash, nil
}

func ParseOpaqueToken(token string) (userID string, hash [sha256.Size]byte, err error) {
	if strings.Count(token, ".") != 1 {
		return "", hash, ErrInvalidToken
	}
	userID, secret, ok := strings.Cut(token, ".")
	if !ok || !ValidateUserID(userID) {
		return "", hash, ErrInvalidToken
	}
	raw, decodeErr := base64.RawURLEncoding.DecodeString(secret)
	if decodeErr != nil || len(raw) != 32 {
		return "", hash, ErrInvalidToken
	}
	canonical := base64.RawURLEncoding.EncodeToString(raw)
	if subtle.ConstantTimeCompare([]byte(secret), []byte(canonical)) != 1 {
		return "", hash, ErrInvalidToken
	}
	return userID, sha256.Sum256([]byte(secret)), nil
}

func RandomString(bytes int) (string, error) {
	buffer := make([]byte, bytes)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func HashString(value string) [sha256.Size]byte {
	return sha256.Sum256([]byte(value))
}

func EqualHash(left, right []byte) bool {
	return len(left) == sha256.Size && len(right) == sha256.Size && subtle.ConstantTimeCompare(left, right) == 1
}

func EqualString(left, right string) bool {
	return len(left) == len(right) && subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

func (c *Codec) Seal(purpose string, value any) (string, error) {
	plaintext, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := c.aead.Seal(nonce, nonce, plaintext, []byte(purpose))
	return base64.RawURLEncoding.EncodeToString(sealed), nil
}

func (c *Codec) Open(purpose, token string, value any) error {
	sealed, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(sealed) < c.aead.NonceSize()+c.aead.Overhead() {
		return ErrInvalidToken
	}
	nonce := sealed[:c.aead.NonceSize()]
	plaintext, err := c.aead.Open(nil, nonce, sealed[c.aead.NonceSize():], []byte(purpose))
	if err != nil {
		return ErrInvalidToken
	}
	if err := json.Unmarshal(plaintext, value); err != nil {
		return ErrInvalidToken
	}
	return nil
}

func (c *Codec) OpenOAuthState(token string, now time.Time) (OAuthState, error) {
	var state OAuthState
	if err := c.Open("oauth-state", token, &state); err != nil {
		return OAuthState{}, err
	}
	if state.ExpiresAt <= now.Unix() || state.ExpiresAt > now.Add(OAuthStateLifetime+time.Minute).Unix() {
		return OAuthState{}, ErrExpired
	}
	if state.State == "" || state.Nonce == "" || state.CodeVerifier == "" || state.ReturnTo == "" {
		return OAuthState{}, ErrInvalidToken
	}
	return state, nil
}

func (c *Codec) OpenNativeChallenge(token string, now time.Time) (NativeChallenge, error) {
	var challenge NativeChallenge
	if err := c.Open("native-challenge", token, &challenge); err != nil {
		return NativeChallenge{}, err
	}
	if challenge.ExpiresAt <= now.Unix() || challenge.ExpiresAt > now.Add(ChallengeLifetime+time.Minute).Unix() || challenge.Nonce == "" {
		return NativeChallenge{}, ErrExpired
	}
	return challenge, nil
}

func BearerToken(header string) (string, error) {
	parts := strings.Fields(header)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || strings.Contains(parts[1], ",") {
		return "", fmt.Errorf("%w: malformed authorization header", ErrInvalidToken)
	}
	return parts[1], nil
}
