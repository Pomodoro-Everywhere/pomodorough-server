package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// PWA-12: a signed-out visitor to an app route sees a signed-out page with a
// Sign in link instead of the Google account chooser, an unknown path shows a
// not-found page for every visitor, and the public pages can load their
// translations without a session.

const pwa12SignedOutPage = `<title>Signed out</title><a href="%POMODOROUGH_SIGN_IN_PATH%">Sign in</a>`
const pwa12NotFoundPage = `<title>Page not found</title>`

func pwa12Fixture(t *testing.T) serverFixture {
	t.Helper()
	fixture := newServerFixture(t)
	writeFixtureWebFile(t, fixture, "signed-out.html", pwa12SignedOutPage)
	writeFixtureWebFile(t, fixture, "not-found.html", pwa12NotFoundPage)
	writeFixtureWebFile(t, fixture, "app.css", "body { color: navy; }")
	writeFixtureWebFile(t, fixture, "i18n.js", "globalThis.i18nLoaded = true;")
	if err := os.MkdirAll(filepath.Join(fixture.application.cfg.WebRoot, "locales"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeFixtureWebFile(t, fixture, "locales/en.json", `{"$meta":{"locale":"en"}}`)
	return fixture
}

func pwa12Get(fixture serverFixture, method, requestPath string, signedIn bool) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, "https://pomodorough.egigoka.me"+requestPath, nil)
	if signedIn {
		addWebAuthentication(request, fixture)
	}
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	return response
}

func TestPWA12SignedOutAppRoutesShowSignedOutPage(t *testing.T) {
	fixture := pwa12Fixture(t)
	for _, test := range []struct{ path, signIn string }{
		{path: "/app", signIn: "/auth/google/start?return=%2Fapp"},
		{path: "/app/tasks?view=all", signIn: "/auth/google/start?return=%2Fapp%2Ftasks%3Fview%3Dall"},
	} {
		t.Run(test.path, func(t *testing.T) {
			response := pwa12Get(fixture, http.MethodGet, test.path, false)
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401; body=%s", response.Code, response.Body.String())
			}
			if location := response.Header().Get("Location"); location != "" {
				t.Fatalf("Location = %q, want no redirect to the account chooser", location)
			}
			body := response.Body.String()
			if !strings.Contains(body, `href="`+test.signIn+`"`) || strings.Contains(body, "%POMODOROUGH_SIGN_IN_PATH%") {
				t.Fatalf("body = %q, want Sign in link %q", body, test.signIn)
			}
			if response.Header().Get("Cache-Control") != "no-store" || !strings.HasPrefix(response.Header().Get("Content-Type"), "text/html") {
				t.Errorf("headers = %v, want uncached HTML", response.Header())
			}
		})
	}
	head := pwa12Get(fixture, http.MethodHead, "/app", false)
	if head.Code != http.StatusUnauthorized || head.Body.Len() != 0 {
		t.Fatalf("HEAD status = %d body length = %d, want 401 and empty", head.Code, head.Body.Len())
	}
}

func TestPWA12SignInLinkEscapesTheReturnPath(t *testing.T) {
	fixture := pwa12Fixture(t)
	response := pwa12Get(fixture, http.MethodGet, `/app/a?x="><b>&y=1`, false)
	body := response.Body.String()
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want the signed-out page", response.Code)
	}
	if strings.Contains(body, `"><b>`) {
		t.Fatalf("body = %q, return path broke out of the attribute", body)
	}
	if !strings.Contains(body, "return=%2Fapp%2Fa%3Fx%3D%22%3E%3Cb%3E%26y%3D1") {
		t.Fatalf("body = %q, want the query-escaped return path", body)
	}
}

func TestPWA12UnknownPathsShowNotFoundPageForEveryVisitor(t *testing.T) {
	fixture := pwa12Fixture(t)
	for _, signedIn := range []bool{false, true} {
		for _, requestPath := range []string{"/nope", "/missing.css"} {
			response := pwa12Get(fixture, http.MethodGet, requestPath, signedIn)
			if response.Code != http.StatusNotFound {
				t.Fatalf("signedIn=%v %s status = %d, want 404; Location=%q", signedIn, requestPath, response.Code, response.Header().Get("Location"))
			}
			if !strings.Contains(response.Body.String(), "Page not found") {
				t.Fatalf("signedIn=%v %s body = %q, want the not-found page", signedIn, requestPath, response.Body.String())
			}
		}
	}
}

func TestPWA12PublicTranslationsAndPrivateAssets(t *testing.T) {
	fixture := pwa12Fixture(t)
	for _, requestPath := range []string{"/i18n.js?v=8", "/locales/en.json?v=7"} {
		if response := pwa12Get(fixture, http.MethodGet, requestPath, false); response.Code != http.StatusOK {
			t.Fatalf("%s status = %d, want 200 without a session", requestPath, response.Code)
		}
	}
	response := pwa12Get(fixture, http.MethodGet, "/app.css?v=24", false)
	if response.Code != http.StatusFound || response.Header().Get("Location") != "/auth/google/start?return=%2Fapp.css%3Fv%3D24" {
		t.Fatalf("private asset status = %d Location = %q, want the sign-in redirect", response.Code, response.Header().Get("Location"))
	}
}
