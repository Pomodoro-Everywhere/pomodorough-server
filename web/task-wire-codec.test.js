"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { indexedDB, IDBFactory } = require("fake-indexeddb");
const sync = require("./sync-core.js");
const storage = require("./sync-storage.js");
const { SharedCore } = require("./shared-core.js");

const sharedCoreBytes = fs.readFileSync(path.join(__dirname, "pomodorough_core.wasm"));
let sharedCorePromise = null;

function authoritativeCore() {
  globalThis.crypto ||= crypto.webcrypto;
  sharedCorePromise ||= SharedCore.fromBytes(sharedCoreBytes);
  return sharedCorePromise;
}

test.before(async () => {
  storage.setSharedCore(await authoritativeCore());
});

let databaseSequence = 0;

function openDatabase(name) {
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
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function fixture() {
  const name = `pomodorough-task-wire-${databaseSequence += 1}`;
  const instance = { database: await openDatabase(name), name };
  instance.close = async () => {
    instance.database.close();
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  };
  return instance;
}

async function seedMeta(database, values) {
  const transaction = database.transaction("meta", "readwrite");
  const store = transaction.objectStore("meta");
  for (const [key, value] of Object.entries(values)) store.put({ key, value });
  await storage.transactionDone(transaction);
}

async function seedQueues(database, values) {
  const transaction = database.transaction(
    ["pending", "pendingTasks", "pendingDurations", "pendingAutoStarts", "pendingSelectedTasks"],
    "readwrite"
  );
  for (const item of values.commands || []) transaction.objectStore("pending").put(item);
  for (const item of values.taskOperations || []) transaction.objectStore("pendingTasks").put(item);
  for (const item of values.durationOperations || []) transaction.objectStore("pendingDurations").put(item);
  for (const item of values.autoStartOperations || []) transaction.objectStore("pendingAutoStarts").put(item);
  for (const item of values.selectedTaskOperations || []) transaction.objectStore("pendingSelectedTasks").put(item);
  await storage.transactionDone(transaction);
}

function snapshot(revision = 0) {
  return {
    revision,
    serverTime: "2026-07-22T12:30:00Z",
    canonicalTimer: null,
    history: [],
    tasks: [],
    durationsMs: { focus: 1_500_000, short_break: 300_000, long_break: 900_000 },
    autoStartBreaks: false,
    selectedTaskId: null,
    user: { id: "user-1", name: "user-1" }
  };
}

async function coreTaskOperation(title, type = "upsert") {
  const core = await authoritativeCore();
  const identity = core.taskIdentity({ title });
  const wallMs = Date.now();
  return {
    id: `task-operation-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`,
    deviceId: "device-1",
    taskId: identity.id,
    type,
    ...(type === "upsert" ? { title: identity.title } : { title: "" }),
    occurredAt: new Date(wallMs).toISOString(),
    hlcWallMs: wallMs,
    hlcCounter: 0
  };
}

test("task wire codec strips Core deviceId without changing wire identity", () => {
  const upsert = {
    id: "task-operation-0001", deviceId: "device-1", taskId: "task-abc12345",
    type: "upsert", title: "Review offline task", occurredAt: "2026-07-22T12:00:00Z",
    hlcWallMs: 1, hlcCounter: 0, ownerId: "local-only"
  };
  assert.deepEqual(sync.taskRequestOperation(upsert), {
    id: "task-operation-0001", taskId: "task-abc12345", type: "upsert",
    occurredAt: "2026-07-22T12:00:00Z", hlcWallMs: 1, hlcCounter: 0,
    title: "Review offline task"
  });
  const removal = {
    id: "task-operation-0002", deviceId: "device-1", taskId: "task-abc12345",
    type: "delete", title: "", occurredAt: "2026-07-22T12:00:00Z",
    hlcWallMs: 2, hlcCounter: 0
  };
  assert.deepEqual(sync.taskRequestOperation(removal), {
    id: "task-operation-0002", taskId: "task-abc12345", type: "delete",
    occurredAt: "2026-07-22T12:00:00Z", hlcWallMs: 2, hlcCounter: 0
  });
});

test("real Core task rows encode to strict wire shape for sync and bootstrap", async () => {
  const upsert = await coreTaskOperation("Review offline task");
  assert.equal(typeof upsert.deviceId, "string", "Core durable row carries deviceId");
  const sent = sync.buildSyncBatch({ taskOperations: [upsert], deviceId: "device-1" });
  assert.equal(sent.taskOperations.length, 1);
  assert.equal(Object.hasOwn(sent.taskOperations[0], "deviceId"), false);
  assert.deepEqual(Object.keys(sent.taskOperations[0]).sort(),
    ["hlcCounter", "hlcWallMs", "id", "occurredAt", "taskId", "title", "type"]);
  const pending = sync.createPendingResolution({
    userId: "user-1", requestId: "request-task-wire", deviceId: "device-1",
    expectedRevision: 3, strategy: "merge", commands: [],
    taskOperations: [upsert], durationOperations: []
  });
  assert.equal(pending.payload.taskOperations.length, 1);
  assert.equal(Object.hasOwn(pending.payload.taskOperations[0], "deviceId"), false);
  assert.equal(pending.payload.taskOperations[0].title, "Review offline task");
});

test("mixed task and Start claim keeps exact bytes across lost response and reopen", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  const upsert = await coreTaskOperation("Review offline task");
  const wallMs = Date.now();
  await seedMeta(instance.database, {
    snapshot: snapshot(0), deviceId: "device-1", deviceSequence: 1,
    hlc: { wallMs, counter: 0 }
  });
  await seedQueues(instance.database, {
    commands: [{
      id: "command-0001", deviceId: "device-1", deviceSequence: 2, timerId: "timer-000001",
      type: "start", phase: "focus", plannedDurationMs: 1_500_000,
      occurredAt: new Date(wallMs).toISOString(), hlcWallMs: wallMs, hlcCounter: 1,
      observedElapsedMs: 0, taskId: upsert.taskId
    }],
    taskOperations: [upsert]
  });
  const issued = { ownerId: "user-1", deviceId: "device-1", localNowMs: Date.now() };
  const { claim } = await storage.claimWorkspaceBatch(instance.database, issued);
  assert.ok(claim, "mixed batch produces a claim");
  const body = JSON.parse(claim.body);
  assert.equal(body.taskOperations.length, 1);
  assert.equal(Object.hasOwn(body.taskOperations[0], "deviceId"), false);
  assert.equal(body.taskOperations[0].title, "Review offline task");
  assert.equal(body.commands.length, 1);
  assert.deepEqual(body.taskOperations, claim.sent.taskOperations);
  const exactBytes = claim.body;

  instance.database.close();
  instance.database = await openDatabase(instance.name);
  const reopened = await storage.readSyncState(instance.database);
  assert.equal(reopened.outgoing.body, exactBytes, "lost-response retry resends byte-identical claim");
});

