package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"pomodorough/internal/store"
)

func TestHTTPDeletionRejectsLogoutWhileBodyIsHeld(t *testing.T) {
	for _, method := range []string{"cookie", "bearer"} {
		t.Run(method, func(t *testing.T) {
			fixture := newServerFixture(t)
			seedDeletionSessionAccount(t, fixture)
			dir := deletionFixtureDataDir(t, fixture)
			resume := holdAuthenticatedDeletion(t, fixture, method)
			sendDeletionSessionRequest(t, fixture, method, "POST", "/api/v1/auth/logout", http.StatusNoContent)
			sendDeletionSessionRequest(t, fixture, method, "GET", "/api/v1/me", http.StatusUnauthorized)
			account := deletionSessionAccount(t, fixture)
			ledger := deletionSessionLedger(t, dir)
			response := resume()
			if response.Code != http.StatusUnauthorized || response.Body.String() != "{\"error\":\"unauthorized\"}\n" {
				t.Fatalf("revoked deletion: status=%d body=%s", response.Code, response.Body.String())
			}
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("revoked deletion response is cacheable")
			}
			if got := deletionSessionAccount(t, fixture); !reflect.DeepEqual(got, account) {
				t.Fatalf("revoked deletion changed SQL: before=%#v after=%#v", account, got)
			}
			if err := fixture.userStore.ValidateAccountGeneration(context.Background(), fixture.userID, 1); err != nil {
				t.Fatalf("revoked deletion changed generation: %v", err)
			}
			if !reflect.DeepEqual(ledger, deletionSessionLedger(t, dir)) {
				t.Fatal("revoked deletion changed durable ledger")
			}
		})
	}
}

func TestHTTPDeletionSessionReceiptReplayAfterRestart(t *testing.T) {
	for _, method := range []string{"cookie", "bearer"} {
		t.Run(method, func(t *testing.T) {
			fixture := newServerFixture(t)
			seedDeletionSessionAccount(t, fixture)
			dir := deletionFixtureDataDir(t, fixture)
			sendDeletionSessionRequest(t, fixture, method, "DELETE", "/api/v1/account", http.StatusNoContent)
			if db, err := fixture.userStore.OpenExistingUser(context.Background(), fixture.userID); !errors.Is(err, store.ErrNotFound) {
				if db != nil {
					db.Close()
				}
				t.Fatalf("live deletion did not purge session database: %v", err)
			}
			ledger := deletionSessionLedger(t, dir)
			fixture = restartDeletionFixture(t, fixture, dir)
			sendDeletionSessionRequest(t, fixture, method, "GET", "/api/v1/me", http.StatusUnauthorized)
			sendDeletionSessionRequest(t, fixture, method, "DELETE", "/api/v1/account", http.StatusNoContent)
			if !reflect.DeepEqual(ledger, deletionSessionLedger(t, dir)) {
				t.Fatal("receipt-only replay changed durable ledger")
			}
			createFreshFixtureAccount(t, fixture)
			seedDeletionSessionAccount(t, fixture)
			if err := fixture.userStore.ValidateAccountGeneration(t.Context(), fixture.userID, 2); err != nil {
				t.Fatal(err)
			}
			account := deletionSessionAccount(t, fixture)
			ledger = deletionSessionLedger(t, dir)
			sendDeletionSessionRequest(t, fixture, method, "DELETE", "/api/v1/account", http.StatusNoContent)
			if got := deletionSessionAccount(t, fixture); !reflect.DeepEqual(got, account) {
				t.Fatalf("receipt replay changed SQL: before=%#v after=%#v", account, got)
			}
			if !reflect.DeepEqual(ledger, deletionSessionLedger(t, dir)) {
				t.Fatal("receipt-only replay changed durable ledger")
			}
		})
	}
}

