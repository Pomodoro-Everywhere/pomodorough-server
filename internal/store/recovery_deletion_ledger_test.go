package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const recoveryDeletionUserID = "abcdef0123456789abcdef0123456789"

type recoveryDeletionFixture struct {
	generationTwo []byte
	staleLedger   map[string][]byte
	currentLedger map[string][]byte
}

func TestRecoveryRejectsEmptyAndStaleDeletionLedgers(t *testing.T) {
	fixture := buildRecoveryDeletionFixture(t)
	for name, ledger := range map[string]map[string][]byte{
		"empty": {},
		"stale": fixture.staleLedger,
	} {
		t.Run(name, func(t *testing.T) {
			dataDir, ledgerDir := restoreRecoveryState(t, fixture.generationTwo, ledger)
			if _, err := NewWithDeletionLedger(dataDir, ledgerDir); err == nil || !strings.Contains(err.Error(), "lifecycle") {
				t.Fatalf("startup error = %v, want lifecycle binding failure", err)
			}
		})
	}
}

func TestRecoveryWithCurrentLedgerScrubsDeletedDatabase(t *testing.T) {
	fixture := buildRecoveryDeletionFixture(t)
	dataDir, ledgerDir := restoreRecoveryState(t, fixture.generationTwo, fixture.currentLedger)
	recovered, err := NewWithDeletionLedger(dataDir, ledgerDir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := recovered.OpenExistingUser(context.Background(), recoveryDeletionUserID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted account open error = %v, want ErrNotFound", err)
	}
	assertRecoveryAccountAbsent(t, dataDir)
}

func TestRecoveryRejectsLedgerReplacementAfterStartup(t *testing.T) {
	fixture := buildRecoveryDeletionFixture(t)
	dataDir, ledgerDir := restoreRecoveryState(t, nil, fixture.currentLedger)
	recovered, err := NewWithDeletionLedger(dataDir, ledgerDir)
	if err != nil {
		t.Fatal(err)
	}
	restoreRecoveryLedger(t, ledgerDir, fixture.staleLedger)
	restoreRecoveryFile(t, recoveryAccountPath(dataDir), fixture.generationTwo)
	if _, err := recovered.OpenExistingUser(context.Background(), recoveryDeletionUserID); err == nil || !strings.Contains(err.Error(), "lifecycle") {
		t.Fatalf("open after ledger rollback error = %v, want lifecycle binding failure", err)
	}
}

func TestRecoveryHandlesSidecarOnlyAccountStorage(t *testing.T) {
	fixture := buildRecoveryDeletionFixture(t)
	t.Run("empty ledger fails", func(t *testing.T) {
		dataDir, ledgerDir := restoreRecoveryState(t, nil, nil)
		restoreRecoveryFile(t, recoveryAccountPath(dataDir)+"-wal", []byte("sidecar"))
		if _, err := NewWithDeletionLedger(dataDir, ledgerDir); err == nil {
			t.Fatal("startup accepted sidecar-only account without deletion ledger")
		}
	})
	t.Run("current ledger removes", func(t *testing.T) {
		dataDir, ledgerDir := restoreRecoveryState(t, nil, fixture.currentLedger)
		restoreRecoveryFile(t, recoveryAccountPath(dataDir)+"-wal", []byte("sidecar"))
		if _, err := NewWithDeletionLedger(dataDir, ledgerDir); err != nil {
			t.Fatal(err)
		}
		assertRecoveryAccountAbsent(t, dataDir)
	})
}

func TestRecoveryRejectsPhysicalLedgerAliasInsideDataDirectory(t *testing.T) {
	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(root, "data-alias")
	if err := os.Symlink(dataDir, alias); err != nil {
		t.Fatal(err)
	}
	if _, err := NewWithDeletionLedger(dataDir, filepath.Join(alias, "ledger")); err == nil || !strings.Contains(err.Error(), "outside DATA_DIR") {
		t.Fatalf("physical ledger alias error = %v, want outside DATA_DIR", err)
	}
}

func buildRecoveryDeletionFixture(t *testing.T) recoveryDeletionFixture {
	t.Helper()
	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	ledgerDir := filepath.Join(root, "ledger")
	userStore, err := NewWithDeletionLedger(dataDir, ledgerDir)
	if err != nil {
		t.Fatal(err)
	}
	createRecoveryAccount(t, userStore)
	if err := userStore.DeleteUserForGeneration(context.Background(), recoveryDeletionUserID, 1); err != nil {
		t.Fatal(err)
	}
	staleLedger := readRecoveryLedger(t, ledgerDir)
	createRecoveryAccount(t, userStore)
	generationTwo, err := os.ReadFile(recoveryAccountPath(dataDir))
	if err != nil {
		t.Fatal(err)
	}
	if err := userStore.DeleteUserForGeneration(context.Background(), recoveryDeletionUserID, 2); err != nil {
		t.Fatal(err)
	}
	return recoveryDeletionFixture{generationTwo: generationTwo, staleLedger: staleLedger, currentLedger: readRecoveryLedger(t, ledgerDir)}
}

func createRecoveryAccount(t *testing.T, userStore *Store) {
	t.Helper()
	db, err := userStore.OpenUser(context.Background(), recoveryDeletionUserID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO profile(singleton, user_id, issuer, subject, email, email_verified, name, avatar_url, updated_at_ms)
		VALUES (1, ?, 'issuer', 'subject', 'deleted@example.com', 1, 'Deleted', '', 1)`, recoveryDeletionUserID); err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
}

func restoreRecoveryState(t *testing.T, database []byte, ledger map[string][]byte) (string, string) {
	t.Helper()
	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	ledgerDir := filepath.Join(root, "ledger")
	if err := os.MkdirAll(filepath.Join(dataDir, "users"), 0o700); err != nil {
		t.Fatal(err)
	}
	restoreRecoveryLedger(t, ledgerDir, ledger)
	if database != nil {
		restoreRecoveryFile(t, recoveryAccountPath(dataDir), database)
	}
	return dataDir, ledgerDir
}

func restoreRecoveryLedger(t *testing.T, ledgerDir string, ledger map[string][]byte) {
	t.Helper()
	if err := os.RemoveAll(ledgerDir); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(ledgerDir, 0o700); err != nil {
		t.Fatal(err)
	}
	for name, contents := range ledger {
		restoreRecoveryFile(t, filepath.Join(ledgerDir, name), contents)
	}
}

func readRecoveryLedger(t *testing.T, ledgerDir string) map[string][]byte {
	t.Helper()
	entries, err := os.ReadDir(ledgerDir)
	if err != nil {
		t.Fatal(err)
	}
	ledger := make(map[string][]byte)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".pending-") {
			continue
		}
		ledger[entry.Name()], err = os.ReadFile(filepath.Join(ledgerDir, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
	}
	return ledger
}

func assertRecoveryAccountAbsent(t *testing.T, dataDir string) {
	t.Helper()
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if _, err := os.Stat(recoveryAccountPath(dataDir) + suffix); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("deleted account storage%s remains: %v", suffix, err)
		}
	}
}

func recoveryAccountPath(dataDir string) string {
	return filepath.Join(dataDir, "users", recoveryDeletionUserID+".sqlite")
}

func restoreRecoveryFile(t *testing.T, path string, contents []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}
}
