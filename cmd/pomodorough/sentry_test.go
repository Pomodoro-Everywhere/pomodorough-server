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
