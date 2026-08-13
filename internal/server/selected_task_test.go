package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"pomodorough/internal/store"
	"pomodorough/internal/task"
)

func selectedTaskIDRaw(t *testing.T, taskID *string) json.RawMessage {
	t.Helper()
	if taskID == nil {
		return json.RawMessage(`null`)
	}
	encoded, err := json.Marshal(*taskID)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func validSelectedTaskOperationJSON(t *testing.T, now time.Time, taskID *string) syncSelectedTaskOperationJSON {
	t.Helper()
	return syncSelectedTaskOperationJSON{
		ID: "selected-task-operation-0001", TaskID: selectedTaskIDRaw(t, taskID), OccurredAt: now.Format(time.RFC3339Nano),
		HLCWallMs: int64Pointer(now.UnixMilli()), HLCCounter: int64Pointer(0),
	}
}

func selectedTaskOperationsRaw(t *testing.T, operations []syncSelectedTaskOperationJSON) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(operations)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestParseSyncSelectedTaskNullableBoundaryAndLimit(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	payload := validSyncRequestJSON(now)
	payload.Commands = []syncCommandJSON{}
	request, response := newJSONRequest(t, http.MethodPost, "/api/v1/sync", payload)
	result, err := parseSyncRequest(response, request, now)
	if err != nil {
		t.Fatal(err)
	}
	if result.SelectedTaskOperations == nil || len(result.SelectedTaskOperations) != 0 {
		t.Fatalf("omitted selected-task operations = %#v", result.SelectedTaskOperations)
	}

	taskID := task.ID("Boundary task")
	payload.SelectedTaskOperations = make([]syncSelectedTaskOperationJSON, 256)
	for index := range payload.SelectedTaskOperations {
		var selected *string
		if index%2 == 0 {
			selected = &taskID
		}
		operation := validSelectedTaskOperationJSON(t, now, selected)
		operation.ID = fmt.Sprintf("selected-task-operation-%04d", index)
		payload.SelectedTaskOperations[index] = operation
	}
	request, response = newJSONRequest(t, http.MethodPost, "/api/v1/sync", payload)
	result, err = parseSyncRequest(response, request, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.SelectedTaskOperations) != 256 || result.SelectedTaskOperations[255].ID != "selected-task-operation-0255" || result.SelectedTaskOperations[255].TaskID != nil {
		t.Fatalf("parsed selected-task boundary = %#v", result.SelectedTaskOperations[255])
	}

	payload.SelectedTaskOperations = append(payload.SelectedTaskOperations, validSelectedTaskOperationJSON(t, now, nil))
	payload.SelectedTaskOperations[256].ID = "selected-task-operation-0256"
	request, response = newJSONRequest(t, http.MethodPost, "/api/v1/sync", payload)
	if _, err := parseSyncRequest(response, request, now); err == nil {
		t.Fatal("parseSyncRequest accepted 257 selected-task operations")
	}
}

func TestParseBootstrapSelectedTaskDetectsOmittedEmptyAndLimits(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	payload := emptyBootstrapResolutionJSON("resolution-selected-omitted", "device-0001", 0, store.BootstrapReplaceRemote)
	request, response := newJSONRequest(t, http.MethodPost, "/api/v1/bootstrap/resolve", payload)
	result, err := parseBootstrapResolutionRequest(response, request, now)
	if err != nil {
		t.Fatal(err)
	}
	if result.SelectedTaskOperationsPresent || len(result.SelectedTaskOperations) != 0 {
		t.Fatalf("omitted selected-task operations = %#v", result)
	}

	payload.RequestID = "resolution-selected-empty"
	payload.SelectedTaskOperations = json.RawMessage(`[]`)
	request, response = newJSONRequest(t, http.MethodPost, "/api/v1/bootstrap/resolve", payload)
	result, err = parseBootstrapResolutionRequest(response, request, now)
	if err != nil {
		t.Fatal(err)
	}
	if !result.SelectedTaskOperationsPresent || result.SelectedTaskOperations == nil || len(result.SelectedTaskOperations) != 0 {
		t.Fatalf("present-empty selected-task operations = %#v", result)
	}

	operations := make([]syncSelectedTaskOperationJSON, 4096)
	for index := range operations {
		operation := validSelectedTaskOperationJSON(t, now, nil)
		operation.ID = fmt.Sprintf("selected-task-operation-%04d", index)
		operations[index] = operation
	}
	payload.RequestID = "resolution-selected-maximum"
	payload.SelectedTaskOperations = selectedTaskOperationsRaw(t, operations)
	request, response = newJSONRequest(t, http.MethodPost, "/api/v1/bootstrap/resolve", payload)
	result, err = parseBootstrapResolutionRequest(response, request, now)
	if err != nil || len(result.SelectedTaskOperations) != 4096 {
		t.Fatalf("bootstrap selected-task count = %d, %v", len(result.SelectedTaskOperations), err)
	}
	operations = append(operations, validSelectedTaskOperationJSON(t, now, nil))
	operations[4096].ID = "selected-task-operation-4096"
	payload.SelectedTaskOperations = selectedTaskOperationsRaw(t, operations)
	request, response = newJSONRequest(t, http.MethodPost, "/api/v1/bootstrap/resolve", payload)
	if _, err := parseBootstrapResolutionRequest(response, request, now); err == nil {
		t.Fatal("parseBootstrapResolutionRequest accepted 4097 selected-task operations")
	}
}

func TestParseSelectedTaskRejectsInvalidMissingDuplicateNullArrayAndKeepRemote(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	taskID := task.ID("Parser task")
	tests := []struct {
		name      string
		operation syncSelectedTaskOperationJSON
	}{
		{name: "invalid ID", operation: validSelectedTaskOperationJSON(t, now, &taskID)},
		{name: "missing taskId", operation: validSelectedTaskOperationJSON(t, now, &taskID)},
		{name: "invalid taskId", operation: validSelectedTaskOperationJSON(t, now, &taskID)},
		{name: "wrong taskId type", operation: validSelectedTaskOperationJSON(t, now, &taskID)},
		{name: "invalid clock", operation: validSelectedTaskOperationJSON(t, now, &taskID)},
	}
	tests[0].operation.ID = "short"
	tests[1].operation.TaskID = nil
	tests[2].operation.TaskID = json.RawMessage(`"short"`)
	tests[3].operation.TaskID = json.RawMessage(`42`)
	tests[4].operation.HLCWallMs = int64Pointer(-1)
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			payload := validSyncRequestJSON(now)
			payload.Commands = []syncCommandJSON{}
			payload.SelectedTaskOperations = []syncSelectedTaskOperationJSON{testCase.operation}
			request, response := newJSONRequest(t, http.MethodPost, "/api/v1/sync", payload)
			if _, err := parseSyncRequest(response, request, now); err == nil {
				t.Fatal("parseSyncRequest accepted invalid selected-task operation")
			}
		})
	}

	payload := validSyncRequestJSON(now)
	payload.Commands = []syncCommandJSON{}
	operation := validSelectedTaskOperationJSON(t, now, nil)
	payload.SelectedTaskOperations = []syncSelectedTaskOperationJSON{operation, operation}
	request, response := newJSONRequest(t, http.MethodPost, "/api/v1/sync", payload)
	if _, err := parseSyncRequest(response, request, now); err == nil {
		t.Fatal("parseSyncRequest accepted duplicate selected-task IDs")
	}

	bootstrap := emptyBootstrapResolutionJSON("resolution-selected-null", "device-0001", 0, store.BootstrapMerge)
	bootstrap.SelectedTaskOperations = json.RawMessage(`null`)
	request, response = newJSONRequest(t, http.MethodPost, "/api/v1/bootstrap/resolve", bootstrap)
	if _, err := parseBootstrapResolutionRequest(response, request, now); err == nil {
		t.Fatal("parseBootstrapResolutionRequest accepted null selected-task operations")
	}
	bootstrap.RequestID = "resolution-selected-keep"
	bootstrap.Strategy = store.BootstrapKeepRemote
	bootstrap.SelectedTaskOperations = selectedTaskOperationsRaw(t, []syncSelectedTaskOperationJSON{operation})
	request, response = newJSONRequest(t, http.MethodPost, "/api/v1/bootstrap/resolve", bootstrap)
	if _, err := parseBootstrapResolutionRequest(response, request, now); err == nil {
		t.Fatal("parseBootstrapResolutionRequest accepted keep_remote selected-task operation")
	}
}

