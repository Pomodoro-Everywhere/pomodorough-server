package store

import (
	"context"
	"strings"
	"testing"
	"time"

	"pomodorough/internal/authn"
	"pomodorough/internal/task"
	"pomodorough/internal/timer"
)

func TestSyncDuplicateCommandIsIdempotent(t *testing.T) {
	ctx := context.Background()
	userStore, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	userID := authn.UserID([]byte(strings.Repeat("s", 32)), "https://accounts.google.com", "subject")
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	request := SyncRequest{
		DeviceID: "device-0001",
		Commands: []timer.Command{{
			ID: "command-0001", DeviceID: "device-0001", DeviceSequence: 1, TimerID: "timer-000001",
			Type: "start", Phase: "focus", PlannedDurationMs: 25 * 60_000, OccurredAt: now,
			HLCWallMs: now.UnixMilli(), HLCCounter: 0,
		}},
	}

	db, err := userStore.OpenUser(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	first, err := userStore.Sync(ctx, db, userID, request, now)
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision != 1 || len(first.Acknowledgements) != 1 || first.Acknowledgements[0].Outcome != "applied" {
		t.Fatalf("first sync = %#v", first)
	}

	db, err = userStore.OpenExistingUser(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := userStore.Sync(ctx, db, userID, request, now.Add(time.Second))
	if err != nil {
		db.Close()
		t.Fatal(err)
	}
	if second.Revision != 1 || len(second.Acknowledgements) != 1 || second.Acknowledgements[0] != first.Acknowledgements[0] {
		db.Close()
		t.Fatalf("duplicate sync changed acknowledgement or revision: first=%#v second=%#v", first, second)
	}
	var commandCount int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM timer_commands`).Scan(&commandCount); err != nil {
		db.Close()
		t.Fatal(err)
	}
	db.Close()
	if commandCount != 1 {
		t.Fatalf("stored command count = %d, want 1", commandCount)
	}
}

func TestSyncBatchRevisionAndHistoryPersist(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "sync-history-subject")
	deviceID := "device-0001"
	request := SyncRequest{
		DeviceID: deviceID,
		Commands: []timer.Command{
			testTimerCommand("command-0001", deviceID, "timer-000001", "start", 1, now),
			testTimerCommand("command-0002", deviceID, "timer-000001", "cancel", 2, now.Add(time.Second)),
		},
	}
	result, err := userStore.Sync(ctx, db, userID, request, now.Add(time.Second))
	if err != nil {
		db.Close()
		t.Fatal(err)
	}
	if result.Revision != 1 || len(result.Acknowledgements) != 2 {
		db.Close()
		t.Fatalf("batch sync = %#v", result)
	}
	for index, commandID := range []string{"command-0001", "command-0002"} {
		ack := result.Acknowledgements[index]
		if ack.CommandID != commandID || ack.Outcome != "applied" {
			db.Close()
			t.Fatalf("acknowledgement %d = %#v", index, ack)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	db, err = userStore.OpenExistingUser(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	history, revision, changed, err := userStore.History(ctx, db, userID, now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if changed || revision != 1 || len(history) != 1 || history[0].Status != "cancelled" || history[0].CommandID != "command-0002" {
		t.Fatalf("persisted history=%#v revision=%d", history, revision)
	}
	empty, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: deviceID}, now.Add(3*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if empty.Revision != 1 || len(empty.Acknowledgements) != 0 || empty.History == nil {
		t.Fatalf("empty sync changed state: %#v", empty)
	}
}

func TestSyncTasksAreIdempotentLWWAndRetainHistoryAssociation(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "sync-task-subject")
	defer db.Close()
	deviceID := "device-0001"
	title := "Write tests"
	taskID := task.ID(title)
	upsert := task.Operation{
		ID: "task-operation-0001", DeviceID: deviceID, TaskID: taskID, Type: "upsert", Title: title,
		OccurredAt: now, HLCWallMs: now.UnixMilli(),
	}
	start := testTimerCommand("command-0001", deviceID, "timer-000001", "start", 1, now)
	start.TaskID = taskID
	first, err := userStore.Sync(ctx, db, userID, SyncRequest{
		DeviceID: deviceID, Commands: []timer.Command{start}, TaskOperations: []task.Operation{upsert},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision != 1 || len(first.Tasks) != 1 || first.Tasks[0].ID != taskID || first.CanonicalTimer == nil || first.CanonicalTimer.TaskID != taskID {
		t.Fatalf("first task sync = %#v", first)
	}
	if len(first.TaskAcknowledgements) != 1 || first.TaskAcknowledgements[0].Outcome != "applied" {
		t.Fatalf("first task acknowledgement = %#v", first.TaskAcknowledgements)
	}

	duplicate, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: deviceID, TaskOperations: []task.Operation{upsert}}, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if duplicate.Revision != 1 || len(duplicate.Tasks) != 1 || duplicate.TaskAcknowledgements[0].Outcome != "applied" {
		t.Fatalf("duplicate task sync = %#v", duplicate)
	}

	finish := testTimerCommand("command-0002", deviceID, "timer-000001", "finish", 2, now.Add(2*time.Second))
	deleteOperation := task.Operation{
		ID: "task-operation-0002", DeviceID: deviceID, TaskID: taskID, Type: "delete",
		OccurredAt: now.Add(2 * time.Second), HLCWallMs: now.Add(2 * time.Second).UnixMilli(),
	}
	deleted, err := userStore.Sync(ctx, db, userID, SyncRequest{
		DeviceID: deviceID, Commands: []timer.Command{finish}, TaskOperations: []task.Operation{deleteOperation},
	}, now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if deleted.Revision != 2 || len(deleted.Tasks) != 0 || len(deleted.History) != 1 || deleted.History[0].TaskID != taskID {
		t.Fatalf("deleted task sync = %#v", deleted)
	}

	staleUpsert := upsert
	staleUpsert.ID = "task-operation-0003"
	stale, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: deviceID, TaskOperations: []task.Operation{staleUpsert}}, now.Add(3*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if stale.Revision != 3 || len(stale.Tasks) != 0 || stale.TaskAcknowledgements[0].Outcome != "ignored" {
		t.Fatalf("stale recreation won LWW: %#v", stale)
	}

	recreate := upsert
	recreate.ID = "task-operation-0004"
	recreate.OccurredAt = now.Add(4 * time.Second)
	recreate.HLCWallMs = recreate.OccurredAt.UnixMilli()
	recreated, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: deviceID, TaskOperations: []task.Operation{recreate}}, now.Add(4*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if recreated.Revision != 4 || len(recreated.Tasks) != 1 || recreated.Tasks[0].ID != taskID || recreated.History[0].TaskID != taskID {
		t.Fatalf("task recreation did not restore identity: %#v", recreated)
	}
}

func TestSyncTaskLWWUsesCounterDeviceAndOperationIDBoundaries(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "sync-task-order-subject")
	defer db.Close()
	title := "Boundary task"
	taskID := task.ID(title)
	wallMs := now.UnixMilli()
	steps := []struct {
		deviceID  string
		operation task.Operation
		wantTask  bool
		wantAck   string
	}{
		{
			deviceID: "device-z", wantTask: true, wantAck: "applied",
			operation: task.Operation{ID: "task-operation-base", TaskID: taskID, Type: "upsert", Title: title, OccurredAt: now, HLCWallMs: wallMs},
		},
		{
			deviceID: "device-a", wantTask: false, wantAck: "applied",
			operation: task.Operation{ID: "task-operation-counter", TaskID: taskID, Type: "delete", OccurredAt: now, HLCWallMs: wallMs, HLCCounter: 1},
		},
		{
			deviceID: "device-z", wantTask: true, wantAck: "applied",
			operation: task.Operation{ID: "task-operation-a", TaskID: taskID, Type: "upsert", Title: title, OccurredAt: now, HLCWallMs: wallMs, HLCCounter: 1},
		},
		{
			deviceID: "device-z", wantTask: false, wantAck: "applied",
			operation: task.Operation{ID: "task-operation-z", TaskID: taskID, Type: "delete", OccurredAt: now, HLCWallMs: wallMs, HLCCounter: 1},
		},
		{
			deviceID: "device-zz", wantTask: false, wantAck: "ignored",
			operation: task.Operation{ID: "task-operation-stale", TaskID: taskID, Type: "upsert", Title: title, OccurredAt: now.Add(-time.Second), HLCWallMs: wallMs - 1},
		},
	}
	for index, step := range steps {
		result, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: step.deviceID, TaskOperations: []task.Operation{step.operation}}, now.Add(time.Duration(index)*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		if (len(result.Tasks) == 1) != step.wantTask || result.TaskAcknowledgements[0].Outcome != step.wantAck {
			t.Fatalf("step %d result = %#v", index, result)
		}
		if step.wantTask && (result.Tasks[0].ID != taskID || result.Tasks[0].Title != title) {
			t.Fatalf("step %d task = %#v", index, result.Tasks[0])
		}
	}
}

func TestSyncDurationsMergeIndependentlyAndRetryDeterministically(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "sync-duration-subject")
	defer db.Close()
	operation := func(id, phase string, durationMs, wallMs int64) DurationOperation {
		return DurationOperation{ID: id, Phase: phase, DurationMs: durationMs, OccurredAt: now, HLCWallMs: wallMs}
	}

	empty, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-0001"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if empty.Changed || empty.DurationsMs != (DurationsMs{Focus: 1_500_000, ShortBreak: 300_000, LongBreak: 900_000}) || len(empty.DurationAcknowledgements) != 0 {
		t.Fatalf("default durations = %#v", empty)
	}

	firstRequest := SyncRequest{DeviceID: "device-0001", DurationOperations: []DurationOperation{
		operation("duration-operation-old", "focus", 1_200_000, now.UnixMilli()),
		operation("duration-operation-new", "focus", 1_800_000, now.UnixMilli()+1),
		operation("duration-operation-short", "short_break", 420_000, now.UnixMilli()),
	}}
	first, err := userStore.Sync(ctx, db, userID, firstRequest, now)
	if err != nil {
		t.Fatal(err)
	}
	if !first.Changed || first.Revision != 1 || first.DurationsMs != (DurationsMs{Focus: 1_800_000, ShortBreak: 420_000, LongBreak: 900_000}) {
		t.Fatalf("first duration sync = %#v", first)
	}
	if first.DurationAcknowledgements[0].Outcome != "ignored" || first.DurationAcknowledgements[1].Outcome != "applied" || first.DurationAcknowledgements[2].Outcome != "applied" {
		t.Fatalf("first duration acknowledgements = %#v", first.DurationAcknowledgements)
	}

	retry, err := userStore.Sync(ctx, db, userID, firstRequest, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if retry.Changed || retry.Revision != first.Revision || retry.DurationsMs != first.DurationsMs || len(retry.DurationAcknowledgements) != len(first.DurationAcknowledgements) {
		t.Fatalf("duration retry changed result: first=%#v retry=%#v", first, retry)
	}
	for index := range first.DurationAcknowledgements {
		if retry.DurationAcknowledgements[index] != first.DurationAcknowledgements[index] {
			t.Fatalf("retry acknowledgement %d = %#v, want %#v", index, retry.DurationAcknowledgements[index], first.DurationAcknowledgements[index])
		}
	}
	var operationCount int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM duration_operations`).Scan(&operationCount); err != nil || operationCount != 3 {
		t.Fatalf("duration operation count after retry = %d, %v; want 3", operationCount, err)
	}

	second, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-0002", DurationOperations: []DurationOperation{
		operation("duration-operation-stale", "focus", 600_000, now.UnixMilli()-1),
		operation("duration-operation-long", "long_break", 1_200_000, now.UnixMilli()+2),
	}}, now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if second.Revision != 2 || second.DurationsMs != (DurationsMs{Focus: 1_800_000, ShortBreak: 420_000, LongBreak: 1_200_000}) {
		t.Fatalf("independent duration merge = %#v", second)
	}
	if second.DurationAcknowledgements[0].Outcome != "ignored" || second.DurationAcknowledgements[0].Reason == "" || second.DurationAcknowledgements[1].Outcome != "applied" {
		t.Fatalf("second duration acknowledgements = %#v", second.DurationAcknowledgements)
	}
	var deviceID string
	if err := db.QueryRowContext(ctx, `SELECT device_id FROM duration_operations WHERE id = 'duration-operation-long'`).Scan(&deviceID); err != nil || deviceID != "device-0002" {
		t.Fatalf("stored duration device = %q, %v", deviceID, err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE duration_operations SET duration_ms = 60000 WHERE id = 'duration-operation-long'`); err == nil {
		t.Fatal("duration operation was mutable")
	}
}

func TestSyncDurationsUseFullPhaseScopedOrder(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "sync-duration-order-subject")
	defer db.Close()
	operation := func(id, phase string, durationMs, counter int64) DurationOperation {
		return DurationOperation{ID: id, DeviceID: "untrusted-device", Phase: phase, DurationMs: durationMs, OccurredAt: now, HLCWallMs: now.UnixMilli(), HLCCounter: counter}
	}

	first, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-0001", DurationOperations: []DurationOperation{
		operation("duration-operation-focus-a", "focus", 1_200_000, 0),
		operation("duration-operation-focus-z", "focus", 1_440_000, 0),
		operation("duration-operation-short-z", "short_break", 360_000, 0),
	}}, now)
	if err != nil {
		t.Fatal(err)
	}
	if first.DurationsMs.Focus != 1_440_000 || first.DurationsMs.ShortBreak != 360_000 {
		t.Fatalf("initial durations = %#v", first.DurationsMs)
	}

	second, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-0002", DurationOperations: []DurationOperation{
		operation("duration-operation-focus-b", "focus", 1_800_000, 0),
		operation("duration-operation-short-a", "short_break", 420_000, 1),
	}}, now)
	if err != nil {
		t.Fatal(err)
	}
	if second.DurationsMs != (DurationsMs{Focus: 1_800_000, ShortBreak: 420_000, LongBreak: 900_000}) {
		t.Fatalf("tuple-ordered durations = %#v", second.DurationsMs)
	}
	for _, acknowledgement := range second.DurationAcknowledgements {
		if acknowledgement.Outcome != "applied" || acknowledgement.Reason != "" {
			t.Fatalf("winning acknowledgement = %#v", acknowledgement)
		}
	}
	var deviceID string
	if err := db.QueryRowContext(ctx, `SELECT device_id FROM duration_operations WHERE id = 'duration-operation-focus-b'`).Scan(&deviceID); err != nil || deviceID != "device-0002" {
		t.Fatalf("request device ID = %q, %v; want device-0002", deviceID, err)
	}
}

func TestSyncDurationDuplicateIDRequiresIdenticalImmutablePayload(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "sync-duration-idempotency-subject")
	defer db.Close()
	operation := DurationOperation{
		ID: "duration-operation-0001", Phase: "focus", DurationMs: 1_200_000,
		OccurredAt: now, HLCWallMs: now.UnixMilli(), HLCCounter: 2,
	}
	request := SyncRequest{DeviceID: "device-0001", DurationOperations: []DurationOperation{operation}}
	first, err := userStore.Sync(ctx, db, userID, request, now)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := userStore.Sync(ctx, db, userID, request, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if retry.Changed || retry.Revision != first.Revision || retry.DurationAcknowledgements[0].Outcome != "applied" {
		t.Fatalf("identical retry = %#v", retry)
	}

	changedPayload := operation
	changedPayload.DurationMs = 1_800_000
	conflict, err := userStore.Sync(ctx, db, userID, SyncRequest{
		DeviceID: "device-0001", DurationOperations: []DurationOperation{changedPayload},
	}, now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if conflict.Changed || conflict.Revision != first.Revision || conflict.DurationsMs.Focus != 1_200_000 || conflict.DurationAcknowledgements[0].Outcome != "rejected" || conflict.DurationAcknowledgements[0].Reason == "" {
		t.Fatalf("payload conflict = %#v", conflict)
	}

	deviceConflict, err := userStore.Sync(ctx, db, userID, SyncRequest{
		DeviceID: "device-0002", DurationOperations: []DurationOperation{operation},
	}, now.Add(3*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if deviceConflict.DurationAcknowledgements[0].Outcome != "rejected" || deviceConflict.Revision != first.Revision {
		t.Fatalf("device conflict = %#v", deviceConflict)
	}
}

func TestSyncReturnsFutureAccountHLCForNextClientEdit(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "sync-account-hlc-subject")
	defer db.Close()
	remoteWallMs := now.Add(4 * time.Minute).UnixMilli()
	title := "Future task"
	first, err := userStore.Sync(ctx, db, userID, SyncRequest{
		DeviceID: "device-0002",
		TaskOperations: []task.Operation{{
			ID: "task-operation-future", TaskID: task.ID(title), Type: "upsert", Title: title,
			OccurredAt: now, HLCWallMs: remoteWallMs, HLCCounter: 7,
		}},
		DurationOperations: []DurationOperation{{
			ID: "duration-operation-remote", Phase: "focus", DurationMs: 1_200_000,
			OccurredAt: now, HLCWallMs: remoteWallMs, HLCCounter: 6,
		}},
		AutoStartOperations: []AutoStartOperation{{
			ID: "auto-start-operation-remote", Enabled: true, OccurredAt: now, HLCWallMs: remoteWallMs, HLCCounter: 8,
		}},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if first.ServerHLCWallMs != remoteWallMs || first.ServerHLCCounter != 8 {
		t.Fatalf("server HLC = (%d,%d), want (%d,8)", first.ServerHLCWallMs, first.ServerHLCCounter, remoteWallMs)
	}

	second, err := userStore.Sync(ctx, db, userID, SyncRequest{
		DeviceID: "device-0001",
		DurationOperations: []DurationOperation{{
			ID: "duration-operation-local", Phase: "focus", DurationMs: 1_800_000,
			OccurredAt: now.Add(time.Second), HLCWallMs: first.ServerHLCWallMs, HLCCounter: first.ServerHLCCounter + 1,
		}},
	}, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if second.DurationsMs.Focus != 1_800_000 || second.DurationAcknowledgements[0].Outcome != "applied" {
		t.Fatalf("post-merge duration edit = %#v", second)
	}
}

func TestSyncLegacyDurationSentinelCannotSupersedeRealEdit(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "sync-duration-sentinel-subject")
	defer db.Close()
	realOperation := DurationOperation{
		ID: "duration-operation-real", Phase: "focus", DurationMs: 1_800_000,
		OccurredAt: now, HLCWallMs: now.UnixMilli(),
	}
	if _, err := userStore.Sync(ctx, db, userID, SyncRequest{
		DeviceID: "device-0001", DurationOperations: []DurationOperation{realOperation},
	}, now); err != nil {
		t.Fatal(err)
	}
	sentinel, err := userStore.Sync(ctx, db, userID, SyncRequest{
		DeviceID: "device-0002",
		DurationOperations: []DurationOperation{{
			ID: "duration-operation-bootstrap", Phase: "focus", DurationMs: 1_200_000,
			OccurredAt: now.Add(time.Second), HLCWallMs: 0, HLCCounter: 0,
		}},
	}, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if sentinel.DurationsMs.Focus != 1_800_000 || sentinel.DurationAcknowledgements[0].Outcome != "ignored" {
		t.Fatalf("sentinel duration superseded real edit: %#v", sentinel)
	}
}

func TestAuthenticateAndUpdateCSRF(t *testing.T) {
	ctx := context.Background()
	_, db, userID, now := openTestUser(t, "authenticate-subject")
	defer db.Close()
	tokenHash := testTokenHash(t, userID)
	csrf := authn.HashString("csrf-one")
	if err := CreateSession(ctx, db, Session{
		ID: "web-session", Kind: "web", Platform: "web", CSRFHash: csrf[:], CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}, []TokenRecord{{Hash: tokenHash, Kind: "web", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}}); err != nil {
		t.Fatal(err)
	}
	info, err := Authenticate(ctx, db, tokenHash, "web", now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if info.Profile.ID != userID || info.Profile.Email != "user@example.com" || info.SessionID != "web-session" || info.Kind != "web" || !authn.EqualHash(info.CSRFHash, csrf[:]) {
		t.Fatalf("authentication info mismatch: %#v", info)
	}

	updated := authn.HashString("csrf-two")
	if err := UpdateCSRF(ctx, db, "web-session", updated); err != nil {
		t.Fatal(err)
	}
	info, err = Authenticate(ctx, db, tokenHash, "web", now.Add(2*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if !authn.EqualHash(info.CSRFHash, updated[:]) {
		t.Fatalf("CSRF hash was not updated: %x", info.CSRFHash)
	}
	profile, err := ProfileByID(ctx, db)
	if err != nil || profile.ID != userID {
		t.Fatalf("ProfileByID() = %#v, %v", profile, err)
	}
}
