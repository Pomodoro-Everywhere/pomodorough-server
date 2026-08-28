package store

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProfileLookupWithoutProvisionedProfileIsUnauthorized(t *testing.T) {
	ctx := context.Background()
	_, db, _, _ := openTestUser(t, "missing-profile")
	defer db.Close()
	if _, err := db.ExecContext(ctx, "DELETE FROM profile"); err != nil {
		t.Fatal(err)
	}
	if _, err := ProfileByID(ctx, db); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("ProfileByID error = %v, want ErrUnauthorized", err)
	}
}

func TestProvisioningRollsBackWhenNativeSessionRevocationFails(t *testing.T) {
	ctx := context.Background()
	_, db, userID, now := openTestUser(t, "provision-revocation-rollback")
	defer db.Close()
	if err := CreateSession(ctx, db, Session{ID: "native", Kind: "native", DeviceID: "device", Platform: "ios",
		CreatedAt: now, ExpiresAt: now.Add(time.Hour)}, nil); err != nil {
		t.Fatal(err)
	}
	installSQLAbortTrigger(t, db, "reject_native_revoke", `BEFORE UPDATE OF revoked_at_ms ON auth_sessions
		BEGIN SELECT RAISE(ABORT, 'session revoke denied'); END`)
	profile := Profile{ID: userID, Email: "changed@example.com"}
	err := ProvisionProfileAndSessions(ctx, db, profile, now.Add(time.Minute), nil)
	if err == nil || !strings.Contains(err.Error(), "revoke replaced native sessions") {
		t.Fatalf("ProvisionProfileAndSessions error = %v", err)
	}
	stored, err := ProfileByID(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Email == profile.Email {
		t.Fatal("failed provisioning committed the profile update")
	}
}

func TestSessionRevocationRollsBackWhenTokenRevocationFails(t *testing.T) {
	ctx := context.Background()
	_, db, userID, now := openTestUser(t, "session-revocation-rollback")
	defer db.Close()
	hash := testTokenHash(t, userID)
	if err := CreateSession(ctx, db, Session{ID: "session", Kind: "web", CreatedAt: now, ExpiresAt: now.Add(time.Hour)},
		[]TokenRecord{{Hash: hash, Kind: "access", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}}); err != nil {
		t.Fatal(err)
	}
	installSQLAbortTrigger(t, db, "reject_token_revoke", `BEFORE UPDATE OF revoked_at_ms ON auth_tokens
		BEGIN SELECT RAISE(ABORT, 'token revoke denied'); END`)
	if err := RevokeSession(ctx, db, "session", now.Add(time.Minute)); err == nil || !strings.Contains(err.Error(), "revoke session tokens") {
		t.Fatalf("RevokeSession error = %v", err)
	}
	if _, err := Authenticate(ctx, db, hash, "access", now.Add(2*time.Minute)); err != nil {
		t.Fatalf("rolled-back session revocation invalidated token: %v", err)
	}
}

func TestDeviceRevocationRollsBackAcrossSessionAndTokenFailures(t *testing.T) {
	for _, scenario := range []struct {
		name, trigger, statement, want string
	}{
		{name: "session update", trigger: "reject_device_sessions", statement: `BEFORE UPDATE OF revoked_at_ms ON auth_sessions
			BEGIN SELECT RAISE(ABORT, 'session revoke denied'); END`, want: "revoke device sessions"},
		{name: "token update", trigger: "reject_device_tokens", statement: `BEFORE UPDATE OF revoked_at_ms ON auth_tokens
			BEGIN SELECT RAISE(ABORT, 'token revoke denied'); END`, want: "revoke device tokens"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx := context.Background()
			_, db, userID, now := openTestUser(t, "device-revocation-"+scenario.name)
			defer db.Close()
			hash := testTokenHash(t, userID)
			if err := CreateSession(ctx, db, Session{ID: "session", Kind: "native", DeviceID: "device", Platform: "ios",
				CreatedAt: now, ExpiresAt: now.Add(time.Hour)}, []TokenRecord{{Hash: hash, Kind: "access", CreatedAt: now,
				ExpiresAt: now.Add(time.Hour)}}); err != nil {
				t.Fatal(err)
			}
			installSQLAbortTrigger(t, db, scenario.trigger, scenario.statement)
			if err := RevokeDevice(ctx, db, "device", now.Add(time.Minute)); err == nil || !strings.Contains(err.Error(), scenario.want) {
				t.Fatalf("RevokeDevice error = %v, want %q", err, scenario.want)
			}
			if _, err := Authenticate(ctx, db, hash, "access", now.Add(2*time.Minute)); err != nil {
				t.Fatalf("rolled-back device revocation invalidated token: %v", err)
			}
		})
	}
}

