package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func lookupDeletionReceipt(t *testing.T, fixture serverFixture, mutate func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	request, response := newJSONRequest(t, http.MethodPost, fixture.application.cfg.PublicURL+"/api/v1/account/deletion-receipt", nil)
	addWebAuthentication(request, fixture)
	addValidCSRF(request, fixture)
	if mutate != nil {
		mutate(request)
	}
	fixture.handler.ServeHTTP(response, request)
	return response
}

func TestR49S01ReceiptLookupNeverDeletesLiveAccount(t *testing.T) {
	fixture := newServerFixture(t)
	for range 3 {
		response := lookupDeletionReceipt(t, fixture, nil)
		if response.Code != http.StatusNotFound {
			t.Fatalf("live receipt lookup status=%d", response.Code)
		}
		if err := fixture.userStore.ValidateAccountGeneration(context.Background(), fixture.userID, 1); err != nil {
			t.Fatalf("read-only lookup changed live account: %v", err)
		}
	}
}

func TestR49S01LegacyReceiptLookupSurvivesRestartAndRecreation(t *testing.T) {
	fixture := newServerFixture(t)
	dataDir := deletionFixtureDataDir(t, fixture)
	request, response := webDeletionRequest(t, fixture)
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatal(response.Code)
	}
	fixture = restartDeletionFixture(t, fixture, dataDir)
	for range 2 {
		response = lookupDeletionReceipt(t, fixture, nil)
		if response.Code != http.StatusNoContent || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("receipt lookup status=%d headers=%v", response.Code, response.Header())
		}
	}
	createFreshFixtureAccount(t, fixture)
	if lookupDeletionReceipt(t, fixture, nil).Code != http.StatusNoContent {
		t.Fatal("old committed receipt was lost after recreation")
	}
	assertFreshFixtureAccountUnchanged(t, fixture)
}

func TestR49S01ReceiptLookupRejectsWrongCredentialCSRFAndIncarnation(t *testing.T) {
	fixture := newServerFixture(t)
	request, response := webDeletionRequest(t, fixture)
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatal(response.Code)
	}
	for _, control := range []struct {
		mutate func(*http.Request)
		status int
	}{
		{func(r *http.Request) { r.Header.Del("Cookie") }, 401},
		{func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+fixture.accessToken) }, 404},
		{func(r *http.Request) { r.Header.Del("Origin") }, 403},
		{func(r *http.Request) { r.Header.Set("X-CSRF-Token", "wrong") }, 403},
		{func(r *http.Request) { r.Header.Set(accountIncarnationHeader, "wrong") }, 409},
	} {
		if got := lookupDeletionReceipt(t, fixture, control.mutate).Code; got != control.status {
			t.Fatalf("lookup status=%d want=%d", got, control.status)
		}
	}
}

func TestR49S01ReceiptLookupWaitsForPurgeWithoutChangingEvidence(t *testing.T) {
	fixture := newServerFixture(t)
	dataDir := deletionFixtureDataDir(t, fixture)
	request, response := webDeletionRequest(t, fixture)
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatal(response.Code)
	}
	sidecar := filepath.Join(dataDir, "users", fixture.userID+".sqlite-wal")
	if err := os.WriteFile(sidecar, []byte("retained purge evidence"), 0o600); err != nil {
		t.Fatal(err)
	}
	response = lookupDeletionReceipt(t, fixture, nil)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("pending purge confirmed status=%d", response.Code)
	}
	if contents, err := os.ReadFile(sidecar); err != nil || string(contents) != "retained purge evidence" {
		t.Fatalf("lookup changed retained purge evidence: %q %v", contents, err)
	}
	if err := os.Remove(sidecar); err != nil {
		t.Fatal(err)
	}
	if lookupDeletionReceipt(t, fixture, nil).Code != http.StatusNoContent {
		t.Fatal("completed purge cannot be confirmed")
	}
}
