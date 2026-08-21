package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestDeleteUserRemovesDatabaseAndSidecars(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	userStore, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	userID := "0123456789abcdef0123456789abcdef"
	db, err := userStore.OpenUser(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO profile(singleton, user_id, issuer, subject, email, email_verified, name, avatar_url, updated_at_ms)
		VALUES (1, ?, 'issuer', 'subject', 'person@example.com', 1, 'Person', '', 1)`, userID); err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	path := filepath.Join(dataDir, "users", userID+".sqlite")
	for _, suffix := range []string{"-wal", "-shm"} {
		if err := os.WriteFile(path+suffix, []byte("sidecar"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	if err := userStore.DeleteUser(ctx, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := userStore.OpenExistingUser(ctx, userID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("OpenExistingUser after deletion error = %v, want ErrNotFound", err)
	}
	for _, candidate := range []string{path, path + "-wal", path + "-shm"} {
		if _, err := os.Stat(candidate); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("deleted file %s stat error = %v", candidate, err)
		}
	}
}

func TestDeleteUserIsIdempotent(t *testing.T) {
	userStore, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := userStore.DeleteUser(context.Background(), "0123456789abcdef0123456789abcdef"); err != nil {
		t.Fatalf("DeleteUser absent account error = %v", err)
	}
}
