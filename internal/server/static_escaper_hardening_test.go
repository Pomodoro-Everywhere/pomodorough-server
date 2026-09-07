package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestEntrypointEscapesSingleQuoteInWebDSN(t *testing.T) {
	fixture := newServerFixture(t)
	writeFixtureWebFile(t, fixture, "index.html", `<!doctype html><meta name="sentry-dsn" content="%POMODOROUGH_SENTRY_DSN%">`)
	fixture.application.cfg.SentryWebDSN = `https://x@o1.ingest.sentry.io/2'><script>`
	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/", nil)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	want := `content="https://x@o1.ingest.sentry.io/2&#39;&gt;&lt;script&gt;"`
	if body := response.Body.String(); !strings.Contains(body, want) {
		t.Fatalf("escaped entrypoint = %s, want substring %s", body, want)
	}
}
