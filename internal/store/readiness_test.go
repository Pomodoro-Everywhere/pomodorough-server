package store

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

const readinessTestUserID = "1234567890abcdef1234567890abcdef"

type storeReadinessPathState struct {
	Mode       fs.FileMode
	Size       int64
	ModifiedNS int64
	Digest     [sha256.Size]byte
}

func TestStoreReadinessValidatesHealthyDatabaseAndLifecycle(t *testing.T) {
	userStore, databasePath := newReadinessStore(t)
	before := storeReadinessSnapshot(t, userStore.usersDir, userStore.deletionLedgerDir)
	if err := userStore.Ready(context.Background()); err != nil {
		t.Fatalf("healthy readiness error = %v", err)
	}
	after := storeReadinessSnapshot(t, userStore.usersDir, userStore.deletionLedgerDir)
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("readiness changed storage:\nbefore=%#v\nafter=%#v", before, after)
	}
	if _, err := os.Stat(databasePath + "-wal"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("readiness created WAL sidecar: %v", err)
	}
	if _, err := os.Stat(databasePath + "-shm"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("readiness created shared-memory sidecar: %v", err)
	}
}

func TestStoreReadinessReadsDatabaseWithLiveWAL(t *testing.T) {
	userStore, databasePath := newReadinessStore(t)
	db, err := userStore.OpenExistingUser(context.Background(), readinessTestUserID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, suffix := range []string{"-wal", "-shm"} {
		if _, err := os.Stat(databasePath + suffix); err != nil {
			t.Fatalf("live database %s sidecar: %v", suffix, err)
		}
	}
	before := storeReadinessSnapshot(t, userStore.usersDir, userStore.deletionLedgerDir)
	if err := userStore.Ready(context.Background()); err != nil {
		t.Fatalf("live WAL readiness error = %v", err)
	}
	after := storeReadinessSnapshot(t, userStore.usersDir, userStore.deletionLedgerDir)
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("live WAL readiness changed storage:\nbefore=%#v\nafter=%#v", before, after)
	}
}

