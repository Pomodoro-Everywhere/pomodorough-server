package server

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"pomodorough/internal/authn"
	"pomodorough/internal/config"
	"pomodorough/internal/sharedcore"
	"pomodorough/internal/store"
)

type readinessTestFixture struct {
	application  *Server
	handler      http.Handler
	dataDir      string
	ledgerDir    string
	webRoot      string
	databasePath string
	userID       string
}

type readinessPathState struct {
	Mode       fs.FileMode
	Size       int64
	ModifiedNS int64
	Digest     [sha256.Size]byte
}

type readinessCoreFunc func(context.Context, string, []byte) ([]byte, error)

func (function readinessCoreFunc) Call(ctx context.Context, operation string, input []byte) ([]byte, error) {
	return function(ctx, operation, input)
}

func TestS6ReadinessHealthyWithoutDependencySideEffects(t *testing.T) {
	fixture := newReadinessTestFixture(t)
	coreArtifact := filepath.Join("..", "sharedcore", "pomodorough_core.wasm")
	before := readinessSnapshot(t, fixture.dataDir, fixture.ledgerDir, fixture.webRoot, coreArtifact)
	response := requestReadiness(fixture.handler)
	after := readinessSnapshot(t, fixture.dataDir, fixture.ledgerDir, fixture.webRoot, coreArtifact)
	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != `{"status":"ready"}` {
		t.Fatalf("readiness response = %d %s", response.Code, response.Body.String())
	}
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("readiness changed dependencies:\nbefore=%#v\nafter=%#v", before, after)
	}
}

func TestS8ReadinessMetadataDigestMatchesGeneratedAsset(t *testing.T) {
	contents, err := os.ReadFile(filepath.Join("..", "..", "web", "shared-core-metadata.js"))
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(contents)
	if actual := fmt.Sprintf("%x", digest); actual != readinessSharedCoreMetadataDigest {
		t.Fatalf("shared-core metadata digest = %s, want %s", actual, readinessSharedCoreMetadataDigest)
	}
}

func TestS6ReadinessAssetDigestsMatchWebDirectory(t *testing.T) {
	for _, asset := range readinessAssets {
		contents, err := os.ReadFile(filepath.Join("..", "..", "web", asset.name))
		if err != nil {
			t.Fatalf("read web asset %s: %v", asset.name, err)
		}
		digest := sha256.Sum256(contents)
		if actual := fmt.Sprintf("%x", digest); actual != asset.digest {
			t.Fatalf("stale readiness pin for %s = %s, want %s (update readiness.go)", asset.name, asset.digest, actual)
		}
	}
}

func TestS6NewReadinessRequiresAssetsAndCore(t *testing.T) {
	fixture := newReadinessTestFixture(t)
	application, err := New(fixture.application.cfg, fixture.application.store, fixture.application.logger)
	if err != nil {
		t.Fatal(err)
	}
	handler := application.Handler()
	assertReadinessFailure(t, handler, "core_unavailable")
	if err := os.Remove(filepath.Join(fixture.webRoot, "index.html")); err != nil {
		t.Fatal(err)
	}
	assertReadinessFailure(t, handler, "web_unavailable")
	assertHealthIndependent(t, handler)
}

func TestS6NewForTrafficReadinessRequiresCoreAndAssets(t *testing.T) {
	fixture := newReadinessTestFixture(t)
	_, err := NewForTraffic(fixture.application.cfg, fixture.application.store, fixture.application.logger, nil)
	if err == nil {
		t.Fatal("NewForTraffic accepted missing Core runtime")
	}
	if err := os.Remove(filepath.Join(fixture.webRoot, "index.html")); err != nil {
		t.Fatal(err)
	}
	assertReadinessFailure(t, fixture.handler, "web_unavailable")
	assertHealthIndependent(t, fixture.handler)
}

