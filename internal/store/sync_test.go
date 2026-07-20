package store

import (
	"context"
	"strings"
	"testing"
	"time"

	"pomodorough/internal/authn"
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
