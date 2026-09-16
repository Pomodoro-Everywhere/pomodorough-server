package main

import (
	"testing"
)

func TestErrorMonitoringReleaseNamesBuildVersion(t *testing.T) {
	identity := buildIdentity{version: "0.14.0", commit: "0123456789abcdef0123456789abcdef01234567"}
	if got := errorMonitoringRelease(identity); got != "pomodorough@0.14.0" {
		t.Fatalf("errorMonitoringRelease = %q, want pomodorough@0.14.0", got)
	}
}

func TestInitErrorMonitoringStaysDisabledWithoutDSN(t *testing.T) {
	identity := buildIdentity{version: "development", commit: "unknown"}
	flush := initErrorMonitoring(identity, "", testLogger())
	if flush == nil {
		t.Fatal("initErrorMonitoring without DSN returned nil flush")
	}
	flush()
}

func TestInitErrorMonitoringSurvivesInvalidDSN(t *testing.T) {
	identity := buildIdentity{version: "development", commit: "unknown"}
	flush := initErrorMonitoring(identity, "://malformed-dsn", testLogger())
	if flush == nil {
		t.Fatal("initErrorMonitoring with invalid DSN returned nil flush")
	}
	flush()
}

func TestErrorMonitoringEnvironmentHonorsEnv(t *testing.T) {
	cases := []struct {
		name  string
		value string
		set   bool
		want  string
	}{
		{"default", "", false, "production"},
		{"explicit", "staging", true, "staging"},
		{"trimmed", "  production-eu  ", true, "production-eu"},
		{"blank falls back", "   ", true, "production"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.set {
				t.Setenv("SENTRY_ENVIRONMENT", tc.value)
			}
			if got := errorMonitoringEnvironment(); got != tc.want {
				t.Fatalf("errorMonitoringEnvironment = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestErrorMonitoringBlockedInTests(t *testing.T) {
	original := sentryInTest
	defer func() { sentryInTest = original }()
	cases := []struct {
		name   string
		inTest bool
		allow  string
		want   bool
	}{
		{"blocks under go test", true, "", true},
		{"blocks explicit zero", true, "0", true},
		{"opt-in allows", true, "1", false},
		{"production untouched", false, "", false},
		{"production opt-in untouched", false, "1", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sentryInTest = func() bool { return tc.inTest }
			t.Setenv("SENTRY_ALLOW_IN_TESTS", tc.allow)
			if got := errorMonitoringBlockedInTests(); got != tc.want {
				t.Fatalf("errorMonitoringBlockedInTests = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestInitErrorMonitoringNoopsInTestsWithoutOptIn(t *testing.T) {
	identity := buildIdentity{version: "development", commit: "unknown"}
	flush := initErrorMonitoring(identity, "https://backend-key@o1.ingest.sentry.io/1", testLogger())
	if flush == nil {
		t.Fatal("initErrorMonitoring under go test returned nil flush")
	}
	flush()
}