func TestS6ReadinessFailsClosedForKeyStorageLedgerAndDatabase(t *testing.T) {
	tests := map[string]struct {
		code   string
		mutate func(*testing.T, readinessTestFixture)
	}{
		"key": {"key_unavailable", func(_ *testing.T, fixture readinessTestFixture) {
			fixture.application.cfg.AppSecret[0] ^= 0xff
		}},
		"storage": {"storage_unavailable", func(t *testing.T, fixture readinessTestFixture) {
			renameReadinessPath(t, filepath.Join(fixture.dataDir, "users"))
		}},
		"ledger": {"ledger_unavailable", func(t *testing.T, fixture readinessTestFixture) {
			renameReadinessPath(t, fixture.ledgerDir)
		}},
		"database": {"database_unavailable", func(t *testing.T, fixture readinessTestFixture) {
			if err := os.WriteFile(fixture.databasePath, []byte("corrupt"), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			fixture := newReadinessTestFixture(t)
			test.mutate(t, fixture)
			assertReadinessFailure(t, fixture.handler, test.code)
			assertHealthIndependent(t, fixture.handler)
		})
	}
}

func TestS6ReadinessRejectsInvalidAccountLifecycle(t *testing.T) {
	fixture := newReadinessTestFixture(t)
	digest := sha256.Sum256([]byte(fixture.userID))
	path := filepath.Join(fixture.ledgerDir, fmt.Sprintf("account-%x.json", digest))
	contents := []byte(`{"version":1,"generation":2,"state":"active","updatedAtMs":1}` + "\n")
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	assertReadinessFailure(t, fixture.handler, "lifecycle_invalid")
}

func TestS6ReadinessRejectsMissingCorruptAndUnsafeWebAssets(t *testing.T) {
	tests := map[string]func(*testing.T, readinessTestFixture){
		"missing": func(t *testing.T, fixture readinessTestFixture) {
			if err := os.Remove(filepath.Join(fixture.webRoot, "index.html")); err != nil {
				t.Fatal(err)
			}
		},
		"corrupt": func(t *testing.T, fixture readinessTestFixture) {
			if err := os.WriteFile(filepath.Join(fixture.webRoot, "app.js"), []byte("broken"), 0o600); err != nil {
				t.Fatal(err)
			}
		},
		"unsafe": func(t *testing.T, fixture readinessTestFixture) {
			path := filepath.Join(fixture.webRoot, "icon.svg")
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(filepath.Join(fixture.webRoot, "index.html"), path); err != nil {
				t.Fatal(err)
			}
		},
		"unreadable": func(t *testing.T, fixture readinessTestFixture) {
			if err := os.Chmod(filepath.Join(fixture.webRoot, "landing.js"), 0o000); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			fixture := newReadinessTestFixture(t)
			mutate(t, fixture)
			assertReadinessFailure(t, fixture.handler, "web_unavailable")
		})
	}
}

func TestS6ReadinessRejectsWrongCoreProvenance(t *testing.T) {
	for _, name := range []string{"shared-core-metadata.js", "pomodorough_core.wasm"} {
		t.Run(name, func(t *testing.T) {
			fixture := newReadinessTestFixture(t)
			path := filepath.Join(fixture.webRoot, name)
			if err := os.WriteFile(path, []byte("wrong provenance"), 0o600); err != nil {
				t.Fatal(err)
			}
			assertReadinessFailure(t, fixture.handler, "core_provenance_invalid")
		})
	}
}

func TestS6ReadinessRejectsUnavailableOrWrongCoreRuntime(t *testing.T) {
	tests := map[string]readinessCore{
		"missing": nil,
		"unavailable": readinessCoreFunc(func(context.Context, string, []byte) ([]byte, error) {
			return nil, errors.New("secret runtime detail")
		}),
		"wrong version": readinessCoreFunc(func(context.Context, string, []byte) ([]byte, error) {
			return []byte(`{"ok":true,"value":{"schemaVersion":1,"coreVersion":"wrong"}}`), nil
		}),
		"malformed": readinessCoreFunc(func(context.Context, string, []byte) ([]byte, error) {
			return []byte(`not-json`), nil
		}),
	}
	for name, runtime := range tests {
		t.Run(name, func(t *testing.T) {
			fixture := newReadinessTestFixture(t)
			fixture.application.readinessCore = runtime
			assertReadinessFailure(t, fixture.handler, "core_unavailable")
		})
	}
}

