"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { indexedDB } = require("fake-indexeddb");
const sync = require("./sync-core.js");
const storage = require("./sync-storage.js");

let databaseSequence = 0;

function command(id, sequence, wall = sequence, counter = 0) {
  return {
    id,
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

function snapshot(revision, userId = "user-1", serverTime = "2026-07-22T12:30:00Z") {
  return {
    revision,
    serverTime,
    canonicalTimer: null,
    history: [],
    tasks: [],
    durationsMs: { focus: 1_500_000, short_break: 300_000, long_break: 900_000 },
    autoStartBreaks: false,
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
    ["pending", "pendingTasks", "pendingDurations", "pendingAutoStarts"],
    "readwrite"
  );
  for (const item of values.commands || []) transaction.objectStore("pending").put(item);
  for (const item of values.taskOperations || []) transaction.objectStore("pendingTasks").put(item);
  for (const item of values.durationOperations || []) transaction.objectStore("pendingDurations").put(item);
  for (const item of values.autoStartOperations || []) transaction.objectStore("pendingAutoStarts").put(item);
  await storage.transactionDone(transaction);
}

async function seedMeta(database, values) {
  const transaction = database.transaction("meta", "readwrite");
  const store = transaction.objectStore("meta");
  for (const [key, value] of Object.entries(values)) store.put({ key, value });
  await storage.transactionDone(transaction);
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

test("capture atomically snapshots stores and survives database reload", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await seedQueues(instance.database, {
    commands: [command("command-2", 2), command("command-1", 1)],
    taskOperations: [taskOperation("task-op-1")],
    durationOperations: [durationOperation("duration-op-1")],
    autoStartOperations: [autoStartOperation("auto-start-op-1")]
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
    autoStartOperations: ["auto-start-op-1"]
  });
  assert.equal(pending.gateToken, "tab-1");
  assert.equal(Object.hasOwn(pending.payload.durationOperations[0], "ownerId"), false);
  assert.deepEqual(pending.payload.autoStartOperations, [autoStartOperation("auto-start-op-1")]);

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
    autoStartOperations: [autoStartOperation("captured-auto-start")]
  });
  await acquire(instance.database);
  const pending = await capture(instance.database, resolutionInput("replace_remote"));
  await seedQueues(instance.database, {
    commands: [command("newer", 2)],
    taskOperations: [taskOperation("newer-task")],
    durationOperations: [durationOperation("newer-duration")],
    autoStartOperations: [autoStartOperation("newer-auto-start", false, 2)]
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
    storeNames: ["meta", "pending", "pendingTasks", "pendingDurations", "pendingAutoStarts"],
    mode: "readwrite"
  }]);
  assert.deepEqual((await storage.readCanonicalState(instance.database)).snapshot, canonicalSnapshot);
  const queues = await storage.readQueues(instance.database);
  assert.deepEqual(queues.commands.map((item) => item.id), ["newer"]);
  assert.deepEqual(queues.taskOperations.map((item) => item.id), ["newer-task"]);
  assert.deepEqual(queues.durationOperations.map((item) => item.id), ["newer-duration"]);
  assert.deepEqual(queues.autoStartOperations.map((item) => item.id), ["newer-auto-start"]);
  assert.deepEqual(await storage.readBootstrapState(instance.database), { gate: null, resolution: null });
});

test("merge resolution atomically commits combined canonical history and tasks", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await seedQueues(instance.database, {
    commands: [command("local-command", 1)],
    taskOperations: [taskOperation("local-task")],
    durationOperations: [durationOperation("local-duration")],
    autoStartOperations: [autoStartOperation("local-auto-start")]
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
    autoStartOperations: []
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
    autoStartOperations: [autoStartOperation("sent-auto-start"), autoStartOperation("later-auto-start", false, 2)]
  });
  const incoming = snapshot(4);
  incoming.tasks = [{ id: "remote-task", title: "Remote task" }];

  const outcome = await storage.applySyncResponse(instance.database, {
    expectedUserId: "user-1",
    snapshot: incoming,
    hlc: { wallMs: 400, counter: 0 },
    queueIds: {
      commands: ["sent"],
      taskOperations: ["sent-task"],
      durationOperations: ["sent-duration"],
      autoStartOperations: ["sent-auto-start"]
    }
  });

  assert.equal(outcome.applied, true);
  const persisted = await storage.readSyncState(instance.database);
  assert.deepEqual(persisted.snapshot, incoming);
  assert.deepEqual(persisted.commands.map((item) => item.id), ["later"]);
  assert.deepEqual(persisted.taskOperations.map((item) => item.id), ["later-task"]);
  assert.deepEqual(persisted.durationOperations.map((item) => item.id), ["later-duration"]);
  assert.deepEqual(persisted.autoStartOperations.map((item) => item.id), ["later-auto-start"]);
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
    autoStartOperations: [autoStartOperation("auto-start-1")]
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
    storeNames: ["meta", "pending", "pendingTasks", "pendingDurations", "pendingAutoStarts"],
    mode: "readonly"
  }]);
  assert.equal(persisted.snapshot.revision, 6);
  assert.deepEqual(persisted.hlc, { wallMs: 600, counter: 2 });
  assert.deepEqual(persisted.commands.map((item) => item.id), ["command-1"]);
  assert.deepEqual(persisted.taskOperations.map((item) => item.id), ["task-1"]);
  assert.deepEqual(persisted.durationOperations.map((item) => item.id), ["duration-1"]);
  assert.deepEqual(persisted.autoStartOperations.map((item) => item.id), ["auto-start-1"]);
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

