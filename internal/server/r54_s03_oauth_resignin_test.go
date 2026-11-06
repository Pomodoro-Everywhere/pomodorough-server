package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"golang.org/x/oauth2"

	"pomodorough/internal/authn"
	"pomodorough/internal/store"
)

// R54-S03: the Google callback overwrites the browser's session cookie.
// After that, the browser can never sign the replaced session out, so a
// sign-out whose revocation was deferred (R54-S01) would leave it valid.

const (
	r54S03PublicURL = "https://pomodorough.egigoka.me"
	r54S03Nonce     = "s03-nonce"
	r54S03State     = "s03-state"
)

type r54S03Harness struct {
	fixture serverFixture
	// nonce is the nonce the token endpoint signs into the ID token.
	nonce *string
}

// newR54S03Harness serves real callbacks against a local token endpoint.
// The authorization code names the Google subject the exchange returns.
func newR54S03Harness(t *testing.T) r54S03Harness {
	t.Helper()
	fixture := newServerFixture(t)
	application := fixture.application
	application.cfg.GoogleWebClientID = "web-client"
	application.cfg.GoogleWebClientSecret = "web-secret"
	verifier, sign := testGoogleVerifier(t)
	application.webVerifier = verifier
	nonce := r54S03Nonce
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		claims := testGoogleClaims("web-client", nonce, time.Now().Add(time.Hour))
		claims["sub"] = r.Form.Get("code")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "provider-access", "token_type": "Bearer", "id_token": sign(claims)})
	}))
	t.Cleanup(tokenServer.Close)
	application.oauthConfig.ClientID = "web-client"
	application.oauthConfig.ClientSecret = "web-secret"
	application.oauthConfig.Endpoint = oauth2.Endpoint{TokenURL: tokenServer.URL, AuthStyle: oauth2.AuthStyleInParams}
	return r54S03Harness{fixture: fixture, nonce: &nonce}
}

func (h r54S03Harness) callback(t *testing.T, subject, nonce string, prepare ...func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	state := authn.OAuthState{
		State: r54S03State, Nonce: nonce, CodeVerifier: "s03-verifier", ReturnTo: "/app", ExpiresAt: time.Now().Add(time.Minute).Unix(),
	}
	sealed, err := h.fixture.application.codec.Seal("oauth-state", state)
	if err != nil {
		t.Fatal(err)
	}
	query := url.Values{"code": {subject}, "state": {r54S03State}}
	request := httptest.NewRequest(http.MethodGet, r54S03PublicURL+"/auth/google/callback?"+query.Encode(), nil)
	request.AddCookie(&http.Cookie{Name: authn.OAuthStateCookie, Value: sealed})
	return h.serve(request, prepare...)
}

func (h r54S03Harness) serve(request *http.Request, prepare ...func(*http.Request)) *httptest.ResponseRecorder {
	for _, apply := range prepare {
		apply(request)
	}
	response := httptest.NewRecorder()
	h.fixture.handler.ServeHTTP(response, request)
	return response
}

func (h r54S03Harness) meStatus(credentials ...func(*http.Request)) int {
	return h.serve(httptest.NewRequest(http.MethodGet, r54S03PublicURL+"/api/v1/me", nil), credentials...).Code
}

func (h r54S03Harness) logoutStatus(sessionToken, csrfToken string) int {
	request := httptest.NewRequest(http.MethodPost, r54S03PublicURL+"/api/v1/auth/logout", nil)
	request.Header.Set("Origin", r54S03PublicURL)
	request.Header.Set("X-CSRF-Token", csrfToken)
	return h.serve(request, withS03SessionCookie(sessionToken), withS03CSRFCookie(csrfToken)).Code
}

func (h r54S03Harness) subscribe(t *testing.T, credential func(*http.Request)) <-chan int64 {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, r54S03PublicURL+"/api/v1/events", nil)
	credential(request)
	identity, err := h.fixture.application.authenticate(request)
	if err != nil {
		t.Fatal(err)
	}
	revisions, unsubscribe := h.fixture.application.hub.subscribe(identity.UserID, identity.Generation, identity.SessionID, identity.DeviceID)
	t.Cleanup(unsubscribe)
	return revisions
}

func withS03SessionCookie(token string) func(*http.Request) {
	return func(request *http.Request) {
		request.AddCookie(&http.Cookie{Name: authn.WebSessionCookie, Value: token})
	}
}

func withS03CSRFCookie(token string) func(*http.Request) {
	return func(request *http.Request) {
		request.AddCookie(&http.Cookie{Name: authn.CSRFCookie, Value: token})
	}
}

func withS03Bearer(token string) func(*http.Request) {
	return func(request *http.Request) {
		request.Header.Set("Authorization", "Bearer "+token)
	}
}

func assertS03Status(t *testing.T, label string, got, want int) {
	t.Helper()
	if got != want {
		t.Fatalf("%s: status = %d, want %d", label, got, want)
	}
}