test("applied mixed acknowledgement clears every queue across reopen", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  const upsert = await coreTaskOperation("Review offline task");
  const wallMs = Date.now();
  await seedMeta(instance.database, {
    snapshot: snapshot(0), deviceId: "device-1", deviceSequence: 1,
    hlc: { wallMs, counter: 0 }
  });
  await seedQueues(instance.database, {
    commands: [{
      id: "command-0001", deviceId: "device-1", deviceSequence: 2, timerId: "timer-000001",
      type: "start", phase: "focus", plannedDurationMs: 1_500_000,
      occurredAt: new Date(wallMs).toISOString(), hlcWallMs: wallMs, hlcCounter: 1,
      observedElapsedMs: 0, taskId: upsert.taskId
    }],
    taskOperations: [upsert]
  });
  const canonical = snapshot(1);
  canonical.tasks = [{ id: upsert.taskId, title: upsert.title }];
  canonical.canonicalTimer = {
    id: "timer-000001", phase: "focus", status: "running", plannedDurationMs: 1_500_000,
    elapsedAtAnchorMs: 0, anchorAt: new Date(wallMs).toISOString(),
    lastIntent: { type: "start", commandId: "command-0001", occurredAt: new Date(wallMs).toISOString() }
  };
  await storage.applySyncResponse(instance.database, {
    expectedUserId: "user-1",
    snapshot: canonical,
    hlc: { wallMs: wallMs + 1, counter: 0 },
    queueIds: { commands: ["command-0001"], taskOperations: [upsert.id],
      durationOperations: [], autoStartOperations: [] }
  });
  instance.database.close();
  instance.database = await openDatabase(instance.name);
  const afterApply = await storage.readSyncState(instance.database);
  assert.deepEqual(sync.buildSyncBatch(afterApply).taskOperations, []);
  assert.deepEqual(sync.buildSyncBatch(afterApply).commands, []);
  assert.deepEqual(afterApply.snapshot.tasks, [{ id: upsert.taskId, title: upsert.title }]);
});