func TestRefreshReuseRevocationRollsBackWhenFamilyWriteFails(t *testing.T) {
	ctx := context.Background()
	_, db, userID, now := openTestUser(t, "reuse-revocation-rollback")
	defer db.Close()
	oldHash := testTokenHash(t, userID)
	if err := CreateSession(ctx, db, Session{ID: "session", Kind: "native", DeviceID: "device", Platform: "ios",
		CreatedAt: now, ExpiresAt: now.Add(time.Hour)}, []TokenRecord{{Hash: oldHash, Kind: "refresh", CreatedAt: now,
		ExpiresAt: now.Add(time.Hour)}}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "UPDATE auth_tokens SET used_at_ms = ? WHERE token_hash = ?", now.UnixMilli(), oldHash[:]); err != nil {
		t.Fatal(err)
	}
	installSQLAbortTrigger(t, db, "reject_reuse_family", `BEFORE UPDATE OF revoked_at_ms ON auth_tokens
		BEGIN SELECT RAISE(ABORT, 'family revoke denied'); END`)
	fresh := TokenRecord{Hash: testTokenHash(t, userID), Kind: "access", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
	err := RotateRefresh(ctx, db, oldHash, fresh, fresh, now.Add(time.Minute))
	if err == nil || !strings.Contains(err.Error(), "revoke reused token family") {
		t.Fatalf("RotateRefresh error = %v", err)
	}
	var revokedAt any
	if err := db.QueryRowContext(ctx, "SELECT revoked_at_ms FROM auth_sessions WHERE id = 'session'").Scan(&revokedAt); err != nil {
		t.Fatal(err)
	}
	if revokedAt != nil {
		t.Fatal("failed reuse-family revocation committed session revocation")
	}
}

func TestRefreshRotationRollsBackWhenSessionExtensionFails(t *testing.T) {
	ctx := context.Background()
	_, db, userID, now := openTestUser(t, "refresh-extension-rollback")
	defer db.Close()
	oldHash := testTokenHash(t, userID)
	if err := CreateSession(ctx, db, Session{ID: "session", Kind: "native", DeviceID: "device", Platform: "ios",
		CreatedAt: now, ExpiresAt: now.Add(time.Hour)}, []TokenRecord{{Hash: oldHash, Kind: "refresh", CreatedAt: now,
		ExpiresAt: now.Add(time.Hour)}}); err != nil {
		t.Fatal(err)
	}
	installSQLAbortTrigger(t, db, "reject_session_extension", `BEFORE UPDATE OF expires_at_ms ON auth_sessions
		BEGIN SELECT RAISE(ABORT, 'extension denied'); END`)
	access := TokenRecord{Hash: testTokenHash(t, userID), Kind: "access", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
	refresh := TokenRecord{Hash: testTokenHash(t, userID), Kind: "refresh", CreatedAt: now, ExpiresAt: now.Add(2 * time.Hour)}
	err := RotateRefresh(ctx, db, oldHash, access, refresh, now.Add(time.Minute))
	if err == nil || !strings.Contains(err.Error(), "extend refresh session") {
		t.Fatalf("RotateRefresh error = %v", err)
	}
	var usedAt any
	if err := db.QueryRowContext(ctx, "SELECT used_at_ms FROM auth_tokens WHERE token_hash = ?", oldHash[:]).Scan(&usedAt); err != nil {
		t.Fatal(err)
	}
	if usedAt != nil {
		t.Fatal("failed refresh extension consumed the old refresh token")
	}
}

func installSQLAbortTrigger(t *testing.T, db *sql.DB, name, statement string) {
	t.Helper()
	if _, err := db.ExecContext(context.Background(), "CREATE TRIGGER "+name+" "+statement); err != nil {
		t.Fatal(err)
	}
}

func TestAuthenticationTransactionFirstWritesFailClosedWithoutPartialMutation(t *testing.T) {
	for _, scenario := range []struct {
		name, trigger, statement, want string
		operation                      func(context.Context, *sql.DB, string, time.Time) error
	}{
		{
			name: "provision token revocation", trigger: "reject_provision_tokens",
			statement: `BEFORE UPDATE OF revoked_at_ms ON auth_tokens BEGIN SELECT RAISE(ABORT, 'token revoke denied'); END`,
			want:      "revoke replaced native session tokens",
			operation: func(ctx context.Context, db *sql.DB, userID string, now time.Time) error {
				return ProvisionProfileAndSessions(ctx, db, Profile{ID: userID, Email: "new@example.com"}, now, nil)
			},
		},
		{
			name: "session revocation", trigger: "reject_session_revoke_first",
			statement: `BEFORE UPDATE OF revoked_at_ms ON auth_sessions BEGIN SELECT RAISE(ABORT, 'session revoke denied'); END`,
			want:      "revoke session",
			operation: func(ctx context.Context, db *sql.DB, _ string, now time.Time) error {
				return RevokeSession(ctx, db, "session", now)
			},
		},
		{
			name: "device revocation", trigger: "reject_device_revoke_first",
			statement: `BEFORE UPDATE OF revoked_at_ms ON devices BEGIN SELECT RAISE(ABORT, 'device revoke denied'); END`,
			want:      "revoke device",
			operation: func(ctx context.Context, db *sql.DB, _ string, now time.Time) error {
				return RevokeDevice(ctx, db, "device", now)
			},
		},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx := context.Background()
			_, db, userID, now := openTestUser(t, "first-write-"+scenario.name)
			defer db.Close()
			hash := testTokenHash(t, userID)
			if err := CreateSession(ctx, db, Session{ID: "session", Kind: "native", DeviceID: "device", Platform: "ios",
				CreatedAt: now, ExpiresAt: now.Add(time.Hour)}, []TokenRecord{{Hash: hash, Kind: "access", CreatedAt: now,
				ExpiresAt: now.Add(time.Hour)}}); err != nil {
				t.Fatal(err)
			}
			installSQLAbortTrigger(t, db, scenario.trigger, scenario.statement)
			if err := scenario.operation(ctx, db, userID, now.Add(time.Minute)); err == nil || !strings.Contains(err.Error(), scenario.want) {
				t.Fatalf("operation error = %v, want %q", err, scenario.want)
			}
			if _, err := Authenticate(ctx, db, hash, "access", now.Add(2*time.Minute)); err != nil {
				t.Fatalf("failed transaction invalidated live token: %v", err)
			}
		})
	}
}

