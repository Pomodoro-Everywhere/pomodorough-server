"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { indexedDB } = require("fake-indexeddb");
const sync = require("./sync-core.js");
const storage = require("./sync-storage.js");
const uuidFixtureBytes = fs.readFileSync(
  path.join(__dirname, "../internal/timer/testdata/uuidv7-v1.json")
);
const uuidFixture = JSON.parse(uuidFixtureBytes);

let databaseSequence = 0;

function command(id, sequence, wall = sequence, counter = 0) {
  return {
    id,
    deviceId: "device-1",
    deviceSequence: sequence,
    timerId: `timer-${id}`,
    type: "start",
    phase: "focus",
    plannedDurationMs: 1_500_000,
    occurredAt: "2026-07-22T12:00:00Z",
    hlcWallMs: wall,
    hlcCounter: counter,
    observedElapsedMs: 0
  };
}

function taskOperation(id, wall = 1, counter = 0) {
  return {
    id,
    taskId: `task-${id}`,
    type: "upsert",
    title: id,
    occurredAt: "2026-07-22T12:00:00Z",
    hlcWallMs: wall,
    hlcCounter: counter
  };
}

function durationOperation(id) {
  return {
    id,
    ownerId: "tab-1",
    phase: "focus",
    durationMs: 1_800_000,
    occurredAt: "2026-07-22T12:00:00Z",
    hlcWallMs: 1,
    hlcCounter: 0
  };
}

function autoStartOperation(id, enabled = true, wall = 1, counter = 0) {
  return {
    id,
    enabled,
    occurredAt: "2026-07-22T12:00:00Z",
    hlcWallMs: wall,
    hlcCounter: counter
  };
}

function selectedTaskOperation(id, taskId = `task-${id}`, wall = 1, counter = 0) {
  return {
    id,
    taskId,
    occurredAt: "2026-07-22T12:00:00Z",
    hlcWallMs: wall,
    hlcCounter: counter
  };
}

function snapshot(revision, userId = "user-1", serverTime = "2026-07-22T12:30:00Z") {
  return {
    revision,
    serverTime,
    canonicalTimer: null,
    history: [],
    tasks: [],
    durationsMs: { focus: 1_500_000, short_break: 300_000, long_break: 900_000 },
    autoStartBreaks: false,
    selectedTaskId: null,
    user: { id: userId, name: userId }
  };
}

function runningFocusSnapshot(revision = 0, timerId = "owned-focus") {
  const value = snapshot(revision);
  value.canonicalTimer = {
    id: timerId,
    phase: "focus",
    status: "running",
    plannedDurationMs: 1_500_000,
    elapsedAtAnchorMs: 0,
    anchorAt: "2026-07-22T12:00:00Z"
  };
  return value;
}

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
  const name = `pomodorough-storage-${databaseSequence += 1}`;
  const instance = {
    database: await openDatabase(name),
    name,
    async secondConnection() {
      return openDatabase(name);
    },
    async close() {
      this.database.close();
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }
  };
  return instance;
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

async function seedMeta(database, values) {
  const transaction = database.transaction("meta", "readwrite");
  const store = transaction.objectStore("meta");
  for (const [key, value] of Object.entries(values)) store.put({ key, value });
  await storage.transactionDone(transaction);
}

async function readMeta(database, key) {
  const transaction = database.transaction("meta", "readonly");
  const record = await storage.requestResult(transaction.objectStore("meta").get(key));
  return record?.value;
}

function fixedEntropy(hex) {
  const source = Uint8Array.from(Buffer.from(hex.padStart(20, "0"), "hex"));
  return (bytes) => {
    bytes.set(source);
    return bytes;
  };
}

function resolutionInput(strategy = "merge", userId = "user-1") {
  return {
    userId,
    requestId: `request-${userId}`,
    deviceId: "device-1",
    expectedRevision: 3,
    strategy
  };
}

async function acquire(database, token = "tab-1", nowMs = 1_000, leaseMs = 1_000) {
  return storage.acquireBootstrapGate(database, { token, nowMs, leaseMs });
}

async function capture(database, input = resolutionInput(), token = "tab-1") {
  return storage.captureResolution(database, input, { gateToken: token, replaceExisting: false });
}

test("UUIDv7 generator matches RFC 9562 fixture", () => {
  assert.equal(
    crypto.createHash("sha256").update(uuidFixtureBytes).digest("hex"),
    "719bf4601f0e82aa9898e891184edcf8f37b183a05f3ddd6fa211e1ac8dc2f10"
  );
  const fixture = uuidFixture.rfc9562;
  const randomValue = BigInt(`0x${fixture.randomValueHex}`);
  const generated = storage.uuid7FromParts(fixture.timestampMs, randomValue);

  assert.equal(generated, fixture.uuid);
  assert.deepEqual(storage.uuid7Parts(generated), {
    integer: BigInt(`0x${fixture.uuid.replaceAll("-", "")}`),
    timestampMs: fixture.timestampMs,
    randomValue
  });
});

test("UUIDv7 reservation is monotonic through equal clocks and rollback", () => {
  const first = storage.reserveUuid7(
    1_000,
    3,
    null,
    [],
    fixedEntropy("09")
  );
  const second = storage.reserveUuid7(999, 2, first.at(-1));

  assert.deepEqual(
    first.concat(second).map((identifier) => storage.uuid7Parts(identifier).randomValue),
    [9n, 10n, 11n, 12n, 13n]
  );
  assert.deepEqual(first.concat(second), first.concat(second).toSorted());
  assert.ok(first.every((identifier) => storage.uuid7Parts(identifier).timestampMs === 1_000));
});

test("UUIDv7 rejects timestamp and random-tail overflow", () => {
  assert.throws(
    () => storage.reserveUuid7(storage.UUID7_MAX_TIMESTAMP_MS + 1, 1, null),
    { name: "UUIDRangeError" }
  );
  const exhausted = storage.uuid7FromParts(1_000, storage.UUID7_RANDOM_MAX);
  assert.throws(
    () => storage.reserveUuid7(1_000, 1, exhausted),
    { name: "UUIDRangeError", message: /headroom/ }
  );
});

test("capture atomically snapshots stores and survives database reload", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await seedQueues(instance.database, {
    commands: [command("command-2", 2), command("command-1", 1)],
    taskOperations: [taskOperation("task-op-1")],
    durationOperations: [durationOperation("duration-op-1")],
    autoStartOperations: [autoStartOperation("auto-start-op-1")],
    selectedTaskOperations: [selectedTaskOperation("selected-task-op-1")]
  });
  assert.equal((await acquire(instance.database)).acquired, true);
  await assert.rejects(storage.guardedMutation(instance.database, ["pending"], (transaction) => {
    transaction.objectStore("pending").add(command("blocked", 3));
  }), { name: "BootstrapGateError" });

  const pending = await capture(instance.database);
  assert.deepEqual(pending.queueIds, {
    commands: ["command-1", "command-2"],
    taskOperations: ["task-op-1"],
    durationOperations: ["duration-op-1"],
    autoStartOperations: ["auto-start-op-1"],
    selectedTaskOperations: ["selected-task-op-1"]
  });
  assert.equal(pending.gateToken, "tab-1");
  assert.equal(Object.hasOwn(pending.payload.durationOperations[0], "ownerId"), false);
  assert.deepEqual(pending.payload.autoStartOperations, [autoStartOperation("auto-start-op-1")]);
  assert.deepEqual(pending.payload.selectedTaskOperations, [selectedTaskOperation("selected-task-op-1")]);

  instance.database.close();
  instance.database = await openDatabase(instance.name);
  const reloaded = await storage.readBootstrapState(instance.database);
  assert.equal(JSON.stringify(reloaded.resolution), JSON.stringify(pending));
  assert.equal(reloaded.gate.token, "tab-1");
});

test("legacy auto-start migration preserves only distinguishable choices", async (t) => {
  const cases = [
    { name: "non-default true", settings: { autoStartBreaks: true }, migrated: true, enabled: true },
    { name: "explicit false marker", settings: { autoStartBreaks: false, autoStartBreaksExplicit: true }, migrated: true, enabled: false },
    { name: "ambiguous default false", settings: { autoStartBreaks: false }, migrated: false }
  ];
  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const instance = await fixture();
      try {
        await seedMeta(instance.database, {
          settings: { selectedPhase: "focus", ...testCase.settings },
          hlc: { wallMs: 100, counter: 2 }
        });
        const first = await storage.migrateLegacyAutoStart(instance.database, {
          operationId: `auto-start-migration-${testCase.name}`,
          nowMs: 100
        });
        const second = await storage.migrateLegacyAutoStart(instance.database, {
          operationId: `auto-start-duplicate-${testCase.name}`,
          nowMs: 101
        });

        assert.equal(first.migrated, testCase.migrated);
        if (testCase.migrated) {
          assert.equal(first.operation.enabled, testCase.enabled);
          assert.equal(first.operation.occurredAt, "1970-01-01T00:00:00.000Z");
          assert.equal(first.operation.hlcWallMs, 0);
          assert.equal(first.operation.hlcCounter, 0);
        } else {
          assert.equal(first.operation, null);
        }
        assert.deepEqual(second, { migrated: false, operation: null });

        instance.database.close();
        instance.database = await openDatabase(instance.name);
        const persisted = await storage.readSyncState(instance.database);
        assert.deepEqual(persisted.autoStartOperations, testCase.migrated ? [first.operation] : []);
        assert.deepEqual(persisted.hlc, { wallMs: 100, counter: 2 });
        const transaction = instance.database.transaction("meta", "readonly");
        const settings = await storage.requestResult(transaction.objectStore("meta").get("settings"));
        assert.equal(settings.value.autoStartSyncBootstrapped, true);
        assert.equal(Object.hasOwn(settings.value, "autoStartBreaks"), false);
        assert.equal(Object.hasOwn(settings.value, "autoStartBreaksExplicit"), false);
      } finally {
        await instance.close();
      }
    });
  }
});

test("legacy auto-start migration stays valid under a far-future local clock", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await seedMeta(instance.database, {
    settings: { autoStartBreaks: true },
    hlc: { wallMs: 9_000_000_000_000, counter: 7 }
  });
  const result = await storage.migrateLegacyAutoStart(instance.database, {
    operationId: "auto-start-future-clock",
    nowMs: 9_000_000_000_000
  });
  assert.deepEqual(result.operation, {
    id: "auto-start-future-clock",
    enabled: true,
    occurredAt: "1970-01-01T00:00:00.000Z",
    hlcWallMs: 0,
    hlcCounter: 0
  });
  assert.deepEqual((await storage.readSyncState(instance.database)).hlc, {
    wallMs: 9_000_000_000_000,
    counter: 7
  });
});

