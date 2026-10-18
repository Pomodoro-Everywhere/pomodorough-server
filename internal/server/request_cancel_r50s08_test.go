package server

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"

	"pomodorough/internal/authn"
)

func r50S08CookieIdentity(t *testing.T, fixture serverFixture) principal {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/me", nil)
	addWebAuthentication(request, fixture)
	identity, err := fixture.application.authenticate(request)
	if err != nil {
		t.Fatalf("authenticate cookie principal: %v", err)
	}
	if identity.Method != "cookie" {
		t.Fatalf("identity method = %q, want cookie", identity.Method)
	}
	return identity
}

func r50S08HelperRequest(sentinel error) (*http.Request, context.CancelFunc) {
	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/me", nil)
	request.Pattern = "GET /api/v1/me"
	request.Header.Set("Idempotency-Key", "r50-s08-wire-key")
	if sentinel == nil {
		return request, func() {}
	}
	var cancel context.CancelFunc
	var ctx context.Context
	if errors.Is(sentinel, context.DeadlineExceeded) {
		ctx, cancel = context.WithDeadline(request.Context(), time.Now().Add(-time.Second))
	} else {
		ctx, cancel = context.WithCancel(request.Context())
		cancel()
	}
	return request.WithContext(ctx), cancel
}

func r50S08SessionCSRFHash(t *testing.T, fixture serverFixture) []byte {
	t.Helper()
	db, err := fixture.userStore.OpenExistingUser(context.Background(), fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var hash []byte
	if err := db.QueryRow(`SELECT csrf_hash FROM auth_sessions WHERE id = 'web-session'`).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	return bytes.Clone(hash)
}

func r50S08AssertHelperWire(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	if response.Code != http.StatusInternalServerError || response.Body.String() != "{\"error\":\"internal server error\"}\n" {
		t.Errorf("status=%d body=%q, want 500 and exact internal-error JSON", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Idempotency-Key"); got != "r50-s08-wire-key" {
		t.Errorf("Idempotency-Key=%q, want echo of r50-s08-wire-key", got)
	}
	if cookies := response.Header().Values("Set-Cookie"); len(cookies) != 0 {
		t.Errorf("failed replacement minted cookies: %q", cookies)
	}
}

func TestR50S08CanceledCSRFReplacementDoesNotReport(t *testing.T) {
	for _, sentinel := range []error{context.Canceled, context.DeadlineExceeded} {
		t.Run(sentinel.Error(), func(t *testing.T) {
			transport := initMockSentry(t)
			fixture := newServerFixture(t)
			logs := r49S08CaptureLogs(fixture.application)
			identity := r50S08CookieIdentity(t, fixture)
			before := r50S08SessionCSRFHash(t, fixture)
			probe := authn.HashString("r50-s08-probe")
			request, cancel := r50S08HelperRequest(sentinel)
			defer cancel()
			if failure := fixture.userStore.UpdateCSRFForGeneration(request.Context(), identity.UserID, identity.Generation, identity.SessionID, probe); !errors.Is(failure, sentinel) {
				t.Fatalf("production store error=%v, want typed %v", failure, sentinel)
			}
			response := httptest.NewRecorder()
			token, ok := fixture.application.replaceCSRFToken(response, request, identity)
			if ok || token != "" {
				t.Fatalf("replace = (%q, %v), want (\"\", false)", token, ok)
			}
			r50S08AssertHelperWire(t, response)
			if got := fixture.application.metrics.canceledCount(http.MethodGet, "GET /api/v1/me"); got != 1 {
				t.Fatalf("canceled count = %d, want 1", got)
			}
			sentry.Flush(2 * time.Second)
			if events := transport.Events(); len(events) != 0 {
				t.Fatalf("Sentry events = %d, want 0 for cancellation", len(events))
			}
			if !strings.Contains(logs.String(), `level=INFO msg="replace CSRF token canceled"`) {
				t.Error("missing operation-specific cancellation info log")
			}
			if strings.Contains(logs.String(), "level=ERROR") {
				t.Error("cancellation logged at error level")
			}
			if after := r50S08SessionCSRFHash(t, fixture); !bytes.Equal(after, before) {
				t.Error("canceled replacement rotated the session CSRF hash")
			}
		})
	}
}

func TestR50S08GenuineCSRFReplacementFailureStillReports(t *testing.T) {
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	logs := r49S08CaptureLogs(fixture.application)
	identity := r50S08CookieIdentity(t, fixture)
	r49S08DatabaseCommand(t, fixture, `DROP TABLE auth_sessions`)
	probe := authn.HashString("r50-s08-genuine")
	request, cancel := r50S08HelperRequest(nil)
	defer cancel()
	failure := fixture.userStore.UpdateCSRFForGeneration(request.Context(), identity.UserID, identity.Generation, identity.SessionID, probe)
	r49S08AssertSQLiteFailure(t, request.Context(), failure, 1, "no such table")
	response := httptest.NewRecorder()
	token, ok := fixture.application.replaceCSRFToken(response, request, identity)
	if ok || token != "" {
		t.Fatalf("replace = (%q, %v), want (\"\", false)", token, ok)
	}
	r50S08AssertHelperWire(t, response)
	if got := fixture.application.metrics.canceledCount(http.MethodGet, "GET /api/v1/me"); got != 0 {
		t.Fatalf("canceled count = %d, want 0 for genuine failure", got)
	}
	sentry.Flush(2 * time.Second)
	events := transport.Events()
	if len(events) != 1 {
		t.Fatalf("Sentry events = %d, want 1 for genuine failure", len(events))
	}
	if got := events[0].Tags["error.operation"]; got != "replace CSRF token" {
		t.Errorf("Sentry error.operation=%q, want %q", got, "replace CSRF token")
	}
	assertEventHasNoPII(t, events[0], []string{fixture.userID, fixture.webToken, fixture.csrfToken})
	if !strings.Contains(logs.String(), `level=ERROR msg="replace CSRF token"`) {
		t.Error("missing operation-specific error log")
	}
	if strings.Contains(logs.String(), `msg="replace CSRF token canceled"`) {
		t.Error("genuine database failure logged as cancellation")
	}
}
