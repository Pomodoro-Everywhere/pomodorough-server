package server

import (
	"context"
	"fmt"
	"time"

	"pomodorough/internal/store"
	"pomodorough/internal/task"
	"pomodorough/internal/timer"
)

type operationBatch struct {
	deviceID               string
	commands               []syncCommandJSON
	taskOperations         []syncTaskOperationJSON
	durationOperations     []syncDurationOperationJSON
	autoStartOperations    []syncAutoStartOperationJSON
	selectedTaskOperations []syncSelectedTaskOperationJSON
	maximum                int
}

func (batch operationBatch) operationCount() int {
	return len(batch.commands) + len(batch.taskOperations) + len(batch.durationOperations) +
		len(batch.autoStartOperations) + len(batch.selectedTaskOperations)
}

func (batch operationBatch) validCount() bool {
	return operationCountsValid(len(batch.commands), len(batch.taskOperations), len(batch.durationOperations),
		len(batch.autoStartOperations), len(batch.selectedTaskOperations), batch.maximum)
}

func operationCountsValid(commands, tasks, durations, autoStarts, selectedTasks, maximum int) bool {
	return commands <= maximum && tasks <= maximum && durations <= maximum &&
		autoStarts <= maximum && selectedTasks <= maximum
}

func parseOperationBatch(ctx context.Context, batch operationBatch, now time.Time) (store.SyncRequest, error) {
	if !batch.validCount() {
		return store.SyncRequest{}, fmt.Errorf("too many operations")
	}
	commands, err := parseCommands(batch.deviceID, batch.commands, now)
	if err != nil {
		return store.SyncRequest{}, err
	}
	tasks, err := parseTaskOperations(ctx, batch.deviceID, batch.taskOperations, now)
	if err != nil {
		return store.SyncRequest{}, err
	}
	durations, err := parseDurationOperations(batch.deviceID, batch.durationOperations, now)
	if err != nil {
		return store.SyncRequest{}, err
	}
	autoStarts, err := parseAutoStartOperations(batch.deviceID, batch.autoStartOperations, now)
	if err != nil {
		return store.SyncRequest{}, err
	}
	selectedTasks, err := parseSelectedTaskOperations(batch.deviceID, batch.selectedTaskOperations, now)
	if err != nil {
		return store.SyncRequest{}, err
	}
	return store.SyncRequest{
		DeviceID: batch.deviceID, Commands: commands, TaskOperations: tasks, DurationOperations: durations,
		AutoStartOperations: autoStarts, SelectedTaskOperations: selectedTasks,
	}, nil
}

func parseCommands(deviceID string, inputs []syncCommandJSON, now time.Time) ([]timer.Command, error) {
	commands := make([]timer.Command, 0, len(inputs))
	seen := make(map[string]struct{}, len(inputs))
	for _, input := range inputs {
		if !validID(input.ID) || !validID(input.TimerID) || input.DeviceSequence == nil ||
			*input.DeviceSequence <= 0 || *input.DeviceSequence > maxSafeInteger {
			return nil, fmt.Errorf("invalid command identity")
		}
		if _, duplicate := seen[input.ID]; duplicate {
			return nil, fmt.Errorf("duplicate command identity")
		}
		seen[input.ID] = struct{}{}
		command, err := parseCommand(deviceID, input, now)
		if err != nil {
			return nil, err
		}
		commands = append(commands, command)
	}
	return commands, nil
}

