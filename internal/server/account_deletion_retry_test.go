package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pomodorough/internal/authn"
	"pomodorough/internal/store"
)

func TestHTTPDeletionRetryAfterLostResponseRestartAndRecreation(t *testing.T) {
	fixture := newServerFixture(t)
	dataDir := deletionFixtureDataDir(t, fixture)
	deleteWithBearer(t, fixture, fixture.accessToken, http.StatusNoContent)
	deleteWithBearer(t, fixture, fixture.accessToken, http.StatusNoContent)
	fixture = restartDeletionFixture(t, fixture, dataDir)
	deleteWithBearer(t, fixture, fixture.accessToken, http.StatusNoContent)
	createFreshFixtureAccount(t, fixture)
	deleteWithBearer(t, fixture, fixture.accessToken, http.StatusNoContent)
	assertFreshFixtureAccountUnchanged(t, fixture)
	fixture = restartDeletionFixture(t, fixture, dataDir)
	deleteWithBearer(t, fixture, fixture.accessToken, http.StatusNoContent)
	assertFreshFixtureAccountUnchanged(t, fixture)
}

func TestHTTPDeletionRetryRejectsUncommittedCredentialsAndOtherEndpoints(t *testing.T) {
	fixture := newServerFixture(t)
	wrongToken, _, err := authn.NewOpaqueToken(fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	deleteWithBearer(t, fixture, fixture.accessToken, http.StatusNoContent)
	for _, token := range []string{wrongToken, fixture.refreshToken, fixture.webToken, "invalid", ""} {
		deleteWithBearer(t, fixture, token, http.StatusUnauthorized)
	}
	otherUser := strings.Repeat("f", 32) + fixture.accessToken[32:]
	deleteWithBearer(t, fixture, otherUser, http.StatusUnauthorized)
	request, response := webDeletionRequest(t, fixture)
	request.Header.Set("Cookie", authn.WebSessionCookie+"="+fixture.accessToken+"; "+authn.CSRFCookie+"="+fixture.csrfToken)
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("bearer receipt authorized cookie authentication: %d", response.Code)
	}
	for _, endpoint := range []struct{ method, path string }{
		{"GET", "/api/v1/me"}, {"GET", "/api/v1/bootstrap"}, {"GET", "/api/v1/history"},
		{"GET", "/api/v1/stream"}, {"POST", "/api/v1/sync"}, {"POST", "/api/v1/bootstrap/resolve"},
		{"POST", "/api/v1/auth/logout"}, {"POST", "/api/v1/auth/revoke-device"},
	} {
		request, response := newJSONRequest(t, endpoint.method, fixture.application.cfg.PublicURL+endpoint.path, nil)
		request.Header.Set("Authorization", "Bearer "+fixture.accessToken)
		fixture.handler.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("receipt authorized %s: %d", endpoint.path, response.Code)
		}
	}
}

func TestHTTPDeletionReceiptSurvivesExpiredRestoredCredentials(t *testing.T) {
	fixture := newServerFixture(t)
	dataDir := deletionFixtureDataDir(t, fixture)
	request, response := newJSONRequest(t, http.MethodDelete, fixture.application.cfg.PublicURL+"/api/v1/account", map[string]string{"confirmation": "DELETE"})
	request.Header.Set("Authorization", "Bearer "+fixture.accessToken)
	identity, err := fixture.application.authenticate(request)
	if err != nil {
		t.Fatal(err)
	}
	db, err := fixture.userStore.OpenExistingUser(context.Background(), fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`UPDATE auth_tokens SET expires_at_ms = 1; UPDATE auth_sessions SET expires_at_ms = 1`)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dataDir, "users", fixture.userID+".sqlite")
	backup, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	fixture.application.handleDeleteAccount(response, request, identity)
	if response.Code != http.StatusNoContent {
		t.Fatalf("authorized deletion: %d %s", response.Code, response.Body.String())
	}
	fixture = restartDeletionFixture(t, fixture, dataDir)
	deleteWithBearer(t, fixture, fixture.accessToken, http.StatusNoContent)
	if err := os.WriteFile(path, backup, 0o600); err != nil {
		t.Fatal(err)
	}
	fixture = restartDeletionFixture(t, fixture, dataDir)
	deleteWithBearer(t, fixture, fixture.accessToken, http.StatusNoContent)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("restored deleted generation exists: %v", err)
	}
}

