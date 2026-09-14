package store

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"reflect"
	"slices"
	"testing"
	"time"

	"pomodorough/internal/timer"
)

// S68: seedTimerCommands exists so the ten-thousand-history replay stays
// inside race-detector budgets. These tests prove the seed helper is a
// faithful stand-in for Sync ingestion and restore Sync-ingestion coverage
// at scale: a fast paging-scale retarget runs in every CI gate, while the
// ten-thousand-command ingestion (paging-256 plus HLC-10k chunking through
// the production Sync path) runs in the scheduled scale workflow via
// POMODOROUGH_SCALE_INGESTION=1.

func s68ScaleIngestionEnabled() bool {
	return os.Getenv("POMODOROUGH_SCALE_INGESTION") == "1"
}

func s68ScaleCommands(device string, base time.Time, offset, count int, prefix string) []timer.Command {
	commands := make([]timer.Command, 0, count)
	for index := 0; index < count; index++ {
		sequence := offset + index
		at := base.Add(time.Duration(sequence) * time.Millisecond)
		commands = append(commands, timer.Command{
			ID: fmt.Sprintf("%s-%08d", prefix, sequence), DeviceID: device,
			DeviceSequence: int64(sequence + 1), TimerID: fmt.Sprintf("timer-s68-%08d", sequence),
			Type: "start", Phase: "focus", PlannedDurationMs: 25 * 60_000,
			OccurredAt: at, HLCWallMs: at.UnixMilli(), ObservedElapsedMs: 0,
		})
	}
	return commands
}

