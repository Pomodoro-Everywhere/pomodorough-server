package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"pomodorough/internal/store"
)

type requestRuntimeError struct {
	cause error
}

func (e *requestRuntimeError) Error() string { return e.cause.Error() }
func (e *requestRuntimeError) Unwrap() error { return e.cause }

func isRequestRuntimeError(err error) bool {
	var target *requestRuntimeError
	return errors.As(err, &target)
}

func parseSyncRequest(w http.ResponseWriter, r *http.Request, now time.Time) (store.SyncRequest, error) {
	var payload syncRequestJSON
	if err := decodeJSON(w, r, maxSyncBody, &payload); err != nil {
		return store.SyncRequest{}, err
	}
	if !validSyncEnvelope(payload) {
		return store.SyncRequest{}, errors.New("invalid sync envelope")
	}
	request, err := parseOperationBatch(r.Context(), operationBatch{
		deviceID: payload.DeviceID, commands: payload.Commands, taskOperations: payload.TaskOperations,
		durationOperations: payload.DurationOperations, autoStartOperations: payload.AutoStartOperations,
		selectedTaskOperations: payload.SelectedTaskOperations, maximum: 256,
	}, now)
	if err != nil {
		return store.SyncRequest{}, err
	}
	request.LastRevision = *payload.LastRevision
	return request, nil
}

func validSyncEnvelope(payload syncRequestJSON) bool {
	return validID(payload.DeviceID) && payload.LastRevision != nil &&
		*payload.LastRevision >= 0 && *payload.LastRevision <= store.MaxSafeRevision && payload.Commands != nil &&
		operationCountsValid(len(payload.Commands), len(payload.TaskOperations), len(payload.DurationOperations),
			len(payload.AutoStartOperations), len(payload.SelectedTaskOperations), 256)
}

func parseBootstrapResolutionRequest(w http.ResponseWriter, r *http.Request, now time.Time) (store.BootstrapResolutionRequest, error) {
	var payload bootstrapResolutionRequestJSON
	if err := decodeJSON(w, r, maxBootstrapBody, &payload); err != nil {
		return store.BootstrapResolutionRequest{}, err
	}
	batch, autoPresent, selectedPresent, err := bootstrapOperationBatch(payload)
	if err != nil {
		return store.BootstrapResolutionRequest{}, err
	}
	if !validBootstrapEnvelope(payload, batch) {
		return store.BootstrapResolutionRequest{}, errors.New("invalid bootstrap resolution envelope")
	}
	if payload.Strategy == store.BootstrapKeepRemote && batch.operationCount() != 0 {
		return store.BootstrapResolutionRequest{}, errors.New("keep_remote requires empty operation arrays")
	}
	operations, err := parseOperationBatch(r.Context(), batch, now)
	if err != nil {
		return store.BootstrapResolutionRequest{}, err
	}
	return bootstrapResolution(payload, operations, autoPresent, selectedPresent), nil
}

func bootstrapOperationBatch(payload bootstrapResolutionRequestJSON) (operationBatch, bool, bool, error) {
	autoStart, autoPresent, err := parseOptionalAutoStartOperations(payload.AutoStartOperations)
	if err != nil {
		return operationBatch{}, false, false, err
	}
	selected, selectedPresent, err := parseOptionalSelectedTaskOperations(payload.SelectedTaskOperations)
	if err != nil {
		return operationBatch{}, false, false, err
	}
	batch := operationBatch{
		deviceID: payload.DeviceID, commands: payload.Commands, taskOperations: payload.TaskOperations,
		durationOperations: payload.DurationOperations, autoStartOperations: autoStart,
		selectedTaskOperations: selected, maximum: 4096,
	}
	return batch, autoPresent, selectedPresent, nil
}

func validBootstrapEnvelope(payload bootstrapResolutionRequestJSON, batch operationBatch) bool {
	_, validStrategy := validBootstrapStrategies[payload.Strategy]
	return validID(payload.RequestID) && validID(payload.DeviceID) && payload.ExpectedRevision != nil &&
		*payload.ExpectedRevision >= 0 && *payload.ExpectedRevision <= store.MaxSafeRevision && validStrategy &&
		payload.Commands != nil && payload.TaskOperations != nil && payload.DurationOperations != nil &&
		batch.validCount()
}

func bootstrapResolution(payload bootstrapResolutionRequestJSON, operations store.SyncRequest, autoPresent, selectedPresent bool) store.BootstrapResolutionRequest {
	return store.BootstrapResolutionRequest{
		RequestID: payload.RequestID, DeviceID: payload.DeviceID, ExpectedRevision: *payload.ExpectedRevision, Strategy: payload.Strategy,
		Commands: operations.Commands, TaskOperations: operations.TaskOperations, DurationOperations: operations.DurationOperations,
		AutoStartOperations: operations.AutoStartOperations, AutoStartOperationsPresent: autoPresent,
		SelectedTaskOperations: operations.SelectedTaskOperations, SelectedTaskOperationsPresent: selectedPresent,
	}
}

func parseOptionalSelectedTaskOperations(raw json.RawMessage) ([]syncSelectedTaskOperationJSON, bool, error) {
	return parseOptionalOperationArray[syncSelectedTaskOperationJSON](raw, "selectedTaskOperations")
}

func parseOptionalAutoStartOperations(raw json.RawMessage) ([]syncAutoStartOperationJSON, bool, error) {
	return parseOptionalOperationArray[syncAutoStartOperationJSON](raw, "autoStartOperations")
}

func parseOptionalOperationArray[T any](raw json.RawMessage, name string) ([]T, bool, error) {
	if len(raw) == 0 {
		return nil, false, nil
	}
	message := name + " must be an array"
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, false, errors.New(message)
	}
	var operations []T
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&operations); err != nil || operations == nil {
		return nil, false, errors.New(message)
	}
	return operations, true, nil
}

func parseNullableTaskID(raw json.RawMessage) (*string, error) {
	if len(raw) == 0 {
		return nil, errors.New("missing selected-task value")
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	var taskID string
	if err := json.Unmarshal(raw, &taskID); err != nil || !validID(taskID) {
		return nil, errors.New("invalid selected-task value")
	}
	return &taskID, nil
}

func parseOperationClock(value string, wallMs, counter *int64, allowLegacy bool, now time.Time) (time.Time, error) {
	if wallMs == nil || counter == nil || *wallMs < 0 || *wallMs > maxSafeInteger || *counter < 0 || *counter > maxSafeInteger {
		return time.Time{}, errors.New("clock is outside the safe integer range")
	}
	occurredAt, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, errors.New("occurrence time is not RFC 3339")
	}
	if *wallMs == 0 {
		if !allowLegacy || *counter != 0 || !occurredAt.Equal(time.Unix(0, 0).UTC()) {
			return time.Time{}, errors.New("invalid legacy clock sentinel")
		}
		return occurredAt, nil
	}
	latest := now.Add(maxClockSkew)
	if *wallMs > latest.UnixMilli() || occurredAt.After(latest) {
		return time.Time{}, errors.New("clock is too far ahead of server time")
	}
	delta := occurredAt.Sub(time.UnixMilli(*wallMs))
	if delta < -maxClockSkew || delta > maxClockSkew {
		return time.Time{}, errors.New("occurrence time and hybrid clock disagree")
	}
	return occurredAt, nil
}

func validID(value string) bool { return idPattern.MatchString(value) }

func validPlatform(value string) bool { return platformPattern.MatchString(value) }