func TestS6ReadinessTimeoutAndCancellationFailClosed(t *testing.T) {
	t.Run("timeout", func(t *testing.T) {
		fixture := newReadinessTestFixture(t)
		fixture.application.readinessTimeout = 20 * time.Millisecond
		fixture.application.readinessCore = readinessCoreFunc(blockUntilReadinessCanceled)
		started := time.Now()
		assertReadinessFailure(t, fixture.handler, "check_timeout")
		if elapsed := time.Since(started); elapsed > time.Second {
			t.Fatalf("bounded readiness took %s", elapsed)
		}
	})
	t.Run("cancellation", func(t *testing.T) {
		fixture := newReadinessTestFixture(t)
		request := httptest.NewRequest(http.MethodGet, "https://example.invalid/readyz", nil)
		ctx, cancel := context.WithCancel(request.Context())
		cancel()
		response := httptest.NewRecorder()
		fixture.handler.ServeHTTP(response, request.WithContext(ctx))
		assertReadinessResponse(t, response, "check_canceled")
	})
}

func TestS6ReadinessSupportsConcurrentProbes(t *testing.T) {
	fixture := newReadinessTestFixture(t)
	const probeCount = 8
	errors := make(chan string, probeCount)
	var probes sync.WaitGroup
	for range probeCount {
		probes.Add(1)
		go func() {
			defer probes.Done()
			response := requestReadiness(fixture.handler)
			if response.Code != http.StatusOK {
				errors <- response.Body.String()
			}
		}()
	}
	probes.Wait()
	close(errors)
	for failure := range errors {
		t.Fatalf("concurrent readiness failed: %s", failure)
	}
}

func blockUntilReadinessCanceled(ctx context.Context, _ string, _ []byte) ([]byte, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

func newReadinessTestFixture(t *testing.T) readinessTestFixture {
	t.Helper()
	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	ledgerDir := filepath.Join(root, "ledger")
	webRoot := filepath.Join(root, "web")
	copyReadinessAssets(t, webRoot)
	userStore, err := store.NewWithDeletionLedger(dataDir, ledgerDir)
	if err != nil {
		t.Fatal(err)
	}
	secret := []byte(strings.Repeat("r", 32))
	userID := authn.UserID(secret, googleIssuer, "readiness-subject")
	database, err := userStore.OpenUser(context.Background(), userID)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	core, err := sharedcore.New(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = core.Close(context.Background()) })
	configuration := config.Config{AppSecret: secret, WebRoot: webRoot}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	application, err := NewForTraffic(configuration, userStore, logger, core)
	if err != nil {
		t.Fatal(err)
	}
	databasePath := filepath.Join(dataDir, "users", userID+".sqlite")
	return readinessTestFixture{application, application.Handler(), dataDir, ledgerDir, webRoot, databasePath, userID}
}

func copyReadinessAssets(t *testing.T, destination string) {
	t.Helper()
	for _, asset := range readinessAssets {
		source := filepath.Join("..", "..", "web", asset.name)
		contents, err := os.ReadFile(source)
		if err != nil {
			t.Fatalf("read source asset %s: %v", asset.name, err)
		}
		path := filepath.Join(destination, asset.name)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, contents, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func requestReadiness(handler http.Handler) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, "https://example.invalid/readyz", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func assertReadinessFailure(t *testing.T, handler http.Handler, code string) {
	t.Helper()
	assertReadinessResponse(t, requestReadiness(handler), code)
}

func assertReadinessResponse(t *testing.T, response *httptest.ResponseRecorder, code string) {
	t.Helper()
	want := `{"status":"not_ready","error":"` + code + `"}`
	if response.Code != http.StatusServiceUnavailable || strings.TrimSpace(response.Body.String()) != want {
		t.Fatalf("readiness response = %d %s, want 503 %s", response.Code, response.Body.String(), want)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("readiness Cache-Control = %q", response.Header().Get("Cache-Control"))
	}
}

func assertHealthIndependent(t *testing.T, handler http.Handler) {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "https://example.invalid/healthz", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != `{"status":"ok"}` {
		t.Fatalf("health response = %d %s", response.Code, response.Body.String())
	}
}

func renameReadinessPath(t *testing.T, path string) {
	t.Helper()
	if err := os.Rename(path, path+"-offline"); err != nil {
		t.Fatal(err)
	}
}

func readinessSnapshot(t *testing.T, roots ...string) map[string]readinessPathState {
	t.Helper()
	result := make(map[string]readinessPathState)
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
			result[key] = readinessPathState{info.Mode(), info.Size(), info.ModTime().UnixNano(), digest}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	return result
}
