package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"runtime"
	"testing"
	"time"
)

const accountGenerationTestUserID = "abcdef0123456789abcdef0123456789"

func TestWithAccountGenerationHoldsUserLockThroughOperation(t *testing.T) {
	ctx := context.Background()
	userStore, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	db, err := userStore.OpenUser(ctx, accountGenerationTestUserID)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	operationEntered := make(chan struct{})
	releaseOperation := make(chan struct{})
	operationReleased := false
	defer func() {
		if !operationReleased {
			close(releaseOperation)
		}
	}()
	operationDone := make(chan error, 1)
	go func() {
		_, err := withAccountGeneration(userStore, ctx, accountGenerationTestUserID, 1, func(db *sql.DB) (struct{}, error) {
			close(operationEntered)
			<-releaseOperation
			_, err := db.ExecContext(ctx, `UPDATE account_state SET revision = 1 WHERE singleton = 1`)
			return struct{}{}, err
		})
		operationDone <- err
	}()
	<-operationEntered

	deleteDone := make(chan error, 1)
	go func() {
		deleteDone <- userStore.DeleteUserForGeneration(ctx, accountGenerationTestUserID, 1)
	}()
	waitForUserLockReferences(t, userStore, accountGenerationTestUserID, 2)
	select {
	case err := <-deleteDone:
		t.Fatalf("generation-scoped deletion bypassed active operation lock: %v", err)
	default:
	}

	close(releaseOperation)
	operationReleased = true
	if err := <-operationDone; err != nil {
		t.Fatalf("generation-scoped operation: %v", err)
	}
	if err := <-deleteDone; err != nil {
		t.Fatalf("generation-scoped deletion: %v", err)
	}

	db, err = userStore.OpenUser(ctx, accountGenerationTestUserID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	generation, err := accountGeneration(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	var revision int64
	if err := db.QueryRowContext(ctx, `SELECT revision FROM account_state WHERE singleton = 1`).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	if generation != 2 || revision != 0 {
		t.Fatalf("recreated account generation=%d revision=%d, want generation=2 revision=0", generation, revision)
	}
}

func TestValidateAccountGenerationAcceptsOnlyTheCurrentLiveAccount(t *testing.T) {
	ctx := context.Background()
	userStore, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	db, err := userStore.OpenUser(ctx, accountGenerationTestUserID)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	if err := userStore.ValidateAccountGeneration(ctx, accountGenerationTestUserID, 1); err != nil {
		t.Fatalf("validate current generation: %v", err)
	}
	if err := userStore.ValidateAccountGeneration(ctx, accountGenerationTestUserID, 2); !errors.Is(err, ErrAccountGenerationChanged) {
		t.Fatalf("validate stale generation error = %v, want ErrAccountGenerationChanged", err)
	}

	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := userStore.ValidateAccountGeneration(cancelled, accountGenerationTestUserID, 1); !errors.Is(err, context.Canceled) {
		t.Fatalf("validate cancelled context error = %v, want context.Canceled", err)
	}
}

func TestWithAccountGenerationReturnsTypedResultAndPreservesOperationError(t *testing.T) {
	ctx := context.Background()
	userStore, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	db, err := userStore.OpenUser(ctx, accountGenerationTestUserID)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	result, err := withAccountGeneration(userStore, ctx, accountGenerationTestUserID, 1, func(*sql.DB) (string, error) {
		return "generation-one", nil
	})
	if err != nil || result != "generation-one" {
		t.Fatalf("successful operation = %q, %v", result, err)
	}

	operationErr := errors.New("operation failed")
	result, err = withAccountGeneration(userStore, ctx, accountGenerationTestUserID, 1, func(*sql.DB) (string, error) {
		return "must be discarded", operationErr
	})
	if !errors.Is(err, operationErr) || result != "" {
		t.Fatalf("failed operation = %q, %v; want zero result and original error", result, err)
	}
}

func TestGenerationScopedDataOperationsRejectAStaleAccount(t *testing.T) {
	ctx := context.Background()
	userStore, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	db, err := userStore.OpenUser(ctx, accountGenerationTestUserID)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_700_000_000, 0).UTC()

	checks := map[string]func() error{
		"sync": func() error {
			_, err := userStore.SyncForGeneration(ctx, accountGenerationTestUserID, 2, SyncRequest{DeviceID: "device-stale"}, now)
			return err
		},
		"bootstrap": func() error {
			_, err := userStore.BootstrapForGeneration(ctx, accountGenerationTestUserID, 2, now)
			return err
		},
		"bootstrap resolution": func() error {
			_, err := userStore.ResolveBootstrapForGeneration(ctx, accountGenerationTestUserID, 2, BootstrapResolutionRequest{}, now)
			return err
		},
		"history": func() error {
			_, _, _, err := userStore.HistoryForGeneration(ctx, accountGenerationTestUserID, 2, now)
			return err
		},
		"CSRF rotation": func() error {
			return userStore.UpdateCSRFForGeneration(ctx, accountGenerationTestUserID, 2, "stale-session", sha256.Sum256([]byte("csrf")))
		},
		"session revocation": func() error {
			return userStore.RevokeSessionForGeneration(ctx, accountGenerationTestUserID, 2, "stale-session", now)
		},
		"device revocation": func() error {
			return userStore.RevokeDeviceForGeneration(ctx, accountGenerationTestUserID, 2, "stale-device", now)
		},
	}
	for name, check := range checks {
		t.Run(name, func(t *testing.T) {
			if err := check(); !errors.Is(err, ErrAccountGenerationChanged) {
				t.Fatalf("error = %v, want ErrAccountGenerationChanged", err)
			}
		})
	}
}

func waitForUserLockReferences(t *testing.T, userStore *Store, userID string, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		userStore.locksMu.Lock()
		lock := userStore.locks[userID]
		refs := 0
		if lock != nil {
			refs = lock.refs
		}
		userStore.locksMu.Unlock()
		if refs == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("user lock references = %d, want %d", refs, want)
		}
		runtime.Gosched()
	}
}
