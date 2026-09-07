package config

import (
	"testing"
)

func TestLoadRejectsInvalidSentryDSN(t *testing.T) {
	invalid := []string{
		"http://key@o1.ingest.sentry.io/1",
		"%POMODOROUGH_SENTRY_DSN%",
		"not a dsn",
		"https://key@o1.ingest.sentry.io/1\"><script>",
		"https://key@o1.ingest.sentry.io/",
		"https://@o1.ingest.sentry.io/1",
	}
	for _, value := range invalid {
		t.Run(value, func(t *testing.T) {
			setConfigEnvironment(t)
			t.Setenv("SENTRY_DSN", value)
			t.Setenv("SENTRY_DSN_WEB", value)
			if _, err := Load(); err == nil {
				t.Fatalf("Load accepted invalid Sentry DSN %q", value)
			}
		})
	}
}

func TestLoadAcceptsEmptyAndValidSentryDSN(t *testing.T) {
	setConfigEnvironment(t)
	t.Setenv("SENTRY_DSN", "")
	t.Setenv("SENTRY_DSN_WEB", "")
	if _, err := Load(); err != nil {
		t.Fatalf("Load rejected empty DSNs: %v", err)
	}
	setConfigEnvironment(t)
	t.Setenv("SENTRY_DSN", "https://backend-key@o1.ingest.sentry.io/1")
	t.Setenv("SENTRY_DSN_WEB", "https://web-key@o1.ingest.sentry.io/2")
	if _, err := Load(); err != nil {
		t.Fatalf("Load rejected valid DSNs: %v", err)
	}
}
