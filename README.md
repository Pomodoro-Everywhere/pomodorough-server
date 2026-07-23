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
  <a href="https://pomodorough.egigoka.me/healthz">Service health</a>
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

- Go 1.24 or newer
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
| `DATA_DIR` | No | `/var/lib/pomodorough` | Runtime data root |
| `WEB_ROOT` | No | `/etc/pomodorough/web` | PWA asset directory |
| `PUBLIC_URL` | No | Production URL | Public origin used for redirects and links |

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
stop -> provision -> start order with unchanged server binary:

```sh
umask 077
export POMODOROUGH_INTEGRATION_DATA_DIR="$(mktemp -d)"
export POMODOROUGH_INTEGRATION_APP_SECRET="$(openssl rand -hex 32)"
export POMODOROUGH_INTEGRATION_SUBJECT="integration-protocol-001"
export POMODOROUGH_INTEGRATION_DEVICES="pwa=device-pwa:web,ios=device-ios:ios,linux=device-linux:linux,android=device-android:android"
export POMODOROUGH_INTEGRATION_TTL="2h"
go build -o /tmp/pomodorough ./cmd/pomodorough
go build -tags=integration -o /tmp/pomodorough-integration-user ./cmd/pomodorough-integration-user
# Stop dedicated integration server if already started.
/tmp/pomodorough-integration-user > integration-credentials.json
# Start dedicated integration server with /tmp/pomodorough and matching DATA_DIR/APP_SECRET.
```

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
contains live access and refresh tokens. Keep it out of logs and version
control, protect it with restrictive permissions, and delete it when testing
ends. No HTTP authentication bypass exists.

## Production deployment

The repository includes a hardened systemd unit and example environment file:

```sh
go build -trimpath -o /usr/local/bin/pomodorough ./cmd/pomodorough
install -m 0644 deploy/pomodorough.service /etc/systemd/system/pomodorough.service
systemctl daemon-reload
systemctl enable --now pomodorough.service
```

Terminate TLS with a reverse proxy such as Caddy and forward requests to the
configured `LISTEN_ADDR`. Validate and reload the proxy after deployment:

```sh
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

Runtime account databases live below `DATA_DIR/users`. Back them up with a
SQLite-aware online backup process so WAL contents are included.

## API surface

| Area | Endpoints |
| --- | --- |
| Operations | `GET /healthz`, `GET /openapi.yaml` |
| Browser authentication | `GET /auth/google/start`, `GET /auth/google/callback` |
| Native authentication | `POST /api/v1/auth/google/challenge`, `POST /api/v1/auth/google/exchange` |
| Sessions | `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, `POST /api/v1/auth/revoke-device` |
| Account | `GET /api/v1/me`, `GET /api/v1/history` |
| Synchronization | `GET /api/v1/bootstrap`, `POST /api/v1/bootstrap/resolve`, `POST /api/v1/sync`, `GET /api/v1/stream` |

See [`web/openapi.yaml`](web/openapi.yaml) for schemas, validation constraints,
and response contracts.

## Pomodorough projects

- [`pomodorough-server`](https://github.com/Pomodoro-Everywhere/pomodorough-server) - Web/PWA + sync server
- [`pomodorough-apple`](https://github.com/Pomodoro-Everywhere/pomodorough-apple) - Apple client
- [`pomodorough-android`](https://github.com/Pomodoro-Everywhere/pomodorough-android) - Android client
- [`pomodorough-desktop`](https://github.com/Pomodoro-Everywhere/pomodorough-desktop) - Linux and Windows desktop client

## License

Pomodorough Server is licensed under the GNU General Public License v3.0 or
later. See [LICENSE](LICENSE).
