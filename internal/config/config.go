package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const defaultPublicURL = "https://pomodorough.egigoka.me"

type Config struct {
	ListenAddr              string
	DataDir                 string
	WebRoot                 string
	PublicURL               string
	AppSecret               []byte
	GoogleWebClientID       string
	GoogleWebClientSecret   string
	GoogleNativeClientIDs   []string
	GoogleNativeClientIDSet map[string]struct{}
}

func Load() (Config, error) {
	cfg := Config{
		ListenAddr:            envOr("LISTEN_ADDR", "127.0.0.1:8790"),
		DataDir:               envOr("DATA_DIR", "/var/lib/pomodorough"),
		WebRoot:               envOr("WEB_ROOT", "/etc/pomodorough/web"),
		PublicURL:             envOr("PUBLIC_URL", defaultPublicURL),
		AppSecret:             []byte(os.Getenv("APP_SECRET")),
		GoogleWebClientID:     strings.TrimSpace(os.Getenv("GOOGLE_WEB_CLIENT_ID")),
		GoogleWebClientSecret: strings.TrimSpace(os.Getenv("GOOGLE_WEB_CLIENT_SECRET")),
	}
	if len(cfg.AppSecret) < 32 {
		return Config{}, errors.New("APP_SECRET must contain at least 32 bytes")
	}

	publicURL, err := url.Parse(cfg.PublicURL)
	if err != nil || publicURL.Scheme != "https" || publicURL.Host == "" || publicURL.User != nil || publicURL.RawQuery != "" || publicURL.Fragment != "" || (publicURL.Path != "" && publicURL.Path != "/") {
		return Config{}, errors.New("PUBLIC_URL must be an HTTPS origin without path, query, or fragment")
	}
	cfg.PublicURL = strings.TrimSuffix(cfg.PublicURL, "/")

	if cfg.DataDir, err = filepath.Abs(cfg.DataDir); err != nil {
		return Config{}, fmt.Errorf("resolve DATA_DIR: %w", err)
	}
	if cfg.WebRoot, err = filepath.Abs(cfg.WebRoot); err != nil {
		return Config{}, fmt.Errorf("resolve WEB_ROOT: %w", err)
	}

	cfg.GoogleNativeClientIDSet = make(map[string]struct{})
	for _, item := range strings.Split(os.Getenv("GOOGLE_NATIVE_CLIENT_IDS"), ",") {
		id := strings.TrimSpace(item)
		if id == "" {
			continue
		}
		if _, exists := cfg.GoogleNativeClientIDSet[id]; exists {
			continue
		}
		cfg.GoogleNativeClientIDSet[id] = struct{}{}
		cfg.GoogleNativeClientIDs = append(cfg.GoogleNativeClientIDs, id)
	}
	return cfg, nil
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
