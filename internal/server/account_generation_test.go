package server

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"pomodorough/internal/store"
)

func TestAuthenticatedRequestsRejectRecreatedAccountGeneration(t *testing.T) {
	actions := []struct {
		name string
		run  func(*testing.T, serverFixture, principal) *httptest.ResponseRecorder
	}{
		{
			name: "profile read",
			run: func(t *testing.T, fixture serverFixture, identity principal) *httptest.ResponseRecorder {
				request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/me", nil)
				response := httptest.NewRecorder()
				fixture.application.handleMe(response, request, identity)
				return response
			},
		},
		{
			name: "bootstrap read",
			run: func(t *testing.T, fixture serverFixture, identity principal) *httptest.ResponseRecorder {
				request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/bootstrap", nil)
				response := httptest.NewRecorder()
				fixture.application.handleBootstrap(response, request, identity)
				return response
			},
		},
		{
			name: "history read",
			run: func(t *testing.T, fixture serverFixture, identity principal) *httptest.ResponseRecorder {
				request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/history", nil)
				response := httptest.NewRecorder()
				fixture.application.handleHistory(response, request, identity)
				return response
			},
		},
		{
			name: "revision stream",
			run: func(t *testing.T, fixture serverFixture, identity principal) *httptest.ResponseRecorder {
				request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/stream", nil)
				response := httptest.NewRecorder()
				fixture.application.handleStream(response, request, identity)
				return response
			},
		},
		{
			name: "sync",
			run: func(t *testing.T, fixture serverFixture, identity principal) *httptest.ResponseRecorder {
				request, response := newJSONRequest(t, http.MethodPost, "https://pomodorough.egigoka.me/api/v1/sync", validSyncRequestJSON(time.Now().UTC()))
				fixture.application.handleSync(response, request, identity)
				return response
			},
		},
		{
			name: "bootstrap resolution",
			run: func(t *testing.T, fixture serverFixture, identity principal) *httptest.ResponseRecorder {
				payload := emptyBootstrapResolutionJSON("generation-resolution-0001", fixture.deviceID, 0, store.BootstrapMerge)
				request, response := newJSONRequest(t, http.MethodPost, "https://pomodorough.egigoka.me/api/v1/bootstrap/resolve", payload)
				fixture.application.handleBootstrapResolve(response, request, identity)
				return response
			},
		},
		{
			name: "logout",
			run: func(t *testing.T, fixture serverFixture, identity principal) *httptest.ResponseRecorder {
				request := httptest.NewRequest(http.MethodPost, "https://pomodorough.egigoka.me/api/v1/auth/logout", nil)
				response := httptest.NewRecorder()
				fixture.application.handleLogout(response, request, identity)
				return response
			},
		},
		{
			name: "device revocation",
			run: func(t *testing.T, fixture serverFixture, identity principal) *httptest.ResponseRecorder {
				request, response := newJSONRequest(t, http.MethodPost, "https://pomodorough.egigoka.me/api/v1/auth/revoke-device", map[string]string{"deviceId": fixture.deviceID})
				fixture.application.handleRevokeDevice(response, request, identity)
				return response
			},
		},
		{
			name: "account deletion and recreation",
			run: func(t *testing.T, fixture serverFixture, identity principal) *httptest.ResponseRecorder {
				request, response := newJSONRequest(t, http.MethodDelete, "https://pomodorough.egigoka.me/api/v1/account", map[string]string{"confirmation": "DELETE"})
				fixture.application.handleDeleteAccount(response, request, identity)
				return response
			},
		},
	}

	for _, action := range actions {
		t.Run(action.name, func(t *testing.T) {
			fixture := newServerFixture(t)
			identity := authenticateFixturePrincipal(t, fixture)
			if identity.Generation != 1 {
				t.Fatalf("authenticated generation = %d, want 1", identity.Generation)
			}
			recreateFixtureAccount(t, fixture)

			response := action.run(t, fixture, identity)
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d body=%s, want 401", response.Code, response.Body.String())
			}
			assertFreshFixtureAccountUnchanged(t, fixture)
		})
	}
}

func TestLateOldGenerationSyncPublishCannotReachRecreatedAccountStream(t *testing.T) {
	fixture := newServerFixture(t)
	identity := authenticateFixturePrincipal(t, fixture)
	fresh, unsubscribeFresh := fixture.application.hub.subscribe(fixture.userID, 2)
	defer unsubscribeFresh()

	fixture.application.hub.mu.Lock()
	hubLocked := true
	defer func() {
		if hubLocked {
			fixture.application.hub.mu.Unlock()
		}
	}()

	request, recorder := newJSONRequest(t, http.MethodPost, "https://pomodorough.egigoka.me/api/v1/sync", validSyncRequestJSON(time.Now().UTC()))
	response := &responseWriteBarrier{ResponseRecorder: recorder, wrote: make(chan struct{})}
	done := make(chan struct{})
	go func() {
		fixture.application.handleSync(response, request, identity)
		close(done)
	}()
	waitForSignal(t, response.wrote, "sync response before revision publish")

	recreateFixtureAccount(t, fixture)
	fixture.application.hub.mu.Unlock()
	hubLocked = false
	waitForSignal(t, done, "sync handler after delayed revision publish")
	if recorder.Code != http.StatusOK {
		t.Fatalf("sync status = %d body=%s, want 200", recorder.Code, recorder.Body.String())
	}
	assertNoRevision(t, fresh)
	fixture.application.hub.publish(fixture.userID, 2, 1)
	receiveRevision(t, fresh, 1)
}

