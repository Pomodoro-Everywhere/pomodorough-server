package server

import (
	"context"
	"net/http"
	"testing"

	"pomodorough/internal/authn"
)

func TestR48S03OriginalBearerReplayConfirmsAfterRestart(t *testing.T) {
	fixture := newServerFixture(t)
	dataDir := deletionFixtureDataDir(t, fixture)
	deleteWithBearer(t, fixture, fixture.accessToken, http.StatusNoContent)
	deleteWithBearer(t, fixture, fixture.accessToken, http.StatusNoContent)
	fixture = restartDeletionFixture(t, fixture, dataDir)
	deleteWithBearer(t, fixture, fixture.accessToken, http.StatusNoContent)
	if err := fixture.userStore.ValidateAccountGeneration(context.Background(), fixture.userID, 1); err == nil {
		t.Fatal("replayed deletion left the original generation live")
	}
}

func TestR48S03OriginalWebSessionCSRFReplayConfirmsAfterRestart(t *testing.T) {
	fixture := newServerFixture(t)
	dataDir := deletionFixtureDataDir(t, fixture)
	request, response := webDeletionRequest(t, fixture)
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("initial web deletion: %d %s", response.Code, response.Body.String())
	}
	fixture = restartDeletionFixture(t, fixture, dataDir)
	request, response = webDeletionRequest(t, fixture)
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("original CSRF replay after restart: %d %s", response.Code, response.Body.String())
	}
	request, response = webDeletionRequest(t, fixture)
	request.Header.Set("X-CSRF-Token", "wrong")
	request.Header.Set("Cookie", authn.WebSessionCookie+"="+fixture.webToken+"; "+authn.CSRFCookie+"=wrong")
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("wrong CSRF replay status=%d want=403", response.Code)
	}
}

func TestR48S03Definitive401WithoutReceiptNeverClears(t *testing.T) {
	fixture := newServerFixture(t)
	wrongToken, _, err := authn.NewOpaqueToken(fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	for _, token := range []string{wrongToken, fixture.refreshToken, "invalid", ""} {
		deleteWithBearer(t, fixture, token, http.StatusUnauthorized)
	}
	db, err := fixture.userStore.OpenExistingUser(context.Background(), fixture.userID)
	if err != nil {
		t.Fatalf("definitive 401 cleared the account: %v", err)
	}
	db.Close()
	if err := fixture.userStore.ValidateAccountGeneration(context.Background(), fixture.userID, 1); err != nil {
		t.Fatalf("definitive 401 changed generation: %v", err)
	}
}

func TestR48S03RecreatedAccountUnaffectedByStaleReceipt(t *testing.T) {
	fixture := newServerFixture(t)
	dataDir := deletionFixtureDataDir(t, fixture)
	deleteWithBearer(t, fixture, fixture.accessToken, http.StatusNoContent)
	createFreshFixtureAccount(t, fixture)
	deleteWithBearer(t, fixture, fixture.accessToken, http.StatusNoContent)
	assertFreshFixtureAccountUnchanged(t, fixture)
	fixture = restartDeletionFixture(t, fixture, dataDir)
	deleteWithBearer(t, fixture, fixture.accessToken, http.StatusNoContent)
	assertFreshFixtureAccountUnchanged(t, fixture)
}

func TestR48S03AppServesForDeletionReceiptToAllowRecovery(t *testing.T) {
	fixture := newServerFixture(t)
	request, response := webDeletionRequest(t, fixture)
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("initial web deletion: %d", response.Code)
	}
	app, appResponse := newJSONRequest(t, http.MethodGet, fixture.application.cfg.PublicURL+"/app", nil)
	addWebAuthentication(app, fixture)
	addValidCSRF(app, fixture)
	fixture.handler.ServeHTTP(appResponse, app)
	if appResponse.Code != http.StatusOK {
		t.Fatalf("receipt /app status=%d want=200 for recovery", appResponse.Code)
	}
	anonymous, anonymousResponse := newJSONRequest(t, http.MethodGet, fixture.application.cfg.PublicURL+"/app", nil)
	_ = anonymous
	fixture.handler.ServeHTTP(anonymousResponse, anonymous)
	if anonymousResponse.Code != http.StatusFound {
		t.Fatalf("anonymous /app status=%d want=302", anonymousResponse.Code)
	}
}
