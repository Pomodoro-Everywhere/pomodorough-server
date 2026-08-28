package store

import (
	"context"
	"path/filepath"
	"testing"
)

func TestCurrentSchemaVersionMatchesNewAccountAndReadOnlyVerifier(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	userStore, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	userID := "22222222222222222222222222222222"
	db, err := userStore.OpenUser(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	var databaseVersion int
	if err := db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&databaseVersion); err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if databaseVersion != CurrentSchemaVersion() {
		t.Fatalf("database schema version=%d, binary version=%d", databaseVersion, CurrentSchemaVersion())
	}
	if err := VerifyDataDirSchemaVersion(ctx, filepath.Clean(dataDir)); err != nil {
		t.Fatalf("current account failed read-only schema verification: %v", err)
	}
}
