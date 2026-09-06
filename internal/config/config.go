package config

import (
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const defaultPublicURL = "https://pomodorough.egigoka.me"

type Config struct {
	ListenAddr              string
	DataDir                 string
	DeletionLedgerDir       string
	WebRoot                 string
	PublicURL               string
	AppSecret               []byte
	GoogleWebClientID       string
	GoogleWebClientSecret   string
	GoogleNativeClientIDs   []string
	GoogleNativeClientIDSet map[string]struct{}
	SentryDSN               string
	SentryWebDSN            string
	TrustedProxyCIDRs       []netip.Prefix
	TrustedProxyHops        int
}

func Load() (Config, error) {
	cfg := Config{
		ListenAddr:            envOr("LISTEN_ADDR", "127.0.0.1:8790"),
		DataDir:               envOr("DATA_DIR", "/var/lib/pomodorough"),
		DeletionLedgerDir:     strings.TrimSpace(os.Getenv("DELETION_LEDGER_DIR")),
		WebRoot:               envOr("WEB_ROOT", "/etc/pomodorough/web"),
		PublicURL:             envOr("PUBLIC_URL", defaultPublicURL),
		AppSecret:             []byte(os.Getenv("APP_SECRET")),
		GoogleWebClientID:     strings.TrimSpace(os.Getenv("GOOGLE_WEB_CLIENT_ID")),
		GoogleWebClientSecret: strings.TrimSpace(os.Getenv("GOOGLE_WEB_CLIENT_SECRET")),
		SentryDSN:             strings.TrimSpace(os.Getenv("SENTRY_DSN")),
		SentryWebDSN:          strings.TrimSpace(os.Getenv("SENTRY_DSN_WEB")),
	}
	if len(cfg.AppSecret) < 32 {
		return Config{}, errors.New("APP_SECRET must contain at least 32 bytes")
	}
	if err := normalizeOriginsAndPaths(&cfg); err != nil {
		return Config{}, err
	}
	trustedCIDRs, trustedHops, err := trustedProxySettings()
	if err != nil {
		return Config{}, err
	}
	cfg.TrustedProxyCIDRs = trustedCIDRs
	cfg.TrustedProxyHops = trustedHops
	cfg.GoogleNativeClientIDs, cfg.GoogleNativeClientIDSet = nativeClientIDs()
	return cfg, nil
}

func trustedProxySettings() ([]netip.Prefix, int, error) {
	rawCIDRs := strings.TrimSpace(os.Getenv("TRUSTED_PROXY_CIDRS"))
	rawHops := strings.TrimSpace(os.Getenv("TRUSTED_PROXY_HOPS"))
	if rawCIDRs == "" && rawHops == "" {
		return nil, 0, nil
	}
	if rawCIDRs == "" || rawHops == "" {
		return nil, 0, errors.New("TRUSTED_PROXY_CIDRS and TRUSTED_PROXY_HOPS must be configured together")
	}
	hops, err := strconv.Atoi(rawHops)
	if err != nil || hops < 1 || hops > 16 {
		return nil, 0, errors.New("TRUSTED_PROXY_HOPS must be an integer from 1 to 16")
	}
	cidrs, err := parseTrustedProxyCIDRs(rawCIDRs)
	if err != nil {
		return nil, 0, err
	}
	return cidrs, hops, nil
}

func parseTrustedProxyCIDRs(raw string) ([]netip.Prefix, error) {
	cidrs := make([]netip.Prefix, 0)
	seen := make(map[netip.Prefix]struct{})
	for _, item := range strings.Split(raw, ",") {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(item))
		if err != nil {
			return nil, fmt.Errorf("parse TRUSTED_PROXY_CIDRS entry %q: %w", item, err)
		}
		prefix = prefix.Masked()
		if _, exists := seen[prefix]; exists {
			continue
		}
		seen[prefix] = struct{}{}
		cidrs = append(cidrs, prefix)
	}
	return cidrs, nil
}

func normalizeOriginsAndPaths(cfg *Config) error {
	publicURL, err := url.Parse(cfg.PublicURL)
	if err != nil || publicURL.Scheme != "https" || publicURL.Host == "" || publicURL.User != nil || publicURL.RawQuery != "" || publicURL.Fragment != "" || (publicURL.Path != "" && publicURL.Path != "/") {
		return errors.New("PUBLIC_URL must be an HTTPS origin without path, query, or fragment")
	}
	cfg.PublicURL = strings.TrimSuffix(cfg.PublicURL, "/")
	if cfg.DataDir, err = filepath.Abs(cfg.DataDir); err != nil {
		return fmt.Errorf("resolve DATA_DIR: %w", err)
	}
	if cfg.DeletionLedgerDir == "" {
		cfg.DeletionLedgerDir = cfg.DataDir + "-deletion-ledger"
	} else if cfg.DeletionLedgerDir, err = filepath.Abs(cfg.DeletionLedgerDir); err != nil {
		return fmt.Errorf("resolve DELETION_LEDGER_DIR: %w", err)
	}
	if err := validateLedgerLocation(cfg.DataDir, cfg.DeletionLedgerDir); err != nil {
		return err
	}
	if cfg.WebRoot, err = filepath.Abs(cfg.WebRoot); err != nil {
		return fmt.Errorf("resolve WEB_ROOT: %w", err)
	}
	return nil
}

func validateLedgerLocation(dataDir, ledgerDir string) error {
	relative, err := filepath.Rel(dataDir, ledgerDir)
	if err != nil {
		return fmt.Errorf("compare DELETION_LEDGER_DIR with DATA_DIR: %w", err)
	}
	if relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))) {
		return errors.New("DELETION_LEDGER_DIR must be outside DATA_DIR")
	}
	return nil
}

func nativeClientIDs() ([]string, map[string]struct{}) {
	ids := []string{}
	idSet := make(map[string]struct{})
	for _, item := range strings.Split(os.Getenv("GOOGLE_NATIVE_CLIENT_IDS"), ",") {
		id := strings.TrimSpace(item)
		if id == "" {
			continue
		}
		if _, exists := idSet[id]; exists {
			continue
		}
		idSet[id] = struct{}{}
		ids = append(ids, id)
	}
	return ids, idSet
}

func (c Config) WebAuthEnabled() bool {
	return c.GoogleWebClientID != "" && c.GoogleWebClientSecret != ""
}

func (c Config) NativeAuthEnabled() bool {
	return len(c.GoogleNativeClientIDs) > 0
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}
