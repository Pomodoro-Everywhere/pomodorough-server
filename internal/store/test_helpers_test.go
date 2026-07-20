package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"strings"
	"testing"
	"time"

	"pomodorough/internal/authn"
	"pomodorough/internal/timer"
)

func openTestUser(t *testing.T, subject string) (*Store, *sql.DB, string, time.Time) {
	t.Helper()
	ctx := context.Background()
	userStore, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	userID := authn.UserID([]byte(strings.Repeat("s", 32)), "https://accounts.google.com", subject)
	db, err := userStore.OpenUser(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	if err := UpsertProfile(ctx, db, Profile{
		ID: userID, Issuer: "https://accounts.google.com", Subject: subject, Email: "user@example.com", Name: "Test User", AvatarURL: "https://example.com/avatar.png",
	}, now); err != nil {
		db.Close()
		t.Fatal(err)
	}
	return userStore, db, userID, now
}

func testTokenHash(t *testing.T, userID string) [sha256.Size]byte {
	t.Helper()
	_, hash, err := authn.NewOpaqueToken(userID)
	if err != nil {
		t.Fatal(err)
	}
	return hash
}

func testTimerCommand(id, deviceID, timerID, commandType string, sequence int64, at time.Time) timer.Command {
	observed := int64(0)
	if commandType == "pause" || commandType == "cancel" || commandType == "finish" {
		observed = 1_000
	}
	return timer.Command{
		ID: id, DeviceID: deviceID, DeviceSequence: sequence, TimerID: timerID, Type: commandType,
		Phase: "focus", PlannedDurationMs: 25 * 60_000, OccurredAt: at, HLCWallMs: at.UnixMilli(), ObservedElapsedMs: observed,
	}
}
