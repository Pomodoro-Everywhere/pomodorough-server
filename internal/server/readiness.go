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
	readinessCoreVersion   = "0.57.0"
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
	{"index.html", "36247f56654cc54f8cc4aa11a8feb9c173258947bbe339fae79637cd37bcbe3e", false},
	{"privacy.html", "3e376d370a2c09a3ef8a7f46f444304722b1b27e162fd01411692923994ff89c", false},
	{"signed-out.html", "ff8bb3060db498e79c0dee7cd86b5f770882a5064b39d30e9dc5f9e70875fb5c", false},
	{"not-found.html", "7dd5ed06fad55a63c490420e6931b357f1b8a4c49217a4b6904d0ab6e578df63", false},
	{"landing.css", "93d12a85fa3cab3e6983224ac2ab2d8d0525a3780fdfb27678184786a33d33d2", false},
	{"platform-selector.js", "e53063090e5bbcdb8aa771c251c8226a023414154e1f4b22c2d4f510188e3e7d", false},
	{"landing.js", "ab72f95f879d25b6a45dc6c1f4e8fe1d9091ce3bd42ff272b233fa12a41ab3dc", false},
	{"sentry-client.js", "caa4f9f8051ce925d45ab9cf326b7dabac3f5b7e4174e445e88bb7a5ed64c9a6", false},
	{"app.html", "1550f72e96160971743a13f931f416b9be70a874300679af0880e4eddfda797a", false},
	{"app.css", "ce40e9be6483fd8e3c31d40c7669f8e6151b9e72176312a720584f06bac6169a", false},
	{"shared-core-metadata.js", readinessSharedCoreMetadataDigest, true},
	{"shared-core.js", "1217749ded7521a9be4a3e635d6b10fab32fca48dd5a033ffc0b5e255ece7e50", false},
	{"pomodorough_core.wasm", "2699e1eaad02fa6819fdd9ef5452b51965a046c326543f4feca9eb2ecfe07789", true},
	{"sync-core.js", "b4d49da7537e0858d5e93964f7121324cf0608332bcf5f4505fb382dcf24f3d4", false},
	{"sync-authority.js", "56c505663ec47ad1980976b65164da73c7d127be0272dc55bb4d35127af515d4", false},
	{"sync-storage-uuid.js", "be52474ddd6ccb52b9e67d56c4a92da49e42e178eb24e19838fac2a0209a4b51", false},
	{"workspace-core.js", "a3e0281f194b3f761ac0b2726352902a80f36c7a2b3e4ac63a011a5603d040bb", false},
	{"workspace-transaction.js", "ef38040371afe408691d8e6d485dc233ed581a6eb53bdbafbfa037236c73d574", false},
	{"sync-storage.js", "780180056d6492a26ec4b1656b2194cfa6360e45392c922d2a55df5ee7bb3f3a", false},
	{"i18n.js", "b269061572d1502460fc6ca514f483ba01370ecd065ea79a13d64d66ea9f902c", false},
	{"locales/en.json", "3c4ee0a6baee374ceea1d2c81d5e803830e4e4174238c93003dbf95d4f09427f", false},
	{"locales/ar-XB.json", "179a18ef626a6a01adbcceac27e66006a0d4ad39fd989be8bbf7a236fe9f3018", false},
	{"app-runtime.js", "8193392c8dd148a709935a3fa76f020fe84afcb93a6ae0aa5a195d978377b351", false},
	{"account-operation.js", "10b7912df48b013b5ea0adc5dd71ac889f00f50a85c27039a15c6b065ec4ab33", false},
	{"app-state.js", "40765839f8b63dc30e9e0687b78954f710a58f33b22d45de8e740a6617b3ebff", false},
	{"app-storage.js", "91be8bd0cf9ae3c1df37f3acd6d6f39cb6bdfaa3dd1e7f97716700908dce36f3", false},
	{"app-actions.js", "28ccc7b9171c6a128ff0d0446d08114c9f05adfdff4650ab2f8b0a53831c6aab", false},
	{"app-sync.js", "00b8f47ef4153ab14e24d9ef4862e064ff3c0130526077943f2cdc15d8bb76cc", false},
	{"app-bootstrap.js", "9e1600457f7dbb14c256b47a99da2581cda43428504be07bb8159334bea7fb36", false},
	{"app-session.js", "9dd688f5dc006e1573ec9323d9a6a4887ba23d611b80dc36da02c6f29c941570", false},
	{"app-view.js", "eb4254883e147a928a64d84629d236ef22d5137f2b25e2563e780f5594a35322", false},
	{"app.js", "66aa47641a813fb683ae85dee7cfc90b25810b1f0d0f6a7069866eb61d1e438d", false},
	{"manifest.webmanifest", "56212a7cac1484e2bf9f48cfef67113577290a15dcb3ad082c7eedec6993cef2", false},
	{"icon.svg", "d04344ef9affa400fb6bbf287599dc479d14bdd6dfc907a80342d9b29be0333a", false},
	{"sw.js", "bf3d462278bf1fc55c42393aa4e13492b8ed6a5665330a6369a00db03ac0d7ed", false},
	{"openapi.yaml", "71cbe5772ddb5c990a94c7fec556a20d35f2f99969d2c4f7ab6e1eaaf4b59284", false},
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
