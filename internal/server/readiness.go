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
	readinessCoreVersion   = "0.53.0"
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
	{"index.html", "72954424049a302ad288acf8cf4cc9f75d14be9fedcbfa7edc7e7127448a8aa2", false},
	{"privacy.html", "65ebff33710f5322d0e63d57de9f7ceec79e58ec5de964d587c3edce2fde6fa3", false},
	{"landing.css", "b70b369419fbc6476cd5a04ff3155b320dd00bcb148bafc4948b2860675c9086", false},
	{"platform-selector.js", "e53063090e5bbcdb8aa771c251c8226a023414154e1f4b22c2d4f510188e3e7d", false},
	{"landing.js", "69456dfbb496ce84df451daa89ddbca2933ccaa4d42c0d159ca689727713266f", false},
	{"sentry-client.js", "383f010651e1fc010e25b7c6ba10a12a13f781acdb5bc44ec2be32b90c638d3f", false},
	{"app.html", "e6aa010c4cb922303edbe913a836938fbb584e1c4579acc7d39700f3e2598cae", false},
	{"app.css", "202bcbb141cc8717715a1cc30ad5a2aba9ff9817acdd5395bb5c883b42ccd389", false},
	{"shared-core-metadata.js", readinessSharedCoreMetadataDigest, true},
	{"shared-core.js", "1217749ded7521a9be4a3e635d6b10fab32fca48dd5a033ffc0b5e255ece7e50", false},
	{"pomodorough_core.wasm", "1e72c2bbc178b077fdcc98210f06f66f4bc5332b77be5de83be19792376f4bd4", true},
	{"sync-core.js", "cb2e919e9552db0e61ce5f29612d5fa112a8e8212a03ddca4771b70a51188a37", false},
	{"sync-authority.js", "56c505663ec47ad1980976b65164da73c7d127be0272dc55bb4d35127af515d4", false},
	{"sync-storage-uuid.js", "be52474ddd6ccb52b9e67d56c4a92da49e42e178eb24e19838fac2a0209a4b51", false},
	{"workspace-core.js", "a3e0281f194b3f761ac0b2726352902a80f36c7a2b3e4ac63a011a5603d040bb", false},
	{"workspace-transaction.js", "ef38040371afe408691d8e6d485dc233ed581a6eb53bdbafbfa037236c73d574", false},
	{"sync-storage.js", "d6f492f4a9f69ce625061f546cc81cdc02c0b9842440aa1dadb1d7c43f974e35", false},
	{"i18n.js", "62013592ff91959a21b057d3e4f4de235bd7843e299f10c32ab62c0bfaf92761", false},
	{"locales/en.json", "d50e689f7bf9097545f262a79ecbf14f576609fbbe6bed927c0d0c9ec18d0686", false},
	{"locales/ar-XB.json", "8f3670d61aca80056e71d429f68b68d5fe05a460d8b82432e82c63fbdd79bd51", false},
	{"app-runtime.js", "8193392c8dd148a709935a3fa76f020fe84afcb93a6ae0aa5a195d978377b351", false},
	{"account-operation.js", "10b7912df48b013b5ea0adc5dd71ac889f00f50a85c27039a15c6b065ec4ab33", false},
	{"app-state.js", "b359014f327149eb9a3d79c1f11ca07a119188c03b94dbcbcbbf6db30349e22e", false},
	{"app-storage.js", "9df1129ed571003d08a355f45ba4c44f6e3496ade49c2cd7ecb7cf704e8b8887", false},
	{"app-actions.js", "5d64eadcfd074746a48b5220c1706186b23e1b8f4481677ff24be05b904adab6", false},
	{"app-sync.js", "486bcf79ebd081c695db1c212be54425cd3144cdbdb055b6ee6b9c0a78cf63ae", false},
	{"app-bootstrap.js", "2c8c003279110b3dd7900b3962ed403118550bd1561f17996cf9b29532963e75", false},
	{"app-session.js", "0cc4029babdd6d4c425c86796aca3ebcef0425336ced8f17d5408ee40396ed07", false},
	{"app-view.js", "733470de1e0d38f0a96125c66301f8cb68ad687beef8059b5d7390ae80733de3", false},
	{"app.js", "8af399df27f6bf3181f7d2a17873c821b99e90ec973779e368a1c0b4a212d236", false},
	{"manifest.webmanifest", "56212a7cac1484e2bf9f48cfef67113577290a15dcb3ad082c7eedec6993cef2", false},
	{"icon.svg", "d04344ef9affa400fb6bbf287599dc479d14bdd6dfc907a80342d9b29be0333a", false},
	{"sw.js", "d6cdc219fc667916eedae1b048a8d5e61af78c56b91ea6b167ad754b63d3fae2", false},
	{"openapi.yaml", "a3e13e788039ac2de6288e10b3baff0a70b6c3e1f673654aadae44e8073895a8", false},
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