func TestHTTPExpiredCredentialCannotStartDeletion(t *testing.T) {
	fixture := newServerFixture(t)
	db, err := fixture.userStore.OpenExistingUser(context.Background(), fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE auth_tokens SET expires_at_ms = 1`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	deleteWithBearer(t, fixture, fixture.accessToken, http.StatusUnauthorized)
	if err := fixture.userStore.ValidateAccountGeneration(context.Background(), fixture.userID, 1); err != nil {
		t.Fatalf("expired credential deleted live account: %v", err)
	}
}

func TestHTTPWebDeletionRetryRequiresOriginalMethodCSRFAndConfirmation(t *testing.T) {
	fixture := newServerFixture(t)
	dataDir := deletionFixtureDataDir(t, fixture)
	request, response := webDeletionRequest(t, fixture)
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("initial deletion: %d %s", response.Code, response.Body.String())
	}
	fixture = restartDeletionFixture(t, fixture, dataDir)
	for _, mutate := range []func(*http.Request){
		func(request *http.Request) { request.Header.Del("Origin") },
		func(request *http.Request) { request.Header.Set("Origin", "https://attacker.invalid") },
		func(request *http.Request) { request.Header.Del("X-CSRF-Token") },
		func(request *http.Request) { request.Header.Set("X-CSRF-Token", "wrong") },
		func(request *http.Request) { request.Header.Set("Cookie", authn.WebSessionCookie+"="+fixture.webToken) },
		func(request *http.Request) {
			request.Header.Set("Cookie", authn.WebSessionCookie+"="+fixture.webToken+"; "+authn.CSRFCookie+"=wrong")
			request.Header.Set("X-CSRF-Token", "wrong")
		},
	} {
		request, response := webDeletionRequest(t, fixture)
		mutate(request)
		fixture.handler.ServeHTTP(response, request)
		if response.Code != http.StatusForbidden {
			t.Fatalf("invalid replay CSRF: %d %s", response.Code, response.Body.String())
		}
	}
	deleteWithBearer(t, fixture, fixture.webToken, http.StatusUnauthorized)
	request, response = webDeletionRequest(t, fixture)
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent || !strings.Contains(response.Header().Get("Set-Cookie"), "Max-Age=0") {
		t.Fatalf("valid replay: %d cookies=%v", response.Code, response.Header().Values("Set-Cookie"))
	}
	request, response = newJSONRequest(t, http.MethodDelete, fixture.application.cfg.PublicURL+"/api/v1/account", map[string]string{"confirmation": "delete"})
	addWebAuthentication(request, fixture)
	addValidCSRF(request, fixture)
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid replay confirmation: %d", response.Code)
	}
}

func TestHTTPDeletionRetryWaitsForPurgeAndRejectsReceiptWriteFailure(t *testing.T) {
	fixture := newServerFixture(t)
	dataDir := deletionFixtureDataDir(t, fixture)
	ledgerDir := dataDir + "-deletion-ledger"
	if err := os.Chmod(ledgerDir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(ledgerDir, 0o700) })
	deleteWithBearer(t, fixture, fixture.accessToken, http.StatusInternalServerError)
	if err := os.Chmod(ledgerDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := fixture.userStore.ValidateAccountGeneration(context.Background(), fixture.userID, 1); err != nil {
		t.Fatalf("failed persistence removed account: %v", err)
	}
	deleteWithBearer(t, fixture, fixture.accessToken, http.StatusNoContent)
	sidecar := filepath.Join(dataDir, "users", fixture.userID+".sqlite-wal")
	if err := os.Mkdir(sidecar, 0o700); err != nil {
		t.Fatal(err)
	}
	blocker := filepath.Join(sidecar, "blocker")
	if err := os.WriteFile(blocker, []byte("pending purge"), 0o600); err != nil {
		t.Fatal(err)
	}
	fixture = restartDeletionFixture(t, fixture, dataDir)
	deleteWithBearer(t, fixture, fixture.accessToken, http.StatusInternalServerError)
	if err := os.Remove(blocker); err != nil {
		t.Fatal(err)
	}
	deleteWithBearer(t, fixture, fixture.accessToken, http.StatusNoContent)
	if _, err := os.Stat(sidecar); !os.IsNotExist(err) {
		t.Fatalf("receipt confirmed before purge: %v", err)
	}
}

func deleteWithBearer(t *testing.T, fixture serverFixture, token string, expected int) {
	t.Helper()
	request, response := newJSONRequest(t, http.MethodDelete, fixture.application.cfg.PublicURL+"/api/v1/account", map[string]string{"confirmation": "DELETE"})
	request.Header.Set("Authorization", "Bearer "+token)
	fixture.handler.ServeHTTP(response, request)
	if response.Code != expected {
		t.Fatalf("deletion status=%d want=%d body=%s", response.Code, expected, response.Body.String())
	}
}

func webDeletionRequest(t *testing.T, fixture serverFixture) (*http.Request, *httptest.ResponseRecorder) {
	t.Helper()
	request, response := newJSONRequest(t, http.MethodDelete, fixture.application.cfg.PublicURL+"/api/v1/account", map[string]string{"confirmation": "DELETE"})
	addWebAuthentication(request, fixture)
	addValidCSRF(request, fixture)
	return request, response
}

func deletionFixtureDataDir(t *testing.T, fixture serverFixture) string {
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
	return filepath.Dir(filepath.Dir(path))
}

func restartDeletionFixture(t *testing.T, fixture serverFixture, dataDir string) serverFixture {
	t.Helper()
	userStore, err := store.New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	application, err := New(fixture.application.cfg, userStore, fixture.application.logger)
	if err != nil {
		t.Fatal(err)
	}
	fixture.userStore, fixture.application, fixture.handler = userStore, application, application.Handler()
	return fixture
}
