# Pomodorough Server

<p align="center">
  <img src="web/icon.svg" alt="Pomodorough" width="96">
</p>

<p align="center">
  Authoritative synchronization service and installable web client for the Pomodorough timer.
</p>

<p align="center">
  <a href="https://pomodorough.egigoka.me">Live app</a> |
  <a href="https://pomodorough.egigoka.me/openapi.yaml">OpenAPI specification</a> |
  <a href="https://pomodorough.egigoka.me/readyz">Service readiness</a>
</p>

Pomodorough is a local-first Pomodoro timer designed to keep timer state, tasks,
history, duration preferences, and automatic break-start preference consistent across platforms. One Go process
serves the progressive web app and JSON API. Each account is isolated in its
own SQLite database, so the service requires neither PostgreSQL nor Redis.

## Highlights

- Durable offline operation in the PWA through IndexedDB-backed queues
- Idempotent synchronization of timer commands, task operations, durations, and automatic break-start preference
- Deterministic conflict resolution with hybrid logical clocks
- Canonical server projections with optimistic replay on every client
- Per-account SQLite databases using WAL mode and foreign-key enforcement
- Google OAuth for web and native clients, with rotating refresh tokens
- Server-Sent Events for low-latency revision notifications
- Static asset delivery from the same process that serves the API
- Complete OpenAPI 3.0 contract in [`web/openapi.yaml`](web/openapi.yaml)
- Transport-neutral Iroh peer protocol in [`docs/iroh-sync-v1.md`](docs/iroh-sync-v1.md)

## Architecture

| Component | Responsibility |
| --- | --- |
| Go HTTP service | Authentication, synchronization, revision streaming, and static delivery |
| Progressive web app | Offline-capable browser UI and durable IndexedDB operation queues |
| Per-user SQLite store | Commands, outcomes, tasks, preferences, sessions, and canonical account state |
| Revision hub | Lightweight SSE notifications that tell connected clients when to synchronize |

The revision stream is an optimization, not a second source of truth. Clients
always reconcile through `POST /api/v1/sync`, and every accepted operation is
safe to submit more than once.

### Versioning

The Go service is versioned by git tags (`v0.10.0` and following); release
binaries report their identity through `pomodorough --version` as documented in
[`docs/release-identity-s7.md`](docs/release-identity-s7.md). The web PWA ships
inside the same release, so the `version` field in [`package.json`](package.json)
mirrors the service tag and is bumped with it. The `version` in
[`web/openapi.yaml`](web/openapi.yaml) tracks the API contract revision
separately and is not a release marker.

### Synchronization model

1. Clients persist an operation locally before updating their interface.
2. Pending operations are submitted with the client's last known revision.
3. The server records each operation idempotently and reduces account state.
4. The response acknowledges submitted operations and returns a canonical snapshot.
5. Clients remove acknowledged entries, then replay any newer local work.

Hybrid logical clocks order concurrent offline operations without relying on
perfect device clocks. Running timers store elapsed time at an anchor and its
timestamp, so no background ticking job is required. Work created while a
device is offline remains local until that device reconnects.

## Requirements

- Go 1.25.13 or newer (older 1.25 patch releases contain reachable standard-library vulnerabilities)
- A Google OAuth web client for browser sign-in
- Optional native OAuth client IDs for Apple, Android, and Linux clients
- A writable data directory for per-user SQLite databases

## Local development

Export the required configuration, then run the service:

```sh
export APP_SECRET="$(openssl rand -hex 32)"
export GOOGLE_WEB_CLIENT_ID="your-web-client-id"
export GOOGLE_WEB_CLIENT_SECRET="your-web-client-secret"
export GOOGLE_NATIVE_CLIENT_IDS="comma-separated-native-client-ids"

go run ./cmd/pomodorough
```

Default and optional values are documented in
[`deploy/pomodorough.env.example`](deploy/pomodorough.env.example).

### Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `APP_SECRET` | Yes | None | Derives stable user IDs and protects transient authentication data |
| `GOOGLE_WEB_CLIENT_ID` | Yes | None | Google OAuth client used by the web flow |
| `GOOGLE_WEB_CLIENT_SECRET` | Yes | None | Secret for the web OAuth client |
| `GOOGLE_NATIVE_CLIENT_IDS` | For native clients | Empty | Comma-separated accepted token audiences and authorized parties |
| `LISTEN_ADDR` | No | `127.0.0.1:8790` | HTTP listen address |
| `READINESS_URL` | No | `http://127.0.0.1:8790/readyz` | Direct instance URL used by supplied fail-closed systemd startup probe |
| `DATA_DIR` | No | `/var/lib/pomodorough` | Runtime data root |
| `WEB_ROOT` | No | `/etc/pomodorough/web` | PWA asset directory |
| `PUBLIC_URL` | No | Production URL | Public origin used for redirects and links |
| `TRUSTED_PROXY_CIDRS` | No | Empty | Comma-separated proxy networks allowed to supply `X-Forwarded-For` |
| `TRUSTED_PROXY_HOPS` | With trusted CIDRs | Empty | Exact proxy count between client and server, including direct peer |
| `SENTRY_DSN` | No | Empty (disabled) | Backend error monitoring DSN, initialized at startup in `cmd/pomodorough` |
| `SENTRY_DSN_WEB` | No | Empty (disabled) | Browser error monitoring + Session Replay DSN, server-rendered into the `sentry-dsn` meta tag of `index.html`/`app.html` |

`APP_SECRET` must remain stable. Replacing it changes derived user IDs and
invalidates existing sessions.

### Google OAuth

Configure the web OAuth client with this exact redirect URI:

```text
https://pomodorough.egigoka.me/auth/google/callback
```

Native clients request an ID token containing the nonce returned by
`POST /api/v1/auth/google/challenge`. Every possible `aud` or `azp` value must
be listed in `GOOGLE_NATIVE_CLIENT_IDS`.

## Testing

```sh
go test ./...
go test -race ./...
go vet ./...
```

Tests cover authentication boundaries, migrations, timer and task reduction,
preference synchronization, idempotency, conflict handling, and HTTP contracts.
Real-listener tests use four logical protocol clients named `pwa`, `ios`,
`linux`, and `android`; they do not execute native application code.

### Integration user provisioning

Operator-only integration provisioning creates a synthetic
`https://integration.invalid` profile and separate ordinary native sessions for
each logical client. It does not add an HTTP authentication bypass, use a Google
identity, emit fixed tokens, or print `APP_SECRET`.

Use a dedicated, manually owned integration server data directory and exact app
secret configured for that server. All inputs are mandatory; no production
data-directory or identity defaults exist. Access tokens use normal 15-minute
expiration, capped by shorter requested TTL; refresh tokens and sessions use
requested TTL.

Build server and provisioning CLI from same checkout, then use strict
stop -> provision -> start order with unchanged server binary. Run this recipe
in a clean, non-interactive Bash process without inherited functions replacing
`git`, `mktemp`, `chmod`, or `python3`:

