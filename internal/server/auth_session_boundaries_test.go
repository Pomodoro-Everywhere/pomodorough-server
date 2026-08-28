package server

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	jose "github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"golang.org/x/oauth2"

	"pomodorough/internal/authn"
	"pomodorough/internal/store"
)

func TestGoogleStartBindsReturnPathNonceAndPKCEToStateCookie(t *testing.T) {
	fixture := newServerFixture(t)
	fixture.application.cfg.GoogleWebClientID = "web-client"
	fixture.application.cfg.GoogleWebClientSecret = "web-secret"
	fixture.application.oauthConfig.ClientID = "web-client"
	fixture.application.oauthConfig.Endpoint.AuthURL = "https://accounts.example/authorize"

	request := httptest.NewRequest(http.MethodGet, "/auth/google/start?return=%2Ftimer%3Fview%3Dtoday", nil)
	response := httptest.NewRecorder()
	fixture.application.handleGoogleStart(response, request)

	if response.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302; body=%s", response.Code, response.Body.String())
	}
	location, err := url.Parse(response.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	query := location.Query()
	if query.Get("state") == "" || query.Get("nonce") == "" || query.Get("code_challenge") == "" || query.Get("code_challenge_method") != "S256" {
		t.Fatalf("OAuth redirect omitted security bindings: %s", location.String())
	}
	cookie := onlyResponseCookie(t, response)
	state, err := fixture.application.codec.OpenOAuthState(cookie.Value, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if state.State != query.Get("state") || state.Nonce != query.Get("nonce") || state.ReturnTo != "/timer?view=today" || state.CodeVerifier == "" {
		t.Fatalf("sealed OAuth state does not match redirect: %#v", state)
	}
	if cookie.Path != "/auth/google" || !cookie.Secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("OAuth state cookie weakened: %#v", cookie)
	}
}

