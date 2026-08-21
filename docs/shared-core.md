# Shared-core server integration

The server runs the same Rust WebAssembly reducer as the clients and browser. Go still owns authentication, request limits, SQLite transactions, revisions, idempotency, bootstrap request hashing, and HTTP responses.

## Authoritative behavior

`internal/store/reduceAccount` calls the shared core for:

- timer reduction;
- task projection;
- duration projection;
- auto-start projection;
- selected-task projection.

`internal/server/parseOperations` calls `task.SharedIdentities` for task title normalization and deterministic task IDs. A request's task identities are dispatched through one isolated module instance, including the 4,096-operation bootstrap boundary.

The existing Go reducers remain as differential oracles. The Rust output is authoritative, but every production reduction is compared with its Go oracle before persistence; divergence fails the surrounding transaction closed rather than falling back to and committing native output.

## Runtime boundary

`internal/sharedcore.Core` compiles the embedded module once. Each call or batch creates one module instance and closes it after dispatch. This keeps linear memory separate between requests while avoiding thousands of interpreter instantiations for a maximum-size task bootstrap.

The host enforces these limits:

- 256-byte operation names;
- 16 MiB JSON inputs and outputs;
- 256 MiB linear memory per instance, enforced both by the module's declared maximum and the wazero host;
- four concurrent module instances.

A canceled request stops while it waits for a slot or while WebAssembly runs. The host returns traps and malformed output as Go errors. The store does not fall back to the Go reducer because a fallback could commit different state.

The runtime uses wazero's interpreter backend. In local verification, wazero 1.12.0's amd64 compiler backend changed bytes in timestamp strings returned by the release Rust module. The interpreter returned byte-identical UTF-8 and passed the differential and race tests.

## Artifact provenance

The repository stores the artifact and its provenance in:

```text
internal/sharedcore/pomodorough_core.wasm
internal/sharedcore/CORE_COMMIT
internal/sharedcore/pomodorough_core.wasm.sha256
```

CI checks out the commit from `CORE_COMMIT`, builds the module with the pinned Rust toolchain, and validates the rebuilt module's portable contract: bounded 32-bit memory and the required ABI exports. It separately verifies the committed release artifact's SHA-256 digest and requires the embedded and browser copies to be byte-identical. A rebuild is not compared byte-for-byte across runner operating systems because Rust's host-side compilation can produce different but contract-equivalent `wasm32-unknown-unknown` code ordering. The browser loader and service-worker shell use the committed artifact digest in the URL so ordinary HTTP caches cannot retain an older module.

## Verification

Run the focused gates:

```sh
go test ./internal/sharedcore ./internal/store
go test -race ./internal/sharedcore ./internal/store
```

Run all server and browser checks:

```sh
go test ./...
npm run test:web
npm run check:web
python3 scripts/check_workflow_pins.py
```