func TestHTTPHeldDeletionPreservesRecreatedGeneration(t *testing.T) {
	for _, method := range []string{"cookie", "bearer"} {
		for _, receipt := range []string{"uncommitted", "committed"} {
			t.Run(method+"/"+receipt, func(t *testing.T) {
				fixture := newServerFixture(t)
				seedDeletionSessionAccount(t, fixture)
				dir := deletionFixtureDataDir(t, fixture)
				resume := holdAuthenticatedDeletion(t, fixture, method)
				want := http.StatusUnauthorized
				if receipt == "committed" {
					sendDeletionSessionRequest(t, fixture, method, "DELETE", "/api/v1/account", http.StatusNoContent)
					createFreshFixtureAccount(t, fixture)
					want = http.StatusNoContent
				} else {
					recreateFixtureAccount(t, fixture)
				}
				seedDeletionSessionAccount(t, fixture)
				if err := fixture.userStore.ValidateAccountGeneration(t.Context(), fixture.userID, 2); err != nil {
					t.Fatal(err)
				}
				account := deletionSessionAccount(t, fixture)
				ledger := deletionSessionLedger(t, dir)
				if response := resume(); response.Code != want {
					t.Fatalf("old deletion: status=%d want=%d body=%s", response.Code, want, response.Body.String())
				}
				if got := deletionSessionAccount(t, fixture); !reflect.DeepEqual(got, account) {
					t.Fatalf("old deletion changed SQL: before=%#v after=%#v", account, got)
				}
				if !reflect.DeepEqual(ledger, deletionSessionLedger(t, dir)) {
					t.Fatal("old deletion changed durable ledger")
				}
			})
		}
	}
}

type deletionBodyBarrier struct {
	io.Reader
	entered, release chan struct{}
	once             sync.Once
}

func (body *deletionBodyBarrier) Read(p []byte) (int, error) {
	body.once.Do(func() {
		close(body.entered)
		<-body.release
	})
	return body.Reader.Read(p)
}

func (body *deletionBodyBarrier) Close() error { return nil }

func holdAuthenticatedDeletion(t *testing.T, fixture serverFixture, method string) func() *httptest.ResponseRecorder {
	t.Helper()
	request, response := deletionSessionRequest(t, fixture, method, "DELETE", "/api/v1/account")
	body := &deletionBodyBarrier{
		Reader: strings.NewReader(`{"confirmation":"DELETE"}`), entered: make(chan struct{}), release: make(chan struct{}),
	}
	request.Body = body
	done := make(chan struct{})
	go func() {
		defer close(done)
		fixture.handler.ServeHTTP(response, request)
	}()
	var once sync.Once
	resume := func() *httptest.ResponseRecorder {
		once.Do(func() { close(body.release) })
		waitForSignal(t, done, "held DELETE completion")
		return response
	}
	t.Cleanup(func() { resume() })
	// Only the production handler reads this body, after middleware authentication.
	waitForSignal(t, body.entered, "DELETE body read after authentication")
	return resume
}

func deletionSessionRequest(t *testing.T, fixture serverFixture, method, verb, path string) (*http.Request, *httptest.ResponseRecorder) {
	t.Helper()
	request, response := newJSONRequest(t, verb, fixture.application.cfg.PublicURL+path, map[string]string{"confirmation": "DELETE"})
	if method == "cookie" {
		addWebAuthentication(request, fixture)
		addValidCSRF(request, fixture)
	} else {
		request.Header.Set("Authorization", "Bearer "+fixture.accessToken)
	}
	return request, response
}

func sendDeletionSessionRequest(t *testing.T, fixture serverFixture, method, verb, path string, want int) {
	t.Helper()
	request, response := deletionSessionRequest(t, fixture, method, verb, path)
	fixture.handler.ServeHTTP(response, request)
	if response.Code != want {
		t.Fatalf("%s %s: status=%d want=%d body=%s", verb, path, response.Code, want, response.Body.String())
	}
	if want == http.StatusNoContent && response.Body.Len() != 0 {
		t.Fatalf("204 response contains body: %s", response.Body.String())
	}
}

func deletionSessionLedger(t *testing.T, dir string) map[string]string {
	t.Helper()
	entries, err := os.ReadDir(dir + "-deletion-ledger")
	if err != nil {
		t.Fatal(err)
	}
	files := make(map[string]string, len(entries))
	for _, entry := range entries {
		contents, err := os.ReadFile(filepath.Join(dir+"-deletion-ledger", entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		files[entry.Name()] = string(contents)
	}
	return files
}
