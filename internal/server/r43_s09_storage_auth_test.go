package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"

	"pomodorough/internal/authn"
)

func r43S09DatabasePath(t *testing.T, fixture serverFixture) string {
	t.Helper()
	db, err := fixture.userStore.OpenExistingUser(context.Background(), fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var sequence int
	var name, path string
	if err := db.QueryRow(`PRAGMA database_list`).Scan(&sequence, &name, &path); err != nil {
		t.Fatal(err)
	}
	dataDir := filepath.Dir(filepath.Dir(path))
	return filepath.Join(dataDir, "users", fixture.userID+".sqlite")
}

func r43S09CorruptDatabase(t *testing.T, fixture serverFixture) {
	t.Helper()
	path := r43S09DatabasePath(t, fixture)
	if err := os.WriteFile(path, []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(path + "-wal")
	_ = os.Remove(path + "-shm")
	_ = os.Remove(path + "-journal")
}

func r43S09BreakAuthQuery(t *testing.T, fixture serverFixture) {
	t.Helper()
	db, err := fixture.userStore.OpenExistingUser(context.Background(), fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`DROP TABLE auth_tokens`); err != nil {
		t.Fatal(err)
	}
}

func r43S09MeResponse(fixture serverFixture, token string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/me", nil)
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	return response
}

func r43S09AssertInternal(t *testing.T, response *httptest.ResponseRecorder, events []*sentry.Event) {
	t.Helper()
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body=%s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "internal server error") {
		t.Fatalf("body = %q, want internal server error", response.Body.String())
	}
	if strings.Contains(response.Body.String(), "unauthorized") {
		t.Fatalf("body leaks unauthorized for internal failure: %q", response.Body.String())
	}
	sentry.Flush(2 * time.Second)
	if len(events) != 1 {
		t.Fatalf("events = %d, want exactly 1 bounded report", len(events))
	}
}

func TestR43S09InvalidCredentialsStayUnauthorized(t *testing.T) {
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	badToken, _, err := authn.NewOpaqueToken(fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	if response := r43S09MeResponse(fixture, badToken); response.Code != http.StatusUnauthorized {
		t.Fatalf("bad token status = %d, want 401; body=%s", response.Code, response.Body.String())
	}
	if response := postRefresh(t, fixture, badToken); response.Code != http.StatusUnauthorized {
		t.Fatalf("bad refresh status = %d, want 401; body=%s", response.Code, response.Body.String())
	}
	unknownID := authn.UserID([]byte("ssssssssssssssssssssssssssssssss"), googleIssuer, "unknown-subject")
	unknownToken, _, err := authn.NewOpaqueToken(unknownID)
	if err != nil {
		t.Fatal(err)
	}
	if response := r43S09MeResponse(fixture, unknownToken); response.Code != http.StatusUnauthorized {
		t.Fatalf("unknown user status = %d, want 401; body=%s", response.Code, response.Body.String())
	}
	sentry.Flush(2 * time.Second)
	if events := transport.Events(); len(events) != 0 {
		t.Fatalf("events = %d, want 0 for client-driven 401", len(events))
	}
}

func TestR43S09AuthenticateOpenFailureIsInternal(t *testing.T) {
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	r43S09CorruptDatabase(t, fixture)
	response := r43S09MeResponse(fixture, fixture.accessToken)
	r43S09AssertInternal(t, response, transport.Events())
	assertEventHasNoPII(t, transport.Events()[0], []string{fixture.accessToken, fixture.userID})
	second := r43S09MeResponse(fixture, fixture.accessToken)
	if second.Code != http.StatusInternalServerError {
		t.Fatalf("repeat status = %d, want 500", second.Code)
	}
	sentry.Flush(2 * time.Second)
	if events := transport.Events(); len(events) != 1 {
		t.Fatalf("events after burst = %d, want 1 bounded report", len(events))
	}
}

func TestR43S09AuthenticateQueryFailureIsInternal(t *testing.T) {
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	r43S09BreakAuthQuery(t, fixture)
	response := r43S09MeResponse(fixture, fixture.accessToken)
	r43S09AssertInternal(t, response, transport.Events())
	assertEventHasNoPII(t, transport.Events()[0], []string{fixture.accessToken, fixture.userID})
}

func TestR43S09RefreshOpenFailureIsInternal(t *testing.T) {
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	r43S09CorruptDatabase(t, fixture)
	response := postRefresh(t, fixture, fixture.refreshToken)
	r43S09AssertInternal(t, response, transport.Events())
	assertEventHasNoPII(t, transport.Events()[0], []string{fixture.refreshToken, fixture.userID})
}