func TestGoogleCallbackCreatesWebSessionOnlyAfterBoundTokenVerification(t *testing.T) {
	fixture := newServerFixture(t)
	fixture.application.cfg.GoogleWebClientID = "web-client"
	fixture.application.cfg.GoogleWebClientSecret = "web-secret"
	verifier, sign := testGoogleVerifier(t)
	fixture.application.webVerifier = verifier

	now := time.Now()
	state := authn.OAuthState{State: "bound-state", Nonce: "bound-nonce", CodeVerifier: "pkce-verifier", ReturnTo: "/app", ExpiresAt: now.Add(time.Minute).Unix()}
	sealed, err := fixture.application.codec.Seal("oauth-state", state)
	if err != nil {
		t.Fatal(err)
	}
	idToken := sign(testGoogleClaims("web-client", state.Nonce, now.Add(time.Hour)))
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		if r.Form.Get("code") != "authorization-code" || r.Form.Get("code_verifier") != state.CodeVerifier {
			t.Errorf("token exchange form = %v", r.Form)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "provider-access", "token_type": "Bearer", "id_token": idToken})
	}))
	defer tokenServer.Close()
	fixture.application.oauthConfig.ClientID = "web-client"
	fixture.application.oauthConfig.ClientSecret = "web-secret"
	fixture.application.oauthConfig.Endpoint = oauth2.Endpoint{TokenURL: tokenServer.URL, AuthStyle: oauth2.AuthStyleInParams}

	request := httptest.NewRequest(http.MethodGet, "/auth/google/callback?code=authorization-code&state=bound-state", nil)
	request.AddCookie(&http.Cookie{Name: authn.OAuthStateCookie, Value: sealed})
	response := httptest.NewRecorder()
	fixture.application.handleGoogleCallback(response, request)

	if response.Code != http.StatusSeeOther || response.Header().Get("Location") != "/app" {
		t.Fatalf("callback status=%d location=%q body=%s", response.Code, response.Header().Get("Location"), response.Body.String())
	}
	cookies := response.Result().Cookies()
	sessionCookie := cookieByName(t, cookies, authn.WebSessionCookie)
	csrfCookie := cookieByName(t, cookies, authn.CSRFCookie)
	userID, sessionHash, err := authn.ParseOpaqueToken(sessionCookie.Value)
	if err != nil {
		t.Fatal(err)
	}
	db, err := fixture.userStore.OpenExistingUser(context.Background(), userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	info, err := store.Authenticate(context.Background(), db, sessionHash, "web", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	csrfHash := authn.HashString(csrfCookie.Value)
	if info.Profile.Subject != "verified-subject" || !authn.EqualHash(info.CSRFHash, csrfHash[:]) {
		t.Fatalf("persisted web identity/session = %#v", info)
	}
}

func TestNativeExchangeRejectsMalformedChallengeAndIdentityBeforePersistence(t *testing.T) {
	fixture := newServerFixture(t)
	fixture.application.cfg.GoogleNativeClientIDs = []string{"native-client"}
	fixture.application.cfg.GoogleNativeClientIDSet = map[string]struct{}{"native-client": {}}
	verifier, _ := testGoogleVerifier(t)
	fixture.application.nativeVerifier = verifier

	tests := []struct {
		name       string
		payload    map[string]string
		wantStatus int
	}{
		{
			name: "malformed request",
			payload: map[string]string{
				"idToken": "token", "challenge": "challenge", "deviceId": "bad device", "platform": "ios",
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "invalid challenge",
			payload: map[string]string{
				"idToken": "token", "challenge": "not-sealed", "deviceId": "native-device", "platform": "ios",
			},
			wantStatus: http.StatusUnauthorized,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request, response := newJSONRequest(t, http.MethodPost, "/api/v1/auth/google/exchange", test.payload)
			fixture.application.handleNativeExchange(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("status=%d body=%s, want %d", response.Code, response.Body.String(), test.wantStatus)
			}
		})
	}

	sealed, err := fixture.application.codec.Seal("native-challenge", authn.NativeChallenge{
		Nonce: "bound-nonce", ExpiresAt: time.Now().Add(time.Minute).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	request, response := newJSONRequest(t, http.MethodPost, "/api/v1/auth/google/exchange", map[string]string{
		"idToken": "not-a-jwt", "challenge": sealed, "deviceId": "native-device", "platform": "ios",
	})
	fixture.application.handleNativeExchange(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("invalid identity status=%d body=%s, want 401", response.Code, response.Body.String())
	}
}

func TestNativeChallengeExchangeCreatesDeviceBoundSession(t *testing.T) {
	fixture := newServerFixture(t)
	fixture.application.cfg.GoogleNativeClientIDs = []string{"native-client"}
	fixture.application.cfg.GoogleNativeClientIDSet = map[string]struct{}{"native-client": {}}
	verifier, sign := testGoogleVerifier(t)
	fixture.application.nativeVerifier = verifier

	challengeResponse := httptest.NewRecorder()
	fixture.application.handleNativeChallenge(challengeResponse, httptest.NewRequest(http.MethodPost, "/api/v1/auth/google/challenge", nil))
	if challengeResponse.Code != http.StatusOK {
		t.Fatalf("challenge status=%d body=%s", challengeResponse.Code, challengeResponse.Body.String())
	}
	var challenge struct {
		Sealed string `json:"challenge"`
		Nonce  string `json:"nonce"`
	}
	if err := json.NewDecoder(challengeResponse.Body).Decode(&challenge); err != nil {
		t.Fatal(err)
	}
	opened, err := fixture.application.codec.OpenNativeChallenge(challenge.Sealed, time.Now())
	if err != nil || opened.Nonce != challenge.Nonce {
		t.Fatalf("opened challenge = %#v, %v", opened, err)
	}

	idToken := sign(testGoogleClaims("native-client", challenge.Nonce, time.Now().Add(time.Hour)))
	request, response := newJSONRequest(t, http.MethodPost, "/api/v1/auth/google/exchange", map[string]string{
		"idToken": idToken, "challenge": challenge.Sealed, "deviceId": "native-device", "platform": "ios",
	})
	fixture.application.handleNativeExchange(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("exchange status=%d body=%s", response.Code, response.Body.String())
	}
	var tokens struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
	}
	if err := json.NewDecoder(response.Body).Decode(&tokens); err != nil {
		t.Fatal(err)
	}
	userID, accessHash, err := authn.ParseOpaqueToken(tokens.AccessToken)
	if err != nil {
		t.Fatal(err)
	}
	refreshUserID, refreshHash, err := authn.ParseOpaqueToken(tokens.RefreshToken)
	if err != nil || refreshUserID != userID {
		t.Fatalf("refresh token user=%q error=%v", refreshUserID, err)
	}
	db, err := fixture.userStore.OpenExistingUser(context.Background(), userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	access, err := store.Authenticate(context.Background(), db, accessHash, "access", time.Now())
	if err != nil || access.DeviceID != "native-device" || access.Kind != "native" {
		t.Fatalf("access authentication = %#v, %v", access, err)
	}
	if _, err := store.Authenticate(context.Background(), db, refreshHash, "refresh", time.Now()); err != nil {
		t.Fatalf("refresh authentication: %v", err)
	}
}

func TestGoogleIDTokenVerificationFailsClosedAtClaimBoundaries(t *testing.T) {
	server := &Server{}
	verifier, sign := testGoogleVerifier(t)
	now := time.Now()
	allowed := map[string]struct{}{"client": {}}
	valid := testGoogleClaims("client", "expected-nonce", now.Add(time.Hour))

	identity, err := server.verifyGoogleIDToken(context.Background(), sign(valid), verifier, "expected-nonce", allowed)
	if err != nil || identity.Issuer != googleIssuer || identity.Subject != "verified-subject" || identity.Email != "verified@example.com" {
		t.Fatalf("valid identity = %#v, %v", identity, err)
	}

	tests := map[string]func(map[string]any){
		"unexpected issuer":           func(claims map[string]any) { claims["iss"] = "https://issuer.example" },
		"expired":                     func(claims map[string]any) { claims["exp"] = now.Add(-time.Minute).Unix() },
		"missing audience":            func(claims map[string]any) { delete(claims, "aud") },
		"unexpected audience":         func(claims map[string]any) { claims["aud"] = "other-client" },
		"unexpected authorized party": func(claims map[string]any) { claims["azp"] = "other-client" },
		"missing authorized party":    func(claims map[string]any) { claims["aud"] = []string{"client", "other-client"} },
		"nonce mismatch":              func(claims map[string]any) { claims["nonce"] = "other-nonce" },
		"unverified email":            func(claims map[string]any) { claims["email_verified"] = false },
		"missing subject":             func(claims map[string]any) { claims["sub"] = "" },
		"missing email":               func(claims map[string]any) { claims["email"] = "" },
		"malformed custom claims":     func(claims map[string]any) { claims["email_verified"] = "yes" },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			claims := cloneClaims(valid)
			mutate(claims)
			if _, err := server.verifyGoogleIDToken(context.Background(), sign(claims), verifier, "expected-nonce", allowed); err == nil {
				t.Fatal("verification accepted invalid Google identity")
			}
		})
	}
}

func testGoogleVerifier(t *testing.T) (*oidc.IDTokenVerifier, func(map[string]any) string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, (&jose.SignerOptions{}).WithType("JWT"))
	if err != nil {
		t.Fatal(err)
	}
	verifier := oidc.NewVerifier(googleIssuer, &oidc.StaticKeySet{PublicKeys: []crypto.PublicKey{&key.PublicKey}}, &oidc.Config{
		SkipClientIDCheck: true, SkipIssuerCheck: true, SkipExpiryCheck: true,
	})
	return verifier, func(claims map[string]any) string {
		t.Helper()
		token, err := jwt.Signed(signer).Claims(claims).Serialize()
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
}

func testGoogleClaims(audience, nonce string, expiry time.Time) map[string]any {
	return map[string]any{
		"iss": googleIssuer, "sub": "verified-subject", "aud": audience, "exp": expiry.Unix(),
		"nonce": nonce, "email": "verified@example.com", "email_verified": true,
		"name": "Verified User", "picture": "https://example.com/avatar.png",
	}
}

func cloneClaims(source map[string]any) map[string]any {
	clone := make(map[string]any, len(source))
	for key, value := range source {
		clone[key] = value
	}
	return clone
}

func cookieByName(t *testing.T, cookies []*http.Cookie, name string) *http.Cookie {
	t.Helper()
	for _, cookie := range cookies {
		if cookie.Name == name {
			return cookie
		}
	}
	t.Fatalf("missing cookie %q in %#v", name, cookies)
	return nil
}
