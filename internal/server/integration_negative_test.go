package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"pomodorough/internal/authn"
)

func TestUnavailableAndUnauthenticatedRoutes(t *testing.T) {
	fixture := newServerFixture(t)
	tests := []struct {
		name     string
		method   string
		path     string
		status   int
		location string
	}{
		{name: "root is public", method: http.MethodGet, path: "/", status: http.StatusOK},
		{name: "app requires login", method: http.MethodGet, path: "/app", status: http.StatusFound, location: "/auth/google/start?return=%2Fapp"},
		{name: "web auth unavailable", method: http.MethodGet, path: "/auth/google/start", status: http.StatusServiceUnavailable},
		{name: "native auth unavailable", method: http.MethodPost, path: "/api/v1/auth/google/challenge", status: http.StatusServiceUnavailable},
		{name: "API requires auth", method: http.MethodGet, path: "/api/v1/me", status: http.StatusUnauthorized},
		{name: "unknown API", method: http.MethodGet, path: "/api/v1/unknown", status: http.StatusNotFound},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(test.method, "https://pomodorough.egigoka.me"+test.path, nil)
			response := httptest.NewRecorder()
			fixture.handler.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d; body=%s", response.Code, test.status, response.Body.String())
			}
			if test.location != "" && response.Header().Get("Location") != test.location {
				t.Fatalf("Location = %q, want %q", response.Header().Get("Location"), test.location)
			}
		})
	}
}

func TestCookieMutationRejectsInvalidCSRF(t *testing.T) {
	tests := []struct {
		name   string
		origin string
		header string
		cookie string
	}{
		{name: "missing origin", header: "csrf-token", cookie: "csrf-token"},
		{name: "wrong origin", origin: "https://example.com", header: "csrf-token", cookie: "csrf-token"},
		{name: "missing header", origin: "https://pomodorough.egigoka.me", cookie: "csrf-token"},
		{name: "cookie header mismatch", origin: "https://pomodorough.egigoka.me", header: "csrf-token", cookie: "other-token"},
		{name: "stored hash mismatch", origin: "https://pomodorough.egigoka.me", header: "other-token", cookie: "other-token"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newServerFixture(t)
			request := httptest.NewRequest(http.MethodPost, "https://pomodorough.egigoka.me/api/v1/auth/logout", nil)
			addWebAuthentication(request, fixture)
			if test.origin != "" {
				request.Header.Set("Origin", test.origin)
			}
			if test.header != "" {
				request.Header.Set("X-CSRF-Token", test.header)
			}
			if test.cookie != "" {
				request.AddCookie(&http.Cookie{Name: authn.CSRFCookie, Value: test.cookie})
			}
			response := httptest.NewRecorder()
			fixture.handler.ServeHTTP(response, request)
			if response.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want 403; body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestInvalidAuthorizationDoesNotFallBackToCookie(t *testing.T) {
	fixture := newServerFixture(t)
	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/me", nil)
	request.Header.Set("Authorization", "Bearer invalid")
	addWebAuthentication(request, fixture)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", response.Code, response.Body.String())
	}
}

func TestBearerSyncRejectsDifferentDevice(t *testing.T) {
	fixture := newServerFixture(t)
	body, err := json.Marshal(syncRequestJSON{DeviceID: "device-0002", LastRevision: int64Pointer(0), Commands: []syncCommandJSON{}})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "https://pomodorough.egigoka.me/api/v1/sync", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+fixture.accessToken)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "device mismatch") {
		t.Fatalf("status = %d, want 403 device mismatch; body=%s", response.Code, response.Body.String())
	}
}

func TestRefreshReuseRevokesNativeSession(t *testing.T) {
	fixture := newServerFixture(t)
	if response := postRefresh(t, fixture, fixture.refreshToken); response.Code != http.StatusOK {
		t.Fatalf("initial refresh status=%d body=%s", response.Code, response.Body.String())
	}
	if response := postRefresh(t, fixture, fixture.refreshToken); response.Code != http.StatusUnauthorized {
		t.Fatalf("refresh reuse status=%d, want 401; body=%s", response.Code, response.Body.String())
	}

	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/history", nil)
	request.Header.Set("Authorization", "Bearer "+fixture.accessToken)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("session survived refresh reuse: status=%d", response.Code)
	}
}
