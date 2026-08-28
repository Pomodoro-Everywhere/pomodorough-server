package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"
	"unicode/utf8"

	"pomodorough/internal/sharedcore"
	"pomodorough/internal/task"
	"pomodorough/internal/timer"
)

func accountSharedCore(ctx context.Context) (*sharedcore.Core, error) {
	core, err := sharedcore.Default(ctx)
	if err != nil {
		return nil, err
	}
	if core == nil {
		return nil, errors.New("shared core is unavailable")
	}
	return core, nil
}

type coreEnvelope struct {
	OK    *bool           `json:"ok"`
	Value json.RawMessage `json:"value"`
	Error *string         `json:"error"`
}

func callAccountSharedCore(ctx context.Context, operation string, input, output any) error {
	payload, err := json.Marshal(input)
	if err != nil {
		return fmt.Errorf("encode %s input: %w", operation, err)
	}
	core, err := accountSharedCore(ctx)
	if err != nil {
		return err
	}
	result, err := core.Call(ctx, operation, payload)
	if err != nil {
		return err
	}
	if !utf8.Valid(result) {
		return fmt.Errorf("shared core %s returned invalid UTF-8", operation)
	}
	return decodeCoreEnvelope(operation, result, output)
}

type coreJSONCall func(context.Context, string, any, any) error

type coreHLC struct {
	WallMs  int64 `json:"wallMs"`
	Counter int64 `json:"counter"`
}

type coreHLCHeadInput struct {
	PhysicalNowMs int64     `json:"physicalNowMs"`
	Observed      []coreHLC `json:"observed"`
}

type coreHLCHeadOutput struct {
	WallMs  *int64 `json:"wallMs"`
	Counter *int64 `json:"counter"`
}

func hlcHeadWithCore(ctx context.Context, call coreJSONCall, physicalNowMs int64, observed []coreHLC) (coreHLC, error) {
	input := coreHLCHeadInput{PhysicalNowMs: physicalNowMs, Observed: observed}
	var output coreHLCHeadOutput
	if err := call(ctx, "hlc.head.v1", input, &output); err != nil {
		return coreHLC{}, err
	}
	if output.WallMs == nil || output.Counter == nil {
		return coreHLC{}, errors.New("shared HLC head is missing required fields")
	}
	head := coreHLC{WallMs: *output.WallMs, Counter: *output.Counter}
	if err := validateCoreHLCHead(head, input); err != nil {
		return coreHLC{}, err
	}
	return head, nil
}

func validateCoreHLCHead(head coreHLC, input coreHLCHeadInput) error {
	if head.WallMs < 0 || head.WallMs > MaxSafeRevision || head.Counter < 0 || head.Counter > MaxSafeRevision {
		return errors.New("shared HLC head is outside JavaScript-safe bounds")
	}
	if head == (coreHLC{WallMs: input.PhysicalNowMs}) {
		return nil
	}
	for _, observed := range input.Observed {
		if head == observed {
			return nil
		}
	}
	return errors.New("shared HLC head does not reference an input clock")
}

func decodeCoreEnvelope(operation string, result []byte, output any) error {
	decoder := json.NewDecoder(bytes.NewReader(result))
	decoder.DisallowUnknownFields()
	var envelope coreEnvelope
	if err := decoder.Decode(&envelope); err != nil {
		return fmt.Errorf("decode %s envelope: %w", operation, err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("decode %s envelope: trailing JSON", operation)
	}
	if envelope.OK == nil {
		return fmt.Errorf("decode %s envelope: missing boolean ok", operation)
	}
	if !*envelope.OK {
		if envelope.Error == nil || *envelope.Error == "" || len(envelope.Value) != 0 {
			return fmt.Errorf("decode %s envelope: malformed failure", operation)
		}
		return fmt.Errorf("shared core %s: %s", operation, *envelope.Error)
	}
	if envelope.Error != nil || len(envelope.Value) == 0 || bytes.Equal(bytes.TrimSpace(envelope.Value), []byte("null")) {
		return fmt.Errorf("decode %s envelope: malformed success", operation)
	}
	if err := decodeCoreValue(envelope.Value, output); err != nil {
		return fmt.Errorf("decode %s output: %w", operation, err)
	}
	return nil
}

func decodeCoreValue(value []byte, output any) error {
	decoder := json.NewDecoder(bytes.NewReader(value))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("trailing JSON")
	}
	return nil
}