```bash
umask 077
export POMODOROUGH_INTEGRATION_DATA_DIR="$(mktemp -d)"
export POMODOROUGH_INTEGRATION_APP_SECRET="$(openssl rand -hex 32)"
export POMODOROUGH_INTEGRATION_SUBJECT="integration-protocol-001"
export POMODOROUGH_INTEGRATION_DEVICES="pwa=device-pwa:web,ios=device-ios:ios,linux=device-linux:linux,android=device-android:android"
export POMODOROUGH_INTEGRATION_TTL="2h"
go build -o /tmp/pomodorough ./cmd/pomodorough
go build -tags=integration -o /tmp/pomodorough-integration-user ./cmd/pomodorough-integration-user
with_integration_credentials() (
  set -eu
  umask 077
  credential_directory=
  credential_directory_device=
  credential_directory_inode=
  credential_directory_open=
  credential_parent=
  POMODOROUGH_INTEGRATION_CREDENTIALS=
  credential_file_open=
  integration_command_status=
  integration_cleanup_status=
  python3_path="$(command -v python3)"
  cleanup_integration_credentials() {
    integration_command_status=$?
    trap - EXIT HUP INT TERM
    set +e
    integration_cleanup_status=0
    if [ "$credential_file_open" = 1 ]; then
      "$python3_path" -c 'import os; os.ftruncate(9, 0); os.fsync(9)' || integration_cleanup_status=1
      exec 9>&- || integration_cleanup_status=1
      credential_file_open=
    fi
    if [ "$credential_directory_open" = 1 ]; then
      "$python3_path" -c '
import os
import shutil
import stat
import sys
from pathlib import Path

expected = Path(sys.argv[1])
identity = (int(sys.argv[2]), int(sys.argv[3]))
opened = os.fstat(8)
if not stat.S_ISDIR(opened.st_mode) or (opened.st_dev, opened.st_ino) != identity:
    raise SystemExit("opened credential directory identity changed")
if not shutil.rmtree.avoids_symlink_attacks:
    raise SystemExit("runtime cannot remove credential directory without symlink races")

def matches(path):
    try:
        current = path.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISDIR(current.st_mode) and (current.st_dev, current.st_ino) == identity

if not matches(expected):
    raise SystemExit("credential directory moved or replaced")

def remove_identity(path):
    os.chmod(path, 0o700, follow_symlinks=False)
    for root, directories, _ in os.walk(path, followlinks=False):
        os.chmod(root, 0o700, follow_symlinks=False)
        for directory in directories:
            child = Path(root, directory)
            if not child.is_symlink():
                os.chmod(child, 0o700, follow_symlinks=False)
    if not matches(path):
        raise SystemExit("credential directory identity changed during cleanup")
    shutil.rmtree(path)
    if os.path.lexists(path):
        raise SystemExit("credential directory removal was not conclusive")

remove_identity(expected)
' "$credential_directory" "$credential_directory_device" \
        "$credential_directory_inode" || integration_cleanup_status=1
      exec 8>&- || integration_cleanup_status=1
      credential_directory_open=
    elif [ -n "$credential_directory" ]; then
      integration_cleanup_status=1
    fi
    if [ "$integration_cleanup_status" -ne 0 ]; then
      printf '%s\n' 'secure integration credential cleanup failed' >&2
      exit 125
    fi
    if [ "$integration_command_status" -ne 0 ]; then
      exit "$integration_command_status"
    fi
    exit 0
  }
  trap cleanup_integration_credentials EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if [ "$#" -lt 2 ]; then
    printf '%s\n' 'usage: with_integration_credentials PROVISIONER TEST_COMMAND [ARG ...]' >&2
    return 2
  fi
  provisioner=$1
  shift
  repository_root="$(git rev-parse --show-toplevel)"
  credential_parent="$(
    "$python3_path" -c '
import os
import pathlib
import sys

repository = pathlib.Path(sys.argv[1]).resolve(strict=True)
for raw_candidate in ("/var/tmp", "/tmp"):
    candidate = pathlib.Path(raw_candidate).resolve(strict=True)
    if candidate != repository and repository not in candidate.parents:
        if os.access(candidate, os.W_OK | os.X_OK):
            print(candidate)
            raise SystemExit(0)
raise SystemExit("no writable temporary directory exists outside repository")
' "$repository_root"
  )"
  credential_directory="$(mktemp -d "$credential_parent/pomodorough-integration-credentials.XXXXXX")"
  POMODOROUGH_INTEGRATION_CREDENTIALS="$credential_directory/credentials.json"
  export POMODOROUGH_INTEGRATION_CREDENTIALS
  exec 8< "$credential_directory"
  credential_directory_open=1
  credential_directory_device="$("$python3_path" -c 'import os; print(os.fstat(8).st_dev)')"
  credential_directory_inode="$("$python3_path" -c 'import os; print(os.fstat(8).st_ino)')"
  chmod 700 "$credential_directory"
  : > "$POMODOROUGH_INTEGRATION_CREDENTIALS"
  chmod 600 "$POMODOROUGH_INTEGRATION_CREDENTIALS"
  exec 9<> "$POMODOROUGH_INTEGRATION_CREDENTIALS"
  credential_file_open=1
  # Stop dedicated integration server if already started.
  "$provisioner" >&9
  "$python3_path" -c '
import os
import stat
import sys

opened = os.fstat(9)
named = os.stat(sys.argv[1], follow_symlinks=False)
if not stat.S_ISREG(named.st_mode) or (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino):
    raise SystemExit("credential path identity changed during provisioning")
if stat.S_IMODE(named.st_mode) != 0o600 or named.st_size == 0:
    raise SystemExit("credential file is empty or has unsafe permissions")
os.fsync(9)
' "$POMODOROUGH_INTEGRATION_CREDENTIALS"
  "$@"
)
with_integration_credentials /tmp/pomodorough-integration-user ./run-integration-protocol-tests
```

Replace `./run-integration-protocol-tests` with one command that starts the
dedicated server using `/tmp/pomodorough` and matching `DATA_DIR`/`APP_SECRET`,
then runs test clients using `POMODOROUGH_INTEGRATION_CREDENTIALS`. The helper
ignores `TMPDIR`, creates mode-`0600` credentials under a mode-`0700` directory
outside the checkout, and keeps its exit cleanup active through that command.
It retains the opened credential inode, verifies that provisioning did not
replace it, and retains the created directory identity. Cleanup wipes the
credential inode, then removes that directory only when the original generated
path still names the tracked identity. It does not search for or remove a moved
directory. A failing provisioner or test command status is preserved only after
the original directory is conclusively removed. A relocated or inaccessible
identity, non-identity replacement, wipe failure, or removal failure emits an
error and returns status `125` instead. Relocation may therefore leave a
protected directory containing the wiped, zero-length credential file for
manual removal. Cleanup never follows symlinks or deletes a non-identity
replacement at the original directory path. Content placed inside the still
identity-matching credential directory remains inside its removal scope. State
variables are initialized before allocation, so sourcing this recipe into a
shell with a colliding readonly variable fails before creating credentials.

