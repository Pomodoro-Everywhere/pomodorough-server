# Server release identity

Release tags use full SemVer 2.0.0 with a required `v` prefix. `v0.10.0`,
`v1.2.3-rc.1`, `v1.2.3+build.7`, and `v1.2.3-rc.1+build.7` are valid. Missing
components, leading zeros in core or numeric prerelease identifiers, empty
identifiers, and non-SemVer characters are rejected consistently by release
validation and server startup.

Release jobs peel the tag and require the tag, event SHA, workflow SHA, and
checked-out `HEAD` to resolve to one 40-character lowercase Git commit. Tracked
worktree or index drift fails validation. Untracked job output remains ignored,
preserving fresh CI checkout behavior without weakening tracked source checks.

Each native release binary receives the version without the `v` prefix and the
source commit through Go linker values. Confirm either installed or extracted
binary before deployment:

```sh
pomodorough --version
```

A `v0.23.0` build from commit
`0123456789abcdef0123456789abcdef01234567` prints exactly:

```text
pomodorough version=0.23.0 commit=0123456789abcdef0123456789abcdef01234567
```

Release automation supports Linux amd64, Linux arm64, macOS amd64, macOS arm64,
and Windows amd64. Each target builds twice on its native runner. Windows uses PowerShell and
produces `pomodorough.exe`; other targets produce `pomodorough`. Native smoke
verification requires stdout to equal identity bytes followed by exactly one newline.
It requires empty stderr and successful exit, checks native architecture, and
records tested binary SHA-256. Whitespace normalization is forbidden. The native
runner writes a target-specific `pomodorough-<version>-<target>.native.json`
record, attests it with the tested binary, and uploads it as a separate immutable
workflow artifact.

Package jobs never execute foreign binaries. They require the downloaded binary
SHA-256 to match the native-tested binary SHA-256, compare archive member and
downloaded binary byte-for-byte, then record both native-tested binary SHA-256
and archive member SHA-256 with the final archive SHA-256. Raw binary bytes must
also contain unique version and commit markers with exact tag-derived identity.

Package identity records and archives receive provenance attestations together.
Release finalization separately downloads and verifies each native-record
attestation into a separate trusted-record directory immediately before
finalization. The finalizer requires every package record's native-record digest
and tested binary SHA-256 to match that independently trusted native test record,
and requires the published native record to be byte-identical to it. Every archive
member SHA-256 must match the same trusted record. All five `.native.json` records
are required, checksummed public release assets beside package identity records,
archives, and SPDX SBOM. Exact target and asset matrices are validated immediately
before checksums and again after draft assets are downloaded. The draft gate verifies
all attestations before publication. Post-smoke replacement, same-architecture
forgery, record transplant, and archive/member mismatch fail closed.

Ordinary local builds intentionally use explicit development identity:

```text
pomodorough version=development commit=unknown
```

Local development identity is not accepted by release smoke checks.
