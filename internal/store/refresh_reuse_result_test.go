package store

import (
	"crypto/sha256"
	"database/sql"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestRefreshReuseReturnsCommittedSessionGeneration(t *testing.T) {
	db, oldHash, access, refresh, now := refreshReuseResultFixture(t)
	err := RotateRefresh(t.Context(), db, oldHash, access, refresh, now.Add(time.Minute))
	var revoked *RefreshReuseError
	if !errors.As(err, &revoked) || !errors.Is(err, ErrRefreshReuse) {
		t.Fatalf("reuse error = %v, want scoped ErrRefreshReuse", err)
	}
	if revoked.SessionID != "reused-session" || revoked.Generation != 7 {
		t.Fatal("reuse result did not identify the stored session and generation")
	}
	if err.Error() != ErrRefreshReuse.Error() {
		t.Fatal("reuse error text changed or exposed session identity")
	}
	if _, err := Authenticate(t.Context(), db, access.Hash, "access", now.Add(time.Minute)); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("committed reuse left access valid: %v", err)
	}
	var revokedTokens, devicesRevoked int
	if err := db.QueryRowContext(t.Context(), "SELECT COUNT(*) FROM auth_tokens WHERE revoked_at_ms IS NOT NULL").Scan(&revokedTokens); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(t.Context(), "SELECT COUNT(*) FROM devices WHERE revoked_at_ms IS NOT NULL").Scan(&devicesRevoked); err != nil {
		t.Fatal(err)
	}
	if revokedTokens != 3 || devicesRevoked != 0 {
		t.Fatalf("revoked tokens = %d, devices = %d; want 3, 0", revokedTokens, devicesRevoked)
	}
}

func TestRefreshReuseFailuresDoNotReturnCommittedSession(t *testing.T) {
	for _, scenario := range []struct{ name, statement string }{
		{"session write", `CREATE TRIGGER reject_reuse BEFORE UPDATE OF revoked_at_ms ON auth_sessions
			BEGIN SELECT RAISE(ABORT, 'session denied'); END`},
		{"family write", `CREATE TRIGGER reject_reuse BEFORE UPDATE OF revoked_at_ms ON auth_tokens
			BEGIN SELECT RAISE(ABORT, 'family denied'); END`},
		{"commit", `CREATE TABLE reuse_commit_guard (session_id TEXT REFERENCES auth_sessions(id) DEFERRABLE INITIALLY DEFERRED);
			CREATE TRIGGER reject_reuse AFTER UPDATE OF reuse_detected_at_ms ON auth_sessions
			BEGIN INSERT INTO reuse_commit_guard VALUES ('missing-session'); END`},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			db, oldHash, access, refresh, now := refreshReuseResultFixture(t)
			if _, err := db.ExecContext(t.Context(), scenario.statement); err != nil {
				t.Fatal(err)
			}
			err := RotateRefresh(t.Context(), db, oldHash, access, refresh, now.Add(time.Minute))
			var revoked *RefreshReuseError
			if err == nil || errors.As(err, &revoked) || errors.Is(err, ErrRefreshReuse) {
				t.Fatalf("failed revocation reported a committed session: %v", err)
			}
			if scenario.name == "commit" {
				if !strings.HasPrefix(err.Error(), "commit reuse revocation:") {
					t.Fatalf("expected commit failure: %v", err)
				}
				// Reopen after SQLite's failed deferred-constraint commit to inspect durable state.
				db.SetMaxIdleConns(0)
			}
			if _, err := Authenticate(t.Context(), db, access.Hash, "access", now.Add(time.Minute)); err != nil {
				t.Fatalf("failed revocation invalidated access: %v", err)
			}
			var reuseAt sql.NullInt64
			if err := db.QueryRowContext(t.Context(), "SELECT reuse_detected_at_ms FROM auth_sessions WHERE id = 'reused-session'").Scan(&reuseAt); err != nil {
				t.Fatal(err)
			}
			if reuseAt.Valid {
				t.Fatal("failed revocation persisted reuse marker")
			}
		})
	}
}

func refreshReuseResultFixture(t *testing.T) (*sql.DB, [sha256.Size]byte, TokenRecord, TokenRecord, time.Time) {
	t.Helper()
	_, db, userID, now := openTestUser(t, "refresh-reuse-result")
	t.Cleanup(func() { db.Close() })
	if err := setAccountGeneration(t.Context(), db, 7); err != nil {
		t.Fatal(err)
	}
	oldHash := testTokenHash(t, userID)
	if err := CreateSession(t.Context(), db, Session{
		ID: "reused-session", Kind: "native", DeviceID: "shared-device", Platform: "ios",
		CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}, []TokenRecord{{Hash: oldHash, Kind: "refresh", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}}); err != nil {
		t.Fatal(err)
	}
	access := TokenRecord{Hash: testTokenHash(t, userID), Kind: "access", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
	refresh := TokenRecord{Hash: testTokenHash(t, userID), Kind: "refresh", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
	if err := RotateRefresh(t.Context(), db, oldHash, access, refresh, now); err != nil {
		t.Fatalf("normal rotation returned error: %v", err)
	}
	return db, oldHash, access, refresh, now
}
