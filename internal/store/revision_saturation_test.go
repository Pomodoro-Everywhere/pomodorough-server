package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"pomodorough/internal/task"
	"pomodorough/internal/timer"
)

func TestSafeRevisionIncrementBoundaries(t *testing.T) {
	if revision, err := safeRevisionIncrement(MaxSafeRevision - 1); err != nil || revision != MaxSafeRevision {
		t.Fatalf("last safe increment = %d, %v", revision, err)
	}
	for _, revision := range []int64{MaxSafeRevision, MaxSafeRevision + 1} {
		if next, err := safeRevisionIncrement(revision); !errors.Is(err, ErrRevisionExhausted) || next != 0 {
			t.Fatalf("unsafe increment from %d = %d, %v", revision, next, err)
		}
	}
}

func TestSyncRevisionSaturationRollsBackEntireOperation(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "sync-revision-saturation")
	defer db.Close()
	setTestRevision(t, db, MaxSafeRevision)
	command := testTimerCommand("command-saturated-sync", "device-saturated-sync", "timer-saturated-sync", "start", 1, now)

	result, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: command.DeviceID, Commands: []timer.Command{command}}, now)
	if !errors.Is(err, ErrRevisionExhausted) || !reflect.DeepEqual(result, SyncResult{}) {
		t.Fatalf("saturated sync result = %#v, %v", result, err)
	}
	assertTestRevision(t, db, MaxSafeRevision)
	for table, want := range map[string]int{"devices": 0, "timer_commands": 0, "timer_sessions": 0, "command_outcomes": 0} {
		assertTestTableCount(t, db, table, want)
	}
}

func TestCanonicalRevisionAboveMaximumIsNeverReturned(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "invalid-canonical-revision")
	defer db.Close()
	setTestRevision(t, db, MaxSafeRevision+1)

	result, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-invalid-revision"}, now)
	if !errors.Is(err, ErrRevisionExhausted) || !reflect.DeepEqual(result, SyncResult{}) {
		t.Fatalf("invalid canonical revision result = %#v, %v", result, err)
	}
	assertTestTableCount(t, db, "devices", 0)
}

func TestProjectionMaterializationRevisionSaturationLeavesProjectionUsable(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "projection-revision-saturation")
	defer db.Close()
	command := testTimerCommand("command-saturated-projection", "device-saturated-projection", "timer-saturated-projection", "start", 1, now)
	command.PlannedDurationMs = 60_000
	if _, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: command.DeviceID, Commands: []timer.Command{command}}, now); err != nil {
		t.Fatal(err)
	}
	setTestRevision(t, db, MaxSafeRevision)

	result, err := userStore.Bootstrap(ctx, db, userID, now.Add(time.Minute))
	if !errors.Is(err, ErrRevisionExhausted) || !reflect.DeepEqual(result, SyncResult{}) {
		t.Fatalf("saturated materialization result = %#v, %v", result, err)
	}
	assertTestRevision(t, db, MaxSafeRevision)
	var status string
	if err := db.QueryRowContext(ctx, `SELECT status FROM timer_sessions WHERE timer_id = ?`, command.TimerID).Scan(&status); err != nil || status != "running" {
		t.Fatalf("persisted projection status = %q, %v", status, err)
	}
	assertTestTableCount(t, db, "timer_commands", 1)
	assertTestTableCount(t, db, "timer_sessions", 1)

	setTestRevision(t, db, MaxSafeRevision-1)
	result, err = userStore.Bootstrap(ctx, db, userID, now.Add(time.Minute))
	if err != nil || !result.Changed || result.Revision != MaxSafeRevision || result.CanonicalTimer == nil || result.CanonicalTimer.Status != "completed" {
		t.Fatalf("last usable materialization = %#v, %v", result, err)
	}
}

