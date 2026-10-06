"use strict";

// Regression coverage for the immutable `reconcile.rebase.v2` web-client
// contract: separate Core-owned retarget operations, durable never-sent
// proof retired before possible delivery, exact outgoing payload retention,
// atomic canonical snapshot + covering HLC persistence, and
// projectionPending-safe optimistic state. Retarget never rewrites a pending
// Start and never overlays canonical history or task totals.
//
// Reconcile paths run against the repinned Core v0.47.0 WASM, which natively
// implements `reconcile.rebase.v2`.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { indexedDB } = require("fake-indexeddb");
const sync = require("./sync-core.js");
const storage = { ...require("./sync-storage.js"), ...require("./test/core-planner-storage-fixture.js") };
const { SharedCore } = require("./shared-core.js");
const appStorage = require("./app-storage.js");
const appSync = require("./app-sync.js");

const SERVER_TIME = "2026-07-22T12:30:00Z";
const SERVER_HEAD = { wallMs: Date.parse(SERVER_TIME), counter: 7 };
const USER = { id: "user-1" };
const DURATION_USER = { ...USER, accountIncarnation: "a".repeat(64) };
const DURATION_OWNER = sync.accountOwnerId(DURATION_USER);

let databaseSequence = 0;

function emptyQueues() {
  return { commands: [], taskOperations: [], durationOperations: [],
    autoStartOperations: [], selectedTaskOperations: [] };
}

function emptyProof() {
  return { commands: [], taskOperations: [], durationOperations: [],
    autoStartOperations: [], selectedTaskOperations: [] };
}

function timerCommand(id, sequence, timerId, type, fields = {}) {
  return {
    id, deviceId: "device-1", deviceSequence: sequence, timerId, type,
    phase: "focus", plannedDurationMs: 1_500_000,
    occurredAt: "2026-07-22T12:00:00Z", hlcWallMs: sequence, hlcCounter: 0,
    observedElapsedMs: 0, ...fields
  };
}

function canonicalSnapshot(revision = 1) {
  return {
    revision, serverTime: SERVER_TIME, canonicalTimer: null, history: [],
    tasks: [], durationsMs: { focus: 1_500_000, short_break: 300_000, long_break: 900_000 },
    autoStartBreaks: false, selectedTaskId: null, user: { ...USER }
  };
}

function canonicalResponse(snapshot, acknowledgements = []) {
  return {
    ...snapshot, acknowledgements, taskAcknowledgements: [], durationAcknowledgements: [],
    autoStartAcknowledgements: [], selectedTaskAcknowledgements: [],
    serverHlcWallMs: SERVER_HEAD.wallMs, serverHlcCounter: SERVER_HEAD.counter
  };
}

function openDatabase(name = `pomodorough-immutable-${(databaseSequence += 1)}`) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("meta", { keyPath: "key" });
      request.result.createObjectStore("pending", { keyPath: "id" });
      request.result.createObjectStore("pendingTasks", { keyPath: "id" });
      request.result.createObjectStore("pendingDurations", { keyPath: "id" });
      request.result.createObjectStore("pendingAutoStarts", { keyPath: "id" });
      request.result.createObjectStore("pendingSelectedTasks", { keyPath: "id" });
    };
    request.onsuccess = () => resolve({ database: request.result, name });
    request.onerror = () => reject(request.error);
  });
}

async function reopenDatabase(name) {
  const opened = await openDatabase(name);
  return opened.database;
}

async function seedMeta(database, values) {
  const transaction = database.transaction("meta", "readwrite");
  for (const [key, value] of Object.entries(values)) transaction.objectStore("meta").put({ key, value });
  await storage.transactionDone(transaction);
}

async function seedSnapshot(database) {
  await seedMeta(database, {
    snapshot: { ...canonicalSnapshot(0), serverTime: "2026-07-22T12:00:00Z" },
    hlc: { wallMs: 1, counter: 0 }
  });
}

async function allocateTimer(database, build) {
  return storage.allocateMutation(database, {
    expectedUserId: "user-1", storeName: "pending", requireProjection: true,
    nowMs: Date.parse("2026-07-22T12:10:00Z"),
    withDeviceSequence: true, withUuidV7: true, build
  });
}

