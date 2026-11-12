package store

import (
	"context"
	"database/sql"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"pomodorough/internal/task"
	"pomodorough/internal/timer"
)

// Core 0.56.0 task.carryHistory.v1 moves finished history along task renames.
// The server returns the carried view and keeps timer_sessions raw.

const carryDevice = "device-0001"

func taskOperationAt(t *testing.T, id, operationType, fromTitle, title string, at time.Time) task.Operation {
	t.Helper()
	operation := task.Operation{
		ID: id, DeviceID: carryDevice, TaskID: canonicalTaskID(t, fromTitle), Type: operationType,
		OccurredAt: at, HLCWallMs: at.UnixMilli(),
	}
	if operationType != "delete" {
		operation.Title = title
	}
	return operation
}

// focusRun returns a start and a finish of one timer on taskID.
func focusRun(index int, taskID string, startedAt time.Time) []timer.Command {
	timerID := fmt.Sprintf("timer-%06d", index+1)
	start := testTimerCommand(fmt.Sprintf("command-%06d-a", index), carryDevice, timerID, "start", int64(2*index+1), startedAt)
	start.TaskID = taskID
	finish := testTimerCommand(fmt.Sprintf("command-%06d-b", index), carryDevice, timerID, "finish", int64(2*index+2), startedAt.Add(7*time.Minute))
	return []timer.Command{start, finish}
}