// The PWA treats a landing on its return path as proof that the callback
// revoked the replaced session, so a failed callback must never redirect.
func assertS03NoRedirect(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	if location := response.Header().Get("Location"); location != "" {
		t.Fatalf("failed callback redirected to %q", location)
	}
}

func assertS03NoSessionCookies(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	for _, cookie := range response.Result().Cookies() {
		if cookie.Name == authn.WebSessionCookie || cookie.Name == authn.CSRFCookie {
			t.Fatalf("failed callback set %s", cookie.Name)
		}
	}
}

func TestR54S03ReSignInRevokesReplacedWebSession(t *testing.T) {
	for _, testCase := range []struct{ name, subject string }{
		{name: "same account", subject: "test-subject"},
		{name: "other account", subject: "verified-subject"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			h := newR54S03Harness(t)
			replaced := h.fixture.webToken
			replacedStream := h.subscribe(t, withS03SessionCookie(replaced))
			nativeStream := h.subscribe(t, withS03Bearer(h.fixture.accessToken))

			// The browser still holds the cookie of a session whose sign-out was deferred.
			response := h.callback(t, testCase.subject, r54S03Nonce, withS03SessionCookie(replaced), withS03CSRFCookie(h.fixture.csrfToken))
			if response.Code != http.StatusSeeOther || response.Header().Get("Location") != "/app" {
				t.Fatalf("callback status=%d location=%q body=%s", response.Code, response.Header().Get("Location"), response.Body.String())
			}
			cookies := response.Result().Cookies()
			session := cookieByName(t, cookies, authn.WebSessionCookie).Value
			csrf := cookieByName(t, cookies, authn.CSRFCookie).Value
			if session == replaced {
				t.Fatal("callback kept the replaced session cookie")
			}
			assertS03Status(t, "replaced session", h.meStatus(withS03SessionCookie(replaced)), http.StatusUnauthorized)
			// Send the CSRF cookie as a browser would: /me rotates the token without it.
			assertS03Status(t, "new session", h.meStatus(withS03SessionCookie(session), withS03CSRFCookie(csrf)), http.StatusOK)
			assertS03Status(t, "native session", h.meStatus(withS03Bearer(h.fixture.accessToken)), http.StatusOK)
			assertRevisionStreamClosed(t, replacedStream)
			assertRevisionStreamOpen(t, nativeStream)

			// Recovery that has not seen the sign-in landing still revokes the
			// cookie it holds, which is now the new one.
			assertS03Status(t, "deferred logout", h.logoutStatus(session, csrf), http.StatusNoContent)
			assertS03Status(t, "new session after logout", h.meStatus(withS03SessionCookie(session)), http.StatusUnauthorized)
			assertS03Status(t, "replaced session after logout", h.meStatus(withS03SessionCookie(replaced)), http.StatusUnauthorized)
		})
	}
}

func TestR54S03CallbackWithoutLiveWebSessionStillSignsIn(t *testing.T) {
	for _, testCase := range []struct {
		name       string
		credential func(*testing.T, r54S03Harness) func(*http.Request)
	}{
		{name: "no session cookie", credential: func(*testing.T, r54S03Harness) func(*http.Request) {
			return func(*http.Request) {}
		}},
		{name: "malformed session cookie", credential: func(*testing.T, r54S03Harness) func(*http.Request) {
			return withS03SessionCookie("not-a-session-token")
		}},
		{name: "unknown account cookie", credential: func(t *testing.T, h r54S03Harness) func(*http.Request) {
			token, _, err := authn.NewOpaqueToken(authn.UserID(h.fixture.application.cfg.AppSecret, googleIssuer, "absent-subject"))
			if err != nil {
				t.Fatal(err)
			}
			return withS03SessionCookie(token)
		}},
		{name: "already revoked session cookie", credential: func(t *testing.T, h r54S03Harness) func(*http.Request) {
			assertS03Status(t, "prior logout", h.logoutStatus(h.fixture.webToken, h.fixture.csrfToken), http.StatusNoContent)
			return withS03SessionCookie(h.fixture.webToken)
		}},
		{name: "bearer header without cookie", credential: func(_ *testing.T, h r54S03Harness) func(*http.Request) {
			return withS03Bearer(h.fixture.accessToken)
		}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			h := newR54S03Harness(t)
			response := h.callback(t, "verified-subject", r54S03Nonce, testCase.credential(t, h))
			if response.Code != http.StatusSeeOther {
				t.Fatalf("callback status=%d body=%s", response.Code, response.Body.String())
			}
			session := cookieByName(t, response.Result().Cookies(), authn.WebSessionCookie).Value
			assertS03Status(t, "new session", h.meStatus(withS03SessionCookie(session)), http.StatusOK)
			// Only the web session cookie names a session to replace.
			assertS03Status(t, "native session", h.meStatus(withS03Bearer(h.fixture.accessToken)), http.StatusOK)
		})
	}
}