function startBuild(timerId, taskId) {
  return ({ id, wallMs, counter, deviceSequence }) => ({
    id, deviceId: "device-1", deviceSequence, timerId, type: "start",
    phase: "focus", plannedDurationMs: 1_500_000,
    occurredAt: new Date(wallMs).toISOString(), hlcWallMs: wallMs, hlcCounter: counter,
    observedElapsedMs: 0, ...(taskId === undefined ? {} : { taskId })
  });
}

function applyInput(snapshot, sent, response, validatedIds, capturedClaim) {
  return {
    capturedClaim,
    expectedUserId: "user-1", snapshot,
    hlc: { wallMs: SERVER_HEAD.wallMs, counter: SERVER_HEAD.counter },
    serverHlc: { ...SERVER_HEAD }, clockOffset: null,
    queueIds: validatedIds,
    timerOwnerClaim: { deviceId: "device-1", tabId: "tab-1", nowMs: Date.now(), leaseMs: 60_000 },
    reconciliation: { sent, response, deviceId: "device-1" }
  };
}

async function captureClaim(database) {
  await seedMeta(database, { deviceId: "device-1" });
  return storage.claimWorkspaceBatch(database, {
    ownerId: sync.accountOwnerId(USER), deviceId: "device-1", localNowMs: Date.now()
  });
}

function ackIds(validated) {
  return {
    commands: [...validated.commands.acknowledgedIds],
    taskOperations: [...validated.tasks.acknowledgedIds],
    durationOperations: [...validated.durations.acknowledgedIds],
    autoStartOperations: [...validated.autoStart.acknowledgedIds],
    selectedTaskOperations: [...validated.selectedTask.acknowledgedIds]
  };
}

test.before(async () => {
  globalThis.crypto ||= crypto.webcrypto;
  const bytes = fs.readFileSync(path.join(__dirname, "pomodorough_core.wasm"));
  storage.setSharedCore(await SharedCore.fromBytes(bytes));
});

test("delayed success consumes acknowledgements with the covering head", async (t) => {
  const { database, name: databaseName } = await openDatabase();
  t.after(() => database.close());
  await seedSnapshot(database);
  const start = await allocateTimer(database, startBuild("timer-delayed", "task-original"));
  const queues = await storage.readSyncState(database);
  assert.deepEqual(queues.deliveryProof.commands, [start.id]);
  const sent = sync.buildSyncBatch({ ...emptyQueues(), commands: queues.commands });
  const retired = await captureClaim(database);
  assert.deepEqual(retired.proof.commands, []);
  const snapshot = canonicalSnapshot(1);
  const response = canonicalResponse(snapshot, [{ commandId: start.id, outcome: "applied", reason: "" }]);
  const validated = sync.validateCanonicalResponse(response, sent);
  const rebased = storage.reconcileState({
    queues: { ...emptyQueues(), commands: queues.commands },
    sent, response, deviceId: "device-1",
    deliveryProof: retired.proof
  });
  assert.deepEqual(rebased.queues.commands, []);
  await storage.applySyncResponse(database, applyInput(snapshot, sent, response, ackIds(validated), retired.claim));
  const after = await storage.readSyncState(database);
  assert.deepEqual(after.commands, []);
  assert.equal(after.snapshot.revision, 1);
  assert.deepEqual(after.canonicalHead, SERVER_HEAD);
  assert.equal(after.outgoing, null);
});

