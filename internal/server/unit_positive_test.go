package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestDecodeJSONAcceptsJSONMediaTypes(t *testing.T) {
	for _, contentType := range []string{"", "application/json", "application/json; charset=utf-8", "Application/JSON"} {
		t.Run(contentType, func(t *testing.T) {
			request := httptest.NewRequest("POST", "/", strings.NewReader(`{"name":"timer"}`))
			request.Header.Set("Content-Type", contentType)
			response := httptest.NewRecorder()
			var payload struct {
				Name string `json:"name"`
			}
			if err := decodeJSON(response, request, 1024, &payload); err != nil {
				t.Fatal(err)
			}
			if payload.Name != "timer" {
				t.Fatalf("decoded name = %q, want timer", payload.Name)
			}
		})
	}
}

func TestRevisionHubFansOutIsolatesAndCoalesces(t *testing.T) {
	hub := newRevisionHub()
	first, unsubscribeFirst := hub.subscribe("user-a")
	second, unsubscribeSecond := hub.subscribe("user-a")
	other, unsubscribeOther := hub.subscribe("user-b")
	t.Cleanup(unsubscribeFirst)
	t.Cleanup(unsubscribeSecond)
	t.Cleanup(unsubscribeOther)

	hub.publish("user-a", 1)
	receiveRevision(t, first, 1)
	receiveRevision(t, second, 1)
	assertNoRevision(t, other)

	hub.publish("user-a", 2)
	hub.publish("user-a", 3)
	receiveRevision(t, first, 3)
	receiveRevision(t, second, 3)
}

func TestRevisionHubNeverPublishesRegressingRevision(t *testing.T) {
	hub := newRevisionHub()
	revisions, unsubscribe := hub.subscribe("user-a")
	t.Cleanup(unsubscribe)

	hub.publish("user-a", 5)
	hub.publish("user-a", 4)
	receiveRevision(t, revisions, 5)
	assertNoRevision(t, revisions)

	hub.publish("user-a", 6)
	receiveRevision(t, revisions, 6)
}

func TestRevisionHubUnsubscribeKeepsOtherSubscribers(t *testing.T) {
	hub := newRevisionHub()
	removed, unsubscribeRemoved := hub.subscribe("user-a")
	remaining, unsubscribeRemaining := hub.subscribe("user-a")
	t.Cleanup(unsubscribeRemaining)

	unsubscribeRemoved()
	unsubscribeRemoved()
	hub.publish("user-a", 4)
	assertNoRevision(t, removed)
	receiveRevision(t, remaining, 4)
}

func TestSafeReturnPathAcceptsLocalPath(t *testing.T) {
	if got := safeReturnPath("/timer?view=today"); got != "/timer?view=today" {
		t.Fatalf("safe relative return path = %q", got)
	}
}

func TestParseSyncRequestAcceptsBoundaryValues(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 123_000_000, time.UTC)
	for _, duration := range []int64{int64(time.Minute / time.Millisecond), int64(4 * time.Hour / time.Millisecond)} {
		t.Run((time.Duration(duration) * time.Millisecond).String(), func(t *testing.T) {
			payload := validSyncRequestJSON(now)
			payload.Commands[0].PlannedDurationMs = int64Pointer(duration)
			payload.Commands[0].HLCWallMs = int64Pointer(now.Add(5 * time.Minute).UnixMilli())
			payload.Commands[0].HLCCounter = int64Pointer(0)
			payload.Commands[0].ObservedElapsedMs = int64Pointer(-1)
			request, response := newJSONRequest(t, http.MethodPost, "/api/v1/sync", payload)
			result, err := parseSyncRequest(response, request, now)
			if err != nil {
				t.Fatal(err)
			}
			if result.DeviceID != payload.DeviceID || result.LastRevision != 0 || len(result.Commands) != 1 {
				t.Fatalf("parsed sync request = %#v", result)
			}
			command := result.Commands[0]
			if command.PlannedDurationMs != duration || command.HLCWallMs != now.Add(5*time.Minute).UnixMilli() || command.HLCCounter != 0 || command.ObservedElapsedMs != -1 {
				t.Fatalf("parsed command = %#v", command)
			}
		})
	}
}

func TestParseSyncRequestNormalizesTaskOperationsAndAssociations(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	title := "\x00Cafe\u0301\x1f"
	payload := validSyncRequestJSON(now)
	payload.TaskOperations = []syncTaskOperationJSON{validTaskOperationJSON(now, title)}
	payload.Commands[0].TaskID = payload.TaskOperations[0].TaskID
	request, response := newJSONRequest(t, http.MethodPost, "/api/v1/sync", payload)
	result, err := parseSyncRequest(response, request, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.TaskOperations) != 1 || result.TaskOperations[0].Title != "Café" || result.Commands[0].TaskID != payload.TaskOperations[0].TaskID {
		t.Fatalf("parsed task sync = %#v", result)
	}
}

func TestParseSyncRequestAcceptsDurationOperationsAndOmission(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	payload := validSyncRequestJSON(now)
	request, response := newJSONRequest(t, http.MethodPost, "/api/v1/sync", payload)
	result, err := parseSyncRequest(response, request, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.DurationOperations) != 0 {
		t.Fatalf("omitted duration operations = %#v", result.DurationOperations)
	}

	payload.DurationOperations = []syncDurationOperationJSON{
		validDurationOperationJSON(now, "focus", 60_000),
		validDurationOperationJSON(now, "long_break", 10_800_000),
	}
	payload.DurationOperations[0].HLCWallMs = int64Pointer(0)
	payload.DurationOperations[0].HLCCounter = int64Pointer(0)
	payload.DurationOperations[1].ID = "duration-operation-0002"
	request, response = newJSONRequest(t, http.MethodPost, "/api/v1/sync", payload)
	result, err = parseSyncRequest(response, request, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.DurationOperations) != 2 || result.DurationOperations[0].DurationMs != 60_000 || result.DurationOperations[0].HLCWallMs != 0 || result.DurationOperations[1].DurationMs != 10_800_000 || result.DurationOperations[1].Phase != "long_break" {
		t.Fatalf("parsed duration operations = %#v", result.DurationOperations)
	}
}

func TestParseBootstrapResolutionAcceptsMaximumOperationHistory(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	payload := emptyBootstrapResolutionJSON("resolution-maximum-0001", "device-0001", 0, "merge")
	payload.DurationOperations = make([]syncDurationOperationJSON, 4096)
	for index := range payload.DurationOperations {
		operation := validDurationOperationJSON(now, "focus", 1_500_000)
		operation.ID = fmt.Sprintf("duration-operation-%04d", index)
		payload.DurationOperations[index] = operation
	}
	request, response := newJSONRequest(t, http.MethodPost, "/api/v1/bootstrap/resolve", payload)
	result, err := parseBootstrapResolutionRequest(response, request, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.DurationOperations) != 4096 || result.DurationOperations[4095].ID != "duration-operation-4095" {
		t.Fatalf("parsed bootstrap operation count=%d", len(result.DurationOperations))
	}
}

func TestValidPlatformAcceptsSupportedShape(t *testing.T) {
	for _, platform := range []string{"ios", "macOS-15", "web_2"} {
		if !validPlatform(platform) {
			t.Errorf("validPlatform(%q) = false", platform)
		}
	}
}
