package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"

	"pomodorough/internal/authn"
	"pomodorough/internal/store"
)

// R51-S01: refresh cancellation must not emit actionable faults.
// Both refresh error writers now use the typed cancellation boundary
// after unauthorized/reuse classification. Covers open and rotation
// with cancel/expired/finalize wrappers plus malformed and genuine
// controls. 14 cases total: finalize wrappers run direct and through
// route plus middleware.

type r51S01BoundaryContext struct {
	context.Context
	sentinel    error
	rotateEntry uintptr
	triggered   bool
	done        chan struct{}
	once        sync.Once
}

// newR51S01Boundary keys rotation entry on the real store.RotateRefresh
// function object, not on a name string. A rename or removal breaks
// compilation here instead of silently never triggering. The triggered
// guard at the call site stays: a missing frame must fail loudly.
func newR51S01Boundary(parent context.Context, sentinel error) *r51S01BoundaryContext {
	entry := runtime.FuncForPC(reflect.ValueOf(store.RotateRefresh).Pointer()).Entry()
	return &r51S01BoundaryContext{Context: parent, sentinel: sentinel, rotateEntry: entry, done: make(chan struct{})}
}

func (c *r51S01BoundaryContext) activate() {
	pcs := make([]uintptr, 32)
	n := runtime.Callers(2, pcs)
	frames := runtime.CallersFrames(pcs[:n])
	for {
		frame, more := frames.Next()
		if frame.Func != nil && frame.Func.Entry() == c.rotateEntry {
			c.once.Do(func() { c.triggered = true; close(c.done) })
			return
		}
		if !more {
			return
		}
	}
}

func (c *r51S01BoundaryContext) Done() <-chan struct{} {
	c.activate()
	return c.done
}

func (c *r51S01BoundaryContext) Err() error {
	c.activate()
	select {
	case <-c.done:
		return c.sentinel
	default:
		return nil
	}
}

func r51S01RefreshRequest(t *testing.T, fixture serverFixture, token string, ctx context.Context) (*httptest.ResponseRecorder, *http.Request) {
	t.Helper()
	request, response := newJSONRequest(t, http.MethodPost, fixture.application.cfg.PublicURL+"/api/v1/auth/refresh", map[string]string{"refreshToken": token})
	request = request.WithContext(ctx)
	request.Pattern = "POST /api/v1/auth/refresh"
	request.Header.Set("Idempotency-Key", "r51-s01-wire-key")
	return response, request
}