type coreNullable[T any] struct {
	present bool
	value   *T
}

func (nullable *coreNullable[T]) UnmarshalJSON(data []byte) error {
	nullable.present = true
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		nullable.value = nil
		return nil
	}
	var value T
	if err := decodeCoreValue(data, &value); err != nil {
		return err
	}
	nullable.value = &value
	return nil
}

type coreTimerCommand struct {
	ID                string  `json:"id"`
	DeviceID          string  `json:"deviceId"`
	DeviceSequence    int64   `json:"deviceSequence"`
	TimerID           string  `json:"timerId"`
	TaskID            *string `json:"taskId,omitempty"`
	Type              string  `json:"type"`
	Phase             string  `json:"phase"`
	PlannedDurationMs int64   `json:"plannedDurationMs"`
	OccurredAt        string  `json:"occurredAt"`
	HLCWallMs         int64   `json:"hlcWallMs"`
	HLCCounter        int64   `json:"hlcCounter"`
	ObservedElapsedMs int64   `json:"observedElapsedMs"`
}

type coreTimerSession struct {
	TimerID             string        `json:"timerId"`
	TaskID              string        `json:"taskId"`
	Phase               string        `json:"phase"`
	Status              string        `json:"status"`
	PlannedDurationMs   int64         `json:"plannedDurationMs"`
	ElapsedAtAnchorMs   int64         `json:"elapsedAtAnchorMs"`
	AnchorAt            string        `json:"anchorAt"`
	StartedAt           string        `json:"startedAt"`
	StartedByDeviceID   string        `json:"startedByDeviceId"`
	EndedAt             string        `json:"endedAt"`
	LastCommandID       string        `json:"lastCommandId"`
	TerminalCommandID   string        `json:"terminalCommandId"`
	SupersededByTimerID string        `json:"supersededByTimerId"`
	LastIntent          *timer.Intent `json:"lastIntent"`
}

type coreTimerResult struct {
	Canonical coreNullable[timer.CanonicalTimer] `json:"canonicalTimer"`
	History   []timer.HistoryItem                `json:"history"`
	Sessions  []coreTimerSession                 `json:"sessions"`
	Outcomes  map[string]coreTimerOutcome        `json:"outcomes"`
}

type coreTimerOutcome struct {
	Outcome *string `json:"outcome"`
	Reason  *string `json:"reason"`
}

func reduceTimerWithSharedCore(ctx context.Context, commands []timer.Command, now time.Time) (timer.Result, error) {
	var output coreTimerResult
	if err := callAccountSharedCore(ctx, "timer.reduce.v1", map[string]any{
		"commands": coreTimerCommands(commands),
		"now":      now.UTC().Format(time.RFC3339Nano),
	}, &output); err != nil {
		return timer.Result{}, err
	}
	return timerResultFromCore(output, commands)
}

func coreTimerCommands(commands []timer.Command) []coreTimerCommand {
	wireCommands := make([]coreTimerCommand, 0, len(commands))
	for _, command := range commands {
		var taskID *string
		if command.TaskID != "" {
			value := command.TaskID
			taskID = &value
		}
		wireCommands = append(wireCommands, coreTimerCommand{
			ID: command.ID, DeviceID: command.DeviceID, DeviceSequence: command.DeviceSequence,
			TimerID: command.TimerID, TaskID: taskID, Type: command.Type, Phase: command.Phase,
			PlannedDurationMs: command.PlannedDurationMs, OccurredAt: command.OccurredAt.UTC().Format(time.RFC3339Nano),
			HLCWallMs: command.HLCWallMs, HLCCounter: command.HLCCounter, ObservedElapsedMs: command.ObservedElapsedMs,
		})
	}
	return wireCommands
}

