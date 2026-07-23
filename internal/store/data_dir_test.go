package store

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestDataDirLockExcludesConcurrentOwnerAndReleases(t *testing.T) {
	dataDir := t.TempDir()
	first, err := AcquireDataDirLock(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := AcquireDataDirLock(dataDir); !errors.Is(err, ErrDataDirInUse) {
		t.Fatalf("second lock error = %v, want ErrDataDirInUse", err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := AcquireDataDirLock(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyDataDirSchemaVersionIsReadOnly(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	usersDir := filepath.Join(dataDir, "users")
	if err := createPrivateDir(usersDir); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(usersDir, "legacy.sqlite")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `PRAGMA user_version = 4`); err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if err := VerifyDataDirSchemaVersion(ctx, dataDir); !errors.Is(err, ErrSchemaVersionMismatch) {
		t.Fatalf("schema check error = %v, want ErrSchemaVersionMismatch", err)
	}
	db, err = sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var version int
	if err := db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&version); err != nil || version != 4 {
		t.Fatalf("schema version after check = %d, %v; want 4", version, err)
	}
}

func createPrivateDir(path string) error {
	return os.MkdirAll(path, 0o700)
}