func s68TimerRows(t *testing.T, db *sql.DB) []string {
	t.Helper()
	rows, err := db.Query(`SELECT id, device_id, device_sequence, timer_id,
		IFNULL(task_id, ''), command_type, phase, planned_duration_ms,
		occurred_at, occurred_at_ms, hlc_wall_ms, hlc_counter, observed_elapsed_ms
		FROM timer_commands ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id, deviceID, timerID, taskID, commandType, phase, occurredAt string
		var sequence, plannedMs, occurredMs, hlcWall, hlcCounter, observed int64
		if err := rows.Scan(&id, &deviceID, &sequence, &timerID, &taskID,
			&commandType, &phase, &plannedMs, &occurredAt, &occurredMs,
			&hlcWall, &hlcCounter, &observed); err != nil {
			t.Fatal(err)
		}
		out = append(out, fmt.Sprintf("%s|%s|%d|%s|%s|%s|%s|%d|%s|%d|%d|%d|%d",
			id, deviceID, sequence, timerID, taskID, commandType, phase,
			plannedMs, occurredAt, occurredMs, hlcWall, hlcCounter, observed))
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func s68SeedCheckCommands(now time.Time) []timer.Command {
	commands := []timer.Command{
		testTimerCommand("s68-op-01", "device-s68", "timer-s68-a", "start", 1, now),
		testTimerCommand("s68-op-02", "device-s68", "timer-s68-a", "pause", 2, now.Add(2*time.Millisecond)),
		testTimerCommand("s68-op-03", "device-s68", "timer-s68-b", "start", 3, now.Add(3*time.Millisecond)),
		testTimerCommand("s68-op-04", "device-s68", "timer-s68-b", "retarget", 4, now.Add(4*time.Millisecond)),
		testTimerCommand("s68-op-05", "device-s68", "timer-s68-c", "start", 5, now.Add(5*time.Millisecond)),
		testTimerCommand("s68-op-06", "device-s68", "timer-s68-c", "pause", 6, now.Add(6*time.Millisecond)),
	}
	commands[3].TaskID = "task-s68-seed-check"
	return commands
}

func s68AssertSameProjection(t *testing.T, ingested, seeded SyncResult) {
	t.Helper()
	if ingested.CanonicalTimer == nil || seeded.CanonicalTimer == nil {
		t.Fatalf("canonical missing: ingested=%#v seeded=%#v", ingested.CanonicalTimer, seeded.CanonicalTimer)
	}
	if !reflect.DeepEqual(ingested.CanonicalTimer, seeded.CanonicalTimer) {
		t.Fatalf("canonical differs: %#v vs %#v", ingested.CanonicalTimer, seeded.CanonicalTimer)
	}
	ingestedTimers := make([]string, 0, len(ingested.History))
	for _, item := range ingested.History {
		ingestedTimers = append(ingestedTimers, item.TimerID)
	}
	seededTimers := make([]string, 0, len(seeded.History))
	for _, item := range seeded.History {
		seededTimers = append(seededTimers, item.TimerID)
	}
	if !slices.Equal(ingestedTimers, seededTimers) {
		t.Fatalf("history differs: %v vs %v", ingestedTimers, seededTimers)
	}
}

func TestS68SeedMatchesSyncIngestionRows(t *testing.T) {
	ctx := context.Background()
	ingestStore, ingestDB, ingestUser, now := openTestUser(t, "s68-ingest")
	defer ingestDB.Close()
	seedStore, seedDB, seedUser, _ := openTestUser(t, "s68-seed")
	defer seedDB.Close()
	commands := s68SeedCheckCommands(now)
	ingested, err := ingestStore.Sync(ctx, ingestDB, ingestUser, SyncRequest{
		DeviceID: "device-s68", Commands: commands,
	}, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	seedTimerCommands(t, seedDB, "device-s68", commands)
	seeded, err := seedStore.Sync(ctx, seedDB, seedUser, SyncRequest{
		DeviceID: "device-s68",
	}, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(s68TimerRows(t, ingestDB), s68TimerRows(t, seedDB)) {
		t.Fatal("seeded timer rows differ from Sync-ingested rows")
	}
	s68AssertSameProjection(t, ingested, seeded)
}

// wantHistory is len(commands) when the newest session already completed
// (it stays in history) and len(commands)-1 while it is still running as
// the canonical timer (running sessions are not history items).
func s68AssertHistoryOrder(t *testing.T, result SyncResult, commands []timer.Command, wantHistory int) {
	t.Helper()
	if len(result.History) != wantHistory {
		t.Fatalf("history = %d, want %d", len(result.History), wantHistory)
	}
	if result.History[len(result.History)-1].TimerID != commands[0].TimerID {
		t.Fatal("oldest session missing or reordered")
	}
	if result.CanonicalTimer == nil || result.CanonicalTimer.ID != commands[len(commands)-1].TimerID {
		t.Fatalf("canonical = %#v, want newest %s", result.CanonicalTimer, commands[len(commands)-1].TimerID)
	}
}

func s68AssertRetargetApplied(t *testing.T, result SyncResult, commandID, timerID, taskID string) {
	t.Helper()
	for _, ack := range result.Acknowledgements {
		if ack.CommandID == commandID && ack.Outcome != "applied" {
			t.Fatalf("retarget outcome = %s/%s, want applied", ack.Outcome, ack.Reason)
		}
	}
	if result.CanonicalTimer == nil || result.CanonicalTimer.ID != timerID {
		t.Fatalf("canonical = %#v, want timer %s", result.CanonicalTimer, timerID)
	}
	if result.CanonicalTimer.TaskID != taskID {
		t.Fatalf("canonical task = %q, want %q", result.CanonicalTimer.TaskID, taskID)
	}
}

func TestS68RetargetAfterPagedHistoryViaSync(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "s68-paged-retarget")
	defer db.Close()
	const total = 300
	commands := s68ScaleCommands("device-s68", now, 0, total, "s68-page")
	first, err := userStore.Sync(ctx, db, userID, SyncRequest{
		DeviceID: "device-s68", Commands: commands,
	}, now.Add(10*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	s68AssertHistoryOrder(t, first, commands, total-1)
	retarget := testTimerCommand("s68-page-retarget", "device-s68",
		commands[total-1].TimerID, "retarget", total+1, now.Add(11*time.Minute))
	retarget.TaskID = "task-s68-paged"
	second, err := userStore.Sync(ctx, db, userID, SyncRequest{
		DeviceID: "device-s68", LastRevision: first.Revision,
		Commands: []timer.Command{retarget},
	}, now.Add(12*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	s68AssertRetargetApplied(t, second, retarget.ID, commands[total-1].TimerID, "task-s68-paged")
}

func TestS68SyncIngestionTenThousandHistoriesAndRetarget(t *testing.T) {
	if !s68ScaleIngestionEnabled() {
		t.Skip("set POMODOROUGH_SCALE_INGESTION=1 to ingest ten thousand commands through Sync")
	}
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "s68-scale-ingest")
	defer db.Close()
	const total = 10001
	commands := s68ScaleCommands("device-s68", now, 0, total, "s68-scale")
	first, err := userStore.Sync(ctx, db, userID, SyncRequest{
		DeviceID: "device-s68", Commands: commands,
	}, now.Add(10*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	s68AssertHistoryOrder(t, first, commands, total-1)
	retarget := testTimerCommand("s68-scale-retarget", "device-s68",
		commands[total-1].TimerID, "retarget", total+1, now.Add(11*time.Minute))
	retarget.TaskID = "task-s68-scale"
	second, err := userStore.Sync(ctx, db, userID, SyncRequest{
		DeviceID: "device-s68", LastRevision: first.Revision,
		Commands: []timer.Command{retarget},
	}, now.Add(12*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	s68AssertRetargetApplied(t, second, retarget.ID, commands[total-1].TimerID, "task-s68-scale")
}
