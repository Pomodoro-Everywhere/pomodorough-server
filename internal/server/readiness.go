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
	readinessAssetMaxBytes = 4 << 20
	readinessCoreVersion   = "0.46.0"
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
	{"sentry-client.js", "e7fac5ffee247eb1c18103d07915ab0f919dafbef761b9cf616df2e5f8370843", false},
	{"app.html", "d2d7d6b65038032a1e30bd0bf7bdd9f513c69b615ec934aacc6497d3261e4308", false},
	{"app.css", "cf82c78181143beff051e65818c3b39e6f145ddd0b37af0b971e66a8ea8928b9", false},
	{"shared-core-metadata.js", readinessSharedCoreMetadataDigest, true},
	{"shared-core.js", "1217749ded7521a9be4a3e635d6b10fab32fca48dd5a033ffc0b5e255ece7e50", false},
	{"pomodorough_core.wasm", "55cbddc547933a75a4f20dbf46bbfab9f1274689c2f1a8b631af3e6d8a2815a4", true},
	{"sync-core.js", "d28eacbc08fb614c6d5d838f75beb34f9fa33b13ab4339fcd3facee2543a6fca", false},
	{"sync-authority.js", "56c505663ec47ad1980976b65164da73c7d127be0272dc55bb4d35127af515d4", false},
	{"sync-storage-uuid.js", "be52474ddd6ccb52b9e67d56c4a92da49e42e178eb24e19838fac2a0209a4b51", false},
	{"workspace-core.js", "a3e0281f194b3f761ac0b2726352902a80f36c7a2b3e4ac63a011a5603d040bb", false},
	{"workspace-transaction.js", "ef38040371afe408691d8e6d485dc233ed581a6eb53bdbafbfa037236c73d574", false},
	{"sync-storage.js", "a998fc1d7de9c39acb8f87c3428a279b756027ead415276e8f2572b6099ef7f7", false},
	{"i18n.js", "ca2dbece1883165f5297382d24ca94456ebb92e68abf113c8789e74eb0f6c676", false},
	{"locales/en.json", "44eeb4ecbf1b2a4cc685e7022de49e8d78aa734ab92821e573755a28a1e89427", false},
	{"locales/ar-XB.json", "b79f80785805f18168ad8f8562f97eb36e2f318264e44b746b87eaeec886e2a0", false},
	{"app-runtime.js", "76352fdbc3872145e236fa0e1a9a652cf00d6966116f9a8e16737aaee29d0c9d", false},
	{"account-operation.js", "10b7912df48b013b5ea0adc5dd71ac889f00f50a85c27039a15c6b065ec4ab33", false},
	{"app-state.js", "f5484a4fc5b299931f178eeed713679fe58293e1f3ed0668c54562fcb14bde20", false},
	{"app-storage.js", "9df1129ed571003d08a355f45ba4c44f6e3496ade49c2cd7ecb7cf704e8b8887", false},
	{"app-actions.js", "5d64eadcfd074746a48b5220c1706186b23e1b8f4481677ff24be05b904adab6", false},
	{"app-sync.js", "486bcf79ebd081c695db1c212be54425cd3144cdbdb055b6ee6b9c0a78cf63ae", false},
	{"app-bootstrap.js", "d9a1a54ef3aff014ff8ac250738fbe23b18e4d29dcddc0116edae37a71298e80", false},
	{"app-session.js", "017a552350715cdba992bb2b82931c52a9e4d488f82d3c09a879b914b24ffc6b", false},
	{"app-view.js", "d95be174324606a22dd61a3d1d0573470563fcd4105a644cdc5f8b4fb709e0b6", false},
	{"app.js", "65ad1e4684eb740ec3509baa1777fdb75de75c360694baf677aeb35a925320a3", false},
	{"manifest.webmanifest", "56212a7cac1484e2bf9f48cfef67113577290a15dcb3ad082c7eedec6993cef2", false},
	{"icon.svg", "d04344ef9affa400fb6bbf287599dc479d14bdd6dfc907a80342d9b29be0333a", false},
	{"sw.js", "40d2b6037ac15b178ca0ebfe577d6ad3c2bb7e19ed34daf8d7bccdc4d0b06d7e", false},
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
