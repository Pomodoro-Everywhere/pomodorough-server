package store

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"testing"
	"time"

	"pomodorough/internal/task"
)

func selectedTaskPointer(value string) *string {
	return &value
}

func TestSyncSelectedTaskNullableLWWLiveProjectionAndExactAcknowledgements(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "sync-selected-task-subject")
	defer db.Close()
	taskID := task.ID("Selected task")
	selectTask := SelectedTaskOperation{
		ID: "selected-task-operation-0001", TaskID: selectedTaskPointer(taskID), OccurredAt: now,
		HLCWallMs: now.Add(time.Second).UnixMilli(), HLCCounter: 3,
	}

	empty, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-0001"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if empty.SelectedTaskID != nil || empty.SelectedTaskAcknowledgements == nil || len(empty.SelectedTaskAcknowledgements) != 0 {
		t.Fatalf("default selected-task state = %#v", empty)
	}

	selected, err := userStore.Sync(ctx, db, userID, SyncRequest{
		DeviceID: "device-0001", SelectedTaskOperations: []SelectedTaskOperation{selectTask},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if !selected.Changed || selected.Revision != 1 || selected.SelectedTaskID != nil ||
		len(selected.SelectedTaskAcknowledgements) != 1 || selected.SelectedTaskAcknowledgements[0] != (SelectedTaskAcknowledgement{
		OperationID: selectTask.ID, Outcome: "applied", Reason: "",
	}) {
		t.Fatalf("selection of absent task = %#v", selected)
	}
	if selected.ServerHLCWallMs != selectTask.HLCWallMs || selected.ServerHLCCounter != selectTask.HLCCounter {
		t.Fatalf("server HLC = (%d,%d), want selected-task clock (%d,%d)", selected.ServerHLCWallMs, selected.ServerHLCCounter, selectTask.HLCWallMs, selectTask.HLCCounter)
	}

	retry, err := userStore.Sync(ctx, db, userID, SyncRequest{
		DeviceID: "device-0001", SelectedTaskOperations: []SelectedTaskOperation{selectTask},
	}, now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if retry.Changed || retry.Revision != 1 || retry.SelectedTaskAcknowledgements[0] != selected.SelectedTaskAcknowledgements[0] {
		t.Fatalf("selected-task retry = %#v", retry)
	}

	upsert := task.Operation{
		ID: "task-operation-selected-upsert", TaskID: taskID, Type: "upsert", Title: "Selected task",
		OccurredAt: now, HLCWallMs: now.UnixMilli(),
	}
	created, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-0002", TaskOperations: []task.Operation{upsert}}, now.Add(3*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if created.SelectedTaskID == nil || *created.SelectedTaskID != taskID || created.Revision != 2 {
		t.Fatalf("selection after task appears = %#v", created)
	}

	deletedOperation := upsert
	deletedOperation.ID = "task-operation-selected-delete"
	deletedOperation.Type = "delete"
	deletedOperation.Title = ""
	deletedOperation.HLCWallMs++
	deleted, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-0002", TaskOperations: []task.Operation{deletedOperation}}, now.Add(4*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if deleted.SelectedTaskID != nil || deleted.Revision != 3 {
		t.Fatalf("selection after task deletion = %#v", deleted)
	}

	recreatedOperation := upsert
	recreatedOperation.ID = "task-operation-selected-recreate"
	recreatedOperation.HLCWallMs += 2
	recreated, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-0002", TaskOperations: []task.Operation{recreatedOperation}}, now.Add(5*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if recreated.SelectedTaskID == nil || *recreated.SelectedTaskID != taskID || recreated.Revision != 4 {
		t.Fatalf("selection after task recreation = %#v", recreated)
	}
	var operationCount int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM selected_task_operations`).Scan(&operationCount); err != nil || operationCount != 1 {
		t.Fatalf("selected-task winner history count = %d, %v; want 1", operationCount, err)
	}

	clear := SelectedTaskOperation{
		ID: "selected-task-operation-clear", TaskID: nil, OccurredAt: now,
		HLCWallMs: selectTask.HLCWallMs, HLCCounter: selectTask.HLCCounter + 1,
	}
	cleared, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-0001", SelectedTaskOperations: []SelectedTaskOperation{clear}}, now.Add(6*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if cleared.SelectedTaskID != nil || cleared.Revision != 5 || cleared.SelectedTaskAcknowledgements[0] != (SelectedTaskAcknowledgement{
		OperationID: clear.ID, Outcome: "applied", Reason: "",
	}) {
		t.Fatalf("explicit selected-task clear = %#v", cleared)
	}
}

func TestSyncSelectedTaskUsesHLCDeviceIDOrderAndRejectsImmutableCollisions(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "sync-selected-task-order-subject")
	defer db.Close()
	taskID := task.ID("Winner")
	if _, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-task", TaskOperations: []task.Operation{{
		ID: "task-operation-winner", TaskID: taskID, Type: "upsert", Title: "Winner", OccurredAt: now, HLCWallMs: now.UnixMilli(),
	}}}, now); err != nil {
		t.Fatal(err)
	}

	lower := SelectedTaskOperation{ID: "selected-task-operation-z", TaskID: nil, OccurredAt: now, HLCWallMs: now.UnixMilli(), HLCCounter: 7}
	higher := SelectedTaskOperation{ID: "selected-task-operation-a", TaskID: selectedTaskPointer(taskID), OccurredAt: now, HLCWallMs: now.UnixMilli(), HLCCounter: 7}
	if _, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-a", SelectedTaskOperations: []SelectedTaskOperation{lower}}, now); err != nil {
		t.Fatal(err)
	}
	winner, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-z", SelectedTaskOperations: []SelectedTaskOperation{higher}}, now)
	if err != nil {
		t.Fatal(err)
	}
	if winner.SelectedTaskID == nil || *winner.SelectedTaskID != taskID || winner.SelectedTaskAcknowledgements[0].Outcome != "applied" {
		t.Fatalf("device-ordered selected-task winner = %#v", winner)
	}

	sameDeviceA := SelectedTaskOperation{ID: "selected-task-operation-id-a", TaskID: nil, OccurredAt: now, HLCWallMs: now.UnixMilli(), HLCCounter: 8}
	sameDeviceZ := SelectedTaskOperation{ID: "selected-task-operation-id-z", TaskID: selectedTaskPointer(taskID), OccurredAt: now, HLCWallMs: now.UnixMilli(), HLCCounter: 8}
	idWinner, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-same", SelectedTaskOperations: []SelectedTaskOperation{sameDeviceZ, sameDeviceA}}, now)
	if err != nil {
		t.Fatal(err)
	}
	if !idWinner.Changed || idWinner.Revision != 4 || idWinner.SelectedTaskID == nil || *idWinner.SelectedTaskID != taskID ||
		idWinner.SelectedTaskAcknowledgements[0].Outcome != "applied" || idWinner.SelectedTaskAcknowledgements[1].Outcome != "ignored" {
		t.Fatalf("ID-ordered selected-task result = %#v", idWinner)
	}

	changed := sameDeviceZ
	changed.TaskID = nil
	conflict, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-same", SelectedTaskOperations: []SelectedTaskOperation{changed}}, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if conflict.Changed || conflict.SelectedTaskAcknowledgements[0] != (SelectedTaskAcknowledgement{
		OperationID: changed.ID, Outcome: "rejected", Reason: "operation ID already used with different payload",
	}) {
		t.Fatalf("changed selected-task payload = %#v", conflict)
	}
	deviceConflict, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-other", SelectedTaskOperations: []SelectedTaskOperation{sameDeviceZ}}, now.Add(2*time.Second))
	if err != nil || deviceConflict.Changed || deviceConflict.SelectedTaskAcknowledgements[0].Outcome != "rejected" {
		t.Fatalf("changed selected-task device = %#v, %v", deviceConflict, err)
	}
	if _, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-same", SelectedTaskOperations: []SelectedTaskOperation{sameDeviceZ, sameDeviceZ}}, now); err == nil {
		t.Fatal("duplicate selected-task IDs succeeded")
	}
	if _, err := db.ExecContext(ctx, `UPDATE selected_task_operations SET task_id = NULL WHERE id = ?`, sameDeviceZ.ID); err == nil {
		t.Fatal("selected-task operation was mutable")
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM selected_task_operations WHERE id = ?`, sameDeviceZ.ID); err == nil {
		t.Fatal("selected-task operation was deletable")
	}
}

