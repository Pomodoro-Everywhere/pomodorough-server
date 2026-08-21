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

At minimum, alert on:

- `/healthz` failing for two consecutive checks;
- any sustained 5xx ratio above 1%;
- p95 `/api/v1/sync` or `/api/v1/bootstrap/resolve` latency above two seconds;
- sustained 409 growth, which indicates bootstrap/conflict pressure;
- sustained 429 growth, which can indicate abuse or undersized limits;
- no successful backup or restore drill within the expected interval.

## Backups

Back up the complete configured data directory, not individual open SQLite files.
Create a point-in-time copy with the SQLite backup API or stop the service while
copying. Encrypt backups, restrict access, and keep them outside the live host.
A live account deletion removes the live per-user database and sidecars; backups
follow the separately disclosed retention schedule and are not rewritten in
place.

Record each backup's UTC timestamp, size, checksum, and exit status in the
monitoring system. A backup command must return nonzero when any database cannot
be copied or checked.

## Restore drill

Run at least weekly and before releases:

```sh
source_db=/path/to/backup/user.sqlite3
restored_db="$(mktemp -d)/restored.sqlite3"
python3 scripts/restore_drill.py "$source_db" "$restored_db"
```

The drill runs `PRAGMA integrity_check`, copies through SQLite's backup API, and
checks the restored database. Use a disposable restore directory and never point
the drill at the live destination. CI and release workflows also exercise a
synthetic restore; that protects the tooling but does not replace periodic drills
against authentic encrypted backups.

## Recovery

1. Stop the service or route traffic away from the affected replica.
2. Preserve the damaged data directory for diagnosis.
3. Restore into a new directory and run `scripts/restore_drill.py` against every
   restored user database.
4. Start one replica against the restored directory and verify `/healthz`,
   `/metrics`, authentication, bootstrap, sync, and SSE.
5. Resume traffic gradually and monitor 409/429/5xx rates and sync latency.
6. Record the recovery point, affected interval, validation evidence, and any
   retained backup copies without logging account or task content.