func timerResultFromCore(output coreTimerResult, commands []timer.Command) (timer.Result, error) {
	if err := validateCoreTimerResult(output, commands); err != nil {
		return timer.Result{}, fmt.Errorf("validate shared timer output: %w", err)
	}
	result := timer.Result{
		Canonical: output.Canonical.value,
		History:   output.History,
		Sessions:  make([]timer.Session, 0, len(output.Sessions)),
		Outcomes:  timerOutcomesFromCore(output.Outcomes),
	}
	if len(result.History) == 0 {
		result.History = nil
	}
	for _, session := range output.Sessions {
		decoded, err := timerSessionFromCore(session)
		if err != nil {
			return timer.Result{}, err
		}
		result.Sessions = append(result.Sessions, decoded)
	}
	if len(result.Sessions) == 0 {
		result.Sessions = nil
	}
	return result, nil
}

func timerOutcomesFromCore(input map[string]coreTimerOutcome) map[string]timer.Outcome {
	outcomes := make(map[string]timer.Outcome, len(input))
	for commandID, outcome := range input {
		outcomes[commandID] = timer.Outcome{Outcome: *outcome.Outcome, Reason: *outcome.Reason}
	}
	return outcomes
}

func timerSessionFromCore(session coreTimerSession) (timer.Session, error) {
	anchorAt, err := time.Parse(time.RFC3339Nano, session.AnchorAt)
	if err != nil {
		return timer.Session{}, fmt.Errorf("parse shared timer anchor: %w", err)
	}
	startedAt, err := time.Parse(time.RFC3339Nano, session.StartedAt)
	if err != nil {
		return timer.Session{}, fmt.Errorf("parse shared timer start: %w", err)
	}
	var endedAt time.Time
	if session.EndedAt != "" {
		endedAt, err = time.Parse(time.RFC3339Nano, session.EndedAt)
		if err != nil {
			return timer.Session{}, fmt.Errorf("parse shared timer end: %w", err)
		}
	}
	return timer.Session{
		TimerID: session.TimerID, TaskID: session.TaskID, Phase: session.Phase, Status: session.Status,
		PlannedDurationMs: session.PlannedDurationMs, ElapsedAtAnchorMs: session.ElapsedAtAnchorMs,
		AnchorAt: anchorAt, StartedAt: startedAt, StartedByDeviceID: session.StartedByDeviceID, EndedAt: endedAt,
		LastCommandID: session.LastCommandID, TerminalCommandID: session.TerminalCommandID,
		SupersededByTimerID: session.SupersededByTimerID, LastIntent: session.LastIntent,
	}, nil
}

type coreOperationClock struct {
	ID         string `json:"id"`
	DeviceID   string `json:"deviceId"`
	OccurredAt string `json:"occurredAt"`
	HLCWallMs  int64  `json:"hlcWallMs"`
	HLCCounter int64  `json:"hlcCounter"`
}

type coreTaskOperation struct {
	coreOperationClock
	TaskID string `json:"taskId"`
	Type   string `json:"type"`
	Title  string `json:"title,omitempty"`
}

type coreTaskResult struct {
	Tasks               []task.Task       `json:"tasks"`
	WinningOperationIDs map[string]string `json:"winningOperationIds"`
}

func reduceTasksWithSharedCore(ctx context.Context, operations []task.Operation) ([]task.Task, map[string]string, error) {
	wire := make([]coreTaskOperation, 0, len(operations))
	for _, operation := range operations {
		wire = append(wire, coreTaskOperation{
			coreOperationClock: coreOperationClock{
				ID: operation.ID, DeviceID: operation.DeviceID,
				OccurredAt: operation.OccurredAt.UTC().Format(time.RFC3339Nano),
				HLCWallMs:  operation.HLCWallMs, HLCCounter: operation.HLCCounter,
			},
			TaskID: operation.TaskID, Type: operation.Type, Title: operation.Title,
		})
	}
	var output coreTaskResult
	if err := callAccountSharedCore(ctx, "task.reduce.v1", map[string]any{"operations": wire}, &output); err != nil {
		return nil, nil, err
	}
	return taskResultFromCore(output, operations)
}

