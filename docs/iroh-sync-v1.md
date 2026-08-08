# Pomodorough Iroh Sync Protocol v1

Status: implementation contract for native clients

Iroh version: `iroh-ffi` 1.1.x over the stabilized Iroh 1.x endpoint API

ALPN: `me.egigoka.pomodorough/sync/1`

## Goals

- Keep every client fully usable without any network.
- Add an optional equal-peer replica without replacing local persistence or reducers.
- Keep centralized Pomodorough sync available as a separate replication mode.
- Preserve immutable operation IDs and the canonical reducer order already used by the server.
- Authenticate room membership in addition to Iroh's endpoint identity.

## Non-goals

- This protocol does not run an Iroh relay inside `pomodorough-server`.
- It does not reuse server revisions, bearer tokens, SSE, bootstrap CAS, or server time.
- It does not expose an endpoint secret key or use an endpoint ticket as authorization.
- It does not promise background synchronization while a mobile app is suspended.

## Replication modes

Each client stores one device-local mode:

- `offline`: no remote endpoint is started. Local writes, timers, alarms, and projections continue normally.
- `iroh`: local writes are copied to a room operation log and exchanged with room peers.
- `centralized`: existing authenticated HTTPS and SSE synchronization remains unchanged.

Mode is not synchronized. Switching mode must not sign out, clear domain data, dequeue
central operations, or delete an Iroh room log. A client may only run one remote replication
loop at a time. Central outboxes and Iroh room logs are independent.

An Iroh room has a fixed genesis projection. Creating a room seeds genesis from the
creator's current local projection. Joining an existing room stores the device's previous
projection before activating the room projection; leaving the room restores that local
projection. This avoids silently replacing offline or centralized history. v1 does not merge
two independently established genesis projections.

## Iroh transport

Endpoints use the n0 production preset unless the user supplies a custom relay
configuration. Iroh authenticates every connection's Ed25519 endpoint ID. Pomodorough then
authenticates every protocol frame with the room secret.

Direct connections expose peer IP addresses to each peer. Relay connections are end-to-end
encrypted, but relay operators can observe endpoint IDs, IP addresses, timing, and transfer
volume. Endpoint tickets can contain addresses and must be treated as sensitive capability
metadata even though the ticket alone cannot join a room.

Clients persist a stable endpoint secret key in platform secure storage. They never put that
key in an invite, log, diagnostic, or synchronized record.

## Room identity and invites

Room secret: 32 cryptographically random bytes.

Room ID:

```text
base64url-no-pad(SHA-256("pomodorough-room-v1\0" || room-secret))
```

Invite text:

```text
pomodorough1.<base64url-no-pad(UTF-8 JSON)>
```

Invite JSON has exactly these fields:

```json
{
  "v": 1,
  "roomId": "base64url SHA-256 digest",
  "roomName": "Design desk",
  "endpointTicket": "endpoint...",
  "roomSecret": "base64url 32-byte secret"
}
```

`roomName` is optional, contains 1 through 64 Unicode scalar values when present, and is
display-only. `endpointTicket` is at most 16 KiB. Decoders reject unknown fields, malformed
base64url, duplicate object keys at any nesting depth, malformed Unicode scalar sequences,
wrong secret length, a room ID mismatch, or any version other than 1. Optional fields are
omitted rather than encoded as `null`. The Iroh binding must parse the endpoint ticket and
confirm its endpoint ID before dialing.

An invite grants full room read/write access. v1 has no member revocation. To remove a member,
create a new room with a new secret and invite only retained members.

## Framing and authentication

Every QUIC bidirectional stream carries one request frame followed by one response frame.
A frame is:

```text
4-byte unsigned big-endian body length
32-byte HMAC-SHA-256
body-length bytes of UTF-8 JSON
```

Maximum body length is 16 MiB. The MAC input is:

```text
"pomodorough-iroh-frame-v1\0" || body
```

The HMAC key is the 32-byte room secret. Receivers read the bounded length, read exactly one
MAC and body, verify HMAC in constant time, then decode JSON while rejecting unknown fields.
They require stream EOF immediately after the body and reject trailing bytes. JSON decoding
rejects duplicate object keys recursively and malformed UTF-8 or Unicode scalar sequences.
No canonical JSON is required for frame authentication because the exact transmitted bytes are
authenticated.

## Connection handshake

The dialing peer opens the first bidirectional stream and sends `hello`. Before a successful
hello exchange, both peers reject every other request on that connection.

```json
{
  "protocolVersion": 1,
  "roomId": "...",
  "requestId": "UUIDv7",
  "kind": "hello",
  "deviceId": "...",
  "endpointTicket": "endpoint...",
  "platform": "ios|macos|android|linux|windows",
  "displayName": "Optional device label"
}
```

The receiver verifies:

1. Frame MAC and room ID.
2. `protocolVersion == 1` and `kind == "hello"`.
3. ID syntax and field limits.
4. Parsed `endpointTicket` ID equals the authenticated Iroh connection remote ID.

It returns its own `hello` body with the same `requestId`. Each side stores the latest valid
ticket for that endpoint. A room address book may contain at most 64 peers. Receiving a valid
ticket does not bypass the room-secret handshake on later connections.

## Anti-entropy RPCs

After handshake, either peer may open streams and issue RPCs. A peer periodically pulls until
one full inventory scan yields no missing or conflicting entries.

### Inventory

Request:

```json
{
  "protocolVersion": 1,
  "roomId": "...",
  "requestId": "UUIDv7",
  "kind": "inventory",
  "after": null,
  "limit": 1024
}
```

Response:

```json
{
  "protocolVersion": 1,
  "roomId": "...",
  "requestId": "UUIDv7",
  "kind": "inventoryResult",
  "entries": [
    {"domain": "timer", "id": "command-...", "digest": "base64url SHA-256"}
  ],
  "next": "timer\u0000command-..."
}
```

