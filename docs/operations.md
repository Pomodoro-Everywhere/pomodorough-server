# Operations, metrics, backups, and alerts

## Metrics

`GET /metrics` exports process-local Prometheus metrics with bounded labels:

- `pomodorough_http_requests_total{method,route,status}`
- `pomodorough_http_request_duration_seconds_count{method,route}`
- `pomodorough_http_request_duration_seconds_sum{method,route}`

`route` is the registered route template, never an arbitrary path. Metrics do not
contain account IDs, task/timer content, query strings, IP addresses, or OAuth
values. For multiple replicas, scrape and aggregate every process; the service's
rate limiter and metrics remain intentionally process-local.

## Liveness and readiness

`GET /healthz` is process liveness only. It always returns `200` with
`{"status":"ok"}` while the HTTP process can respond, even when storage is
unavailable. Use it for restart decisions, never traffic admission.

`GET /readyz` is the traffic-routing probe. It checks application key material,
account storage, the independent deletion ledger, server web assets, and the
bundled Core runtime. Each account SQLite database and any existing WAL/SHM pair
must be private regular files. The probe opens databases read-only with
`query_only`, verifies schema version, runs `quick_check`, and confirms database
generation against active lifecycle and deletion records. It also validates
deletion receipts, hashes the fixed PWA/OpenAPI asset inventory, checks exact
Core WASM and metadata provenance, and calls `core.version` through the runtime
used by traffic.

The users and ledger inventories are each capped at 4,096 entries; exceeding the
cap fails readiness instead of producing a partial result. Web checks cover a
fixed list with a 2 MiB per-file limit. The whole probe fails closed within two
seconds. It never creates, migrates, checkpoints, repairs, enrolls, or deletes
data and does not create or rewrite SQLite WAL/SHM files, ledger records, web
assets, or Core artifacts. Avoid high-frequency probing because readiness hashes
the web bundle and checks every account database. Remove an instance from routing
on any readiness failure; retain `/healthz` for diagnosis.

Readiness has no reduced dependency mode. Missing web assets or traffic Core
runtime always return `503`; constructors that lack either dependency cannot
report ready.

Readiness failures expose only these stable nonsecret codes:

- `key_unavailable`: application key material no longer matches startup state;
- `storage_unavailable`: account directory or account-file metadata is unusable;
- `ledger_unavailable`: independent deletion-ledger directory is unusable;
- `database_unavailable`: account database cannot pass read-only schema/integrity checks;
- `lifecycle_invalid`: ledger record or account-generation binding is invalid;
- `web_unavailable`: required non-Core web asset is missing, unsafe, or has wrong digest;
- `core_provenance_invalid`: Core WASM or metadata is missing, unsafe, or has wrong digest;
- `core_unavailable`: traffic Core runtime is absent, failing, or has wrong identity;
- `check_timeout` or `check_canceled`: bounded probe did not complete.

The supplied systemd unit keeps the service in startup until its direct-instance
`READINESS_URL` returns `200`. It retries connection failures and `503` responses
for up to 20 seconds. Exhaustion fails `ExecStartPost`; `Restart=on-failure` then
restarts the unit. Do not point this URL at a load balancer, and do not replace it
with `/healthz`.

At minimum, alert on:

- `/healthz` failing for two consecutive checks, which indicates process failure;
- `/readyz` failing for two consecutive checks, which requires traffic removal;
- any sustained 5xx ratio above 1%;
- p95 `/api/v1/sync` or `/api/v1/bootstrap/resolve` latency above two seconds;
- sustained 409 growth, which indicates bootstrap/conflict pressure;
- sustained 429 growth, which can indicate abuse or undersized limits;
- no successful backup or restore drill within the expected interval.

## SQLite durability

Runtime per-user databases use WAL mode with `synchronous=FULL`. SQLite syncs
each committed WAL transaction before the server acknowledges its write, which
improves resistance to operating-system crashes and power loss compared with
`NORMAL`, at the cost of an additional sync and potentially lower write
throughput or higher write latency. Durability still depends on the operating
system, filesystem, and storage device honoring sync requests. Automated
recovery tests use abrupt process termination and reopen the WAL-backed database;
they verify process-kill recovery, not a true host power cut.

## Backups

Treat `DELETION_LEDGER_DIR` and `DATA_DIR` as one recovery unit. The deletion
ledger is deliberately outside `DATA_DIR`; a data-only backup is incomplete.
Stop every replica that can write these paths, then create a bound snapshot:

```sh
python3 scripts/restore_drill.py snapshot \
  "$DATA_DIR" "$DELETION_LEDGER_DIR" "/backup/sets/$(date -u +%Y%m%dT%H%M%SZ)"
```

