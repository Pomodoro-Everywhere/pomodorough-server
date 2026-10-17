package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"pomodorough/internal/authn"
	"pomodorough/internal/store"
)

func TestHTTPRefreshReuseClosesOnlyRevokedSessionStreams(t *testing.T) {
	for _, generation := range []int64{1, 2} {
		t.Run(fmt.Sprintf("generation-%d", generation), func(t *testing.T) {
			fixture := refreshStreamFixture(t, generation)
			fixture.application.streamLimiter = newConcurrentLimiter(3)
			controlToken := createRefreshStreamControl(t, fixture)
			testServer := httptest.NewServer(fixture.handler)
			t.Cleanup(testServer.Close)
			first := openRefreshStream(t, testServer.URL, fixture.accessToken)
			second := openRefreshStream(t, testServer.URL, fixture.accessToken)
			control := openRefreshStream(t, testServer.URL, controlToken)
			assertRefreshStreamCounts(t, fixture, 3)
			assertRefreshHTTPStatus(t, testServer.URL, "/api/v1/stream", controlToken, http.StatusTooManyRequests)
			rotated := refreshOverHTTP(t, testServer.URL, fixture.refreshToken, http.StatusOK)
			assertRefreshStreamCounts(t, fixture, 3)
			fixture.application.hub.publish(fixture.userID, generation, 1)
			for _, scanner := range []*bufio.Scanner{first, second, control} {
				if got := scanNextRevision(t, scanner); got != 1 {
					t.Fatalf("rotation stream revision = %d, want 1", got)
				}
			}
			refreshOverHTTP(t, testServer.URL, fixture.refreshToken, http.StatusUnauthorized)
			for _, token := range []string{fixture.accessToken, rotated.accessToken} {
				assertRefreshHTTPStatus(t, testServer.URL, "/api/v1/me", token, http.StatusUnauthorized)
			}
			refreshOverHTTP(t, testServer.URL, rotated.refreshToken, http.StatusUnauthorized)
			fixture.application.hub.publish(fixture.userID, generation, 42)
			assertRefreshStreamEOF(t, first)
			assertRefreshStreamEOF(t, second)
			assertRefreshStreamCounts(t, fixture, 1)
			refreshOverHTTP(t, testServer.URL, fixture.refreshToken, http.StatusUnauthorized)
			assertRefreshStreamCounts(t, fixture, 1)
			if got := scanNextRevision(t, control); got != 42 {
				t.Fatalf("control revision = %d, want 42", got)
			}
			assertRefreshHTTPStatus(t, testServer.URL, "/api/v1/me", controlToken, http.StatusOK)
			openRefreshStream(t, testServer.URL, controlToken)
			openRefreshStream(t, testServer.URL, controlToken)
			assertRefreshStreamCounts(t, fixture, 3)
			assertRefreshHTTPStatus(t, testServer.URL, "/api/v1/stream", fixture.accessToken, http.StatusUnauthorized)
		})
	}
}

func TestHTTPRefreshRotationKeepsExistingStreamAndNewTokensValid(t *testing.T) {
	fixture := newServerFixture(t)
	fixture.application.streamKeepaliveInterval = time.Hour
	testServer := httptest.NewServer(fixture.handler)
	t.Cleanup(testServer.Close)
	stream := openRefreshStream(t, testServer.URL, fixture.accessToken)
	refresh := fixture.refreshToken
	for revision := int64(1); revision <= 2; revision++ {
		rotated := refreshOverHTTP(t, testServer.URL, refresh, http.StatusOK)
		if rotated.refreshToken == refresh || rotated.accessToken == fixture.accessToken {
			t.Fatal("rotation did not issue new tokens")
		}
		assertRefreshHTTPStatus(t, testServer.URL, "/api/v1/me", fixture.accessToken, http.StatusOK)
		assertRefreshHTTPStatus(t, testServer.URL, "/api/v1/me", rotated.accessToken, http.StatusOK)
		assertRefreshStreamCounts(t, fixture, 1)
		fixture.application.hub.publish(fixture.userID, 1, revision)
		if got := scanNextRevision(t, stream); got != revision {
			t.Fatalf("rotation stream revision = %d, want %d", got, revision)
		}
		refresh = rotated.refreshToken
	}
}