func r51S01AssertCanceledWire(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	if response.Code != http.StatusInternalServerError || response.Body.String() != "{\"error\":\"internal server error\"}\n" {
		t.Fatalf("status=%d body=%q, want 500 exact internal-error JSON", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Idempotency-Key"); got != "r51-s01-wire-key" {
		t.Fatalf("Idempotency-Key=%q, want echo", got)
	}
	for name, want := range map[string]string{
		"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
	} {
		if got := response.Header().Values(name); !slices.Equal(got, []string{want}) {
			t.Fatalf("%s=%q, want single value %q", name, got, want)
		}
	}
	if cookies := response.Header().Values("Set-Cookie"); len(cookies) != 0 {
		t.Fatalf("cancellation changed cookies: %q", cookies)
	}
}

func r51S01Inventory(t *testing.T, fixture serverFixture) (int, int) {
	t.Helper()
	db, err := fixture.userStore.OpenExistingUser(context.Background(), fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var sessions, tokens int
	if err := db.QueryRow(`SELECT COUNT(*) FROM auth_sessions`).Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM auth_tokens`).Scan(&tokens); err != nil {
		t.Fatal(err)
	}
	return sessions, tokens
}

func r51S01AssertIntactAndRetry(t *testing.T, fixture serverFixture, sessions, tokens int) {
	t.Helper()
	if gotS, gotT := r51S01Inventory(t, fixture); gotS != sessions || gotT != tokens {
		t.Fatalf("inventory sessions=%d tokens=%d, want %d %d", gotS, gotT, sessions, tokens)
	}
	if err := fixture.userStore.ValidateAccountGeneration(context.Background(), fixture.userID, 1); err != nil {
		t.Fatalf("generation invalid after canceled refresh: %v", err)
	}
	if got := postRefresh(t, fixture, fixture.refreshToken); got.Code != http.StatusOK {
		t.Fatalf("live retry status=%d, want 200", got.Code)
	}
}

func r51S01AssertCanceled(t *testing.T, response *httptest.ResponseRecorder, transport *sentry.MockTransport, app *Server, logs string, operation string) {
	t.Helper()
	r51S01AssertCanceledWire(t, response)
	if got := app.metrics.canceledCount(http.MethodPost, "POST /api/v1/auth/refresh"); got != 1 {
		t.Fatalf("canceled count=%d, want 1", got)
	}
	sentry.Flush(2 * time.Second)
	if events := transport.Events(); len(events) != 0 {
		t.Fatalf("Sentry events=%d, want 0", len(events))
	}
	if !strings.Contains(logs, `level=INFO msg="`+operation+` canceled"`) {
		t.Fatalf("missing INFO %q canceled log: %s", operation, logs)
	}
	if strings.Contains(logs, "level=ERROR") {
		t.Fatal("cancellation logged at error level")
	}
}

func TestR51S01OpenCancellationDoesNotReport(t *testing.T) {
	for _, sentinel := range []error{context.Canceled, context.DeadlineExceeded} {
		t.Run(sentinel.Error(), func(t *testing.T) {
			transport := initMockSentry(t)
			fixture := newServerFixture(t)
			logs := r49S08CaptureLogs(fixture.application)
			sessions, tokens := r51S01Inventory(t, fixture)
			ctx := r49S08CanceledContext(t, context.Background(), sentinel)
			if _, err := fixture.userStore.OpenExistingUser(ctx, fixture.userID); !errors.Is(err, sentinel) {
				t.Fatalf("store=%v, want typed %v", err, sentinel)
			}
			response, request := r51S01RefreshRequest(t, fixture, fixture.refreshToken, ctx)
			fixture.handler.ServeHTTP(response, request)
			r51S01AssertCanceled(t, response, transport, fixture.application, logs.String(), "open user account for refresh")
			r51S01AssertIntactAndRetry(t, fixture, sessions, tokens)
		})
	}
}

func TestR51S01RotationCancellationDoesNotReport(t *testing.T) {
	for _, sentinel := range []error{context.Canceled, context.DeadlineExceeded} {
		t.Run(sentinel.Error(), func(t *testing.T) {
			transport := initMockSentry(t)
			fixture := newServerFixture(t)
			logs := r49S08CaptureLogs(fixture.application)
			sessions, tokens := r51S01Inventory(t, fixture)
			ctx := newR51S01Boundary(context.Background(), sentinel)
			response, request := r51S01RefreshRequest(t, fixture, fixture.refreshToken, ctx)
			fixture.handler.ServeHTTP(response, request)
			if !ctx.triggered {
				t.Fatal("rotation boundary not reached")
			}
			r51S01AssertCanceled(t, response, transport, fixture.application, logs.String(), "rotate refresh token")
			r51S01AssertIntactAndRetry(t, fixture, sessions, tokens)
		})
	}
}

func TestR51S01FinalizeWrapperStillCancels(t *testing.T) {
	cases := []struct {
		name      string
		operation string
		wrap      func(error) error
		serve     func(*Server, http.ResponseWriter, *http.Request, error)
	}{
		{"open/finalize", "open user account for refresh", func(err error) error { return fmt.Errorf("finalize open user account: %w", err) },
			func(app *Server, w http.ResponseWriter, r *http.Request, err error) {
				app.writeRefreshOpenError(w, r, err)
			}},
		{"rotation/finalize", "rotate refresh token", func(err error) error { return fmt.Errorf("finalize refresh rotation: %w", err) },
			func(app *Server, w http.ResponseWriter, r *http.Request, err error) {
				app.writeRefreshRotationError(w, r, "user", err)
			}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			transport := initMockSentry(t)
			fixture := newServerFixture(t)
			logs := r49S08CaptureLogs(fixture.application)
			wrapped := tc.wrap(context.Canceled)
			if !errors.Is(wrapped, context.Canceled) {
				t.Fatal("wrapper lost sentinel identity")
			}
			canceled, cancel := context.WithCancel(context.Background())
			cancel()
			request := httptest.NewRequest(http.MethodPost, "https://pomodorough.egigoka.me/api/v1/auth/refresh", nil)
			request.Pattern = "POST /api/v1/auth/refresh"
			request.Header.Set("Idempotency-Key", "r51-s01-wire-key")
			request = request.WithContext(canceled)
			response := httptest.NewRecorder()
			tc.serve(fixture.application, response, request, wrapped)
			r51S01AssertCanceled(t, response, transport, fixture.application, logs.String(), tc.operation)
		})
		t.Run(tc.name+"/route", func(t *testing.T) {
			r51S01FinalizeThroughRoute(t, tc.operation, tc.serve, tc.wrap)
		})
	}
}

func r51S01FinalizeThroughRoute(t *testing.T, operation string, serve func(*Server, http.ResponseWriter, *http.Request, error), wrap func(error) error) {
	t.Helper()
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	logs := r49S08CaptureLogs(fixture.application)
	wrapped := wrap(context.Canceled)
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	app := fixture.application
	mux := http.NewServeMux()
	mux.Handle("POST /api/v1/auth/refresh", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serve(app, w, r, wrapped)
	}))
	request := httptest.NewRequest(http.MethodPost, "https://pomodorough.egigoka.me/api/v1/auth/refresh", nil)
	request.Header.Set("Idempotency-Key", "r51-s01-wire-key")
	request = request.WithContext(canceled)
	response := httptest.NewRecorder()
	app.recoverMiddleware(app.loggingMiddleware(app.securityMiddleware(mux))).ServeHTTP(response, request)
	r51S01AssertCanceled(t, response, transport, app, logs.String(), operation)
}

func TestR51S01WrapperIdentityAndReuse(t *testing.T) {
	t.Run("wrapper-identity", func(t *testing.T) {
		live := context.Background()
		canceled, cancel := context.WithCancel(live)
		cancel()
		defer cancel()
		for _, err := range []error{context.Canceled, context.DeadlineExceeded, fmt.Errorf("open: %w", context.Canceled)} {
			if !isRequestCancellation(err, live) {
				t.Fatalf("isRequestCancellation(%v)=false, want true", err)
			}
		}
		if !isRequestCancellation(errors.New("store unavailable"), canceled) {
			t.Fatal("canceled context not detected")
		}
		for _, err := range []error{errors.New("store unavailable"), errors.New("read refresh: context canceled")} {
			if isRequestCancellation(err, live) {
				t.Fatalf("isRequestCancellation(%q)=true, want false", err.Error())
			}
		}
	})
	t.Run("reuse-still-401", func(t *testing.T) {
		transport := initMockSentry(t)
		fixture := newServerFixture(t)
		if got := postRefresh(t, fixture, fixture.refreshToken); got.Code != http.StatusOK {
			t.Fatalf("initial rotation=%d, want 200", got.Code)
		}
		reuse := postRefresh(t, fixture, fixture.refreshToken)
		if reuse.Code != http.StatusUnauthorized {
			t.Fatalf("reuse=%d, want 401", reuse.Code)
		}
		sentry.Flush(2 * time.Second)
		if events := transport.Events(); len(events) != 0 {
			t.Fatalf("reuse events=%d, want 0", len(events))
		}
		if got := fixture.application.metrics.canceledCount(http.MethodPost, "POST /api/v1/auth/refresh"); got != 0 {
			t.Fatalf("reuse canceled=%d, want 0", got)
		}
	})
}

func r51S01UnknownToken(t *testing.T, fixture serverFixture) string {
	t.Helper()
	token, _, err := authn.NewOpaqueToken(fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func r51S01AssertGenuine(t *testing.T, command, operation string) {
	t.Helper()
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	logs := r49S08CaptureLogs(fixture.application)
	r49S08DatabaseCommand(t, fixture, command)
	response := postRefresh(t, fixture, fixture.refreshToken)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d, want 500", response.Code)
	}
	if got := fixture.application.metrics.canceledCount(http.MethodPost, "POST /api/v1/auth/refresh"); got != 0 {
		t.Fatalf("canceled=%d, want 0", got)
	}
	sentry.Flush(2 * time.Second)
	events := transport.Events()
	if len(events) != 1 {
		t.Fatalf("events=%d, want 1", len(events))
	}
	if got := events[0].Tags["error.operation"]; got != operation {
		t.Fatalf("operation=%q, want %q", got, operation)
	}
	assertEventHasNoPII(t, events[0], []string{fixture.refreshToken, fixture.userID})
	if !strings.Contains(logs.String(), `level=ERROR msg="`+operation+`"`) {
		t.Error("missing ERROR log")
	}
}

func TestR51S01MalformedControlsStayUnauthorized(t *testing.T) {
	for _, tc := range []struct{ name, token string }{{"invalid-format", "invalid-client-input"}, {"unknown-token", ""}} {
		t.Run(tc.name, func(t *testing.T) {
			transport := initMockSentry(t)
			fixture := newServerFixture(t)
			token := tc.token
			if token == "" {
				token = r51S01UnknownToken(t, fixture)
			}
			response := postRefresh(t, fixture, token)
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("status=%d, want 401", response.Code)
			}
			sentry.Flush(2 * time.Second)
			if events := transport.Events(); len(events) != 0 {
				t.Fatalf("events=%d, want 0 for malformed", len(events))
			}
			if got := fixture.application.metrics.canceledCount(http.MethodPost, "POST /api/v1/auth/refresh"); got != 0 {
				t.Fatalf("canceled=%d, want 0", got)
			}
		})
	}
}

func TestR51S01GenuineOpenStillReports(t *testing.T) {
	r51S01AssertGenuine(t, `DROP TABLE account_metadata`, "open user account for refresh")
}

func TestR51S01GenuineRotationStillReports(t *testing.T) {
	r51S01AssertGenuine(t, `DROP TABLE auth_tokens`, "rotate refresh token")
}
