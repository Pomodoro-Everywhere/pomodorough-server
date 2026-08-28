package store

import (
	"reflect"
	"testing"
	"time"

	"pomodorough/internal/task"
	"pomodorough/internal/timer"
)

func TestTimerSharedCorePolicyDriftIsAccepted(t *testing.T) {
	command := authorityTimerCommand()
	output := coreTimerResult{
		Canonical: coreNullable[timer.CanonicalTimer]{present: true},
		History:   []timer.HistoryItem{},
		Sessions:  []coreTimerSession{},
		Outcomes: map[string]coreTimerOutcome{
			command.ID: authorityTimerOutcome("ignored", "future SharedCore policy"),
		},
	}
	got, err := timerResultFromCore(output, []timer.Command{command})
	if err != nil {
		t.Fatal(err)
	}
	legacyOracle := timer.Result{Canonical: &timer.CanonicalTimer{ID: command.TimerID}}
	if reflect.DeepEqual(got, legacyOracle) || got.Outcomes[command.ID].Outcome != "ignored" {
		t.Fatalf("SharedCore policy drift was not preserved: %#v", got)
	}
}

func TestTimerEquivalentTimestampRepresentationsAreAccepted(t *testing.T) {
	command := authorityTimerCommand()
	output := validAuthorityTimerOutput(command)
	alternateAnchor := command.OccurredAt.Format("2006-01-02T15:04:05") + "+00:00"
	output.Canonical.value.AnchorAt = alternateAnchor
	got, err := timerResultFromCore(output, []timer.Command{command})
	if err != nil {
		t.Fatal(err)
	}
	if got.Canonical == nil || got.Canonical.AnchorAt != alternateAnchor {
		t.Fatalf("SharedCore timestamp was rewritten: %#v", got.Canonical)
	}
}

func TestTaskSharedCorePolicyDriftIsAccepted(t *testing.T) {
	operations := []task.Operation{{ID: "task-op", TaskID: "task-a", Type: "upsert", Title: "A"}}
	legacyTasks, _ := reduceTasks(operations)
	output := coreTaskResult{
		Tasks:               []task.Task{},
		WinningOperationIDs: map[string]string{"task-a": "task-op"},
	}
	got, winners, err := taskResultFromCore(output, operations)
	if err != nil {
		t.Fatal(err)
	}
	if reflect.DeepEqual(got, legacyTasks) || winners["task-a"] != "task-op" {
		t.Fatalf("SharedCore policy drift was not preserved: %#v/%#v", got, winners)
	}
}

func TestDurationSharedCorePolicyDriftIsAccepted(t *testing.T) {
	operations := []DurationOperation{{ID: "duration-op", Phase: "focus", DurationMs: 1_800_000}}
	legacy, _ := reduceDurations(operations)
	output := coreDurationResult{
		DurationsMs: map[string]int64{
			"focus": 2_400_000, "short_break": 300_000, "long_break": 900_000,
		},
		WinningOperationIDs: map[string]string{"focus": "duration-op"},
	}
	got, winners, err := durationResultFromCore(output, operations)
	if err != nil {
		t.Fatal(err)
	}
	if got == legacy || len(winners) != 1 {
		t.Fatalf("SharedCore policy drift was not preserved: %#v/%#v", got, winners)
	}
}

func TestAutoStartSharedCorePolicyDriftIsAccepted(t *testing.T) {
	operations := []AutoStartOperation{{ID: "auto-op", Enabled: true}}
	legacy, _ := reduceAutoStart(operations)
	value, winner := false, "auto-op"
	output := coreAutoStartResult{
		AutoStartBreaks:    &value,
		WinningOperationID: coreNullable[string]{present: true, value: &winner},
	}
	got, gotWinner, err := autoStartResultFromCore(output, operations)
	if err != nil {
		t.Fatal(err)
	}
	if got == legacy || gotWinner != winner {
		t.Fatalf("SharedCore policy drift was not preserved: %t/%q", got, gotWinner)
	}
}

func TestSelectedTaskSharedCorePolicyDriftIsAccepted(t *testing.T) {
	selected, winner := "task-a", "selected-op"
	tasks := []task.Task{{ID: selected, Title: "A"}}
	operations := []SelectedTaskOperation{{ID: winner, TaskID: &selected}}
	legacy, _ := reduceSelectedTask(operations, tasks)
	output := coreSelectedTaskResult{
		SelectedTaskID:     coreNullable[string]{present: true},
		WinningOperationID: coreNullable[string]{present: true, value: &winner},
	}
	got, gotWinner, err := selectedTaskResultFromCore(output, operations, tasks)
	if err != nil {
		t.Fatal(err)
	}
	if reflect.DeepEqual(got, legacy) || gotWinner != winner {
		t.Fatalf("SharedCore policy drift was not preserved: %#v/%q", got, gotWinner)
	}
}

