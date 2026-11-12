package task

import (
	"context"
	"errors"
	"testing"
	"time"
)

func renameOperation(fromTitle, toTitle string) Operation {
	return Operation{
		ID: "task-operation-0001", DeviceID: "device-0001", TaskID: ID(fromTitle), Type: "rename", Title: toTitle,
		OccurredAt: time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC), HLCWallMs: 1784109600000,
	}
}

func TestCheckSharedRenamesAcceptsValidRenames(t *testing.T) {
	operations := []Operation{renameOperation("Alpha", "Beta"), renameOperation("Gamma", "  Gamma  ")}
	if err := CheckSharedRenames(context.Background(), operations); err != nil {
		t.Fatal(err)
	}
	if err := CheckSharedRenames(context.Background(), nil); err != nil {
		t.Fatalf("empty rename list: %v", err)
	}
}

func TestCheckSharedRenamesReportsCoreRejections(t *testing.T) {
	for _, operation := range []Operation{
		renameOperation("Alpha", "Alpha"),
		renameOperation("Alpha", "\x00Beta"),
		renameOperation("Alpha", ""),
	} {
		err := CheckSharedRenames(context.Background(), []Operation{renameOperation("Delta", "Epsilon"), operation})
		if !errors.Is(err, ErrInvalidRename) || IsSharedIdentityRuntimeError(err) {
			t.Fatalf("rename %q -> %q error = %v; want ErrInvalidRename", operation.TaskID, operation.Title, err)
		}
	}
}

func TestDecodeRenameCheckFailsClosed(t *testing.T) {
	operation := renameOperation("Alpha", "Beta")
	winner := `{"` + operation.TaskID + `":"task-operation-0001"}`
	invalid := []string{
		`{"ok":true,"value":{"tasks":[],"winningOperationIds":` + winner + `},"extra":1}`,
		`{"ok":true,"value":{"tasks":[{"id":"x","title":"Beta"}],"winningOperationIds":` + winner + `}}`,
		`{"ok":true,"value":{"tasks":[],"winningOperationIds":{}}}`,
		`{"ok":true,"value":{"tasks":[],"winningOperationIds":{"` + operation.TaskID + `":"task-operation-0002"}}}`,
		`{"ok":true,"value":{"winningOperationIds":` + winner + `}}`,
		`{"ok":true,"value":{"tasks":[],"winningOperationIds":` + winner + `,"extra":1}}`,
		`{"ok":false,"error":"invalid shared-core input: invalid duration"}`,
		`{"ok":false,"error":"invalid task rename"}`,
		`{"ok":false}`,
	}
	for _, document := range invalid {
		err := decodeRenameCheck(operation, []byte(document))
		if !IsSharedIdentityRuntimeError(err) {
			t.Fatalf("decodeRenameCheck(%s) = %v; want a runtime failure", document, err)
		}
	}
	valid := `{"ok":true,"value":{"tasks":[],"winningOperationIds":` + winner + `}}`
	if err := decodeRenameCheck(operation, []byte(valid)); err != nil {
		t.Fatalf("valid rename check rejected: %v", err)
	}
}
