package store

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"pomodorough/internal/authn"
)

const nativeChallengeS4Domain = "google-native-exchange-v1"

func TestS4NativeChallengeDigestDomainBindingIsFrozen(t *testing.T) {
	digest := HashNativeChallenge(nativeChallengeS4Domain, "sealed-token")
	got := hex.EncodeToString(digest[:])
	want := "f11ab8779587308541b45a9eb8df4de9fe862842d6074d33126ac352a2bcd5fc"
	if got != want {
		t.Fatalf("digest = %s, want %s", got, want)
	}
	if digest == HashNativeChallenge("other-domain", "sealed-token") {
		t.Fatal("challenge digest ignored domain")
	}
}

func TestS4NativeChallengeRollbackLeavesChallengeRetryable(t *testing.T) {
	ctx := context.Background()
	userStore, db, profile, now := openNativeChallengeS4Account(t, t.TempDir(), "rollback")
	defer db.Close()
	digest := HashNativeChallenge(nativeChallengeS4Domain, "rollback-challenge")
	if err := userStore.CreateNativeChallenge(ctx, digest, nativeChallengeS4Domain, now, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	broken := nativeChallengeS4Consumption(t, digest, profile, "rollback-device", now)
	broken.Session.Kind = "invalid"
	if err := userStore.ConsumeNativeChallengeAndCreateSession(ctx, db, broken); err == nil {
		t.Fatal("invalid session unexpectedly committed")
	}
	assertNativeChallengeS4Count(t, db, "profile", 0)
	valid := nativeChallengeS4Consumption(t, digest, profile, "retry-device", now.Add(time.Second))
	if err := userStore.ConsumeNativeChallengeAndCreateSession(ctx, db, valid); err != nil {
		t.Fatalf("retry after rollback: %v", err)
	}
	if err := userStore.ConsumeNativeChallengeAndCreateSession(ctx, db, valid); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("replay error = %v, want unauthorized", err)
	}
	assertNativeChallengeS4Count(t, db, "auth_sessions", 1)
	assertNativeChallengeS4Count(t, db, "auth_tokens", 2)
}