func TestHTTPInvalidRefreshDoesNotDisconnectStream(t *testing.T) {
	fixture := newServerFixture(t)
	fixture.application.streamKeepaliveInterval = time.Hour
	testServer := httptest.NewServer(fixture.handler)
	t.Cleanup(testServer.Close)
	stream := openRefreshStream(t, testServer.URL, fixture.accessToken)
	unknown, _, err := authn.NewOpaqueToken(fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	for index, token := range []string{"invalid", unknown, fixture.accessToken} {
		refreshOverHTTP(t, testServer.URL, token, http.StatusUnauthorized)
		assertRefreshStreamCounts(t, fixture, 1)
		fixture.application.hub.publish(fixture.userID, 1, int64(index+1))
		if got := scanNextRevision(t, stream); got != int64(index+1) {
			t.Fatalf("invalid refresh stream revision = %d", got)
		}
	}
}

func TestHTTPRefreshReuseWriteFailureKeepsStreamSubscribed(t *testing.T) {
	fixture := newServerFixture(t)
	fixture.application.streamKeepaliveInterval = time.Hour
	testServer := httptest.NewServer(fixture.handler)
	t.Cleanup(testServer.Close)
	stream := openRefreshStream(t, testServer.URL, fixture.accessToken)
	rotated := refreshOverHTTP(t, testServer.URL, fixture.refreshToken, http.StatusOK)
	db, err := fixture.userStore.OpenExistingUser(t.Context(), fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.ExecContext(t.Context(), `CREATE TRIGGER reject_reuse_family BEFORE UPDATE OF revoked_at_ms ON auth_tokens
		BEGIN SELECT RAISE(ABORT, 'family revoke denied'); END`); err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(map[string]string{"refreshToken": fixture.refreshToken})
	if err != nil {
		t.Fatal(err)
	}
	response := refreshHTTPRequest(t, http.MethodPost, testServer.URL+"/api/v1/auth/refresh", "", bytes.NewReader(body))
	defer response.Body.Close()
	if response.StatusCode != http.StatusInternalServerError {
		t.Fatalf("failed revocation status = %d, want 500", response.StatusCode)
	}
	assertRefreshHTTPStatus(t, testServer.URL, "/api/v1/me", rotated.accessToken, http.StatusOK)
	assertRefreshStreamCounts(t, fixture, 1)
	fixture.application.hub.publish(fixture.userID, 1, 1)
	if got := scanNextRevision(t, stream); got != 1 {
		t.Fatalf("failed revocation stream revision = %d, want 1", got)
	}
}

func TestRefreshReuseDisconnectUsesCommittedGeneration(t *testing.T) {
	fixture := newServerFixture(t)
	hub := fixture.application.hub
	old, unsubscribeOld := hub.subscribe(fixture.userID, 1, "same-session", "same-device")
	defer unsubscribeOld()
	fresh, unsubscribeFresh := hub.subscribe(fixture.userID, 2, "same-session", "same-device")
	defer unsubscribeFresh()
	otherSession, unsubscribeSession := hub.subscribe(fixture.userID, 1, "other-session", "same-device")
	defer unsubscribeSession()
	otherUser, unsubscribeUser := hub.subscribe("other-account", 1, "same-session", "same-device")
	defer unsubscribeUser()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/refresh", nil)
	response := httptest.NewRecorder()
	err := fmt.Errorf("rotation: %w", &store.RefreshReuseError{SessionID: "same-session", Generation: 1})
	fixture.application.writeRefreshRotationError(response, request, fixture.userID, err)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("reuse status = %d, want 401", response.Code)
	}
	assertRevisionStreamClosed(t, old)
	assertRevisionStreamOpen(t, fresh)
	assertRevisionStreamOpen(t, otherSession)
	assertRevisionStreamOpen(t, otherUser)
}

func refreshStreamFixture(t *testing.T, generation int64) serverFixture {
	t.Helper()
	fixture := newServerFixture(t)
	fixture.application.streamKeepaliveInterval = time.Hour
	if generation == 1 {
		return fixture
	}
	if err := fixture.userStore.DeleteUser(t.Context(), fixture.userID); err != nil {
		t.Fatal(err)
	}
	db, err := fixture.userStore.OpenUser(t.Context(), fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Now()
	if err := store.UpsertProfile(t.Context(), db, store.Profile{ID: fixture.userID}, now); err != nil {
		t.Fatal(err)
	}
	access, refresh, session, tokens, err := newNativeSession(fixture.userID, fixture.deviceID, "ios", now)
	if err != nil {
		t.Fatal(err)
	}
	session.ID = "native-session"
	if err := store.CreateSession(t.Context(), db, session, tokens); err != nil {
		t.Fatal(err)
	}
	fixture.accessToken, fixture.refreshToken = access, refresh
	return fixture
}

func createRefreshStreamControl(t *testing.T, fixture serverFixture) string {
	t.Helper()
	db, err := fixture.userStore.OpenExistingUser(t.Context(), fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	// A second session on the same device must survive family revocation.
	access, _, session, tokens, err := newNativeSession(fixture.userID, fixture.deviceID, "ios", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.CreateSession(t.Context(), db, session, tokens); err != nil {
		t.Fatal(err)
	}
	return access
}

func openRefreshStream(t *testing.T, url, token string) *bufio.Scanner {
	t.Helper()
	response := refreshHTTPRequest(t, http.MethodGet, url+"/api/v1/stream", token, nil)
	if response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("stream response = %d %q", response.StatusCode, response.Header.Get("Content-Type"))
	}
	scanner := bufio.NewScanner(response.Body)
	if got := scanNextRevision(t, scanner); got != 0 {
		t.Fatalf("initial revision = %d, want 0", got)
	}
	return scanner
}

type refreshStreamTokens struct {
	accessToken, refreshToken string
}

func refreshOverHTTP(t *testing.T, url, token string, wantStatus int) refreshStreamTokens {
	t.Helper()
	body, err := json.Marshal(map[string]string{"refreshToken": token})
	if err != nil {
		t.Fatal(err)
	}
	response := refreshHTTPRequest(t, http.MethodPost, url+"/api/v1/auth/refresh", "", bytes.NewReader(body))
	defer response.Body.Close()
	if response.StatusCode != wantStatus {
		t.Fatalf("refresh status = %d, want %d", response.StatusCode, wantStatus)
	}
	if wantStatus != http.StatusOK {
		var failure struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(response.Body).Decode(&failure); err != nil || failure.Error != "invalid refresh token" {
			t.Fatalf("refresh error changed: %q, %v", failure.Error, err)
		}
		return refreshStreamTokens{}
	}
	var tokens struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
	}
	if err := json.NewDecoder(response.Body).Decode(&tokens); err != nil {
		t.Fatal(err)
	}
	if tokens.AccessToken == "" || tokens.RefreshToken == "" {
		t.Fatal("refresh response omitted tokens")
	}
	return refreshStreamTokens{tokens.AccessToken, tokens.RefreshToken}
}

func refreshHTTPRequest(t *testing.T, method, url, token string, body io.Reader) *http.Response {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	t.Cleanup(cancel)
	request, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { response.Body.Close() })
	return response
}

func assertRefreshHTTPStatus(t *testing.T, url, path, token string, want int) {
	t.Helper()
	response := refreshHTTPRequest(t, http.MethodGet, url+path, token, nil)
	defer response.Body.Close()
	if response.StatusCode != want {
		t.Fatalf("%s status = %d, want %d", path, response.StatusCode, want)
	}
}

func assertRefreshStreamEOF(t *testing.T, scanner *bufio.Scanner) {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		for scanner.Scan() {
			if scanner.Text() != "" {
				done <- io.ErrUnexpectedEOF
				return
			}
		}
		done <- scanner.Err()
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("stream did not end with clean EOF: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("revoked session stream did not reach EOF")
	}
}

func assertRefreshStreamCounts(t *testing.T, fixture serverFixture, want int) {
	t.Helper()
	if got := hubSubscriberCount(fixture.application); got != want {
		t.Fatalf("stream subscribers = %d, want %d", got, want)
	}
	if got := streamPermitCount(fixture.application, fixture.userID); got != want {
		t.Fatalf("stream permits = %d, want %d", got, want)
	}
}
