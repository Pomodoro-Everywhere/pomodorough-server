package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"pomodorough/internal/authn"
)

func TestBearerProfileDoesNotExposeOrMintBrowserCSRFToken(t *testing.T) {
	fixture := newServerFixture(t)
	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/me", nil)
	request.Header.Set("Authorization", "Bearer "+fixture.accessToken)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/me status=%d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		CSRFToken string `json:"csrfToken"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.CSRFToken != "" {
		t.Fatalf("bearer profile exposed browser CSRF token %q", payload.CSRFToken)
	}
	if cookies := response.Result().Cookies(); len(cookies) != 0 {
		t.Fatalf("bearer profile minted browser cookies: %#v", cookies)
	}
}

func TestCookieProfileReplacesMismatchedCSRFCookieAndRejectsTheOldValue(t *testing.T) {
	fixture := newServerFixture(t)
	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/me", nil)
	addWebAuthentication(request, fixture)
	request.AddCookie(&http.Cookie{Name: authn.CSRFCookie, Value: "attacker-controlled"})
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/me status=%d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		CSRFToken string `json:"csrfToken"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.CSRFToken == "" || payload.CSRFToken == "attacker-controlled" || payload.CSRFToken == fixture.csrfToken {
		t.Fatalf("replacement CSRF token was not freshly generated: %q", payload.CSRFToken)
	}

	logout := httptest.NewRequest(http.MethodPost, "https://pomodorough.egigoka.me/api/v1/auth/logout", nil)
	addWebAuthentication(logout, fixture)
	logout.Header.Set("Origin", "https://pomodorough.egigoka.me")
	logout.Header.Set("X-CSRF-Token", "attacker-controlled")
	logout.AddCookie(&http.Cookie{Name: authn.CSRFCookie, Value: "attacker-controlled"})
	logoutResponse := httptest.NewRecorder()
	fixture.handler.ServeHTTP(logoutResponse, logout)
	if logoutResponse.Code != http.StatusForbidden {
		t.Fatalf("old mismatched CSRF token status=%d body=%s", logoutResponse.Code, logoutResponse.Body.String())
	}
}
