package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRecoverMiddlewareSeparatesBrowserAndAPIFailures(t *testing.T) {
	fixture := newServerFixture(t)
	panicHandler := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("sensitive panic detail")
	})
	handler := fixture.application.recoverMiddleware(panicHandler)

	for _, testCase := range []struct {
		path, contentType, body string
	}{
		{path: "/app", contentType: "text/plain", body: "Internal Server Error"},
		{path: "/api/v1/sync", contentType: "application/json", body: `"error":"internal server error"`},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, testCase.path, nil))
		if response.Code != http.StatusInternalServerError {
			t.Fatalf("%s status = %d, want 500", testCase.path, response.Code)
		}
		if !strings.HasPrefix(response.Header().Get("Content-Type"), testCase.contentType) {
			t.Fatalf("%s Content-Type = %q", testCase.path, response.Header().Get("Content-Type"))
		}
		if body := response.Body.String(); !strings.Contains(body, testCase.body) || strings.Contains(body, "sensitive") {
			t.Fatalf("%s body = %q", testCase.path, body)
		}
	}
}

func TestStaticFileFailuresDoNotExposeDirectoriesOrMissingSpecifications(t *testing.T) {
	fixture := newServerFixture(t)
	if err := os.Remove(filepath.Join(fixture.application.cfg.WebRoot, "openapi.yaml")); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	fixture.application.handleOpenAPISpec(response, httptest.NewRequest(http.MethodGet, "/openapi.yaml", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing OpenAPI status = %d, want 503", response.Code)
	}

	if _, _, err := fixture.application.openWebFile("."); err == nil {
		t.Fatal("openWebFile accepted the web root directory as a file")
	}
	if _, _, err := fixture.application.openWebFile("../outside-secret"); !os.IsNotExist(err) {
		t.Fatalf("path traversal error = %v, want not-exist", err)
	}
}

func TestBearerCredentialsCannotAuthenticateProtectedBrowserRoutes(t *testing.T) {
	fixture := newServerFixture(t)
	request := httptest.NewRequest(http.MethodGet, "/app", nil)
	request.Header.Set("Authorization", "Bearer "+fixture.accessToken)
	response := httptest.NewRecorder()
	fixture.application.handleStatic(response, request)
	if response.Code != http.StatusFound {
		t.Fatalf("status = %d, want login redirect", response.Code)
	}
	if location := response.Header().Get("Location"); location != "/auth/google/start?return=%2Fapp" {
		t.Fatalf("Location = %q", location)
	}
}
