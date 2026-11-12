package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
)

func assertHistoricalDiagnostics(t *testing.T, fixture serverFixture, events int, transport *sentry.MockTransport, operation string, canceled bool) {
	t.Helper()
	sentry.Flush(2 * time.Second)
	if got := len(transport.Events()); got != events {
		t.Fatalf("events=%d, want %d for %s", got, events, operation)
	}
	want := uint64(0)
	if canceled {
		want = 1
	}
	if got := fixture.application.metrics.canceledCount(http.MethodPost, "POST /diagnostics"); got != want {
		t.Fatalf("cancellations=%d, want %d", got, want)
	}
}

func TestHistoricalAuthPersistenceDiagnostics(t *testing.T) {
	for _, operation := range []string{"persist native challenge", "open native user account", "consume native challenge", "open user account", "update user profile", "create web session"} {
		for _, cause := range []error{context.Canceled, context.DeadlineExceeded, errors.New("infrastructure cancellation lookalike")} {
			t.Run(operation+"/"+cause.Error(), func(t *testing.T) {
				transport := initMockSentry(t)
				fixture := newServerFixture(t)
				logs := r49S08CaptureLogs(fixture.application)
				request := httptest.NewRequest(http.MethodPost, "/diagnostics", nil)
				request.Pattern = "POST /diagnostics"
				request.Header.Set("Idempotency-Key", "historical-wire-key")
				response := httptest.NewRecorder()
				failure := fmt.Errorf("persist: %w", cause)
				web := operation == "open user account" || operation == "update user profile" || operation == "create web session"
				if web {
					fixture.application.internalError(response, request, operation, failure)
				} else {
					fixture.application.internalAPIError(response, request, operation, failure)
				}
				assertHistoricalAuthWire(t, response, web)
				canceled := isRequestCancellation(cause, context.Background())
				events := 1
				if canceled {
					events = 0
				}
				assertHistoricalDiagnostics(t, fixture, events, transport, operation, canceled)
				if strings.Contains(logs.String(), "level=ERROR") == canceled {
					t.Fatalf("wrong diagnostic level: %s", logs.String())
				}
			})
		}
	}
}

func assertHistoricalAuthWire(t *testing.T, response *httptest.ResponseRecorder, web bool) {
	t.Helper()
	want := "{\"error\":\"internal server error\"}\n"
	if web {
		want = "Internal Server Error\n"
	}
	if response.Code != 500 || response.Body.String() != want {
		t.Fatalf("wire=%d %q, want 500 %q", response.Code, response.Body.String(), want)
	}
	if !web && response.Header().Get("Idempotency-Key") != "historical-wire-key" {
		t.Fatal("missing API idempotency echo")
	}
	if len(response.Header().Values("Set-Cookie")) != 0 {
		t.Fatal("failure minted cookies")
	}
}

type historicalFailWriter struct {
	*httptest.ResponseRecorder
	err error
}

func (w historicalFailWriter) Write(_ []byte) (int, error) { return 0, w.err }

func TestHistoricalResponseWriteDiagnostics(t *testing.T) {
	for _, metrics := range []bool{false, true} {
		for _, cause := range []error{context.Canceled, context.DeadlineExceeded, errors.New(strings.Repeat("secret-canary", 2000))} {
			t.Run(fmt.Sprintf("metrics=%v/%T/%s", metrics, cause, monitoringCause(cause)), func(t *testing.T) {
				transport := initMockSentry(t)
				fixture := newServerFixture(t)
				logs := r49S08CaptureLogs(fixture.application)
				request := httptest.NewRequest(http.MethodPost, "/diagnostics", nil)
				request.Pattern = "POST /diagnostics"
				writer := historicalFailWriter{httptest.NewRecorder(), cause}
				handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if metrics {
						fixture.application.handleMetrics(w, r)
					} else {
						writeJSON(w, r, 200, map[string]string{"status": "ok"})
					}
				})
				fixture.application.loggingMiddleware(handler).ServeHTTP(writer, request)
				canceled := isRequestCancellation(cause, request.Context())
				events := 1
				if canceled {
					events = 0
				}
				assertHistoricalDiagnostics(t, fixture, events, transport, "response", canceled)
				r51S03AssertBoundedNoCanary(t, logs.String(), "secret-canary")
				if writer.Code != 200 {
					t.Fatalf("status=%d", writer.Code)
				}
			})
		}
	}
}

