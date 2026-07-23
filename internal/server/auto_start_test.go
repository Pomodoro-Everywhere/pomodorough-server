package server

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"pomodorough/internal/store"
)

func boolPointer(value bool) *bool {
	return &value
}

func validAutoStartOperationJSON(now time.Time, enabled bool) syncAutoStartOperationJSON {
	return syncAutoStartOperationJSON{
		ID: "auto-start-operation-0001", Enabled: boolPointer(enabled), OccurredAt: now.Format(time.RFC3339Nano),
		HLCWallMs: int64Pointer(now.UnixMilli()), HLCCounter: int64Pointer(0),
	}
}

func autoStartOperationsRaw(t *testing.T, operations []syncAutoStartOperationJSON) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(operations)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestParseSyncAutoStartOmissionBoundaryAndLimit(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	payload := validSyncRequestJSON(now)
	payload.Commands = []syncCommandJSON{}
	request, response := newJSONRequest(t, http.MethodPost, "/api/v1/sync", payload)
	result, err := parseSyncRequest(response, request, now)
	if err != nil {
		t.Fatal(err)
	}
	if result.AutoStartOperations == nil || len(result.AutoStartOperations) != 0 {
		t.Fatalf("omitted auto-start operations = %#v", result.AutoStartOperations)
	}

	payload.AutoStartOperations = make([]syncAutoStartOperationJSON, 256)
	for index := range payload.AutoStartOperations {
		operation := validAutoStartOperationJSON(now, index%2 == 0)
		operation.ID = fmt.Sprintf("auto-start-operation-%04d", index)
		payload.AutoStartOperations[index] = operation
	}
	request, response = newJSONRequest(t, http.MethodPost, "/api/v1/sync", payload)
	result, err = parseSyncRequest(response, request, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.AutoStartOperations) != 256 || result.AutoStartOperations[255].ID != "auto-start-operation-0255" || result.AutoStartOperations[255].Enabled {
		t.Fatalf("parsed auto-start boundary = %#v", result.AutoStartOperations[255])
	}

	payload.AutoStartOperations = append(payload.AutoStartOperations, validAutoStartOperationJSON(now, true))
	payload.AutoStartOperations[256].ID = "auto-start-operation-0256"
	request, response = newJSONRequest(t, http.MethodPost, "/api/v1/sync", payload)
	if _, err := parseSyncRequest(response, request, now); err == nil {
		t.Fatal("parseSyncRequest accepted 257 auto-start operations")
	}
}

func TestParseLegacyAutoStartClockRemainsValidWithFutureClientTime(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	payload := validSyncRequestJSON(now)
	payload.Commands = []syncCommandJSON{}
	operation := validAutoStartOperationJSON(now, true)
	operation.ID = "auto-start-legacy-clock"
	operation.OccurredAt = time.Unix(0, 0).UTC().Format(time.RFC3339Nano)
	operation.HLCWallMs = int64Pointer(0)
	payload.AutoStartOperations = []syncAutoStartOperationJSON{operation}
	request, response := newJSONRequest(t, http.MethodPost, "/api/v1/sync", payload)
	parsed, err := parseSyncRequest(response, request, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.AutoStartOperations) != 1 || parsed.AutoStartOperations[0].HLCWallMs != 0 {
		t.Fatalf("legacy clock operation = %#v", parsed.AutoStartOperations)
	}
}

