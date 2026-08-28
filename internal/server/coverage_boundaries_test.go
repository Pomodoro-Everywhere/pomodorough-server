package server

import (
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"pomodorough/internal/authn"
)

func TestRequestRuntimeErrorPreservesItsCause(t *testing.T) {
	cause := errors.New("store unavailable")
	wrapped := &requestRuntimeError{cause: cause}

	if wrapped.Error() != cause.Error() {
		t.Fatalf("Error() = %q, want %q", wrapped.Error(), cause.Error())
	}
	if !errors.Is(wrapped, cause) {
		t.Fatal("request runtime error did not preserve its cause")
	}
	if !isRequestRuntimeError(wrapped) {
		t.Fatal("request runtime error was not classified")
	}
	if isRequestRuntimeError(cause) {
		t.Fatal("ordinary error was classified as a request runtime error")
	}
}

func TestAuthenticationCookiesPreserveSecurityBoundaries(t *testing.T) {
	expiresAt := time.Now().Add(time.Hour).UTC().Truncate(time.Second)

	t.Run("web session", func(t *testing.T) {
		response := httptest.NewRecorder()
		setSessionCookie(response, "session-token", expiresAt)
		cookie := onlyResponseCookie(t, response)
		if cookie.Name != authn.WebSessionCookie || cookie.Value != "session-token" || cookie.Path != "/" {
			t.Fatalf("unexpected session cookie: %#v", cookie)
		}
		if !cookie.Secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || cookie.MaxAge <= 0 {
			t.Fatalf("session cookie weakened security attributes: %#v", cookie)
		}
	})

	t.Run("csrf", func(t *testing.T) {
		response := httptest.NewRecorder()
		setCSRFCookie(response, "csrf-token", expiresAt)
		cookie := onlyResponseCookie(t, response)
		if cookie.Name != authn.CSRFCookie || cookie.Value != "csrf-token" || cookie.Path != "/" {
			t.Fatalf("unexpected CSRF cookie: %#v", cookie)
		}
		if !cookie.Secure || cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || cookie.MaxAge <= 0 {
			t.Fatalf("CSRF cookie has incorrect script/security attributes: %#v", cookie)
		}
	})

	t.Run("oauth state deletion", func(t *testing.T) {
		response := httptest.NewRecorder()
		clearOAuthStateCookie(response)
		cookie := onlyResponseCookie(t, response)
		if cookie.Name != authn.OAuthStateCookie || cookie.Value != "" || cookie.Path != "/auth/google" {
			t.Fatalf("unexpected OAuth deletion cookie: %#v", cookie)
		}
		if cookie.MaxAge != -1 || !cookie.Secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode {
			t.Fatalf("OAuth deletion cookie weakened security attributes: %#v", cookie)
		}
	})
}

func TestInternalErrorsKeepDetailsOutOfResponses(t *testing.T) {
	server := &Server{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	cause := errors.New("database password leaked")

	plain := httptest.NewRecorder()
	server.internalError(plain, "load account", cause)
	if plain.Code != http.StatusInternalServerError || strings.Contains(plain.Body.String(), cause.Error()) {
		t.Fatalf("plain internal error leaked details: status=%d body=%q", plain.Code, plain.Body.String())
	}

	api := httptest.NewRecorder()
	server.internalAPIError(api, "sync account", cause)
	if api.Code != http.StatusInternalServerError || strings.Contains(api.Body.String(), cause.Error()) {
		t.Fatalf("API internal error leaked details: status=%d body=%q", api.Code, api.Body.String())
	}
	mediaType, _, err := mime.ParseMediaType(api.Header().Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		t.Fatalf("API Content-Type = %q, want application/json", api.Header().Get("Content-Type"))
	}
}

func onlyResponseCookie(t *testing.T, response *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	cookies := response.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("received %d cookies, want 1", len(cookies))
	}
	return cookies[0]
}