The command advances an append-only recovery sequence, then copies the ledger
first and account data second. Recovery-domain metadata lives in the ledger; each
sequence receipt HMAC-authenticates its predecessor and the account-data inventory,
while account data stores an HMAC-authenticated binding to that exact receipt. The
manifest records those identities plus every file, SHA-256 digest, account
lifecycle, and deletion high-watermark. The command verifies both source
inventories remained stable, fsyncs the set, and publishes it by directory rename.
This writes only recovery metadata in the stopped live paths. A storage snapshot
is acceptable only when it atomically covers both configured paths after a bound
snapshot has established the same recovery metadata. Never combine independently
timed live SQLite copies with a ledger copy.

Encrypt backups, restrict access, and keep them outside the live host. Publish a
backup set only after the bound snapshot command succeeds and the external backup
catalog records its identity, UTC timestamp, size, checksum, and exit status. Sign
or MAC that catalog and store it separately: snapshot SHA-256 files detect
modification but do not prove authenticity or that an operator selected the newest
set. A live account deletion removes the live per-user
database and sidecars; backups follow the separately disclosed retention schedule
and are not rewritten in place. Preserve newer ledger backups: tombstones are
monotonic and must not be rolled back to match older account data.

Record each backup set's result in the monitoring system. A backup command must
return nonzero when the ledger, manifest, or any database cannot be copied or
checked.

## Restore drill

Run at least weekly and before releases:

```sh
snapshot=/path/to/bound-snapshot
restore_root="$(mktemp -d)"
python3 scripts/restore_drill.py verify "$snapshot"
python3 scripts/restore_drill.py restore \
  "$snapshot" "$snapshot" "$restore_root/data" "$restore_root/deletion-ledger" \
  --data-manifest-sha256 "$DATA_MANIFEST_SHA256" \
  --ledger-manifest-sha256 "$LEDGER_MANIFEST_SHA256"
```

The restore verifies both manifests and inventories, rejects recovery-domain,
sequence, lifecycle, or deletion-watermark rollback, restores the trusted ledger
before account data, fsyncs both, and publishes each destination by directory
rename. Version 2 account data remains compatible with a newer ledger snapshot
from the same recovery domain when that ledger's receipt chain contains the exact
selected data receipt. Independently created domains and forked sequence receipts
are rejected even when each snapshot verifies alone. Version 1 manifests lack
this binding and are rejected; recreate them from authoritative stopped storage
with the current snapshot command before relying on version 2 recovery. Use a
disposable destination. The legacy two-path invocation checks one SQLite file only
and is not a valid account recovery procedure. CI exercises deterministic path
swaps, domain and sequence transplants, interrupted receipt publication,
deletion/backup/restore/restart scenarios; it does not replace drills against
authentic encrypted backups.

Before first deployment of lifecycle-bound deletion ledgers, stop the service and
enroll only known-authoritative live storage:

```sh
python3 scripts/restore_drill.py enroll "$DATA_DIR" "$DELETION_LEDGER_DIR"
```

Run enrollment once before upgrade, then create and verify a bound snapshot. Never
use enrollment to repair a restored empty or stale ledger: it would bless restored
account data as current. Runtime intentionally fails closed when active account
data lacks an exact lifecycle record.

## Recovery

1. Stop the service; do not restore into a directory reachable by a running
   process.
2. Preserve the damaged data directory for diagnosis.
3. Select account data from the required recovery point and the newest trusted
   ledger snapshot. A fully rolled-back but internally consistent pair cannot be
   detected without the external signed/MACed monotonic backup catalog.
4. Restore both into new paths while the service remains stopped:
   `python3 scripts/restore_drill.py restore DATA_SNAPSHOT LEDGER_SNAPSHOT NEW_DATA NEW_LEDGER --data-manifest-sha256 DATA_SHA256 --ledger-manifest-sha256 LEDGER_SHA256`.
   The command proves the trusted ledger dominates the selected data snapshot,
   restores the ledger first, and rejects missing immutable ledger inventory.
   Supply both digests from the separately authenticated backup catalog, not from
   files inside the candidate snapshot.
   Never initialize, enroll, modify, or delete ledger records during recovery.
5. Start one replica with both restored paths. Startup refuses a missing ledger
   when account databases already exist and removes restored account generations
   covered by tombstones before serving requests.
6. Verify `/readyz`, `/healthz`,
   `/metrics`, authentication, bootstrap, sync, and SSE.
7. Resume traffic gradually and monitor 409/429/5xx rates and sync latency.
8. Record the recovery point, affected interval, validation evidence, and any
   retained backup copies without logging account or task content.