Entries are sorted by UTF-8 byte order of `(domain, id)`. `after` is exclusive. `limit` is 1
through 1024. `next` is null at end of scan. Domains are `genesis`, `timer`, `task`,
`duration`, and `autoStart`.

Digest is SHA-256 of RFC 8785 JSON Canonicalization Scheme bytes for the complete stored
record, including `domain` and origin `deviceId`. Same `(domain, id)` with a different digest
is an immutable-ID conflict. Clients keep both local data and the conflict evidence, stop
Iroh replication for that room, and show a repair action. They never select one payload by
arrival order.

### Operations

Request contains at most 255 inventory references. This leaves enough frame capacity for 255
maximum-size records plus the response envelope:

```json
{
  "protocolVersion": 1,
  "roomId": "...",
  "requestId": "UUIDv7",
  "kind": "operations",
  "refs": [{"domain": "timer", "id": "command-..."}]
}
```

Response:

```json
{
  "protocolVersion": 1,
  "roomId": "...",
  "requestId": "UUIDv7",
  "kind": "operationsResult",
  "records": [
    {
      "domain": "timer",
      "deviceId": "device-...",
      "operation": {
        "id": "command-...",
        "deviceSequence": 12,
        "timerId": "timer-...",
        "type": "pause",
        "phase": "focus",
        "plannedDurationMs": 1500000,
        "occurredAt": "2026-07-15T17:00:00.125Z",
        "hlcWallMs": 1784134800125,
        "hlcCounter": 0,
        "observedElapsedMs": 420125
      }
    }
  ]
}
```

The response must contain every requested record exactly once and no unrequested record.
Unknown references produce an authenticated `error` response rather than a partial result.
Clients validate the complete response and commit all new immutable records atomically before
updating projections.

## Operation schemas and reduction

Timer, task, duration, and auto-start operation objects use the existing centralized wire
fields documented in `web/openapi.yaml`. The Iroh wrapper adds origin `deviceId`; it is not
inferred from the current connection because peers forward records created by other peers.

Validation retains existing ID, safe-integer, duration, phase, task-title, occurrence/HLC
agreement, and immutable-payload rules. Peer validation does not compare `hlcWallMs` with the
receiver's current wall clock because different receivers must accept the same immutable set.
Room members therefore share write authority and can introduce a far-future clock; rotating
the room is the v1 recovery mechanism for a malicious member.

All domains reduce in total order:

```text
(hlcWallMs, hlcCounter, deviceId UTF-8 bytes, operation id UTF-8 bytes)
```

`deviceSequence` remains a per-device uniqueness constraint and never determines cross-device
order. Reducer behavior, deterministic task IDs, history semantics, and LWW preference rules
remain identical to centralized sync. Time-driven timer completion is a local projection and
does not create a shared revision.

Genesis is one immutable record with ID `genesis` and contains the creator's validated
canonical timer, history, tasks, durations, automatic-break preference, and maximum HLC. Its
digest is part of every inventory. A room with a missing or conflicting genesis is invalid.
The canonical timer retains its explicit starter when present. Genesis history has no starter
field in v1, so a later resume attributes those seeded sessions to the genesis origin device;
all replicas use this deterministic fallback.

## Limits and errors

- Frame JSON: 16 MiB.
- Inventory page: 1024 entries.
- Pre-authentication hello frame: 32 KiB.
- Operation request: 255 references.
- Operation record JSON: 64 KiB.
- Room peers: 64.
- Display name: 64 Unicode scalar values.
- Device ID, operation ID, timer ID, and task ID: existing 8 through 128 byte syntax.

Errors use `kind: "error"`, the original `requestId`, a stable machine code, a plain-language
message, and `retryable`. Stable codes are `bad_frame`, `unauthorized`, `wrong_room`,
`unsupported_version`, `invalid_request`, `not_found`, `immutable_conflict`, `limit`, and
`internal`.

Malformed or unauthenticated input closes the stream without an error body. Authentication
failures never reveal whether a room exists.

## Scheduling

- Local mutations persist first, project immediately, then signal peer sync.
- Desktop peers listen while Iroh mode and app process are active.
- Mobile peers listen and dial while foreground-active. v1 does not require a foreground
  service or background execution entitlement.
- Retry uses exponential backoff with jitter, capped at 60 seconds.
- No online peer is not an error: writes remain durable and sync when another member is online.

## Compatibility

Iroh 1.x endpoint compatibility and this ALPN version are separate. A client may update its
Iroh 1.x dependency without changing this protocol. Breaking application changes require a
new ALPN suffix and invite version. Readers ignore no unknown fields in v1; additions require
a protocol version change.

## Interoperability vectors

These fixed values are shared regression vectors for all clients. Hex uses lowercase digits.

- Room secret: bytes `00` through `1f` inclusive.
- Room ID: `Z_qLtnvZQsi-d2Giw1lvj7yy1x20hyE4jUgODkFsQBs`.
- Frame body: `{"kind":"hello"}`.
- Complete authenticated frame hex:
  `00000010d9f01510c6ce30066f8318494a013c47657387a9bc3bbb81625b3cd74569d8377b226b696e64223a2268656c6c6f227d`.
- Canonical record:
  `{"deviceId":"device-test0001","domain":"autoStart","operation":{"enabled":true,"hlcCounter":0,"hlcWallMs":1000000,"id":"auto-start-operation-peer0001","occurredAt":"1970-01-01T00:16:40Z"}}`.
- Canonical record SHA-256 base64url digest:
  `ViRTrF---kkCpXCRyxUvXbeZSas4Iyal_dtSbi4TTzE`.