type coreDurationOperation struct {
	coreOperationClock
	Phase      string `json:"phase"`
	DurationMs int64  `json:"durationMs"`
}

type coreDurationResult struct {
	DurationsMs         map[string]int64  `json:"durationsMs"`
	WinningOperationIDs map[string]string `json:"winningOperationIds"`
}

func reduceDurationsWithSharedCore(ctx context.Context, operations []DurationOperation) (DurationsMs, map[string]struct{}, error) {
	wire := make([]coreDurationOperation, 0, len(operations))
	for _, operation := range operations {
		wire = append(wire, coreDurationOperation{
			coreOperationClock: coreOperationClock{
				ID: operation.ID, DeviceID: operation.DeviceID,
				OccurredAt: operation.OccurredAt.UTC().Format(time.RFC3339Nano),
				HLCWallMs:  operation.HLCWallMs, HLCCounter: operation.HLCCounter,
			},
			Phase: operation.Phase, DurationMs: operation.DurationMs,
		})
	}
	var output coreDurationResult
	if err := callAccountSharedCore(ctx, "duration.reduce.v1", map[string]any{"operations": wire}, &output); err != nil {
		return DurationsMs{}, nil, err
	}
	return durationResultFromCore(output, operations)
}

type coreAutoStartOperation struct {
	coreOperationClock
	Enabled bool `json:"enabled"`
}

type coreAutoStartResult struct {
	AutoStartBreaks    *bool                `json:"autoStartBreaks"`
	WinningOperationID coreNullable[string] `json:"winningOperationId"`
}

func reduceAutoStartWithSharedCore(ctx context.Context, operations []AutoStartOperation) (bool, string, error) {
	wire := make([]coreAutoStartOperation, 0, len(operations))
	for _, operation := range operations {
		wire = append(wire, coreAutoStartOperation{
			coreOperationClock: coreOperationClock{
				ID: operation.ID, DeviceID: operation.DeviceID,
				OccurredAt: operation.OccurredAt.UTC().Format(time.RFC3339Nano),
				HLCWallMs:  operation.HLCWallMs, HLCCounter: operation.HLCCounter,
			},
			Enabled: operation.Enabled,
		})
	}
	var output coreAutoStartResult
	if err := callAccountSharedCore(ctx, "autoStart.reduce.v1", map[string]any{"operations": wire}, &output); err != nil {
		return false, "", err
	}
	return autoStartResultFromCore(output, operations)
}

type coreSelectedTaskOperation struct {
	coreOperationClock
	TaskID *string `json:"taskId"`
}

type coreSelectedTaskResult struct {
	SelectedTaskID     coreNullable[string] `json:"selectedTaskId"`
	WinningOperationID coreNullable[string] `json:"winningOperationId"`
}

func reduceSelectedTaskWithSharedCore(ctx context.Context, operations []SelectedTaskOperation, tasks []task.Task) (*string, string, error) {
	wire := make([]coreSelectedTaskOperation, 0, len(operations))
	for _, operation := range operations {
		wire = append(wire, coreSelectedTaskOperation{
			coreOperationClock: coreOperationClock{
				ID: operation.ID, DeviceID: operation.DeviceID,
				OccurredAt: operation.OccurredAt.UTC().Format(time.RFC3339Nano),
				HLCWallMs:  operation.HLCWallMs, HLCCounter: operation.HLCCounter,
			},
			TaskID: operation.TaskID,
		})
	}
	activeTaskIDs := make([]string, 0, len(tasks))
	for _, current := range tasks {
		activeTaskIDs = append(activeTaskIDs, current.ID)
	}
	var output coreSelectedTaskResult
	if err := callAccountSharedCore(ctx, "selectedTask.reduce.v1", map[string]any{
		"operations": wire, "activeTaskIds": activeTaskIDs,
	}, &output); err != nil {
		return nil, "", err
	}
	return selectedTaskResultFromCore(output, operations, tasks)
}