func TestHistoricalPanicLogIsFiniteAndStillReports(t *testing.T) {
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	logs := r49S08CaptureLogs(fixture.application)
	request := httptest.NewRequest(http.MethodGet, "/api/panic", nil)
	request.Pattern = "GET /api/panic"
	response := httptest.NewRecorder()
	fixture.application.recoverMiddleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic(strings.Repeat("panic-canary", 4000))
	})).ServeHTTP(response, request)
	r51S03AssertBoundedNoCanary(t, logs.String(), "panic-canary")
	if !strings.Contains(logs.String(), "cause=panic") || response.Code != 500 {
		t.Fatal("missing panic diagnostic or 500")
	}
	sentry.Flush(2 * time.Second)
	if len(transport.Events()) != 1 {
		t.Fatal("genuine panic not reported")
	}
}

func TestHistoricalStaticFailuresBoundPathsAndPreserveFaults(t *testing.T) {
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	logs := r49S08CaptureLogs(fixture.application)
	fixture.application.cfg.WebRoot = t.TempDir() + "/" + strings.Repeat("path-canary", 1000)
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Pattern = "GET /"
	response := httptest.NewRecorder()
	fixture.application.handleStatic(response, request)
	r51S03AssertBoundedNoCanary(t, logs.String(), "path-canary")
	sentry.Flush(2 * time.Second)
	if response.Code != 503 || len(transport.Events()) != 1 {
		t.Fatal("static failure lost status or fault")
	}
	if !strings.Contains(logs.String(), "level=ERROR") {
		t.Fatal("missing error log")
	}
}

func TestHistoricalStaticFaultSitesRemainBounded(t *testing.T) {
	for _, site := range []string{"open OpenAPI specification", "open SPA entrypoint", "read web entrypoint"} {
		t.Run(site, func(t *testing.T) {
			transport := initMockSentry(t)
			fixture := newServerFixture(t)
			logs := r49S08CaptureLogs(fixture.application)
			fixture.application.cfg.WebRoot = t.TempDir()
			request := httptest.NewRequest(http.MethodGet, "/", nil)
			response := httptest.NewRecorder()
			switch site {
			case "open OpenAPI specification":
				fixture.application.handleOpenAPISpec(response, request)
			case "open SPA entrypoint":
				fixture.application.openRequestedWebFile(response, request, "/app/deep", "app/deep", false)
			case "read web entrypoint":
				file, err := os.Create(filepath.Join(fixture.application.cfg.WebRoot, "app.html"))
				if err != nil {
					t.Fatal(err)
				}
				info, err := file.Stat()
				if err != nil {
					t.Fatal(err)
				}
				file.Close()
				fixture.application.serveEntrypoint(response, request, file, info, strings.Repeat("path-canary", 1000))
			}
			r51S03AssertBoundedNoCanary(t, logs.String(), "path-canary")
			sentry.Flush(2 * time.Second)
			if response.Code != 503 || len(transport.Events()) != 1 {
				t.Fatal("missing fault status/report")
			}
			if !strings.Contains(logs.String(), `msg="`+site+`"`) {
				t.Fatalf("wrong site: %s", logs.String())
			}
		})
	}
}

func TestHistoricalWebAuthenticationCancellationPreservesRedirect(t *testing.T) {
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	logs := r49S08CaptureLogs(fixture.application)
	request := httptest.NewRequest(http.MethodGet, "/app", nil)
	addWebAuthentication(request, fixture)
	ctx, cancel := context.WithCancel(request.Context())
	cancel()
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request.WithContext(ctx))
	if response.Code != 302 || !strings.HasPrefix(response.Header().Get("Location"), "/auth/google/start?") {
		t.Fatalf("browser contract changed: %d %v", response.Code, response.Header())
	}
	if fixture.application.metrics.canceledCount(http.MethodGet, "/") != 1 {
		t.Fatal("missing cancellation metric")
	}
	sentry.Flush(2 * time.Second)
	if len(transport.Events()) != 0 || strings.Contains(logs.String(), "level=ERROR") {
		t.Fatal("cancellation reported as fault")
	}
}