Both commands must be trusted code run as the operator account. Same-account
hostile code can copy credentials before cleanup; shell permissions cannot stop
that. Commands must finish their child processes before returning and must not
leave a same-account process racing cleanup. This helper protects against
sequential permission and path replacement, not deliberate credential
exfiltration or concurrent mutation by either command. Cross-filesystem
copy-and-delete creates an untracked copy that this helper cannot erase. Any
rename away from the original generated path also makes directory cleanup
unresolved and returns status `125` instead of the command status.

EXIT, HUP, INT, and TERM run cleanup. SIGKILL or host loss cannot run a shell
trap; inspect and remove protected `pomodorough-integration-credentials.*`
directories after either event. Status `125` also requires inspection: the
credential wipe or directory removal was not proven, so a protected path or
same-inode link may still contain credential bytes.

`-data-dir`, `-app-secret`, `-subject`, `-devices`, and `-ttl` flags may replace
their corresponding environment variables. Prefer the environment for the app
secret to keep it out of process listings and shell history.

CLI and server take same exclusive data-directory lock. CLI marks only an empty
directory as dedicated integration data, refuses existing unmarked account
databases, and checks every existing user database already has current schema;
it never migrates existing databases. Lock or schema mismatch is fatal.

Run CLI as same operating-system account that owns dedicated integration
directory. Do not run it as root and do not point it at hardened production
`StateDirectory=pomodorough`: production service uses systemd `DynamicUser`, and
manual writes can break ownership while creating real credentials. Output
contains live access and refresh tokens. Keep it out of logs and the repository,
retain exact mode `0600`, and delete it when testing ends. No HTTP authentication
bypass exists.

Legacy repository-local integration-credentials.json storage is unsafe and
ignored. Never copy credentials there.

## Production deployment

The repository includes a hardened systemd unit and example environment file:

```sh
go build -trimpath -o /usr/local/bin/pomodorough ./cmd/pomodorough
install -m 0644 deploy/pomodorough.service /etc/systemd/system/pomodorough.service
systemctl daemon-reload
systemctl enable --now pomodorough.service
```