test("lost response retry resends the exact persisted payload", async (t) => {
  const { database, name: databaseName } = await openDatabase();
  t.after(() => database.close());
  await seedSnapshot(database);
  const start = await allocateTimer(database, startBuild("timer-lost", "task-original"));
  const queues = await storage.readSyncState(database);
  const sent = sync.buildSyncBatch({ ...emptyQueues(), commands: queues.commands });
  const retired = await captureClaim(database);
  const stored = await storage.readSyncState(database);
  assert.ok(stored.outgoing?.sent);
  assert.deepEqual(stored.outgoing.sent.commands, sent.commands);
  const rebuilt = sync.buildSyncBatch({ ...emptyQueues(), commands: stored.commands });
  assert.deepEqual(rebuilt.commands, stored.outgoing.sent.commands);
  assert.equal(storage.outgoingMatchesStored(stored.outgoing, rebuilt), true);
  const snapshot = canonicalSnapshot(1);
  const response = canonicalResponse(snapshot, [{ commandId: start.id, outcome: "applied", reason: "" }]);
  const validated = sync.validateCanonicalResponse(response, sent);
  await storage.applySyncResponse(database, applyInput(snapshot, sent, response, ackIds(validated), retired.claim));
  assert.deepEqual((await storage.readSyncState(database)).commands, []);
});

function durationClient(database, postMutation, tabId = "tab-1") {
  const state = {
    user: { ...DURATION_USER }, localOwnerId: DURATION_OWNER, deviceId: "device-1", revision: 0,
    ready: true, sessionIdentityValidated: true, authenticated: true, csrfToken: "csrf",
    selectedPhase: "focus", history: [], hlcWallMs: 1, hlcCounter: 0, clockOffset: null,
    pending: [], pendingTaskOperations: [], pendingDurationOperations: [],
    pendingAutoStartOperations: [], pendingSelectedTaskOperations: []
  };
  const warnings = [];
  const host = {
    crypto: crypto.webcrypto, navigator: { onLine: true },
    setTimeout: () => 1, clearTimeout: () => {}, console: { warn: (...args) => warnings.push(args) }
  };
  const use = {
    captureAccountContext: () => require("./app-state.js").create({ state, external: { host, syncCore: sync, syncStorage: storage }, use })
      .captureAccountContext(),
    assertExpectedAccount: (owner) => assert.equal(owner, DURATION_OWNER),
    quarantineAccountMismatch: () => {}, tabId: () => tabId,
    trustedNow: () => Date.parse("2026-07-22T12:10:00Z"),
    compareDurationOperations: sync.compareDurationOperations,
    render() {}, renderSyncStatus() {}, rebuildOptimisticState() {},
    tr: (_key, _values, fallback) => fallback, postMutation,
    clone: structuredClone, normalizeDurationsMs: (value) => value,
    emptyTimer: () => null, selectedDurationMs: () => 1_500_000,
    selectedPhaseAfterCommandAcknowledgements: (phase) => phase,
    snapshotValue: (value) => ({ ...value, user: { ...DURATION_USER } })
  };
  const external = { host, syncCore: sync, syncStorage: storage };
  const repository = appStorage.create({ state, external, use });
  repository.setDatabaseForTest(database);
  Object.assign(use, {
    database: repository.database, setInFlightDurationOperationIds: repository.setInFlightDurationOperationIds
  });
  const coordinator = appSync.create({ state, external, use, listen() {} });
  use.reloadPersistedState = async () => {
    await coordinator.refreshAllPendingOperations();
    state.revision = (await storage.readSyncState(database)).snapshot.revision;
  };
  return { repository, coordinator, state, warnings };
}

function lostDurationResponseTransport() {
  const posts = [];
  const accepted = new Map();
  const snapshot = canonicalSnapshot(0);
  const postMutation = async (url, body, owner) => {
    assert.equal(url, "/api/v1/sync");
    assert.equal(owner, DURATION_OWNER);
    const batch = JSON.parse(body);
    posts.push(batch);
    for (const operation of batch.durationOperations) {
      if (accepted.has(operation.id)) {
        assert.deepEqual(operation, accepted.get(operation.id), "retry preserves every wire field");
      } else {
        accepted.set(operation.id, operation);
        snapshot.durationsMs[operation.phase] = operation.durationMs;
        snapshot.revision += 1;
      }
    }
    if (posts.length === 1) throw new Error("response lost after server accepted duration");
    const payload = canonicalResponse(snapshot);
    payload.accountIncarnation = DURATION_USER.accountIncarnation;
    payload.durationAcknowledgements = batch.durationOperations.map((operation) => ({
      operationId: operation.id, outcome: "applied", reason: ""
    }));
    return { response: { ok: true, status: 200, json: async () => payload } };
  };
  return { posts, accepted, postMutation };
}