func parseCommand(deviceID string, input syncCommandJSON, now time.Time) (timer.Command, error) {
	if _, valid := validTypes[input.Type]; !valid {
		return timer.Command{}, fmt.Errorf("invalid command type")
	}
	if input.TaskID != "" && (!validID(input.TaskID) || input.Type != "start" || input.Phase != "focus") {
		return timer.Command{}, fmt.Errorf("invalid task association")
	}
	if _, valid := validPhases[input.Phase]; !valid {
		return timer.Command{}, fmt.Errorf("invalid command phase")
	}
	if input.PlannedDurationMs == nil || *input.PlannedDurationMs < int64(time.Minute/time.Millisecond) ||
		*input.PlannedDurationMs > int64(4*time.Hour/time.Millisecond) {
		return timer.Command{}, fmt.Errorf("invalid timer duration")
	}
	occurredAt, err := parseOperationClock(input.OccurredAt, input.HLCWallMs, input.HLCCounter, false, now)
	if err != nil {
		return timer.Command{}, fmt.Errorf("invalid hybrid clock: %w", err)
	}
	if input.ObservedElapsedMs == nil {
		return timer.Command{}, fmt.Errorf("missing observed elapsed")
	}
	return timer.Command{
		ID: input.ID, DeviceID: deviceID, DeviceSequence: *input.DeviceSequence, TimerID: input.TimerID,
		TaskID: input.TaskID, Type: input.Type, Phase: input.Phase, PlannedDurationMs: *input.PlannedDurationMs,
		OccurredAt: occurredAt, HLCWallMs: *input.HLCWallMs, HLCCounter: *input.HLCCounter,
		ObservedElapsedMs: *input.ObservedElapsedMs,
	}, nil
}

func parseTaskOperations(ctx context.Context, deviceID string, inputs []syncTaskOperationJSON, now time.Time) ([]task.Operation, error) {
	titles, err := validateTaskOperationInputs(inputs)
	if err != nil {
		return nil, err
	}
	identities, err := task.SharedIdentities(ctx, titles)
	if task.IsSharedIdentityRuntimeError(err) {
		return nil, &requestRuntimeError{cause: err}
	}
	if err != nil {
		return nil, fmt.Errorf("invalid task title")
	}
	operations := make([]task.Operation, 0, len(inputs))
	identityIndex := 0
	for _, input := range inputs {
		title := ""
		if input.Type == "upsert" {
			identity := identities[identityIndex]
			identityIndex++
			if identity.ID != input.TaskID {
				return nil, fmt.Errorf("invalid task title")
			}
			title = identity.Title
		}
		operation, err := parseTaskOperation(deviceID, input, title, now)
		if err != nil {
			return nil, err
		}
		operations = append(operations, operation)
	}
	return operations, nil
}

func validateTaskOperationInputs(inputs []syncTaskOperationJSON) ([]string, error) {
	titles := make([]string, 0, len(inputs))
	seen := make(map[string]struct{}, len(inputs))
	for _, input := range inputs {
		if !validID(input.ID) || !validID(input.TaskID) {
			return nil, fmt.Errorf("invalid task operation identity")
		}
		if _, duplicate := seen[input.ID]; duplicate {
			return nil, fmt.Errorf("duplicate task operation identity")
		}
		seen[input.ID] = struct{}{}
		if _, valid := validTaskOperationTypes[input.Type]; !valid {
			return nil, fmt.Errorf("invalid task operation type")
		}
		if input.Type == "upsert" {
			titles = append(titles, input.Title)
		} else if input.Title != "" {
			return nil, fmt.Errorf("delete task operation has title")
		}
	}
	return titles, nil
}

func parseTaskOperation(deviceID string, input syncTaskOperationJSON, title string, now time.Time) (task.Operation, error) {
	occurredAt, err := parseOperationClock(input.OccurredAt, input.HLCWallMs, input.HLCCounter, false, now)
	if err != nil {
		return task.Operation{}, fmt.Errorf("invalid task operation clock: %w", err)
	}
	return task.Operation{
		ID: input.ID, DeviceID: deviceID, TaskID: input.TaskID, Type: input.Type, Title: title,
		OccurredAt: occurredAt, HLCWallMs: *input.HLCWallMs, HLCCounter: *input.HLCCounter,
	}, nil
}