func TestBootstrapResolutionRevisionSaturationRollsBackEntireResolution(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "bootstrap-revision-saturation")
	defer db.Close()
	setTestRevision(t, db, MaxSafeRevision)
	operation := task.Operation{
		ID: "task-saturated-bootstrap", TaskID: "task-saturated-bootstrap", Type: "upsert", Title: "Saturated",
		OccurredAt: now, HLCWallMs: now.UnixMilli(),
	}

	result, err := userStore.ResolveBootstrap(ctx, db, userID, BootstrapResolutionRequest{
		RequestID: "resolution-saturated-bootstrap", DeviceID: "device-saturated-bootstrap", ExpectedRevision: MaxSafeRevision,
		Strategy: BootstrapMerge, TaskOperations: []task.Operation{operation},
	}, now)
	if !errors.Is(err, ErrRevisionExhausted) || !reflect.DeepEqual(result, SyncResult{}) {
		t.Fatalf("saturated bootstrap result = %#v, %v", result, err)
	}
	assertTestRevision(t, db, MaxSafeRevision)
	for table, want := range map[string]int{"task_operations": 0, "bootstrap_resolutions": 0, "timer_sessions": 0} {
		assertTestTableCount(t, db, table, want)
	}

	setTestRevision(t, db, MaxSafeRevision-1)
	result, err = userStore.ResolveBootstrap(ctx, db, userID, BootstrapResolutionRequest{
		RequestID: "resolution-last-bootstrap", DeviceID: "device-saturated-bootstrap", ExpectedRevision: MaxSafeRevision - 1,
		Strategy: BootstrapMerge, TaskOperations: []task.Operation{operation},
	}, now)
	if err != nil || !result.Changed || result.Revision != MaxSafeRevision || len(result.Tasks) != 1 {
		t.Fatalf("last usable bootstrap = %#v, %v", result, err)
	}
}

func TestBootstrapReplacementRevisionSaturationPreservesRemoteState(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "bootstrap-replace-revision-saturation")
	defer db.Close()
	remote := testTimerCommand("command-saturated-remote", "device-saturated-remote", "timer-saturated-remote", "start", 1, now)
	if _, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: remote.DeviceID, Commands: []timer.Command{remote}}, now); err != nil {
		t.Fatal(err)
	}
	setTestRevision(t, db, MaxSafeRevision)

	result, err := userStore.ResolveBootstrap(ctx, db, userID, BootstrapResolutionRequest{
		RequestID: "resolution-saturated-replace", DeviceID: "device-saturated-replace", ExpectedRevision: MaxSafeRevision,
		Strategy: BootstrapReplaceRemote,
	}, now.Add(time.Second))
	if !errors.Is(err, ErrRevisionExhausted) || !reflect.DeepEqual(result, SyncResult{}) {
		t.Fatalf("saturated replacement result = %#v, %v", result, err)
	}
	assertTestRevision(t, db, MaxSafeRevision)
	assertTestTableCount(t, db, "timer_commands", 1)
	assertTestTableCount(t, db, "timer_sessions", 1)
	assertTestTableCount(t, db, "bootstrap_resolutions", 0)
}

func TestCachedBootstrapReplayRejectsUnsafeRevision(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "bootstrap-cached-unsafe-revision")
	defer db.Close()
	request := BootstrapResolutionRequest{
		RequestID: "resolution-cached-unsafe", DeviceID: "device-cached-unsafe",
		ExpectedRevision: 0, Strategy: BootstrapKeepRemote,
	}
	if _, err := userStore.ResolveBootstrap(ctx, db, userID, request, now); err != nil {
		t.Fatal(err)
	}
	var encoded string
	if err := db.QueryRowContext(ctx, `SELECT response_json FROM bootstrap_resolutions WHERE request_id = ?`, request.RequestID).Scan(&encoded); err != nil {
		t.Fatal(err)
	}
	var cached SyncResult
	if err := json.Unmarshal([]byte(encoded), &cached); err != nil {
		t.Fatal(err)
	}
	cached.Revision = MaxSafeRevision + 1
	encodedResult, err := json.Marshal(cached)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE bootstrap_resolutions SET response_json = ? WHERE request_id = ?`, string(encodedResult), request.RequestID); err != nil {
		t.Fatal(err)
	}

	result, err := userStore.ResolveBootstrap(ctx, db, userID, request, now.Add(time.Hour))
	if !errors.Is(err, ErrRevisionExhausted) || !reflect.DeepEqual(result, SyncResult{}) {
		t.Fatalf("unsafe cached replay = %#v, %v", result, err)
	}
	assertTestRevision(t, db, 0)
	assertTestTableCount(t, db, "bootstrap_resolutions", 1)
}

func setTestRevision(t *testing.T, db interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}, revision int64) {
	t.Helper()
	if _, err := db.ExecContext(context.Background(), `UPDATE account_state SET revision = ? WHERE singleton = 1`, revision); err != nil {
		t.Fatal(err)
	}
}

func assertTestRevision(t *testing.T, db interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, want int64) {
	t.Helper()
	var got int64
	if err := db.QueryRowContext(context.Background(), `SELECT revision FROM account_state WHERE singleton = 1`).Scan(&got); err != nil || got != want {
		t.Fatalf("revision = %d, %v; want %d", got, err, want)
	}
}

func assertTestTableCount(t *testing.T, db interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, table string, want int) {
	t.Helper()
	var got int
	if err := db.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM `+table).Scan(&got); err != nil || got != want {
		t.Fatalf("%s count = %d, %v; want %d", table, got, err, want)
	}
}
