package server

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pomodorough/internal/config"
	"pomodorough/internal/store"
)

func TestPublicAndUnauthenticatedRoutes(t *testing.T) {
	userStore, err := store.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	webRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(webRoot, "openapi.yaml"), []byte("openapi: 3.0.3\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		PublicURL:               "https://pomodorough.egigoka.me",
		WebRoot:                 webRoot,
		AppSecret:               []byte(strings.Repeat("s", 32)),
		GoogleNativeClientIDSet: map[string]struct{}{},
	}
	application, err := New(cfg, userStore, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	handler := application.Handler()

	tests := []struct {
		name        string
		method      string
		path        string
		status      int
		location    string
		contentType string
	}{
		{name: "health", method: http.MethodGet, path: "/healthz", status: http.StatusOK, contentType: "application/json"},
		{name: "OpenAPI specification is public", method: http.MethodGet, path: "/openapi.yaml", status: http.StatusOK, contentType: "application/yaml"},
		{name: "root requires login", method: http.MethodGet, path: "/", status: http.StatusFound, location: "/auth/google/start?return=%2F"},
		{name: "web auth unavailable", method: http.MethodGet, path: "/auth/google/start", status: http.StatusServiceUnavailable},
		{name: "native auth unavailable", method: http.MethodPost, path: "/api/v1/auth/google/challenge", status: http.StatusServiceUnavailable, contentType: "application/json"},
		{name: "API auth is JSON", method: http.MethodGet, path: "/api/v1/me", status: http.StatusUnauthorized, contentType: "application/json"},
		{name: "unknown API does not redirect", method: http.MethodGet, path: "/api/v1/unknown", status: http.StatusNotFound, contentType: "application/json"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(test.method, "https://pomodorough.egigoka.me"+test.path, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d; body=%s", response.Code, test.status, response.Body.String())
			}
			if test.location != "" && response.Header().Get("Location") != test.location {
				t.Fatalf("Location = %q, want %q", response.Header().Get("Location"), test.location)
			}
			if test.contentType != "" && !strings.HasPrefix(response.Header().Get("Content-Type"), test.contentType) {
				t.Fatalf("Content-Type = %q, want prefix %q", response.Header().Get("Content-Type"), test.contentType)
			}
		})
	}
}

func TestSafeReturnPathRejectsExternalAndBackslashPaths(t *testing.T) {
	for _, value := range []string{"https://example.com/", "//example.com/", `/\example.com/`, `/%5cexample.com/`} {
		if got := safeReturnPath(value); got != "/" {
			t.Errorf("safeReturnPath(%q) = %q, want /", value, got)
		}
	}
	if got := safeReturnPath("/timer?view=today"); got != "/timer?view=today" {
		t.Fatalf("safe relative return path = %q", got)
	}
}
