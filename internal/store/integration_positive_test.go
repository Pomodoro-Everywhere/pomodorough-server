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
	history, revision, err := History(ctx, db, now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if revision != 1 || len(history) != 1 || history[0].Status != "cancelled" || history[0].CommandID != "command-0002" {
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
