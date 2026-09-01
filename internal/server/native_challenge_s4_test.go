package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"pomodorough/internal/authn"
)

type nativeChallengeS4Response struct {
	Challenge string `json:"challenge"`
	Nonce     string `json:"nonce"`
	ExpiresAt string `json:"expiresAt"`
}

func TestS4NativeChallengeSequentialReplayRejectedAcrossDevices(t *testing.T) {
	fixture := newServerFixture(t)
	sign := configureNativeChallengeS4(t, &fixture)
	challenge := issueNativeChallengeS4(t, fixture.application)
	idToken := sign(testGoogleClaims("native-client", challenge.Nonce, time.Now().Add(time.Hour)))
	first := exchangeNativeChallengeS4(t, fixture.application, idToken, challenge.Challenge, "first-device")
	if first.Code != http.StatusOK {
		t.Fatalf("first exchange status=%d body=%s", first.Code, first.Body.String())
	}
	second := exchangeNativeChallengeS4(t, fixture.application, idToken, challenge.Challenge, "second-device")
	if second.Code != http.StatusUnauthorized || !hasAPIErrorS4(second, "invalid challenge") {
		t.Fatalf("replay status=%d body=%s", second.Code, second.Body.String())
	}
	assertNativeAccountS4Rows(t, fixture, "verified-subject", 1, 1)
}

func TestS4NativeChallengeFailedVerificationDoesNotConsume(t *testing.T) {
	fixture := newServerFixture(t)
	sign := configureNativeChallengeS4(t, &fixture)
	challenge := issueNativeChallengeS4(t, fixture.application)
	wrongNonce := sign(testGoogleClaims("native-client", "wrong-nonce", time.Now().Add(time.Hour)))
	rejected := exchangeNativeChallengeS4(t, fixture.application, wrongNonce, challenge.Challenge, "retry-device")
	if rejected.Code != http.StatusUnauthorized || !hasAPIErrorS4(rejected, "invalid Google token") {
		t.Fatalf("invalid token status=%d body=%s", rejected.Code, rejected.Body.String())
	}
	valid := sign(testGoogleClaims("native-client", challenge.Nonce, time.Now().Add(time.Hour)))
	retried := exchangeNativeChallengeS4(t, fixture.application, valid, challenge.Challenge, "retry-device")
	if retried.Code != http.StatusOK {
		t.Fatalf("retry status=%d body=%s", retried.Code, retried.Body.String())
	}
}

func TestS4NativeChallengeRejectsUnissuedSealedValue(t *testing.T) {
	fixture := newServerFixture(t)
	sign := configureNativeChallengeS4(t, &fixture)
	challenge := authn.NativeChallenge{Nonce: "unissued-nonce", ExpiresAt: time.Now().Add(time.Minute).Unix()}
	sealed, err := fixture.application.codec.Seal("native-challenge", challenge)
	if err != nil {
		t.Fatal(err)
	}
	idToken := sign(testGoogleClaims("native-client", challenge.Nonce, time.Now().Add(time.Hour)))
	response := exchangeNativeChallengeS4(t, fixture.application, idToken, sealed, "unissued-device")
	if response.Code != http.StatusUnauthorized || !hasAPIErrorS4(response, "invalid challenge") {
		t.Fatalf("unissued challenge status=%d body=%s", response.Code, response.Body.String())
	}
	assertNativeAccountS4Rows(t, fixture, "verified-subject", 0, 0)
}

func TestS4NativeChallengeConcurrentReplayAcrossAccounts(t *testing.T) {
	fixture := newServerFixture(t)
	sign := configureNativeChallengeS4(t, &fixture)
	challenge := issueNativeChallengeS4(t, fixture.application)
	subjects := []string{"s4-first-account", "s4-second-account"}
	responses := make(chan *httptest.ResponseRecorder, len(subjects))
	start := make(chan struct{})
	for index, subject := range subjects {
		claims := testGoogleClaims("native-client", challenge.Nonce, time.Now().Add(time.Hour))
		claims["sub"] = subject
		claims["email"] = subject + "@example.com"
		idToken := sign(claims)
		go func(deviceID string) {
			<-start
			responses <- exchangeNativeChallengeS4(t, fixture.application, idToken, challenge.Challenge, deviceID)
		}("concurrent-device-" + string(rune('1'+index)))
	}
	close(start)
	assertConcurrentNativeChallengeS4Responses(t, responses, len(subjects))
	assertNativeChallengeS4SessionTotal(t, fixture, subjects, 1)
}

