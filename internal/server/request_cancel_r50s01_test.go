package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
)

// R50-S01: delete-account cancellation must not report a Sentry fault.
// handleDeleteAccount was the only authenticated mutation without the typed
// cancellation boundary; a client disconnect during DeleteUserWithReceipt
// returned 500 with one Sentry event and zero cancellation-metric increments.

func r50S01Request(t *testing.T, fixture serverFixture, authentication string) *http.Request {
	t.Helper()
	payload := `{"confirmation":"DELETE"}`
	request := httptest.NewRequest(http.MethodDelete, fixture.application.cfg.PublicURL+"/api/v1/account", strings.NewReader(payload))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", "r50-s01-wire-key")
	switch authentication {
	case "cookie":
		addWebAuthentication(request, fixture)
		addValidCSRF(request, fixture)
	case "bearer":
		request.Header.Set("Authorization", "Bearer "+fixture.accessToken)
	default:
		t.Fatalf("unsupported authentication %q", authentication)
	}
	return request
}

func r50S01Serve(t *testing.T, fixture serverFixture, authentication string, next authenticatedHandler) *httptest.ResponseRecorder {
	t.Helper()
	entered := 0
	continuation := func(w http.ResponseWriter, request *http.Request, identity principal) {
		entered++
		if identity.Method != authentication || request.Context().Err() != nil {
			t.Fatalf("post-auth identity=%q context=%v, want %q and live context", identity.Method, request.Context().Err(), authentication)
		}
		next(w, request, identity)
	}
	app := fixture.application
	mux := http.NewServeMux()
	mux.Handle("DELETE /api/v1/account", app.requireMutation(continuation))
	response := httptest.NewRecorder()
	app.recoverMiddleware(app.loggingMiddleware(app.securityMiddleware(mux))).ServeHTTP(response, r50S01Request(t, fixture, authentication))
	if entered != 1 {
		t.Fatalf("post-auth calls=%d, want 1", entered)
	}
	return response
}

func r50S01AssertWire(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	if response.Code != http.StatusInternalServerError || response.Body.String() != "{\"error\":\"internal server error\"}\n" {
		t.Errorf("status=%d body=%q, want 500 and exact internal-error JSON", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Idempotency-Key"); got != "r50-s01-wire-key" {
		t.Errorf("Idempotency-Key=%q, want echo of r50-s01-wire-key", got)
	}
	if cookies := response.Header().Values("Set-Cookie"); len(cookies) != 0 {
		t.Errorf("failed deletion minted cookies: %q", cookies)
	}
}

func r50S01AssertIntact(t *testing.T, fixture serverFixture) {
	t.Helper()
	if err := fixture.userStore.ValidateAccountGeneration(context.Background(), fixture.userID, 1); err != nil {
		t.Errorf("account generation invalid after canceled deletion: %v", err)
	}
	db, err := fixture.userStore.OpenExistingUser(context.Background(), fixture.userID)
	if err != nil {
		t.Errorf("canceled deletion removed account: %v", err)
		return
	}
	db.Close()
}

func TestR50S01CanceledDeletionDoesNotReport(t *testing.T) {
	for _, sentinel := range []error{context.Canceled, context.DeadlineExceeded} {
		for _, authentication := range []string{"bearer", "cookie"} {
			t.Run(authentication+"/"+sentinel.Error(), func(t *testing.T) {
				transport := initMockSentry(t)
				fixture := newServerFixture(t)
				logs := r49S08CaptureLogs(fixture.application)
				response := r50S01Serve(t, fixture, authentication, func(w http.ResponseWriter, request *http.Request, identity principal) {
					ctx := r49S08CanceledContext(t, request.Context(), sentinel)
					if failure := fixture.userStore.DeleteUserWithReceipt(ctx, identity.UserID, identity.Generation, identity.Credential, identity.CSRFHash); !errors.Is(failure, sentinel) {
						t.Fatalf("production store error=%v, want typed %v", failure, sentinel)
					}
					canceled := request.WithContext(ctx)
					canceled.Pattern = "DELETE /api/v1/account"
					fixture.application.handleDeleteAccount(w, canceled, identity)
				})
				r50S01AssertWire(t, response)
				if got := fixture.application.metrics.canceledCount(http.MethodDelete, "DELETE /api/v1/account"); got != 1 {
					t.Fatalf("canceled count = %d, want 1", got)
				}
				sentry.Flush(2 * time.Second)
				if events := transport.Events(); len(events) != 0 {
					t.Fatalf("Sentry events = %d, want 0 for cancellation", len(events))
				}
				if !strings.Contains(logs.String(), `level=INFO msg="delete account canceled"`) {
					t.Error("missing operation-specific cancellation info log")
				}
				if strings.Contains(logs.String(), "level=ERROR") {
					t.Error("cancellation logged at error level")
				}
				r50S01AssertIntact(t, fixture)
			})
		}
	}
}

func TestR50S01GenuineDeletionFailureStillReports(t *testing.T) {
	for _, authentication := range []string{"bearer", "cookie"} {
		t.Run(authentication, func(t *testing.T) {
			transport := initMockSentry(t)
			fixture := newServerFixture(t)
			logs := r49S08CaptureLogs(fixture.application)
			response := r50S01Serve(t, fixture, authentication, func(w http.ResponseWriter, request *http.Request, identity principal) {
				r49S08DatabaseCommand(t, fixture, `DROP TABLE account_metadata`)
				failure := fixture.userStore.DeleteUserWithReceipt(request.Context(), identity.UserID, identity.Generation, identity.Credential, identity.CSRFHash)
				r49S08AssertSQLiteFailure(t, request.Context(), failure, 1, "no such table")
				live := request
				live.Pattern = "DELETE /api/v1/account"
				fixture.application.handleDeleteAccount(w, live, identity)
			})
			r50S01AssertWire(t, response)
			if got := fixture.application.metrics.canceledCount(http.MethodDelete, "DELETE /api/v1/account"); got != 0 {
				t.Fatalf("canceled count = %d, want 0 for genuine failure", got)
			}
			sentry.Flush(2 * time.Second)
			events := transport.Events()
			if len(events) != 1 {
				t.Fatalf("Sentry events = %d, want 1 for genuine failure", len(events))
			}
			if got := events[0].Tags["error.operation"]; got != "delete account" {
				t.Errorf("Sentry error.operation=%q, want %q", got, "delete account")
			}
			assertEventHasNoPII(t, events[0], []string{fixture.userID, fixture.webToken, fixture.csrfToken})
			if !strings.Contains(logs.String(), `level=ERROR msg="delete account"`) {
				t.Error("missing operation-specific error log")
			}
			if strings.Contains(logs.String(), `msg="delete account canceled"`) {
				t.Error("genuine database failure logged as cancellation")
			}
		})
	}
}