test("legacy selected-task migration queues only an explicit task and strips local setting", async (t) => {
  for (const testCase of [
    { name: "selected", selectedTaskId: "task-legacy", migrated: true },
    { name: "no task", selectedTaskId: null, migrated: false }
  ]) {
    await t.test(testCase.name, async () => {
      const instance = await fixture();
      try {
        await seedMeta(instance.database, {
          settings: { selectedPhase: "focus", selectedTaskId: testCase.selectedTaskId },
          hlc: { wallMs: 100, counter: 2 }
        });
        const first = await storage.migrateLegacySelectedTask(instance.database, {
          operationId: `selected-task-migration-${testCase.name}`,
          nowMs: 100
        });
        const second = await storage.migrateLegacySelectedTask(instance.database, {
          operationId: `selected-task-duplicate-${testCase.name}`,
          nowMs: 101
        });

        assert.equal(first.migrated, testCase.migrated);
        assert.deepEqual(second, { migrated: false, operation: null });
        const persisted = await storage.readSyncState(instance.database);
        assert.deepEqual(persisted.selectedTaskOperations, testCase.migrated ? [{
          id: `selected-task-migration-${testCase.name}`,
          taskId: "task-legacy",
          occurredAt: "1970-01-01T00:00:00.000Z",
          hlcWallMs: 0,
          hlcCounter: 0
        }] : []);
        const settings = await readMeta(instance.database, "settings");
        assert.equal(settings.selectedTaskSyncBootstrapped, true);
        assert.equal(Object.hasOwn(settings, "selectedTaskId"), false);
      } finally {
        await instance.close();
      }
    });
  }
});

test("legacy duration normalization repairs queue but freezes unowned captured payload", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  const legacy = {
    ...durationOperation("duration-legacy"),
    occurredAt: "2026-07-22T12:30:00Z",
    hlcWallMs: 0,
    hlcCounter: 0
  };
  const current = durationOperation("duration-current");
  await seedQueues(instance.database, { durationOperations: [legacy, current] });
  await seedMeta(instance.database, {
    bootstrapResolution: {
      userId: "user-1",
      payload: { durationOperations: [legacy, current] },
      queueIds: { durationOperations: [legacy.id, current.id] }
    }
  });

  const before = (await storage.readBootstrapState(instance.database)).resolution;
  assert.deepEqual(await storage.normalizeLegacyDurationOperations(instance.database), { changed: 1, resolution: before });
  assert.deepEqual(await storage.normalizeLegacyDurationOperations(instance.database), { changed: 0, resolution: before });
  const queues = await storage.readQueues(instance.database);
  assert.equal(queues.durationOperations.find((item) => item.id === legacy.id).occurredAt, "1970-01-01T00:00:00.000Z");
  assert.deepEqual(queues.durationOperations.find((item) => item.id === current.id), current);
  const resolution = (await storage.readBootstrapState(instance.database)).resolution;
  assert.deepEqual(resolution, before);
  assert.equal(resolution.payload.durationOperations[0].occurredAt, "2026-07-22T12:30:00Z");
  assert.deepEqual(resolution.payload.durationOperations[1], current);
});

test("legacy duration capture normalizes queue before freezing request payload", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  const legacy = {
    ...durationOperation("duration-capture-legacy"),
    occurredAt: "2026-07-22T12:30:00Z",
    hlcWallMs: 0,
    hlcCounter: 0
  };
  await seedQueues(instance.database, { durationOperations: [legacy] });
  await acquire(instance.database);

  const pending = await capture(instance.database);
  assert.equal(pending.payload.durationOperations[0].occurredAt, "1970-01-01T00:00:00.000Z");
  assert.equal((await storage.readQueues(instance.database)).durationOperations[0].occurredAt, "1970-01-01T00:00:00.000Z");
});

test("resolution replacement requires owner and fresh request ID", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await acquire(instance.database, "tab-owner");
  const existing = await capture(instance.database, {
    ...resolutionInput("merge"),
    requestId: "request-existing"
  }, "tab-owner");

  await assert.rejects(storage.captureResolution(instance.database, {
    ...resolutionInput("merge"),
    requestId: "request-existing"
  }, { gateToken: "tab-owner", replaceExisting: true }), { name: "BootstrapGateError" });
  assert.deepEqual((await storage.readBootstrapState(instance.database)).resolution, existing);

  const foreign = { ...existing, gateToken: "tab-foreign" };
  await seedMeta(instance.database, { bootstrapResolution: foreign });
  await assert.rejects(storage.captureResolution(instance.database, {
    ...resolutionInput("merge"),
    requestId: "request-fresh"
  }, { gateToken: "tab-owner", replaceExisting: true }), { name: "BootstrapGateError" });
  assert.deepEqual((await storage.readBootstrapState(instance.database)).resolution, foreign);

  await seedMeta(instance.database, { bootstrapResolution: existing });
  const replaced = await storage.captureResolution(instance.database, {
    ...resolutionInput("merge"),
    requestId: "request-fresh"
  }, { gateToken: "tab-owner", replaceExisting: true });
  assert.equal(replaced.payload.requestId, "request-fresh");
});

test("legacy captured payload rotates request ID only for current gate owner", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  const legacy = {
    ...durationOperation("duration-rotate-legacy"),
    occurredAt: "2026-07-22T12:30:00Z",
    hlcWallMs: 0,
    hlcCounter: 0
  };
  const captured = {
    userId: "user-1",
    gateToken: "tab-owner",
    payload: { requestId: "request-old", durationOperations: [legacy] },
    queueIds: { durationOperations: [legacy.id] }
  };
  await seedQueues(instance.database, { durationOperations: [legacy] });
  await seedMeta(instance.database, {
    bootstrapGate: { token: "tab-owner", acquiredAtMs: 1, expiresAtMs: 10_000 },
    bootstrapResolution: captured
  });

  await assert.rejects(storage.normalizeLegacyDurationOperations(instance.database, {
    gateToken: "tab-other",
    replacementRequestId: "request-other"
  }), { name: "BootstrapGateError" });
  assert.deepEqual((await storage.readBootstrapState(instance.database)).resolution, captured);

  const result = await storage.normalizeLegacyDurationOperations(instance.database, {
    gateToken: "tab-owner",
    replacementRequestId: "request-new"
  });
  assert.equal(result.resolution.payload.requestId, "request-new");
  assert.equal(result.resolution.payload.durationOperations[0].occurredAt, "1970-01-01T00:00:00.000Z");
  assert.deepEqual((await storage.readBootstrapState(instance.database)).resolution, result.resolution);
});

test("stale gate takeover can rotate legacy captured payload before retry", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  const legacy = {
    ...durationOperation("duration-takeover-legacy"),
    occurredAt: "2026-07-22T12:30:00Z",
    hlcWallMs: 0,
    hlcCounter: 0
  };
  const captured = {
    userId: "user-1",
    gateToken: "tab-old",
    payload: { requestId: "request-old", strategy: "merge", durationOperations: [legacy] },
    queueIds: { durationOperations: [legacy.id] }
  };
  await seedQueues(instance.database, { durationOperations: [legacy] });
  await seedMeta(instance.database, {
    bootstrapGate: { token: "tab-old", acquiredAtMs: 1, expiresAtMs: 10 },
    bootstrapResolution: captured
  });

  const takeover = await acquire(instance.database, "tab-new", 11, 1_000);
  assert.equal(takeover.acquired, true);
  assert.equal(takeover.resolution.gateToken, "tab-new");
  const normalized = await storage.normalizeLegacyDurationOperations(instance.database, {
    gateToken: "tab-new",
    replacementRequestId: "request-new"
  });
  assert.equal(normalized.resolution.payload.requestId, "request-new");
  assert.equal(normalized.resolution.payload.durationOperations[0].occurredAt, "1970-01-01T00:00:00.000Z");
  assert.equal((await storage.validatePendingForSend(instance.database, {
    pending: normalized.resolution,
    currentUserId: "user-1",
    gateToken: "tab-new",
    nowMs: 12,
    leaseMs: 1_000
  })).payload.requestId, "request-new");
});

test("server clock offset persists across restart and rejects stale or invalid samples", async (t) => {
  const instance = await fixture();
  const reloaded = await instance.secondConnection();
  t.after(() => {
    reloaded.close();
    return instance.close();
  });
  const fastClock = {
    offsetMs: -3_600_050, uncertaintyMs: 50, sampledAtWallMs: 4_600_050,
    requestSequence: 1, receivedAtWallMs: 4_600_100
  };
  const rolledBackClock = {
    offsetMs: 3_599_950, uncertaintyMs: 50, sampledAtWallMs: 1_000_050,
    requestSequence: 2, receivedAtWallMs: 1_000_100
  };
  const staleClock = {
    offsetMs: -3_600_050, uncertaintyMs: 100, sampledAtWallMs: 4_600_050,
    requestSequence: 1, receivedAtWallMs: 4_600_100
  };

  await storage.saveClockOffset(instance.database, fastClock);
  assert.deepEqual((await storage.readCanonicalState(reloaded)).clockOffset, fastClock);
  await storage.saveClockOffset(reloaded, rolledBackClock);
  assert.deepEqual((await storage.readSyncState(instance.database)).clockOffset, rolledBackClock);
  assert.deepEqual(await storage.saveClockOffset(instance.database, staleClock), rolledBackClock);
  const laterReceiptSameRequest = {
    offsetMs: 3_599_900, uncertaintyMs: 100, sampledAtWallMs: 999_950,
    requestSequence: 2, receivedAtWallMs: 1_000_150
  };
  assert.deepEqual(await storage.saveClockOffset(instance.database, laterReceiptSameRequest), laterReceiptSameRequest);
  await assert.rejects(
    storage.saveClockOffset(instance.database, {
      offsetMs: 0, uncertaintyMs: 30_001, sampledAtWallMs: 1_000,
      requestSequence: 3, receivedAtWallMs: 1_000
    }),
    { name: "ClockRangeError" }
  );
  assert.deepEqual((await storage.readCanonicalState(reloaded)).clockOffset, laterReceiptSameRequest);
});

test("clock request sequence is atomic across tabs and survives restart", async (t) => {
  const instance = await fixture();
  const second = await instance.secondConnection();
  t.after(() => {
    second.close();
    return instance.close();
  });
  assert.deepEqual(
    await Promise.all([
      storage.allocateClockRequestSequence(instance.database),
      storage.allocateClockRequestSequence(second)
    ]).then((values) => values.sort((left, right) => left - right)),
    [1, 2]
  );
  instance.database.close();
  instance.database = await openDatabase(instance.name);
  assert.equal(await storage.allocateClockRequestSequence(instance.database), 3);
});

test("invalid sync clock tuple leaves canonical state and queues unchanged", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  const queued = command("clock-invalid-pending", 1);
  await seedMeta(instance.database, { snapshot: snapshot(1), hlc: { wallMs: 100, counter: 0 } });
  await seedQueues(instance.database, { commands: [queued] });

  await assert.rejects(storage.applySyncResponse(instance.database, {
    expectedUserId: "user-1",
    snapshot: snapshot(2),
    hlc: { wallMs: 200, counter: 0 },
    clockOffset: {
      offsetMs: 0, uncertaintyMs: 30_001, sampledAtWallMs: 1_000,
      requestSequence: 1, receivedAtWallMs: 1_000
    },
    queueIds: { commands: [queued.id], taskOperations: [], durationOperations: [], autoStartOperations: [] }
  }), { name: "ClockRangeError" });

  const persisted = await storage.readSyncState(instance.database);
  assert.equal(persisted.snapshot.revision, 1);
  assert.deepEqual(persisted.commands, [queued]);
});

