# PWA Core 0.46 migration status

The PWA embeds the immutable official Core 0.46 artifact. Current workspace, preference, completion, and ownership routes use Core planners. The migration is not complete or release-qualified. Four canonical natural-expiry scenarios still fail, and legacy metadata migration contracts remain unresolved.

## Official artifact

- Release: `v0.46.0` from `Pomodoro-Everywhere/pomodorough-core`.
- Source commit: `4c16270f2da6f4a65a2813070670f2ac98624ad0`.
- Artifact: `pomodorough_core.wasm`, 2,790,028 bytes.
- SHA-256: `55cbddc547933a75a4f20dbf46bbfab9f1274689c2f1a8b631af3e6d8a2815a4`.
- Attested workflow: `.github/workflows/release.yml`, invocation `37183018037`, attempt 1.

`gh release download` supplies the artifact. Checksum and attestation verification bind the bytes to the immutable release, exact source commit, and release workflow. Both embedded copies match the download. No local Core build supplies either copy.

Generated browser metadata, CI pins, nightly pins, release pins, cache URLs, and readiness digests use that artifact. The client version remains unchanged.

## Core-owned decisions

- `workspace.intent.v1` constructs timer intents, phase selection, task mutations, task selection with retarget, duration mutations, and auto-start mutations.
- `workspace.completionMutation.v1` constructs manual and automatic Finish, generated Start, direct dependencies, phase selection, completion records, and ownership writes.
- `workspace.ownershipPlan.v1` decides missing-owner installation, lease admission and renewal, stale-owner removal, and the complete ordered owner-write sequence.
- `workspace.project.v1` selects display queues from the canonical base, retained queues, covering head, delivery proof, and dependency metadata.
- `workspace.readModel.v1` supplies elapsed time, countdown, progress, available timer intents, cadence, and task totals.
- `clock.observe.v1` processes raw wall and monotonic observations and server timing samples.
- `bootstrap.workspacePlan.v1` classifies raw persisted local records and remote state.
- `sync.batchPlan.v1` selects retained IDs, ordering, limits, dependency barriers, and the next domain cursor.
- `timer.completionState.v1` decides rejected-Finish selection from transaction-time records and acknowledgements.
- `reconcile.rebase.v3` accepts raw terminal timer/history pairs and returns the retained workspace.
- `hlc.head.v1` preserves response maximum-merge semantics. `hlc.tick.v1` supplies allocation clocks.

The browser owns IndexedDB, account and connection fences, immutable request bytes, transport, entropy, calendar observations, DOM rendering, localization, audio, notifications, and scheduling.

## Ownership transaction

Heartbeat renewal reads all five queues, the canonical base, actual owner, head, proof, and raw display context inside the existing guarded transaction. It dispatches the complete raw ownership request. The adapter executes every returned write in order and exposes `renewed` only after commit.

Canonical acceptance supplies the raw accepted base with Core-reconciled queues and context. Stale acceptance supplies the actual stored workspace. Existing issuer, revision, account-incarnation, bootstrap-gate, and captured-claim checks remain in place.

Core preserves absent and null legacy owner fields without host normalization. Corrupt owner arrays and unknown fields fail closed. Missing-owner renewal retains both identical owner writes. Explicit terminal state removes an orphan owner through Core's returned instruction.

PWA08 retains its issuing account/database/generation scope across dispatch and completion. A stale success or error cannot quarantine or report replacement state. Overlapping ticks share the issuing resource guard. Only a later independent tick captures replacement scope.

## Atomic workspace and exact retry

A planned mutation commits all new durable members, retired duration IDs, proof, selection, allocation, observations, dependencies, raw display context, ownership, completion records, and group records in one transaction. Core effects run only after commit and an issuer check. The optimistic projection never becomes the canonical base.

Saved outgoing request strings and captured arrays remain exact across retries, later edits, and cold restore. Claim comparison still includes the complete captured metadata. Possibly delivered requests cannot gain reconstructed bodies, moved timestamps, replacement IDs, or invented non-delivery proof.

