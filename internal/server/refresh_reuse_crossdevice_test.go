package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"pomodorough/internal/store"
)

func TestHTTPRefreshReuseCrossDeviceSessionSurvives(t *testing.T) {
	fixture := newServerFixture(t)
	fixture.application.streamKeepaliveInterval = time.Hour
	db, err := fixture.userStore.OpenExistingUser(t.Context(), fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	peerAccess, peerRefresh, peerSession, peerTokens, err := newNativeSession(fixture.userID, "device-0002", "ios", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.CreateSession(t.Context(), db, peerSession, peerTokens); err != nil {
		t.Fatal(err)
	}
	testServer := httptest.NewServer(fixture.handler)
	t.Cleanup(testServer.Close)
	revoked := openRefreshStream(t, testServer.URL, fixture.accessToken)
	survivor := openRefreshStream(t, testServer.URL, peerAccess)
	assertRefreshStreamCounts(t, fixture, 2)
	refreshOverHTTP(t, testServer.URL, fixture.refreshToken, http.StatusOK)
	refreshOverHTTP(t, testServer.URL, fixture.refreshToken, http.StatusUnauthorized)
	assertRefreshHTTPStatus(t, testServer.URL, "/api/v1/me", fixture.accessToken, http.StatusUnauthorized)
	assertRefreshHTTPStatus(t, testServer.URL, "/api/v1/me", peerAccess, http.StatusOK)
	fixture.application.hub.publish(fixture.userID, 1, 42)
	assertRefreshStreamEOF(t, revoked)
	if got := scanNextRevision(t, survivor); got != 42 {
		t.Fatalf("cross-device revision = %d, want 42", got)
	}
	assertRefreshStreamCounts(t, fixture, 1)
	peerRotated := refreshOverHTTP(t, testServer.URL, peerRefresh, http.StatusOK)
	assertRefreshHTTPStatus(t, testServer.URL, "/api/v1/me", peerRotated.accessToken, http.StatusOK)
}
