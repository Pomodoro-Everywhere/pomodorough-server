package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestEntrypointRendersConfiguredWebDSN(t *testing.T) {
	fixture := newServerFixture(t)
	writeFixtureWebFile(t, fixture, "index.html", `<!doctype html><meta name="sentry-dsn" content="%POMODOROUGH_SENTRY_DSN%">`)
	fixture.application.cfg.SentryWebDSN = "https://web-key@o1.ingest.sentry.io/2"

	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/", nil)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", response.Code, response.Body.String())
	}
	if body := response.Body.String(); !strings.Contains(body, `content="https://web-key@o1.ingest.sentry.io/2"`) {
		t.Fatalf("rendered entrypoint missing DSN: %s", body)
	} else if strings.Contains(body, sentryDSNPlaceholder) {
		t.Fatalf("rendered entrypoint leaked placeholder: %s", body)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", response.Header().Get("Cache-Control"))
	}
}

func TestEntrypointClearsPlaceholderWithoutWebDSN(t *testing.T) {
	fixture := newServerFixture(t)
	writeFixtureWebFile(t, fixture, "index.html", `<!doctype html><meta name="sentry-dsn" content="%POMODOROUGH_SENTRY_DSN%">`)

	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/", nil)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)

	if body := response.Body.String(); !strings.Contains(body, `content=""`) {
		t.Fatalf("unconfigured entrypoint = %s, want empty DSN", body)
	} else if strings.Contains(body, sentryDSNPlaceholder) {
		t.Fatalf("unconfigured entrypoint leaked placeholder: %s", body)
	}
}

func TestEntrypointEscapesWebDSNAttribute(t *testing.T) {
	fixture := newServerFixture(t)
	writeFixtureWebFile(t, fixture, "index.html", `<!doctype html><meta name="sentry-dsn" content="%POMODOROUGH_SENTRY_DSN%">`)
	fixture.application.cfg.SentryWebDSN = `https://x@o1.ingest.sentry.io/2"><script>`

	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/", nil)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)

	want := `content="https://x@o1.ingest.sentry.io/2&quot;&gt;&lt;script&gt;"`
	if body := response.Body.String(); !strings.Contains(body, want) {
		t.Fatalf("escaped entrypoint = %s, want substring %s", body, want)
	}
}

func TestNonEntrypointKeepsPlaceholderVerbatim(t *testing.T) {
	fixture := newServerFixture(t)
	writeFixtureWebFile(t, fixture, "landing.css", "body::after { content: \"%POMODOROUGH_SENTRY_DSN%\"; }")
	fixture.application.cfg.SentryWebDSN = "https://web-key@o1.ingest.sentry.io/2"

	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/landing.css", nil)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)

	if body := response.Body.String(); !strings.Contains(body, sentryDSNPlaceholder) {
		t.Fatalf("static asset = %s, want verbatim placeholder", body)
	}
}

func TestSentryClientScriptIsPublic(t *testing.T) {
	fixture := newServerFixture(t)
	writeFixtureWebFile(t, fixture, "sentry-client.js", "globalThis.sentryClientLoaded = true;")

	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/sentry-client.js?v=1", nil)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", response.Code, response.Body.String())
	}
	if body := response.Body.String(); !strings.Contains(body, "sentryClientLoaded") {
		t.Fatalf("sentry client body = %q", body)
	}
}