for (const reopen of [false, true]) {
  test(`R43-S01 lost duration response then edit drains exact retries, reopen=${reopen}`, async (t) => {
    const opened = await openDatabase();
    let database = opened.database;
    t.after(() => database.close());
    await seedSnapshot(database);
    const transport = lostDurationResponseTransport();
    await seedMeta(database, { snapshot: { ...canonicalSnapshot(0), user: DURATION_USER } });
    await seedMeta(database, { deviceId: "device-1", settings: { selectedPhase: "focus" } });
    let client = durationClient(database, transport.postMutation);
    const first = (await client.repository.persistDurationOperation("focus", 1_800_000)).operation;
    await client.coordinator.syncNow();
    assert.equal(transport.posts.length, 1);
    assert.equal(client.state.syncing, false);
    assert.equal(client.state.retrying, true);
    const outgoing = (await storage.readSyncState(database)).outgoing;
    const second = (await client.repository.persistDurationOperation("focus", 2_100_000)).operation;
    const edited = await storage.readSyncState(database);
    if (reopen) {
      database.close();
      database = await reopenDatabase(opened.name);
      client = durationClient(database, transport.postMutation);
      assert.deepEqual(await storage.readSyncState(database), edited);
    }
    await client.coordinator.syncNow();
    assert.equal(transport.posts.length, 2, JSON.stringify(client.warnings.map((args) => String(args[1]))));
    assert.deepEqual(edited.durationOperations, [first, second]);
    assert.deepEqual(edited.outgoing, outgoing);
    assert.deepEqual(edited.deliveryProof.durationOperations, [second.id]);
    assert.deepEqual(transport.posts[1].durationOperations[0], transport.posts[0].durationOperations[0]);
    assert.deepEqual(transport.posts[1].durationOperations.map((item) => item.id), [first.id]);
    assert.deepEqual(transport.posts[1], transport.posts[0], "lost response replays the complete saved request exactly");
    const acceptedRetry = await storage.readSyncState(database);
    assert.equal(acceptedRetry.outgoing, null, JSON.stringify(client.warnings.map((args) => String(args[1]))));
    assert.deepEqual(acceptedRetry.durationOperations, [second]);
    await client.coordinator.syncNow();
    assert.equal(transport.posts.length, 3);
    assert.deepEqual(transport.posts[2].durationOperations.map((item) => item.id), [second.id]);
    assert.equal(transport.accepted.size, 2);
    assert.equal(client.state.retrying, false, JSON.stringify(client.warnings.map((args) => String(args[1]))));
    const drained = await storage.readSyncState(database);
    assert.deepEqual(drained.durationOperations, []);
    assert.equal(drained.outgoing, null);
    assert.equal(drained.snapshot.durationsMs.focus, second.durationMs);
    assert.equal(drained.snapshot.revision, 2);
  });
}

async function durationDatabase(t) {
  const opened = await openDatabase();
  t.after(() => opened.database.close());
  await seedSnapshot(opened.database);
  await seedMeta(opened.database, { snapshot: { ...canonicalSnapshot(0), user: DURATION_USER } });
  await seedMeta(opened.database, { deviceId: "device-1", settings: { selectedPhase: "focus" } });
  return opened;
}

const durationSupersessionCases = [
  { name: "durably never-sent same tab and phase", supersedes: true },
  { name: "missing proof", metadata: () => ({ deliveryProof: null }) },
  { name: "malformed proof", metadata: () => ({ deliveryProof: { durationOperations: "invalid" } }) },
  { name: "retired proof without outgoing", metadata: () => ({ deliveryProof: emptyProof() }) },
  { name: "outgoing reference overrides never-sent proof", metadata: (first) => ({
    outgoingSync: { sent: sync.buildSyncBatch({ ...emptyQueues(), durationOperations: [first] }) }
  }) },
  { name: "other tab", tabId: "tab-2" },
  { name: "other phase", phase: "short_break" },
  { name: "current in-flight operation", inFlight: true }
];