func TestSyncSelectedTaskConvergesAcrossEveryArrivalPermutation(t *testing.T) {
	base := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	taskID := task.ID("Permutation winner")
	operations := []SelectedTaskOperation{
		{ID: "selected-task-arrival-old", DeviceID: "device-selected-a", TaskID: nil, OccurredAt: base, HLCWallMs: 100},
		{ID: "selected-task-arrival-middle", DeviceID: "device-selected-b", TaskID: nil, OccurredAt: base, HLCWallMs: 200},
		{ID: "selected-task-arrival-new", DeviceID: "device-selected-c", TaskID: selectedTaskPointer(taskID), OccurredAt: base, HLCWallMs: 300},
	}
	for permutationIndex, permutation := range indexPermutations(len(operations)) {
		permutationIndex, permutation := permutationIndex, permutation
		t.Run(fmt.Sprintf("permutation-%02d", permutationIndex), func(t *testing.T) {
			userStore, db, userID, _ := openTestUser(t, fmt.Sprintf("selected-arrival-%02d", permutationIndex))
			defer db.Close()
			if _, err := userStore.Sync(context.Background(), db, userID, SyncRequest{DeviceID: "device-task", TaskOperations: []task.Operation{{
				ID: "task-operation-permutation", TaskID: taskID, Type: "upsert", Title: "Permutation winner", OccurredAt: base, HLCWallMs: 50,
			}}}, base); err != nil {
				t.Fatal(err)
			}
			for revision, operationIndex := range permutation {
				operation := operations[operationIndex]
				result, err := userStore.Sync(context.Background(), db, userID, SyncRequest{
					DeviceID: operation.DeviceID, LastRevision: int64(revision + 1), SelectedTaskOperations: []SelectedTaskOperation{operation},
				}, base)
				if err != nil || !result.Changed || result.Revision != int64(revision+2) {
					t.Fatalf("arrival %d result = %#v, %v", revision, result, err)
				}
			}
			result, err := userStore.Sync(context.Background(), db, userID, SyncRequest{DeviceID: "device-pull", LastRevision: 4}, base)
			if err != nil || result.SelectedTaskID == nil || *result.SelectedTaskID != taskID {
				t.Fatalf("final selected-task state = %#v, %v", result.SelectedTaskID, err)
			}
		})
	}
}