func TestParseBootstrapAutoStartDetectsOmittedEmptyAndLimits(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	payload := emptyBootstrapResolutionJSON("resolution-auto-omitted", "device-0001", 0, store.BootstrapReplaceRemote)
	request, response := newJSONRequest(t, http.MethodPost, "/api/v1/bootstrap/resolve", payload)
	result, err := parseBootstrapResolutionRequest(response, request, now)
	if err != nil {
		t.Fatal(err)
	}
	if result.AutoStartOperationsPresent || len(result.AutoStartOperations) != 0 {
		t.Fatalf("omitted auto-start operations = %#v", result)
	}

	payload.RequestID = "resolution-auto-empty"
	payload.AutoStartOperations = json.RawMessage(`[]`)
	request, response = newJSONRequest(t, http.MethodPost, "/api/v1/bootstrap/resolve", payload)
	result, err = parseBootstrapResolutionRequest(response, request, now)
	if err != nil {
		t.Fatal(err)
	}
	if !result.AutoStartOperationsPresent || result.AutoStartOperations == nil || len(result.AutoStartOperations) != 0 {
		t.Fatalf("present-empty auto-start operations = %#v", result)
	}

	operations := make([]syncAutoStartOperationJSON, 4096)
	for index := range operations {
		operation := validAutoStartOperationJSON(now, index%2 == 0)
		operation.ID = fmt.Sprintf("auto-start-operation-%04d", index)
		operations[index] = operation
	}
	payload.RequestID = "resolution-auto-maximum"
	payload.AutoStartOperations = autoStartOperationsRaw(t, operations)
	request, response = newJSONRequest(t, http.MethodPost, "/api/v1/bootstrap/resolve", payload)
	result, err = parseBootstrapResolutionRequest(response, request, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.AutoStartOperations) != 4096 || result.AutoStartOperations[4095].ID != "auto-start-operation-4095" {
		t.Fatalf("bootstrap auto-start count = %d", len(result.AutoStartOperations))
	}

	operations = append(operations, validAutoStartOperationJSON(now, true))
	operations[4096].ID = "auto-start-operation-4096"
	payload.AutoStartOperations = autoStartOperationsRaw(t, operations)
	request, response = newJSONRequest(t, http.MethodPost, "/api/v1/bootstrap/resolve", payload)
	if _, err := parseBootstrapResolutionRequest(response, request, now); err == nil {
		t.Fatal("parseBootstrapResolutionRequest accepted 4097 auto-start operations")
	}
}

func TestParseAutoStartRejectsInvalidDuplicateNullAndKeepRemote(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	tests := []struct {
		name      string
		operation syncAutoStartOperationJSON
	}{
		{name: "invalid ID", operation: validAutoStartOperationJSON(now, true)},
		{name: "missing enabled", operation: validAutoStartOperationJSON(now, true)},
		{name: "negative wall", operation: validAutoStartOperationJSON(now, true)},
		{name: "future wall", operation: validAutoStartOperationJSON(now, true)},
		{name: "missing counter", operation: validAutoStartOperationJSON(now, true)},
		{name: "negative counter", operation: validAutoStartOperationJSON(now, true)},
		{name: "invalid occurredAt", operation: validAutoStartOperationJSON(now, true)},
	}
	tests[0].operation.ID = "short"
	tests[1].operation.Enabled = nil
	tests[2].operation.HLCWallMs = int64Pointer(-1)
	tests[3].operation.HLCWallMs = int64Pointer(now.Add(5*time.Minute).UnixMilli() + 1)
	tests[4].operation.HLCCounter = nil
	tests[5].operation.HLCCounter = int64Pointer(-1)
	tests[6].operation.OccurredAt = "yesterday"
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			payload := validSyncRequestJSON(now)
			payload.Commands = []syncCommandJSON{}
			payload.AutoStartOperations = []syncAutoStartOperationJSON{testCase.operation}
			request, response := newJSONRequest(t, http.MethodPost, "/api/v1/sync", payload)
			if _, err := parseSyncRequest(response, request, now); err == nil {
				t.Fatal("parseSyncRequest accepted invalid auto-start operation")
			}
		})
	}

	payload := validSyncRequestJSON(now)
	payload.Commands = []syncCommandJSON{}
	operation := validAutoStartOperationJSON(now, true)
	payload.AutoStartOperations = []syncAutoStartOperationJSON{operation, operation}
	request, response := newJSONRequest(t, http.MethodPost, "/api/v1/sync", payload)
	if _, err := parseSyncRequest(response, request, now); err == nil {
		t.Fatal("parseSyncRequest accepted duplicate auto-start IDs")
	}

	bootstrap := emptyBootstrapResolutionJSON("resolution-auto-null", "device-0001", 0, store.BootstrapMerge)
	bootstrap.AutoStartOperations = json.RawMessage(`null`)
	request, response = newJSONRequest(t, http.MethodPost, "/api/v1/bootstrap/resolve", bootstrap)
	if _, err := parseBootstrapResolutionRequest(response, request, now); err == nil {
		t.Fatal("parseBootstrapResolutionRequest accepted null auto-start operations")
	}

	bootstrap.RequestID = "resolution-auto-keep"
	bootstrap.Strategy = store.BootstrapKeepRemote
	bootstrap.AutoStartOperations = autoStartOperationsRaw(t, []syncAutoStartOperationJSON{operation})
	request, response = newJSONRequest(t, http.MethodPost, "/api/v1/bootstrap/resolve", bootstrap)
	if _, err := parseBootstrapResolutionRequest(response, request, now); err == nil {
		t.Fatal("parseBootstrapResolutionRequest accepted keep_remote auto-start operation")
	}
}

