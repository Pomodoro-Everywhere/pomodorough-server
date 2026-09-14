"use strict";

// Regression coverage for the immutable `reconcile.rebase.v2` web-client
// contract: separate Core-owned retarget operations, durable never-sent
// proof retired before possible delivery, exact outgoing payload retention,
// atomic canonical snapshot + covering HLC persistence, and
// projectionPending-safe optimistic state. Retarget never rewrites a pending
// Start and never overlays canonical history or task totals.
//
// Reconcile paths run against the repinned Core v0.39.0 WASM, which natively
// implements `reconcile.rebase.v2`.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { indexedDB } = require("fake-indexeddb");
const sync = require("./sync-core.js");
const storage = require("./sync-storage.js");
const { SharedCore } = require("./shared-core.js");

const SERVER_TIME = "2026-07-22T12:30:00Z";
const SERVER_HEAD = { wallMs: Date.parse(SERVER_TIME), counter: 7 };
const USER = { id: "user-1" };

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

function applyInput(snapshot, sent, response, validatedIds) {
  return {
    expectedUserId: "user-1", snapshot,
    hlc: { wallMs: SERVER_HEAD.wallMs, counter: SERVER_HEAD.counter },
    serverHlc: { ...SERVER_HEAD }, clockOffset: null,
    queueIds: validatedIds,
    timerOwnerClaim: { deviceId: "device-1", tabId: "tab-1", nowMs: Date.now(), leaseMs: 60_000 },
    reconciliation: { sent, response, deviceId: "device-1" }
  };
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
  const retired = await storage.retireProofAndPersistOutgoing(database, sent);
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
  await storage.applySyncResponse(database, applyInput(snapshot, sent, response, ackIds(validated)));
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
  await storage.retireProofAndPersistOutgoing(database, sent);
  const stored = await storage.readSyncState(database);
  assert.ok(stored.outgoing?.sent);
  assert.deepEqual(stored.outgoing.sent.commands, sent.commands);
  const rebuilt = sync.buildSyncBatch({ ...emptyQueues(), commands: stored.commands });
  assert.deepEqual(rebuilt.commands, stored.outgoing.sent.commands);
  assert.equal(storage.outgoingMatchesStored(stored.outgoing, rebuilt), true);
  const snapshot = canonicalSnapshot(1);
  const response = canonicalResponse(snapshot, [{ commandId: start.id, outcome: "applied", reason: "" }]);
  const validated = sync.validateCanonicalResponse(response, sent);
  await storage.applySyncResponse(database, applyInput(snapshot, sent, response, ackIds(validated)));
  assert.deepEqual((await storage.readSyncState(database)).commands, []);
});

test("reload retains proof, head, projectionPending, outgoing, and exact payloads", async (t) => {
  const { database, name: databaseName } = await openDatabase();
  t.after(() => database.close());
  await seedSnapshot(database);
  const start = await allocateTimer(database, startBuild("timer-reload", "task-original"));
  const sent = sync.buildSyncBatch({ ...emptyQueues(), commands: [start] });
  await storage.retireProofAndPersistOutgoing(database, sent);
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
    queues: local, sent, response, deviceId: "device-1", deliveryProof: emptyProof()
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
    timerId: "timer-peer", type: "retarget", phase: "focus", plannedDurationMs: 1_500_000,
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
