package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"pomodorough/internal/authn"
	"pomodorough/internal/timer"
)

func TestPublicRoutesAndSecurityHeaders(t *testing.T) {
	fixture := newServerFixture(t)
	tests := []struct {
		path        string
		contentType string
	}{
		{path: "/healthz", contentType: "application/json"},
		{path: "/openapi.yaml", contentType: "application/yaml"},
	}
	for _, test := range tests {
		request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me"+test.path, nil)
		response := httptest.NewRecorder()
		fixture.handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK || !strings.HasPrefix(response.Header().Get("Content-Type"), test.contentType) {
			t.Fatalf("GET %s: status=%d Content-Type=%q body=%s", test.path, response.Code, response.Header().Get("Content-Type"), response.Body.String())
		}
		for _, header := range []string{"Content-Security-Policy", "Strict-Transport-Security", "X-Content-Type-Options", "X-Frame-Options"} {
			if response.Header().Get(header) == "" {
				t.Errorf("GET %s missing %s", test.path, header)
			}
		}
	}
}

func TestCookieAuthenticationServesProfileAndApplication(t *testing.T) {
	fixture := newServerFixture(t)
	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/me", nil)
	addWebAuthentication(request, fixture)
	request.AddCookie(&http.Cookie{Name: authn.CSRFCookie, Value: fixture.csrfToken})
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/me status=%d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		User struct {
			ID    string `json:"id"`
			Email string `json:"email"`
		} `json:"user"`
		CSRFToken string `json:"csrfToken"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.User.ID != fixture.userID || payload.User.Email != "user@example.com" || payload.CSRFToken != fixture.csrfToken {
		t.Fatalf("profile response mismatch: %#v", payload)
	}

	request = httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/", nil)
	addWebAuthentication(request, fixture)
	response = httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "Pomodorough") {
		t.Fatalf("GET / status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestBearerSyncAndHistoryRoundTrip(t *testing.T) {
	fixture := newServerFixture(t)
	now := time.Now().UTC()
	payload := validSyncRequestJSON(now)
	payload.DeviceID = fixture.deviceID
	payload.Commands = append(payload.Commands, syncCommandJSON{
		ID: "command-0002", DeviceSequence: int64Pointer(2), TimerID: "timer-000001", Type: "cancel", Phase: "focus",
		PlannedDurationMs: int64Pointer(25 * 60_000), OccurredAt: now.Add(time.Second).Format(time.RFC3339Nano), HLCWallMs: int64Pointer(now.Add(time.Second).UnixMilli()),
		HLCCounter: int64Pointer(0), ObservedElapsedMs: int64Pointer(1_000),
	})
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "https://pomodorough.egigoka.me/api/v1/sync", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+fixture.accessToken)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("POST /api/v1/sync status=%d body=%s", response.Code, response.Body.String())
	}
	var syncResult struct {
		Revision         int64 `json:"revision"`
		Acknowledgements []struct {
			CommandID string `json:"commandId"`
			Outcome   string `json:"outcome"`
		} `json:"acknowledgements"`
	}
	if err := json.NewDecoder(response.Body).Decode(&syncResult); err != nil {
		t.Fatal(err)
	}
	if syncResult.Revision != 1 || len(syncResult.Acknowledgements) != 2 || syncResult.Acknowledgements[0].CommandID != "command-0001" || syncResult.Acknowledgements[1].Outcome != "applied" {
		t.Fatalf("sync response mismatch: %#v", syncResult)
	}

	request = httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/history", nil)
	request.Header.Set("Authorization", "Bearer "+fixture.accessToken)
	response = httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/history status=%d body=%s", response.Code, response.Body.String())
	}
	var history struct {
		Items []timer.HistoryItem `json:"history"`
	}
	if err := json.NewDecoder(response.Body).Decode(&history); err != nil {
		t.Fatal(err)
	}
	if len(history.Items) != 1 || history.Items[0].Status != "cancelled" || history.Items[0].CommandID != "command-0002" {
		t.Fatalf("history response mismatch: %#v", history.Items)
	}
}

func TestCookieLogoutWithValidCSRF(t *testing.T) {
	fixture := newServerFixture(t)
	request := httptest.NewRequest(http.MethodPost, "https://pomodorough.egigoka.me/api/v1/auth/logout", nil)
	addWebAuthentication(request, fixture)
	addValidCSRF(request, fixture)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("POST /api/v1/auth/logout status=%d body=%s", response.Code, response.Body.String())
	}
	if len(response.Result().Cookies()) < 2 {
		t.Fatalf("logout did not clear session cookies: %#v", response.Result().Cookies())
	}
}

func TestMeReplacesMissingCSRFToken(t *testing.T) {
	fixture := newServerFixture(t)
	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/me", nil)
	addWebAuthentication(request, fixture)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/me status=%d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		CSRFToken string `json:"csrfToken"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.CSRFToken == "" || payload.CSRFToken == fixture.csrfToken {
		t.Fatalf("replacement CSRF token = %q", payload.CSRFToken)
	}

	request = httptest.NewRequest(http.MethodPost, "https://pomodorough.egigoka.me/api/v1/auth/logout", nil)
	addWebAuthentication(request, fixture)
	request.Header.Set("Origin", "https://pomodorough.egigoka.me")
	request.Header.Set("X-CSRF-Token", payload.CSRFToken)
	request.AddCookie(&http.Cookie{Name: authn.CSRFCookie, Value: payload.CSRFToken})
	response = httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("logout with replacement CSRF status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestRefreshRotatesNativeTokens(t *testing.T) {
	fixture := newServerFixture(t)
	response := postRefresh(t, fixture, fixture.refreshToken)
	if response.Code != http.StatusOK {
		t.Fatalf("POST /api/v1/auth/refresh status=%d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.AccessToken == "" || payload.RefreshToken == "" || payload.AccessToken == fixture.accessToken || payload.RefreshToken == fixture.refreshToken {
		t.Fatalf("refresh response did not rotate tokens: %#v", payload)
	}
	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/history", nil)
	request.Header.Set("Authorization", "Bearer "+payload.AccessToken)
	response = httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("rotated access token status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestRevokeDeviceInvalidatesNativeSession(t *testing.T) {
	fixture := newServerFixture(t)
	request, response := newJSONRequest(t, http.MethodPost, "https://pomodorough.egigoka.me/api/v1/auth/revoke-device", map[string]string{"deviceId": fixture.deviceID})
	addWebAuthentication(request, fixture)
	addValidCSRF(request, fixture)
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("POST /api/v1/auth/revoke-device status=%d body=%s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/history", nil)
	request.Header.Set("Authorization", "Bearer "+fixture.accessToken)
	response = httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("revoked device access status=%d, want 401", response.Code)
	}
}
