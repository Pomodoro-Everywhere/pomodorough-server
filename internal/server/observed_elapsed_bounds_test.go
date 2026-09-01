package server

import (
	"context"
	"net/http"
	"testing"
	"time"
)

type observedElapsedRequestCase struct {
	name        string
	path        string
	clientError string
	payload     func(*int64) any
	parse       func(http.ResponseWriter, *http.Request, time.Time) (int64, error)
}

type invalidObservedElapsedCase struct {
	name        string
	value       *int64
	parserError string
}

func TestObservedElapsedSafeIntegerBoundariesAcceptedBySyncAndBootstrap(t *testing.T) {
	now := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	for _, requestCase := range observedElapsedRequestCases(now) {
		for _, observedElapsedMs := range []int64{-maxSafeInteger, maxSafeInteger} {
			name := requestCase.name + "/" + elapsedBoundaryName(observedElapsedMs)
			t.Run(name, func(t *testing.T) {
				request, response := newJSONRequest(t, http.MethodPost, requestCase.path, requestCase.payload(&observedElapsedMs))
				parsed, err := requestCase.parse(response, request, now)
				if err != nil {
					t.Fatalf("boundary rejected: %v", err)
				}
				if parsed != observedElapsedMs {
					t.Fatalf("observedElapsedMs = %d, want %d", parsed, observedElapsedMs)
				}
			})
		}
	}
}

func TestObservedElapsedUnsafeIntegersAndNullRejectedBySyncAndBootstrap(t *testing.T) {
	now := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	for _, requestCase := range observedElapsedRequestCases(now) {
		for _, invalid := range invalidObservedElapsedCases() {
			t.Run(requestCase.name+"/"+invalid.name, func(t *testing.T) {
				request, response := newJSONRequest(t, http.MethodPost, requestCase.path, requestCase.payload(invalid.value))
				_, err := requestCase.parse(response, request, now)
				if err == nil || err.Error() != invalid.parserError {
					t.Fatalf("error = %v, want %q", err, invalid.parserError)
				}
			})
		}
	}
}

func TestHTTPRejectsUnsafeObservedElapsedBeforePersistence(t *testing.T) {
	now := time.Now().UTC()
	for _, requestCase := range observedElapsedRequestCases(now) {
		for _, invalid := range invalidObservedElapsedCases() {
			t.Run(requestCase.name+"/"+invalid.name, func(t *testing.T) {
				fixture := newServerFixture(t)
				response := postAuthenticatedJSON(t, fixture, requestCase.path, requestCase.payload(invalid.value))
				if response.Code != http.StatusBadRequest {
					t.Fatalf("status = %d, want %d; body=%s", response.Code, http.StatusBadRequest, response.Body.String())
				}
				wantBody := "{\"error\":\"" + requestCase.clientError + "\"}\n"
				if response.Body.String() != wantBody {
					t.Fatalf("body = %q, want %q", response.Body.String(), wantBody)
				}
				assertStoredCommandCount(t, fixture, 0)
			})
		}
	}
}

func TestOpenAPIObservedElapsedExposesSafeIntegerBounds(t *testing.T) {
	document := loadOpenAPIDocument(t)
	schemas := openAPIMap(t, openAPIMap(t, document, "components"), "schemas")
	command := openAPIMap(t, schemas, "TimerCommand")
	observed := openAPIMap(t, openAPIMap(t, command, "properties"), "observedElapsedMs")
	const safeInteger = 9_007_199_254_740_991
	if observed["minimum"] != -safeInteger || observed["maximum"] != safeInteger {
		t.Fatalf("observedElapsedMs bounds = [%#v, %#v]", observed["minimum"], observed["maximum"])
	}
}

func observedElapsedRequestCases(now time.Time) []observedElapsedRequestCase {
	return []observedElapsedRequestCase{
		{
			name: "sync", path: "/api/v1/sync", clientError: "invalid sync request",
			payload: func(value *int64) any {
				payload := validSyncRequestJSON(now)
				payload.Commands[0].ObservedElapsedMs = value
				return payload
			},
			parse: func(w http.ResponseWriter, r *http.Request, at time.Time) (int64, error) {
				parsed, err := parseSyncRequest(w, r, at)
				if err != nil {
					return 0, err
				}
				return parsed.Commands[0].ObservedElapsedMs, nil
			},
		},
		{
			name: "bootstrap", path: "/api/v1/bootstrap/resolve", clientError: "invalid bootstrap resolution request",
			payload: func(value *int64) any { return bootstrapObservedElapsedPayload(now, value) },
			parse: func(w http.ResponseWriter, r *http.Request, at time.Time) (int64, error) {
				parsed, err := parseBootstrapResolutionRequest(w, r, at)
				if err != nil {
					return 0, err
				}
				return parsed.Commands[0].ObservedElapsedMs, nil
			},
		},
	}
}

func invalidObservedElapsedCases() []invalidObservedElapsedCase {
	return []invalidObservedElapsedCase{
		{name: "below-minimum", value: int64Pointer(-maxSafeInteger - 1), parserError: "observed elapsed is outside the safe integer range"},
		{name: "above-maximum", value: int64Pointer(maxSafeInteger + 1), parserError: "observed elapsed is outside the safe integer range"},
		{name: "null", value: nil, parserError: "missing observed elapsed"},
	}
}

func bootstrapObservedElapsedPayload(now time.Time, value *int64) bootstrapResolutionRequestJSON {
	payload := emptyBootstrapResolutionJSON("resolution-observed-bounds", "device-0001", 0, "merge")
	command := validSyncRequestJSON(now).Commands[0]
	command.ObservedElapsedMs = value
	payload.Commands = []syncCommandJSON{command}
	return payload
}

func assertStoredCommandCount(t *testing.T, fixture serverFixture, want int) {
	t.Helper()
	database, err := fixture.userStore.OpenExistingUser(context.Background(), fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	var count int
	if err := database.QueryRow(`SELECT COUNT(*) FROM timer_commands`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != want {
		t.Fatalf("stored command count = %d, want %d", count, want)
	}
}

func elapsedBoundaryName(value int64) string {
	if value < 0 {
		return "minimum"
	}
	return "maximum"
}