func TestS4NativeChallengeRejectsWrongDomainMalformedAndExpired(t *testing.T) {
	ctx := context.Background()
	userStore, db, profile, now := openNativeChallengeS4Account(t, t.TempDir(), "boundaries")
	defer db.Close()
	digest := HashNativeChallenge(nativeChallengeS4Domain, "domain-challenge")
	if err := userStore.CreateNativeChallenge(ctx, digest, nativeChallengeS4Domain, now, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	wrongDomain := nativeChallengeS4Consumption(t, digest, profile, "wrong-domain", now)
	wrongDomain.Domain = "other-native-exchange"
	assertNativeChallengeS4Unauthorized(t, userStore, db, wrongDomain)
	missing := nativeChallengeS4Consumption(t, HashNativeChallenge(nativeChallengeS4Domain, "missing"), profile, "missing", now)
	assertNativeChallengeS4Unauthorized(t, userStore, db, missing)
	valid := nativeChallengeS4Consumption(t, digest, profile, "valid-domain", now)
	if err := userStore.ConsumeNativeChallengeAndCreateSession(ctx, db, valid); err != nil {
		t.Fatalf("correct domain after rejection: %v", err)
	}
	expiredDigest := HashNativeChallenge(nativeChallengeS4Domain, "expired")
	issuedAt := now.Add(-2 * time.Minute)
	if err := userStore.CreateNativeChallenge(ctx, expiredDigest, nativeChallengeS4Domain, issuedAt, now.Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	expired := nativeChallengeS4Consumption(t, expiredDigest, profile, "expired", now)
	assertNativeChallengeS4Unauthorized(t, userStore, db, expired)
	futureDigest := HashNativeChallenge(nativeChallengeS4Domain, "future")
	issuedAt = now.Add(time.Minute)
	if err := userStore.CreateNativeChallenge(ctx, futureDigest, nativeChallengeS4Domain, issuedAt, issuedAt.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	future := nativeChallengeS4Consumption(t, futureDigest, profile, "future", now)
	assertNativeChallengeS4Unauthorized(t, userStore, db, future)
}

func TestS4NativeChallengeConcurrentReplayAcrossAccounts(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	userStore, firstDB, firstProfile, now := openNativeChallengeS4Account(t, dataDir, "first-account")
	defer firstDB.Close()
	secondDB, secondProfile := openNativeChallengeS4User(t, userStore, "second-account")
	defer secondDB.Close()
	digest := HashNativeChallenge(nativeChallengeS4Domain, "shared-challenge")
	if err := userStore.CreateNativeChallenge(ctx, digest, nativeChallengeS4Domain, now, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	attempts := []nativeChallengeS4Attempt{
		{firstDB, nativeChallengeS4Consumption(t, digest, firstProfile, "first-device", now)},
		{secondDB, nativeChallengeS4Consumption(t, digest, secondProfile, "second-device", now)},
	}
	results := runNativeChallengeS4Attempts(userStore, attempts)
	assertNativeChallengeS4ConcurrentResults(t, results)
	assertNativeChallengeS4TotalSessions(t, firstDB, secondDB, 1)
}

func TestS4NativeChallengeConsumptionSurvivesStoreRestart(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	userStore, db, profile, now := openNativeChallengeS4Account(t, dataDir, "restart")
	digest := HashNativeChallenge(nativeChallengeS4Domain, "restart-challenge")
	if err := userStore.CreateNativeChallenge(ctx, digest, nativeChallengeS4Domain, now, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	valid := nativeChallengeS4Consumption(t, digest, profile, "restart-device", now)
	if err := userStore.ConsumeNativeChallengeAndCreateSession(ctx, db, valid); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	forgetNativeChallengeS4Spent(userStore, digest)
	reopened, err := restarted.OpenExistingUser(ctx, profile.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	assertNativeChallengeS4Count(t, reopened, "native_challenge_consumptions", 1)
	if err := restarted.ConsumeNativeChallengeAndCreateSession(ctx, reopened, valid); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("replay after restart error = %v, want unauthorized", err)
	}
}

func TestS4NativeChallengeConsumptionSurvivesProcessRestart(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	userStore, db, profile, now := openNativeChallengeS4Account(t, dataDir, "process-restart")
	digest := HashNativeChallenge(nativeChallengeS4Domain, "process-restart-challenge")
	if err := userStore.CreateNativeChallenge(ctx, digest, nativeChallengeS4Domain, now, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	consumption := nativeChallengeS4Consumption(t, digest, profile, "process-restart-device", now)
	if err := userStore.ConsumeNativeChallengeAndCreateSession(ctx, db, consumption); err != nil {
		t.Fatal(err)
	}
	checkpointNativeChallengeS4(t, db)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	runNativeChallengeS4RestoreProcess(t, dataDir, profile, digest, now.Add(time.Second), 1)
}

func TestS4NativeChallengeIssuanceSurvivesStoreReopen(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	userStore, db, profile, now := openNativeChallengeS4Account(t, dataDir, "pending-reopen")
	digest := HashNativeChallenge(nativeChallengeS4Domain, "pending-reopen-challenge")
	if err := userStore.CreateNativeChallenge(ctx, digest, nativeChallengeS4Domain, now, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	reopenedStore, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	reopened, err := reopenedStore.OpenExistingUser(ctx, profile.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	consumption := nativeChallengeS4Consumption(t, digest, profile, "pending-reopen-device", now.Add(time.Second))
	if err := reopenedStore.ConsumeNativeChallengeAndCreateSession(ctx, reopened, consumption); err != nil {
		t.Fatalf("consume after store reopen: %v", err)
	}
	assertNativeChallengeS4AccountCounts(t, reopened, 1)
}

func TestS4NativeChallengeConsumptionSurvivesAccountDeletion(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	userStore, db, profile, now := openNativeChallengeS4Account(t, dataDir, "deleted-account")
	digest := HashNativeChallenge(nativeChallengeS4Domain, "deleted-account-challenge")
	if err := userStore.CreateNativeChallenge(ctx, digest, nativeChallengeS4Domain, now, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	consumption := nativeChallengeS4Consumption(t, digest, profile, "deleted-account-device", now)
	if err := userStore.ConsumeNativeChallengeAndCreateSession(ctx, db, consumption); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if err := userStore.DeleteUser(ctx, profile.ID); err != nil {
		t.Fatal(err)
	}
	recreated, err := userStore.OpenUser(ctx, profile.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer recreated.Close()
	if err := userStore.ConsumeNativeChallengeAndCreateSession(ctx, recreated, consumption); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("replay after account deletion = %v, want unauthorized", err)
	}
	assertNativeChallengeS4Count(t, recreated, "profile", 0)
	assertNativeChallengeS4Count(t, recreated, "auth_sessions", 0)
	assertNativeChallengeS4Count(t, recreated, "auth_tokens", 0)
	assertNativeChallengeS4Count(t, recreated, "sqlite_master WHERE name = 'native_challenge_consumptions'", 0)
}

func TestS4NativeChallengeCrashBoundaryIsAtomicAfterReopen(t *testing.T) {
	for _, phase := range []string{"before-commit", "after-commit"} {
		t.Run(phase, func(t *testing.T) {
			testNativeChallengeS4CrashBoundary(t, phase)
		})
	}
}

func TestS4NativeChallengeStaleBackupFailsClosedAfterRestart(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	userStore, db, profile, now := openNativeChallengeS4Account(t, dataDir, "stale-restore")
	digest := HashNativeChallenge(nativeChallengeS4Domain, "stale-restore-challenge")
	if err := userStore.CreateNativeChallenge(ctx, digest, nativeChallengeS4Domain, now, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	checkpointNativeChallengeS4(t, db)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	checkpointNativeChallengeS4Registry(t, userStore)
	accountPath, _ := userStore.userPath(profile.ID)
	accountBackup := copyNativeChallengeS4File(t, accountPath)
	registryPath := userStore.nativeChallengeDatabasePath()
	registryBackup := copyNativeChallengeS4File(t, registryPath)
	db, err := userStore.OpenExistingUser(ctx, profile.ID)
	if err != nil {
		t.Fatal(err)
	}
	consumption := nativeChallengeS4Consumption(t, digest, profile, "stale-device", now.Add(time.Second))
	if err := userStore.ConsumeNativeChallengeAndCreateSession(ctx, db, consumption); err != nil {
		t.Fatal(err)
	}
	checkpointNativeChallengeS4(t, db)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	restoreNativeChallengeS4Database(t, accountPath, accountBackup)
	restoreNativeChallengeS4Database(t, registryPath, registryBackup)
	assertNativeChallengeS4HotRestoreRejected(t, userStore, profile, digest, now.Add(2*time.Second))
	runNativeChallengeS4RestoreProcess(t, dataDir, profile, digest, now.Add(2*time.Second), 0)
}

func TestS4NativeChallengeLegacyConsumptionSchemaIsInvalidated(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	userStore, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	createNativeChallengeS4LegacyRegistry(t, userStore.nativeChallengeDatabasePath())
	db, err := userStore.openNativeChallengeDatabase(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var version, rows, legacyColumn int
	if err := db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM native_auth_challenges`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM pragma_table_info('native_auth_challenges') WHERE name = 'consumed_at_ms'`).Scan(&legacyColumn); err != nil {
		t.Fatal(err)
	}
	if version != nativeChallengeSchemaVersion || rows != 0 || legacyColumn != 0 {
		t.Fatalf("migration version=%d rows=%d legacyColumn=%d", version, rows, legacyColumn)
	}
}

func TestS4NativeChallengeCrashHelper(t *testing.T) {
	dataDir := os.Getenv("POMODOROUGH_S4_CRASH_DATA_DIR")
	if dataDir == "" {
		t.Skip("subprocess helper")
	}
	userID := os.Getenv("POMODOROUGH_S4_CRASH_USER_ID")
	digestBytes, err := hex.DecodeString(os.Getenv("POMODOROUGH_S4_CRASH_DIGEST"))
	if err != nil || len(digestBytes) != 32 {
		t.Fatalf("decode challenge digest: %v", err)
	}
	var digest [32]byte
	copy(digest[:], digestBytes)
	phase := os.Getenv("POMODOROUGH_S4_CRASH_PHASE")
	runNativeChallengeS4CrashTransaction(t, dataDir, userID, digest, phase)
	os.Exit(0)
}

func TestS4NativeChallengeRestoreHelper(t *testing.T) {
	dataDir := os.Getenv("POMODOROUGH_S4_RESTORE_DATA_DIR")
	if dataDir == "" {
		t.Skip("subprocess helper")
	}
	runNativeChallengeS4RestoredExchange(t, dataDir)
	os.Exit(0)
}

type nativeChallengeS4Attempt struct {
	db          *sql.DB
	consumption NativeChallengeConsumption
}

func testNativeChallengeS4CrashBoundary(t *testing.T, phase string) {
	t.Helper()
	ctx := context.Background()
	dataDir := t.TempDir()
	userStore, db, profile, now := openNativeChallengeS4Account(t, dataDir, "crash-"+phase)
	digest := HashNativeChallenge(nativeChallengeS4Domain, "challenge-"+phase)
	if err := userStore.CreateNativeChallenge(ctx, digest, nativeChallengeS4Domain, now, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	runNativeChallengeS4CrashProcess(t, dataDir, profile.ID, digest, phase)
	reopened, err := userStore.OpenExistingUser(ctx, profile.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	retry := nativeChallengeS4Consumption(t, digest, profile, "retry-"+phase, now.Add(time.Second))
	err = userStore.ConsumeNativeChallengeAndCreateSession(ctx, reopened, retry)
	if phase == "before-commit" && err != nil {
		t.Fatalf("retry after pre-commit crash: %v", err)
	}
	if phase == "after-commit" && !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("retry after committed crash = %v, want unauthorized", err)
	}
	assertNativeChallengeS4AccountCounts(t, reopened, 1)
}

func runNativeChallengeS4CrashProcess(t *testing.T, dataDir, userID string, digest [32]byte, phase string) {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestS4NativeChallengeCrashHelper$")
	command.Env = append(os.Environ(),
		"POMODOROUGH_S4_CRASH_DATA_DIR="+dataDir,
		"POMODOROUGH_S4_CRASH_USER_ID="+userID,
		"POMODOROUGH_S4_CRASH_DIGEST="+hex.EncodeToString(digest[:]),
		"POMODOROUGH_S4_CRASH_PHASE="+phase,
	)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("crash subprocess: %v\n%s", err, output)
	}
}

func runNativeChallengeS4CrashTransaction(t *testing.T, dataDir, userID string, digest [32]byte, phase string) {
	t.Helper()
	ctx := context.Background()
	userStore, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := userStore.OpenExistingUser(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 1, 12, 0, 1, 0, time.UTC)
	profile := nativeChallengeS4Profile(userID, "process-crash")
	consumption := nativeChallengeS4Consumption(t, digest, profile, "process-crash", now)
	issuance := nativeChallengeIssuance{now.Add(-time.Second), now.Add(time.Minute)}
	if err := writeNativeChallengeAccount(ctx, tx, consumption, issuance); err != nil {
		t.Fatal(err)
	}
	if phase == "after-commit" {
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
	} else if phase != "before-commit" {
		t.Fatalf("unknown crash phase %q", phase)
	}
}

func runNativeChallengeS4RestoreProcess(t *testing.T, dataDir string, profile Profile, digest [32]byte, now time.Time, expectedSessions int) {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestS4NativeChallengeRestoreHelper$")
	command.Env = append(os.Environ(),
		"POMODOROUGH_S4_RESTORE_DATA_DIR="+dataDir,
		"POMODOROUGH_S4_RESTORE_USER_ID="+profile.ID,
		"POMODOROUGH_S4_RESTORE_SUBJECT="+profile.Subject,
		"POMODOROUGH_S4_RESTORE_DIGEST="+hex.EncodeToString(digest[:]),
		"POMODOROUGH_S4_RESTORE_NOW="+strconv.FormatInt(now.UnixMilli(), 10),
		"POMODOROUGH_S4_RESTORE_EXPECTED_SESSIONS="+strconv.Itoa(expectedSessions),
	)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("restored subprocess: %v\n%s", err, output)
	}
}

func assertNativeChallengeS4HotRestoreRejected(t *testing.T, userStore *Store, profile Profile, digest [32]byte, now time.Time) {
	t.Helper()
	db, err := userStore.OpenExistingUser(context.Background(), profile.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	consumption := nativeChallengeS4Consumption(t, digest, profile, "hot-restored-device", now)
	if err := userStore.ConsumeNativeChallengeAndCreateSession(context.Background(), db, consumption); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("hot-restored challenge error = %v, want unauthorized", err)
	}
	assertNativeChallengeS4Count(t, db, "auth_sessions", 0)
}

func runNativeChallengeS4RestoredExchange(t *testing.T, dataDir string) {
	t.Helper()
	ctx := context.Background()
	userStore, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	userID := os.Getenv("POMODOROUGH_S4_RESTORE_USER_ID")
	db, err := userStore.OpenExistingUser(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	digest := decodeNativeChallengeS4Digest(t, os.Getenv("POMODOROUGH_S4_RESTORE_DIGEST"))
	nowMS, err := strconv.ParseInt(os.Getenv("POMODOROUGH_S4_RESTORE_NOW"), 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	profile := nativeChallengeS4Profile(userID, os.Getenv("POMODOROUGH_S4_RESTORE_SUBJECT"))
	consumption := nativeChallengeS4Consumption(t, digest, profile, "restored-device", time.UnixMilli(nowMS))
	if err := userStore.ConsumeNativeChallengeAndCreateSession(ctx, db, consumption); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("restored challenge error = %v, want unauthorized", err)
	}
	expectedSessions, err := strconv.Atoi(os.Getenv("POMODOROUGH_S4_RESTORE_EXPECTED_SESSIONS"))
	if err != nil {
		t.Fatal(err)
	}
	assertNativeChallengeS4Count(t, db, "auth_sessions", expectedSessions)
}

func openNativeChallengeS4Account(t *testing.T, dataDir, subject string) (*Store, *sql.DB, Profile, time.Time) {
	t.Helper()
	userStore, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	db, profile := openNativeChallengeS4User(t, userStore, subject)
	return userStore, db, profile, time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
}

func openNativeChallengeS4User(t *testing.T, userStore *Store, subject string) (*sql.DB, Profile) {
	t.Helper()
	userID := authn.UserID([]byte(strings.Repeat("s", 32)), "https://accounts.google.com", subject)
	db, err := userStore.OpenUser(context.Background(), userID)
	if err != nil {
		t.Fatal(err)
	}
	return db, nativeChallengeS4Profile(userID, subject)
}

func nativeChallengeS4Profile(userID, subject string) Profile {
	return Profile{
		ID: userID, Issuer: "https://accounts.google.com", Subject: subject,
		Email: subject + "@example.com", Name: subject, AvatarURL: "https://example.com/avatar.png",
	}
}

func nativeChallengeS4Consumption(t *testing.T, digest [32]byte, profile Profile, deviceID string, now time.Time) NativeChallengeConsumption {
	t.Helper()
	return NativeChallengeConsumption{
		Digest: digest, Domain: nativeChallengeS4Domain, Now: now, Profile: profile,
		Session: Session{ID: deviceID + "-session", Kind: "native", DeviceID: deviceID, Platform: "ios", CreatedAt: now, ExpiresAt: now.Add(time.Hour)},
		Tokens: []TokenRecord{
			{Hash: testTokenHash(t, profile.ID), Kind: "access", CreatedAt: now, ExpiresAt: now.Add(time.Minute)},
			{Hash: testTokenHash(t, profile.ID), Kind: "refresh", CreatedAt: now, ExpiresAt: now.Add(time.Hour)},
		},
	}
}

func assertNativeChallengeS4Unauthorized(t *testing.T, userStore *Store, db *sql.DB, consumption NativeChallengeConsumption) {
	t.Helper()
	err := userStore.ConsumeNativeChallengeAndCreateSession(context.Background(), db, consumption)
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("error = %v, want unauthorized", err)
	}
}

func assertNativeChallengeS4Count(t *testing.T, db *sql.DB, table string, want int) {
	t.Helper()
	var got int
	if err := db.QueryRowContext(context.Background(), "SELECT count(*) FROM "+table).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("%s count = %d, want %d", table, got, want)
	}
}

func assertNativeChallengeS4AccountCounts(t *testing.T, db *sql.DB, want int) {
	t.Helper()
	assertNativeChallengeS4Count(t, db, "profile", want)
	assertNativeChallengeS4Count(t, db, "auth_sessions", want)
	assertNativeChallengeS4Count(t, db, "auth_tokens", want*2)
	assertNativeChallengeS4Count(t, db, "native_challenge_consumptions", want)
}

func forgetNativeChallengeS4Spent(userStore *Store, digest [32]byte) {
	key := nativeChallengeSpentKey{userStore.nativeChallengeDatabasePath(), digest}
	nativeChallengeSpent.Lock()
	defer nativeChallengeSpent.Unlock()
	delete(nativeChallengeSpent.expiresAt, key)
}

func decodeNativeChallengeS4Digest(t *testing.T, encoded string) [32]byte {
	t.Helper()
	decoded, err := hex.DecodeString(encoded)
	if err != nil || len(decoded) != 32 {
		t.Fatalf("decode challenge digest: %v", err)
	}
	var digest [32]byte
	copy(digest[:], decoded)
	return digest
}

func checkpointNativeChallengeS4(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.ExecContext(context.Background(), `PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		t.Fatal(err)
	}
}

func checkpointNativeChallengeS4Registry(t *testing.T, userStore *Store) {
	t.Helper()
	db, err := userStore.openNativeChallengeDatabase(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	checkpointNativeChallengeS4(t, db)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
}

func copyNativeChallengeS4File(t *testing.T, path string) []byte {
	t.Helper()
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return contents
}

func restoreNativeChallengeS4Database(t *testing.T, path string, contents []byte) {
	t.Helper()
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if err := os.Remove(path + suffix); err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}
}

func createNativeChallengeS4LegacyRegistry(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+nativeChallengeDatabasePragmas)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	legacy := `CREATE TABLE native_auth_challenges (
		digest BLOB PRIMARY KEY CHECK (length(digest) = 32), domain TEXT NOT NULL,
		issued_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, consumed_at_ms INTEGER
	) STRICT`
	if _, err := db.Exec(legacy); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO native_auth_challenges VALUES (zeroblob(32), 'legacy', 1, 2, NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`PRAGMA user_version = 1`); err != nil {
		t.Fatal(err)
	}
}

func runNativeChallengeS4Attempts(userStore *Store, attempts []nativeChallengeS4Attempt) []error {
	start := make(chan struct{})
	results := make(chan error, len(attempts))
	for _, attempt := range attempts {
		go func(entry nativeChallengeS4Attempt) {
			<-start
			results <- userStore.ConsumeNativeChallengeAndCreateSession(context.Background(), entry.db, entry.consumption)
		}(attempt)
	}
	close(start)
	errors := make([]error, 0, len(attempts))
	for range attempts {
		errors = append(errors, <-results)
	}
	return errors
}

func assertNativeChallengeS4ConcurrentResults(t *testing.T, results []error) {
	t.Helper()
	var succeeded, rejected int
	for _, err := range results {
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrUnauthorized):
			rejected++
		default:
			t.Fatalf("concurrent exchange error = %v", err)
		}
	}
	if succeeded != 1 || rejected != 1 {
		t.Fatalf("concurrent results: succeeded=%d rejected=%d", succeeded, rejected)
	}
}

func assertNativeChallengeS4TotalSessions(t *testing.T, first, second *sql.DB, want int) {
	t.Helper()
	total := 0
	for _, db := range []*sql.DB{first, second} {
		var count int
		if err := db.QueryRowContext(context.Background(), `SELECT count(*) FROM auth_sessions`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		total += count
	}
	if total != want {
		t.Fatalf("session total = %d, want %d", total, want)
	}
}