test("ambiguous legacy false omits bootstrap field and preserves canonical true", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await seedMeta(instance.database, {
    settings: { selectedPhase: "focus", autoStartBreaks: false },
    snapshot: snapshot(3)
  });
  const migration = await storage.migrateLegacyAutoStart(instance.database, {
    operationId: "auto-start-ambiguous-false",
    nowMs: 100
  });
  assert.deepEqual(migration, { migrated: false, operation: null });
  await acquire(instance.database);
  const pending = await capture(instance.database, resolutionInput("replace_remote"));
  assert.equal(Object.hasOwn(pending.payload, "autoStartOperations"), false);
  assert.deepEqual(pending.queueIds.autoStartOperations, []);

  const canonicalSnapshot = snapshot(4);
  canonicalSnapshot.autoStartBreaks = true;
  await storage.applyResolution(instance.database, pending, {
    snapshot: canonicalSnapshot,
    hlc: { wallMs: 400, counter: 0 }
  });
  assert.equal((await storage.readCanonicalState(instance.database)).snapshot.autoStartBreaks, true);
});

test("legacy bootstrap retry keeps auto-start omission exact and retires old local setting", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await seedMeta(instance.database, {
    settings: { selectedPhase: "focus", autoStartBreaks: true }
  });
  await acquire(instance.database);
  const pending = await capture(instance.database, resolutionInput("replace_remote"));
  delete pending.payload.autoStartOperations;
  delete pending.queueIds.autoStartOperations;
  await seedMeta(instance.database, { bootstrapResolution: pending });

  const reloaded = await storage.readBootstrapState(instance.database);
  assert.equal(JSON.stringify(reloaded.resolution.payload), JSON.stringify(pending.payload));
  assert.equal(Object.hasOwn(reloaded.resolution.payload, "autoStartOperations"), false);

  const canonicalSnapshot = snapshot(4);
  canonicalSnapshot.autoStartBreaks = true;
  await storage.applyResolution(instance.database, pending, {
    snapshot: canonicalSnapshot,
    hlc: { wallMs: 400, counter: 0 }
  });

  const transaction = instance.database.transaction("meta", "readonly");
  const settings = await storage.requestResult(transaction.objectStore("meta").get("settings"));
  assert.equal(settings.value.autoStartSyncBootstrapped, true);
  assert.equal(Object.hasOwn(settings.value, "autoStartBreaks"), false);
  assert.equal((await storage.readCanonicalState(instance.database)).snapshot.autoStartBreaks, true);
  assert.deepEqual((await storage.readQueues(instance.database)).autoStartOperations, []);
});

test("live bootstrap lease has one owner and stale lease supports takeover", async (t) => {
  const instance = await fixture();
  const second = await instance.secondConnection();
  t.after(() => {
    second.close();
    return instance.close();
  });
  assert.equal((await acquire(instance.database, "tab-1", 1_000, 1_000)).acquired, true);
  assert.equal((await acquire(second, "tab-2", 1_500, 1_000)).acquired, false);
  await assert.rejects(storage.clearBootstrapGate(second, "tab-2"), { name: "BootstrapGateError" });

  const takeover = await acquire(second, "tab-2", 2_001, 1_000);
  assert.equal(takeover.acquired, true);
  assert.equal(takeover.takenOver, true);
  await assert.rejects(storage.clearBootstrapGate(instance.database, "tab-1"), { name: "BootstrapGateError" });
  assert.equal(await storage.clearBootstrapGate(second, "tab-2"), true);
});

test("stale bootstrap gate takeover idempotently preserves explicit legacy auto-start", async (t) => {
  const instance = await fixture();
  const takeoverTab = await instance.secondConnection();
  t.after(() => {
    takeoverTab.close();
    return instance.close();
  });
  await seedMeta(instance.database, {
    settings: { selectedPhase: "focus", autoStartBreaks: true }
  });
  assert.equal((await acquire(instance.database, "tab-old", 1_000, 1_000)).acquired, true);

  const takeover = await storage.acquireBootstrapGateWithLegacyAutoStart(takeoverTab, {
    token: "tab-new",
    nowMs: 2_001,
    leaseMs: 1_000,
    legacyAutoStartOperationId: "auto-start-stale-takeover"
  });
  assert.equal(takeover.acquired, true);
  assert.equal(takeover.takenOver, true);
  assert.equal(takeover.resolution, null);
  assert.equal(takeover.legacyAutoStartMigration.migrated, true);
  assert.deepEqual((await storage.readQueues(takeoverTab)).autoStartOperations, [
    takeover.legacyAutoStartMigration.operation
  ]);

  const repeated = await storage.acquireBootstrapGateWithLegacyAutoStart(takeoverTab, {
    token: "tab-new",
    nowMs: 2_002,
    leaseMs: 1_000,
    legacyAutoStartOperationId: "auto-start-stale-duplicate"
  });
  assert.deepEqual(repeated.legacyAutoStartMigration, { migrated: false, operation: null });
  assert.equal((await storage.readQueues(takeoverTab)).autoStartOperations.length, 1);
});

test("UUIDv7 mutation allocation persists across domains, restart, and clock rollback", async (t) => {
  const instance = await fixture();
  const second = await instance.secondConnection();
  t.after(() => {
    second.close();
    return instance.close();
  });
  await seedMeta(instance.database, {
    deviceSequence: 0,
    hlc: { wallMs: 100, counter: 0 }
  });
  const first = await storage.allocateMutation(instance.database, {
    storeName: "pending",
    nowMs: 100,
    withDeviceSequence: true,
    withUuidV7: true,
    entropy: fixedEntropy("09"),
    build: ({ id, wallMs, counter, deviceSequence }) => command(
      id,
      deviceSequence,
      wallMs,
      counter
    )
  });
  const secondOperation = await storage.allocateMutation(second, {
    storeName: "pendingTasks",
    nowMs: 100,
    withDeviceSequence: false,
    withUuidV7: true,
    build: ({ id, wallMs, counter }) => taskOperation(id, wallMs, counter)
  });
  instance.database.close();
  instance.database = await openDatabase(instance.name);
  const afterRestart = await storage.allocateMutation(instance.database, {
    storeName: "pendingAutoStarts",
    nowMs: 99,
    withDeviceSequence: false,
    withUuidV7: true,
    build: ({ id, wallMs, counter }) => autoStartOperation(id, true, wallMs, counter)
  });
  const selectedTask = await storage.allocateMutation(instance.database, {
    storeName: "pendingSelectedTasks",
    nowMs: 98,
    withDeviceSequence: false,
    withUuidV7: true,
    build: ({ id, wallMs, counter }) => selectedTaskOperation(id, null, wallMs, counter)
  });

  const identifiers = [first.id, secondOperation.id, afterRestart.id, selectedTask.id];
  assert.deepEqual(identifiers, [...identifiers].sort());
  assert.deepEqual(
    identifiers.map((identifier) => storage.uuid7Parts(identifier).timestampMs),
    [100, 100, 100, 100]
  );
  assert.deepEqual(
    identifiers.map((identifier) => storage.uuid7Parts(identifier).randomValue),
    [9n, 10n, 11n, 12n]
  );
  assert.equal(await readMeta(instance.database, storage.UUID7_KEY), selectedTask.id);
});

test("UUIDv7 allocator reconstructs missing state without rewriting UUIDv4 queues", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  const legacy = command("550e8400-e29b-41d4-a716-446655440000", 1, 100);
  const existingV7 = storage.uuid7FromParts(100, 9n);
  await seedQueues(instance.database, {
    commands: [legacy],
    taskOperations: [taskOperation(existingV7, 100, 1)]
  });
  await seedMeta(instance.database, {
    deviceSequence: 1,
    hlc: { wallMs: 100, counter: 1 }
  });

  const operation = await storage.allocateMutation(instance.database, {
    storeName: "pendingAutoStarts",
    nowMs: 100,
    withDeviceSequence: false,
    withUuidV7: true,
    build: ({ id, wallMs, counter }) => autoStartOperation(id, true, wallMs, counter)
  });

  assert.deepEqual(storage.uuid7Parts(operation.id), {
    integer: storage.uuid7Parts(operation.id).integer,
    timestampMs: 100,
    randomValue: 10n
  });
  assert.deepEqual((await storage.readQueues(instance.database)).commands, [legacy]);
  assert.equal(await readMeta(instance.database, storage.UUID7_KEY), operation.id);
});

test("UUIDv7 stale or exhausted state aborts queue, HLC, and sequence writes", async () => {
  const cases = [
    {
      name: "stale",
      stored: storage.uuid7FromParts(100, 8n),
      pending: storage.uuid7FromParts(100, 9n),
      message: /predates/
    },
    {
      name: "exhausted",
      stored: storage.uuid7FromParts(100, storage.UUID7_RANDOM_MAX),
      pending: null,
      message: /headroom/
    }
  ];
  for (const item of cases) {
    const instance = await fixture();
    try {
      await seedMeta(instance.database, {
        deviceSequence: 0,
        hlc: { wallMs: 100, counter: 0 },
        [storage.UUID7_KEY]: item.stored
      });
      if (item.pending) {
        await seedQueues(instance.database, {
          taskOperations: [taskOperation(item.pending, 100)]
        });
      }
      const beforeQueues = await storage.readQueues(instance.database);

      await assert.rejects(storage.allocateMutation(instance.database, {
        storeName: "pending",
        nowMs: 100,
        withDeviceSequence: true,
        withUuidV7: true,
        build: ({ id, wallMs, counter, deviceSequence }) => command(
          id,
          deviceSequence,
          wallMs,
          counter
        )
      }), { name: "UUIDRangeError", message: item.message });

      assert.deepEqual(await storage.readQueues(instance.database), beforeQueues);
      assert.deepEqual((await storage.readCanonicalState(instance.database)).hlc, {
        wallMs: 100,
        counter: 0
      });
      assert.equal(await readMeta(instance.database, "deviceSequence"), 0);
      assert.equal(await readMeta(instance.database, storage.UUID7_KEY), item.stored);
    } finally {
      await instance.close();
    }
  }
});

test("UUIDv7 finish and generated break reserve one atomic consecutive batch", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await seedMeta(instance.database, {
    snapshot: runningFocusSnapshot(),
    deviceSequence: 0,
    hlc: { wallMs: 100, counter: 0 },
    timerOwner: {
      timerId: "owned-focus",
      deviceId: "device-owner",
      tabId: "tab-owner",
      leaseExpiresAtMs: 2_000
    }
  });

  const result = await storage.finishTimer(instance.database, {
    timerId: "owned-focus",
    phase: "focus",
    deviceId: "device-owner",
    tabId: "tab-owner",
    leaseMs: 1_000,
    manual: false,
    requireOwner: true,
    nowMs: 500,
    observedElapsedMs: 1_500_000,
    withUuidV7: true,
    entropy: fixedEntropy("09"),
    breakPhase: "short_break",
    breakDurationMs: 300_000,
    breakTimerId: "550e8400-e29b-41d4-a716-446655440000",
    settings: { selectedPhase: "short_break" }
  });

  const parts = result.commands.map((item) => storage.uuid7Parts(item.id));
  assert.deepEqual(parts.map((item) => item.timestampMs), [500, 500]);
  assert.deepEqual(parts.map((item) => item.randomValue), [9n, 10n]);
  assert.equal(result.commands[1].dependsOnCommandId, result.commands[0].id);
  assert.equal(await readMeta(instance.database, storage.UUID7_KEY), result.commands[1].id);
  assert.deepEqual(await readMeta(instance.database, "settings"), {
    selectedPhase: "short_break"
  });

  const firstBody = JSON.stringify(sync.buildSyncBatch({ commands: result.commands }));
  instance.database.close();
  instance.database = await openDatabase(instance.name);
  assert.equal(
    JSON.stringify(sync.buildSyncBatch(await storage.readSyncState(instance.database))),
    firstBody
  );
});

