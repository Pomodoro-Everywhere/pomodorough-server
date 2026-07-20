package config

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestLoadValidConfiguration(t *testing.T) {
	setConfigEnvironment(t)
	t.Setenv("LISTEN_ADDR", " 0.0.0.0:9000 ")
	t.Setenv("DATA_DIR", "var/data")
	t.Setenv("WEB_ROOT", "public")
	t.Setenv("PUBLIC_URL", "https://example.com/")
	t.Setenv("GOOGLE_WEB_CLIENT_ID", " web-client ")
	t.Setenv("GOOGLE_WEB_CLIENT_SECRET", " web-secret ")
	t.Setenv("GOOGLE_NATIVE_CLIENT_IDS", " ios-client, android-client, ios-client,  ")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	dataDir, err := filepath.Abs("var/data")
	if err != nil {
		t.Fatal(err)
	}
	webRoot, err := filepath.Abs("public")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ListenAddr != "0.0.0.0:9000" || cfg.DataDir != dataDir || cfg.WebRoot != webRoot {
		t.Fatalf("resolved paths or address mismatch: %#v", cfg)
	}
	if cfg.PublicURL != "https://example.com" {
		t.Fatalf("PublicURL = %q, want normalized origin", cfg.PublicURL)
	}
	if cfg.GoogleWebClientID != "web-client" || cfg.GoogleWebClientSecret != "web-secret" || !cfg.WebAuthEnabled() {
		t.Fatalf("web authentication configuration mismatch: %#v", cfg)
	}
	wantNative := []string{"ios-client", "android-client"}
	if !reflect.DeepEqual(cfg.GoogleNativeClientIDs, wantNative) || !cfg.NativeAuthEnabled() {
		t.Fatalf("native client IDs = %#v, want %#v", cfg.GoogleNativeClientIDs, wantNative)
	}
	for _, id := range wantNative {
		if _, ok := cfg.GoogleNativeClientIDSet[id]; !ok {
			t.Fatalf("native client ID set missing %q", id)
		}
	}
}

func TestLoadUsesDefaultsForBlankOptionalValues(t *testing.T) {
	setConfigEnvironment(t)

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ListenAddr != "127.0.0.1:8790" || cfg.DataDir != "/var/lib/pomodorough" || cfg.WebRoot != "/etc/pomodorough/web" {
		t.Fatalf("defaults mismatch: %#v", cfg)
	}
	if cfg.PublicURL != defaultPublicURL {
		t.Fatalf("PublicURL = %q, want %q", cfg.PublicURL, defaultPublicURL)
	}
	if cfg.WebAuthEnabled() || cfg.NativeAuthEnabled() {
		t.Fatalf("authentication unexpectedly enabled: %#v", cfg)
	}
}

func setConfigEnvironment(t *testing.T) {
	t.Helper()
	t.Setenv("APP_SECRET", strings.Repeat("s", 32))
	for _, name := range []string{
		"LISTEN_ADDR", "DATA_DIR", "WEB_ROOT", "PUBLIC_URL", "GOOGLE_WEB_CLIENT_ID",
		"GOOGLE_WEB_CLIENT_SECRET", "GOOGLE_NATIVE_CLIENT_IDS",
	} {
		t.Setenv(name, "")
	}
}
