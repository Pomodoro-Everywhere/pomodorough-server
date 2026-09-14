package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"pomodorough/internal/authn"
	"pomodorough/internal/store"
)

const (
	readinessCheckTimeout  = 2 * time.Second
	readinessAssetMaxBytes = 2 << 20
	readinessCoreVersion   = "0.39.0"
)

type readinessAsset struct {
	name       string
	digest     string
	provenance bool
}

type readinessCore interface {
	Call(context.Context, string, []byte) ([]byte, error)
}

type readinessFailure struct {
	code string
	err  error
}

func (failure *readinessFailure) Error() string { return failure.err.Error() }
func (failure *readinessFailure) Unwrap() error { return failure.err }

var readinessAssets = []readinessAsset{
	{"index.html", "3746682541e5844a61e7a39eaf1950e93f30fe353f0a5ed63f6e19102e6fbb06", false},
	{"privacy.html", "37331b4b5c4bbbc8d78535b519885e3556f4db00e9eb31f5a6eb6b2b5abd3643", false},
	{"landing.css", "4d42859c8f0bc575055f3099b79f0a6d3862a966e8aa955d49933328e4cf86ba", false},
	{"platform-selector.js", "e53063090e5bbcdb8aa771c251c8226a023414154e1f4b22c2d4f510188e3e7d", false},
	{"landing.js", "51568abe1282e9578d0709a447868df7d9956c98945543f1e98e28c1a5d68b66", false},
	{"sentry-client.js", "1ea6c55ebb06f7e79ea6e4e5e4d60fbd1b1b132746b15645e4d7055449ebd4af", false},
	{"app.html", "2f3cde1c78bf37b5f90df5daba22ced57204ff04fc757ca95c577a2758a0d53d", false},
	{"app.css", "98a518584f823ceba56e612a756912b97f7f4607d255f79db5e4863bfede5297", false},
	{"shared-core-metadata.js", readinessSharedCoreMetadataDigest, true},
	{"shared-core.js", "06bd18d37625c53ce6c57186476748a231a1da28b89d8e869683e5da9f2a5b98", false},
	{"pomodorough_core.wasm", "51639c4f9261cf26f940934c093f9caf4458e4b04ff50022a75044da34091619", true},
	{"sync-core.js", "dbdf85af88fa6f9381efd10b259d07318a133381e5d0abe897298672aabc3122", false},
	{"sync-authority.js", "56c505663ec47ad1980976b65164da73c7d127be0272dc55bb4d35127af515d4", false},
	{"sync-storage-uuid.js", "be52474ddd6ccb52b9e67d56c4a92da49e42e178eb24e19838fac2a0209a4b51", false},
	{"sync-storage.js", "526bf59ce753b89da5d96cf1a5a16540b686856684bc52eb79df411dae9a01bf", false},
	{"i18n.js", "ca2dbece1883165f5297382d24ca94456ebb92e68abf113c8789e74eb0f6c676", false},
	{"locales/en.json", "41647741780faa35490b35e676a6e49278559377f01a32cab89eede5e0b24085", false},
	{"locales/ar-XB.json", "24f101db121d782f354eeb35b6ae2e705391ee6fd3c9fece8fad33da1ae73711", false},
	{"app-runtime.js", "6a39b1c9554f98ba2a7c98d9b72fca837953b1e743c7726bf9c17811bcd00052", false},
	{"app-state.js", "fbde67c896eb733d8f8238d024f62ac1b3487e35cfe70a021b5329c3f6049eb8", false},
	{"app-storage.js", "ffd0933dbe5429f5f160b6a58b41eb1a7d8a0e184941689450ce9510a0cabee0", false},
	{"app-actions.js", "f8128a3021c31822fe277ae2939e37073dac780467cfd551f428f27e5fd1af18", false},
	{"app-sync.js", "8191f5cee2b1553a3edf052961ef7170d49e2f69aeb4ac9129f8c634f8297ed0", false},
	{"app-bootstrap.js", "114acd027375ac052ba97d45eb055b21af6aa92f4eee1a8cc5f285a875db5810", false},
	{"app-session.js", "c81d23363aead63afe6515b8e0bbf1df43d9bb01d47a77c018bbdcdef78a901f", false},
	{"app-view.js", "ca146d39f85663ecad55534ab4dda668e396aa97226480a3b91971532c1af71c", false},
	{"app.js", "157fac29860c5f98ea523c39d8b50849d78e4d532c23a94b39d8cca423919fbb", false},
	{"manifest.webmanifest", "56212a7cac1484e2bf9f48cfef67113577290a15dcb3ad082c7eedec6993cef2", false},
	{"icon.svg", "d04344ef9affa400fb6bbf287599dc479d14bdd6dfc907a80342d9b29be0333a", false},
	{"sw.js", "783e3d53a4e2079e3bc0c940d4e5f245dcae04af59bf7b329162f8284d203436", false},
	{"openapi.yaml", "3703a7be7d28d03ba52397b48a522fb0844a5e803517a1eb0361c448a9aed523", false},
}

func readinessKeyDigest(secret []byte) [sha256.Size]byte {
	return sha256.Sum256(secret)
}