func syncCarry(t *testing.T, userStore *Store, db *sql.DB, userID string, at time.Time, request SyncRequest) SyncResult {
	t.Helper()
	request.DeviceID = carryDevice
	result, err := userStore.Sync(context.Background(), db, userID, request, at)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func historyTaskIDs(history []timer.HistoryItem) []string {
	ids := make([]string, 0, len(history))
	for _, row := range history {
		ids = append(ids, row.TaskID)
	}
	return ids
}

func repeatedID(id string, count int) []string {
	ids := make([]string, count)
	for index := range ids {
		ids[index] = id
	}
	return ids
}

func storedSessionTasks(t *testing.T, db *sql.DB) []string {
	t.Helper()
	rows, err := db.Query(`SELECT COALESCE(task_id, '') FROM timer_sessions ORDER BY timer_id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var tasks []string
	for rows.Next() {
		var taskID string
		if err := rows.Scan(&taskID); err != nil {
			t.Fatal(err)
		}
		tasks = append(tasks, taskID)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return tasks
}

func currentTimerID(t *testing.T, db *sql.DB) string {
	t.Helper()
	var current sql.NullString
	if err := db.QueryRow(`SELECT current_timer_id FROM account_state WHERE singleton = 1`).Scan(&current); err != nil {
		t.Fatal(err)
	}
	return current.String
}

func TestRenameCarriesReturnedHistoryAndTerminalTimer(t *testing.T) {
	userStore, db, userID, now := openTestUser(t, "carry-rename-subject")
	defer db.Close()
	alpha, beta := canonicalTaskID(t, "Alpha"), canonicalTaskID(t, "Beta")
	finished := now.Add(7 * time.Minute)
	before := syncCarry(t, userStore, db, userID, finished, SyncRequest{
		TaskOperations: []task.Operation{taskOperationAt(t, "task-operation-0001", "upsert", "Alpha", "Alpha", now)},
		Commands:       focusRun(0, alpha, now),
	})
	if got := historyTaskIDs(before.History); !reflect.DeepEqual(got, []string{alpha}) || before.CanonicalTimer.TaskID != alpha {
		t.Fatalf("history before rename = %v, timer task %q", got, before.CanonicalTimer.TaskID)
	}
	currentBefore := currentTimerID(t, db)
	renamedAt := finished.Add(time.Minute)
	after := syncCarry(t, userStore, db, userID, renamedAt, SyncRequest{TaskOperations: []task.Operation{
		taskOperationAt(t, "task-operation-0002", "upsert", "Beta", "Beta", renamedAt),
		taskOperationAt(t, "task-operation-0003", "rename", "Alpha", "Beta", renamedAt),
	}})
	if got := historyTaskIDs(after.History); !reflect.DeepEqual(got, []string{beta}) {
		t.Fatalf("history after rename = %v; want [%s]", got, beta)
	}
	if after.CanonicalTimer == nil || after.CanonicalTimer.TaskID != beta || after.CanonicalTimer.ID != before.CanonicalTimer.ID {
		t.Fatalf("canonical timer after rename = %#v", after.CanonicalTimer)
	}
	if after.Revision <= before.Revision {
		t.Fatalf("revision %d did not rise above %d", after.Revision, before.Revision)
	}
	if got := storedSessionTasks(t, db); !reflect.DeepEqual(got, []string{alpha}) {
		t.Fatalf("timer_sessions tasks = %v; want the uncarried [%s]", got, alpha)
	}
	if got := currentTimerID(t, db); got != currentBefore {
		t.Fatalf("current_timer_id = %q; want %q", got, currentBefore)
	}
	history, _, _, err := userStore.History(context.Background(), db, userID, renamedAt.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if got := historyTaskIDs(history); !reflect.DeepEqual(got, []string{beta}) {
		t.Fatalf("read history after rename = %v; want [%s]", got, beta)
	}
}

// A chain A -> B -> C moves A's row once, to C, and every read recomputes the
// carry from the raw sessions instead of carrying a carried row again.
func TestRenameChainCarriesOnceAcrossReads(t *testing.T) {
	userStore, db, userID, now := openTestUser(t, "carry-chain-subject")
	defer db.Close()
	alpha, beta, gamma := canonicalTaskID(t, "Alpha"), canonicalTaskID(t, "Beta"), canonicalTaskID(t, "Gamma")
	firstRename, secondRename := now.Add(10*time.Minute), now.Add(30*time.Minute)
	syncCarry(t, userStore, db, userID, now.Add(7*time.Minute), SyncRequest{
		TaskOperations: []task.Operation{taskOperationAt(t, "task-operation-0001", "upsert", "Alpha", "Alpha", now)},
		Commands:       focusRun(0, alpha, now),
	})
	syncCarry(t, userStore, db, userID, firstRename, SyncRequest{TaskOperations: []task.Operation{
		taskOperationAt(t, "task-operation-0002", "upsert", "Beta", "Beta", firstRename),
		taskOperationAt(t, "task-operation-0003", "rename", "Alpha", "Beta", firstRename),
	}})
	// This run starts on Beta after the first rename, so only the second
	// rename moves it.
	syncCarry(t, userStore, db, userID, firstRename.Add(8*time.Minute), SyncRequest{Commands: focusRun(1, beta, firstRename.Add(time.Minute))})
	result := syncCarry(t, userStore, db, userID, secondRename, SyncRequest{TaskOperations: []task.Operation{
		taskOperationAt(t, "task-operation-0004", "upsert", "Gamma", "Gamma", secondRename),
		taskOperationAt(t, "task-operation-0005", "rename", "Beta", "Gamma", secondRename),
	}})
	if got := historyTaskIDs(result.History); !reflect.DeepEqual(got, []string{gamma, gamma}) {
		t.Fatalf("history after chain = %v; want both rows on %s", got, gamma)
	}
	for read := range 2 {
		history, _, _, err := userStore.History(context.Background(), db, userID, secondRename.Add(time.Duration(read+1)*time.Minute))
		if err != nil {
			t.Fatal(err)
		}
		if got := historyTaskIDs(history); !reflect.DeepEqual(got, []string{gamma, gamma}) {
			t.Fatalf("read %d history = %v; want both rows on %s", read, got, gamma)
		}
	}
	if got := storedSessionTasks(t, db); !reflect.DeepEqual(got, []string{alpha, beta}) {
		t.Fatalf("timer_sessions tasks = %v; want the uncarried [%s %s]", got, alpha, beta)
	}
}

// A run that starts after the rename keeps its task: the rename moves only
// history that started at or before it.
func TestRenameLeavesLaterRunsOnTheirTask(t *testing.T) {
	userStore, db, userID, now := openTestUser(t, "carry-bound-subject")
	defer db.Close()
	alpha, beta := canonicalTaskID(t, "Alpha"), canonicalTaskID(t, "Beta")
	renamedAt := now.Add(10 * time.Minute)
	syncCarry(t, userStore, db, userID, now.Add(7*time.Minute), SyncRequest{
		TaskOperations: []task.Operation{taskOperationAt(t, "task-operation-0001", "upsert", "Alpha", "Alpha", now)},
		Commands:       focusRun(0, alpha, now),
	})
	syncCarry(t, userStore, db, userID, renamedAt, SyncRequest{TaskOperations: []task.Operation{
		taskOperationAt(t, "task-operation-0002", "upsert", "Beta", "Beta", renamedAt),
		taskOperationAt(t, "task-operation-0003", "rename", "Alpha", "Beta", renamedAt),
	}})
	// A stale device still starts a run on Alpha after the rename.
	later := renamedAt.Add(time.Minute)
	result := syncCarry(t, userStore, db, userID, later.Add(7*time.Minute), SyncRequest{Commands: focusRun(1, alpha, later)})
	if got := historyTaskIDs(result.History); !reflect.DeepEqual(got, []string{alpha, beta}) {
		t.Fatalf("history = %v; want the later run on %s and the earlier on %s", got, alpha, beta)
	}
}

// Above 256 commands the timer reduction runs through timer.replay.page.v1;
// its history is carried the same way.
func TestRenameCarriesReplayPagedHistory(t *testing.T) {
	userStore, db, userID, now := openTestUser(t, "carry-paged-subject")
	defer db.Close()
	alpha, beta := canonicalTaskID(t, "Alpha"), canonicalTaskID(t, "Beta")
	const runs = 130
	commands := make([]timer.Command, 0, 2*runs)
	for index := range runs {
		commands = append(commands, focusRun(index, alpha, now.Add(time.Duration(index)*10*time.Minute))...)
	}
	end := now.Add(runs * 10 * time.Minute)
	syncCarry(t, userStore, db, userID, end, SyncRequest{
		TaskOperations: []task.Operation{taskOperationAt(t, "task-operation-0001", "upsert", "Alpha", "Alpha", now)},
		Commands:       commands,
	})
	result := syncCarry(t, userStore, db, userID, end, SyncRequest{TaskOperations: []task.Operation{
		taskOperationAt(t, "task-operation-0002", "upsert", "Beta", "Beta", end),
		taskOperationAt(t, "task-operation-0003", "rename", "Alpha", "Beta", end),
	}})
	if got := historyTaskIDs(result.History); !reflect.DeepEqual(got, repeatedID(beta, runs)) {
		t.Fatalf("paged history has %d rows, tasks %v; want %d rows on %s", len(got), got, runs, beta)
	}
	if got := storedSessionTasks(t, db); !reflect.DeepEqual(got, repeatedID(alpha, runs)) {
		t.Fatalf("timer_sessions keep %d raw tasks, want %d on %s", len(got), runs, alpha)
	}
}

// carryFixture returns an uncarried reduction with two finished runs on
// Alpha, one run without a task, a terminal canonical timer and an
// Alpha -> Beta rename in the log.
func carryFixture(t *testing.T) accountReduction {
	t.Helper()
	userStore, db, userID, now := openTestUser(t, "carry-fixture-subject")
	defer db.Close()
	alpha := canonicalTaskID(t, "Alpha")
	commands := append(focusRun(0, alpha, now), focusRun(1, "", now.Add(10*time.Minute))...)
	commands = append(commands, focusRun(2, alpha, now.Add(20*time.Minute))...)
	renamedAt := now.Add(30 * time.Minute)
	syncCarry(t, userStore, db, userID, renamedAt, SyncRequest{Commands: commands, TaskOperations: []task.Operation{
		taskOperationAt(t, "task-operation-0001", "upsert", "Alpha", "Alpha", now),
		taskOperationAt(t, "task-operation-0002", "upsert", "Beta", "Beta", renamedAt),
		taskOperationAt(t, "task-operation-0003", "rename", "Alpha", "Beta", renamedAt),
	}})
	reduction, err := reduceAccount(context.Background(), db, renamedAt)
	if err != nil {
		t.Fatal(err)
	}
	if len(reduction.timer.History) != 3 || reduction.timer.Canonical == nil {
		t.Fatalf("fixture reduction = %#v", reduction.timer)
	}
	reduction.returned = returnedTimer{}
	return reduction
}

type carryCall struct {
	calls  int
	mutate func(*coreCarryHistoryOutput)
}

func (fake *carryCall) call(ctx context.Context, operation string, input, output any) error {
	if err := callAccountSharedCore(ctx, operation, input, output); err != nil {
		return err
	}
	fake.calls++
	if fake.mutate != nil {
		fake.mutate(output.(*coreCarryHistoryOutput))
	}
	return nil
}

func TestCarryRunsWithoutRenameAndKeepsHistory(t *testing.T) {
	reduction := carryFixture(t)
	withoutRename := reduction.taskOperations[:0:0]
	for _, operation := range reduction.taskOperations {
		if operation.Type != "rename" {
			withoutRename = append(withoutRename, operation)
		}
	}
	reduction.taskOperations = withoutRename
	fake := &carryCall{}
	if err := carryReturnedHistory(context.Background(), fake.call, &reduction); err != nil {
		t.Fatal(err)
	}
	if fake.calls != 1 {
		t.Fatalf("carry calls = %d; want 1 even without a rename", fake.calls)
	}
	if !reflect.DeepEqual(reduction.returned.History, reduction.timer.History) ||
		!reflect.DeepEqual(reduction.returned.Canonical, reduction.timer.Canonical) {
		t.Fatalf("carry without rename changed the view: %#v", reduction.returned)
	}
}

func TestCarryMovesOnlyTaskRowsOfTheRenamedTask(t *testing.T) {
	reduction := carryFixture(t)
	alpha, beta := canonicalTaskID(t, "Alpha"), canonicalTaskID(t, "Beta")
	if err := carryReturnedHistory(context.Background(), callAccountSharedCore, &reduction); err != nil {
		t.Fatal(err)
	}
	want := make([]string, 0, 3)
	for _, row := range reduction.timer.History {
		if row.TaskID == alpha {
			want = append(want, beta)
		} else {
			want = append(want, row.TaskID)
		}
	}
	if got := historyTaskIDs(reduction.returned.History); !reflect.DeepEqual(got, want) {
		t.Fatalf("carried tasks = %v; want %v", got, want)
	}
	if !slices.Contains(want, "") || !slices.Contains(want, beta) {
		t.Fatalf("fixture tasks %v need a row without a task and a moved row", want)
	}
	if reduction.returned.Canonical.TaskID != beta || reduction.timer.Canonical.TaskID != alpha {
		t.Fatalf("canonical timer task: returned %q, reduced %q", reduction.returned.Canonical.TaskID, reduction.timer.Canonical.TaskID)
	}
}

func TestCarryFailsClosedOnChangedOutput(t *testing.T) {
	cases := map[string]func(*coreCarryHistoryOutput){
		"row id changed": func(output *coreCarryHistoryOutput) { output.History[0].ID = "timer-999999" },
		"row dropped":    func(output *coreCarryHistoryOutput) { output.History = output.History[1:] },
		"rows reordered": func(output *coreCarryHistoryOutput) {
			output.History[0], output.History[2] = output.History[2], output.History[0]
		},
		"row elapsed changed":   func(output *coreCarryHistoryOutput) { *output.History[0].ElapsedMs++ },
		"task added to a row":   func(output *coreCarryHistoryOutput) { output.History[1].TaskID = "task-added" },
		"task removed from row": func(output *coreCarryHistoryOutput) { output.History[0].TaskID = "" },
		"history null":          func(output *coreCarryHistoryOutput) { output.History = nil },
		"canonical dropped":     func(output *coreCarryHistoryOutput) { output.Canonical.value = nil },
		"canonical missing":     func(output *coreCarryHistoryOutput) { output.Canonical.present = false },
		"canonical id changed":  func(output *coreCarryHistoryOutput) { output.Canonical.value.ID = "timer-999999" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			reduction := carryFixture(t)
			fake := &carryCall{mutate: mutate}
			err := carryReturnedHistory(context.Background(), fake.call, &reduction)
			if err == nil || !strings.Contains(err.Error(), "validate shared history carry output") {
				t.Fatalf("carry error = %v; want a validation failure", err)
			}
			if !reflect.DeepEqual(reduction.returned, returnedTimer{}) {
				t.Fatalf("failed carry left a returned view: %#v", reduction.returned)
			}
		})
	}
}
