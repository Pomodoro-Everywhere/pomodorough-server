package store

import (
	"context"
	"strings"
	"testing"
	"time"

	"pomodorough/internal/timer"
)

// S56: pinned 0.34.0 wasm reduces unknown retarget to rejected
// "unsupported command type" — a valid ack that would silently diverge.
// The server must map it to a sync error (fail-closed), never ack success.
func TestS56RetargetUnsupportedFailsClosed(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	start := timer.Command{
		ID: "s56-start-0001", DeviceID: "device-a", DeviceSequence: 1,
		TimerID: "timer-s56-0001", Type: "start", Phase: "focus",
		PlannedDurationMs: 1_500_000, OccurredAt: now, HLCWallMs: now.UnixMilli(), ObservedElapsedMs: 0,
	}
	retarget := timer.Command{
		ID: "s56-retarget-01", DeviceID: "device-a", DeviceSequence: 2,
		TimerID: "timer-s56-0001", TaskID: "task-s56-001", Type: "retarget", Phase: "focus",
		PlannedDurationMs: 1_500_000, OccurredAt: now.Add(time.Minute),
		HLCWallMs: now.Add(time.Minute).UnixMilli(), ObservedElapsedMs: 0,
	}
	if _, err := reduceTimerWithSharedCore(ctx, []timer.Command{start, retarget}, now.Add(2*time.Minute)); err == nil {
		t.Fatal("retarget unsupported reduced without error; want fail-closed sync error")
	} else if !strings.Contains(strings.ToLower(err.Error()), "retarget") ||
		!strings.Contains(strings.ToLower(err.Error()), "unsupported") {
		t.Fatalf("fail-closed error = %q, want retarget+unsupported", err)
	}
}

func TestS56RetargetUnsupportedSyncReturnsErrorNotAck(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "s56-no-silent-ack")
	defer db.Close()
	start := testTimerCommand("s56-sync-start", "device-a", "timer-s56-sync", "start", 1, now)
	retarget := testTimerCommand("s56-sync-retarget", "device-a", "timer-s56-sync", "retarget", 2, now.Add(time.Minute))
	retarget.TaskID = "task-s56-001"
	if _, err := userStore.Sync(ctx, db, userID, SyncRequest{
		DeviceID: "device-a", Commands: []timer.Command{start, retarget},
	}, now.Add(2*time.Minute)); err == nil {
		t.Fatal("Sync with unsupported retarget succeeded; want fail-closed error, no silent ack")
	} else if !strings.Contains(strings.ToLower(err.Error()), "retarget") {
		t.Fatalf("Sync error = %q, want retarget fail-closed", err)
	}
}

func TestS56NonUnsupportedRetargetRejectionStillAcks(t *testing.T) {
	commands := []timer.Command{{ID: "cmd-1", Type: "retarget"}}
	result := timer.Result{Outcomes: map[string]timer.Outcome{
		"cmd-1": {Outcome: "rejected", Reason: "invalid task association"},
	}}
	if err := rejectUnsupportedRetarget(commands, result); err != nil {
		t.Fatalf("validation rejection mapped to error: %v", err)
	}
}

// S57: capability-gate the >256 paging path. Pinned 0.34.0 wasm lacks
// timer.replay.page.v1 (UnsupportedOperation); direct timer.reduce.v1
// supports up to 10,000. >256-command syncs must pass on pinned wasm.
func TestS57LargeHistoryFallsBackToDirectReduce(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "s57-paging-fallback")
	defer db.Close()
	const total = 300
	commands := make([]timer.Command, 0, total)
	for i := 0; i < total; i++ {
		at := now.Add(time.Duration(i) * time.Millisecond)
		commands = append(commands, timer.Command{
			ID: "s57-command-" + padIndex(i), DeviceID: "device-a",
			DeviceSequence: int64(i + 1), TimerID: "timer-s57-" + padIndex(i),
			Type: "start", Phase: "focus", PlannedDurationMs: 1_500_000,
			OccurredAt: at, HLCWallMs: at.UnixMilli(), ObservedElapsedMs: 0,
		})
	}
	result, err := userStore.Sync(ctx, db, userID, SyncRequest{
		DeviceID: "device-a", Commands: commands,
	}, now.Add(time.Duration(total)*time.Millisecond))
	if err != nil {
		t.Fatalf("300-command sync failed on pinned wasm: %v", err)
	}
	if len(result.Acknowledgements) != total {
		t.Fatalf("acknowledgements = %d, want %d", len(result.Acknowledgements), total)
	}
	for _, ack := range result.Acknowledgements {
		if ack.Outcome != "applied" {
			t.Fatalf("command %s outcome = %s/%s, want applied", ack.CommandID, ack.Outcome, ack.Reason)
		}
	}
}

func padIndex(i int) string {
	const digits = "0123456789"
	out := make([]byte, 4)
	n := i
	for k := 3; k >= 0; k-- {
		out[k] = digits[n%10]
		n /= 10
	}
	return string(out)
}