func TestLateOldGenerationAccountDisconnectCannotCloseRecreatedAccountStream(t *testing.T) {
	fixture := newServerFixture(t)
	identity := authenticateFixturePrincipal(t, fixture)
	old, unsubscribeOld := fixture.application.hub.subscribe(fixture.userID, 1)
	defer unsubscribeOld()
	fresh, unsubscribeFresh := fixture.application.hub.subscribe(fixture.userID, 2)
	defer unsubscribeFresh()

	fixture.application.hub.mu.Lock()
	hubLocked := true
	defer func() {
		if hubLocked {
			fixture.application.hub.mu.Unlock()
		}
	}()
	request, response := newJSONRequest(t, http.MethodDelete, "https://pomodorough.egigoka.me/api/v1/account", map[string]string{"confirmation": "DELETE"})
	done := make(chan struct{})
	go func() {
		fixture.application.handleDeleteAccount(response, request, identity)
		close(done)
	}()
	waitForFixtureAccountDeletion(t, fixture)
	createFreshFixtureAccount(t, fixture)

	fixture.application.hub.mu.Unlock()
	hubLocked = false
	waitForSignal(t, done, "account deletion handler after delayed disconnect")
	if response.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d body=%s, want 204", response.Code, response.Body.String())
	}
	assertRevisionStreamClosed(t, old)
	assertRevisionStreamOpen(t, fresh)
}

type responseWriteBarrier struct {
	*httptest.ResponseRecorder
	once  sync.Once
	wrote chan struct{}
}

func (w *responseWriteBarrier) WriteHeader(status int) {
	w.ResponseRecorder.WriteHeader(status)
	w.once.Do(func() { close(w.wrote) })
}

func (w *responseWriteBarrier) Write(body []byte) (int, error) {
	written, err := w.ResponseRecorder.Write(body)
	w.once.Do(func() { close(w.wrote) })
	return written, err
}

func waitForSignal(t *testing.T, signal <-chan struct{}, description string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(10 * time.Second):
		t.Fatalf("timed out waiting for %s", description)
	}
}

func waitForFixtureAccountDeletion(t *testing.T, fixture serverFixture) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		err := fixture.userStore.ValidateAccountGeneration(context.Background(), fixture.userID, 1)
		if errors.Is(err, store.ErrNotFound) {
			return
		}
		if err != nil {
			t.Fatalf("wait for account deletion: %v", err)
		}
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for account deletion")
		}
	}
}

func authenticateFixturePrincipal(t *testing.T, fixture serverFixture) principal {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/me", nil)
	request.Header.Set("Authorization", "Bearer "+fixture.accessToken)
	identity, err := fixture.application.authenticate(request)
	if err != nil {
		t.Fatalf("authenticate fixture principal: %v", err)
	}
	return identity
}

func recreateFixtureAccount(t *testing.T, fixture serverFixture) {
	t.Helper()
	ctx := context.Background()
	if err := fixture.userStore.DeleteUser(ctx, fixture.userID); err != nil {
		t.Fatalf("delete authenticated generation: %v", err)
	}
	createFreshFixtureAccount(t, fixture)
}

func createFreshFixtureAccount(t *testing.T, fixture serverFixture) {
	t.Helper()
	ctx := context.Background()
	db, err := fixture.userStore.OpenUser(ctx, fixture.userID)
	if err != nil {
		t.Fatalf("recreate account: %v", err)
	}
	defer db.Close()
	now := time.Now().UTC()
	if err := store.UpsertProfile(ctx, db, store.Profile{
		ID: fixture.userID, Issuer: googleIssuer, Subject: "fresh-subject", Email: "fresh@example.com", Name: "Fresh User",
	}, now); err != nil {
		t.Fatalf("create fresh profile: %v", err)
	}
	if err := store.CreateSession(ctx, db, store.Session{
		ID: "native-session", Kind: "native", DeviceID: fixture.deviceID, Platform: "ios", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}, nil); err != nil {
		t.Fatalf("create fresh session: %v", err)
	}
}

func assertFreshFixtureAccountUnchanged(t *testing.T, fixture serverFixture) {
	t.Helper()
	db, err := fixture.userStore.OpenExistingUser(context.Background(), fixture.userID)
	if err != nil {
		t.Fatalf("open fresh account after stale mutation: %v", err)
	}
	defer db.Close()

	var generation, revision, commandCount, resolutionCount int64
	if err := db.QueryRow(`SELECT generation FROM account_metadata WHERE singleton = 1`).Scan(&generation); err != nil {
		t.Fatalf("read fresh generation: %v", err)
	}
	if err := db.QueryRow(`SELECT revision FROM account_state WHERE singleton = 1`).Scan(&revision); err != nil {
		t.Fatalf("read fresh revision: %v", err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM timer_commands`).Scan(&commandCount); err != nil {
		t.Fatalf("count fresh commands: %v", err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM bootstrap_resolutions`).Scan(&resolutionCount); err != nil {
		t.Fatalf("count fresh bootstrap resolutions: %v", err)
	}
	var sessionRevoked, deviceRevoked sql.NullInt64
	if err := db.QueryRow(`SELECT revoked_at_ms FROM auth_sessions WHERE id = 'native-session'`).Scan(&sessionRevoked); err != nil {
		t.Fatalf("read fresh session: %v", err)
	}
	if err := db.QueryRow(`SELECT revoked_at_ms FROM devices WHERE id = ?`, fixture.deviceID).Scan(&deviceRevoked); err != nil {
		t.Fatalf("read fresh device: %v", err)
	}
	if generation != 2 || revision != 0 || commandCount != 0 || resolutionCount != 0 || sessionRevoked.Valid || deviceRevoked.Valid {
		t.Fatalf("fresh account mutated: generation=%d revision=%d commands=%d resolutions=%d sessionRevoked=%v deviceRevoked=%v",
			generation, revision, commandCount, resolutionCount, sessionRevoked.Valid, deviceRevoked.Valid)
	}
}