for (const scenario of durationSupersessionCases) {
  test(`R43-S01 duration supersession: ${scenario.name}`, async (t) => {
    const { database } = await durationDatabase(t);
    let client = durationClient(database, () => assert.fail("offline edit must not POST"));
    const first = (await client.repository.persistDurationOperation("focus", 1_800_000)).operation;
    if (scenario.metadata) await seedMeta(database, scenario.metadata(first));
    if (scenario.tabId) client = durationClient(database, null, scenario.tabId);
    if (scenario.inFlight) client.repository.setInFlightDurationOperationIds([first.id]);
    const before = await storage.readSyncState(database);
    const second = (await client.repository.persistDurationOperation(scenario.phase || "focus", 2_100_000)).operation;
    const after = await storage.readSyncState(database);
    assert.deepEqual(after.durationOperations, scenario.supersedes ? [second] : [first, second]);
    assert.deepEqual(after.outgoing, before.outgoing);
    assert.equal(second.hlcWallMs, first.hlcWallMs);
    assert.equal(second.hlcCounter, first.hlcCounter + 1);
    assert.equal(second.occurredAt, first.occurredAt);
    assert.ok(second.id > first.id, "UUID allocation order must survive supersession");
  });
}

test("R43-S01 peer proof retirement serializes before duration supersession", async (t) => {
  const { database, name } = await durationDatabase(t);
  const peer = await reopenDatabase(name);
  t.after(() => peer.close());
  const client = durationClient(database, null);
  const first = (await client.repository.persistDurationOperation("focus", 1_800_000)).operation;
  const sent = sync.buildSyncBatch({ ...emptyQueues(), durationOperations: [first] });
  const retirement = storage.retireProofAndPersistOutgoing(peer, sent, { ownerId: DURATION_OWNER });
  const edit = client.repository.persistDurationOperation("focus", 2_100_000);
  const [, { operation: second }] = await Promise.all([retirement, edit]);
  const after = await storage.readSyncState(database);
  assert.deepEqual(after.durationOperations, [first, second]);
  assert.deepEqual(after.deliveryProof.durationOperations, [second.id]);
  assert.deepEqual(after.outgoing.sent, storage.cloneOutgoing(sent));
});

test("R43-S01 ownership change aborts allocation and supersession atomically", async (t) => {
  const { database, name } = await durationDatabase(t);
  const peer = await reopenDatabase(name);
  t.after(() => peer.close());
  const client = durationClient(database, null);
  await client.repository.persistDurationOperation("focus", 1_800_000);
  const before = await storage.readSyncState(database);
  const snapshot = { ...before.snapshot, user: { ...DURATION_USER, accountIncarnation: "b".repeat(64) } };
  const ownershipChange = seedMeta(peer, { snapshot });
  await assert.rejects(client.repository.persistDurationOperation("focus", 2_100_000), storage.AccountOwnershipError);
  await ownershipChange;
  assert.deepEqual(await storage.readSyncState(database), { ...before, snapshot });
});

test("reload retains proof, head, projectionPending, outgoing, and exact payloads", async (t) => {
  const { database, name: databaseName } = await openDatabase();
  t.after(() => database.close());
  await seedSnapshot(database);
  const start = await allocateTimer(database, startBuild("timer-reload", "task-original"));
  const sent = sync.buildSyncBatch({ ...emptyQueues(), commands: [start] });
  await storage.retireProofAndPersistOutgoing(database, sent, { ownerId: sync.accountOwnerId(USER) });
  const before = await storage.readSyncState(database);
  database.close();
  const reopened = await reopenDatabase(databaseName);
  t.after(() => reopened.close());
  const after = await storage.readSyncState(reopened);
  assert.deepEqual(after.commands, before.commands);
  assert.deepEqual(after.deliveryProof, before.deliveryProof);
  assert.deepEqual(after.canonicalHead, before.canonicalHead);
  assert.deepEqual(after.projectionPending, before.projectionPending);
  assert.deepEqual(after.outgoing, before.outgoing);
  assert.deepEqual(after.outgoing.sent.commands, sent.commands);
  const neverSent = sync.neverSentForQueues(after.deliveryProof, { commands: after.commands }, sent);
  assert.deepEqual(neverSent.commands, []);
});

