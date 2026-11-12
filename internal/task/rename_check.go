package task

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"pomodorough/internal/sharedcore"
)

// ErrInvalidRename marks a rename that Core rejected as a client input error.
var ErrInvalidRename = errors.New("invalid task rename")

// coreRejections are the Core task.reduce.v1 reasons that describe the
// candidate operation itself. Any other Core failure is a runtime failure.
var coreRejections = map[string]struct{}{
	"invalid task rename":         {},
	"invalid task identity":       {},
	"invalid task operation type": {},
}

const coreInvalidInputPrefix = "invalid shared-core input: "

type coreRenameCandidate struct {
	ID         string `json:"id"`
	DeviceID   string `json:"deviceId"`
	OccurredAt string `json:"occurredAt"`
	HLCWallMs  int64  `json:"hlcWallMs"`
	HLCCounter int64  `json:"hlcCounter"`
	TaskID     string `json:"taskId"`
	Type       string `json:"type"`
	Title      string `json:"title"`
}

// CheckSharedRenames runs each rename alone through Core task.reduce.v1, so
// Core decides whether the new title is normalized and names a different
// identity. Go checks only the request shape. A Core rejection returns an
// error wrapping ErrInvalidRename; anything else is a SharedIdentityRuntimeError.
func CheckSharedRenames(ctx context.Context, operations []Operation) error {
	calls := make([]sharedcore.Call, 0, len(operations))
	for _, operation := range operations {
		input, err := json.Marshal(map[string][]coreRenameCandidate{"operations": {renameCandidate(operation)}})
		if err != nil {
			return &SharedIdentityRuntimeError{Cause: err}
		}
		calls = append(calls, sharedcore.Call{Operation: "task.reduce.v1", Input: input})
	}
	if len(calls) == 0 {
		return nil
	}
	core, err := sharedcore.Default(ctx)
	if err != nil {
		return &SharedIdentityRuntimeError{Cause: err}
	}
	results, err := core.CallBatch(ctx, calls)
	if err != nil {
		return &SharedIdentityRuntimeError{Cause: err}
	}
	for index, result := range results {
		if err := decodeRenameCheck(operations[index], result); err != nil {
			return err
		}
	}
	return nil
}

func renameCandidate(operation Operation) coreRenameCandidate {
	return coreRenameCandidate{
		ID: operation.ID, DeviceID: operation.DeviceID,
		OccurredAt: operation.OccurredAt.UTC().Format(time.RFC3339Nano),
		HLCWallMs:  operation.HLCWallMs, HLCCounter: operation.HLCCounter,
		TaskID: operation.TaskID, Type: operation.Type, Title: operation.Title,
	}
}

// decodeRenameCheck accepts only the result Core gives a valid lone rename:
// no surviving task, and the rename as the winner for its old identity.
func decodeRenameCheck(operation Operation, result []byte) error {
	value, err := decodeSharedEnvelope("shared task rename check", result)
	var rejected *SharedIdentityValidationError
	if errors.As(err, &rejected) {
		return classifyRenameRejection(rejected.Detail)
	}
	if err != nil {
		return err
	}
	var reduced struct {
		Tasks               []Task            `json:"tasks"`
		WinningOperationIDs map[string]string `json:"winningOperationIds"`
	}
	decoder := json.NewDecoder(bytes.NewReader(value))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&reduced); err != nil {
		return &SharedIdentityRuntimeError{Cause: fmt.Errorf("decode shared task rename check: %w", err)}
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return &SharedIdentityRuntimeError{Cause: errors.New("shared task rename check contains trailing data")}
	}
	if reduced.Tasks == nil || len(reduced.Tasks) != 0 || len(reduced.WinningOperationIDs) != 1 ||
		reduced.WinningOperationIDs[operation.TaskID] != operation.ID {
		return &SharedIdentityRuntimeError{Cause: errors.New("shared task rename check returned an unexpected reduction")}
	}
	return nil
}

func classifyRenameRejection(detail string) error {
	reason, found := strings.CutPrefix(detail, coreInvalidInputPrefix)
	if _, known := coreRejections[reason]; found && known {
		return fmt.Errorf("%w: %s", ErrInvalidRename, reason)
	}
	return &SharedIdentityRuntimeError{Cause: fmt.Errorf("shared task rename check failed: %s", detail)}
}
