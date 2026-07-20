package config

import (
	"strings"
	"testing"
)

func TestLoadRejectsShortAppSecret(t *testing.T) {
	setConfigEnvironment(t)
	t.Setenv("APP_SECRET", strings.Repeat("s", 31))
	if _, err := Load(); err == nil {
		t.Fatal("Load accepted a 31-byte APP_SECRET")
	}
}

func TestLoadRejectsInvalidPublicURL(t *testing.T) {
	tests := []string{
		"http://example.com",
		"https://user:password@example.com",
		"https://example.com/path",
		"https://example.com?query=value",
		"https://example.com/#fragment",
		"https:///missing-host",
	}
	for _, value := range tests {
		t.Run(value, func(t *testing.T) {
			setConfigEnvironment(t)
			t.Setenv("PUBLIC_URL", value)
			if _, err := Load(); err == nil {
				t.Fatalf("Load accepted invalid PUBLIC_URL %q", value)
			}
		})
	}
}

func TestAuthenticationRequiresCompleteConfiguration(t *testing.T) {
	tests := []Config{
		{GoogleWebClientID: "client"},
		{GoogleWebClientSecret: "secret"},
		{},
	}
	for _, cfg := range tests {
		if cfg.WebAuthEnabled() {
			t.Fatalf("WebAuthEnabled() = true for incomplete config %#v", cfg)
		}
	}
	if (Config{}).NativeAuthEnabled() {
		t.Fatal("NativeAuthEnabled() = true without client IDs")
	}
}
