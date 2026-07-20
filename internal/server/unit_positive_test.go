package server

import (
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

func TestValidPlatformAcceptsSupportedShape(t *testing.T) {
	for _, platform := range []string{"ios", "macOS-15", "web_2"} {
		if !validPlatform(platform) {
			t.Errorf("validPlatform(%q) = false", platform)
		}
	}
}
