package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
)

func canceledMeRequest(fixture serverFixture) (*http.Request, context.CancelFunc) {
	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/me", nil)
	request.Header.Set("Authorization", "Bearer "+fixture.accessToken)
	canceled, cancel := context.WithCancel(request.Context())
	cancel()
	return request.WithContext(canceled), cancel
}

func assertCanceledWire(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", response.Code)
	}
	if body := response.Body.String(); !strings.Contains(body, "internal server error") {
		t.Fatalf("body = %q, want internal server error", body)
	}
}

func assertNoSentry(t *testing.T, transport *sentry.MockTransport) {
	t.Helper()
	sentry.Flush(2 * time.Second)
	if events := transport.Events(); len(events) != 0 {
		t.Fatalf("events = %d, want 0 for cancellation", len(events))
	}
}

func TestR48S05CanceledAuthenticationDoesNotReport(t *testing.T) {
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	request, cancel := canceledMeRequest(fixture)
	defer cancel()
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	assertCanceledWire(t, response)
	assertNoSentry(t, transport)
	if got := fixture.application.metrics.canceledCount(http.MethodGet, "GET /api/v1/me"); got != 1 {
		t.Fatalf("canceled count = %d, want 1", got)
	}
}

func TestR48S05DeadlineAuthenticationDoesNotReport(t *testing.T) {
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/me", nil)
	request.Header.Set("Authorization", "Bearer "+fixture.accessToken)
	expired, cancel := context.WithDeadline(request.Context(), time.Now().Add(-time.Second))
	defer cancel()
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request.WithContext(expired))
	assertCanceledWire(t, response)
	assertNoSentry(t, transport)
}

func TestR48S05CanceledStreamRevisionDoesNotReport(t *testing.T) {
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/stream", nil)
	request.Pattern = "GET /api/v1/stream"
	canceled, cancel := context.WithCancel(request.Context())
	cancel()
	defer cancel()
	response := httptest.NewRecorder()
	fixture.application.handleStream(response, request.WithContext(canceled), principal{
		UserID: fixture.userID, SessionID: "native-session", DeviceID: fixture.deviceID, Method: "bearer", Generation: 1,
	})
	assertCanceledWire(t, response)
	assertNoSentry(t, transport)
	if got := streamPermitCount(fixture.application, fixture.userID); got != 0 {
		t.Fatalf("stream permits = %d, want 0", got)
	}
	if got := hubSubscriberCount(fixture.application); got != 0 {
		t.Fatalf("subscribers = %d, want 0", got)
	}
	if got := fixture.application.metrics.canceledCount(http.MethodGet, "GET /api/v1/stream"); got != 1 {
		t.Fatalf("canceled count = %d, want 1", got)
	}
}

func TestR48S05GenuineAuthFailureStillReports(t *testing.T) {
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	r43S09CorruptDatabase(t, fixture)
	response := r43S09MeResponse(fixture, fixture.accessToken)
	r43S09AssertInternal(t, response, transport.Events())
	assertEventHasNoPII(t, transport.Events()[0], []string{fixture.accessToken, fixture.userID})
}

func TestR48S05GenuineStreamRevisionFailureStillReports(t *testing.T) {
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	dropTimerCommands(t, fixture)
	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/stream", nil)
	request.Pattern = "GET /api/v1/stream"
	response := httptest.NewRecorder()
	fixture.application.handleStream(response, request, principal{
		UserID: fixture.userID, SessionID: "native-session", DeviceID: fixture.deviceID, Method: "bearer", Generation: 1,
	})
	r43S09AssertInternal(t, response, transport.Events())
	if got := streamPermitCount(fixture.application, fixture.userID); got != 0 {
		t.Fatalf("stream permits = %d, want 0", got)
	}
	if got := hubSubscriberCount(fixture.application); got != 0 {
		t.Fatalf("subscribers = %d, want 0", got)
	}
}

func TestR48S05CancellationUsesTypedEvidenceOnly(t *testing.T) {
	live := context.Background()
	canceled, cancel := context.WithCancel(live)
	cancel()
	defer cancel()
	for _, failure := range []error{
		context.Canceled,
		context.DeadlineExceeded,
		fmt.Errorf("authenticate request: %w", context.Canceled),
		fmt.Errorf("read stream revision: %w", context.DeadlineExceeded),
	} {
		if !isRequestCancellation(failure, live) {
			t.Fatalf("isRequestCancellation(%v) = false, want true", failure)
		}
	}
	if !isRequestCancellation(errors.New("store unavailable"), canceled) {
		t.Fatal("isRequestCancellation with canceled context = false, want true")
	}
	for _, failure := range []error{
		errors.New("store unavailable"),
		errors.New("read timer commands: context canceled"),
		errors.New("shared core is closed"),
		errors.New(""),
	} {
		if isRequestCancellation(failure, live) {
			t.Fatalf("isRequestCancellation(%q) = true, want false", failure.Error())
		}
	}
	if isRequestCancellation(nil, live) {
		t.Fatal("isRequestCancellation(nil) = true, want false")
	}
}

func dropTimerCommands(t *testing.T, fixture serverFixture) {
	t.Helper()
	db, err := fixture.userStore.OpenExistingUser(context.Background(), fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`DROP TABLE timer_commands`); err != nil {
		t.Fatal(err)
	}
}