test("acknowledged Start leaves the retained retarget byte-identical and unprojected", () => {
  const start = timerCommand("command-start", 1, "timer-a", "start", { taskId: "task-original", hlcWallMs: 100 });
  const retarget = timerCommand("command-retarget", 2, "timer-a", "retarget", { taskId: "task-next", hlcWallMs: 200 });
  const local = { ...emptyQueues(), commands: [start, retarget] };
  const sent = { ...emptyQueues(), commands: [{ id: start.id }] };
  const snapshot = canonicalSnapshot(1);
  snapshot.canonicalTimer = {
    id: "timer-a", phase: "focus", status: "running", plannedDurationMs: 1_500_000,
    elapsedAtAnchorMs: 0, anchorAt: "2026-07-22T12:00:00Z",
    lastIntent: { type: "start", commandId: start.id, occurredAt: "2026-07-22T12:00:00Z" }
  };
  const response = canonicalResponse(snapshot, [{ commandId: start.id, outcome: "applied", reason: "" }]);
  const rebased = storage.reconcileState({
    queues: local, sent, response, deviceId: "device-1", deliveryProof: emptyProof(), projectionPending: emptyQueues()
  });
  assert.deepEqual(rebased.queues.commands, [retarget]);
  assert.deepEqual(rebased.projectionPending.commands, []);
  assert.equal(rebased.timer.taskId, undefined);
});

test("paused timer retarget preserves elapsed time and lifecycle intent", () => {
  const head = { canonicalTimer: null, history: [], tasks: [],
    durationsMs: { focus: 1_500_000, short_break: 300_000, long_break: 900_000 },
    autoStartBreaks: false, selectedTaskId: null };
  const start = timerCommand("command-start", 1, "timer-a", "start", { taskId: "task-original", hlcWallMs: 100 });
  const pause = timerCommand("command-pause", 2, "timer-a", "pause", { hlcWallMs: 200, observedElapsedMs: 60_000 });
  const before = storage.projectState({
    snapshot: head, queues: { ...emptyQueues(), commands: [start, pause] },
    nowMs: Date.parse("2026-07-22T12:03:00Z"), deviceId: "device-1"
  });
  const retarget = timerCommand("command-retarget", 3, "timer-a", "retarget",
    { taskId: "task-next", hlcWallMs: 300, observedElapsedMs: 60_000 });
  const after = storage.projectState({
    snapshot: head, queues: { ...emptyQueues(), commands: [start, pause, retarget] },
    nowMs: Date.parse("2026-07-22T12:03:00Z"), deviceId: "device-1"
  });
  assert.equal(before.canonicalTimer.status, "paused");
  for (const field of ["status", "phase", "elapsedAtAnchorMs", "anchorAt", "plannedDurationMs"]) {
    assert.deepEqual(after.canonicalTimer[field], before.canonicalTimer[field], field);
  }
  assert.equal(after.canonicalTimer.taskId, "task-next");
  assert.equal(after.timerOutcomes["command-retarget"].outcome, "applied");
});