func parseDurationOperations(deviceID string, inputs []syncDurationOperationJSON, now time.Time) ([]store.DurationOperation, error) {
	operations := make([]store.DurationOperation, 0, len(inputs))
	seen := make(map[string]struct{}, len(inputs))
	for _, input := range inputs {
		if !validID(input.ID) {
			return nil, fmt.Errorf("invalid duration operation identity")
		}
		if _, duplicate := seen[input.ID]; duplicate {
			return nil, fmt.Errorf("duplicate duration operation identity")
		}
		seen[input.ID] = struct{}{}
		if _, valid := validPhases[input.Phase]; !valid {
			return nil, fmt.Errorf("invalid duration phase")
		}
		if input.DurationMs == nil || *input.DurationMs < 60_000 || *input.DurationMs > 10_800_000 || *input.DurationMs%60_000 != 0 {
			return nil, fmt.Errorf("invalid duration value")
		}
		occurredAt, err := parseOperationClock(input.OccurredAt, input.HLCWallMs, input.HLCCounter, true, now)
		if err != nil {
			return nil, fmt.Errorf("invalid duration operation clock: %w", err)
		}
		operations = append(operations, store.DurationOperation{
			ID: input.ID, DeviceID: deviceID, Phase: input.Phase, DurationMs: *input.DurationMs,
			OccurredAt: occurredAt, HLCWallMs: *input.HLCWallMs, HLCCounter: *input.HLCCounter,
		})
	}
	return operations, nil
}

func parseAutoStartOperations(deviceID string, inputs []syncAutoStartOperationJSON, now time.Time) ([]store.AutoStartOperation, error) {
	operations := make([]store.AutoStartOperation, 0, len(inputs))
	seen := make(map[string]struct{}, len(inputs))
	for _, input := range inputs {
		if !validID(input.ID) {
			return nil, fmt.Errorf("invalid auto-start operation identity")
		}
		if _, duplicate := seen[input.ID]; duplicate {
			return nil, fmt.Errorf("duplicate auto-start operation identity")
		}
		seen[input.ID] = struct{}{}
		if input.Enabled == nil {
			return nil, fmt.Errorf("missing auto-start value")
		}
		occurredAt, err := parseOperationClock(input.OccurredAt, input.HLCWallMs, input.HLCCounter, true, now)
		if err != nil {
			return nil, fmt.Errorf("invalid auto-start operation clock: %w", err)
		}
		operations = append(operations, store.AutoStartOperation{
			ID: input.ID, DeviceID: deviceID, Enabled: *input.Enabled, OccurredAt: occurredAt,
			HLCWallMs: *input.HLCWallMs, HLCCounter: *input.HLCCounter,
		})
	}
	return operations, nil
}

func parseSelectedTaskOperations(deviceID string, inputs []syncSelectedTaskOperationJSON, now time.Time) ([]store.SelectedTaskOperation, error) {
	operations := make([]store.SelectedTaskOperation, 0, len(inputs))
	seen := make(map[string]struct{}, len(inputs))
	for _, input := range inputs {
		if !validID(input.ID) {
			return nil, fmt.Errorf("invalid selected-task operation identity")
		}
		if _, duplicate := seen[input.ID]; duplicate {
			return nil, fmt.Errorf("duplicate selected-task operation identity")
		}
		seen[input.ID] = struct{}{}
		taskID, err := parseNullableTaskID(input.TaskID)
		if err != nil {
			return nil, err
		}
		occurredAt, err := parseOperationClock(input.OccurredAt, input.HLCWallMs, input.HLCCounter, true, now)
		if err != nil {
			return nil, fmt.Errorf("invalid selected-task operation clock: %w", err)
		}
		operations = append(operations, store.SelectedTaskOperation{
			ID: input.ID, DeviceID: deviceID, TaskID: taskID, OccurredAt: occurredAt,
			HLCWallMs: *input.HLCWallMs, HLCCounter: *input.HLCCounter,
		})
	}
	return operations, nil
}