func TestBootstrapSelectedTaskPresenceMergeHashesAndReplacementRollback(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "bootstrap-selected-task-subject")
	defer db.Close()
	taskID := task.ID("Bootstrap task")
	remote := SelectedTaskOperation{ID: "selected-task-operation-remote", TaskID: selectedTaskPointer(taskID), OccurredAt: now, HLCWallMs: now.UnixMilli()}
	if _, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-remote", SelectedTaskOperations: []SelectedTaskOperation{remote}}, now); err != nil {
		t.Fatal(err)
	}

	omitted := BootstrapResolutionRequest{
		RequestID: "resolution-selected-omitted", DeviceID: "device-local", ExpectedRevision: 1, Strategy: BootstrapReplaceRemote,
	}
	preserved, err := userStore.ResolveBootstrap(ctx, db, userID, omitted, now.Add(time.Second))
	if err != nil || preserved.Changed || preserved.Revision != 1 || len(preserved.SelectedTaskAcknowledgements) != 0 {
		t.Fatalf("omitted selected-task replacement = %#v, %v", preserved, err)
	}
	var count int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM selected_task_operations`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("preserved selected-task rows = %d, %v", count, err)
	}

	presentEmpty := BootstrapResolutionRequest{
		RequestID: "resolution-selected-empty", DeviceID: "device-local", ExpectedRevision: 1, Strategy: BootstrapReplaceRemote,
		SelectedTaskOperations: []SelectedTaskOperation{}, SelectedTaskOperationsPresent: true,
	}
	cleared, err := userStore.ResolveBootstrap(ctx, db, userID, presentEmpty, now.Add(2*time.Second))
	if err != nil || !cleared.Changed || cleared.Revision != 2 || cleared.SelectedTaskID != nil {
		t.Fatalf("present-empty selected-task replacement = %#v, %v", cleared, err)
	}

	upsert := task.Operation{
		ID: "task-operation-bootstrap", TaskID: taskID, Type: "upsert", Title: "Bootstrap task", OccurredAt: now, HLCWallMs: now.UnixMilli(),
	}
	mergedOperation := SelectedTaskOperation{ID: "selected-task-operation-merge", TaskID: selectedTaskPointer(taskID), OccurredAt: now, HLCWallMs: now.UnixMilli() + 1}
	mergeRequest := BootstrapResolutionRequest{
		RequestID: "resolution-selected-merge", DeviceID: "device-local", ExpectedRevision: 2, Strategy: BootstrapMerge,
		TaskOperations: []task.Operation{upsert}, SelectedTaskOperations: []SelectedTaskOperation{mergedOperation}, SelectedTaskOperationsPresent: true,
	}
	merged, err := userStore.ResolveBootstrap(ctx, db, userID, mergeRequest, now.Add(3*time.Second))
	if err != nil || merged.SelectedTaskID == nil || *merged.SelectedTaskID != taskID || merged.Revision != 3 ||
		merged.SelectedTaskAcknowledgements[0] != (SelectedTaskAcknowledgement{OperationID: mergedOperation.ID, Outcome: "applied"}) {
		t.Fatalf("merged selected-task result = %#v, %v", merged, err)
	}
	retry, err := userStore.ResolveBootstrap(ctx, db, userID, mergeRequest, now.Add(time.Hour))
	if err != nil || retry.Changed || retry.ServerTime != merged.ServerTime || retry.SelectedTaskAcknowledgements[0] != merged.SelectedTaskAcknowledgements[0] {
		t.Fatalf("selected-task bootstrap retry = %#v, %v", retry, err)
	}

	presence := BootstrapResolutionRequest{
		RequestID: "resolution-selected-presence", DeviceID: "device-local", ExpectedRevision: 3, Strategy: BootstrapKeepRemote,
	}
	if _, err := userStore.ResolveBootstrap(ctx, db, userID, presence, now.Add(4*time.Second)); err != nil {
		t.Fatal(err)
	}
	presence.SelectedTaskOperations = []SelectedTaskOperation{}
	presence.SelectedTaskOperationsPresent = true
	if _, err := userStore.ResolveBootstrap(ctx, db, userID, presence, now.Add(5*time.Second)); !errors.Is(err, ErrRequestIDConflict) {
		t.Fatalf("selected-task presence hash conflict = %v, want ErrRequestIDConflict", err)
	}
	keep := BootstrapResolutionRequest{
		RequestID: "resolution-selected-keep", DeviceID: "device-local", ExpectedRevision: 3, Strategy: BootstrapKeepRemote,
		SelectedTaskOperations: []SelectedTaskOperation{mergedOperation}, SelectedTaskOperationsPresent: true,
	}
	if _, err := userStore.ResolveBootstrap(ctx, db, userID, keep, now); err == nil {
		t.Fatal("keep_remote accepted nonempty selected-task operations")
	}

	invalid := SelectedTaskOperation{ID: "selected-task-operation-invalid", TaskID: nil, OccurredAt: now, HLCWallMs: -1}
	_, err = userStore.ResolveBootstrap(ctx, db, userID, BootstrapResolutionRequest{
		RequestID: "resolution-selected-rollback", DeviceID: "device-local", ExpectedRevision: 3, Strategy: BootstrapReplaceRemote,
		SelectedTaskOperations: []SelectedTaskOperation{invalid}, SelectedTaskOperationsPresent: true,
	}, now.Add(6*time.Second))
	if err == nil {
		t.Fatal("invalid selected-task replacement succeeded")
	}
	var remoteCount, invalidCount, flags, revision int
	db.QueryRowContext(ctx, `SELECT COUNT(*) FROM selected_task_operations WHERE id = ?`, mergedOperation.ID).Scan(&remoteCount)
	db.QueryRowContext(ctx, `SELECT COUNT(*) FROM selected_task_operations WHERE id = ?`, invalid.ID).Scan(&invalidCount)
	db.QueryRowContext(ctx, `SELECT COUNT(*) FROM maintenance_flags`).Scan(&flags)
	db.QueryRowContext(ctx, `SELECT revision FROM account_state WHERE singleton = 1`).Scan(&revision)
	if remoteCount != 1 || invalidCount != 0 || flags != 0 || revision != 3 {
		t.Fatalf("rollback state remote=%d invalid=%d flags=%d revision=%d", remoteCount, invalidCount, flags, revision)
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM selected_task_operations WHERE id = ?`, mergedOperation.ID); err == nil {
		t.Fatal("selected-task delete guard remained disabled after rollback")
	}
}

