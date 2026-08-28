package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSchemaVerificationRejectsNonRegularAccountDatabase(t *testing.T) {
	dataDir := t.TempDir()
	usersDir := filepath.Join(dataDir, "users")
	if err := os.MkdirAll(usersDir, 0o700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "target.sqlite")
	if err := os.WriteFile(target, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(usersDir, "unsafe.sqlite")); err != nil {
		t.Fatal(err)
	}
	if err := VerifyDataDirSchemaVersion(context.Background(), dataDir); err == nil || !strings.Contains(err.Error(), "not a regular file") {
		t.Fatalf("schema verification error = %v, want unsafe-file rejection", err)
	}
}

func TestAccountCreationRejectsExhaustedGeneration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "account.sqlite")
	db, err := createAccountDatabase(context.Background(), path, MaxSafeRevision)
	if db != nil {
		db.Close()
	}
	if !errors.Is(err, ErrRevisionExhausted) {
		t.Fatalf("createAccountDatabase error = %v, want ErrRevisionExhausted", err)
	}
}

func TestGenerationScopedBootstrapResolutionSucceedsForCurrentAccount(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "generation-bootstrap-positive")
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	result, err := userStore.ResolveBootstrapForGeneration(ctx, userID, 1, BootstrapResolutionRequest{
		RequestID: "generation-bootstrap-request", DeviceID: "device-generation",
		ExpectedRevision: 0, Strategy: BootstrapKeepRemote,
	}, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if result.Revision != 0 || result.Changed {
		t.Fatalf("bootstrap result revision=%d changed=%v, want unchanged revision zero", result.Revision, result.Changed)
	}
}
