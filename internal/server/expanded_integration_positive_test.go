package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"pomodorough/internal/authn"
)

func TestCookieLogoutInvalidatesTheServerSession(t *testing.T) {
	fixture := newServerFixture(t)
	logout := httptest.NewRequest(http.MethodPost, "https://pomodorough.egigoka.me/api/v1/auth/logout", nil)
	addWebAuthentication(logout, fixture)
	addValidCSRF(logout, fixture)
	logoutResponse := httptest.NewRecorder()
	fixture.handler.ServeHTTP(logoutResponse, logout)
	if logoutResponse.Code != http.StatusNoContent {
		t.Fatalf("logout status=%d body=%s", logoutResponse.Code, logoutResponse.Body.String())
	}
	cleared := map[string]*http.Cookie{}
	for _, cookie := range logoutResponse.Result().Cookies() {
		cleared[cookie.Name] = cookie
	}
	for _, name := range []string{authn.WebSessionCookie, authn.CSRFCookie} {
		cookie := cleared[name]
		if cookie == nil {
			t.Fatalf("logout did not clear %s", name)
		}
		if cookie.Value != "" || cookie.MaxAge >= 0 || !cookie.Secure || cookie.Path != "/" || cookie.SameSite != http.SameSiteLaxMode {
			t.Fatalf("unsafe cleared cookie %s: %#v", name, cookie)
		}
	}
	if !cleared[authn.WebSessionCookie].HttpOnly {
		t.Fatal("cleared web session cookie is not HttpOnly")
	}

	profile := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/me", nil)
	addWebAuthentication(profile, fixture)
	profileResponse := httptest.NewRecorder()
	fixture.handler.ServeHTTP(profileResponse, profile)
	if profileResponse.Code != http.StatusUnauthorized {
		t.Fatalf("profile after logout status=%d body=%s", profileResponse.Code, profileResponse.Body.String())
	}
}