test("peer tab delivery converges through the shared durable queues", async (t) => {
  const { database, name: databaseName } = await openDatabase();
  t.after(() => database.close());
  await seedSnapshot(database);
  const start = await allocateTimer(database, startBuild("timer-peer", "task-original"));
  database.close();
  const peer = await reopenDatabase(databaseName);
  t.after(() => peer.close());
  const peerQueues = await storage.readSyncState(peer);
  assert.deepEqual(peerQueues.commands, [start]);
  assert.deepEqual(peerQueues.deliveryProof.commands, [start.id]);
  const retarget = {
    id: "peer-tab-retarget", deviceId: "device-1", deviceSequence: start.deviceSequence + 1,
    timerId: start.timerId, type: "retarget", phase: "focus", plannedDurationMs: 1_500_000,
    occurredAt: "2026-07-22T12:11:00Z", hlcWallMs: start.hlcWallMs + 1_000,
    hlcCounter: 0, observedElapsedMs: 0, taskId: "task-next"
  };
  const base = { canonicalTimer: null, history: [], tasks: [],
    durationsMs: { focus: 1_500_000, short_break: 300_000, long_break: 900_000 },
    autoStartBreaks: false, selectedTaskId: null };
  const firstTab = storage.projectState({
    snapshot: base, queues: { ...emptyQueues(), commands: [start, retarget] },
    nowMs: Date.parse("2026-07-22T12:12:00Z"), deviceId: "device-1"
  });
  const secondTab = storage.projectState({
    snapshot: base, queues: { ...emptyQueues(), commands: [...peerQueues.commands, retarget] },
    nowMs: Date.parse("2026-07-22T12:12:00Z"), deviceId: "device-1"
  });
  assert.equal(firstTab.canonicalTimer.taskId, "task-next");
  assert.deepEqual(secondTab.canonicalTimer, firstTab.canonicalTimer);
  assert.equal(secondTab.timerOutcomes[retarget.id].outcome, "applied");
});

test("completed history converges with whole-session task attribution", () => {
  const start = timerCommand("command-start", 1, "timer-a", "start", { taskId: "task-original", hlcWallMs: 100 });
  const retarget = timerCommand("command-retarget", 2, "timer-a", "retarget", { taskId: "task-next", hlcWallMs: 200 });
  const finish = timerCommand("command-finish", 3, "timer-a", "finish",
    { hlcWallMs: 300, observedElapsedMs: 1_500_000 });
  const projected = storage.projectState({
    snapshot: { canonicalTimer: null, history: [], tasks: [],
      durationsMs: { focus: 1_500_000, short_break: 300_000, long_break: 900_000 },
      autoStartBreaks: false, selectedTaskId: null },
    queues: { ...emptyQueues(), commands: [start, retarget, finish] },
    nowMs: Date.parse("2026-07-22T12:03:00Z"), deviceId: "device-1"
  });
  assert.equal(projected.history.length, 1);
  assert.equal(projected.history[0].taskId, "task-next");
  assert.equal(projected.history[0].commandId, finish.id);
});

test("null retarget unassigns with an explicit wire null", () => {
  assert.equal(sync.validRetargetTaskId(null), true);
  assert.equal(sync.validRetargetTaskId("task-next"), true);
  assert.equal(sync.validRetargetTaskId(""), false);
  assert.equal(sync.validRetargetTaskId(undefined), false);
  assert.deepEqual(sync.retargetRequestFields(null), { taskId: null });
  assert.throws(() => sync.retargetRequestFields(""), /explicit taskId or null/);
  assert.throws(() => sync.retargetRequestFields(undefined), /explicit taskId or null/);
  const wire = sync.timerRequestCommand(timerCommand("command-retarget", 2, "timer-a", "retarget",
    { hlcWallMs: 200, taskId: null }));
  assert.equal(Object.hasOwn(wire, "taskId"), true);
  assert.equal(wire.taskId, null);
  const sent = sync.buildSyncBatch({ ...emptyQueues(),
    commands: [timerCommand("command-retarget", 2, "timer-a", "retarget", { hlcWallMs: 200, taskId: null })] });
  assert.equal(sent.commands[0].taskId, null);
  const projected = storage.projectState({
    snapshot: { canonicalTimer: null, history: [], tasks: [],
      durationsMs: { focus: 1_500_000, short_break: 300_000, long_break: 900_000 },
      autoStartBreaks: false, selectedTaskId: null },
    queues: { ...emptyQueues(), commands: [
      timerCommand("command-start", 1, "timer-a", "start", { taskId: "task-original", hlcWallMs: 100 }),
      timerCommand("command-retarget", 2, "timer-a", "retarget", { hlcWallMs: 200, taskId: null })
    ] },
    nowMs: Date.parse("2026-07-22T12:03:00Z"), deviceId: "device-1"
  });
  assert.equal(Object.hasOwn(projected.canonicalTimer, "taskId"), false);
});
