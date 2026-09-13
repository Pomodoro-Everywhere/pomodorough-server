package store

import (
	"context"
	"testing"
	"time"

	"pomodorough/internal/timer"
)

// S56: Core 0.35.0 owns the synchronized retarget op. A retarget command
// reduces to applied with the session taskId updated (assign), and a
// null-taskId retarget clears the assignment (unassign).
func TestS56RetargetAssignApplies(t *testing.T) {
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
	result, err := reduceTimerWithSharedCore(ctx, []timer.Command{start, retarget}, now.Add(2*time.Minute))
	if err != nil {
		t.Fatalf("retarget assign reduce failed: %v", err)
	}
	for _, id := range []string{"s56-start-0001", "s56-retarget-01"} {
		outcome, exists := result.Outcomes[id]
		if !exists {
			t.Fatalf("missing outcome for %s", id)
		}
		if outcome.Outcome != "applied" {
			t.Fatalf("command %s outcome = %s/%s, want applied", id, outcome.Outcome, outcome.Reason)
		}
	}
	session := findSession(result.Sessions, "timer-s56-0001")
	if session == nil {
		t.Fatal("missing session timer-s56-0001")
	}
	if session.TaskID != "task-s56-001" {
		t.Fatalf("session taskId = %q, want task-s56-001", session.TaskID)
	}
	if result.Canonical == nil || result.Canonical.TaskID != "task-s56-001" {
		t.Fatalf("canonical taskId = %v, want task-s56-001", result.Canonical)
	}
}

func TestS56RetargetNullUnassignApplies(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	start := timer.Command{
		ID: "s56-start-0002", DeviceID: "device-a", DeviceSequence: 1,
		TimerID: "timer-s56-0002", Type: "start", Phase: "focus",
		PlannedDurationMs: 1_500_000, OccurredAt: now, HLCWallMs: now.UnixMilli(), ObservedElapsedMs: 0,
	}
	assign := timer.Command{
		ID: "s56-retarget-02", DeviceID: "device-a", DeviceSequence: 2,
		TimerID: "timer-s56-0002", TaskID: "task-s56-002", Type: "retarget", Phase: "focus",
		PlannedDurationMs: 1_500_000, OccurredAt: now.Add(time.Minute),
		HLCWallMs: now.Add(time.Minute).UnixMilli(), ObservedElapsedMs: 0,
	}
	// Empty TaskID encodes as null taskId on the wire: clear the assignment.
	unassign := timer.Command{
		ID: "s56-retarget-03", DeviceID: "device-a", DeviceSequence: 3,
		TimerID: "timer-s56-0002", TaskID: "", Type: "retarget", Phase: "focus",
		PlannedDurationMs: 1_500_000, OccurredAt: now.Add(2 * time.Minute),
		HLCWallMs: now.Add(2 * time.Minute).UnixMilli(), ObservedElapsedMs: 0,
	}
	commands := []timer.Command{start, assign, unassign}
	result, err := reduceTimerWithSharedCore(ctx, commands, now.Add(3*time.Minute))
	if err != nil {
		t.Fatalf("retarget null-unassign reduce failed: %v", err)
	}
	outcome, exists := result.Outcomes["s56-retarget-03"]
	if !exists || outcome.Outcome != "applied" {
		t.Fatalf("unassign outcome = %+v, want applied", outcome)
	}
	session := findSession(result.Sessions, "timer-s56-0002")
	if session == nil {
		t.Fatal("missing session timer-s56-0002")
	}
	if session.TaskID != "" {
		t.Fatalf("session taskId = %q, want cleared", session.TaskID)
	}
}

func TestS56RetargetSyncAcksApplied(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "s56-applied-ack")
	defer db.Close()
	start := testTimerCommand("s56-sync-start", "device-a", "timer-s56-sync", "start", 1, now)
	retarget := testTimerCommand("s56-sync-retarget", "device-a", "timer-s56-sync", "retarget", 2, now.Add(time.Minute))
	retarget.TaskID = "task-s56-001"
	result, err := userStore.Sync(ctx, db, userID, SyncRequest{
		DeviceID: "device-a", Commands: []timer.Command{start, retarget},
	}, now.Add(2*time.Minute))
	if err != nil {
		t.Fatalf("Sync with retarget failed: %v", err)
	}
	if len(result.Acknowledgements) != 2 {
		t.Fatalf("acknowledgements = %d, want 2", len(result.Acknowledgements))
	}
	for _, ack := range result.Acknowledgements {
		if ack.Outcome != "applied" {
			t.Fatalf("command %s outcome = %s/%s, want applied", ack.CommandID, ack.Outcome, ack.Reason)
		}
	}
}

