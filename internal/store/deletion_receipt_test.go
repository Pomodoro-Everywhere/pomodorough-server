package store

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDeletionReceiptIsPrivateAndPreservesVersionOneTombstone(t *testing.T) {
	userStore, credential := deletionReceiptFixture(t)
	if err := userStore.DeleteUserWithReceipt(context.Background(), deletionLedgerTestUserID, 1, credential, nil); err != nil {
		t.Fatal(err)
	}
	path, err := userStore.deletionReceiptPath(deletionLedgerTestUserID, credential)
	if err != nil {
		t.Fatal(err)
	}
	receiptBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("unsafe receipt permissions: %v %v", info, err)
	}
	if strings.Contains(string(receiptBytes), deletionLedgerTestUserID) || strings.Contains(path, deletionLedgerTestUserID) {
		t.Fatal("receipt exposes user identifier")
	}
	ledgerPath, _ := userStore.ledgerPath(deletionLedgerTestUserID)
	file, err := os.Open(ledgerPath)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	var record deletionRecord
	if err := decoder.Decode(&record); err != nil || record.Version != 1 || record.DeletedGeneration != 1 {
		t.Fatalf("legacy tombstone changed: %+v %v", record, err)
	}
}

func TestPreparedDeletionReceiptDoesNotConfirmFailedTombstonePersistence(t *testing.T) {
	userStore, credential := deletionReceiptFixture(t)
	prepared := DeletionReceipt{Version: 1, Generation: 1}
	if err := userStore.writeDeletionReceipt(deletionLedgerTestUserID, credential, prepared); err != nil {
		t.Fatal(err)
	}
	ledgerPath, _ := userStore.ledgerPath(deletionLedgerTestUserID)
	if err := os.Mkdir(ledgerPath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := userStore.recordDeletion(deletionLedgerTestUserID, 1, time.Now()); err == nil {
		t.Fatal("unsafe tombstone unexpectedly persisted")
	}
	if receipt, err := userStore.CommittedDeletionReceipt(deletionLedgerTestUserID, credential); err == nil || receipt.Generation != 0 {
		t.Fatalf("failed tombstone confirmed: %+v %v", receipt, err)
	}
	if err := os.Remove(ledgerPath); err != nil {
		t.Fatal(err)
	}
	restarted, err := NewWithDeletionLedger(filepath.Dir(userStore.usersDir), userStore.deletionLedgerDir)
	if err != nil {
		t.Fatal(err)
	}
	if receipt, err := restarted.CommittedDeletionReceipt(deletionLedgerTestUserID, credential); err != nil || receipt.Generation != 0 {
		t.Fatalf("prepared receipt authorized after restart: %+v %v", receipt, err)
	}
	if err := restarted.ValidateAccountGeneration(context.Background(), deletionLedgerTestUserID, 1); err != nil {
		t.Fatalf("failed deletion purged live generation: %v", err)
	}
}

func TestDeletionReceiptRejectsMalformedRecordsAndUnsafeMetadata(t *testing.T) {
	for _, contents := range []string{
		`{}`, `{"version":2,"generation":1}`, `{"version":1,"generation":0}`,
		`{"version":1,"generation":9007199254740992}`, `{"version":1,"generation":1} {}`,
		`{"version":1,"generation":1,"unknown":true}`, `{"version":1,"generation":1,"csrfHash":"YQ=="}`,
	} {
		t.Run(contents, func(t *testing.T) {
			userStore, credential := deletionReceiptFixture(t)
			path, _ := userStore.deletionReceiptPath(deletionLedgerTestUserID, credential)
			if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := userStore.CommittedDeletionReceipt(deletionLedgerTestUserID, credential); err == nil {
				t.Fatal("invalid receipt accepted")
			}
		})
	}
	for _, metadata := range []string{"permissions", "symlink", "oversized"} {
		t.Run(metadata, func(t *testing.T) {
			userStore, credential := deletionReceiptFixture(t)
			path, _ := userStore.deletionReceiptPath(deletionLedgerTestUserID, credential)
			contents, mode := `{"version":1,"generation":1}`, os.FileMode(0o600)
			if metadata == "permissions" {
				mode = 0o644
			}
			if metadata == "oversized" {
				contents += strings.Repeat(" ", 4097)
			}
			if err := os.WriteFile(path, []byte(contents), mode); err != nil {
				t.Fatal(err)
			}
			if metadata == "symlink" {
				if err := os.Rename(path, path+".target"); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(path+".target", path); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := userStore.CommittedDeletionReceipt(deletionLedgerTestUserID, credential); err == nil {
				t.Fatal("unsafe receipt accepted")
			}
		})
	}
}

func TestDeletionReceiptPurgeChecksGenerationAndDurableObligation(t *testing.T) {
	userStore, credential := deletionReceiptFixture(t)
	ctx := context.Background()
	path, _ := userStore.userPath(deletionLedgerTestUserID)
	backup, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := userStore.DeleteUserWithReceipt(ctx, deletionLedgerTestUserID, 1, credential, nil); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, backup, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := userStore.DeleteUserWithReceipt(ctx, deletionLedgerTestUserID, 1, credential, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("restored generation not purged: %v", err)
	}
	db, err := userStore.OpenUser(ctx, deletionLedgerTestUserID)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if err := userStore.DeleteUserWithReceipt(ctx, deletionLedgerTestUserID, 2, credential, nil); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("receipt used for new generation: %v", err)
	}
	if err := userStore.DeleteUserWithReceipt(ctx, deletionLedgerTestUserID, 1, credential, nil); err != nil {
		t.Fatal(err)
	}
	if err := userStore.ValidateAccountGeneration(ctx, deletionLedgerTestUserID, 2); err != nil {
		t.Fatal(err)
	}
}

func TestDeletionReceiptIsNotCreatedForStaleGeneration(t *testing.T) {
	userStore, credential := deletionReceiptFixture(t)
	if err := userStore.DeleteUserWithReceipt(context.Background(), deletionLedgerTestUserID, 2, credential, nil); !errors.Is(err, ErrAccountGenerationChanged) {
		t.Fatalf("stale generation error: %v", err)
	}
	path, _ := userStore.deletionReceiptPath(deletionLedgerTestUserID, credential)
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale generation wrote receipt: %v", err)
	}
}

