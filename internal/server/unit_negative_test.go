package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestDecodeJSONRejectsInvalidBodies(t *testing.T) {
	tests := []struct {
		name  string
		body  string
		limit int64
	}{
		{name: "empty", body: "", limit: 1024},
		{name: "malformed", body: `{`, limit: 1024},
		{name: "unknown field", body: `{"name":"timer","extra":true}`, limit: 1024},
		{name: "second value", body: `{"name":"timer"} {"name":"other"}`, limit: 1024},
		{name: "oversized", body: `{"name":"timer"}`, limit: 8},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest("POST", "/", strings.NewReader(test.body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			var payload struct {
				Name string `json:"name"`
			}
			if err := decodeJSON(response, request, test.limit, &payload); err == nil {
				t.Fatal("decodeJSON accepted invalid body")
			}
		})
	}
}

func TestDecodeJSONRejectsNonJSONMediaTypes(t *testing.T) {
	for _, contentType := range []string{"text/plain", "application/jsonp", "application/json-seq", "application/json; charset"} {
		t.Run(contentType, func(t *testing.T) {
			request := httptest.NewRequest("POST", "/", strings.NewReader(`{"name":"timer"}`))
			request.Header.Set("Content-Type", contentType)
			response := httptest.NewRecorder()
			var payload map[string]string
			if err := decodeJSON(response, request, 1024, &payload); err == nil {
				t.Fatalf("decodeJSON accepted Content-Type %q", contentType)
			}
		})
	}
}

func TestSafeReturnPathRejectsExternalAndBackslashPaths(t *testing.T) {
	for _, value := range []string{"https://example.com/", "//example.com/", `/\example.com/`, `/%5cexample.com/`} {
		if got := safeReturnPath(value); got != "/" {
			t.Errorf("safeReturnPath(%q) = %q, want /", value, got)
		}
	}
}

func TestParseSyncRequestRejectsInvalidFields(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	tests := []struct {
		name   string
		mutate func(*syncRequestJSON)
	}{
		{name: "invalid device ID", mutate: func(value *syncRequestJSON) { value.DeviceID = "short" }},
		{name: "missing last revision", mutate: func(value *syncRequestJSON) { value.LastRevision = nil }},
		{name: "negative last revision", mutate: func(value *syncRequestJSON) { value.LastRevision = int64Pointer(-1) }},
		{name: "missing commands", mutate: func(value *syncRequestJSON) { value.Commands = nil }},
		{name: "too many commands", mutate: func(value *syncRequestJSON) {
			command := value.Commands[0]
			value.Commands = make([]syncCommandJSON, 257)
			for index := range value.Commands {
				value.Commands[index] = command
			}
		}},
		{name: "invalid command ID", mutate: func(value *syncRequestJSON) { value.Commands[0].ID = "short" }},
		{name: "invalid timer ID", mutate: func(value *syncRequestJSON) { value.Commands[0].TimerID = "short" }},
		{name: "missing device sequence", mutate: func(value *syncRequestJSON) { value.Commands[0].DeviceSequence = nil }},
		{name: "zero device sequence", mutate: func(value *syncRequestJSON) { value.Commands[0].DeviceSequence = int64Pointer(0) }},
		{name: "invalid command type", mutate: func(value *syncRequestJSON) { value.Commands[0].Type = "stop" }},
		{name: "invalid task association", mutate: func(value *syncRequestJSON) { value.Commands[0].TaskID = "short" }},
		{name: "task association on non-start", mutate: func(value *syncRequestJSON) {
			value.Commands[0].TaskID = "task-0000001"
			value.Commands[0].Type = "pause"
		}},
		{name: "task association on break", mutate: func(value *syncRequestJSON) {
			value.Commands[0].TaskID = "task-0000001"
			value.Commands[0].Phase = "break"
		}},
		{name: "invalid phase", mutate: func(value *syncRequestJSON) { value.Commands[0].Phase = "lunch" }},
		{name: "missing duration", mutate: func(value *syncRequestJSON) { value.Commands[0].PlannedDurationMs = nil }},
		{name: "duration below minimum", mutate: func(value *syncRequestJSON) { value.Commands[0].PlannedDurationMs = int64Pointer(59_999) }},
		{name: "duration above maximum", mutate: func(value *syncRequestJSON) { value.Commands[0].PlannedDurationMs = int64Pointer(14_400_001) }},
		{name: "missing wall clock", mutate: func(value *syncRequestJSON) { value.Commands[0].HLCWallMs = nil }},
		{name: "zero wall clock", mutate: func(value *syncRequestJSON) { value.Commands[0].HLCWallMs = int64Pointer(0) }},
		{name: "future wall clock", mutate: func(value *syncRequestJSON) {
			value.Commands[0].HLCWallMs = int64Pointer(now.Add(5*time.Minute).UnixMilli() + 1)
		}},
		{name: "missing clock counter", mutate: func(value *syncRequestJSON) { value.Commands[0].HLCCounter = nil }},
		{name: "negative clock counter", mutate: func(value *syncRequestJSON) { value.Commands[0].HLCCounter = int64Pointer(-1) }},
		{name: "missing observed elapsed", mutate: func(value *syncRequestJSON) { value.Commands[0].ObservedElapsedMs = nil }},
		{name: "invalid occurrence time", mutate: func(value *syncRequestJSON) { value.Commands[0].OccurredAt = "yesterday" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload := validSyncRequestJSON(now)
			test.mutate(&payload)
			request, response := newJSONRequest(t, http.MethodPost, "/api/v1/sync", payload)
			if _, err := parseSyncRequest(response, request, now); err == nil {
				t.Fatal("parseSyncRequest accepted invalid payload")
			}
		})
	}
}

