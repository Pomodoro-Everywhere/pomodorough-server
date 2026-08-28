package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const deletionLedgerTestUserID = "0123456789abcdef0123456789abcdef"

func TestDeletionLedgerRejectsRestoredGenerationsAndAllowsFreshRecreation(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	ledgerDir := filepath.Join(root, "deletion-ledger")
	userStore, err := NewWithDeletionLedger(dataDir, ledgerDir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := userStore.OpenUser(ctx, deletionLedgerTestUserID)
	if err != nil {
		t.Fatal(err)
	}
	if generation, err := accountGeneration(ctx, db); err != nil || generation != 1 {
		t.Fatalf("initial generation = %d, %v; want 1", generation, err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO profile(singleton, user_id, issuer, subject, email, email_verified, name, avatar_url, updated_at_ms)
		VALUES (1, ?, 'issuer', 'subject', 'person@example.com', 1, 'Deleted Person', '', 1)`, deletionLedgerTestUserID); err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	userPath := filepath.Join(dataDir, "users", deletionLedgerTestUserID+".sqlite")
	generationOneBackup, err := os.ReadFile(userPath)
	if err != nil {
		t.Fatal(err)
	}

	if err := userStore.DeleteUserForGeneration(ctx, deletionLedgerTestUserID, 1); err != nil {
		t.Fatal(err)
	}
	ledgerPath, err := userStore.ledgerPath(deletionLedgerTestUserID)
	if err != nil {
		t.Fatal(err)
	}
	ledgerBytes, err := os.ReadFile(ledgerPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(ledgerBytes), deletionLedgerTestUserID) || strings.Contains(filepath.Base(ledgerPath), deletionLedgerTestUserID) {
		t.Fatal("deletion ledger exposed raw account identifier")
	}
	if info, err := os.Stat(ledgerPath); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("deletion record permissions = %v, %v; want 0600", info, err)
	}

	restoreDatabase(t, userPath, generationOneBackup)
	if _, err := userStore.OpenExistingUser(ctx, deletionLedgerTestUserID); !errors.Is(err, ErrAccountDeleted) {
		t.Fatalf("restored deleted generation open error = %v, want ErrAccountDeleted", err)
	}
	if _, err := os.Stat(userPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("rejected restored database stat error = %v, want absence", err)
	}

	db, err = userStore.OpenUser(ctx, deletionLedgerTestUserID)
	if err != nil {
		t.Fatal(err)
	}
	if generation, err := accountGeneration(ctx, db); err != nil || generation != 2 {
		db.Close()
		t.Fatalf("recreated generation = %d, %v; want 2", generation, err)
	}
	var profiles int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM profile`).Scan(&profiles); err != nil || profiles != 0 {
		db.Close()
		t.Fatalf("recreated profile count = %d, %v; want 0", profiles, err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	generationTwoBackup, err := os.ReadFile(userPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := userStore.DeleteUserForGeneration(ctx, deletionLedgerTestUserID, 2); err != nil {
		t.Fatal(err)
	}

	for name, backup := range map[string][]byte{
		"older generation":          generationOneBackup,
		"latest deleted generation": generationTwoBackup,
	} {
		t.Run(name, func(t *testing.T) {
			restoreDatabase(t, userPath, backup)
			restarted, err := NewWithDeletionLedger(dataDir, ledgerDir)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := restarted.OpenExistingUser(ctx, deletionLedgerTestUserID); !errors.Is(err, ErrNotFound) {
				t.Fatalf("startup-scrubbed generation open error = %v, want ErrNotFound", err)
			}
		})
	}
}

func TestDeletionLedgerFailurePreservesLiveAccount(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	ledgerDir := filepath.Join(root, "deletion-ledger")
	userStore, err := NewWithDeletionLedger(dataDir, ledgerDir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := userStore.OpenUser(ctx, deletionLedgerTestUserID)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(ledgerDir, ledgerDir+"-moved"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ledgerDir, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := userStore.DeleteUserForGeneration(ctx, deletionLedgerTestUserID, 1); err == nil {
		t.Fatal("DeleteUserForGeneration succeeded without durable deletion ledger")
	}
	userPath := filepath.Join(dataDir, "users", deletionLedgerTestUserID+".sqlite")
	if _, err := os.Stat(userPath); err != nil {
		t.Fatalf("failed ledger write removed live account: %v", err)
	}
}

func TestDeletionLedgerFailsClosedOnCorruptOrUnsafeRecord(t *testing.T) {
	for name, record := range map[string]struct {
		contents string
		mode     os.FileMode
	}{
		"corrupt": {contents: `{}`, mode: 0o600},
		"multiple JSON values": {
			contents: `{"version":1,"deletedGeneration":1,"deletedAtMs":1} {}`,
			mode:     0o600,
		},
		"malformed trailing value": {
			contents: `{"version":1,"deletedGeneration":1,"deletedAtMs":1} {`,
			mode:     0o600,
		},
		"unknown field": {
			contents: `{"version":1,"deletedGeneration":1,"deletedAtMs":1,"account":"leak"}`,
			mode:     0o600,
		},
		"oversized": {contents: strings.Repeat(" ", 4097), mode: 0o600},
		"unsafe permissions": {
			contents: `{"version":1,"deletedGeneration":1,"deletedAtMs":1}`,
			mode:     0o644,
		},
	} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			dataDir := filepath.Join(root, "data")
			ledgerDir := filepath.Join(root, "deletion-ledger")
			userStore, err := NewWithDeletionLedger(dataDir, ledgerDir)
			if err != nil {
				t.Fatal(err)
			}
			db, err := userStore.OpenUser(context.Background(), deletionLedgerTestUserID)
			if err != nil {
				t.Fatal(err)
			}
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			ledgerPath, err := userStore.ledgerPath(deletionLedgerTestUserID)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(ledgerPath, []byte(record.contents), record.mode); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(ledgerPath, record.mode); err != nil {
				t.Fatal(err)
			}
			if _, err := NewWithDeletionLedger(dataDir, ledgerDir); err == nil {
				t.Fatal("store startup accepted unsafe deletion record")
			}
		})
	}
}

func TestDeletionLedgerRejectsSymbolicLinks(t *testing.T) {
	t.Run("ledger directory", func(t *testing.T) {
		root := t.TempDir()
		actualLedger := filepath.Join(root, "actual-ledger")
		if err := os.Mkdir(actualLedger, 0o700); err != nil {
			t.Fatal(err)
		}
		linkedLedger := filepath.Join(root, "linked-ledger")
		if err := os.Symlink(actualLedger, linkedLedger); err != nil {
			t.Fatal(err)
		}
		if _, err := NewWithDeletionLedger(filepath.Join(root, "data"), linkedLedger); err == nil {
			t.Fatal("store accepted a symbolic-link deletion ledger directory")
		}
	})

	t.Run("deletion record", func(t *testing.T) {
		root := t.TempDir()
		dataDir := filepath.Join(root, "data")
		ledgerDir := filepath.Join(root, "deletion-ledger")
		userStore, err := NewWithDeletionLedger(dataDir, ledgerDir)
		if err != nil {
			t.Fatal(err)
		}
		db, err := userStore.OpenUser(context.Background(), deletionLedgerTestUserID)
		if err != nil {
			t.Fatal(err)
		}
		if err := db.Close(); err != nil {
			t.Fatal(err)
		}
		ledgerPath, err := userStore.ledgerPath(deletionLedgerTestUserID)
		if err != nil {
			t.Fatal(err)
		}
		target := filepath.Join(root, "record.json")
		contents := `{"version":1,"deletedGeneration":1,"deletedAtMs":1}`
		if err := os.WriteFile(target, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, ledgerPath); err != nil {
			t.Fatal(err)
		}
		if _, err := NewWithDeletionLedger(dataDir, ledgerDir); err == nil {
			t.Fatal("store accepted a symbolic-link deletion record")
		}
	})
}

func TestDeletionLedgerMustBeOutsideAccountBackupDirectory(t *testing.T) {
	dataDir := t.TempDir()
	for _, ledgerDir := range []string{dataDir, filepath.Join(dataDir, "deletions")} {
		if _, err := NewWithDeletionLedger(dataDir, ledgerDir); err == nil {
			t.Fatalf("NewWithDeletionLedger accepted ledger inside DATA_DIR: %q", ledgerDir)
		}
	}
}

func restoreDatabase(t *testing.T, path string, contents []byte) {
	t.Helper()
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		if err := os.WriteFile(path+suffix, []byte("stale sidecar"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}