func TestOldDeletionReceiptSurvivesLaterGenerationDeletion(t *testing.T) {
	userStore, first := deletionReceiptFixture(t)
	ctx := context.Background()
	second := DeletionCredential{TokenHash: sha256.Sum256([]byte("second-credential")), Method: "bearer"}
	for index, credential := range []DeletionCredential{first, second} {
		if err := userStore.DeleteUserWithReceipt(ctx, deletionLedgerTestUserID, int64(index+1), credential, nil); err != nil {
			t.Fatal(err)
		}
		db, err := userStore.OpenUser(ctx, deletionLedgerTestUserID)
		if err != nil {
			t.Fatal(err)
		}
		if err := db.Close(); err != nil {
			t.Fatal(err)
		}
	}
	receipt, err := userStore.CommittedDeletionReceipt(deletionLedgerTestUserID, first)
	if err != nil || receipt.Generation != 1 {
		t.Fatalf("original receipt changed: %+v %v", receipt, err)
	}
	if err := userStore.DeleteUserWithReceipt(ctx, deletionLedgerTestUserID, 1, first, nil); err != nil {
		t.Fatal(err)
	}
	if err := userStore.ValidateAccountGeneration(ctx, deletionLedgerTestUserID, 3); err != nil {
		t.Fatalf("old receipt deleted third generation: %v", err)
	}
}

func deletionReceiptFixture(t *testing.T) (*Store, DeletionCredential) {
	t.Helper()
	userStore, err := NewWithDeletionLedger(t.TempDir(), t.TempDir())
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
	return userStore, DeletionCredential{TokenHash: sha256.Sum256([]byte("original-credential")), Method: "bearer"}
}
