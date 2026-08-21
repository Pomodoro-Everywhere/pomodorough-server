package store

import (
	"context"
	"reflect"
	"testing"
	"time"

	"pomodorough/internal/task"
	"pomodorough/internal/timer"
)

func TestSharedCoreEnvelopeFailsClosed(t *testing.T) {
	invalid := []string{
		`{}`,
		`{"ok":true}`,
		`{"ok":true,"value":null}`,
		`{"ok":true,"value":{},"error":"bad"}`,
		`{"ok":false}`,
		`{"ok":false,"error":"bad","value":{}}`,
		`{"ok":true,"value":{},"extra":1}`,
		`{"ok":true,"value":{}} trailing`,
	}
	for _, encoded := range invalid {
		var output map[string]any
		if err := decodeCoreEnvelope("probe", []byte(encoded), &output); err == nil {
			t.Fatalf("accepted malformed envelope %s", encoded)
		}
	}
	var output map[string]any
	if err := decodeCoreEnvelope("probe", []byte(`{"ok":true,"value":{"answer":42}}`), &output); err != nil {
		t.Fatal(err)
	}
	if output["answer"] != float64(42) {
		t.Fatalf("unexpected output %#v", output)
	}
}

func TestSharedCoreReducersMatchGoOracles(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 21, 12, 30, 0, 0, time.UTC)
	commands := []timer.Command{
		{
			ID: "018f0000-0000-7000-8000-000000000001", DeviceID: "device-a", DeviceSequence: 1,
			TimerID: "018f0000-0000-7000-8000-000000000011", TaskID: "task-a", Type: "start", Phase: "focus",
			PlannedDurationMs: 1_500_000, OccurredAt: now.Add(-20 * time.Minute), HLCWallMs: 100, ObservedElapsedMs: 0,
		},
		{
			ID: "018f0000-0000-7000-8000-000000000002", DeviceID: "device-b", DeviceSequence: 9,
			TimerID: "018f0000-0000-7000-8000-000000000011", Type: "pause", Phase: "focus",
			PlannedDurationMs: 1_500_000, OccurredAt: now.Add(-10 * time.Minute), HLCWallMs: 101, ObservedElapsedMs: 600_000,
		},
	}
	wantTimer := timer.Reduce(commands, now)
	gotTimer, err := reduceTimerWithSharedCore(ctx, commands, now)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gotTimer, wantTimer) {
		t.Fatalf("shared timer mismatch\ngot:  %#v\nwant: %#v", gotTimer, wantTimer)
	}

	taskOps := []task.Operation{
		{ID: "op-a", DeviceID: "device-a", TaskID: "task-a", Type: "upsert", Title: "A", OccurredAt: now, HLCWallMs: 1},
		{ID: "op-b", DeviceID: "device-b", TaskID: "task-a", Type: "delete", OccurredAt: now, HLCWallMs: 2},
		{ID: "op-c", DeviceID: "device-a", TaskID: "task-b", Type: "upsert", Title: "B", OccurredAt: now, HLCWallMs: 3},
	}
	wantTasks, wantTaskWinners := reduceTasks(taskOps)
	gotTasks, gotTaskWinners, err := reduceTasksWithSharedCore(ctx, taskOps)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gotTasks, wantTasks) || !reflect.DeepEqual(gotTaskWinners, wantTaskWinners) {
		t.Fatalf("shared task mismatch: got %#v/%#v want %#v/%#v", gotTasks, gotTaskWinners, wantTasks, wantTaskWinners)
	}

	durationOps := []DurationOperation{
		{ID: "duration-a", DeviceID: "device-a", Phase: "focus", DurationMs: 1_800_000, OccurredAt: now, HLCWallMs: 1},
		{ID: "duration-b", DeviceID: "device-b", Phase: "focus", DurationMs: 2_100_000, OccurredAt: now, HLCWallMs: 2},
	}
	wantDurations, wantDurationWinners := reduceDurations(durationOps)
	gotDurations, gotDurationWinners, err := reduceDurationsWithSharedCore(ctx, durationOps)
	if err != nil || !reflect.DeepEqual(gotDurations, wantDurations) || !reflect.DeepEqual(gotDurationWinners, wantDurationWinners) {
		t.Fatalf("shared duration mismatch: err=%v got %#v/%#v want %#v/%#v", err, gotDurations, gotDurationWinners, wantDurations, wantDurationWinners)
	}

	autoOps := []AutoStartOperation{
		{ID: "auto-a", DeviceID: "device-a", Enabled: true, OccurredAt: now, HLCWallMs: 1},
		{ID: "auto-b", DeviceID: "device-b", Enabled: false, OccurredAt: now, HLCWallMs: 2},
	}
	wantAuto, wantAutoWinner := reduceAutoStart(autoOps)
	gotAuto, gotAutoWinner, err := reduceAutoStartWithSharedCore(ctx, autoOps)
	if err != nil || gotAuto != wantAuto || gotAutoWinner != wantAutoWinner {
		t.Fatalf("shared auto-start mismatch: err=%v got %v/%q want %v/%q", err, gotAuto, gotAutoWinner, wantAuto, wantAutoWinner)
	}

	selected := "task-b"
	selectedOps := []SelectedTaskOperation{
		{ID: "selected-a", DeviceID: "device-a", TaskID: &selected, OccurredAt: now, HLCWallMs: 1},
	}
	wantSelected, wantSelectedWinner := reduceSelectedTask(selectedOps, gotTasks)
	gotSelected, gotSelectedWinner, err := reduceSelectedTaskWithSharedCore(ctx, selectedOps, gotTasks)
	if err != nil || !reflect.DeepEqual(gotSelected, wantSelected) || gotSelectedWinner != wantSelectedWinner {
		t.Fatalf("shared selected-task mismatch: err=%v got %#v/%q want %#v/%q", err, gotSelected, gotSelectedWinner, wantSelected, wantSelectedWinner)
	}
}