test("older equal-revision response preserves canonical state and queues", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await seedMeta(instance.database, {
    snapshot: snapshot(8, "user-1", "2026-07-22T12:30:00Z"),
    hlc: { wallMs: 800, counter: 0 }
  });
  await seedQueues(instance.database, { commands: [command("sent", 1)] });
  const incoming = snapshot(8, "user-1", "2026-07-22T12:29:59.999999999Z");
  incoming.tasks = [{ id: "older", title: "Older" }];

  const outcome = await storage.applySyncResponse(instance.database, {
    expectedUserId: "user-1",
    snapshot: incoming,
    hlc: { wallMs: 900, counter: 0 },
    queueIds: { commands: ["sent"], taskOperations: [], durationOperations: [] }
  });

  assert.equal(outcome.stale, true);
  assert.equal(outcome.idempotent, false);
  const persisted = await storage.readSyncState(instance.database);
  assert.equal(persisted.snapshot.serverTime, "2026-07-22T12:30:00Z");
  assert.deepEqual(persisted.snapshot.tasks, []);
  assert.deepEqual(persisted.commands.map((item) => item.id), ["sent"]);
  assert.deepEqual(persisted.hlc, { wallMs: 800, counter: 0 });
});

test("newer equal-revision response advances canonical state and acknowledgements", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await seedMeta(instance.database, {
    snapshot: snapshot(8, "user-1", "2026-07-22T12:30:00Z"),
    hlc: { wallMs: 800, counter: 0 }
  });
  await seedQueues(instance.database, { commands: [command("sent", 1)] });
  const incoming = snapshot(8, "user-1", "2026-07-22T12:30:00.000000001Z");
  incoming.tasks = [{ id: "newer", title: "Newer" }];

  const outcome = await storage.applySyncResponse(instance.database, {
    expectedUserId: "user-1",
    snapshot: incoming,
    hlc: { wallMs: 900, counter: 0 },
    queueIds: { commands: ["sent"], taskOperations: [], durationOperations: [] }
  });

  assert.equal(outcome.applied, true);
  const persisted = await storage.readSyncState(instance.database);
  assert.equal(persisted.snapshot.serverTime, "2026-07-22T12:30:00.000000001Z");
  assert.deepEqual(persisted.snapshot.tasks, [{ id: "newer", title: "Newer" }]);
  assert.deepEqual(persisted.commands, []);
  assert.deepEqual(persisted.hlc, { wallMs: 900, counter: 0 });
});

test("exact equal-revision server time is an idempotent no-op", async (t) => {
  const instance = await fixture();
  t.after(() => instance.close());
  await seedMeta(instance.database, {
    snapshot: snapshot(8, "user-1", "2026-07-22T12:30:00.123456789Z"),
    hlc: { wallMs: 800, counter: 0 }
  });
  await seedQueues(instance.database, { commands: [command("sent", 1)] });
  const incoming = snapshot(8, "user-1", "2026-07-22T12:30:00.123456789Z");
  incoming.tasks = [{ id: "different", title: "Different" }];

  const outcome = await storage.applySyncResponse(instance.database, {
    expectedUserId: "user-1",
    snapshot: incoming,
    hlc: { wallMs: 900, counter: 0 },
    queueIds: { commands: ["sent"], taskOperations: [], durationOperations: [] }
  });

  assert.equal(outcome.applied, false);
  assert.equal(outcome.stale, false);
  assert.equal(outcome.idempotent, true);
  const persisted = await storage.readSyncState(instance.database);
  assert.deepEqual(persisted.snapshot.tasks, []);
  assert.deepEqual(persisted.commands.map((item) => item.id), ["sent"]);
  assert.deepEqual(persisted.hlc, { wallMs: 800, counter: 0 });
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
    revision: 4,
    canonicalTimer: null,
    history: [],
    tasks: [],
    durationsMs: { focus: 1_500_000, short_break: 300_000, long_break: 900_000 },
    autoStartBreaks: false,
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
    revision: 4,
    canonicalTimer: null,
    history: [],
    tasks: [],
    durationsMs: { focus: 1_500_000, short_break: 300_000, long_break: 900_000 },
    autoStartBreaks: false,
    serverTime: "2026-07-22 12:30:00Z",
    serverHlcWallMs: 400,
    serverHlcCounter: 0
  };
  assert.throws(() => sync.validateCanonicalResponse(malformed, {
    commands: [sent],
    taskOperations: [],
    durationOperations: [],
    autoStartOperations: [sentAutoStart]
  }), /serverTime/);
  assert.equal((await storage.readCanonicalState(instance.database)).snapshot.revision, 3);
  assert.deepEqual((await storage.readQueues(instance.database)).commands.map((item) => item.id), ["sent"]);
  assert.deepEqual((await storage.readQueues(instance.database)).autoStartOperations.map((item) => item.id), ["sent-auto-start"]);
});