func TestR54S03RejectedCallbackKeepsWebSession(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		nonce   string
		prepare func(*http.Request)
		status  int
	}{
		{name: "forged state", nonce: r54S03Nonce, status: http.StatusBadRequest, prepare: func(request *http.Request) {
			query := request.URL.Query()
			query.Set("state", "forged-state")
			request.URL.RawQuery = query.Encode()
		}},
		{name: "nonce mismatch", nonce: "stale-nonce", status: http.StatusUnauthorized, prepare: func(*http.Request) {}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			h := newR54S03Harness(t)
			stream := h.subscribe(t, withS03SessionCookie(h.fixture.webToken))
			response := h.callback(t, "verified-subject", testCase.nonce, withS03SessionCookie(h.fixture.webToken), testCase.prepare)
			assertS03Status(t, "callback", response.Code, testCase.status)
			assertS03NoRedirect(t, response)
			assertS03NoSessionCookies(t, response)
			// An unverified callback must not sign the browser out.
			assertS03Status(t, "existing session", h.meStatus(withS03SessionCookie(h.fixture.webToken)), http.StatusOK)
			assertRevisionStreamOpen(t, stream)
		})
	}
}

func TestR54S03RevocationFailureKeepsCookieAndCreatesNoSession(t *testing.T) {
	h := newR54S03Harness(t)
	db, err := h.fixture.userStore.OpenExistingUser(context.Background(), h.fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TRIGGER r54_s03_block_revocation BEFORE UPDATE OF revoked_at_ms ON auth_sessions
		BEGIN SELECT RAISE(ABORT, 'injected revocation failure'); END`)
	if closeErr := db.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		t.Fatal(err)
	}

	response := h.callback(t, "verified-subject", r54S03Nonce, withS03SessionCookie(h.fixture.webToken))
	assertS03Status(t, "callback", response.Code, http.StatusInternalServerError)
	assertS03NoRedirect(t, response)
	assertS03NoSessionCookies(t, response)
	// The browser keeps the old cookie, so deferred recovery can still revoke it.
	assertS03Status(t, "existing session", h.meStatus(withS03SessionCookie(h.fixture.webToken)), http.StatusOK)
	newUserID := authn.UserID(h.fixture.application.cfg.AppSecret, googleIssuer, "verified-subject")
	if _, err := h.fixture.userStore.OpenExistingUser(context.Background(), newUserID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("failed callback created the signing-in account: %v", err)
	}
}

// A landing token in the PWA's format: 16 bytes, hex encoded.
var r54S03LandingToken = strings.Repeat("0a", 16)

// The PWA's sign-in landing token rides in the return path, so the callback
// must send the browser back to exactly the path the start request named.
func TestR54S03CallbackReturnsToStartReturnPath(t *testing.T) {
	h := newR54S03Harness(t)
	returnTo := "/app/tasks?filter=today&signin=" + r54S03LandingToken
	start := h.serve(httptest.NewRequest(http.MethodGet, r54S03PublicURL+"/auth/google/start?return="+url.QueryEscape(returnTo), nil))
	assertS03Status(t, "start", start.Code, http.StatusFound)
	stateCookie := cookieByName(t, start.Result().Cookies(), authn.OAuthStateCookie)
	state, err := h.fixture.application.codec.OpenOAuthState(stateCookie.Value, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	*h.nonce = state.Nonce

	query := url.Values{"code": {"test-subject"}, "state": {state.State}}
	request := httptest.NewRequest(http.MethodGet, r54S03PublicURL+"/auth/google/callback?"+query.Encode(), nil)
	request.AddCookie(&http.Cookie{Name: authn.OAuthStateCookie, Value: stateCookie.Value})
	response := h.serve(request, withS03SessionCookie(h.fixture.webToken), withS03CSRFCookie(h.fixture.csrfToken))
	if response.Code != http.StatusSeeOther || response.Header().Get("Location") != returnTo {
		t.Fatalf("callback status=%d location=%q body=%s", response.Code, response.Header().Get("Location"), response.Body.String())
	}
	assertS03Status(t, "replaced session", h.meStatus(withS03SessionCookie(h.fixture.webToken)), http.StatusUnauthorized)
}

// The landing token must not widen what the server accepts as a return path.
// Rejected paths stay rejected with the token in the query, and an accepted
// path keeps its query byte for byte.
func TestR54S03ReturnPathWithLandingTokenStaysSameOrigin(t *testing.T) {
	token := r54S03LandingToken
	for value, want := range map[string]string{
		"/app?signin=" + token:                     "/app?signin=" + token,
		"/app?signin=":                             "/app?signin=",
		"/app/tasks?filter=today&signin=" + token:  "/app/tasks?filter=today&signin=" + token,
		"//evil.example/app?signin=" + token:       "/",
		"/%2f%2fevil.example/app?signin=" + token:  "/",
		"https://evil.example/app?signin=" + token: "/",
		"https:/app?signin=" + token:               "/",
		`/app\evil?signin=` + token:                "/",
		`/\evil.example/app?signin=` + token:       "/",
	} {
		if got := safeReturnPath(value); got != want {
			t.Errorf("safeReturnPath(%q) = %q, want %q", value, got, want)
		}
	}
}