func TestHTTPSelectedTaskResponseAndOldClientCompatibility(t *testing.T) {
	fixture := newServerFixture(t)
	now := time.Now().UTC()
	taskTitle := "HTTP selected task"
	taskID := task.ID(taskTitle)
	payload := validSyncRequestJSON(now)
	payload.Commands = []syncCommandJSON{}
	payload.TaskOperations = []syncTaskOperationJSON{validTaskOperationJSON(now, taskTitle)}
	payload.SelectedTaskOperations = []syncSelectedTaskOperationJSON{validSelectedTaskOperationJSON(t, now, &taskID)}
	response := postAuthenticatedJSON(t, fixture, "/api/v1/sync", payload)
	if response.Code != http.StatusOK {
		t.Fatalf("selected-task sync status=%d body=%s", response.Code, response.Body.String())
	}
	var selected store.SyncResult
	if err := json.Unmarshal(response.Body.Bytes(), &selected); err != nil {
		t.Fatal(err)
	}
	if selected.SelectedTaskID == nil || *selected.SelectedTaskID != taskID || selected.Revision != 1 ||
		selected.SelectedTaskAcknowledgements[0] != (store.SelectedTaskAcknowledgement{OperationID: "selected-task-operation-0001", Outcome: "applied"}) {
		t.Fatalf("selected-task sync response = %#v", selected)
	}

	oldClient := validSyncRequestJSON(now.Add(time.Second))
	oldClient.Commands = []syncCommandJSON{}
	oldClient.LastRevision = int64Pointer(1)
	response = postAuthenticatedJSON(t, fixture, "/api/v1/sync", oldClient)
	if response.Code != http.StatusOK {
		t.Fatalf("old client sync status=%d body=%s", response.Code, response.Body.String())
	}
	var preserved store.SyncResult
	if err := json.Unmarshal(response.Body.Bytes(), &preserved); err != nil {
		t.Fatal(err)
	}
	if preserved.SelectedTaskID == nil || *preserved.SelectedTaskID != taskID || preserved.SelectedTaskAcknowledgements == nil || len(preserved.SelectedTaskAcknowledgements) != 0 || preserved.Revision != 1 {
		t.Fatalf("old client selected-task response = %#v", preserved)
	}
}