func TestRefreshSecurityWritesRollBackAtConsumptionAndReuseSessionBoundaries(t *testing.T) {
	for _, scenario := range []struct {
		name, trigger, statement, want string
		reused                         bool
	}{
		{name: "consume", trigger: "reject_refresh_consume", statement: `BEFORE UPDATE OF used_at_ms ON auth_tokens
			BEGIN SELECT RAISE(ABORT, 'consume denied'); END`, want: "consume refresh token"},
		{name: "reuse session", trigger: "reject_reuse_session", statement: `BEFORE UPDATE OF revoked_at_ms ON auth_sessions
			BEGIN SELECT RAISE(ABORT, 'session revoke denied'); END`, want: "revoke reused session", reused: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx := context.Background()
			_, db, userID, now := openTestUser(t, "refresh-write-"+scenario.name)
			defer db.Close()
			oldHash := testTokenHash(t, userID)
			if err := CreateSession(ctx, db, Session{ID: "session", Kind: "native", DeviceID: "device", Platform: "ios",
				CreatedAt: now, ExpiresAt: now.Add(time.Hour)}, []TokenRecord{{Hash: oldHash, Kind: "refresh", CreatedAt: now,
				ExpiresAt: now.Add(time.Hour)}}); err != nil {
				t.Fatal(err)
			}
			if scenario.reused {
				if _, err := db.ExecContext(ctx, "UPDATE auth_tokens SET used_at_ms = ? WHERE token_hash = ?", now.UnixMilli(), oldHash[:]); err != nil {
					t.Fatal(err)
				}
			}
			installSQLAbortTrigger(t, db, scenario.trigger, scenario.statement)
			fresh := TokenRecord{Hash: testTokenHash(t, userID), Kind: "access", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
			if err := RotateRefresh(ctx, db, oldHash, fresh, fresh, now.Add(time.Minute)); err == nil || !strings.Contains(err.Error(), scenario.want) {
				t.Fatalf("RotateRefresh error = %v, want %q", err, scenario.want)
			}
		})
	}
}

