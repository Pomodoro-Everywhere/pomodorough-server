package store

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"pomodorough/internal/task"
	"pomodorough/internal/timer"
)

func TestBootstrapReturnsReadOnlyCanonicalSnapshot(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "bootstrap-preview-subject")
	defer db.Close()
	remote := bootstrapSyncRequest(now, "device-0001", "remote")
	if _, err := userStore.Sync(ctx, db, userID, remote, now); err != nil {
		t.Fatal(err)
	}
	var beforeRevision, beforeLastSeen int64
	if err := db.QueryRowContext(ctx, `SELECT revision FROM account_state WHERE singleton = 1`).Scan(&beforeRevision); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT last_seen_at_ms FROM devices WHERE id = ?`, remote.DeviceID).Scan(&beforeLastSeen); err != nil {
		t.Fatal(err)
	}

	result, err := userStore.Bootstrap(ctx, db, userID, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if result.Revision != 1 || result.Changed || len(result.Acknowledgements) != 0 || len(result.TaskAcknowledgements) != 0 || len(result.DurationAcknowledgements) != 0 {
		t.Fatalf("bootstrap snapshot metadata = %#v", result)
	}
	if result.CanonicalTimer == nil || result.CanonicalTimer.ID != "timer-remote" || len(result.Tasks) != 1 || result.DurationsMs.Focus != 1_800_000 {
		t.Fatalf("bootstrap snapshot state = %#v", result)
	}
	var afterRevision, afterLastSeen, resolutionCount int64
	if err := db.QueryRowContext(ctx, `SELECT revision FROM account_state WHERE singleton = 1`).Scan(&afterRevision); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT last_seen_at_ms FROM devices WHERE id = ?`, remote.DeviceID).Scan(&afterLastSeen); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM bootstrap_resolutions`).Scan(&resolutionCount); err != nil {
		t.Fatal(err)
	}
	if afterRevision != beforeRevision || afterLastSeen != beforeLastSeen || resolutionCount != 0 {
		t.Fatalf("bootstrap preview mutated storage: revision %d->%d last_seen %d->%d resolutions=%d", beforeRevision, afterRevision, beforeLastSeen, afterLastSeen, resolutionCount)
	}
}

func TestBootstrapKeepRemoteIsRecordedWithoutRevisionChange(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "bootstrap-keep-subject")
	defer db.Close()
	if _, err := userStore.Sync(ctx, db, userID, bootstrapSyncRequest(now, "device-0001", "remote"), now); err != nil {
		t.Fatal(err)
	}
	request := BootstrapResolutionRequest{
		RequestID: "resolution-keep-0001", DeviceID: "device-0001", ExpectedRevision: 1, Strategy: BootstrapKeepRemote,
		Commands: []timer.Command{}, TaskOperations: []task.Operation{}, DurationOperations: []DurationOperation{},
	}
	first, err := userStore.ResolveBootstrap(ctx, db, userID, request, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	retry, err := userStore.ResolveBootstrap(ctx, db, userID, request, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	firstJSON, _ := json.Marshal(first)
	retryJSON, _ := json.Marshal(retry)
	if first.Revision != 1 || first.Changed || retry.Changed || string(firstJSON) != string(retryJSON) {
		t.Fatalf("keep_remote retry mismatch: first=%s retry=%s", firstJSON, retryJSON)
	}
	var revision, resolutionCount int
	if err := db.QueryRowContext(ctx, `SELECT revision FROM account_state WHERE singleton = 1`).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM bootstrap_resolutions`).Scan(&resolutionCount); err != nil {
		t.Fatal(err)
	}
	if revision != 1 || resolutionCount != 1 {
		t.Fatalf("keep_remote storage revision=%d resolutions=%d", revision, resolutionCount)
	}
}

