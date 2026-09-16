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
	readinessCoreVersion   = "0.41.0"
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
	{"index.html", "4ac05e8b6a1beb61efe3a426b17cbcd151c369167ac92433cfdf18427950a438", false},
	{"privacy.html", "37331b4b5c4bbbc8d78535b519885e3556f4db00e9eb31f5a6eb6b2b5abd3643", false},
	{"landing.css", "510c82512246cfb2bb4db1660cfe70b33bd27e8826433ed5d60c947f79904b11", false},
	{"platform-selector.js", "e53063090e5bbcdb8aa771c251c8226a023414154e1f4b22c2d4f510188e3e7d", false},
	{"landing.js", "69456dfbb496ce84df451daa89ddbca2933ccaa4d42c0d159ca689727713266f", false},
	{"sentry-client.js", "a44ce143273fe41b4d4bf359bfaaf095346e54f06463bb761c6f3f040a987a53", false},
	{"app.html", "688bcc765b79f58837412d208666f5445e838fb0fe228089638c635586a2da93", false},
	{"app.css", "9e2cd4d8da535919ab91a46b8c840e7f5dea0d5a6e1951ae434bb63f9ecb69df", false},
	{"shared-core-metadata.js", readinessSharedCoreMetadataDigest, true},
	{"shared-core.js", "06bd18d37625c53ce6c57186476748a231a1da28b89d8e869683e5da9f2a5b98", false},
	{"pomodorough_core.wasm", "0c6bb71dfb5949e1fe9c3d4adcc8151b99607ad24545b5d1b2fc00ae8d359a74", true},
	{"sync-core.js", "dbdf85af88fa6f9381efd10b259d07318a133381e5d0abe897298672aabc3122", false},
	{"sync-authority.js", "56c505663ec47ad1980976b65164da73c7d127be0272dc55bb4d35127af515d4", false},
	{"sync-storage-uuid.js", "be52474ddd6ccb52b9e67d56c4a92da49e42e178eb24e19838fac2a0209a4b51", false},
	{"sync-storage.js", "526bf59ce753b89da5d96cf1a5a16540b686856684bc52eb79df411dae9a01bf", false},
	{"i18n.js", "ca2dbece1883165f5297382d24ca94456ebb92e68abf113c8789e74eb0f6c676", false},
	{"locales/en.json", "6121117577df42749ccf3c1885ad5788dcc8f8404b15cc9c5d6a2d4f0b36f1df", false},
	{"locales/ar-XB.json", "5989c8330ae9a62f306c156b93a27e557e39e5584e3c84793333ead587c1218c", false},
	{"app-runtime.js", "76352fdbc3872145e236fa0e1a9a652cf00d6966116f9a8e16737aaee29d0c9d", false},
	{"app-state.js", "fbde67c896eb733d8f8238d024f62ac1b3487e35cfe70a021b5329c3f6049eb8", false},
	{"app-storage.js", "63b7de714fdeec1204f8e28ce053e21b7388f8bdcd808d40267bfa4f1cec61e9", false},
	{"app-actions.js", "f7f974f650aa1359fbf495aab939f021ac4e583ef2f78fc04c91f23cc9c2e0bc", false},
	{"app-sync.js", "250bb2265ad07ee85645a9959a7c3e844979bf788265b62eee075b270493690f", false},
	{"app-bootstrap.js", "b1a17445a1ffcb253fb2798dfee4a1b5ffeb4a41f692571f06eabfb26ea3b8f4", false},
	{"app-session.js", "db83cacca58fda8a8cd42f8ea9eb9f13875e87dcab363d48beaa385ce8efbe21", false},
	{"app-view.js", "60bd156a7a30dc9c3f758bf508a885b547c7a5134109bc41a4c5abef39786270", false},
	{"app.js", "83c448e81d51fbd96b855d381e5be7b7a1bf9eb71d3483a1eb5391ab58dc3bd7", false},
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
			if _, writeErr := hash.Write(buffer[:count]); writeErr != nil {
				return [sha256.Size]byte{}, writeErr
			}
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
