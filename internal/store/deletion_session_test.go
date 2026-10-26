package store

import (
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"
)

func TestDeletionSessionValidationWaitsForAccountLock(t *testing.T) {
	for _, mutation := range []string{"token", "session", "ownership"} {
		t.Run(mutation, func(t *testing.T) {
			userStore, userID, credential := deletionSessionFixture(t, "bearer", "access")
			unlock := userStore.LockUser(userID)
			var once sync.Once
			release := func() { once.Do(unlock) }
			wait := startDeletionSessionWorker(t, userStore, userID, credential, release)
			// A second lock reference proves DELETE reached the serialization boundary.
			waitForUserLockReferences(t, userStore, userID, 2)
			mutateDeletionSession(t, userStore, userID, mutation)
			account := deletionSessionAccount(t, userStore, userID)
			ledger := deletionSessionFiles(t, userStore)
			release()
			if err := wait(); !errors.Is(err, ErrUnauthorized) {
				t.Fatalf("queued deletion error=%v, want ErrUnauthorized", err)
			}
			assertDeletionSessionPreserved(t, userStore, userID, account, ledger)
		})
	}
}

func TestDeletionSessionRejectsInvalidCredentialOwnership(t *testing.T) {
	cases := []struct {
		name, method, tokenKind, session, mutation string
	}{
		{"empty-session", "bearer", "access", "", ""},
		{"other-session", "bearer", "access", "other-session", ""},
		{"missing-token", "bearer", "access", "deleting-session", "missing-token"},
		{"access-as-cookie", "cookie", "access", "deleting-session", ""},
		{"web-as-bearer", "bearer", "web", "deleting-session", ""},
		{"refresh-as-bearer", "bearer", "refresh", "deleting-session", ""},
		{"revoked-token", "cookie", "web", "deleting-session", "token"},
		{"revoked-session", "cookie", "web", "deleting-session", "session"},
		{"prepared-receipt", "bearer", "access", "deleting-session", "prepared"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			userStore, userID, credential := deletionSessionFixture(t, test.method, test.tokenKind)
			if test.mutation == "missing-token" {
				credential.TokenHash = sha256.Sum256([]byte("unissued-token"))
			} else if test.mutation == "prepared" {
				if err := userStore.writeDeletionReceipt(userID, credential, DeletionReceipt{Version: 1, Generation: 1}); err != nil {
					t.Fatal(err)
				}
				mutateDeletionSession(t, userStore, userID, "session")
			} else if test.mutation != "" {
				mutateDeletionSession(t, userStore, userID, test.mutation)
			}
			account := deletionSessionAccount(t, userStore, userID)
			ledger := deletionSessionFiles(t, userStore)
			err := userStore.DeleteUserWithReceiptForSession(context.Background(), userID, 1, credential, nil, test.session)
			if !errors.Is(err, ErrUnauthorized) {
				t.Fatalf("deletion error=%v, want ErrUnauthorized", err)
			}
			assertDeletionSessionPreserved(t, userStore, userID, account, ledger)
			if receipt, err := userStore.CommittedDeletionReceipt(userID, credential); err != nil || receipt.Generation != 0 {
				t.Fatalf("rejection committed receipt: %+v %v", receipt, err)
			}
		})
	}
}

func TestDeletionSessionAcceptsMatchingLiveCredential(t *testing.T) {
	for method, kind := range map[string]string{"cookie": "web", "bearer": "access"} {
		t.Run(method, func(t *testing.T) {
			userStore, userID, credential := deletionSessionFixture(t, method, kind)
			var csrf []byte
			if method == "cookie" {
				hash := sha256.Sum256([]byte("csrf"))
				csrf = hash[:]
			}
			if err := userStore.DeleteUserWithReceiptForSession(context.Background(), userID, 1, credential, csrf, "deleting-session"); err != nil {
				t.Fatal(err)
			}
			if receipt, err := userStore.CommittedDeletionReceipt(userID, credential); err != nil || receipt.Generation != 1 {
				t.Fatalf("live deletion receipt: %+v %v", receipt, err)
			}
		})
	}
}

