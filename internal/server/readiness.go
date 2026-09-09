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
	readinessCoreVersion   = "0.22.0"
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
	{"index.html", "a30f5f689c2d831cc50112854f40361d132dd8484d80af9732aed570f893b9a4", false},
	{"privacy.html", "37331b4b5c4bbbc8d78535b519885e3556f4db00e9eb31f5a6eb6b2b5abd3643", false},
	{"landing.css", "4d42859c8f0bc575055f3099b79f0a6d3862a966e8aa955d49933328e4cf86ba", false},
	{"platform-selector.js", "e53063090e5bbcdb8aa771c251c8226a023414154e1f4b22c2d4f510188e3e7d", false},
	{"landing.js", "51568abe1282e9578d0709a447868df7d9956c98945543f1e98e28c1a5d68b66", false},
	{"sentry-client.js", "a9a77386c8539597b2ddc0dcdfb04886a6baf97343fe172cbbc7532f40ada42e", false},
	{"app.html", "f904f8e66fca44ae957455da42c4aff1c784364b4fa3760ad8f4b147bbe572a0", false},
	{"app.css", "98a518584f823ceba56e612a756912b97f7f4607d255f79db5e4863bfede5297", false},
	{"shared-core-metadata.js", readinessSharedCoreMetadataDigest, true},
	{"shared-core.js", "da463bfa117c404587d6009f426077898655df0cf620cdc145b1859b1e4b3461", false},
	{"pomodorough_core.wasm", "f119e7d374e33e1ad2822554ebf93c836263c9b81bae2480b20523aeefa6a55e", true},
	{"sync-core.js", "22df0bae998505f4ef6c9e399ff845c96bf0c30ad9f937ef19aa4b03c69b5739", false},
	{"sync-authority.js", "56c505663ec47ad1980976b65164da73c7d127be0272dc55bb4d35127af515d4", false},
	{"sync-storage-uuid.js", "be52474ddd6ccb52b9e67d56c4a92da49e42e178eb24e19838fac2a0209a4b51", false},
	{"sync-storage.js", "8edfec5cb309202cb20a9974e67ab00e85c0ce5cea38325000730b7d3da3bef4", false},
	{"i18n.js", "ca2dbece1883165f5297382d24ca94456ebb92e68abf113c8789e74eb0f6c676", false},
	{"locales/en.json", "ffb966cbe3f9c9ad86e23459e3d8184e455d8a7911a9386c7ab5f1257d839dfd", false},
	{"locales/ar-XB.json", "20deded20dff83fe27d035f78ece2322145caf542ec161161ed93d7429ae51fe", false},
	{"app-runtime.js", "6a39b1c9554f98ba2a7c98d9b72fca837953b1e743c7726bf9c17811bcd00052", false},
	{"app-state.js", "409eb06f5ecdb2e4959da956d0542591505309dd0c3dcd0f23c4a43801f7c7e3", false},
	{"app-storage.js", "9c577c586948096be43632305b851539778795132e1cdfe6b08c849e7117cfe7", false},
	{"app-actions.js", "cb1634375368d7b1016026c2136fcb52355ebfd8e5b1a0dfdfc6f2d21603067b", false},
	{"app-sync.js", "9d5640baeb9eaf269b2dba1a21d686335f99ac87446b81478ffc536f5a3a05f1", false},
	{"app-bootstrap.js", "08f17448ba35fe4bc1c74febe20d2d59e0d57da6e842bb2cb058354031a63e7b", false},
	{"app-session.js", "4184b9bd4c418b845a1af1730caa085d4d7147f5a22b8cbf8314ae1847345f55", false},
	{"app-view.js", "b2a2f2c0c27697b2f73f992390781a7264c71ce8a8522bf05dd44e96aac807b3", false},
	{"app.js", "ebcdba391080213410593e9e0c937fb444d734aa704e2d78df934fad3536f572", false},
	{"manifest.webmanifest", "56212a7cac1484e2bf9f48cfef67113577290a15dcb3ad082c7eedec6993cef2", false},
	{"icon.svg", "d04344ef9affa400fb6bbf287599dc479d14bdd6dfc907a80342d9b29be0333a", false},
	{"sw.js", "bfcb79f75aa9fab8ef2dec46d5639fa0198578767cf814af9b22ca3c6791ca48", false},
	{"openapi.yaml", "8a5db31a006cecf6ec857f938fb0903dd90f13a9a43fa5933cec8132faec2a49", false},
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