func TestHTTPAutoStartResponseFieldsAndBootstrapCompatibility(t *testing.T) {
	fixture := newServerFixture(t)
	now := time.Now().UTC()
	payload := validSyncRequestJSON(now)
	payload.Commands = []syncCommandJSON{}
	payload.AutoStartOperations = []syncAutoStartOperationJSON{validAutoStartOperationJSON(now, true)}
	response := postAuthenticatedJSON(t, fixture, "/api/v1/sync", payload)
	if response.Code != http.StatusOK {
		t.Fatalf("auto-start sync status=%d body=%s", response.Code, response.Body.String())
	}
	var first store.SyncResult
	if err := json.Unmarshal(response.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	if !first.AutoStartBreaks || first.Revision != 1 || first.AutoStartAcknowledgements[0] != (store.AutoStartAcknowledgement{OperationID: "auto-start-operation-0001", Outcome: "applied"}) {
		t.Fatalf("auto-start sync response = %#v", first)
	}

	omitted := emptyBootstrapResolutionJSON("resolution-auto-http-omitted", fixture.deviceID, 1, store.BootstrapReplaceRemote)
	response = postAuthenticatedJSON(t, fixture, "/api/v1/bootstrap/resolve", omitted)
	if response.Code != http.StatusOK {
		t.Fatalf("omitted replacement status=%d body=%s", response.Code, response.Body.String())
	}
	var preserved store.SyncResult
	if err := json.Unmarshal(response.Body.Bytes(), &preserved); err != nil {
		t.Fatal(err)
	}
	if !preserved.AutoStartBreaks || preserved.Revision != 1 {
		t.Fatalf("omitted replacement response = %#v", preserved)
	}

	empty := emptyBootstrapResolutionJSON("resolution-auto-http-empty", fixture.deviceID, 1, store.BootstrapReplaceRemote)
	empty.AutoStartOperations = json.RawMessage(`[]`)
	response = postAuthenticatedJSON(t, fixture, "/api/v1/bootstrap/resolve", empty)
	if response.Code != http.StatusOK {
		t.Fatalf("present-empty replacement status=%d body=%s", response.Code, response.Body.String())
	}
	var cleared store.SyncResult
	if err := json.Unmarshal(response.Body.Bytes(), &cleared); err != nil {
		t.Fatal(err)
	}
	if cleared.AutoStartBreaks || cleared.Revision != 2 || cleared.AutoStartAcknowledgements == nil {
		t.Fatalf("present-empty replacement response = %#v", cleared)
	}
}

func TestHTTPLegacyBootstrapReplayNormalizesRequiredArrays(t *testing.T) {
	fixture := newServerFixture(t)
	payload := emptyBootstrapResolutionJSON("resolution-legacy-json", fixture.deviceID, 0, store.BootstrapKeepRemote)
	legacyPayload := `{"DeviceID":"device-0001","ExpectedRevision":0,"Strategy":"keep_remote","Commands":[],"TaskOperations":[],"DurationOperations":[]}`
	legacyHash := sha256.Sum256([]byte(legacyPayload))
	legacyResponse := `{"acknowledgements":[],"taskAcknowledgements":[],"durationAcknowledgements":[],"revision":0,"canonicalTimer":null,"history":null,"tasks":null,"durationsMs":{"focus":1500000,"short_break":300000,"long_break":900000},"serverTime":"2026-07-23T12:00:00Z","serverHlcWallMs":0,"serverHlcCounter":0}`
	db, err := fixture.userStore.OpenExistingUser(context.Background(), fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(context.Background(), `INSERT INTO bootstrap_resolutions(request_id, payload_hash, response_json, created_at_ms)
		VALUES (?, ?, ?, 0)`, payload.RequestID, legacyHash[:], legacyResponse); err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	response := postAuthenticatedJSON(t, fixture, "/api/v1/bootstrap/resolve", payload)
	if response.Code != http.StatusOK {
		t.Fatalf("legacy replay status=%d body=%s", response.Code, response.Body.String())
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"acknowledgements", "taskAcknowledgements", "durationAcknowledgements", "autoStartAcknowledgements", "history", "tasks"} {
		if string(fields[field]) != "[]" {
			t.Errorf("%s = %s, want []", field, fields[field])
		}
	}
}
