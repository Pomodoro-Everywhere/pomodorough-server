# PWA Core migration status

Updated 2026-11-12. The PWA embeds official Core 0.56.0. Workspace decisions, legacy preference and dependency migration, completion lifecycle, and ownership release use Core planners. This inventory replaces the historical Core 0.46 snapshot; it is not independent release acceptance.

## Embedded artifact

- Release: `v0.56.0` from `Pomodoro-Everywhere/pomodorough-core`.
- Source commit: `f3ab43a348d4e17bb32b61b8325664351e2ed70e`.
- Both `web/pomodorough_core.wasm` and `internal/sharedcore/pomodorough_core.wasm` have SHA-256 `f57b411f47ef614e78ebb1ed4aea9ae58e0f1156b385c25222ee5c006837ebfd`.
- `internal/sharedcore/CORE_COMMIT`, generated browser metadata, and readiness provenance identify the bundled artifact. Run `python3 scripts/generate_shared_core_metadata.py --check` and the configured provenance checks when changing it.

Do not substitute a local build or update provenance independently of the artifact. The application version and Core version remain separate contracts.

## Core-owned decisions and browser responsibilities

| Core operation | Decision |
| --- | --- |
| `workspace.intent.v1` | Timer, phase, task, selection, duration, and auto-start mutations. |
| `workspace.completionMutation.v1` | Finish, generated Start, dependency graph, completion evidence, and ownership writes. |
| `workspace.ownershipPlan.v1` | Installation, renewal, stale removal, explicit release, and ordered owner writes. |
| `workspace.project.v1`, `workspace.readModel.v1` | Retained projection, elapsed time, countdown, cadence, available intents, and task totals. |
| `workspace.legacyPreferences.v1` | Original explicitness flags, numeric tokens, and zero-clock preference precedence. |
| `workspace.legacyDependencyPlan.v1` | Direct-parent legacy dependency migration or fail-closed recovery when provenance is incomplete. |
| `clock.observe.v1` | Raw wall/monotonic observations and server timing samples. |
| `bootstrap.workspacePlan.v1` | Raw persisted local records and remote-state classification. |
| `sync.batchPlan.v1` | Retained IDs, ordering, limits, dependency barriers, and domain cursor. |
| `timer.completionState.v1`, `reconcile.rebase.v3` | Completion selection, terminal pairs, acknowledgements, and retained workspace. |
| `hlc.head.v1`, `hlc.tick.v1` | Response maximum merge and allocation clocks. |

The browser owns IndexedDB transactions, account/connection fences, immutable request bytes, transport, entropy, calendar observations, DOM rendering, localization, audio, notifications, and scheduling. Browser adapters execute Core results; they do not replace Core decisions.

## Durable transaction and retry boundaries

Ownership and mutation adapters read the actual guarded workspace and apply every returned write in order. Effects run only after commit and an issuer check. Stale callbacks cannot affect a replacement account/database/generation. The optimistic projection never becomes the canonical base.

Saved outgoing bodies and captured arrays remain exact across retries, edits, and cold restore. Migration cannot reconstruct a possibly delivered request, replace its identity or timestamp, or invent non-delivery proof. Invalid migration inputs roll back rather than partially changing queues.

Legacy dependency migration changes complete metadata only. Missing source evidence returns blocked recovery with queues and saved claims unchanged. Legacy preference migration preserves original flags and zero-clock precedence, including unknown numeric extensions.

## Regression inventory

These are current executable coverage locations, not a claim that every browser/device matrix has run:

- `web/core-pwa046-migration.test.js`: raw Core input/return parity, original flags, numeric preservation, immutable claims, direct dependency migration, incomplete-provenance recovery, repeated migration, durable Finish evidence, reopen, selection generation, and fabricated-marker rejection.
- `web/p222-completion-atomicity.test.js` and related completion suites: canonical natural expiry and explicit Finish through the public planner. The old statement that four canonical natural-expiry tests still fail is superseded; retain these assertions rather than restoring host-side completion policy.
- `web/core-pwa02-account-effects.test.js` and `web/core-pwa02-final-callbacks.test.js`: delayed committed effects, stale success/error callbacks, account teardown, and replacement resource fences.
- `web/sync-storage.js`: dispatch sites for `workspace.legacyPreferences.v1`, `workspace.legacyDependencyPlan.v1`, and ownership `release` are the adoption boundary.

The earlier claim that Core lacks legacy preference/dependency operations is obsolete. Test filenames retain historical identifiers; they do not pin the runtime to Core 0.46.

## Qualification still required

Run `npm run check:web`, `npm run test:web`, and `go test ./...` on the exact final tree. Readiness digest checks must match changed web assets. A nested `scratch/go.mod` excludes local overlay packages from the application module without excluding `cmd` or `internal` packages.

Full-route cancellation timing, rendered RTL/zoom/fold matrices, live Sentry delivery, hosted CI, and downloaded release verification are separate evidence. Broader cross-client migration acceptance remains with the respective platform owners. This document does not close those gates or authorize publication.
