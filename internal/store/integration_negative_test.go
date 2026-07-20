package store

import (
	"context"
	"crypto/sha256"
	"errors"
	"strings"
	"testing"
	"time"

	"pomodorough/internal/authn"
	"pomodorough/internal/timer"
)

func TestRefreshReuseRevokesSessionFamily(t *testing.T) {
	ctx := context.Background()
	userStore, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	userID := authn.UserID([]byte(strings.Repeat("s", 32)), "https://accounts.google.com", "refresh-subject")
	db, err := userStore.OpenUser(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	if err := UpsertProfile(ctx, db, Profile{ID: userID, Issuer: "https://accounts.google.com", Subject: "refresh-subject", Email: "user@example.com"}, now); err != nil {
		t.Fatal(err)
	}
	oldRefreshToken, oldRefreshHash, err := authn.NewOpaqueToken(userID)
	if err != nil {
		t.Fatal(err)
	}
	_ = oldRefreshToken
	if err := CreateSession(ctx, db, Session{
		ID: "session-family", Kind: "native", DeviceID: "device-0001", Platform: "ios", CreatedAt: now, ExpiresAt: now.Add(24 * time.Hour),
	}, []TokenRecord{{Hash: oldRefreshHash, Kind: "refresh", CreatedAt: now, ExpiresAt: now.Add(24 * time.Hour)}}); err != nil {
		t.Fatal(err)
	}

	_, firstAccessHash, _ := authn.NewOpaqueToken(userID)
	_, firstRefreshHash, _ := authn.NewOpaqueToken(userID)
	firstAccess := TokenRecord{Hash: firstAccessHash, Kind: "access", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
	firstRefresh := TokenRecord{Hash: firstRefreshHash, Kind: "refresh", CreatedAt: now, ExpiresAt: now.Add(24 * time.Hour)}
	if err := RotateRefresh(ctx, db, oldRefreshHash, firstAccess, firstRefresh, now); err != nil {
		t.Fatal(err)
	}

	_, secondAccessHash, _ := authn.NewOpaqueToken(userID)
	_, secondRefreshHash, _ := authn.NewOpaqueToken(userID)
	err = RotateRefresh(ctx, db, oldRefreshHash,
		TokenRecord{Hash: secondAccessHash, Kind: "access", CreatedAt: now, ExpiresAt: now.Add(time.Hour)},
		TokenRecord{Hash: secondRefreshHash, Kind: "refresh", CreatedAt: now, ExpiresAt: now.Add(24 * time.Hour)},
		now.Add(time.Second),
	)
	if !errors.Is(err, ErrRefreshReuse) {
		t.Fatalf("reuse error = %v, want ErrRefreshReuse", err)
	}
	if _, err := Authenticate(ctx, db, firstAccessHash, "access", now.Add(2*time.Second)); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("rotated access token remained valid after reuse: %v", err)
	}
}

func TestSyncRejectsReusedDeviceSequenceWithoutMutatingProjection(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "sync-conflict-subject")
	defer db.Close()
	deviceID := "device-0001"
	start := testTimerCommand("command-0001", deviceID, "timer-000001", "start", 1, now)
	first, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: deviceID, Commands: []timer.Command{start}}, now)
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision != 1 {
		t.Fatalf("first revision = %d, want 1", first.Revision)
	}

	conflict := testTimerCommand("command-conflict", deviceID, "timer-000001", "finish", 1, now.Add(time.Second))
	pause := testTimerCommand("command-0002", deviceID, "timer-000001", "pause", 2, now.Add(2*time.Second))
	second, err := userStore.Sync(ctx, db, userID, SyncRequest{
		DeviceID: deviceID,
		Commands: []timer.Command{start, conflict, pause},
	}, now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if second.Revision != 2 || len(second.Acknowledgements) != 3 {
		t.Fatalf("second sync = %#v", second)
	}
	wantIDs := []string{"command-0001", "command-conflict", "command-0002"}
	wantOutcomes := []string{"applied", "rejected", "applied"}
	for index := range wantIDs {
		ack := second.Acknowledgements[index]
		if ack.CommandID != wantIDs[index] || ack.Outcome != wantOutcomes[index] {
			t.Fatalf("acknowledgement %d = %#v, want %s/%s", index, ack, wantIDs[index], wantOutcomes[index])
		}
	}
	if second.Acknowledgements[1].Reason != "device sequence already used" {
		t.Fatalf("conflict reason = %q", second.Acknowledgements[1].Reason)
	}
	if second.CanonicalTimer == nil || second.CanonicalTimer.Status != "paused" {
		t.Fatalf("rejected finish changed projection: %#v", second.CanonicalTimer)
	}
	var commandCount int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM timer_commands`).Scan(&commandCount); err != nil {
		t.Fatal(err)
	}
	if commandCount != 2 {
		t.Fatalf("stored command count = %d, want 2", commandCount)
	}
}

func TestAuthenticateRejectsWrongKindAndExpirationBoundaries(t *testing.T) {
	ctx := context.Background()
	_, db, userID, now := openTestUser(t, "authentication-boundary-subject")
	defer db.Close()

	tokenExpires := now.Add(time.Hour)
	tokenHash := testTokenHash(t, userID)
	if err := CreateSession(ctx, db, Session{
		ID: "token-expiry-session", Kind: "native", DeviceID: "device-0001", Platform: "ios", CreatedAt: now, ExpiresAt: now.Add(2 * time.Hour),
	}, []TokenRecord{{Hash: tokenHash, Kind: "access", CreatedAt: now, ExpiresAt: tokenExpires}}); err != nil {
		t.Fatal(err)
	}
	for name, testCase := range map[string]struct {
		kind string
		at   time.Time
	}{
		"wrong kind":         {kind: "refresh", at: now.Add(time.Minute)},
		"token exact expiry": {kind: "access", at: tokenExpires},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Authenticate(ctx, db, tokenHash, testCase.kind, testCase.at); !errors.Is(err, ErrUnauthorized) {
				t.Fatalf("Authenticate() error = %v, want ErrUnauthorized", err)
			}
		})
	}

	sessionExpires := now.Add(30 * time.Minute)
	sessionToken := testTokenHash(t, userID)
	if err := CreateSession(ctx, db, Session{
		ID: "session-expiry-session", Kind: "native", DeviceID: "device-0002", Platform: "ios", CreatedAt: now, ExpiresAt: sessionExpires,
	}, []TokenRecord{{Hash: sessionToken, Kind: "access", CreatedAt: now, ExpiresAt: now.Add(2 * time.Hour)}}); err != nil {
		t.Fatal(err)
	}
	if _, err := Authenticate(ctx, db, sessionToken, "access", sessionExpires); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("session exact expiry error = %v, want ErrUnauthorized", err)
	}
}

func TestRevocationAndCSRFUpdatesRejectInvalidSessions(t *testing.T) {
	ctx := context.Background()
	_, db, userID, now := openTestUser(t, "revocation-subject")
	defer db.Close()
	csrf := authn.HashString("csrf")
	if err := UpdateCSRF(ctx, db, "missing-session", csrf); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("missing session UpdateCSRF() error = %v", err)
	}

	firstHash := testTokenHash(t, userID)
	if err := CreateSession(ctx, db, Session{
		ID: "first-session", Kind: "native", DeviceID: "device-0001", Platform: "ios", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}, []TokenRecord{{Hash: firstHash, Kind: "access", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}}); err != nil {
		t.Fatal(err)
	}
	if err := RevokeSession(ctx, db, "first-session", now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := Authenticate(ctx, db, firstHash, "access", now.Add(2*time.Minute)); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("revoked session Authenticate() error = %v", err)
	}
	if err := UpdateCSRF(ctx, db, "first-session", csrf); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("revoked session UpdateCSRF() error = %v", err)
	}

	deviceASecondHash := testTokenHash(t, userID)
	deviceBHash := testTokenHash(t, userID)
	for _, setup := range []struct {
		id       string
		deviceID string
		hash     [sha256.Size]byte
	}{
		{id: "device-a-second-session", deviceID: "device-0001", hash: deviceASecondHash},
		{id: "device-b-session", deviceID: "device-0002", hash: deviceBHash},
	} {
		if err := CreateSession(ctx, db, Session{
			ID: setup.id, Kind: "native", DeviceID: setup.deviceID, Platform: "ios", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
		}, []TokenRecord{{Hash: setup.hash, Kind: "access", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}}); err != nil {
			t.Fatal(err)
		}
	}
	if err := RevokeDevice(ctx, db, "device-0001", now.Add(3*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := Authenticate(ctx, db, deviceASecondHash, "access", now.Add(4*time.Minute)); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("revoked device token error = %v", err)
	}
	if _, err := Authenticate(ctx, db, deviceBHash, "access", now.Add(4*time.Minute)); err != nil {
		t.Fatalf("other device was revoked: %v", err)
	}
}