func TestParseSyncRequestRejectsInvalidTaskOperations(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	tests := []struct {
		name   string
		mutate func(*syncTaskOperationJSON)
	}{
		{name: "invalid operation ID", mutate: func(value *syncTaskOperationJSON) { value.ID = "short" }},
		{name: "invalid task ID", mutate: func(value *syncTaskOperationJSON) { value.TaskID = "short" }},
		{name: "invalid type", mutate: func(value *syncTaskOperationJSON) { value.Type = "rename" }},
		{name: "empty normalized title", mutate: func(value *syncTaskOperationJSON) { value.Title = "\x00\x1f" }},
		{name: "mismatched deterministic ID", mutate: func(value *syncTaskOperationJSON) { value.TaskID = "task-0000001" }},
		{name: "delete with title", mutate: func(value *syncTaskOperationJSON) { value.Type = "delete" }},
		{name: "missing wall clock", mutate: func(value *syncTaskOperationJSON) { value.HLCWallMs = nil }},
		{name: "future wall clock", mutate: func(value *syncTaskOperationJSON) {
			value.HLCWallMs = int64Pointer(now.Add(5*time.Minute).UnixMilli() + 1)
		}},
		{name: "missing counter", mutate: func(value *syncTaskOperationJSON) { value.HLCCounter = nil }},
		{name: "negative counter", mutate: func(value *syncTaskOperationJSON) { value.HLCCounter = int64Pointer(-1) }},
		{name: "invalid occurrence time", mutate: func(value *syncTaskOperationJSON) { value.OccurredAt = "yesterday" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload := validSyncRequestJSON(now)
			operation := validTaskOperationJSON(now, "Write tests")
			test.mutate(&operation)
			payload.TaskOperations = []syncTaskOperationJSON{operation}
			request, response := newJSONRequest(t, http.MethodPost, "/api/v1/sync", payload)
			if _, err := parseSyncRequest(response, request, now); err == nil {
				t.Fatal("parseSyncRequest accepted invalid task operation")
			}
		})
	}
}

func TestParseSyncRequestRejectsInvalidDurationOperations(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	tests := []struct {
		name   string
		mutate func(*syncDurationOperationJSON)
	}{
		{name: "invalid operation ID", mutate: func(value *syncDurationOperationJSON) { value.ID = "short" }},
		{name: "invalid phase", mutate: func(value *syncDurationOperationJSON) { value.Phase = "break" }},
		{name: "missing duration", mutate: func(value *syncDurationOperationJSON) { value.DurationMs = nil }},
		{name: "duration below minimum", mutate: func(value *syncDurationOperationJSON) { value.DurationMs = int64Pointer(59_999) }},
		{name: "duration above maximum", mutate: func(value *syncDurationOperationJSON) { value.DurationMs = int64Pointer(10_800_001) }},
		{name: "duration not whole minutes", mutate: func(value *syncDurationOperationJSON) { value.DurationMs = int64Pointer(60_001) }},
		{name: "missing wall clock", mutate: func(value *syncDurationOperationJSON) { value.HLCWallMs = nil }},
		{name: "negative wall clock", mutate: func(value *syncDurationOperationJSON) { value.HLCWallMs = int64Pointer(-1) }},
		{name: "future wall clock", mutate: func(value *syncDurationOperationJSON) {
			value.HLCWallMs = int64Pointer(now.Add(5*time.Minute).UnixMilli() + 1)
		}},
		{name: "missing counter", mutate: func(value *syncDurationOperationJSON) { value.HLCCounter = nil }},
		{name: "negative counter", mutate: func(value *syncDurationOperationJSON) { value.HLCCounter = int64Pointer(-1) }},
		{name: "invalid occurrence time", mutate: func(value *syncDurationOperationJSON) { value.OccurredAt = "yesterday" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload := validSyncRequestJSON(now)
			operation := validDurationOperationJSON(now, "focus", 1_500_000)
			test.mutate(&operation)
			payload.DurationOperations = []syncDurationOperationJSON{operation}
			request, response := newJSONRequest(t, http.MethodPost, "/api/v1/sync", payload)
			if _, err := parseSyncRequest(response, request, now); err == nil {
				t.Fatal("parseSyncRequest accepted invalid duration operation")
			}
		})
	}
}

func TestParseSyncRequestRejectsDuplicateDurationOperationIDs(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	payload := validSyncRequestJSON(now)
	operation := validDurationOperationJSON(now, "focus", 1_500_000)
	payload.DurationOperations = []syncDurationOperationJSON{operation, operation}
	request, response := newJSONRequest(t, http.MethodPost, "/api/v1/sync", payload)
	if _, err := parseSyncRequest(response, request, now); err == nil {
		t.Fatal("parseSyncRequest accepted duplicate duration operation IDs")
	}
}

func TestParseSyncRequestRejectsTooManyDurationOperations(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	payload := validSyncRequestJSON(now)
	payload.DurationOperations = make([]syncDurationOperationJSON, 257)
	for index := range payload.DurationOperations {
		payload.DurationOperations[index] = validDurationOperationJSON(now, "focus", 1_500_000)
	}
	request, response := newJSONRequest(t, http.MethodPost, "/api/v1/sync", payload)
	if _, err := parseSyncRequest(response, request, now); err == nil {
		t.Fatal("parseSyncRequest accepted too many duration operations")
	}
}

func TestValidPlatformRejectsInvalidShape(t *testing.T) {
	for _, platform := range []string{"", "i", "has space", strings.Repeat("x", 33)} {
		if validPlatform(platform) {
			t.Errorf("validPlatform(%q) = true", platform)
		}
	}
}
