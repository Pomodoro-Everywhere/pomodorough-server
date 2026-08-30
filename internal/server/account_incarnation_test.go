package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"
	"time"
)

func p221Request(t *testing.T, fixture serverFixture, method, route string, body any, incarnation string) *httptest.ResponseRecorder {
	t.Helper()
	request, response := newJSONRequest(t, method, "https://review.invalid"+route, body)
	addWebAuthentication(request, fixture)
	addValidCSRF(request, fixture)
	if incarnation != "" {
		request.Header.Set("X-Pomodorough-Account-Incarnation", incarnation)
	}
	fixture.handler.ServeHTTP(response, request)
	return response
}

func p221Decode(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	return payload
}

func p221Profile(t *testing.T, fixture serverFixture) (string, string) {
	t.Helper()
	profile := p221Decode(t, p221Request(t, fixture, http.MethodGet, "/api/v1/me", nil, ""))["user"].(map[string]any)
	incarnation, _ := profile["accountIncarnation"].(string)
	if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(incarnation) {
		t.Fatalf("authenticated incarnation unavailable: %v", profile)
	}
	return profile["id"].(string), incarnation
}

func p221Populate(t *testing.T, fixture serverFixture) {
	t.Helper()
	for sequence := int64(1); sequence <= 20; sequence++ {
		operation := validTaskOperationJSON(time.Now().UTC().Truncate(time.Millisecond), fmt.Sprintf("Old task %d", sequence))
		operation.ID = fmt.Sprintf("old-operation-%04d", sequence)
		operation.HLCCounter = int64Pointer(sequence)
		payload := syncRequestJSON{DeviceID: fixture.deviceID, LastRevision: int64Pointer(sequence - 1),
			Commands: []syncCommandJSON{}, TaskOperations: []syncTaskOperationJSON{operation}}
		result := p221Decode(t, p221Request(t, fixture, http.MethodPost, "/api/v1/sync", payload, ""))
		if result["revision"] != float64(sequence) {
			t.Fatalf("revision=%v expected=%d", result["revision"], sequence)
		}
	}
}

func p221Recreate(t *testing.T, fixture serverFixture) serverFixture {
	t.Helper()
	deleted := p221Request(t, fixture, http.MethodDelete, "/api/v1/account", map[string]string{"confirmation": "DELETE"}, "")
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("delete=%d %s", deleted.Code, deleted.Body.String())
	}
	session, failure := fixture.application.persistWebAccount(context.Background(), googleIdentity{
		Issuer: googleIssuer, Subject: "test-subject", Email: "fixture@example.invalid", Name: "Fixture",
	})
	if failure != nil {
		t.Fatal(failure)
	}
	fixture.webToken, fixture.csrfToken = session.sessionToken, session.csrfToken
	return fixture
}

func TestP221RecreationChangesIncarnationNotPublicID(t *testing.T) {
	fixture := newServerFixture(t)
	publicID, oldIncarnation := p221Profile(t, fixture)
	p221Populate(t, fixture)
	_, stable := p221Profile(t, fixture)
	if stable != oldIncarnation {
		t.Fatal("ordinary revisions changed incarnation")
	}
	oldFixture := fixture
	fixture = p221Recreate(t, fixture)
	recreatedID, newIncarnation := p221Profile(t, fixture)
	if publicID != recreatedID || oldIncarnation == newIncarnation {
		t.Fatal("recreation did not isolate incarnation from public identity")
	}
	fresh := p221Decode(t, p221Request(t, fixture, http.MethodGet, "/api/v1/bootstrap", nil, newIncarnation))
	if fresh["revision"] != float64(0) || fresh["accountIncarnation"] != newIncarnation {
		t.Fatalf("unexpected fresh snapshot: %v", fresh)
	}
	if response := p221Request(t, oldFixture, http.MethodGet, "/api/v1/me", nil, ""); response.Code != http.StatusUnauthorized {
		t.Fatalf("old credential remained valid: %d", response.Code)
	}
	p221StaleCookieControls(t, fixture, oldIncarnation, newIncarnation)
	p221DuplicateAcknowledgement(t, fixture, newIncarnation)
}

func p221StaleCookieControls(t *testing.T, fixture serverFixture, oldIncarnation, newIncarnation string) {
	t.Helper()
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/api/v1/bootstrap"}, {http.MethodPost, "/api/v1/sync"},
		{http.MethodPost, "/api/v1/bootstrap/resolve"}, {http.MethodPost, "/api/v1/auth/logout"},
		{http.MethodDelete, "/api/v1/account"}, {http.MethodGet, "/api/v1/me"},
	} {
		t.Run("stale-cookie"+route.path, func(t *testing.T) {
			response := p221Request(t, fixture, route.method, route.path, map[string]string{"confirmation": "DELETE"}, oldIncarnation)
			if response.Code != http.StatusConflict {
				t.Fatalf("stale incarnation status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
	fresh := p221Decode(t, p221Request(t, fixture, http.MethodGet, "/api/v1/bootstrap", nil, newIncarnation))
	if fresh["revision"] != float64(0) {
		t.Fatal("stale cookie request mutated replacement account")
	}
}

func p221DuplicateAcknowledgement(t *testing.T, fixture serverFixture, incarnation string) {
	t.Helper()
	payload := validSyncRequestJSON(time.Now().UTC().Truncate(time.Millisecond))
	payload.LastRevision = int64Pointer(20)
	for _, outcome := range []string{"applied", "applied"} {
		response := p221Decode(t, p221Request(t, fixture, http.MethodPost, "/api/v1/sync", payload, incarnation))
		acknowledgement := response["acknowledgements"].([]any)[0].(map[string]any)
		if response["revision"] != float64(1) || response["accountIncarnation"] != incarnation || acknowledgement["outcome"] != outcome {
			t.Fatalf("unexpected %s response: %v", outcome, response)
		}
	}
}

func TestP221OptionalFenceRejectsMalformedAndPreservesNativeCompatibility(t *testing.T) {
	fixture := newServerFixture(t)
	_, incarnation := p221Profile(t, fixture)
	for _, values := range [][]string{{""}, {"legacy"}, {incarnation, incarnation}} {
		request, response := newJSONRequest(t, http.MethodGet, "https://review.invalid/api/v1/bootstrap", nil)
		request.Header.Set("Authorization", "Bearer "+fixture.accessToken)
		request.Header["X-Pomodorough-Account-Incarnation"] = values
		fixture.handler.ServeHTTP(response, request)
		if response.Code != http.StatusConflict {
			t.Fatalf("malformed fence %v status=%d", values, response.Code)
		}
	}
	request, response := newJSONRequest(t, http.MethodGet, "https://review.invalid/api/v1/bootstrap", nil)
	request.Header.Set("Authorization", "Bearer "+fixture.accessToken)
	fixture.handler.ServeHTTP(response, request)
	if p221Decode(t, response)["accountIncarnation"] != incarnation {
		t.Fatal("header omission changed native authentication")
	}
}
