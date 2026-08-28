package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestOpenUserReusesLiveAccountAndReplacesRestoredDeletedGeneration(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	ledgerDir := filepath.Join(root, "deletion-ledger")
	userID := "11111111111111111111111111111111"
	userStore, err := NewWithDeletionLedger(dataDir, ledgerDir)
	if err != nil {
		t.Fatal(err)
	}

	db, err := userStore.OpenUser(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE account_state SET revision = 7 WHERE singleton = 1`); err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dataDir, "users", userID+".sqlite")
	generationOne, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	reopened, err := userStore.OpenUser(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	var revision int64
	if err := reopened.QueryRowContext(ctx, `SELECT revision FROM account_state WHERE singleton = 1`).Scan(&revision); err != nil {
		reopened.Close()
		t.Fatal(err)
	}
	if revision != 7 {
		reopened.Close()
		t.Fatalf("reused account revision = %d, want 7", revision)
	}
	if err := reopened.Close(); err != nil {
		t.Fatal(err)
	}

	if err := userStore.DeleteUserForGeneration(ctx, userID, 1); err != nil {
		t.Fatal(err)
	}
	restoreDatabase(t, path, generationOne)
	recreated, err := userStore.OpenUser(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	defer recreated.Close()
	generation, err := accountGeneration(ctx, recreated)
	if err != nil {
		t.Fatal(err)
	}
	if err := recreated.QueryRowContext(ctx, `SELECT revision FROM account_state WHERE singleton = 1`).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	if generation != 2 || revision != 0 {
		t.Fatalf("recreated account generation=%d revision=%d, want generation=2 revision=0", generation, revision)
	}
}

func TestRefreshRotationRejectsMissingWrongKindAndExpiredTokensWithoutMutation(t *testing.T) {
	ctx := context.Background()
	_, db, userID, now := openTestUser(t, "refresh-rejection-boundaries")
	defer db.Close()
	accessHash := testTokenHash(t, userID)
	expiredRefreshHash := testTokenHash(t, userID)
	if err := CreateSession(ctx, db, Session{
		ID: "security-session", Kind: "native", DeviceID: "security-device", Platform: "ios",
		CreatedAt: now, ExpiresAt: now.Add(24 * time.Hour),
	}, []TokenRecord{
		{Hash: accessHash, Kind: "access", CreatedAt: now, ExpiresAt: now.Add(time.Hour)},
		{Hash: expiredRefreshHash, Kind: "refresh", CreatedAt: now.Add(-2 * time.Hour), ExpiresAt: now.Add(-time.Hour)},
	}); err != nil {
		t.Fatal(err)
	}
	newToken := func(kind string) TokenRecord {
		return TokenRecord{Hash: testTokenHash(t, userID), Kind: kind, CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
	}

	for name, oldHash := range map[string][32]byte{
		"missing":    testTokenHash(t, userID),
		"wrong kind": accessHash,
		"expired":    expiredRefreshHash,
	} {
		t.Run(name, func(t *testing.T) {
			if err := RotateRefresh(ctx, db, oldHash, newToken("access"), newToken("refresh"), now); !errors.Is(err, ErrUnauthorized) {
				t.Fatalf("RotateRefresh error = %v, want ErrUnauthorized", err)
			}
		})
	}
	if _, err := Authenticate(ctx, db, accessHash, "access", now); err != nil {
		t.Fatalf("rejected refresh rotation mutated live access token: %v", err)
	}
}

func TestProvisioningFailureRollsBackProfileAndNativeFamilyReplacement(t *testing.T) {
	ctx := context.Background()
	_, db, userID, now := openTestUser(t, "provision-rollback-boundary")
	defer db.Close()
	oldProfile := Profile{ID: userID, Issuer: "issuer", Subject: "old-subject", Email: "old@example.com", Name: "Old"}
	if err := UpsertProfile(ctx, db, oldProfile, now); err != nil {
		t.Fatal(err)
	}
	oldHash := testTokenHash(t, userID)
	if err := CreateSession(ctx, db, Session{
		ID: "old-native", Kind: "native", DeviceID: "old-device", Platform: "ios",
		CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}, []TokenRecord{{Hash: oldHash, Kind: "access", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}}); err != nil {
		t.Fatal(err)
	}
	newHash := testTokenHash(t, userID)
	duplicate := Session{
		ID: "duplicate-session", Kind: "native", DeviceID: "new-device", Platform: "android",
		CreatedAt: now.Add(time.Minute), ExpiresAt: now.Add(2 * time.Hour),
	}
	err := ProvisionProfileAndSessions(ctx, db,
		Profile{ID: userID, Issuer: "issuer", Subject: "new-subject", Email: "new@example.com", Name: "New"},
		now.Add(time.Minute),
		[]SessionTokens{
			{Session: duplicate, Tokens: []TokenRecord{{Hash: newHash, Kind: "access", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}}},
			{Session: duplicate},
		},
	)
	if err == nil {
		t.Fatal("duplicate replacement session unexpectedly committed")
	}
	if _, err := Authenticate(ctx, db, oldHash, "access", now.Add(2*time.Minute)); err != nil {
		t.Fatalf("failed replacement revoked original native family: %v", err)
	}
	if _, err := Authenticate(ctx, db, newHash, "access", now.Add(2*time.Minute)); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("failed replacement persisted new token: %v", err)
	}
	profile, err := ProfileByID(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if profile.Subject != oldProfile.Subject || profile.Email != oldProfile.Email {
		t.Fatalf("failed replacement persisted profile = %#v, want %#v", profile, oldProfile)
	}
	var newDevices int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM devices WHERE id = 'new-device'`).Scan(&newDevices); err != nil {
		t.Fatal(err)
	}
	if newDevices != 0 {
		t.Fatalf("failed replacement persisted %d new devices", newDevices)
	}
}
