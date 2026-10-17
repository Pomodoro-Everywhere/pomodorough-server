package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
	"modernc.org/sqlite"

	"pomodorough/internal/store"
)

type r49S08Mutation struct {
	name, path, operation, triggerTarget string
	serve                                func(*Server, http.ResponseWriter, *http.Request, principal)
}

func r49S08Mutations() []r49S08Mutation {
	return []r49S08Mutation{
		{"logout", "/api/v1/auth/logout", "revoke session", "UPDATE ON auth_tokens", (*Server).handleLogout},
		{"revoke-device", "/api/v1/auth/revoke-device", "revoke device", "UPDATE ON auth_tokens", (*Server).handleRevokeDevice},
		{"bootstrap-resolve", "/api/v1/bootstrap/resolve", "resolve bootstrap history", "INSERT ON bootstrap_resolutions", (*Server).handleBootstrapResolve},
	}
}

func (mutation r49S08Mutation) request(t *testing.T, fixture serverFixture, authentication string) *http.Request {
	t.Helper()
	payload := ""
	switch mutation.name {
	case "revoke-device":
		payload = fmt.Sprintf(`{"deviceId":%q}`, fixture.deviceID)
	case "bootstrap-resolve":
		payload = fmt.Sprintf(`{"requestId":"r49-s08-resolution","deviceId":%q,"expectedRevision":0,"strategy":"keep_remote","commands":[],"taskOperations":[],"durationOperations":[],"autoStartOperations":[],"selectedTaskOperations":[]}`, fixture.deviceID)
	}
	request := httptest.NewRequest(http.MethodPost, fixture.application.cfg.PublicURL+mutation.path, strings.NewReader(payload))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", "r49-s08-wire-key")
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

func (mutation r49S08Mutation) storeFailure(fixture serverFixture, ctx context.Context, identity principal) error {
	switch mutation.name {
	case "logout":
		return fixture.userStore.RevokeSessionForGeneration(ctx, identity.UserID, identity.Generation, identity.SessionID, time.Now())
	case "revoke-device":
		return fixture.userStore.RevokeDeviceForGeneration(ctx, identity.UserID, identity.Generation, fixture.deviceID, time.Now())
	default:
		_, err := fixture.userStore.ResolveBootstrapForGeneration(ctx, identity.UserID, identity.Generation, store.BootstrapResolutionRequest{
			RequestID: "r49-s08-resolution", DeviceID: fixture.deviceID, ExpectedRevision: 0, Strategy: store.BootstrapKeepRemote,
			AutoStartOperationsPresent: true, SelectedTaskOperationsPresent: true,
		}, time.Now())
		return err
	}
}

func r49S08Serve(t *testing.T, fixture serverFixture, mutation r49S08Mutation, authentication string, next authenticatedHandler) *httptest.ResponseRecorder {
	t.Helper()
	entered := 0
	continuation := func(w http.ResponseWriter, request *http.Request, identity principal) {
		entered++
		if identity.Method != authentication || request.Context().Err() != nil {
			t.Fatalf("post-auth identity=%q context=%v, want %q and live context", identity.Method, request.Context().Err(), authentication)
		}
		next(w, request, identity)
	}
	// Inject the failure only after real authentication and cookie CSRF validation.
	app := fixture.application
	mux := http.NewServeMux()
	mux.Handle("POST "+mutation.path, app.requireMutation(continuation))
	response := httptest.NewRecorder()
	app.recoverMiddleware(app.loggingMiddleware(app.securityMiddleware(mux))).ServeHTTP(response, mutation.request(t, fixture, authentication))
	if entered != 1 {
		t.Fatalf("post-auth calls=%d, want 1", entered)
	}
	return response
}

func r49S08CanceledContext(t *testing.T, parent context.Context, sentinel error) context.Context {
	t.Helper()
	var ctx context.Context
	var cancel context.CancelFunc
	switch sentinel {
	case context.Canceled:
		ctx, cancel = context.WithCancel(parent)
		cancel()
	case context.DeadlineExceeded:
		ctx, cancel = context.WithDeadline(parent, time.Now().Add(-time.Second))
	default:
		t.Fatalf("unsupported cancellation sentinel %v", sentinel)
	}
	t.Cleanup(cancel)
	if !errors.Is(ctx.Err(), sentinel) {
		t.Fatalf("context error=%v, want %v", ctx.Err(), sentinel)
	}
	return ctx
}

func r49S08DatabaseCommand(t *testing.T, fixture serverFixture, command string) {
	t.Helper()
	db, err := fixture.userStore.OpenExistingUser(context.Background(), fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(command); err != nil {
		t.Fatal(err)
	}
}

func r49S08AssertSQLiteFailure(t *testing.T, ctx context.Context, failure error, code int, message string) {
	t.Helper()
	var sqliteFailure *sqlite.Error
	if ctx.Err() != nil || failure == nil || errors.Is(failure, context.Canceled) || errors.Is(failure, context.DeadlineExceeded) {
		t.Fatalf("expected genuine live-context failure, context=%v store=%v", ctx.Err(), failure)
	}
	if !errors.As(failure, &sqliteFailure) || sqliteFailure.Code() != code {
		t.Fatalf("store failure=%v, want SQLite code %d", failure, code)
	}
	if !strings.Contains(failure.Error(), message) {
		t.Fatalf("store failure=%q, want text %q", failure, message)
	}
	t.Logf("live-context SQLite code=%d store error=%q", code, failure)
}

func r49S08AssertWire(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	if response.Code != http.StatusInternalServerError || response.Body.String() != "{\"error\":\"internal server error\"}\n" {
		t.Errorf("status=%d body=%q, want 500 and exact internal-error JSON", response.Code, response.Body.String())
	}
	for name, want := range map[string]string{
		"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Idempotency-Key": "r49-s08-wire-key",
	} {
		if got := response.Header().Values(name); !slices.Equal(got, []string{want}) {
			t.Errorf("%s=%q, want single value %q", name, got, want)
		}
	}
	if cookies := response.Header().Values("Set-Cookie"); len(cookies) != 0 {
		t.Errorf("failure changed cookies: %q", cookies)
	}
}

func r49S08AssertMetrics(t *testing.T, app *Server, mutation r49S08Mutation, requests, cancellations uint64) {
	t.Helper()
	var output bytes.Buffer
	if err := app.metrics.writePrometheus(&output); err != nil {
		t.Fatal(err)
	}
	var cancellationSamples, requestSamples []string
	for line := range strings.SplitSeq(output.String(), "\n") {
		if strings.HasPrefix(line, "pomodorough_http_cancellations_total{") {
			cancellationSamples = append(cancellationSamples, line)
		}
		if strings.HasPrefix(line, "pomodorough_http_requests_total{") {
			requestSamples = append(requestSamples, line)
		}
	}
	var wantCancellations []string
	if cancellations > 0 {
		wantCancellations = []string{fmt.Sprintf("pomodorough_http_cancellations_total{method=\"POST\",route=%q} %d", mutation.path, cancellations)}
	}
	if !slices.Equal(cancellationSamples, wantCancellations) {
		t.Errorf("cancellation samples=%q, want %q", cancellationSamples, wantCancellations)
	}
	wantRequests := []string{fmt.Sprintf("pomodorough_http_requests_total{method=\"POST\",route=%q,status=\"500\"} %d", mutation.path, requests)}
	if !slices.Equal(requestSamples, wantRequests) {
		t.Errorf("request samples=%q, want %q", requestSamples, wantRequests)
	}
}

func r49S08AssertUnchanged(t *testing.T, fixture serverFixture) {
	t.Helper()
	db, err := fixture.userStore.OpenExistingUser(context.Background(), fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for query, want := range map[string]int{
		"SELECT COUNT(*) FROM auth_sessions":                                 2,
		"SELECT COUNT(*) FROM auth_tokens":                                   3,
		"SELECT COUNT(*) FROM devices":                                       1,
		"SELECT COUNT(*) FROM auth_sessions WHERE revoked_at_ms IS NOT NULL": 0,
		"SELECT COUNT(*) FROM auth_tokens WHERE revoked_at_ms IS NOT NULL":   0,
		"SELECT COUNT(*) FROM devices WHERE revoked_at_ms IS NOT NULL":       0,
		"SELECT COUNT(*) FROM bootstrap_resolutions":                         0,
		"SELECT revision FROM account_state WHERE singleton = 1":             0,
	} {
		var got int
		if err := db.QueryRow(query).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Errorf("%s = %d, want %d", query, got, want)
		}
	}
}

func r49S08Events(t *testing.T, transport *sentry.MockTransport, want int) []*sentry.Event {
	t.Helper()
	if !sentry.Flush(2 * time.Second) {
		t.Fatal("Sentry flush timed out")
	}
	events := transport.Events()
	if len(events) != want {
		t.Errorf("Sentry events=%d, want %d", len(events), want)
	}
	return events
}

func r49S08CaptureLogs(app *Server) *bytes.Buffer {
	logs := &bytes.Buffer{}
	app.logger = slog.New(slog.NewTextHandler(logs, nil))
	return logs
}
