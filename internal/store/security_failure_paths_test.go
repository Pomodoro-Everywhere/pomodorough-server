package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestAuthenticationMutationsFailClosedWhenDatabaseIsUnavailable(t *testing.T) {
	ctx := context.Background()
	_, db, userID, now := openTestUser(t, "closed-auth-database")
	tokenHash := testTokenHash(t, userID)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	operations := map[string]func() error{
		"upsert profile": func() error {
			return UpsertProfile(ctx, db, Profile{ID: userID}, now)
		},
		"create session": func() error {
			return CreateSession(ctx, db, Session{ID: "closed-session"}, nil)
		},
		"provision account": func() error {
			return ProvisionProfileAndSessions(ctx, db, Profile{ID: userID}, now, nil)
		},
		"update csrf": func() error {
			return UpdateCSRF(ctx, db, "closed-session", tokenHash)
		},
		"revoke session": func() error {
			return RevokeSession(ctx, db, "closed-session", now)
		},
		"revoke device": func() error {
			return RevokeDevice(ctx, db, "closed-device", now)
		},
		"rotate refresh": func() error {
			token := TokenRecord{Hash: tokenHash, Kind: "access", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
			return RotateRefresh(ctx, db, tokenHash, token, token, now)
		},
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); err == nil {
				t.Fatal("operation succeeded against a closed authentication database")
			}
		})
	}
	if _, err := ProfileByID(ctx, db); err == nil || errors.Is(err, ErrUnauthorized) {
		t.Fatalf("ProfileByID error = %v, want storage failure rather than unauthorized", err)
	}
	if _, err := Authenticate(ctx, db, tokenHash, "access", now); err == nil || errors.Is(err, ErrUnauthorized) {
		t.Fatalf("Authenticate error = %v, want storage failure rather than unauthorized", err)
	}
}

func TestCreateSessionRollsBackDeviceAndSessionWhenTokenInsertFails(t *testing.T) {
	ctx := context.Background()
	_, db, userID, now := openTestUser(t, "session-token-rollback")
	defer db.Close()
	duplicateHash := testTokenHash(t, userID)
	if err := CreateSession(ctx, db, Session{
		ID: "existing-session", Kind: "native", DeviceID: "existing-device", Platform: "ios",
		CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}, []TokenRecord{{Hash: duplicateHash, Kind: "access", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}}); err != nil {
		t.Fatal(err)
	}

	err := CreateSession(ctx, db, Session{
		ID: "rolled-back-session", Kind: "native", DeviceID: "rolled-back-device", Platform: "android",
		CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}, []TokenRecord{{Hash: duplicateHash, Kind: "access", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}})
	if err == nil || !strings.Contains(err.Error(), "insert auth token") {
		t.Fatalf("CreateSession error = %v, want duplicate-token insertion failure", err)
	}
	checks := []struct {
		table, column, value string
	}{
		{table: "auth_sessions", column: "id", value: "rolled-back-session"},
		{table: "devices", column: "id", value: "rolled-back-device"},
	}
	for _, check := range checks {
		var count int
		query := "SELECT COUNT(*) FROM " + check.table + " WHERE " + check.column + " = ?"
		if err := db.QueryRowContext(ctx, query, check.value).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("failed session creation left %s row %q", check.table, check.value)
		}
	}
}

func TestRefreshRotationInsertionFailureLeavesOldRefreshUsable(t *testing.T) {
	ctx := context.Background()
	_, db, userID, now := openTestUser(t, "refresh-write-rollback")
	defer db.Close()
	oldRefresh := testTokenHash(t, userID)
	conflictingHash := testTokenHash(t, userID)
	if err := CreateSession(ctx, db, Session{
		ID: "rotation-session", Kind: "native", DeviceID: "rotation-device", Platform: "ios",
		CreatedAt: now, ExpiresAt: now.Add(24 * time.Hour),
	}, []TokenRecord{
		{Hash: oldRefresh, Kind: "refresh", CreatedAt: now, ExpiresAt: now.Add(24 * time.Hour)},
		{Hash: conflictingHash, Kind: "access", CreatedAt: now, ExpiresAt: now.Add(time.Hour)},
	}); err != nil {
		t.Fatal(err)
	}

	failedRefresh := TokenRecord{Hash: testTokenHash(t, userID), Kind: "refresh", CreatedAt: now, ExpiresAt: now.Add(24 * time.Hour)}
	err := RotateRefresh(ctx, db, oldRefresh,
		TokenRecord{Hash: conflictingHash, Kind: "access", CreatedAt: now, ExpiresAt: now.Add(time.Hour)},
		failedRefresh, now.Add(time.Minute))
	if err == nil || !strings.Contains(err.Error(), "insert rotated token") {
		t.Fatalf("RotateRefresh error = %v, want duplicate-token insertion failure", err)
	}

	access := TokenRecord{Hash: testTokenHash(t, userID), Kind: "access", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
	refresh := TokenRecord{Hash: testTokenHash(t, userID), Kind: "refresh", CreatedAt: now, ExpiresAt: now.Add(24 * time.Hour)}
	if err := RotateRefresh(ctx, db, oldRefresh, access, refresh, now.Add(2*time.Minute)); err != nil {
		t.Fatalf("old refresh was consumed by rolled-back rotation: %v", err)
	}
	if _, err := Authenticate(ctx, db, access.Hash, "access", now.Add(3*time.Minute)); err != nil {
		t.Fatalf("successful retry access token did not authenticate: %v", err)
	}
}