test("cancel and clear reserve one restart-safe atomic batch", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  const start = {
    ...command("generated-break-start", 4, 100, 4),
    timerId: "generated-break",
    phase: "short_break",
    plannedDurationMs: 300_000,
    dependsOnCommandId: "finish-source"
  };
  await seedMeta(instance.database, {
    snapshot: snapshot(0),
    deviceSequence: 4,
    hlc: { wallMs: 100, counter: 4 },
    timerOwner: {
      timerId: "generated-break",
      deviceId: "device-owner",
      tabId: "tab-owner",
      leaseExpiresAtMs: 2_000
    }
  });
  await seedQueues(instance.database, { commands: [start] });

  const result = await storage.cancelAndClearTimer(instance.database, {
    timerId: "generated-break",
    phase: "short_break",
    deviceId: "device-owner",
    nowMs: 500,
    observedElapsedMs: 10_000,
    withUuidV7: true,
    entropy: fixedEntropy("09")
  });

  assert.equal(result.transitioned, true);
  assert.deepEqual(result.commands.map((item) => item.type), ["cancel", "clear"]);
  assert.deepEqual(result.commands.map((item) => item.deviceSequence), [5, 6]);
  assert.deepEqual(result.commands.map((item) => item.hlcCounter), [0, 1]);
  assert.deepEqual(result.commands.map((item) => item.dependsOnCommandId), ["finish-source", "finish-source"]);
  assert.deepEqual(
    result.commands.map((item) => storage.uuid7Parts(item.id).randomValue),
    [9n, 10n]
  );
  assert.equal(await readMeta(instance.database, "timerOwner"), undefined);
  assert.equal(await readMeta(instance.database, storage.UUID7_KEY), result.commands[1].id);

  instance.database.close();
  instance.database = await openDatabase(instance.name);
  const persisted = (await storage.readQueues(instance.database)).commands
    .sort((left, right) => left.deviceSequence - right.deviceSequence);
  assert.deepEqual(persisted.map((item) => item.type), ["start", "cancel", "clear"]);
  assert.deepEqual(await storage.cancelAndClearTimer(instance.database, {
    timerId: "generated-break",
    phase: "short_break",
    deviceId: "device-owner",
    nowMs: 600,
    observedElapsedMs: 20_000,
    cancelCommandId: "cancel-retry",
    clearCommandId: "clear-retry"
  }), { transitioned: false, reason: "stale", commands: [] });
});

test("two tabs allocate unique timer sequences and monotonic timer/task HLC tuples", async (t) => {
  const instance = await fixture();
  const second = await instance.secondConnection();
  t.after(() => {
    second.close();
    return instance.close();
  });
  await seedMeta(instance.database, {
    deviceSequence: 0,
    hlc: { wallMs: 100, counter: 0 }
  });
  const allocateCommand = (database, id) => storage.allocateMutation(database, {
    storeName: "pending",
    nowMs: 100,
    withDeviceSequence: true,
    build: ({ wallMs, counter, deviceSequence }) => command(id, deviceSequence, wallMs, counter)
  });
  const commands = await Promise.all([
    allocateCommand(instance.database, "command-a"),
    allocateCommand(second, "command-b")
  ]);
  const allocateTask = (database, id) => storage.allocateMutation(database, {
    storeName: "pendingTasks",
    nowMs: 100,
    withDeviceSequence: false,
    build: ({ wallMs, counter }) => taskOperation(id, wallMs, counter)
  });
  const tasks = await Promise.all([
    allocateTask(instance.database, "task-a"),
    allocateTask(second, "task-b")
  ]);

  assert.deepEqual(commands.map((item) => item.deviceSequence).sort(), [1, 2]);
  const tuples = commands.concat(tasks).map((item) => `${item.hlcWallMs}:${item.hlcCounter}`);
  assert.equal(new Set(tuples).size, 4);
  assert.deepEqual(tuples.sort(), ["100:1", "100:2", "100:3", "100:4"]);
  const queues = await storage.readQueues(instance.database);
  assert.deepEqual(queues.commands.map((item) => item.id).sort(), ["command-a", "command-b"]);
  assert.deepEqual(queues.taskOperations.map((item) => item.id).sort(), ["task-a", "task-b"]);
});

test("mutation allocation rejects unsafe sequence and counter atomically", async () => {
  const cases = [
    { name: "sequence", deviceSequence: Number.MAX_SAFE_INTEGER, hlc: { wallMs: 100, counter: 0 }, nowMs: 100, withDeviceSequence: true },
    { name: "counter", deviceSequence: 0, hlc: { wallMs: 100, counter: Number.MAX_SAFE_INTEGER }, nowMs: 100, withDeviceSequence: false }
  ];
  for (const item of cases) {
    const instance = await fixture();
    await seedMeta(instance.database, { deviceSequence: item.deviceSequence, hlc: item.hlc });
    await assert.rejects(storage.allocateMutation(instance.database, {
      storeName: "pending",
      nowMs: item.nowMs,
      withDeviceSequence: item.withDeviceSequence,
      build: ({ wallMs, counter, deviceSequence }) => command(item.name, deviceSequence || 1, wallMs, counter)
    }), { name: "ClockRangeError" });
    const queues = await storage.readQueues(instance.database);
    assert.deepEqual(queues.commands, []);
    assert.deepEqual((await storage.readCanonicalState(instance.database)).hlc, item.hlc);
    await instance.close();
  }
});

test("focus ownership lease blocks live peers and allows same-device restart reclaim", async (t) => {
  const instance = await fixture();
  const staleTab = await instance.secondConnection();
  t.after(() => {
    staleTab.close();
    return instance.close();
  });
  await seedMeta(instance.database, {
    snapshot: snapshot(0),
    deviceSequence: 0,
    hlc: { wallMs: 100, counter: 0 }
  });
  const started = await storage.allocateMutation(instance.database, {
    storeName: "pending",
    nowMs: 100,
    withDeviceSequence: true,
    timerOwner: {
      deviceId: "device-owner",
      tabId: "tab-owner",
      nowMs: 100,
      leaseMs: 1_000
    },
    build: ({ wallMs, counter, deviceSequence }) => ({
      ...command("owned-focus-start", deviceSequence, wallMs, counter),
      timerId: "owned-focus",
      occurredAt: new Date(100).toISOString()
    })
  });
  assert.equal(started.deviceSequence, 1);
  instance.database.close();
  instance.database = await openDatabase(instance.name);
  assert.equal(await storage.renewTimerOwnership(instance.database, {
    timerId: "owned-focus",
    deviceId: "device-owner",
    tabId: "tab-owner",
    nowMs: 900,
    leaseMs: 1_000
  }), true);

  const completion = (database, deviceId, tabId, nowMs, suffix) => storage.finishTimer(
    database,
    {
      timerId: "owned-focus",
      phase: "focus",
      deviceId,
      tabId,
      leaseMs: 1_000,
      manual: false,
      requireOwner: true,
      nowMs,
      observedElapsedMs: 1_500_000,
      finishCommandId: `finish-${suffix}`,
      breakPhase: "short_break",
      breakDurationMs: 300_000,
      breakCommandId: `break-${suffix}`,
      breakTimerId: `break-timer-${suffix}`
    }
  );
  const livePeer = await completion(staleTab, "device-owner", "tab-peer", 1_500, "live-peer");
  assert.deepEqual(livePeer, {
    transitioned: false,
    reason: "not_owner",
    commands: [],
    retryAtMs: 1_900
  });
  const foreignObserver = await completion(staleTab, "device-observer", "tab-observer", 2_000, "observer");
  assert.deepEqual(foreignObserver, { transitioned: false, reason: "not_owner", commands: [] });
  const reclaimed = await completion(instance.database, "device-owner", "tab-reopened", 2_000, "reclaimed");
  assert.equal(reclaimed.transitioned, true);
  assert.deepEqual(reclaimed.commands.map((item) => item.type), ["finish", "start"]);
  assert.deepEqual(reclaimed.commands.map((item) => item.deviceId), ["device-owner", "device-owner"]);

  instance.database.close();
  instance.database = await openDatabase(instance.name);
  const persisted = (await storage.readQueues(instance.database)).commands
    .sort((left, right) => left.deviceSequence - right.deviceSequence);
  assert.deepEqual(persisted.map((item) => item.type), ["start", "finish", "start"]);
  assert.deepEqual(persisted.map((item) => item.deviceSequence), [1, 2, 3]);
  assert.equal(persisted.filter((item) => item.type === "finish" && item.timerId === "owned-focus").length, 1);
  assert.equal(persisted.filter((item) => item.type === "start" && item.phase === "short_break").length, 1);

  const retry = await completion(instance.database, "device-owner", "tab-reopened", 2_100, "retry");
  assert.deepEqual(retry, { transitioned: false, reason: "stale", commands: [] });
  assert.equal((await storage.readQueues(instance.database)).commands.length, 3);
});

test("sync install migrates missing owner only from same-device canonical start evidence", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await seedMeta(instance.database, {
    deviceId: "device-owner",
    snapshot: snapshot(0),
    deviceSequence: 0,
    hlc: { wallMs: 100, counter: 0 }
  });
  const incoming = runningFocusSnapshot(1, "upgraded-focus");
  incoming.canonicalTimer.status = "paused";
  incoming.canonicalTimer.startedByDeviceId = "device-owner";
  await storage.applySyncResponse(instance.database, {
    expectedUserId: "user-1",
    snapshot: incoming,
    hlc: { wallMs: 200, counter: 0 },
    queueIds: { commands: [], taskOperations: [], durationOperations: [], autoStartOperations: [] },
    timerOwnerClaim: {
      deviceId: "device-owner",
      tabId: "tab-before-restart",
      nowMs: 1_000,
      leaseMs: 1_000
    }
  });

  instance.database.close();
  instance.database = await openDatabase(instance.name);
  assert.equal(await storage.renewTimerOwnership(instance.database, {
    timerId: "upgraded-focus",
    deviceId: "device-owner",
    tabId: "tab-reopened",
    nowMs: 1_500,
    leaseMs: 1_000
  }), false);
  assert.equal(await storage.renewTimerOwnership(instance.database, {
    timerId: "upgraded-focus",
    deviceId: "device-owner",
    tabId: "tab-reopened",
    nowMs: 2_001,
    leaseMs: 1_000
  }), true);
});

