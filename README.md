# Pomodorough

Local-first Pomodoro timer with cross-device synchronization. One Go process serves the protected PWA and API. Each Google account has an independent SQLite database.

## Runtime model

- Browser actions are written to IndexedDB before the UI changes.
- `/api/v1/sync` accepts idempotent commands and returns a canonical snapshot.
- Hybrid logical clocks deterministically order commands created during network partitions.
- Running timers store elapsed time at an anchor plus its timestamp; no ticking server job is required.
- Server-Sent Events only announce revisions. HTTP sync remains authoritative.
- PostgreSQL and Redis are not required.

An action created on an offline device cannot appear elsewhere until that device reconnects. Concurrent offline actions converge deterministically; ignored actions remain in the audit log.

## Google OAuth

Create a Google OAuth web client with this exact redirect URI:

```text
https://pomodorough.egigoka.me/auth/google/callback
```

Set its client ID and secret in `/etc/pomodorough/pomodorough.env`. Set `GOOGLE_NATIVE_CLIENT_IDS` to a comma-separated list of allowed iOS, Android, and desktop OAuth client IDs. Native clients must request an ID token containing the nonce returned by `POST /api/v1/auth/google/challenge`.

`APP_SECRET` must remain stable. Changing it changes derived user IDs and invalidates every session.

## Development

```sh
go test ./...
go run ./cmd/pomodorough
```

Required environment:

```text
APP_SECRET=<at least 32 bytes>
GOOGLE_WEB_CLIENT_ID=<web OAuth client ID>
GOOGLE_WEB_CLIENT_SECRET=<web OAuth client secret>
GOOGLE_NATIVE_CLIENT_IDS=<comma-separated native OAuth client IDs>
```

Optional environment defaults are documented in `deploy/pomodorough.env.example`.

## Deployment

```sh
go build -trimpath -o /usr/local/bin/pomodorough ./cmd/pomodorough
install -m 0644 deploy/pomodorough.service /etc/systemd/system/pomodorough.service
systemctl daemon-reload
systemctl enable --now pomodorough.service
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

Runtime data lives under `/var/lib/pomodorough/users`. Back up SQLite databases with a SQLite-aware online backup process so WAL contents are included.

## API

Full OpenAPI 3.0 specification: [`web/openapi.yaml`](web/openapi.yaml). The deployed specification is public at <https://pomodorough.egigoka.me/openapi.yaml>.

- `GET /healthz`
- `GET /auth/google/start`
- `GET /auth/google/callback`
- `POST /api/v1/auth/google/challenge`
- `POST /api/v1/auth/google/exchange`
- `POST /api/v1/auth/refresh`
- `GET /api/v1/me`
- `POST /api/v1/auth/logout`
- `POST /api/v1/auth/revoke-device`
- `POST /api/v1/sync`
- `GET /api/v1/history`
- `GET /api/v1/stream`
