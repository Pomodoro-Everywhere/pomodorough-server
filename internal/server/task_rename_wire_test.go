package server

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"pomodorough/internal/store"
	"pomodorough/internal/task"
)

// A Core 0.56.0 rename names the old identity in taskId and the new
// normalized title in title. Go checks only its shape; Core task.reduce.v1 on
// the lone candidate decides the rest.

func renameOperationJSON(now time.Time, id, fromTitle, toTitle string) syncTaskOperationJSON {
	operation := validTaskOperationJSON(now, fromTitle)
	operation.ID, operation.Type, operation.Title = id, "rename", toTitle
	return operation
}

func TestParseTaskOperationsAcceptsCoreRename(t *testing.T) {
	now := time.Now().UTC()
	upsert := validTaskOperationJSON(now, "Beta")
	upsert.ID = "task-operation-0002"
	rename := renameOperationJSON(now, "task-operation-0003", "Alpha", "Beta")
	operations, err := parseTaskOperations(context.Background(), "device-0001",
		[]syncTaskOperationJSON{upsert, rename}, now)
	if err != nil {
		t.Fatal(err)
	}
	got := operations[1]
	if got.Type != "rename" || got.TaskID != task.ID("Alpha") || got.Title != "Beta" || got.DeviceID != "device-0001" {
		t.Fatalf("parsed rename = %#v", got)
	}
}

func TestParseTaskOperationsRejectsRenameShapeAndCoreFailures(t *testing.T) {
	now := time.Now().UTC()
	cases := []struct {
		name, want string
		operation  syncTaskOperationJSON
	}{
		{"missing title", "rename task operation has no title", renameOperationJSON(now, "task-operation-0001", "Alpha", "")},
		{"title not normalized", "invalid task rename", renameOperationJSON(now, "task-operation-0001", "Alpha", "Beta\x00")},
		{"same identity", "invalid task rename", renameOperationJSON(now, "task-operation-0001", "Alpha", "Alpha")},
		{"title only of controls", "invalid task rename", renameOperationJSON(now, "task-operation-0001", "Alpha", "\x00\x1f")},
		{"delete with a title", "delete task operation has title", func() syncTaskOperationJSON {
			operation := renameOperationJSON(now, "task-operation-0001", "Alpha", "Beta")
			operation.Type = "delete"
			return operation
		}()},
		{"unknown type", "invalid task operation type", func() syncTaskOperationJSON {
			operation := renameOperationJSON(now, "task-operation-0001", "Alpha", "Beta")
			operation.Type = "merge"
			return operation
		}()},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := parseTaskOperations(context.Background(), "device-0001", []syncTaskOperationJSON{testCase.operation}, now)
			if err == nil || err.Error() != testCase.want {
				t.Fatalf("error = %v; want %q", err, testCase.want)
			}
			if isRequestRuntimeError(err) {
				t.Fatalf("client error classified as runtime failure: %v", err)
			}
		})
	}
}

func TestTaskWireRejectsRenameTitleOfWrongType(t *testing.T) {
	fixture := newServerFixture(t)
	body := syncBodyWithTaskDevice(t, nil, map[string]any{"type": "rename", "title": 7})
	if response := postSyncBytes(t, fixture, body); response.Code != http.StatusBadRequest {
		t.Fatalf("numeric rename title status=%d body=%s", response.Code, response.Body.String())
	}
}

// Core trims only non-printable characters, so edge spaces are a normalized
// title; a leading NUL is not.
func TestTaskWireRejectsUnnormalizedRenameAsClientError(t *testing.T) {
	fixture := newServerFixture(t)
	body := syncBodyWithTaskDevice(t, nil, map[string]any{"type": "rename", "title": "\u0000Beta"})
	if response := postSyncBytes(t, fixture, body); response.Code != http.StatusBadRequest {
		t.Fatalf("unnormalized rename status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestTaskWireRenameMovesTaskAndReplaysExactly(t *testing.T) {
	fixture := newServerFixture(t)
	now := time.Now().UTC()
	alpha := validTaskOperationJSON(now, "Alpha")
	postTaskOperations(t, fixture, now, alpha)
	later := now.Add(time.Second)
	beta := validTaskOperationJSON(later, "Beta")
	beta.ID = "task-operation-0002"
	rename := renameOperationJSON(later, "task-operation-0003", "Alpha", "Beta")
	result := postTaskOperations(t, fixture, later, beta, rename)
	if want := []task.Task{{ID: task.ID("Beta"), Title: "Beta"}}; !reflect.DeepEqual(result.Tasks, want) {
		t.Fatalf("tasks after rename = %#v; want %#v", result.Tasks, want)
	}
	if len(result.TaskAcknowledgements) != 2 || result.TaskAcknowledgements[1].Outcome != "applied" {
		t.Fatalf("rename acks = %#v", result.TaskAcknowledgements)
	}
	replay := postTaskOperations(t, fixture, later, beta, rename)
	if !reflect.DeepEqual(replay.Tasks, result.Tasks) || replay.TaskAcknowledgements[1].Outcome == "rejected" {
		t.Fatalf("exact rename replay = %#v %#v", replay.Tasks, replay.TaskAcknowledgements)
	}
	changed := rename
	changed.Title = "Gamma"
	replay = postTaskOperations(t, fixture, later, changed)
	if len(replay.TaskAcknowledgements) != 1 || replay.TaskAcknowledgements[0].Outcome != "rejected" {
		t.Fatalf("rename replay with a different title = %#v", replay.TaskAcknowledgements)
	}
}

func postTaskOperations(t *testing.T, fixture serverFixture, now time.Time, operations ...syncTaskOperationJSON) store.SyncResult {
	t.Helper()
	payload := validSyncRequestJSON(now)
	payload.Commands = []syncCommandJSON{}
	payload.TaskOperations = operations
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	response := postSyncBytes(t, fixture, string(raw))
	if response.Code != http.StatusOK {
		t.Fatalf("task sync status=%d body=%s", response.Code, strings.TrimSpace(response.Body.String()))
	}
	return decodeSyncResult(t, response)
}