test("bootstrap install never migrates missing owner from remote canonical start evidence", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await seedMeta(instance.database, {
    deviceId: "device-observer",
    snapshot: snapshot(0),
    deviceSequence: 0,
    hlc: { wallMs: 100, counter: 0 }
  });
  await acquire(instance.database);
  const pending = await capture(instance.database);
  const incoming = runningFocusSnapshot(1, "remote-focus");
  incoming.canonicalTimer.startedByDeviceId = "device-remote";
  await storage.applyResolution(instance.database, pending, {
    snapshot: incoming,
    hlc: { wallMs: 200, counter: 0 },
    timerOwnerClaim: {
      deviceId: "device-observer",
      tabId: "tab-observer",
      nowMs: 1_000,
      leaseMs: 1_000
    }
  });

  instance.database.close();
  instance.database = await openDatabase(instance.name);
  assert.equal(await storage.renewTimerOwnership(instance.database, {
    timerId: "remote-focus",
    deviceId: "device-observer",
    tabId: "tab-observer-reopened",
    nowMs: 10_000,
    leaseMs: 1_000
  }), false);
  const outcome = await storage.finishTimer(instance.database, {
    timerId: "remote-focus",
    phase: "focus",
    deviceId: "device-observer",
    tabId: "tab-observer-reopened",
    leaseMs: 1_000,
    manual: false,
    requireOwner: true,
    nowMs: 10_000,
    observedElapsedMs: 1_500_000,
    finishCommandId: "finish-remote-observer",
    breakPhase: "short_break",
    breakDurationMs: 300_000,
    breakCommandId: "break-remote-observer",
    breakTimerId: "break-timer-remote-observer"
  });
  assert.deepEqual(outcome, { transitioned: false, reason: "not_owner", commands: [] });
  assert.deepEqual((await storage.readQueues(instance.database)).commands, []);
});

test("acknowledged local start is not retained ownership evidence for remote canonical timer", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  const localStart = { ...command("sent-local-start", 1), timerId: "remote-focus" };
  await seedMeta(instance.database, {
    deviceId: "device-observer",
    snapshot: snapshot(0),
    deviceSequence: 1,
    hlc: { wallMs: 100, counter: 0 }
  });
  await seedQueues(instance.database, { commands: [localStart] });
  const incoming = runningFocusSnapshot(1, "remote-focus");
  incoming.canonicalTimer.startedByDeviceId = "device-remote";
  await storage.applySyncResponse(instance.database, {
    expectedUserId: "user-1",
    snapshot: incoming,
    hlc: { wallMs: 200, counter: 0 },
    queueIds: {
      commands: [localStart.id],
      taskOperations: [],
      durationOperations: [],
      autoStartOperations: []
    },
    timerOwnerClaim: {
      deviceId: "device-observer",
      tabId: "tab-observer",
      nowMs: 1_000,
      leaseMs: 1_000
    }
  });

  assert.deepEqual((await storage.readQueues(instance.database)).commands, []);
  assert.equal(await storage.renewTimerOwnership(instance.database, {
    timerId: "remote-focus",
    deviceId: "device-observer",
    tabId: "tab-observer",
    nowMs: 10_000,
    leaseMs: 1_000
  }), false);
});

test("explicit remote start evidence overrides retained same-ID local command", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  const localStart = { ...command("retained-local-start", 1), timerId: "shared-focus" };
  const remote = runningFocusSnapshot(1, "shared-focus");
  remote.canonicalTimer.startedByDeviceId = "device-remote";
  await seedMeta(instance.database, {
    deviceId: "device-observer",
    snapshot: remote,
    deviceSequence: 1,
    hlc: { wallMs: 100, counter: 0 }
  });
  await seedQueues(instance.database, { commands: [localStart] });

  assert.equal(await storage.renewTimerOwnership(instance.database, {
    timerId: "shared-focus",
    deviceId: "device-observer",
    tabId: "tab-observer",
    nowMs: 10_000,
    leaseMs: 1_000
  }), false);
});

test("automatic completion atomically claims upgraded same-device timer after restart", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  const upgraded = runningFocusSnapshot(1, "restart-race-focus");
  upgraded.canonicalTimer.startedByDeviceId = "device-owner";
  await seedMeta(instance.database, {
    deviceId: "device-owner",
    snapshot: upgraded,
    deviceSequence: 0,
    hlc: { wallMs: 100, counter: 0 }
  });
  instance.database.close();
  instance.database = await openDatabase(instance.name);

  const outcome = await storage.finishTimer(instance.database, {
    timerId: "restart-race-focus",
    phase: "focus",
    deviceId: "device-owner",
    tabId: "tab-reopened",
    leaseMs: 1_000,
    manual: false,
    requireOwner: true,
    nowMs: 1_000,
    observedElapsedMs: 1_500_000,
    finishCommandId: "finish-restart-race",
    breakPhase: "short_break",
    breakDurationMs: 300_000,
    breakCommandId: "break-restart-race",
    breakTimerId: "break-timer-restart-race"
  });
  assert.equal(outcome.transitioned, true);
  assert.deepEqual(outcome.commands.map((item) => item.type), ["finish", "start"]);
  assert.equal((await storage.readQueues(instance.database)).commands.length, 2);
});

test("manual non-owner finish atomically claims focus and creates provisional break", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await seedMeta(instance.database, {
    snapshot: runningFocusSnapshot(),
    deviceSequence: 0,
    hlc: { wallMs: 100, counter: 0 },
    timerOwner: {
      timerId: "owned-focus",
      deviceId: "device-owner",
      tabId: "tab-owner",
      leaseExpiresAtMs: 2_000
    }
  });
  const result = await storage.finishTimer(instance.database, {
    timerId: "owned-focus",
    phase: "focus",
    deviceId: "device-observer",
    tabId: "tab-observer",
    leaseMs: 1_000,
    manual: true,
    requireOwner: false,
    nowMs: 500,
    observedElapsedMs: 500,
    finishCommandId: "finish-manual-claim",
    breakPhase: "short_break",
    breakDurationMs: 300_000,
    breakCommandId: "break-manual-claim",
    breakTimerId: "break-timer-manual-claim"
  });
  assert.equal(result.transitioned, true);
  assert.equal(result.commands[1].dependsOnCommandId, "finish-manual-claim");
  assert.equal(result.commands[1].generatedBreak, true);
  assert.equal(await storage.renewTimerOwnership(instance.database, {
    timerId: "break-timer-manual-claim",
    deviceId: "device-observer",
    tabId: "tab-observer",
    nowMs: 600,
    leaseMs: 1_000
  }), true);
  assert.deepEqual(sync.buildSyncBatch({ commands: result.commands }).commands.map((item) => item.id), [
    "finish-manual-claim"
  ]);
});

test("generated break survives lost response and promotes only after applied finish", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await seedMeta(instance.database, {
    snapshot: runningFocusSnapshot(),
    deviceSequence: 0,
    hlc: { wallMs: 100, counter: 0 },
    timerOwner: {
      timerId: "owned-focus",
      deviceId: "device-owner",
      tabId: "tab-owner",
      leaseExpiresAtMs: 2_000
    }
  });
  const result = await storage.finishTimer(instance.database, {
    timerId: "owned-focus",
    phase: "focus",
    deviceId: "device-owner",
    tabId: "tab-owner",
    leaseMs: 1_000,
    manual: false,
    requireOwner: true,
    nowMs: 500,
    observedElapsedMs: 1_500_000,
    finishCommandId: "finish-dependent-source",
    breakPhase: "short_break",
    breakDurationMs: 300_000,
    breakCommandId: "break-dependent-start",
    breakTimerId: "break-dependent-timer"
  });
  const firstBody = JSON.stringify(sync.buildSyncBatch({ commands: result.commands }));
  instance.database.close();
  instance.database = await openDatabase(instance.name);
  const reloaded = await storage.readSyncState(instance.database);
  assert.equal(JSON.stringify(sync.buildSyncBatch(reloaded)), firstBody);
  assert.deepEqual(JSON.parse(firstBody).commands.map((item) => item.id), ["finish-dependent-source"]);

  const acknowledgements = [{ commandId: "finish-dependent-source", outcome: "applied", reason: "" }];
  const canonical = snapshot(1, "user-1", "2026-07-22T12:31:00Z");
  canonical.canonicalTimer = {
    id: "owned-focus",
    phase: "focus",
    status: "completed",
    plannedDurationMs: 1_500_000,
    elapsedAtAnchorMs: 1_500_000,
    anchorAt: "2026-07-22T12:25:00Z"
  };
  canonical.history = [{
    id: "history-finish-dependent-source",
    timerId: "owned-focus",
    commandId: "finish-dependent-source",
    phase: "focus",
    status: "completed",
    plannedDurationMs: 1_500_000,
    completedAt: "2026-07-22T12:25:00Z"
  }];
  const updates = sync.generatedBreakUpdates(reloaded.commands, acknowledgements, canonical);
  await storage.applySyncResponse(instance.database, {
    expectedUserId: "user-1",
    snapshot: canonical,
    hlc: { wallMs: 500, counter: 1 },
    queueIds: {
      commands: ["finish-dependent-source"],
      taskOperations: [],
      durationOperations: [],
      autoStartOperations: []
    },
    ...updates
  });
  const promoted = (await storage.readQueues(instance.database)).commands;
  assert.deepEqual(promoted.map((item) => item.id), ["break-dependent-start"]);
  assert.equal(Object.hasOwn(promoted[0], "dependsOnCommandId"), false);
  assert.equal(Object.hasOwn(promoted[0], "generatedBreak"), false);
  assert.deepEqual(sync.buildSyncBatch({ commands: promoted }).commands.map((item) => item.id), [
    "break-dependent-start"
  ]);
});