// S57: Core 0.35.0 ships timer.replay.page.v1. Histories over 256 commands
// page live through the real paged endpoint with no direct-reduce fallback.
func TestS57LargeHistoryPagesLive(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "s57-paging-live")
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
	// Direct proof the paged endpoint exists on the pinned wasm.
	var probe timerReplayPage
	if err := callAccountSharedCore(ctx, "timer.replay.page.v1", map[string]any{
		"commands": coreTimerCommands(commands[:1]), "sessions": []coreTimerSession{},
		"currentTimerId": nil, "after": nil,
		"now": now.Add(time.Millisecond).UTC().Format(time.RFC3339Nano),
	}, &probe); err != nil {
		t.Fatalf("timer.replay.page.v1 probe failed: %v", err)
	}
	// Full 300-command replay pages live through the real endpoint.
	paged, err := replayTimerPages(ctx, commands, now.Add(time.Duration(total)*time.Millisecond))
	if err != nil {
		t.Fatalf("300-command paged replay failed: %v", err)
	}
	if len(paged.Outcomes) != total {
		t.Fatalf("paged outcomes = %d, want %d", len(paged.Outcomes), total)
	}
	result, err := userStore.Sync(ctx, db, userID, SyncRequest{
		DeviceID: "device-a", Commands: commands,
	}, now.Add(time.Duration(total)*time.Millisecond))
	if err != nil {
		t.Fatalf("300-command sync failed: %v", err)
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

func TestS57RetargetMixedLargeBatchPagesLive(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	const total = 300
	commands := make([]timer.Command, 0, total)
	for i := 0; i < total-1; i++ {
		at := now.Add(time.Duration(i) * time.Millisecond)
		commands = append(commands, timer.Command{
			ID: "s57-mixed-" + padIndex(i), DeviceID: "device-a",
			DeviceSequence: int64(i + 1), TimerID: "timer-s57-mixed-" + padIndex(i),
			Type: "start", Phase: "focus", PlannedDurationMs: 1_500_000,
			OccurredAt: at, HLCWallMs: at.UnixMilli(), ObservedElapsedMs: 0,
		})
	}
	retargetAt := now.Add(time.Duration(total-1) * time.Millisecond).Add(time.Minute)
	commands = append(commands, timer.Command{
		ID: "s57-mixed-retarget", DeviceID: "device-a", DeviceSequence: total,
		TimerID: "timer-s57-mixed-" + padIndex(total-2), TaskID: "task-s57-mixed",
		Type: "retarget", Phase: "focus", PlannedDurationMs: 1_500_000,
		OccurredAt: retargetAt, HLCWallMs: retargetAt.UnixMilli(), ObservedElapsedMs: 0,
	})
	result, err := reduceTimerWithSharedCore(ctx, commands, retargetAt.Add(time.Minute))
	if err != nil {
		t.Fatalf("retarget-mixed 300-command reduce failed: %v", err)
	}
	outcome, exists := result.Outcomes["s57-mixed-retarget"]
	if !exists || outcome.Outcome != "applied" {
		t.Fatalf("mixed retarget outcome = %+v, want applied", outcome)
	}
	session := findSession(result.Sessions, "timer-s57-mixed-"+padIndex(total-2))
	if session == nil {
		t.Fatal("missing mixed retarget session")
	}
	if session.TaskID != "task-s57-mixed" {
		t.Fatalf("mixed session taskId = %q, want task-s57-mixed", session.TaskID)
	}
}

func findSession(sessions []timer.Session, timerID string) *timer.Session {
	for i := range sessions {
		if sessions[i].TimerID == timerID {
			return &sessions[i]
		}
	}
	return nil
}

// S63: malformed EndedAt must not collapse to zero time and silently
// misorder. The sort falls back to deterministic raw order; validation
// still rejects malformed timestamps fail-closed.
func TestS63MalformedHistoryEndSortsDeterministically(t *testing.T) {
	history := map[string]timer.HistoryItem{
		"timer-aaa": {ID: "history-aaa", TimerID: "timer-aaa", EndedAt: "bad-a"},
		"timer-zzz": {ID: "history-zzz", TimerID: "timer-zzz", EndedAt: "bad-b"},
	}
	_, items := orderedReplayProjection(map[string]coreTimerSession{}, history)
	if len(items) != 2 || items[0].TimerID != "timer-zzz" || items[1].TimerID != "timer-aaa" {
		t.Fatalf("malformed history order = %v, want raw-descending [timer-zzz timer-aaa]", items)
	}
	tied := map[string]timer.HistoryItem{
		"timer-aaa": {ID: "history-aaa", TimerID: "timer-aaa", EndedAt: "bad-same"},
		"timer-zzz": {ID: "history-zzz", TimerID: "timer-zzz", EndedAt: "bad-same"},
	}
	_, tiedItems := orderedReplayProjection(map[string]coreTimerSession{}, tied)
	if len(tiedItems) != 2 || tiedItems[0].TimerID != "timer-aaa" || tiedItems[1].TimerID != "timer-zzz" {
		t.Fatalf("tied malformed history order = %v, want TimerID [timer-aaa timer-zzz]", tiedItems)
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
