package store

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"pomodorough/internal/timer"
)

// UX round 2 batch C: history rows carry the time a session really ran.

func TestEarlyFinishHistoryRecordsElapsedAcrossReopen(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "history-elapsed-subject")
	deviceID := "device-0001"
	finishedAt := now.Add(7 * time.Minute)
	request := SyncRequest{DeviceID: deviceID, Commands: []timer.Command{
		testTimerCommand("command-0001", deviceID, "timer-000001", "start", 1, now),
		testTimerCommand("command-0002", deviceID, "timer-000001", "finish", 2, finishedAt),
	}}
	if _, err := userStore.Sync(ctx, db, userID, request, finishedAt); err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := userStore.OpenExistingUser(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	history, _, _, err := userStore.History(ctx, db, userID, finishedAt.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 1 || history[0].Status != "completed" || history[0].ElapsedMs == nil {
		t.Fatalf("history = %#v, want one completed row with elapsedMs", history)
	}
	if got := *history[0].ElapsedMs; got != 7*60_000 {
		t.Fatalf("elapsedMs = %d, want %d (finished early, not the 25 minute plan)", got, 7*60_000)
	}
	encoded, err := json.Marshal(history[0])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"elapsedMs":420000`) {
		t.Fatalf("history JSON = %s, want elapsedMs 420000", encoded)
	}
}

func elapsedHistoryFixture(elapsed *int64) (timer.HistoryItem, map[string]coreTimerSession) {
	endedAt := "2026-11-11T12:07:00Z"
	session := coreTimerSession{
		TimerID: "timer-000001", Phase: "focus", Status: "completed", PlannedDurationMs: 25 * 60_000,
		ElapsedAtAnchorMs: 7 * 60_000, AnchorAt: endedAt, StartedAt: "2026-11-11T12:00:00Z", EndedAt: endedAt,
	}
	item := timer.HistoryItem{
		ID: "timer-000001", TimerID: "timer-000001", Phase: "focus", Status: "completed",
		PlannedDurationMs: 25 * 60_000, ElapsedMs: elapsed, CompletedAt: endedAt, EndedAt: endedAt,
	}
	return item, map[string]coreTimerSession{session.TimerID: session}
}

func TestHistoryElapsedWithinPlanMatchingSessionIsAccepted(t *testing.T) {
	elapsed := int64(7 * 60_000)
	item, sessions := elapsedHistoryFixture(&elapsed)
	if _, err := validateCoreHistoryItem(item, sessions, nil); err != nil {
		t.Fatalf("validate = %v, want accepted", err)
	}
}

func TestHistoryElapsedOutsidePlanFailsClosed(t *testing.T) {
	for _, elapsed := range []int64{-1, 25*60_000 + 1} {
		item, sessions := elapsedHistoryFixture(&elapsed)
		// The session agrees with the row, so only the range check can reject it.
		session := sessions[item.TimerID]
		session.ElapsedAtAnchorMs = elapsed
		sessions[item.TimerID] = session
		if _, err := validateCoreHistoryItem(item, sessions, nil); err == nil {
			t.Fatalf("elapsedMs %d was accepted, want fail closed", elapsed)
		}
	}
}

func TestHistoryElapsedDifferentFromSessionFailsClosed(t *testing.T) {
	elapsed := int64(8 * 60_000)
	item, sessions := elapsedHistoryFixture(&elapsed)
	if _, err := validateCoreHistoryItem(item, sessions, nil); err == nil {
		t.Fatal("elapsedMs that differs from its session was accepted, want fail closed")
	}
}

func TestHistoryRowWithoutElapsedLoadsAndGetsNoDefault(t *testing.T) {
	item, sessions := elapsedHistoryFixture(nil)
	if _, err := validateCoreHistoryItem(item, sessions, nil); err != nil {
		t.Fatalf("row without elapsedMs: %v, want accepted", err)
	}
	var decoded timer.HistoryItem
	if err := json.Unmarshal([]byte(`{"id":"a","timerId":"a","phase":"focus","status":"completed","plannedDurationMs":60000}`), &decoded); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(decoded)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "elapsedMs") {
		t.Fatalf("row without elapsedMs encoded as %s, want no default written", encoded)
	}
}
