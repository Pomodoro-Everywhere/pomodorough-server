package main

import (
	"errors"
	"regexp"
)

const (
	developmentVersion  = "development"
	developmentCommit   = "unknown"
	versionMarkerPrefix = "pomodorough-release-version:"
	commitMarkerPrefix  = "pomodorough-release-commit:"
)

var (
	version               = developmentVersion
	sourceCommit          = developmentCommit
	embeddedVersionMarker = versionMarkerPrefix + developmentVersion
	embeddedCommitMarker  = commitMarkerPrefix + developmentCommit
	semverPattern         = regexp.MustCompile(
		`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)` +
			`(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)` +
			`(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?` +
			`(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`,
	)
	commitPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)
)

type buildIdentity struct {
	version string
	commit  string
}

func currentBuildIdentity() (buildIdentity, error) {
	identity, err := parseBuildIdentity(version, sourceCommit)
	if err != nil {
		return buildIdentity{}, err
	}
	if embeddedVersionMarker != versionMarkerPrefix+identity.version {
		return buildIdentity{}, errors.New("embedded version marker does not match version")
	}
	if embeddedCommitMarker != commitMarkerPrefix+identity.commit {
		return buildIdentity{}, errors.New("embedded commit marker does not match commit")
	}
	return identity, nil
}

func parseBuildIdentity(candidateVersion string, candidateCommit string) (buildIdentity, error) {
	identity := buildIdentity{version: candidateVersion, commit: candidateCommit}
	if candidateVersion == developmentVersion && candidateCommit == developmentCommit {
		return identity, nil
	}
	if !semverPattern.MatchString(candidateVersion) {
		return buildIdentity{}, errors.New("version must be strict SemVer or development")
	}
	if !commitPattern.MatchString(candidateCommit) {
		return buildIdentity{}, errors.New("commit must be 40 lowercase hexadecimal characters")
	}
	return identity, nil
}

func (identity buildIdentity) String() string {
	return "pomodorough version=" + identity.version + " commit=" + identity.commit
}

func isVersionRequest(arguments []string) bool {
	return len(arguments) == 1 && arguments[0] == "--version"
}