func TestMalformedSharedCoreOutputsFailClosed(t *testing.T) {
	command := authorityTimerCommand()
	invalidTimer := validAuthorityTimerOutput(command)
	invalidTimer.Canonical.value.Status = "paused"
	if _, err := timerResultFromCore(invalidTimer, []timer.Command{command}); err == nil {
		t.Fatal("accepted canonical timer inconsistent with session")
	}
	missingOutcomeField := validAuthorityTimerOutput(command)
	missingOutcomeField.Outcomes[command.ID] = coreTimerOutcome{}
	if _, err := timerResultFromCore(missingOutcomeField, []timer.Command{command}); err == nil {
		t.Fatal("accepted timer outcome with missing fields")
	}
	if _, _, err := taskResultFromCore(coreTaskResult{Tasks: []task.Task{}}, nil); err == nil {
		t.Fatal("accepted task output with missing winners")
	}
	invalidDuration := coreDurationResult{DurationsMs: map[string]int64{
		"focus": 1, "short_break": 300_000, "long_break": 900_000,
	}, WinningOperationIDs: map[string]string{}}
	if _, _, err := durationResultFromCore(invalidDuration, nil); err == nil {
		t.Fatal("accepted out-of-bounds duration")
	}
}

func TestInconsistentSharedCoreReferencesFailClosed(t *testing.T) {
	value, unknown := true, "unknown-op"
	autoOutput := coreAutoStartResult{
		AutoStartBreaks:    &value,
		WinningOperationID: coreNullable[string]{present: true, value: &unknown},
	}
	if _, _, err := autoStartResultFromCore(autoOutput, nil); err == nil {
		t.Fatal("accepted unknown auto-start winner")
	}
	selectedOutput := coreSelectedTaskResult{
		SelectedTaskID:     coreNullable[string]{present: true, value: &unknown},
		WinningOperationID: coreNullable[string]{present: true},
	}
	if _, _, err := selectedTaskResultFromCore(selectedOutput, nil, nil); err == nil {
		t.Fatal("accepted inactive selected task")
	}
}

func TestSharedCoreOutputSchemaFailsClosed(t *testing.T) {
	var output coreTaskResult
	encoded := []byte(`{"ok":true,"value":{"tasks":[],"winningOperationIds":{},"extra":1}}`)
	if err := decodeCoreEnvelope("task.reduce.v1", encoded, &output); err == nil {
		t.Fatal("accepted unknown SharedCore output field")
	}
	encoded = []byte(`{"ok":true,"value":{"tasks":[],"winningOperationIds":{}}}`)
	if err := decodeCoreEnvelope("task.reduce.v1", encoded, &output); err != nil {
		t.Fatal(err)
	}
}

func authorityTimerCommand() timer.Command {
	at := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	return timer.Command{
		ID: "timer-command", DeviceID: "device-a", TimerID: "timer-a",
		Type: "start", Phase: "focus", PlannedDurationMs: 1_500_000, OccurredAt: at,
	}
}

func validAuthorityTimerOutput(command timer.Command) coreTimerResult {
	at := command.OccurredAt.Format(time.RFC3339Nano)
	intent := &timer.Intent{Type: command.Type, CommandID: command.ID, OccurredAt: at}
	session := coreTimerSession{
		TimerID: command.TimerID, Phase: command.Phase, Status: "running",
		PlannedDurationMs: command.PlannedDurationMs, AnchorAt: at, StartedAt: at,
		StartedByDeviceID: command.DeviceID, LastCommandID: command.ID, LastIntent: intent,
	}
	canonical := &timer.CanonicalTimer{
		ID: command.TimerID, Phase: command.Phase, Status: "running",
		PlannedDurationMs: command.PlannedDurationMs, AnchorAt: at,
		StartedByDeviceID: command.DeviceID, LastIntent: intent,
	}
	return coreTimerResult{
		Canonical: coreNullable[timer.CanonicalTimer]{present: true, value: canonical},
		History:   []timer.HistoryItem{}, Sessions: []coreTimerSession{session},
		Outcomes: map[string]coreTimerOutcome{command.ID: authorityTimerOutcome("applied", "")},
	}
}

func authorityTimerOutcome(outcome, reason string) coreTimerOutcome {
	return coreTimerOutcome{Outcome: &outcome, Reason: &reason}
}