func (s *Server) handleReady(w http.ResponseWriter, request *http.Request) {
	timeout := s.readinessTimeout
	if timeout <= 0 {
		timeout = readinessCheckTimeout
	}
	ctx, cancel := context.WithTimeout(request.Context(), timeout)
	defer cancel()
	if err := s.readiness(ctx); err != nil {
		code := readinessErrorCode(ctx, err)
		s.logger.Warn("readiness check failed", "code", code)
		// Report only the bounded code: raw readiness errors can carry paths.
		reportInternalErrorToErrorMonitoring(err, request, "readiness check "+code)
		writeJSON(w, request, http.StatusServiceUnavailable, readinessResponse{Status: "not_ready", Error: code})
		return
	}
	writeJSON(w, request, http.StatusOK, readinessResponse{Status: "ready"})
}

type readinessResponse struct {
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

func (s *Server) readiness(ctx context.Context) error {
	digest := readinessKeyDigest(s.cfg.AppSecret)
	if len(s.cfg.AppSecret) < 32 || s.codec == nil || !authn.EqualHash(digest[:], s.appSecretDigest[:]) {
		return readinessError("key_unavailable", errors.New("application key material is unavailable"))
	}
	if s.store == nil {
		return readinessError("storage_unavailable", errors.New("account storage is unavailable"))
	}
	if err := s.store.Ready(ctx); err != nil {
		return err
	}
	if err := s.validateReadinessAssets(ctx); err != nil {
		return err
	}
	return s.validateReadinessCore(ctx)
}

func (s *Server) validateReadinessAssets(ctx context.Context) error {
	info, err := os.Lstat(s.cfg.WebRoot)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return readinessError("web_unavailable", errors.New("web root is unavailable"))
	}
	root, err := os.OpenRoot(s.cfg.WebRoot)
	if err != nil {
		return readinessError("web_unavailable", errors.New("web root is unavailable"))
	}
	defer root.Close()
	for _, asset := range readinessAssets {
		if err := validateReadinessAsset(ctx, root, asset); err != nil {
			code := "web_unavailable"
			if asset.provenance {
				code = "core_provenance_invalid"
			}
			return readinessError(code, err)
		}
	}
	return nil
}

func validateReadinessAsset(ctx context.Context, root *os.Root, asset readinessAsset) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	info, err := root.Lstat(asset.name)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o444 == 0 ||
		info.Size() <= 0 || info.Size() > readinessAssetMaxBytes {
		return fmt.Errorf("required asset %s has invalid metadata", asset.name)
	}
	file, err := root.Open(asset.name)
	if err != nil {
		return fmt.Errorf("open required asset %s: %w", asset.name, err)
	}
	digest, readErr := readinessFileDigest(ctx, file)
	closeErr := file.Close()
	if readErr != nil || closeErr != nil {
		return fmt.Errorf("read required asset %s", asset.name)
	}
	if hex.EncodeToString(digest[:]) != asset.digest {
		return fmt.Errorf("required asset %s has invalid digest", asset.name)
	}
	return nil
}

func readinessFileDigest(ctx context.Context, reader io.Reader) ([sha256.Size]byte, error) {
	hash := sha256.New()
	buffer := make([]byte, 64*1024)
	limited := io.LimitReader(reader, readinessAssetMaxBytes+1)
	for {
		if err := ctx.Err(); err != nil {
			return [sha256.Size]byte{}, err
		}
		count, err := limited.Read(buffer)
		if count > 0 {
			_, _ = hash.Write(buffer[:count])
		}
		if errors.Is(err, io.EOF) {
			var digest [sha256.Size]byte
			copy(digest[:], hash.Sum(nil))
			return digest, nil
		}
		if err != nil {
			return [sha256.Size]byte{}, err
		}
	}
}

func (s *Server) validateReadinessCore(ctx context.Context) error {
	if s.readinessCore == nil {
		return readinessError("core_unavailable", errors.New("shared core runtime is unavailable"))
	}
	result, err := s.readinessCore.Call(ctx, "core.version", []byte(`{}`))
	if err != nil || len(result) > 4096 {
		return readinessError("core_unavailable", errors.New("shared core runtime probe failed"))
	}
	var envelope struct {
		OK    bool `json:"ok"`
		Value struct {
			SchemaVersion int    `json:"schemaVersion"`
			CoreVersion   string `json:"coreVersion"`
		} `json:"value"`
	}
	decoder := json.NewDecoder(bytes.NewReader(result))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&envelope) != nil || decoder.Decode(&struct{}{}) != io.EOF || !envelope.OK ||
		envelope.Value.SchemaVersion != 1 || envelope.Value.CoreVersion != readinessCoreVersion {
		return readinessError("core_unavailable", errors.New("shared core runtime identity is invalid"))
	}
	return nil
}

func readinessError(code string, err error) error {
	return &readinessFailure{code: code, err: err}
}

func readinessErrorCode(ctx context.Context, err error) string {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		return "check_timeout"
	}
	if errors.Is(ctx.Err(), context.Canceled) || errors.Is(err, context.Canceled) {
		return "check_canceled"
	}
	var failure *readinessFailure
	if errors.As(err, &failure) {
		return failure.code
	}
	return store.ReadinessErrorCode(err)
}