test("provisional chain matrix survives restart and response loss", async () => {
  const chains = [
    ["start"],
    ["start", "pause"],
    ["start", "pause", "resume"],
    ["start", "finish"],
    ["start", "cancel"],
    ["start", "finish", "clear"]
  ];
  let caseIndex = 0;
  for (const types of chains) {
    for (const outcome of ["applied", "ignored", "rejected"]) {
      for (const phaseCorrection of [false, true]) {
        for (const restartBeforeHttp of [false, true]) {
          for (const responseLoss of [false, true]) {
            caseIndex += 1;
            const label = [
              types.join("-"),
              outcome,
              phaseCorrection ? "long" : "short",
              restartBeforeHttp ? "restart" : "live",
              responseLoss ? "lost" : "delivered"
            ].join("/");
            const instance = await fixture();
            try {
              const source = {
                ...command(`00-source-${caseIndex}`, 1),
                timerId: `focus-${caseIndex}`,
                type: "finish",
                phase: "focus"
              };
              const dependents = types.map((type, index) => ({
                ...command(`1${index}-dependent-${caseIndex}`, index + 2),
                timerId: `break-${caseIndex}`,
                type,
                phase: "short_break",
                plannedDurationMs: 300_000,
                observedElapsedMs: index * 1_000,
                dependsOnCommandId: source.id,
                ...(index === 0 ? { generatedBreak: true } : {})
              }));
              await seedMeta(instance.database, {
                snapshot: snapshot(0),
                hlc: { wallMs: 100, counter: 0 }
              });
              await seedQueues(instance.database, { commands: [source, ...dependents] });
              if (restartBeforeHttp) {
                instance.database.close();
                instance.database = await openDatabase(instance.name);
              }
              let pending = (await storage.readQueues(instance.database)).commands;
              assert.deepEqual(
                sync.buildSyncBatch({ commands: pending }).commands.map((item) => item.id),
                [source.id],
                label
              );
              const canonical = snapshot(1);
              canonical.history = [
                ...(phaseCorrection ? [1, 2, 3].map((index) => ({
                  id: `prior-${index}-${caseIndex}`,
                  timerId: `prior-${index}-${caseIndex}`,
                  commandId: `prior-command-${index}-${caseIndex}`,
                  phase: "focus",
                  status: "completed",
                  plannedDurationMs: 1_500_000,
                  completedAt: `2026-07-22T12:2${index}:00Z`
                })) : []),
                {
                  id: `completion-${caseIndex}`,
                  timerId: source.timerId,
                  commandId: source.id,
                  phase: "focus",
                  status: "completed",
                  plannedDurationMs: 1_500_000,
                  completedAt: "2026-07-22T12:25:00Z"
                }
              ];
              canonical.canonicalTimer = {
                id: source.timerId,
                phase: "focus",
                status: "completed",
                plannedDurationMs: 1_500_000,
                elapsedAtAnchorMs: 1_500_000,
                anchorAt: "2026-07-22T12:25:00Z"
              };
              const acknowledgements = [{ commandId: source.id, outcome, reason: "" }];
              let updates = sync.generatedBreakUpdates(pending, acknowledgements, canonical);
              if (responseLoss) {
                const firstUpdates = JSON.stringify(updates);
                instance.database.close();
                instance.database = await openDatabase(instance.name);
                pending = (await storage.readQueues(instance.database)).commands;
                updates = sync.generatedBreakUpdates(pending, acknowledgements, canonical);
                assert.equal(JSON.stringify(updates), firstUpdates, label);
              }
              await storage.applySyncResponse(instance.database, {
                expectedUserId: "user-1",
                snapshot: canonical,
                hlc: { wallMs: 500, counter: 0 },
                queueIds: {
                  commands: [source.id],
                  taskOperations: [],
                  durationOperations: [],
                  autoStartOperations: []
                },
                ...updates
              });
              instance.database.close();
              instance.database = await openDatabase(instance.name);
              const after = (await storage.readQueues(instance.database)).commands;
              const releases = outcome !== "rejected";
              assert.deepEqual(
                after.map((item) => item.id),
                releases ? dependents.map((item) => item.id) : [],
                label
              );
              if (releases) {
                const expectedPhase = phaseCorrection && !types.includes("finish")
                  ? "long_break"
                  : "short_break";
                assert.ok(after.every((item) =>
                  item.phase === expectedPhase
                    && item.plannedDurationMs === canonical.durationsMs[expectedPhase]
                    && !Object.hasOwn(item, "dependsOnCommandId")
                    && !Object.hasOwn(item, "generatedBreak")
                ), label);
              }
            } finally {
              await instance.close();
            }
          }
        }
      }
    }
  }
});

test("normal sync survives every restart checkpoint", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  const operation = taskOperation("restart-task-operation");
  await seedMeta(instance.database, {
    snapshot: snapshot(0),
    hlc: { wallMs: 100, counter: 0 }
  });
  await seedQueues(instance.database, { taskOperations: [operation] });
  const firstBody = JSON.stringify(sync.buildSyncBatch(await storage.readSyncState(instance.database)));

  instance.database.close();
  instance.database = await openDatabase(instance.name);
  assert.equal(
    JSON.stringify(sync.buildSyncBatch(await storage.readSyncState(instance.database))),
    firstBody
  );

  instance.database.close();
  instance.database = await openDatabase(instance.name);
  assert.equal(
    JSON.stringify(sync.buildSyncBatch(await storage.readSyncState(instance.database))),
    firstBody
  );

  const canonical = snapshot(1);
  canonical.tasks = [{ id: operation.taskId, title: operation.title }];
  await storage.applySyncResponse(instance.database, {
    expectedUserId: "user-1",
    snapshot: canonical,
    hlc: { wallMs: 200, counter: 0 },
    queueIds: {
      commands: [],
      taskOperations: [operation.id],
      durationOperations: [],
      autoStartOperations: []
    }
  });

  instance.database.close();
  instance.database = await openDatabase(instance.name);
  const afterApply = await storage.readSyncState(instance.database);
  assert.deepEqual(sync.buildSyncBatch(afterApply).taskOperations, []);
  assert.deepEqual(afterApply.snapshot, canonical);
});

test("ignored finish drops provisional break and rebases to newer canonical timer", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await seedMeta(instance.database, {
    snapshot: runningFocusSnapshot(),
    deviceSequence: 0,
    hlc: { wallMs: 100, counter: 0 },
    timerOwner: {
      timerId: "owned-focus",
      deviceId: "device-owner",
      tabId: "tab-owner",
      leaseExpiresAtMs: 2_000
    }
  });
  await storage.finishTimer(instance.database, {
    timerId: "owned-focus",
    phase: "focus",
    deviceId: "device-owner",
    tabId: "tab-owner",
    leaseMs: 1_000,
    manual: false,
    requireOwner: true,
    nowMs: 500,
    observedElapsedMs: 1_500_000,
    finishCommandId: "finish-ignored-source",
    breakPhase: "long_break",
    breakDurationMs: 900_000,
    breakCommandId: "break-ignored-start",
    breakTimerId: "break-ignored-timer"
  });
  const pending = (await storage.readQueues(instance.database)).commands;
  const acknowledgements = [{ commandId: "finish-ignored-source", outcome: "ignored", reason: "superseded" }];
  const canonical = snapshot(1, "user-1", "2026-07-22T12:31:00Z");
  canonical.canonicalTimer = {
    id: "remote-newer",
    phase: "focus",
    status: "running",
    plannedDurationMs: 1_500_000,
    elapsedAtAnchorMs: 0,
    anchorAt: "2026-07-22T12:30:00Z"
  };
  await storage.applySyncResponse(instance.database, {
    expectedUserId: "user-1",
    snapshot: canonical,
    hlc: { wallMs: 500, counter: 1 },
    queueIds: {
      commands: ["finish-ignored-source"],
      taskOperations: [],
      durationOperations: [],
      autoStartOperations: []
    },
    ...sync.generatedBreakUpdates(pending, acknowledgements, canonical)
  });
  assert.deepEqual((await storage.readQueues(instance.database)).commands, []);
  assert.equal((await storage.readCanonicalState(instance.database)).snapshot.canonicalTimer.id, "remote-newer");
  assert.equal(await storage.renewTimerOwnership(instance.database, {
    timerId: "break-ignored-timer",
    deviceId: "device-owner",
    tabId: "tab-owner",
    nowMs: 600,
    leaseMs: 1_000
  }), false);
});

test("offline cached owner can append locally before a different account discards without upload", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await seedMeta(instance.database, {
    snapshot: snapshot(3, "user-old"),
    deviceSequence: 1,
    hlc: { wallMs: 100, counter: 0 }
  });
  await seedQueues(instance.database, { commands: [command("cached", 1)] });
  assert.equal((await acquire(instance.database, "offline-tab", 1_000, 1_000)).acquired, true);
  const cached = await storage.readSyncState(instance.database);
  assert.equal(cached.snapshot.user.id, "user-old");
  await storage.clearBootstrapGate(instance.database, "offline-tab");

  await storage.allocateMutation(instance.database, {
    storeName: "pending",
    nowMs: 101,
    withDeviceSequence: true,
    build: ({ wallMs, counter, deviceSequence }) => command("offline", deviceSequence, wallMs, counter)
  });
  assert.deepEqual((await storage.readQueues(instance.database)).commands.map((item) => item.id).sort(), ["cached", "offline"]);

  assert.deepEqual(sync.decideBootstrap({
    localOwnerId: "user-old",
    currentUserId: "user-new",
    localHistory: [],
    remoteHistory: [],
    hasLocalState: true
  }), { mode: "auto", strategy: "keep_remote", reason: "different_owner" });
  await acquire(instance.database, "new-account-tab", 2_001, 1_000);
  const pending = await capture(instance.database, resolutionInput("keep_remote", "user-new"), "new-account-tab");
  assert.deepEqual(pending.payload.commands, []);
  assert.deepEqual(pending.queueIds.commands.sort(), ["cached", "offline"]);
});

test("oversized bootstrap request is not persisted and keep-remote recovery remains available", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  const operations = Array.from({ length: 4097 }, (_, index) => taskOperation(`overflow-${index}`, index + 1));
  await seedQueues(instance.database, { taskOperations: operations });
  await acquire(instance.database);

  await assert.rejects(capture(instance.database, resolutionInput("merge")), {
    name: "ResolutionLimitError",
    field: "taskOperations",
    count: 4097,
    limit: 4096
  });
  const blocked = await storage.readBootstrapState(instance.database);
  assert.equal(blocked.resolution, null);
  assert.equal(blocked.gate.token, "tab-1");
  assert.equal((await storage.readQueues(instance.database)).taskOperations.length, 4097);

  const recovery = await capture(instance.database, resolutionInput("keep_remote"));
  assert.deepEqual(recovery.payload.taskOperations, []);
  assert.equal(recovery.queueIds.taskOperations.length, 4097);
});

test("account switch waits for live foreign lease before invalidating its exact request", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await acquire(instance.database, "tab-old", 1_000, 1_000);
  const oldPending = await capture(instance.database, resolutionInput("merge", "user-old"), "tab-old");

  const blocked = await storage.invalidateForeignResolution(instance.database, {
    currentUserId: "user-new",
    gateToken: "tab-new",
    nowMs: 1_100,
    leaseMs: 1_000
  });
  assert.equal(blocked.acquired, false);
  assert.equal(blocked.invalidated, false);
  assert.equal((await storage.readBootstrapState(instance.database)).resolution.userId, "user-old");
  assert.equal((await storage.readBootstrapState(instance.database)).gate.token, "tab-old");

  const invalidated = await storage.invalidateForeignResolution(instance.database, {
    currentUserId: "user-new",
    gateToken: "tab-new",
    nowMs: 2_001,
    leaseMs: 1_000
  });
  assert.equal(invalidated.acquired, true);
  assert.equal(invalidated.invalidated, true);
  assert.equal((await storage.readBootstrapState(instance.database)).resolution, null);
  assert.equal((await storage.readBootstrapState(instance.database)).gate.token, "tab-new");
  await assert.rejects(storage.validatePendingForSend(instance.database, {
    pending: oldPending,
    currentUserId: "user-new",
    gateToken: "tab-new",
    nowMs: 2_001,
    leaseMs: 1_000
  }), { name: "BootstrapGateError" });
});

test("account restart does not replace another tab's live gate without a resolution", async (t) => {
  const instance = await fixture();
  const second = await instance.secondConnection();
  t.after(() => {
    second.close();
    return instance.close();
  });
  await acquire(instance.database, "tab-owner", 1_000, 1_000);

  const blocked = await storage.invalidateForeignResolution(second, {
    currentUserId: "user-new",
    gateToken: "tab-waiting",
    nowMs: 1_500,
    leaseMs: 1_000
  });

  assert.equal(blocked.acquired, false);
  assert.equal(blocked.invalidated, false);
  assert.deepEqual(await storage.readBootstrapState(instance.database), {
    gate: { token: "tab-owner", acquiredAtMs: 1_000, expiresAtMs: 2_000 },
    resolution: null
  });
});