func TestS6StoreReadinessScansEveryAccountDatabase(t *testing.T) {
	userStore, _ := newReadinessStore(t)
	secondUserID := "abcdef0123456789abcdef0123456789"
	database, err := userStore.OpenUser(context.Background(), secondUserID)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(userStore.usersDir, secondUserID+".sqlite")
	if err := os.WriteFile(path, []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	assertStoreReadinessCode(t, userStore, "database_unavailable")
}

func TestS6StoreReadinessRejectsStorageDatabaseAndLedgerFailures(t *testing.T) {
	tests := map[string]struct {
		code   string
		mutate func(*testing.T, *Store, string)
	}{
		"unsafe users directory": {"storage_unavailable", func(t *testing.T, userStore *Store, _ string) {
			if err := os.Chmod(userStore.usersDir, 0o755); err != nil {
				t.Fatal(err)
			}
		}},
		"unsafe database": {"storage_unavailable", func(t *testing.T, _ *Store, path string) {
			if err := os.Chmod(path, 0o644); err != nil {
				t.Fatal(err)
			}
		}},
		"incomplete sidecars": {"database_unavailable", func(t *testing.T, _ *Store, path string) {
			if err := os.WriteFile(path+"-wal", []byte("orphan"), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
		"corrupt database": {"database_unavailable", func(t *testing.T, _ *Store, path string) {
			if err := os.WriteFile(path, []byte("corrupt"), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
		"unsafe ledger directory": {"ledger_unavailable", func(t *testing.T, userStore *Store, _ string) {
			if err := os.Chmod(userStore.deletionLedgerDir, 0o755); err != nil {
				t.Fatal(err)
			}
		}},
		"corrupt deletion record":  {"lifecycle_invalid", corruptReadinessDeletionRecord},
		"corrupt deletion receipt": {"lifecycle_invalid", corruptReadinessDeletionReceipt},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			userStore, databasePath := newReadinessStore(t)
			test.mutate(t, userStore, databasePath)
			assertStoreReadinessCode(t, userStore, test.code)
		})
	}
}

func TestS6StoreReadinessRejectsSchemaWithoutMigrating(t *testing.T) {
	userStore, databasePath := newReadinessStore(t)
	database, err := userStore.OpenExistingUser(context.Background(), readinessTestUserID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(context.Background(), `PRAGMA user_version = 6`); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	before := storeReadinessSnapshot(t, userStore.usersDir, userStore.deletionLedgerDir)
	assertStoreReadinessCode(t, userStore, "database_unavailable")
	after := storeReadinessSnapshot(t, userStore.usersDir, userStore.deletionLedgerDir)
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("schema readiness migrated storage:\nbefore=%#v\nafter=%#v", before, after)
	}
	if _, err := os.Stat(databasePath + "-wal"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("schema readiness created WAL: %v", err)
	}
}

func TestS6StoreReadinessSupportsConcurrentChecksOnOpenDatabase(t *testing.T) {
	userStore, _ := newReadinessStore(t)
	database, err := userStore.OpenExistingUser(context.Background(), readinessTestUserID)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	before := storeReadinessSnapshot(t, userStore.usersDir, userStore.deletionLedgerDir)
	const checkCount = 8
	failures := make(chan error, checkCount)
	var checks sync.WaitGroup
	for range checkCount {
		checks.Add(1)
		go func() {
			defer checks.Done()
			if err := userStore.Ready(context.Background()); err != nil {
				failures <- err
			}
		}()
	}
	checks.Wait()
	close(failures)
	for err := range failures {
		t.Fatalf("concurrent readiness error = %v", err)
	}
	after := storeReadinessSnapshot(t, userStore.usersDir, userStore.deletionLedgerDir)
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("concurrent readiness changed storage:\nbefore=%#v\nafter=%#v", before, after)
	}
}

func TestReadinessDatabaseRejectsClosedHandle(t *testing.T) {
	_, databasePath := newReadinessStore(t)
	db, err := openReadinessDatabase(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := validateReadinessDatabase(context.Background(), db); err == nil {
		t.Fatal("closed database passed readiness")
	}
}

func TestReadinessInventoryIsBounded(t *testing.T) {
	directory := t.TempDir()
	for index := 0; index <= readinessInventoryLimit; index++ {
		path := filepath.Join(directory, fmt.Sprintf("entry-%04d", index))
		if err := os.WriteFile(path, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := readinessEntries(context.Background(), directory); err == nil || !strings.Contains(err.Error(), "bounded limit") {
		t.Fatalf("oversized inventory error = %v", err)
	}
}

func TestStoreReadinessHonorsCanceledContext(t *testing.T) {
	userStore, _ := newReadinessStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := userStore.Ready(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled readiness error = %v", err)
	}
}

func corruptReadinessDeletionRecord(t *testing.T, userStore *Store, _ string) {
	t.Helper()
	path := filepath.Join(userStore.deletionLedgerDir, strings.Repeat("0", 64)+".json")
	if err := os.WriteFile(path, []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func corruptReadinessDeletionReceipt(t *testing.T, userStore *Store, _ string) {
	t.Helper()
	path := filepath.Join(userStore.deletionLedgerDir, "receipt-"+strings.Repeat("0", 64)+".json")
	if err := os.WriteFile(path, []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func assertStoreReadinessCode(t *testing.T, userStore *Store, code string) {
	t.Helper()
	err := userStore.Ready(context.Background())
	if err == nil || ReadinessErrorCode(err) != code {
		t.Fatalf("readiness error = %v code=%q, want %q", err, ReadinessErrorCode(err), code)
	}
}

func newReadinessStore(t *testing.T) (*Store, string) {
	t.Helper()
	root := t.TempDir()
	userStore, err := NewWithDeletionLedger(filepath.Join(root, "data"), filepath.Join(root, "ledger"))
	if err != nil {
		t.Fatal(err)
	}
	db, err := userStore.OpenUser(context.Background(), readinessTestUserID)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	return userStore, filepath.Join(userStore.usersDir, readinessTestUserID+".sqlite")
}

func storeReadinessSnapshot(t *testing.T, roots ...string) map[string]storeReadinessPathState {
	t.Helper()
	result := make(map[string]storeReadinessPathState)
	for rootIndex, root := range roots {
		err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			digest := [sha256.Size]byte{}
			if info.Mode().IsRegular() {
				contents, err := os.ReadFile(path)
				if err != nil {
					return err
				}
				digest = sha256.Sum256(contents)
			}
			relative, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			key := fmt.Sprintf("%d:%s", rootIndex, relative)
			result[key] = storeReadinessPathState{info.Mode(), info.Size(), info.ModTime().UnixNano(), digest}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	return result
}