func configureNativeChallengeS4(t *testing.T, fixture *serverFixture) func(map[string]any) string {
	t.Helper()
	fixture.application.cfg.GoogleNativeClientIDs = []string{"native-client"}
	fixture.application.cfg.GoogleNativeClientIDSet = map[string]struct{}{"native-client": {}}
	verifier, sign := testGoogleVerifier(t)
	fixture.application.nativeVerifier = verifier
	return sign
}

func issueNativeChallengeS4(t *testing.T, application *Server) nativeChallengeS4Response {
	t.Helper()
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/google/challenge", nil)
	application.handleNativeChallenge(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("challenge status=%d body=%s", response.Code, response.Body.String())
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw) != 3 || raw["challenge"] == nil || raw["nonce"] == nil || raw["expiresAt"] == nil {
		t.Fatalf("challenge wire keys = %v", raw)
	}
	var challenge nativeChallengeS4Response
	if err := json.Unmarshal(response.Body.Bytes(), &challenge); err != nil {
		t.Fatal(err)
	}
	return challenge
}

func exchangeNativeChallengeS4(t *testing.T, application *Server, idToken, challenge, deviceID string) *httptest.ResponseRecorder {
	t.Helper()
	request, response := newJSONRequest(t, http.MethodPost, "/api/v1/auth/google/exchange", map[string]string{
		"idToken": idToken, "challenge": challenge, "deviceId": deviceID, "platform": "ios",
	})
	application.handleNativeExchange(response, request)
	return response
}

func hasAPIErrorS4(response *httptest.ResponseRecorder, want string) bool {
	var payload struct {
		Error string `json:"error"`
	}
	return json.Unmarshal(response.Body.Bytes(), &payload) == nil && payload.Error == want
}

func assertNativeAccountS4Rows(t *testing.T, fixture serverFixture, subject string, sessions, devices int) {
	t.Helper()
	userID := authn.UserID(fixture.application.cfg.AppSecret, googleIssuer, subject)
	db, err := fixture.userStore.OpenExistingUser(context.Background(), userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for table, want := range map[string]int{"auth_sessions": sessions, "devices": devices} {
		var got int
		if err := db.QueryRowContext(context.Background(), "SELECT count(*) FROM "+table).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("%s count=%d, want %d", table, got, want)
		}
	}
}

func assertConcurrentNativeChallengeS4Responses(t *testing.T, responses <-chan *httptest.ResponseRecorder, count int) {
	t.Helper()
	succeeded, rejected := 0, 0
	for range count {
		response := <-responses
		switch response.Code {
		case http.StatusOK:
			succeeded++
		case http.StatusUnauthorized:
			rejected++
		default:
			t.Fatalf("concurrent status=%d body=%s", response.Code, response.Body.String())
		}
	}
	if succeeded != 1 || rejected != 1 {
		t.Fatalf("concurrent responses: succeeded=%d rejected=%d", succeeded, rejected)
	}
}

func assertNativeChallengeS4SessionTotal(t *testing.T, fixture serverFixture, subjects []string, want int) {
	t.Helper()
	total := 0
	for _, subject := range subjects {
		userID := authn.UserID(fixture.application.cfg.AppSecret, googleIssuer, subject)
		db, err := fixture.userStore.OpenExistingUser(context.Background(), userID)
		if err != nil {
			t.Fatal(err)
		}
		var count int
		if err := db.QueryRowContext(context.Background(), `SELECT count(*) FROM auth_sessions`).Scan(&count); err != nil {
			db.Close()
			t.Fatal(err)
		}
		total += count
		if err := db.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if total != want {
		t.Fatalf("session total=%d, want %d", total, want)
	}
}
