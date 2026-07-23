package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pomodorough/internal/authn"
	"pomodorough/internal/config"
	"pomodorough/internal/store"
	"pomodorough/internal/task"
)

type serverFixture struct {
	application  *Server
	handler      http.Handler
	userStore    *store.Store
	userID       string
	webToken     string
	accessToken  string
	refreshToken string
	csrfToken    string
	deviceID     string
}

func newServerFixture(t *testing.T) serverFixture {
	t.Helper()
	userStore, err := store.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	webRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(webRoot, "openapi.yaml"), []byte("openapi: 3.0.3\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(webRoot, "index.html"), []byte("<!doctype html><title>Pomodorough landing</title>"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(webRoot, "app.html"), []byte("<!doctype html><title>Pomodorough application</title>"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		PublicURL:               "https://pomodorough.egigoka.me",
		WebRoot:                 webRoot,
		AppSecret:               []byte(strings.Repeat("s", 32)),
		GoogleNativeClientIDSet: map[string]struct{}{},
	}
	application, err := New(cfg, userStore, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}

	now := time.Now().UTC()
	userID := authn.UserID(cfg.AppSecret, googleIssuer, "test-subject")
	db, err := userStore.OpenUser(context.Background(), userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := store.UpsertProfile(context.Background(), db, store.Profile{
		ID: userID, Issuer: googleIssuer, Subject: "test-subject", Email: "user@example.com", Name: "Test User", AvatarURL: "https://example.com/avatar.png",
	}, now); err != nil {
		t.Fatal(err)
	}
	webToken, webHash, err := authn.NewOpaqueToken(userID)
	if err != nil {
		t.Fatal(err)
	}
	csrfToken := "csrf-token"
	csrfHash := authn.HashString(csrfToken)
	if err := store.CreateSession(context.Background(), db, store.Session{
		ID: "web-session", Kind: "web", Platform: "web", CSRFHash: csrfHash[:], CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}, []store.TokenRecord{{Hash: webHash, Kind: "web", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}}); err != nil {
		t.Fatal(err)
	}
	accessToken, accessHash, err := authn.NewOpaqueToken(userID)
	if err != nil {
		t.Fatal(err)
	}
	deviceID := "device-0001"
	refreshToken, refreshHash, err := authn.NewOpaqueToken(userID)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.CreateSession(context.Background(), db, store.Session{
		ID: "native-session", Kind: "native", DeviceID: deviceID, Platform: "ios", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}, []store.TokenRecord{
		{Hash: accessHash, Kind: "access", CreatedAt: now, ExpiresAt: now.Add(time.Hour)},
		{Hash: refreshHash, Kind: "refresh", CreatedAt: now, ExpiresAt: now.Add(time.Hour)},
	}); err != nil {
		t.Fatal(err)
	}

	return serverFixture{
		application: application, handler: application.Handler(), userStore: userStore, userID: userID, webToken: webToken,
		accessToken: accessToken, refreshToken: refreshToken, csrfToken: csrfToken, deviceID: deviceID,
	}
}

func int64Pointer(value int64) *int64 {
	return &value
}

func validSyncRequestJSON(now time.Time) syncRequestJSON {
	return syncRequestJSON{
		DeviceID: "device-0001", LastRevision: int64Pointer(0),
		Commands: []syncCommandJSON{{
			ID: "command-0001", DeviceSequence: int64Pointer(1), TimerID: "timer-000001", Type: "start", Phase: "focus",
			PlannedDurationMs: int64Pointer(25 * 60_000), OccurredAt: now.Format(time.RFC3339Nano), HLCWallMs: int64Pointer(now.UnixMilli()),
			HLCCounter: int64Pointer(0), ObservedElapsedMs: int64Pointer(0),
		}},
	}
}

func validTaskOperationJSON(now time.Time, title string) syncTaskOperationJSON {
	return syncTaskOperationJSON{
		ID: "task-operation-0001", TaskID: task.ID(title), Type: "upsert", Title: title,
		OccurredAt: now.Format(time.RFC3339Nano), HLCWallMs: int64Pointer(now.UnixMilli()), HLCCounter: int64Pointer(0),
	}
}

func validDurationOperationJSON(now time.Time, phase string, durationMs int64) syncDurationOperationJSON {
	return syncDurationOperationJSON{
		ID: "duration-operation-0001", Phase: phase, DurationMs: int64Pointer(durationMs),
		OccurredAt: now.Format(time.RFC3339Nano), HLCWallMs: int64Pointer(now.UnixMilli()), HLCCounter: int64Pointer(0),
	}
}

func newJSONRequest(t *testing.T, method, target string, payload any) (*http.Request, *httptest.ResponseRecorder) {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(method, target, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	return request, httptest.NewRecorder()
}

func postRefresh(t *testing.T, fixture serverFixture, token string) *httptest.ResponseRecorder {
	t.Helper()
	request, response := newJSONRequest(t, http.MethodPost, "https://pomodorough.egigoka.me/api/v1/auth/refresh", map[string]string{"refreshToken": token})
	fixture.handler.ServeHTTP(response, request)
	return response
}

func addWebAuthentication(request *http.Request, fixture serverFixture) {
	request.AddCookie(&http.Cookie{Name: authn.WebSessionCookie, Value: fixture.webToken})
}

func addValidCSRF(request *http.Request, fixture serverFixture) {
	request.Header.Set("Origin", "https://pomodorough.egigoka.me")
	request.Header.Set("X-CSRF-Token", fixture.csrfToken)
	request.AddCookie(&http.Cookie{Name: authn.CSRFCookie, Value: fixture.csrfToken})
}

func receiveRevision(t *testing.T, revisions <-chan int64, want int64) {
	t.Helper()
	select {
	case got := <-revisions:
		if got != want {
			t.Fatalf("revision = %d, want %d", got, want)
		}
	default:
		t.Fatalf("missing revision %d", want)
	}
}

func assertNoRevision(t *testing.T, revisions <-chan int64) {
	t.Helper()
	select {
	case got := <-revisions:
		t.Fatalf("unexpected revision %d", got)
	default:
	}
}