func deletionSessionFixture(t *testing.T, method, tokenKind string) (*Store, string, DeletionCredential) {
	t.Helper()
	userStore, db, userID, _ := openTestUser(t, "deletion-session")
	defer func() {
		if err := db.Close(); err != nil {
			t.Errorf("close seeded account: %v", err)
		}
	}()
	now := time.Now().UTC()
	credential := DeletionCredential{TokenHash: sha256.Sum256([]byte("deletion-token")), Method: method}
	kind := "native"
	if tokenKind == "web" {
		kind = "web"
	}
	for _, sessionID := range []string{"deleting-session", "other-session"} {
		var tokens []TokenRecord
		sessionKind := kind
		if sessionID == "deleting-session" {
			tokens = []TokenRecord{{Hash: credential.TokenHash, Kind: tokenKind, CreatedAt: now, ExpiresAt: now.Add(time.Hour)}}
		} else {
			sessionKind = "native"
			tokens = []TokenRecord{{Hash: sha256.Sum256([]byte("preserved-refresh")), Kind: "refresh", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}}
		}
		err := CreateSession(context.Background(), db, Session{
			ID: sessionID, Kind: sessionKind, DeviceID: sessionID + "-device", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
		}, tokens)
		if err != nil {
			t.Fatal(err)
		}
	}
	request := bootstrapSyncRequest(now, "content-device", "preserved")
	result, err := userStore.Sync(context.Background(), db, userID, request, now)
	if err != nil || len(result.Tasks) != 1 || result.CanonicalTimer == nil || result.DurationsMs.Focus != 1_800_000 {
		t.Fatalf("seed account content: result=%+v error=%v", result, err)
	}
	return userStore, userID, credential
}

func mutateDeletionSession(t *testing.T, userStore *Store, userID, mutation string) {
	t.Helper()
	db, err := userStore.OpenExistingUser(context.Background(), userID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Errorf("close mutated session: %v", err)
		}
	}()
	queries := map[string]string{
		"token":     `UPDATE auth_tokens SET revoked_at_ms=1 WHERE session_id='deleting-session'`,
		"session":   `UPDATE auth_sessions SET revoked_at_ms=1 WHERE id='deleting-session'`,
		"ownership": `UPDATE auth_tokens SET session_id='other-session' WHERE session_id='deleting-session'`,
	}
	query, ok := queries[mutation]
	if !ok {
		t.Fatalf("unknown session mutation %q", mutation)
	}
	if _, err := db.Exec(query); err != nil {
		t.Fatal(err)
	}
}

func deletionSessionFiles(t *testing.T, userStore *Store) map[string]string {
	t.Helper()
	entries, err := os.ReadDir(userStore.deletionLedgerDir)
	if err != nil {
		t.Fatal(err)
	}
	files := make(map[string]string, len(entries))
	for _, entry := range entries {
		contents, err := os.ReadFile(filepath.Join(userStore.deletionLedgerDir, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		files[entry.Name()] = string(contents)
	}
	return files
}

func assertDeletionSessionPreserved(t *testing.T, userStore *Store, userID string, account []deletionSQLTable, ledger map[string]string) {
	t.Helper()
	if got := deletionSessionAccount(t, userStore, userID); !reflect.DeepEqual(got, account) {
		t.Fatalf("rejected deletion changed SQL: before=%#v after=%#v", account, got)
	}
	if !reflect.DeepEqual(ledger, deletionSessionFiles(t, userStore)) {
		t.Fatal("rejected deletion changed durable ledger")
	}
}

func startDeletionSessionWorker(t *testing.T, userStore *Store, userID string, credential DeletionCredential, release func()) func() error {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	var result error
	go func() {
		defer close(done)
		result = userStore.DeleteUserWithReceiptForSession(ctx, userID, 1, credential, nil, "deleting-session")
	}()
	wait := func() error {
		select {
		case <-done:
			return result
		case <-time.After(5 * time.Second):
			t.Fatal("deletion worker did not finish after lock release")
			return nil
		}
	}
	t.Cleanup(func() {
		cancel()
		release()
		wait()
	})
	return wait
}