func TestDeletionLedgerGenerationBoundariesPreserveTheStrongestObligation(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	store, err := NewWithDeletionLedger(filepath.Join(root, "data"), filepath.Join(root, "ledger"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ledgerPath("invalid"); err == nil {
		t.Fatal("ledgerPath accepted an invalid account identifier")
	}
	for _, generation := range []int64{0, MaxSafeRevision + 1} {
		if err := store.recordDeletion(deletionLedgerTestUserID, generation, time.Now()); err == nil {
			t.Fatalf("recordDeletion accepted generation %d", generation)
		}
		if err := setAccountGeneration(ctx, nil, generation); err == nil {
			t.Fatalf("setAccountGeneration accepted generation %d", generation)
		}
	}
	if err := store.recordDeletion(deletionLedgerTestUserID, 2, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := store.recordDeletion(deletionLedgerTestUserID, 1, time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if generation, err := store.deletedGeneration(deletionLedgerTestUserID); err != nil || generation != 2 {
		t.Fatalf("deleted generation = %d, %v; want strongest generation 2", generation, err)
	}
}

func TestDeletionObligationScanSkipsUnrelatedFilesAndRemovesOnlyDeletedGenerations(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	ledgerDir := filepath.Join(root, "ledger")
	store, err := NewWithDeletionLedger(dataDir, ledgerDir)
	if err != nil {
		t.Fatal(err)
	}
	usersDir := filepath.Join(dataDir, "users")
	if err := os.WriteFile(filepath.Join(usersDir, "not-a-user.sqlite"), []byte("ignored"), 0o600); err != nil {
		t.Fatal(err)
	}
	liveID := "22222222222222222222222222222222"
	liveDB, err := store.OpenUser(ctx, liveID)
	if err != nil {
		t.Fatal(err)
	}
	if err := setAccountGeneration(ctx, liveDB, 2); err != nil {
		t.Fatal(err)
	}
	if err := liveDB.Close(); err != nil {
		t.Fatal(err)
	}
	if err := store.recordDeletion(liveID, 1, time.Now()); err != nil {
		t.Fatal(err)
	}
	deletedID := "33333333333333333333333333333333"
	deletedDB, err := store.OpenUser(ctx, deletedID)
	if err != nil {
		t.Fatal(err)
	}
	if err := deletedDB.Close(); err != nil {
		t.Fatal(err)
	}
	if err := store.recordDeletion(deletedID, 1, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := store.applyDeletionObligations(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(usersDir, liveID+".sqlite")); err != nil {
		t.Fatalf("newer live generation was removed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(usersDir, deletedID+".sqlite")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("deleted generation remains: %v", err)
	}
}
