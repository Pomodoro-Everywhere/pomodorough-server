package main

import (
	"bytes"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const s7Commit = "0123456789abcdef0123456789abcdef01234567"

func TestS7BuildIdentityAcceptsSemVer20(t *testing.T) {
	versions := []string{
		"0.0.0",
		"1.2.3-rc.1",
		"1.2.3+build.7",
		"1.2.3-0.3.7",
		"1.2.3-x.7.z.92+exp.sha.5114f85",
		"1.2.3-01A+001",
		"1.2.3+" + s7Commit,
	}
	for _, candidate := range versions {
		identity, err := parseBuildIdentity(candidate, s7Commit)
		if err != nil {
			t.Fatalf("parseBuildIdentity(%q) error = %v", candidate, err)
		}
		want := "pomodorough version=" + candidate + " commit=" + s7Commit
		if identity.String() != want {
			t.Fatalf("identity.String() = %q, want %q", identity.String(), want)
		}
	}
}

func TestS7BuildIdentityRejectsMalformedSemVer(t *testing.T) {
	versions := []string{
		"", "v1.2.3", "01.2.3", "1.02.3", "1.2.03", "1.2",
		"1.2.3-", "1.2.3+", "1.2.3-01", "1.2.3-alpha..1",
		"1.2.3+build..7", "1.2.3-alpha_1", "1.2.3+build_1", "1.2.3-rc 1",
	}
	for _, candidate := range versions {
		if _, err := parseBuildIdentity(candidate, s7Commit); err == nil {
			t.Fatalf("parseBuildIdentity(%q) accepted malformed SemVer", candidate)
		}
	}
}

func TestS7BuildIdentityRejectsIncompletePairs(t *testing.T) {
	tests := [][2]string{
		{"development", s7Commit},
		{"1.2.3", ""},
		{"1.2.3", s7Commit[:39]},
		{"1.2.3", strings.ToUpper(s7Commit)},
	}
	for _, test := range tests {
		if _, err := parseBuildIdentity(test[0], test[1]); err == nil {
			t.Fatalf("parseBuildIdentity(%q, %q) accepted incomplete pair", test[0], test[1])
		}
	}
	if identity, err := parseBuildIdentity("development", "unknown"); err != nil || identity.String() != "pomodorough version=development commit=unknown" {
		t.Fatalf("development identity = %q, error = %v", identity.String(), err)
	}
}

func TestS7VersionRequestIsExact(t *testing.T) {
	if !isVersionRequest([]string{"--version"}) {
		t.Fatal("exact --version was not recognized")
	}
	for _, args := range [][]string{nil, {"serve"}, {"--version", "extra"}, {"-version"}} {
		if isVersionRequest(args) {
			t.Fatalf("unexpected version request for %q", args)
		}
	}
}

func TestS7BuiltBinaryReportsDevelopmentAndReleaseIdentity(t *testing.T) {
	development := buildS7Binary(t, "")
	assertS7VersionOutput(t, development, "pomodorough version=development commit=unknown")

	releaseVersion := "1.2.3-rc.1+build.7"
	releaseFlags := s7ReleaseFlags(releaseVersion)
	release := buildS7Binary(t, releaseFlags)
	assertS7VersionOutput(t, release, "pomodorough version="+releaseVersion+" commit="+s7Commit)

	incomplete := buildS7Binary(t, "-X=main.version=0.10.0")
	output, err := exec.Command(incomplete, "--version").CombinedOutput()
	if err == nil || !strings.Contains(string(output), "invalid build identity") {
		t.Fatalf("incomplete identity output = %q, error = %v", output, err)
	}

	missingMarkers := buildS7Binary(t, "-X=main.version=1.2.3 -X=main.sourceCommit="+s7Commit)
	output, err = exec.Command(missingMarkers, "--version").CombinedOutput()
	if err == nil || !strings.Contains(string(output), "embedded version marker") {
		t.Fatalf("missing marker output = %q, error = %v", output, err)
	}
}

func s7ReleaseFlags(releaseVersion string) string {
	return "-s -w -buildid=" +
		" -X=main.version=" + releaseVersion +
		" -X=main.sourceCommit=" + s7Commit +
		" -X=main.embeddedVersionMarker=" + versionMarkerPrefix + releaseVersion +
		" -X=main.embeddedCommitMarker=" + commitMarkerPrefix + s7Commit
}

func buildS7Binary(t *testing.T, ldflags string) string {
	t.Helper()
	name := "pomodorough"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	output := filepath.Join(t.TempDir(), name)
	arguments := []string{"build", "-trimpath", "-buildvcs=false"}
	if ldflags != "" {
		arguments = append(arguments, "-ldflags", ldflags)
	}
	arguments = append(arguments, "-o", output, "./cmd/pomodorough")
	command := exec.Command("go", arguments...)
	command.Dir = filepath.Join("..", "..")
	if buildOutput, err := command.CombinedOutput(); err != nil {
		t.Fatalf("go build failed: %v\n%s", err, buildOutput)
	}
	return output
}

func assertS7VersionOutput(t *testing.T, binary string, expected string) {
	t.Helper()
	output, err := exec.Command(binary, "--version").CombinedOutput()
	if err != nil {
		t.Fatalf("%s --version failed: %v\n%s", binary, err, output)
	}
	want := []byte(expected + "\n")
	if !bytes.Equal(output, want) {
		t.Fatalf("version output = %q, want exact %q", output, want)
	}
}