The unit completes startup only after `READINESS_URL` returns `200`. Keep this
URL pointed at the instance directly, not a load balancer. Install `curl` at
`/usr/bin/curl` or adjust `ExecStartPost` for the host's equivalent client.
`/healthz` remains dependency-free liveness; `/readyz` performs bounded read-only
storage, ledger, web-bundle, Core provenance, and Core runtime checks. Probe
details, stable error codes, scan bounds, and no-side-effect guarantees are in
[`docs/operations.md`](docs/operations.md#liveness-and-readiness).
Readiness has no reduced mode: missing web assets or Core runtime always return
`503` and never admit traffic.

Terminate TLS with a reverse proxy such as Caddy and forward requests to the
configured `LISTEN_ADDR`. Validate and reload the proxy after deployment:

```sh
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

Forwarded client addresses are disabled by default. If authentication rate
limits must identify clients behind proxies, configure both proxy variables and
follow [`docs/trusted-proxy-rate-limits.md`](docs/trusted-proxy-rate-limits.md).
Keep the server listener unreachable except through those proxies.

Published archives include an SPDX software bill of materials, a checksum
manifest, and GitHub build-provenance attestations. Verify both archive checks
before installation:

```sh
gh release download vX.Y.Z --repo Pomodoro-Everywhere/pomodorough-server
sha256sum --check SHA256SUMS
gh attestation verify SHA256SUMS \
  --repo Pomodoro-Everywhere/pomodorough-server
gh attestation verify pomodorough-X.Y.Z-linux-amd64.tar.gz \
  --repo Pomodoro-Everywhere/pomodorough-server
```

On macOS, use `shasum -a 256 -c SHA256SUMS` for the checksum step.

The contractual public privacy policy is served by the application at
<https://pomodorough.egigoka.me/privacy> (and `/privacy.html`). A GitHub Pages
mirror remains independently available. `scripts/check_privacy_policy.py` prevents the two copies
from drifting.

Runtime account databases live below `DATA_DIR/users`. Back them up with a
SQLite-aware online backup process so WAL contents are included.

Run an isolated restore drill against a live or copied account database without
changing the source:

```sh
python3 scripts/restore_drill.py \
  /var/lib/pomodorough/users/<user-id>.sqlite \
  /var/lib/pomodorough/restore-drills/<user-id>-$(date +%Y%m%d).sqlite
```

The command refuses to overwrite a destination, uses SQLite's online backup
API, and requires the restored copy to pass `PRAGMA integrity_check`. After
verification, remove the isolated copy according to the deployment's backup
handling policy. Operators must define and disclose a finite backup-retention
period (30 days or less is recommended). Account deletion removes live storage
immediately; a restore from an older backup must reapply deletions recorded
after that backup rather than resurrect deleted accounts.

`DELETE /api/v1/account` retries with the exact originally authorized credential
and `{"confirmation":"DELETE"}` return `204` only for that committed deletion.
Clients must try the retained access token before refreshing, even when expired;
only a definitive `401` without a receipt permits normal refresh. Other failures
remain ambiguous, and `401` is never a success signal. Web retries additionally
require the original CSRF cookie/header and configured `Origin`.

Private `receipt-*.json` files in `DELETION_LEDGER_DIR` bind a digest of the user,
authentication method, and original opaque-token hash to the deleted generation
(and the CSRF hash for web sessions). Receipts are fsynced before the unchanged
version-1 tombstone; a receipt without its tombstone cannot confirm deletion.
Confirmation rechecks the tombstone and completes old-generation file removal
under the account lock, leaving any recreated generation untouched. Receipts
never authorize another endpoint and do not expire with credentials. Keep the
entire independent ledger durable and backed up: do not roll it back with
`DATA_DIR`, remove receipts, or downgrade to a release without replay support
while clients have pending confirmations. Losing receipts can strand recovery;
losing tombstones can resurrect backed-up accounts.

Application-level abuse controls allow 30 authentication requests per source
IP per minute, 240 authenticated requests per account per minute, and four
concurrent revision streams per account. Rejections return `429` with
`Retry-After`. The default limiter key is always the direct peer. Configured
trusted proxies may supply a strictly parsed `X-Forwarded-For` chain; malformed,
ambiguous, untrusted, or incorrectly sized trusted boundaries are ignored.

Request logs include method, route path, status, byte count, and latency but no
query strings, account identifiers, task text, timer content, or credentials.
Sync events add only aggregate operation counts, revision, and whether canonical
state changed; account deletion emits an identifier-free audit event. Feed these
structured records to the deployment's metrics system and alert on sustained
5xx responses, sustained rate-limit events, restore-drill failures, or missing
backup-success signals. Keep log retention finite and access-controlled.
The bounded Prometheus endpoint, alert recommendations, backup procedure, and
recovery checklist are documented in [`docs/operations.md`](docs/operations.md).
`GET /metrics` is unauthenticated by design and shares the API listener, so keep
the loopback `LISTEN_ADDR` default behind a reverse proxy (or restrict
`/metrics` at the proxy/firewall) and scrape it over loopback.

## API surface

| Area | Endpoints |
| --- | --- |
| Operations | `GET /healthz`, `GET /readyz`, `GET /metrics`, `GET /openapi.yaml` |
| Browser authentication | `GET /auth/google/start`, `GET /auth/google/callback` |
| Native authentication | `POST /api/v1/auth/google/challenge`, `POST /api/v1/auth/google/exchange` |
| Sessions | `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, `POST /api/v1/auth/revoke-device` |
| Account | `GET /api/v1/me`, `GET /api/v1/history`, `DELETE /api/v1/account` |
| Synchronization | `GET /api/v1/bootstrap`, `POST /api/v1/bootstrap/resolve`, `POST /api/v1/sync`, `GET /api/v1/stream` |

See [`web/openapi.yaml`](web/openapi.yaml) for schemas, validation constraints,
examples, and security requirements. Shared navigation, timer-state language,
account-safety, completion guarantees, accessibility, and localization semantics
are defined in [`docs/client-experience-contract.md`](docs/client-experience-contract.md).

## Pomodorough projects

- [`pomodorough-server`](https://github.com/Pomodoro-Everywhere/pomodorough-server) - Web/PWA + sync server
- [`pomodorough-apple`](https://github.com/Pomodoro-Everywhere/pomodorough-apple) - Apple client
- [`pomodorough-android`](https://github.com/Pomodoro-Everywhere/pomodorough-android) - Android client
- [`pomodorough-desktop`](https://github.com/Pomodoro-Everywhere/pomodorough-desktop) - Linux and Windows desktop client

## License

Pomodorough Server is licensed under the GNU General Public License v3.0 or
later. See [LICENSE](LICENSE).
