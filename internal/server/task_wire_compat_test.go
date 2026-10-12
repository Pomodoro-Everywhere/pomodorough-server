package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"pomodorough/internal/store"
)

func postSyncBytes(t *testing.T, fixture serverFixture, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "https://pomodorough.egigoka.me/api/v1/sync", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+fixture.accessToken)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	return response
}

func syncBodyWithTaskDevice(t *testing.T, deviceID *string, extra map[string]any) string {
	t.Helper()
	now := time.Now().UTC()
	payload := validSyncRequestJSON(now)
	payload.TaskOperations = []syncTaskOperationJSON{validTaskOperationJSON(now, "Review offline task")}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	operations := decoded["taskOperations"].([]any)
	operation := operations[0].(map[string]any)
	if deviceID == nil {
		delete(operation, "deviceId")
	} else {
		operation["deviceId"] = *deviceID
	}
	for key, value := range extra {
		operation[key] = value
	}
	encoded, err := json.Marshal(decoded)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func decodeSyncResult(t *testing.T, response *httptest.ResponseRecorder) store.SyncResult {
	t.Helper()
	var result store.SyncResult
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode sync response: %v body=%s", err, response.Body.String())
	}
	return result
}

func TestTaskWireNewClaimsOmitDeviceID(t *testing.T) {
	fixture := newServerFixture(t)
	body := syncBodyWithTaskDevice(t, nil, nil)
	var decoded map[string]any
	if err := json.Unmarshal([]byte(body), &decoded); err != nil {
		t.Fatal(err)
	}
	operation := decoded["taskOperations"].([]any)[0].(map[string]any)
	if _, present := operation["deviceId"]; present {
		t.Fatalf("new claim carries per-operation deviceId: %s", body)
	}
	response := postSyncBytes(t, fixture, body)
	if response.Code != http.StatusOK {
		t.Fatalf("stripped task claim status=%d body=%s", response.Code, response.Body.String())
	}
	result := decodeSyncResult(t, response)
	if len(result.TaskAcknowledgements) != 1 || result.TaskAcknowledgements[0].Outcome != "applied" {
		t.Fatalf("task ack = %#v", result.TaskAcknowledgements)
	}
	if len(result.Tasks) != 1 || result.Tasks[0].Title != "Review offline task" {
		t.Fatalf("persisted tasks = %#v", result.Tasks)
	}
}

func TestTaskWireRetainedMatchingDeviceIDAccepted(t *testing.T) {
	fixture := newServerFixture(t)
	device := "device-0001"
	body := syncBodyWithTaskDevice(t, &device, nil)
	response := postSyncBytes(t, fixture, body)
	if response.Code != http.StatusOK {
		t.Fatalf("retained matching claim status=%d body=%s", response.Code, response.Body.String())
	}
	result := decodeSyncResult(t, response)
	if len(result.TaskAcknowledgements) != 1 || result.TaskAcknowledgements[0].Outcome != "applied" {
		t.Fatalf("compat task ack = %#v", result.TaskAcknowledgements)
	}
}

func TestTaskWireMismatchedDeviceIDRejected(t *testing.T) {
	fixture := newServerFixture(t)
	device := "device-0002"
	body := syncBodyWithTaskDevice(t, &device, nil)
	response := postSyncBytes(t, fixture, body)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("mismatched device status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestTaskWireUnknownFieldStillRejected(t *testing.T) {
	fixture := newServerFixture(t)
	body := syncBodyWithTaskDevice(t, nil, map[string]any{"ownerId": "tab-1"})
	response := postSyncBytes(t, fixture, body)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unknown field status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestTaskWireMixedBatchAndExactRetry(t *testing.T) {
	fixture := newServerFixture(t)
	now := time.Now().UTC()
	payload := validSyncRequestJSON(now)
	payload.TaskOperations = []syncTaskOperationJSON{validTaskOperationJSON(now, "Review offline task")}
	payload.Commands[0].TaskID = payload.TaskOperations[0].TaskID
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	first := postSyncBytes(t, fixture, string(raw))
	if first.Code != http.StatusOK {
		t.Fatalf("mixed batch status=%d body=%s", first.Code, first.Body.String())
	}
	initial := decodeSyncResult(t, first)
	if len(initial.TaskAcknowledgements) != 1 || len(initial.Acknowledgements) != 1 {
		t.Fatalf("mixed acks = %#v %#v", initial.TaskAcknowledgements, initial.Acknowledgements)
	}
	if initial.CanonicalTimer == nil {
		t.Fatal("mixed batch left no canonical timer receipt")
	}
	retry := postSyncBytes(t, fixture, string(raw))
	if retry.Code != http.StatusOK {
		t.Fatalf("exact retry status=%d body=%s", retry.Code, retry.Body.String())
	}
	repeated := decodeSyncResult(t, retry)
	if len(repeated.TaskAcknowledgements) != 1 || repeated.TaskAcknowledgements[0].OperationID != initial.TaskAcknowledgements[0].OperationID {
		t.Fatalf("retry ack identity changed: %#v vs %#v", repeated.TaskAcknowledgements, initial.TaskAcknowledgements)
	}
}