func TestBootstrapMergeAppliesTimerTaskAndDurationOnce(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "bootstrap-merge-subject")
	defer db.Close()
	local := bootstrapSyncRequest(now, "device-0001", "local")
	result, err := userStore.ResolveBootstrap(ctx, db, userID, BootstrapResolutionRequest{
		RequestID: "resolution-merge-0001", DeviceID: local.DeviceID, ExpectedRevision: 0, Strategy: BootstrapMerge,
		Commands: local.Commands, TaskOperations: local.TaskOperations, DurationOperations: local.DurationOperations,
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed || result.Revision != 1 || result.CanonicalTimer == nil || result.CanonicalTimer.TaskID != local.TaskOperations[0].TaskID || result.DurationsMs.Focus != 1_800_000 {
		t.Fatalf("merge result = %#v", result)
	}
	if result.Acknowledgements[0].Outcome != "applied" || result.TaskAcknowledgements[0].Outcome != "applied" || result.DurationAcknowledgements[0].Outcome != "applied" {
		t.Fatalf("merge acknowledgements = %#v %#v %#v", result.Acknowledgements, result.TaskAcknowledgements, result.DurationAcknowledgements)
	}
}

func TestBootstrapStrategiesReturnExactHistoryTaskAndDurationState(t *testing.T) {
	strategies := []struct {
		name          string
		strategy      string
		wantRevision  int64
		wantHistory   []string
		wantTasks     []string
		wantDuration  int64
		wantRemoteRow int
		wantLocalRow  int
	}{
		{
			name: "keep remote", strategy: BootstrapKeepRemote, wantRevision: 1,
			wantHistory: []string{"timer-remote"}, wantTasks: []string{"Task remote"}, wantDuration: 1_800_000,
			wantRemoteRow: 2,
		},
		{
			name: "replace remote", strategy: BootstrapReplaceRemote, wantRevision: 2,
			wantHistory: []string{"timer-local"}, wantTasks: []string{"Task local"}, wantDuration: 1_200_000,
			wantLocalRow: 2,
		},
		{
			name: "merge", strategy: BootstrapMerge, wantRevision: 2,
			wantHistory: []string{"timer-local", "timer-remote"}, wantTasks: []string{"Task local", "Task remote"}, wantDuration: 1_200_000,
			wantRemoteRow: 2, wantLocalRow: 2,
		},
	}
	for _, testCase := range strategies {
		t.Run(testCase.name, func(t *testing.T) {
			ctx := context.Background()
			userStore, db, userID, now := openTestUser(t, "bootstrap-exact-"+testCase.strategy)
			defer db.Close()
			remote := bootstrapSyncRequest(now, "device-remote", "remote")
			remote.Commands = append(remote.Commands, testTimerCommand("command-remote-finish", remote.DeviceID, "timer-remote", "finish", 2, now.Add(time.Second)))
			if _, err := userStore.Sync(ctx, db, userID, remote, now.Add(time.Second)); err != nil {
				t.Fatal(err)
			}
			local := bootstrapSyncRequest(now.Add(2*time.Second), "device-local", "local")
			local.Commands = append(local.Commands, testTimerCommand("command-local-finish", local.DeviceID, "timer-local", "finish", 2, now.Add(3*time.Second)))
			local.DurationOperations[0].DurationMs = 1_200_000
			request := BootstrapResolutionRequest{
				RequestID: "resolution-exact-" + testCase.strategy, DeviceID: local.DeviceID,
				ExpectedRevision: 1, Strategy: testCase.strategy,
				Commands: []timer.Command{}, TaskOperations: []task.Operation{}, DurationOperations: []DurationOperation{},
			}
			if testCase.strategy != BootstrapKeepRemote {
				request.Commands = local.Commands
				request.TaskOperations = local.TaskOperations
				request.DurationOperations = local.DurationOperations
			}
			result, err := userStore.ResolveBootstrap(ctx, db, userID, request, now.Add(4*time.Second))
			if err != nil {
				t.Fatal(err)
			}
			if result.Revision != testCase.wantRevision || result.DurationsMs.Focus != testCase.wantDuration {
				t.Fatalf("resolution metadata = %#v", result)
			}
			if result.CanonicalTimer == nil || result.CanonicalTimer.ID != testCase.wantHistory[0] || result.CanonicalTimer.TaskID == "" {
				t.Fatalf("canonical timer = %#v, want %s with task", result.CanonicalTimer, testCase.wantHistory[0])
			}
			if len(result.History) != len(testCase.wantHistory) {
				t.Fatalf("history = %#v, want timers %v", result.History, testCase.wantHistory)
			}
			for index, timerID := range testCase.wantHistory {
				item := result.History[index]
				if item.ID != timerID || item.TimerID != timerID || item.Status != "completed" || item.TaskID == "" {
					t.Fatalf("history[%d] = %#v, want completed %s with task", index, item, timerID)
				}
			}
			if len(result.Tasks) != len(testCase.wantTasks) {
				t.Fatalf("tasks = %#v, want titles %v", result.Tasks, testCase.wantTasks)
			}
			for index, title := range testCase.wantTasks {
				if result.Tasks[index].Title != title {
					t.Fatalf("tasks[%d] = %#v, want title %q", index, result.Tasks[index], title)
				}
			}
			persisted, revision, err := History(ctx, db, now.Add(4*time.Second))
			if err != nil {
				t.Fatal(err)
			}
			if revision != result.Revision || len(persisted) != len(result.History) {
				t.Fatalf("persisted history=%#v revision=%d, response=%#v", persisted, revision, result.History)
			}
			for suffix, want := range map[string]int{"remote": testCase.wantRemoteRow, "local": testCase.wantLocalRow} {
				var count int
				if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM timer_commands WHERE id LIKE ?`, "command-"+suffix+"-%").Scan(&count); err != nil || count != want {
					t.Fatalf("%s command count = %d, %v; want %d", suffix, count, err, want)
				}
			}
		})
	}
}

func TestBootstrapMergeDeduplicatesExistingHistoryOperations(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "bootstrap-duplicate-history-subject")
	defer db.Close()
	remote := bootstrapSyncRequest(now, "device-0001", "remote")
	remote.Commands = append(remote.Commands, testTimerCommand("command-remote-finish", remote.DeviceID, "timer-remote", "finish", 2, now.Add(time.Second)))
	if _, err := userStore.Sync(ctx, db, userID, remote, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}

	result, err := userStore.ResolveBootstrap(ctx, db, userID, BootstrapResolutionRequest{
		RequestID: "resolution-duplicate-history", DeviceID: remote.DeviceID, ExpectedRevision: 1, Strategy: BootstrapMerge,
		Commands: remote.Commands, TaskOperations: remote.TaskOperations, DurationOperations: remote.DurationOperations,
	}, now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if result.Changed || result.Revision != 1 || len(result.History) != 1 || result.History[0].TimerID != "timer-remote" || len(result.Tasks) != 1 {
		t.Fatalf("duplicate history merge = %#v", result)
	}
	for _, acknowledgement := range result.Acknowledgements {
		if acknowledgement.Outcome != "applied" {
			t.Fatalf("duplicate command acknowledgement = %#v", acknowledgement)
		}
	}
	if result.TaskAcknowledgements[0].Outcome != "applied" || result.DurationAcknowledgements[0].Outcome != "applied" {
		t.Fatalf("duplicate operation acknowledgements = %#v %#v", result.TaskAcknowledgements, result.DurationAcknowledgements)
	}
	for table, want := range map[string]int{"timer_commands": 2, "task_operations": 1, "duration_operations": 1, "bootstrap_resolutions": 1} {
		var count int
		if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+table).Scan(&count); err != nil || count != want {
			t.Fatalf("%s count = %d, %v; want %d", table, count, err, want)
		}
	}
}

func TestBootstrapReplaceClearsRemoteStateAndEmptyReplacementCountsChanged(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "bootstrap-replace-subject")
	defer db.Close()
	remote := bootstrapSyncRequest(now, "device-remote", "remote")
	remote.Commands = append(remote.Commands, testTimerCommand("command-remote-finish", remote.DeviceID, "timer-remote", "finish", 2, now.Add(time.Second)))
	if _, err := userStore.Sync(ctx, db, userID, remote, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	local := bootstrapSyncRequest(now.Add(2*time.Second), "device-local", "local")
	replaced, err := userStore.ResolveBootstrap(ctx, db, userID, BootstrapResolutionRequest{
		RequestID: "resolution-replace-0001", DeviceID: local.DeviceID, ExpectedRevision: 1, Strategy: BootstrapReplaceRemote,
		Commands: local.Commands, TaskOperations: local.TaskOperations, DurationOperations: local.DurationOperations,
	}, now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if !replaced.Changed || replaced.Revision != 2 || replaced.CanonicalTimer == nil || replaced.CanonicalTimer.ID != "timer-local" || len(replaced.History) != 0 || len(replaced.Tasks) != 1 {
		t.Fatalf("replace result = %#v", replaced)
	}
	for table, id := range map[string]string{
		"timer_commands": "command-local-start", "task_operations": "task-operation-local", "duration_operations": "duration-operation-local",
	} {
		var count int
		if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+table+` WHERE id LIKE '%remote%'`).Scan(&count); err != nil || count != 0 {
			t.Fatalf("remote rows in %s = %d, %v", table, count, err)
		}
		if _, err := db.ExecContext(ctx, `DELETE FROM `+table+` WHERE id = ?`, id); err == nil {
			t.Fatalf("%s immutable trigger remained disabled", table)
		}
	}

	empty, err := userStore.ResolveBootstrap(ctx, db, userID, BootstrapResolutionRequest{
		RequestID: "resolution-replace-0002", DeviceID: local.DeviceID, ExpectedRevision: 2, Strategy: BootstrapReplaceRemote,
		Commands: []timer.Command{}, TaskOperations: []task.Operation{}, DurationOperations: []DurationOperation{},
	}, now.Add(3*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if !empty.Changed || empty.Revision != 3 || empty.CanonicalTimer != nil || len(empty.Tasks) != 0 || len(empty.History) != 0 {
		t.Fatalf("empty replacement = %#v", empty)
	}
	for _, table := range []string{"timer_commands", "command_outcomes", "timer_sessions", "task_operations", "duration_operations"} {
		var count int
		if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("%s count after empty replacement = %d, %v", table, count, err)
		}
	}
}

func TestBootstrapResolutionCASRejectsWithoutMutation(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "bootstrap-cas-subject")
	defer db.Close()
	remote := bootstrapSyncRequest(now, "device-0001", "remote")
	if _, err := userStore.Sync(ctx, db, userID, remote, now); err != nil {
		t.Fatal(err)
	}
	_, err := userStore.ResolveBootstrap(ctx, db, userID, BootstrapResolutionRequest{
		RequestID: "resolution-stale-0001", DeviceID: "device-0001", ExpectedRevision: 0, Strategy: BootstrapReplaceRemote,
		Commands: []timer.Command{}, TaskOperations: []task.Operation{}, DurationOperations: []DurationOperation{},
	}, now.Add(time.Second))
	if !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("stale resolution error = %v", err)
	}
	var revision, commandCount, resolutionCount int
	db.QueryRowContext(ctx, `SELECT revision FROM account_state WHERE singleton = 1`).Scan(&revision)
	db.QueryRowContext(ctx, `SELECT COUNT(*) FROM timer_commands`).Scan(&commandCount)
	db.QueryRowContext(ctx, `SELECT COUNT(*) FROM bootstrap_resolutions`).Scan(&resolutionCount)
	if revision != 1 || commandCount != 1 || resolutionCount != 0 {
		t.Fatalf("stale resolution mutated state: revision=%d commands=%d resolutions=%d", revision, commandCount, resolutionCount)
	}
}

func TestConcurrentBootstrapResolutionsAtSameRevisionAllowOneMutation(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "bootstrap-concurrent-subject")
	defer db.Close()
	requests := []BootstrapResolutionRequest{
		{
			RequestID: "resolution-concurrent-0001", DeviceID: "device-0001", ExpectedRevision: 0, Strategy: BootstrapMerge,
			DurationOperations: []DurationOperation{{ID: "duration-concurrent-0001", Phase: "focus", DurationMs: 1_200_000, OccurredAt: now, HLCWallMs: now.UnixMilli()}},
		},
		{
			RequestID: "resolution-concurrent-0002", DeviceID: "device-0002", ExpectedRevision: 0, Strategy: BootstrapMerge,
			DurationOperations: []DurationOperation{{ID: "duration-concurrent-0002", Phase: "short_break", DurationMs: 600_000, OccurredAt: now, HLCWallMs: now.UnixMilli()}},
		},
	}
	start := make(chan struct{})
	errorsByRequest := make([]error, len(requests))
	var wait sync.WaitGroup
	for index := range requests {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			<-start
			_, errorsByRequest[index] = userStore.ResolveBootstrap(ctx, db, userID, requests[index], now)
		}(index)
	}
	close(start)
	wait.Wait()
	successes, conflicts := 0, 0
	for _, err := range errorsByRequest {
		if err == nil {
			successes++
		} else if errors.Is(err, ErrRevisionConflict) {
			conflicts++
		} else {
			t.Fatalf("concurrent resolution error = %v", err)
		}
	}
	var revision, operationCount, resolutionCount int
	db.QueryRowContext(ctx, `SELECT revision FROM account_state WHERE singleton = 1`).Scan(&revision)
	db.QueryRowContext(ctx, `SELECT COUNT(*) FROM duration_operations`).Scan(&operationCount)
	db.QueryRowContext(ctx, `SELECT COUNT(*) FROM bootstrap_resolutions`).Scan(&resolutionCount)
	if successes != 1 || conflicts != 1 || revision != 1 || operationCount != 1 || resolutionCount != 1 {
		t.Fatalf("concurrent results successes=%d conflicts=%d revision=%d operations=%d resolutions=%d", successes, conflicts, revision, operationCount, resolutionCount)
	}
}

func TestBootstrapRequestIDRetryAndPayloadConflict(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "bootstrap-request-id-subject")
	defer db.Close()
	request := BootstrapResolutionRequest{
		RequestID: "resolution-idempotent-0001", DeviceID: "device-0001", ExpectedRevision: 0, Strategy: BootstrapMerge,
		DurationOperations: []DurationOperation{{ID: "duration-idempotent-0001", Phase: "focus", DurationMs: 1_200_000, OccurredAt: now, HLCWallMs: now.UnixMilli()}},
	}
	first, err := userStore.ResolveBootstrap(ctx, db, userID, request, now)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := userStore.ResolveBootstrap(ctx, db, userID, request, now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	firstJSON, _ := json.Marshal(first)
	retryJSON, _ := json.Marshal(retry)
	if !first.Changed || retry.Changed || string(firstJSON) != string(retryJSON) {
		t.Fatalf("idempotent response mismatch: first=%s retry=%s", firstJSON, retryJSON)
	}
	changed := request
	changed.DurationOperations = append([]DurationOperation(nil), request.DurationOperations...)
	changed.DurationOperations[0].DurationMs = 1_800_000
	if _, err := userStore.ResolveBootstrap(ctx, db, userID, changed, now.Add(2*time.Hour)); !errors.Is(err, ErrRequestIDConflict) {
		t.Fatalf("changed request ID payload error = %v", err)
	}
	var revision, operationCount, resolutionCount int
	db.QueryRowContext(ctx, `SELECT revision FROM account_state WHERE singleton = 1`).Scan(&revision)
	db.QueryRowContext(ctx, `SELECT COUNT(*) FROM duration_operations`).Scan(&operationCount)
	db.QueryRowContext(ctx, `SELECT COUNT(*) FROM bootstrap_resolutions`).Scan(&resolutionCount)
	if revision != 1 || operationCount != 1 || resolutionCount != 1 {
		t.Fatalf("request conflict mutated state: revision=%d operations=%d resolutions=%d", revision, operationCount, resolutionCount)
	}
}

func TestBootstrapReplaceRollsBackAndRestoresTriggerSafety(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "bootstrap-rollback-subject")
	defer db.Close()
	remote := bootstrapSyncRequest(now, "device-remote", "remote")
	if _, err := userStore.Sync(ctx, db, userID, remote, now); err != nil {
		t.Fatal(err)
	}
	localCommand := testTimerCommand("command-local-start", "device-local", "timer-local", "start", 1, now.Add(time.Second))
	localTaskID := task.ID("Local rollback task")
	localCommand.TaskID = localTaskID
	_, err := userStore.ResolveBootstrap(ctx, db, userID, BootstrapResolutionRequest{
		RequestID: "resolution-rollback-0001", DeviceID: "device-local", ExpectedRevision: 1, Strategy: BootstrapReplaceRemote,
		Commands: []timer.Command{localCommand},
		TaskOperations: []task.Operation{{
			ID: "task-operation-local-rollback", TaskID: localTaskID, Type: "upsert", Title: "Local rollback task",
			OccurredAt: now.Add(time.Second), HLCWallMs: now.Add(time.Second).UnixMilli(),
		}},
		DurationOperations: []DurationOperation{{ID: "duration-invalid-0001", Phase: "focus", DurationMs: 1, OccurredAt: now, HLCWallMs: now.UnixMilli()}},
	}, now.Add(time.Second))
	if err == nil {
		t.Fatal("replacement with invalid operation succeeded")
	}
	var revision, remoteCommands, localCommands, localTasks, flags, resolutions int
	db.QueryRowContext(ctx, `SELECT revision FROM account_state WHERE singleton = 1`).Scan(&revision)
	db.QueryRowContext(ctx, `SELECT COUNT(*) FROM timer_commands WHERE id = 'command-remote-start'`).Scan(&remoteCommands)
	db.QueryRowContext(ctx, `SELECT COUNT(*) FROM timer_commands WHERE id = 'command-local-start'`).Scan(&localCommands)
	db.QueryRowContext(ctx, `SELECT COUNT(*) FROM task_operations WHERE id = 'task-operation-local-rollback'`).Scan(&localTasks)
	db.QueryRowContext(ctx, `SELECT COUNT(*) FROM maintenance_flags`).Scan(&flags)
	db.QueryRowContext(ctx, `SELECT COUNT(*) FROM bootstrap_resolutions`).Scan(&resolutions)
	if revision != 1 || remoteCommands != 1 || localCommands != 0 || localTasks != 0 || flags != 0 || resolutions != 0 {
		t.Fatalf("failed replacement leaked state: revision=%d remote=%d local=%d tasks=%d flags=%d resolutions=%d", revision, remoteCommands, localCommands, localTasks, flags, resolutions)
	}
	for table, id := range map[string]string{
		"timer_commands": "command-remote-start", "task_operations": "task-operation-remote", "duration_operations": "duration-operation-remote",
	} {
		if _, err := db.ExecContext(ctx, `DELETE FROM `+table+` WHERE id = ?`, id); err == nil {
			t.Fatalf("%s delete trigger disabled after rollback", table)
		}
	}
}

func TestSyncRejectsChangedTimerAndTaskIDsAndBatchDuplicates(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "sync-immutable-id-subject")
	defer db.Close()
	original := bootstrapSyncRequest(now, "device-0001", "original")
	first, err := userStore.Sync(ctx, db, userID, original, now)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := userStore.Sync(ctx, db, userID, original, now.Add(time.Second))
	if err != nil || retry.Changed || retry.Revision != first.Revision || retry.Acknowledgements[0].Outcome != "applied" || retry.TaskAcknowledgements[0].Outcome != "applied" {
		t.Fatalf("exact timer/task retry = %#v, %v", retry, err)
	}
	changed := original
	changed.Commands = append([]timer.Command(nil), original.Commands...)
	changed.TaskOperations = append([]task.Operation(nil), original.TaskOperations...)
	changed.Commands[0].ObservedElapsedMs = 42
	changed.TaskOperations[0].Title = "Changed immutable title"
	conflict, err := userStore.Sync(ctx, db, userID, changed, now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if conflict.Changed || conflict.Revision != 1 || conflict.Acknowledgements[0].Outcome != "rejected" || conflict.TaskAcknowledgements[0].Outcome != "rejected" {
		t.Fatalf("changed immutable payload = %#v", conflict)
	}
	deviceConflict := original
	deviceConflict.DeviceID = "device-0002"
	deviceConflictResult, err := userStore.Sync(ctx, db, userID, deviceConflict, now.Add(3*time.Second))
	if err != nil || deviceConflictResult.Acknowledgements[0].Outcome != "rejected" || deviceConflictResult.TaskAcknowledgements[0].Outcome != "rejected" {
		t.Fatalf("changed immutable device = %#v, %v", deviceConflictResult, err)
	}

	for name, request := range map[string]SyncRequest{
		"timer": {
			DeviceID: "device-duplicate-timer", Commands: []timer.Command{
				testTimerCommand("command-duplicate", "device-duplicate-timer", "timer-duplicate", "start", 1, now),
				testTimerCommand("command-duplicate", "device-duplicate-timer", "timer-duplicate", "start", 1, now),
			},
		},
		"task": {
			DeviceID: "device-duplicate-task", TaskOperations: []task.Operation{
				{ID: "task-operation-duplicate", TaskID: task.ID("Duplicate"), Type: "upsert", Title: "Duplicate", OccurredAt: now, HLCWallMs: now.UnixMilli()},
				{ID: "task-operation-duplicate", TaskID: task.ID("Duplicate"), Type: "upsert", Title: "Duplicate", OccurredAt: now, HLCWallMs: now.UnixMilli()},
			},
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := userStore.Sync(ctx, db, userID, request, now); err == nil {
				t.Fatal("duplicate batch succeeded")
			}
			var deviceCount int
			if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM devices WHERE id = ?`, request.DeviceID).Scan(&deviceCount); err != nil || deviceCount != 0 {
				t.Fatalf("duplicate batch mutated device count=%d, %v", deviceCount, err)
			}
		})
	}
}

func bootstrapSyncRequest(now time.Time, deviceID, suffix string) SyncRequest {
	title := "Task " + suffix
	taskID := task.ID(title)
	command := testTimerCommand("command-"+suffix+"-start", deviceID, "timer-"+suffix, "start", 1, now)
	command.TaskID = taskID
	return SyncRequest{
		DeviceID: deviceID,
		Commands: []timer.Command{command},
		TaskOperations: []task.Operation{{
			ID: "task-operation-" + suffix, DeviceID: deviceID, TaskID: taskID, Type: "upsert", Title: title,
			OccurredAt: now, HLCWallMs: now.UnixMilli(),
		}},
		DurationOperations: []DurationOperation{{
			ID: "duration-operation-" + suffix, DeviceID: deviceID, Phase: "focus", DurationMs: 1_800_000,
			OccurredAt: now, HLCWallMs: now.UnixMilli(),
		}},
	}
}