func TestBootstrapPreviousHashReplaysWhenSelectedTaskFieldWasOmitted(t *testing.T) {
	for _, autoStartPresent := range []bool{false, true} {
		t.Run(fmt.Sprintf("auto-start-present-%t", autoStartPresent), func(t *testing.T) {
			ctx := context.Background()
			userStore, db, userID, now := openTestUser(t, fmt.Sprintf("bootstrap-previous-selected-task-hash-%t", autoStartPresent))
			defer db.Close()
			request := BootstrapResolutionRequest{
				RequestID: "resolution-previous-selected-task", DeviceID: "device-0001", ExpectedRevision: 0, Strategy: BootstrapKeepRemote,
				AutoStartOperationsPresent: autoStartPresent,
			}
			if autoStartPresent {
				request.AutoStartOperations = []AutoStartOperation{}
			}
			previousPayload := fmt.Sprintf(`{"DeviceID":"device-0001","ExpectedRevision":0,"Strategy":"keep_remote","Commands":[],"TaskOperations":[],"DurationOperations":[],"AutoStartOperations":[],"AutoStartOperationsPresent":%t}`, autoStartPresent)
			previousHash := sha256.Sum256([]byte(previousPayload))
			previousResponse := `{"acknowledgements":[],"taskAcknowledgements":[],"durationAcknowledgements":[],"autoStartAcknowledgements":[],"revision":0,"canonicalTimer":null,"history":[],"tasks":[],"durationsMs":{"focus":1500000,"short_break":300000,"long_break":900000},"autoStartBreaks":false,"serverTime":"2026-07-15T10:00:00Z","serverHlcWallMs":1784109600000,"serverHlcCounter":0}`
			if _, err := db.ExecContext(ctx, `INSERT INTO bootstrap_resolutions(request_id, payload_hash, response_json, created_at_ms)
				VALUES (?, ?, ?, ?)`, request.RequestID, previousHash[:], previousResponse, now.UnixMilli()); err != nil {
				t.Fatal(err)
			}

			replayed, err := userStore.ResolveBootstrap(ctx, db, userID, request, now.Add(time.Hour))
			if err != nil || replayed.SelectedTaskAcknowledgements == nil || len(replayed.SelectedTaskAcknowledgements) != 0 || replayed.SelectedTaskID != nil {
				t.Fatalf("previous bootstrap replay = %#v, %v", replayed, err)
			}
			presentEmpty := request
			presentEmpty.SelectedTaskOperations = []SelectedTaskOperation{}
			presentEmpty.SelectedTaskOperationsPresent = true
			if _, err := userStore.ResolveBootstrap(ctx, db, userID, presentEmpty, now.Add(2*time.Hour)); !errors.Is(err, ErrRequestIDConflict) {
				t.Fatalf("present-empty selected-task retry = %v, want ErrRequestIDConflict", err)
			}
		})
	}
}
