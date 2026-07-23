package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLandingAndAssetsArePublic(t *testing.T) {
	fixture := newServerFixture(t)
	writeFixtureWebFile(t, fixture, "landing.css", "body { color: navy; }")
	writeFixtureWebFile(t, fixture, "platform-selector.js", "globalThis.selectorLoaded = true;")
	writeFixtureWebFile(t, fixture, "landing.js", "globalThis.landingLoaded = true;")
	writeFixtureWebFile(t, fixture, "icon.svg", `<svg xmlns="http://www.w3.org/2000/svg"/>`)

	tests := []struct {
		name         string
		method       string
		path         string
		contentType  string
		cacheControl string
	}{
		{name: "root", method: http.MethodGet, path: "/", contentType: "text/html", cacheControl: "no-store"},
		{name: "index HEAD", method: http.MethodHead, path: "/index.html", contentType: "text/html", cacheControl: "no-store"},
		{name: "stylesheet", method: http.MethodGet, path: "/landing.css?v=1", contentType: "text/css", cacheControl: "public, max-age=300"},
		{name: "selector", method: http.MethodGet, path: "/platform-selector.js?v=1", contentType: "text/javascript", cacheControl: "public, max-age=300"},
		{name: "landing script", method: http.MethodGet, path: "/landing.js?v=1", contentType: "text/javascript", cacheControl: "public, max-age=300"},
		{name: "icon", method: http.MethodGet, path: "/icon.svg", contentType: "image/svg+xml", cacheControl: "public, max-age=300"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(test.method, "https://pomodorough.egigoka.me"+test.path, nil)
			response := httptest.NewRecorder()
			fixture.handler.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200; body=%s", response.Code, response.Body.String())
			}
			if !strings.HasPrefix(response.Header().Get("Content-Type"), test.contentType) {
				t.Errorf("Content-Type = %q, want prefix %q", response.Header().Get("Content-Type"), test.contentType)
			}
			if response.Header().Get("Cache-Control") != test.cacheControl {
				t.Errorf("Cache-Control = %q, want %q", response.Header().Get("Cache-Control"), test.cacheControl)
			}
			if response.Header().Get("Content-Security-Policy") == "" {
				t.Error("missing Content-Security-Policy")
			}
			if test.method == http.MethodHead && response.Body.Len() != 0 {
				t.Errorf("HEAD body length = %d, want 0", response.Body.Len())
			}
		})
	}
}

func TestUnsupportedStaticMethodsReturnBeforeAuthentication(t *testing.T) {
	fixture := newServerFixture(t)
	for _, requestPath := range []string{"/", "/index.html", "/app", "/app.css"} {
		t.Run(requestPath, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "https://pomodorough.egigoka.me"+requestPath, nil)
			response := httptest.NewRecorder()
			fixture.handler.ServeHTTP(response, request)
			if response.Code != http.StatusMethodNotAllowed {
				t.Fatalf("status = %d, want 405; body=%s", response.Code, response.Body.String())
			}
			if response.Header().Get("Allow") != "GET, HEAD" {
				t.Errorf("Allow = %q, want GET, HEAD", response.Header().Get("Allow"))
			}
			if response.Header().Get("Location") != "" {
				t.Errorf("Location = %q, want empty", response.Header().Get("Location"))
			}
		})
	}
}

func TestAppRouteAuthenticationAndStaticBehavior(t *testing.T) {
	fixture := newServerFixture(t)
	writeFixtureWebFile(t, fixture, "app.css", "body { color: navy; }")
	writeFixtureWebFile(t, fixture, "sw.js", "// service worker")
	writeFixtureWebFile(t, fixture, "manifest.webmanifest", `{ "start_url": "/app" }`)
	writeFixtureWebFile(t, fixture, "app.abcdef12.js", "// hashed asset")

	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/app", nil)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusFound || response.Header().Get("Location") != "/auth/google/start?return=%2Fapp" {
		t.Fatalf("unauthenticated /app status=%d Location=%q", response.Code, response.Header().Get("Location"))
	}

	tests := []struct {
		name         string
		path         string
		wantStatus   int
		wantBody     string
		cacheControl string
	}{
		{name: "app entry", path: "/app", wantStatus: http.StatusOK, wantBody: "Pomodorough application", cacheControl: "no-store"},
		{name: "SPA fallback", path: "/app/timer/today", wantStatus: http.StatusOK, wantBody: "Pomodorough application", cacheControl: "no-store"},
		{name: "app asset", path: "/app.css?v=14", wantStatus: http.StatusOK, wantBody: "color: navy", cacheControl: "public, max-age=300"},
		{name: "service worker", path: "/sw.js", wantStatus: http.StatusOK, wantBody: "service worker", cacheControl: "no-cache"},
		{name: "manifest", path: "/manifest.webmanifest", wantStatus: http.StatusOK, wantBody: "start_url", cacheControl: "no-cache"},
		{name: "hashed asset", path: "/app.abcdef12.js", wantStatus: http.StatusOK, wantBody: "hashed asset", cacheControl: "public, max-age=31536000, immutable"},
		{name: "missing root asset", path: "/missing.css", wantStatus: http.StatusNotFound},
		{name: "missing app asset", path: "/app/missing.css", wantStatus: http.StatusNotFound},
		{name: "unknown root navigation", path: "/missing-route", wantStatus: http.StatusNotFound},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me"+test.path, nil)
			addWebAuthentication(request, fixture)
			if test.name == "SPA fallback" {
				request.Header.Set("Accept", "text/html")
			}
			response := httptest.NewRecorder()
			fixture.handler.ServeHTTP(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d; body=%s", response.Code, test.wantStatus, response.Body.String())
			}
			if test.wantBody != "" && !strings.Contains(response.Body.String(), test.wantBody) {
				t.Errorf("body = %q, want substring %q", response.Body.String(), test.wantBody)
			}
			if test.cacheControl != "" && response.Header().Get("Cache-Control") != test.cacheControl {
				t.Errorf("Cache-Control = %q, want %q", response.Header().Get("Cache-Control"), test.cacheControl)
			}
		})
	}

	request = httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/", nil)
	addWebAuthentication(request, fixture)
	response = httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "Pomodorough landing") || strings.Contains(response.Body.String(), "Pomodorough application") {
		t.Fatalf("authenticated root did not remain landing: status=%d body=%s", response.Code, response.Body.String())
	}
}

func writeFixtureWebFile(t *testing.T, fixture serverFixture, name, contents string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(fixture.application.cfg.WebRoot, name), []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
}