test("stale lease takeover adopts exact pending request without changing server body", async (t) => {
  const instance = await fixture();
  const second = await instance.secondConnection();
  t.after(() => {
    second.close();
    return instance.close();
  });
  await acquire(instance.database, "tab-old", 1_000, 1_000);
  const original = await capture(instance.database, resolutionInput(), "tab-old");
  const takeover = await acquire(second, "tab-new", 2_001, 1_000);

  assert.equal(takeover.acquired, true);
  assert.equal(takeover.resolution.gateToken, "tab-new");
  assert.equal(JSON.stringify(takeover.resolution.payload), JSON.stringify(original.payload));
  await storage.validatePendingForSend(second, {
    pending: takeover.resolution,
    currentUserId: "user-1",
    gateToken: "tab-new",
    nowMs: 2_002,
    leaseMs: 1_000
  });
});

test("resolution apply atomically stores exact canonical state and preserves uncaptured rows", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await seedQueues(instance.database, {
    commands: [command("captured", 1)],
    taskOperations: [taskOperation("captured-task")],
    durationOperations: [durationOperation("captured-duration")],
    autoStartOperations: [autoStartOperation("captured-auto-start")],
    selectedTaskOperations: [selectedTaskOperation("captured-selected-task", "task-captured")]
  });
  await acquire(instance.database);
  const pending = await capture(instance.database, resolutionInput("replace_remote"));
  await seedQueues(instance.database, {
    commands: [command("newer", 2)],
    taskOperations: [taskOperation("newer-task")],
    durationOperations: [durationOperation("newer-duration")],
    autoStartOperations: [autoStartOperation("newer-auto-start", false, 2)],
    selectedTaskOperations: [selectedTaskOperation("newer-selected-task", null, 2)]
  });

  const canonicalSnapshot = snapshot(4);
  canonicalSnapshot.history = [{ id: "local-history", timerId: "local-history" }];
  canonicalSnapshot.tasks = [{ id: "local-task", title: "Local task" }];
  canonicalSnapshot.durationsMs.focus = 1_800_000;
  const transactions = [];
  const observedDatabase = {
    transaction(storeNames, mode) {
      transactions.push({ storeNames: [...storeNames], mode });
      return instance.database.transaction(storeNames, mode);
    }
  };
  const outcome = await storage.applyResolution(observedDatabase, pending, {
    snapshot: canonicalSnapshot,
    hlc: { wallMs: 10, counter: 0 }
  });
  assert.equal(outcome.applied, true);
  assert.deepEqual(transactions, [{
    storeNames: ["meta", "pending", "pendingTasks", "pendingDurations", "pendingAutoStarts", "pendingSelectedTasks"],
    mode: "readwrite"
  }]);
  assert.deepEqual((await storage.readCanonicalState(instance.database)).snapshot, canonicalSnapshot);
  const queues = await storage.readQueues(instance.database);
  assert.deepEqual(queues.commands.map((item) => item.id), ["newer"]);
  assert.deepEqual(queues.taskOperations.map((item) => item.id), ["newer-task"]);
  assert.deepEqual(queues.durationOperations.map((item) => item.id), ["newer-duration"]);
  assert.deepEqual(queues.autoStartOperations.map((item) => item.id), ["newer-auto-start"]);
  assert.deepEqual(queues.selectedTaskOperations.map((item) => item.id), ["newer-selected-task"]);
  assert.deepEqual(await storage.readBootstrapState(instance.database), { gate: null, resolution: null });
});

test("merge resolution atomically commits combined canonical history and tasks", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await seedQueues(instance.database, {
    commands: [command("local-command", 1)],
    taskOperations: [taskOperation("local-task")],
    durationOperations: [durationOperation("local-duration")],
    autoStartOperations: [autoStartOperation("local-auto-start")],
    selectedTaskOperations: [selectedTaskOperation("local-selected-task", "local-task")]
  });
  await acquire(instance.database);
  const pending = await capture(instance.database, resolutionInput("merge"));
  const canonicalSnapshot = snapshot(4);
  canonicalSnapshot.history = [
    { id: "local-history", timerId: "local-history" },
    { id: "remote-history", timerId: "remote-history" }
  ];
  canonicalSnapshot.tasks = [
    { id: "local-task", title: "Local task" },
    { id: "remote-task", title: "Remote task" }
  ];

  const outcome = await storage.applyResolution(instance.database, pending, {
    snapshot: canonicalSnapshot,
    hlc: { wallMs: 400, counter: 0 }
  });

  assert.equal(outcome.applied, true);
  assert.deepEqual((await storage.readCanonicalState(instance.database)).snapshot, canonicalSnapshot);
  assert.deepEqual(await storage.readQueues(instance.database), {
    commands: [],
    taskOperations: [],
    durationOperations: [],
    autoStartOperations: [],
    selectedTaskOperations: []
  });
  assert.deepEqual(await storage.readBootstrapState(instance.database), { gate: null, resolution: null });
});

test("applied sync acknowledgement deletes exact mixed IDs and preserves later rows", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await seedMeta(instance.database, {
    snapshot: snapshot(3),
    hlc: { wallMs: 300, counter: 0 }
  });
  await seedQueues(instance.database, {
    commands: [command("sent", 1), command("later", 2)],
    taskOperations: [taskOperation("sent-task"), taskOperation("later-task", 2)],
    durationOperations: [durationOperation("sent-duration"), durationOperation("later-duration")],
    autoStartOperations: [autoStartOperation("sent-auto-start"), autoStartOperation("later-auto-start", false, 2)],
    selectedTaskOperations: [
      selectedTaskOperation("sent-selected-task", "task-sent"),
      selectedTaskOperation("later-selected-task", null, 2)
    ]
  });
  const incoming = snapshot(4);
  incoming.tasks = [{ id: "remote-task", title: "Remote task" }];

  const outcome = await storage.applySyncResponse(instance.database, {
    expectedUserId: "user-1",
    snapshot: incoming,
    hlc: { wallMs: 400, counter: 0 },
    settings: { selectedPhase: "focus" },
    queueIds: {
      commands: ["sent"],
      taskOperations: ["sent-task"],
      durationOperations: ["sent-duration"],
      autoStartOperations: ["sent-auto-start"],
      selectedTaskOperations: ["sent-selected-task"]
    }
  });

  assert.equal(outcome.applied, true);
  const persisted = await storage.readSyncState(instance.database);
  assert.deepEqual(persisted.snapshot, incoming);
  assert.deepEqual(persisted.commands.map((item) => item.id), ["later"]);
  assert.deepEqual(persisted.taskOperations.map((item) => item.id), ["later-task"]);
  assert.deepEqual(persisted.durationOperations.map((item) => item.id), ["later-duration"]);
  assert.deepEqual(persisted.autoStartOperations.map((item) => item.id), ["later-auto-start"]);
  assert.deepEqual(persisted.selectedTaskOperations.map((item) => item.id), ["later-selected-task"]);
  assert.deepEqual(await readMeta(instance.database, "settings"), { selectedPhase: "focus" });
});

test("waiting tab sees peer-applied owner and queues before planning", async (t) => {
  const instance = await fixture();
  const waiting = await instance.secondConnection();
  t.after(() => {
    waiting.close();
    return instance.close();
  });
  await seedQueues(instance.database, {
    commands: [command("captured", 1)],
    taskOperations: [taskOperation("captured-task")]
  });
  await acquire(instance.database, "tab-owner", 1_000, 1_000);
  const pending = await capture(instance.database, resolutionInput("merge", "user-1"), "tab-owner");
  assert.equal((await acquire(waiting, "tab-waiting", 1_500, 1_000)).acquired, false);

  await storage.applyResolution(instance.database, pending, {
    snapshot: snapshot(4, "user-1"),
    hlc: { wallMs: 400, counter: 0 }
  });
  assert.equal((await acquire(waiting, "tab-waiting", 1_600, 1_000)).acquired, true);
  const persisted = await storage.readSyncState(waiting);

  assert.equal(persisted.snapshot.user.id, "user-1");
  assert.deepEqual(persisted.commands, []);
  assert.deepEqual(persisted.taskOperations, []);
  assert.deepEqual(sync.decideBootstrap({
    localOwnerId: persisted.snapshot.user.id,
    currentUserId: "user-1"
  }), { mode: "normal_sync", reason: "same_owner" });
});

test("sync state reads canonical snapshot, HLC, and queues in one transaction", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await seedMeta(instance.database, {
    snapshot: snapshot(6),
    hlc: { wallMs: 600, counter: 2 }
  });
  await seedQueues(instance.database, {
    commands: [command("command-1", 1)],
    taskOperations: [taskOperation("task-1")],
    durationOperations: [durationOperation("duration-1")],
    autoStartOperations: [autoStartOperation("auto-start-1")],
    selectedTaskOperations: [selectedTaskOperation("selected-task-1", null)]
  });
  const transactions = [];
  const observedDatabase = {
    transaction(storeNames, mode) {
      transactions.push({ storeNames: [...storeNames], mode });
      return instance.database.transaction(storeNames, mode);
    }
  };

  const persisted = await storage.readSyncState(observedDatabase);

  assert.deepEqual(transactions, [{
    storeNames: ["meta", "pending", "pendingTasks", "pendingDurations", "pendingAutoStarts", "pendingSelectedTasks"],
    mode: "readonly"
  }]);
  assert.equal(persisted.snapshot.revision, 6);
  assert.deepEqual(persisted.hlc, { wallMs: 600, counter: 2 });
  assert.deepEqual(persisted.commands.map((item) => item.id), ["command-1"]);
  assert.deepEqual(persisted.taskOperations.map((item) => item.id), ["task-1"]);
  assert.deepEqual(persisted.durationOperations.map((item) => item.id), ["duration-1"]);
  assert.deepEqual(persisted.autoStartOperations.map((item) => item.id), ["auto-start-1"]);
  assert.deepEqual(persisted.selectedTaskOperations.map((item) => item.id), ["selected-task-1"]);
});

test("delayed sync response retains newer canonical snapshot, HLC, and all pending work", async (t) => {
  const instance = await fixture();
  const second = await instance.secondConnection();
  t.after(() => {
    second.close();
    return instance.close();
  });
  await seedQueues(instance.database, {
    commands: [command("sent", 1), command("newer", 2)],
    taskOperations: [taskOperation("sent-task"), taskOperation("newer-task")]
  });
  await seedMeta(second, {
    snapshot: snapshot(8),
    hlc: { wallMs: 800, counter: 0 }
  });

  const outcome = await storage.applySyncResponse(instance.database, {
    expectedUserId: "user-1",
    snapshot: snapshot(7),
    hlc: { wallMs: 700, counter: 0 },
    queueIds: {
      commands: ["sent"],
      taskOperations: ["sent-task"],
      durationOperations: []
    }
  });
  assert.equal(outcome.stale, true);
  const canonical = await storage.readCanonicalState(instance.database);
  assert.equal(canonical.snapshot.revision, 8);
  assert.deepEqual(canonical.hlc, { wallMs: 800, counter: 0 });
  const queues = await storage.readQueues(instance.database);
  assert.deepEqual(queues.commands.map((item) => item.id), ["newer", "sent"]);
  assert.deepEqual(queues.taskOperations.map((item) => item.id), ["newer-task", "sent-task"]);
});