Legacy duration preferences now enter `workspace.intent.v1` as raw minute requests. Core validates their range, builds operations, and allocates clocks. The transaction retains existing groups, completion records, peer settings, and outgoing claims. An invalid later phase rolls back the entire migration group.

Legacy duration queue transfer still copies original payloads exactly. A different payload under an existing ID aborts. Epoch wire conversion requires durable non-delivery proof and cannot rewrite a possibly delivered request.

## Retired production code

The removal pass verifies the production call closure before deletion. It removes 48 declarations, including the old allocation and completion transaction families, generated Start builders, missing-owner predicates, unused prospective validators, unused resolution builders, state-presence classifiers, completion counting, and local clock decision functions.

Tests use public Core planner transactions instead of these deleted entrypoints. Fault injection targets the actual dispatcher or IDB writes. Historical UUIDv4 records remain retained while newly planned commands use Core-validated UUIDv7 candidates. Direct follow-up dependencies come from Core's graph.

## Verification

The configured web suite runs 981 tests. It passes 977 and fails four, with no cancellations or skips. The four failures are the canonical natural-expiry scenarios below. The previous 20 offline and peer-preference failures are resolved.

The preserved PWA01, PWA02, PWA03, PWA08, workspace parity, and actual local Go HTTP suite passes 241 tests. New raw ownership and legacy duration coverage passes 20 tests. Complete receipts include raw requests, decoded inputs, Core returns, actual owner-write order, and all persisted stores.

The browser runs the shipped HTML, JavaScript, official WASM, and browser-native IndexedDB in an isolated local route. It verifies keyboard Start, Pause, Resume, Finish, task submission, skip-link focus, generated 600000 ms short breaks, generated 1800000 ms long breaks, peer-disabled auto-start, selected-task visibility, exact saved claims, cold restore, and account teardown. Fifteen observations have no page errors. No synchronization service request leaves the local route.

Every Go package passes. The server Python suite passes 76 tests. JavaScript syntax, Python compilation, provenance comparison, generated metadata, and readiness checks pass. The size audit reports no violations and no new exceptions. Complexity reports and the complete incremental diff remain in the checker packet.

## Remaining Core contracts

### Explicit Finish after canonical natural expiry

`workspace.completionMutation.v1` returns `noop` with `staleTimer` for a canonical completed timer whose last intent is Start and whose natural history row has no Finish command ID. Both manual and automatic requests fail the preserved explicit-Finish expectation. The four cases retain their assertions.

The raw request contains the actual canonical terminal pair, empty retained commands, actual owner, and cleaned observation metadata. No host clear, synthetic head, altered canonical timer, or fabricated Finish repairs the request. Core must either support this canonical natural-expiry transition or define its authoritative lifecycle replacement before these scenarios can be closed.

The frozen pre-increment public planner produces the same write-free `staleTimer` result for all four requests. The old direct storage completion tests hid this existing public-planner gap.

### Legacy dependency metadata

New mutations persist Core's dependency graph. Old installations can contain only embedded `dependsOnCommandId` and `generatedBreak`, without the separate graph or source-day bounds. The remaining `timerDependencies` and `localDayBounds` path reconstructs that legacy metadata.

Core 0.46 validates supplied dependency metadata but has no operation that migrates these incomplete raw legacy records. That migration contract must define source-day evidence and direct-parent interpretation without changing possibly delivered payloads. This active legacy path is not certified as Core-owned.

### Legacy explicit auto-start and selection

`migrateLegacyAutoStart` and `migrateLegacySelectedTask` preserve the old explicitness flags and zero-clock serializer contract. Normal workspace preference intents do not accept these legacy raw flags or promise their bootstrap precedence.

A Core migration operation must consume the original settings flags, canonical preferences, retained operations, and delivery metadata before these builders can be removed without changing history-resolution behavior. They remain in the residual inventory.

The checker packet lists every production declaration and line with a domain match, its adapter role, and these unresolved migration paths. The main backlog remains unchanged. Independent checker approval and a client release remain pending.