test("equal-revision response applies acknowledgements despite server clock rollback", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await seedMeta(instance.database, {
    snapshot: snapshot(8, "user-1", "2026-07-22T12:30:00Z"),
    hlc: { wallMs: 800, counter: 0 }
  });
  await seedQueues(instance.database, { commands: [command("sent", 1)] });
  const incoming = snapshot(8, "user-1", "2026-07-22T12:29:59.999999999Z");

  const outcome = await storage.applySyncResponse(instance.database, {
    expectedUserId: "user-1",
    snapshot: incoming,
    hlc: { wallMs: 900, counter: 0 },
    queueIds: { commands: ["sent"], taskOperations: [], durationOperations: [] }
  });

  assert.equal(outcome.applied, true);
  assert.equal(outcome.stale, false);
  const persisted = await storage.readSyncState(instance.database);
  assert.equal(persisted.snapshot.serverTime, "2026-07-22T12:29:59.999999999Z");
  assert.deepEqual(persisted.snapshot.tasks, []);
  assert.deepEqual(persisted.commands, []);
  assert.deepEqual(persisted.hlc, { wallMs: 900, counter: 0 });
});

test("equal-revision response applies acknowledgements with a later server time", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await seedMeta(instance.database, {
    snapshot: snapshot(8, "user-1", "2026-07-22T12:30:00Z"),
    hlc: { wallMs: 800, counter: 0 }
  });
  await seedQueues(instance.database, { commands: [command("sent", 1)] });
  const incoming = snapshot(8, "user-1", "2026-07-22T12:30:00.000000001Z");

  const outcome = await storage.applySyncResponse(instance.database, {
    expectedUserId: "user-1",
    snapshot: incoming,
    hlc: { wallMs: 900, counter: 0 },
    queueIds: { commands: ["sent"], taskOperations: [], durationOperations: [] }
  });

  assert.equal(outcome.applied, true);
  const persisted = await storage.readSyncState(instance.database);
  assert.equal(persisted.snapshot.serverTime, "2026-07-22T12:30:00.000000001Z");
  assert.deepEqual(persisted.snapshot.tasks, []);
  assert.deepEqual(persisted.commands, []);
  assert.deepEqual(persisted.hlc, { wallMs: 900, counter: 0 });
});

test("exact equal-revision response still consumes its acknowledgements", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await seedMeta(instance.database, {
    snapshot: snapshot(8, "user-1", "2026-07-22T12:30:00.123456789Z"),
    hlc: { wallMs: 800, counter: 0 }
  });
  await seedQueues(instance.database, { commands: [command("sent", 1)] });
  const incoming = snapshot(8, "user-1", "2026-07-22T12:30:00.123456789Z");

  const outcome = await storage.applySyncResponse(instance.database, {
    expectedUserId: "user-1",
    snapshot: incoming,
    hlc: { wallMs: 900, counter: 0 },
    queueIds: { commands: ["sent"], taskOperations: [], durationOperations: [] }
  });

  assert.equal(outcome.applied, true);
  assert.equal(outcome.stale, false);
  const persisted = await storage.readSyncState(instance.database);
  assert.deepEqual(persisted.snapshot.tasks, []);
  assert.deepEqual(persisted.commands, []);
  assert.deepEqual(persisted.hlc, { wallMs: 900, counter: 0 });
});

test("current sync response preserves a newer HLC allocated by another tab", async (t) => {
  const instance = await fixture();
  const second = await instance.secondConnection();
  t.after(() => {
    second.close();
    return instance.close();
  });
  await seedMeta(second, {
    snapshot: snapshot(3),
    hlc: { wallMs: 900, counter: 4 }
  });

  const outcome = await storage.applySyncResponse(instance.database, {
    expectedUserId: "user-1",
    snapshot: snapshot(4),
    hlc: { wallMs: 800, counter: 2 },
    queueIds: { commands: [], taskOperations: [], durationOperations: [] }
  });

  assert.equal(outcome.applied, true);
  assert.deepEqual(outcome.hlc, { wallMs: 900, counter: 4 });
  assert.deepEqual((await storage.readCanonicalState(instance.database)).hlc, { wallMs: 900, counter: 4 });
});

test("stale clock sample cannot advance HLC through offset-derived candidate", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  const storedClock = {
    offsetMs: 0, uncertaintyMs: 25, sampledAtWallMs: 2_000,
    requestSequence: 2, receivedAtWallMs: 2_050
  };
  const staleClock = {
    offsetMs: 8_000_000, uncertaintyMs: 25, sampledAtWallMs: 1_000,
    requestSequence: 1, receivedAtWallMs: 1_050
  };
  await seedMeta(instance.database, {
    snapshot: snapshot(8),
    hlc: { wallMs: 800, counter: 0 },
    clockOffset: storedClock
  });

  const outcome = await storage.applySyncResponse(instance.database, {
    expectedUserId: "user-1",
    snapshot: snapshot(9),
    hlc: { wallMs: 8_001_000, counter: 0 },
    serverHlc: { wallMs: 900, counter: 1 },
    clockOffset: staleClock,
    queueIds: { commands: [], taskOperations: [], durationOperations: [], autoStartOperations: [] }
  });

  assert.deepEqual(outcome.clockOffset, storedClock);
  assert.deepEqual(outcome.hlc, { wallMs: 900, counter: 1 });
  const persisted = await storage.readCanonicalState(instance.database);
  assert.deepEqual(persisted.clockOffset, storedClock);
  assert.deepEqual(persisted.hlc, { wallMs: 900, counter: 1 });
});

test("cacheable response without clock sample merges only server HLC", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await seedMeta(instance.database, {
    snapshot: snapshot(8),
    hlc: { wallMs: 800, counter: 0 }
  });

  const outcome = await storage.applySyncResponse(instance.database, {
    expectedUserId: "user-1",
    snapshot: snapshot(9),
    hlc: { wallMs: 8_001_000, counter: 0 },
    serverHlc: { wallMs: 900, counter: 1 },
    clockOffset: null,
    queueIds: { commands: [], taskOperations: [], durationOperations: [], autoStartOperations: [] }
  });

  assert.deepEqual(outcome.hlc, { wallMs: 900, counter: 1 });
  assert.deepEqual((await storage.readCanonicalState(instance.database)).hlc, { wallMs: 900, counter: 1 });
});

test("delayed high-revision response cannot cross account ownership", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await seedMeta(instance.database, {
    snapshot: snapshot(8, "user-b"),
    hlc: { wallMs: 800, counter: 0 }
  });
  await seedQueues(instance.database, { commands: [command("user-b-command", 1)] });

  const wrongAccount = snapshot(99, "user-a");
  wrongAccount.serverTime = "not-a-time";
  await assert.rejects(storage.applySyncResponse(instance.database, {
    expectedUserId: "user-a",
    snapshot: wrongAccount,
    hlc: { wallMs: 9_900, counter: 0 },
    queueIds: {
      commands: ["user-b-command"],
      taskOperations: [],
      durationOperations: []
    }
  }), { name: "AccountOwnershipError", message: /Canonical account changed/ });

  const persisted = await storage.readSyncState(instance.database);
  assert.equal(persisted.snapshot.revision, 8);
  assert.equal(persisted.snapshot.user.id, "user-b");
  assert.deepEqual(persisted.hlc, { wallMs: 800, counter: 0 });
  assert.deepEqual(persisted.commands.map((item) => item.id), ["user-b-command"]);
});

test("peer-applied bootstrap response reconciles as stale success", async (t) => {
  const instance = await fixture();
  const second = await instance.secondConnection();
  t.after(() => {
    second.close();
    return instance.close();
  });
  await acquire(instance.database);
  const pending = await capture(instance.database);
  const canonical = { snapshot: snapshot(5), hlc: { wallMs: 500, counter: 0 } };
  assert.equal((await storage.applyResolution(second, pending, canonical)).applied, true);

  const delayed = await storage.applyResolution(instance.database, pending, canonical);
  assert.equal(delayed.staleSuccess, true);
  assert.equal(delayed.snapshot.revision, 5);
  assert.deepEqual(await storage.readBootstrapState(instance.database), { gate: null, resolution: null });
});

test("invalid canonical response preserves captured queues and lease", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await seedQueues(instance.database, { commands: [command("captured", 1)] });
  await acquire(instance.database);
  const pending = await capture(instance.database);
  const invalidResponse = {
    acknowledgements: [{ commandId: "captured", outcome: "applied", reason: "" }],
    taskAcknowledgements: [],
    durationAcknowledgements: [],
    autoStartAcknowledgements: [],
    selectedTaskAcknowledgements: [],
    revision: 4,
    canonicalTimer: null,
    history: [],
    tasks: [],
    durationsMs: { focus: 1_500_000, short_break: 300_000, long_break: 900_000 },
    autoStartBreaks: false,
    selectedTaskId: null,
    serverTime: "2026-07-22T12:30:00Z",
    serverHlcWallMs: 1
  };
  assert.throws(() => sync.validateCanonicalResponse(invalidResponse, pending.payload), /server HLC/);
  assert.deepEqual((await storage.readQueues(instance.database)).commands.map((item) => item.id), ["captured"]);
  assert.ok((await storage.readBootstrapState(instance.database)).resolution);
});

test("malformed normal sync 200 preserves queue and canonical snapshot", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  const sent = command("sent", 1);
  const sentAutoStart = autoStartOperation("sent-auto-start");
  await seedQueues(instance.database, { commands: [sent], autoStartOperations: [sentAutoStart] });
  await seedMeta(instance.database, {
    snapshot: snapshot(3),
    hlc: { wallMs: 300, counter: 0 }
  });
  const malformed = {
    acknowledgements: [{ commandId: "sent", outcome: "applied", reason: "" }],
    taskAcknowledgements: [],
    durationAcknowledgements: [],
    autoStartAcknowledgements: [{ operationId: "sent-auto-start", outcome: "applied", reason: "" }],
    selectedTaskAcknowledgements: [],
    revision: 4,
    canonicalTimer: null,
    history: [],
    tasks: [],
    durationsMs: { focus: 1_500_000, short_break: 300_000, long_break: 900_000 },
    autoStartBreaks: false,
    selectedTaskId: null,
    serverTime: "2026-07-22 12:30:00Z",
    serverHlcWallMs: 400,
    serverHlcCounter: 0
  };
  assert.throws(() => sync.validateCanonicalResponse(malformed, {
    commands: [sent],
    taskOperations: [],
    durationOperations: [],
    autoStartOperations: [sentAutoStart],
    selectedTaskOperations: []
  }), /serverTime/);
  assert.equal((await storage.readCanonicalState(instance.database)).snapshot.revision, 3);
  assert.deepEqual((await storage.readQueues(instance.database)).commands.map((item) => item.id), ["sent"]);
  assert.deepEqual((await storage.readQueues(instance.database)).autoStartOperations.map((item) => item.id), ["sent-auto-start"]);
});
