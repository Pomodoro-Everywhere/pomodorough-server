"use strict";

const { accountUser, ownerId } = require("./test/incarnation-fixture.js");

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  storage: productionStorage, stores, nowMs, loadCore, snapshot, seedMeta, dump, deferred, fixture, switchOwner, assertQuarantined
} = require("./test/account-ownership-fixture.js");
const storage = { ...productionStorage, ...require("./test/core-planner-storage-fixture.js") };

test("P1.20 runtime uses the bundled authoritative WASM", async (context) => {
  const { core, hash } = await loadCore();
  assert.equal(typeof core.projectSynchronizedState, "function");
  context.diagnostic(`WASM SHA256 ${hash}`);
});

test("P1.20 explicit task issuer cannot be replaced by the currently captured account", async (context) => {
  const { stale, core } = await fixture(context);
  const before = await dump(stale.use.database());
  const task = core.taskIdentity({ title: "Foreign issuer confidential task" });
  assert.equal(await stale.use.issueTaskOperation("upsert", task, ownerId("account-B")), false);
  assert.deepEqual(await dump(stale.use.database()), before);
});

test("P1.20 stale A confidential task cannot enter B after peer bootstrap and reopen", async (context) => {
  const { stale, peer, core, open } = await fixture(context);
  const privateTask = core.taskIdentity({ title: "Account A confidential project" });
  await switchOwner(peer);
  assert.equal(stale.use.controlsBlocked(), false);
  const before = await dump(peer.use.database());
  assert.equal(await stale.use.issueTaskOperation("upsert", privateTask), false);
  assert.deepEqual(await dump(peer.use.database()), before);
  assertQuarantined(stale);
  stale.use.database().close();
  const reopened = await open("account-B");
  await reopened.use.reloadPersistedState();
  assert.deepEqual(reopened.use.currentSyncBatch().taskOperations, []);
  assert.equal(await reopened.use.addTask("Account B permitted project"), true);
  assert.equal(reopened.use.currentSyncBatch().taskOperations[0].title, "Account B permitted project");
});

const mutations = [
  ["task create", (current, task) => current.use.issueTaskOperation("upsert", task)],
  ["task delete", (current, task) => current.use.deleteTask(task)],
  ["auto start setting", (current) => current.use.issueAutoStartOperation(false)],
  ["selected task setting", (current, task) => current.use.issueSelectedTaskOperation(task.id)],
  ["duration setting", (current) => current.use.issueDurationOperation("short_break", 600_000)],
  ["timer start", (current) => current.use.issueCommand("start", { phase: "focus" })],
  ["timer pause", (current) => current.use.issueCommand("pause"), "running"],
  ["timer resume", (current) => current.use.issueCommand("resume"), "paused"],
  ["timer clear", (current) => current.use.issueCommand("clear"), "completed"],
  ["manual completion", (current) => current.use.finishTimer(false), "running"],
  ["automatic completion", (current) => current.use.finishTimer(true), "running"],
  ["cancel and clear", (current) => current.use.cancelAndClearTimer(), "running"]
];

for (const [name, mutate, timerStatus] of mutations) {
  test(`P1.20 ${name} fences stale owner and permits current owner`, async (context) => {
    const { stale, peer, core } = await fixture(context, timerStatus);
    const task = core.taskIdentity({ title: "Private task" });
    await stale.use.persistTaskOperation("upsert", task);
    await switchOwner(peer, "account-B", timerStatus);
    await peer.use.issueTaskOperation("upsert", task);
    if (name === "automatic completion") {
      stale.use.trustedNow = peer.use.trustedNow = () => nowMs + 1_500_000;
    }
    const before = await dump(peer.use.database());
    assert.equal(await mutate(stale, task), false);
    assert.deepEqual(await dump(peer.use.database()), before, "every store including HLC, UUID and sequence is unchanged");
    assertQuarantined(stale);
    assert.equal(await mutate(peer, task), true, JSON.stringify(peer.calls));
    assert.notDeepEqual(await dump(peer.use.database()), before);
  });
}

test("P1.20 settings persistence rejects stale owner without overwriting peer preferences", async (context) => {
  const { stale, peer } = await fixture(context);
  await switchOwner(peer);
  stale.state.selectedPhase = "long_break";
  const before = await dump(peer.use.database());
  await assert.rejects(stale.use.persistSettings(), { name: "AccountOwnershipError" });
  assert.deepEqual(await dump(peer.use.database()), before);
  assertQuarantined(stale);
  peer.state.selectedPhase = "short_break";
  await peer.use.persistSettings();
  const after = await dump(peer.use.database());
  assert.equal(after.meta.find((record) => record.key === "settings").value.selectedPhase, "short_break");
});

function retainedOwnerOperation(core, storeName) {
  const common = { id: "retained-B-operation", deviceId: "shared-device", occurredAt: new Date(nowMs).toISOString(),
    hlcWallMs: nowMs, hlcCounter: 0 };
  const task = core.taskIdentity({ title: "Retained B work" });
  const fields = {
    pending: { deviceSequence: 8, timerId: "retained-B-timer", type: "start", phase: "focus",
      plannedDurationMs: 1500000, observedElapsedMs: 0 },
    pendingTasks: { taskId: task.id, type: "upsert", title: task.title },
    pendingDurations: { phase: "focus", durationMs: 1800000 },
    pendingAutoStarts: { enabled: false },
    pendingSelectedTasks: { taskId: null }
  };
  return { ...common, ...fields[storeName] };
}

for (const storeName of stores.slice(1)) {
  for (const operation of ["delete", "clear"]) {
    test(`P1.20 destructive ${storeName}.${operation} checks owner before callback`, async (context) => {
      const { stale, peer, core } = await fixture(context);
      await switchOwner(peer);
      const database = stale.use.database();
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(retainedOwnerOperation(core, storeName));
      await storage.transactionDone(transaction);
      const before = await dump(database);
      let called = false;
      const remove = (mutation) => {
        called = true;
        mutation.objectStore(storeName)[operation]("retained-B-operation");
      };
      await assert.rejects(storage.guardedMutation(database, [storeName], remove, {
        expectedUserId: ownerId("account-A")
      }), { name: "AccountOwnershipError" });
      assert.equal(called, false);
      assert.deepEqual(await dump(database), before);
      await storage.guardedMutation(peer.use.database(), [storeName], remove, { expectedUserId: ownerId("account-B") });
      assert.equal(called, true);
      assert.deepEqual((await dump(database))[storeName], []);
    });
  }
}

test("P1.20 duration supersession cannot delete B queue while inserting stale A settings", async (context) => {
  const { stale, peer } = await fixture(context);
  await switchOwner(peer);
  const sameTab = peer.state.tabId;
  peer.state.tabId = stale.state.tabId;
  assert.equal(await peer.use.issueDurationOperation("short_break", 420_000), true);
  peer.state.tabId = sameTab;
  const before = await dump(peer.use.database());
  await assert.rejects(stale.use.persistDurationOperation("short_break", 600_000), { name: "AccountOwnershipError" });
  assert.deepEqual(await dump(peer.use.database()), before);
  assertQuarantined(stale);
});

test("P1.20 stale cleanup cannot clear B; authorized cleanup is atomic without deleteDatabase", async (context) => {
  const { stale, peer, indexedDB, open } = await fixture(context);
  await switchOwner(peer);
  await peer.use.addTask("Keep B queue");
  const before = await dump(peer.use.database());
  await assert.rejects(stale.use.clearLocalData(undefined, stale.use.captureDatabaseContext()), { name: "AccountOwnershipError" });
  assert.deepEqual(await dump(peer.use.database()), before);
  assertQuarantined(stale);
  indexedDB.deleteDatabase = () => { throw new Error("Nontransactional deletion forbidden"); };
  await peer.use.clearLocalData(undefined, peer.use.captureDatabaseContext());
  assert.equal(peer.use.database(), null);
  const reopened = await open(null);
  assert.ok(Object.values(await dump(reopened.use.database())).every((records) => records.length === 0));
});

for (const method of ["renewTimerOwnership", "releaseTimerOwnership"]) {
  test(`P1.20 ${method} rejects stale account even with matching device and tab`, async (context) => {
    const { stale, peer } = await fixture(context, "running");
    await switchOwner(peer, "account-B", "running");
    await seedMeta(peer.use.database(), { timerOwner: {
      timerId: "shared-timer", deviceId: "shared-device", tabId: "same-tab", leaseExpiresAtMs: nowMs + 10_000
    } });
    const input = {
      expectedUserId: ownerId("account-A"), timerId: "shared-timer", deviceId: "shared-device",
      tabId: "same-tab", nowMs, leaseMs: 60_000
    };
    const before = await dump(peer.use.database());
    await assert.rejects(storage[method](stale.use.database(), input), { name: "AccountOwnershipError" });
    assert.deepEqual(await dump(peer.use.database()), before);
    await storage[method](peer.use.database(), { ...input, expectedUserId: ownerId("account-B") });
    assert.notDeepEqual(await dump(peer.use.database()), before);
  });
}

test("P1.20 lease heartbeat quarantines stale tab instead of silently retrying", async (context) => {
  const { stale, peer } = await fixture(context, "running");
  await switchOwner(peer, "account-B", "running");
  const before = await dump(peer.use.database());
  await stale.use.heartbeatTimerOwnership();
  await dump(stale.use.database());
  assertQuarantined(stale);
  assert.deepEqual(await dump(peer.use.database()), before);
});

test("P1.20 null identity only mutates unowned storage; offline cached identity remains valid", async (context) => {
  const { stale, peer, open } = await fixture(context);
  stale.state.authenticated = false;
  stale.state.offlineOwnerMode = true;
  stale.state.user = null;
  stale.external.host.navigator.onLine = false;
  await stale.use.persistAutoStartOperation(false);
  const unowned = await open(null);
  const before = await dump(stale.use.database());
  await assert.rejects(unowned.use.persistAutoStartOperation(false), { name: "AccountOwnershipError" });
  assert.deepEqual(await dump(stale.use.database()), before);
  await switchOwner(peer);
  await assert.rejects(stale.use.persistTaskOperation("delete", { id: "private-id" }), { name: "AccountOwnershipError" });
  assertQuarantined(stale);
  await peer.use.clearLocalData(undefined, peer.use.captureDatabaseContext());
  const fresh = await open(null);
  await fresh.use.persistAutoStartOperation(true);
  assert.equal((await storage.readQueues(fresh.use.database())).autoStartOperations.length, 1);
});

test("P1.20 absent or malformed expected owner fails closed on owned database without projection", async (context) => {
  const { stale } = await fixture(context);
  const database = stale.use.database();
  const before = await dump(database);
  for (const expectedUserId of [undefined, null, "", 123, {}, "account-B"]) {
    let dispatched = false;
    await assert.rejects(storage.planWorkspaceMutation(database, {
      expectedUserId, deviceId: stale.state.deviceId, nowMs, localNowMs: nowMs,
      intent: { kind: "upsertTask", title: "must-not-allocate" }, preference: true,
      sharedCore: { call() { dispatched = true; throw new Error("Stale planner executed"); } }
    }), { name: "AccountOwnershipError" });
    assert.equal(dispatched, false);
    assert.deepEqual(await dump(database), before);
  }
});

test("P1.20 transaction queued behind peer switch checks persisted owner, not preflight owner", async (context) => {
  const { stale, peer } = await fixture(context);
  const switching = seedMeta(peer.use.database(), { snapshot: snapshot("account-B") });
  const input = {
    expectedUserId: ownerId("account-A"), deviceId: stale.state.deviceId, nowMs, localNowMs: nowMs,
    intent: { kind: "upsertTask", title: "Stale private task" }, preference: true
  };
  const writing = storage.planWorkspaceMutation(stale.use.database(), input);
  input.expectedUserId = ownerId("account-B");
  const rejected = assert.rejects(writing, { name: "AccountOwnershipError" });
  await switching;
  const before = await dump(peer.use.database());
  await rejected;
  assert.deepEqual(await dump(peer.use.database()), before);
});

test("P1.20 late task identity callback cannot rebind confidential title to newly validated B", async (context) => {
  const { stale, peer, core } = await fixture(context);
  const identity = deferred();
  stale.use.sharedTaskIdentity = () => identity.promise;
  const adding = stale.use.addTask("A late confidential project");
  await switchOwner(peer);
  stale.state.user = accountUser("account-B");
  await stale.use.reloadPersistedState();
  const before = await dump(peer.use.database());
  identity.resolve(core.taskIdentity({ title: "A late confidential project" }));
  assert.equal(await adding, false);
  assert.deepEqual(await dump(peer.use.database()), before);
  assertQuarantined(stale);
});

for (const method of ["issueAutoStartOperation", "issueSelectedTaskOperation", "persistSettings"]) {
  test(`P1.20 ${method} retains issuing owner across action-lock wait`, async (context) => {
    const { stale, peer, core } = await fixture(context);
    stale.state.actionLocked = true;
    const argument = method === "issueSelectedTaskOperation" ? core.taskIdentity({ title: "Private" }).id : false;
    const writing = stale.use[method](argument);
    const outcome = writing.then((value) => value, (error) => error.name);
    await switchOwner(peer);
    stale.state.user = accountUser("account-B");
    await stale.use.reloadPersistedState();
    stale.state.actionLocked = false;
    const before = await dump(peer.use.database());
    stale.callbacks[0].callback();
    assert.equal(await outcome, method === "persistSettings" ? "AccountOwnershipError" : false);
    assert.deepEqual(await dump(peer.use.database()), before);
    assertQuarantined(stale);
  });
}

test("P1.20 delayed committed result cannot enter B in-memory sync batch", async (context) => {
  const { stale, peer, core } = await fixture(context);
  const committed = deferred();
  const release = deferred();
  stale.external.syncStorage = { ...storage, planWorkspaceMutation: async (...args) => {
    const operation = await storage.planWorkspaceMutation(...args);
    committed.resolve();
    await release.promise;
    return operation;
  } };
  const storageModule = require("./app-storage.js");
  const connection = stale.use.database();
  Object.assign(stale.use, storageModule.create({ state: stale.state, external: stale.external, use: stale.use }));
  stale.use.setDatabaseForTest(connection);
  const issuing = stale.use.issueTaskOperation("upsert", core.taskIdentity({ title: "Delayed A result" }));
  await committed.promise;
  await switchOwner(peer);
  stale.state.user = accountUser("account-B");
  await stale.use.reloadPersistedState();
  release.resolve();
  assert.equal(await issuing, false);
  assert.deepEqual(stale.use.currentSyncBatch().taskOperations, []);
  assert.deepEqual((await storage.readQueues(peer.use.database())).taskOperations, []);
  assertQuarantined(stale);
});

test("P1.20 stale reopened read quarantines rather than adopting peer account", async (context) => {
  const { peer, open } = await fixture(context);
  await switchOwner(peer);
  const reopened = await open("account-A");
  const before = await dump(peer.use.database());
  await assert.rejects(reopened.use.reloadPersistedState(), { name: "AccountOwnershipError" });
  assert.equal(reopened.state.user.id, "account-A");
  assert.equal(reopened.state.localOwnerId, ownerId("account-A"));
  assertQuarantined(reopened);
  assert.deepEqual(await dump(peer.use.database()), before);
});

test("P1.20 bootstrap gates still block ordinary owner mutations", async (context) => {
  const { stale } = await fixture(context);
  await storage.acquireBootstrapGate(stale.use.database(), { token: "bootstrap", nowMs, leaseMs: 300_000 });
  const before = await dump(stale.use.database());
  await assert.rejects(stale.use.persistAutoStartOperation(false), { name: "BootstrapGateError" });
  await assert.rejects(stale.use.persistSettings(), { name: "BootstrapGateError" });
  assert.deepEqual(await dump(stale.use.database()), before);
  assert.equal(stale.calls.includes("revalidate"), false);
});

test("P1.20 same-account peer and reopened tab keep authorized offline queues", async (context) => {
  const { stale, open } = await fixture(context);
  const sameOwner = await open("account-A");
  await sameOwner.use.reloadPersistedState();
  assert.equal(await stale.use.addTask("First A task"), true);
  assert.equal(await sameOwner.use.addTask("Second A task"), true);
  const reopened = await open("account-A");
  await reopened.use.reloadPersistedState();
  assert.deepEqual(reopened.use.currentSyncBatch().taskOperations.map((operation) => operation.title), [
    "First A task", "Second A task"
  ]);
  assert.equal(reopened.use.controlsBlocked(), false);
});

test("P1.20 unknown-owner cleanup cannot infer permission; known owner can clear gated storage", async (context) => {
  const { stale, open } = await fixture(context);
  const unknown = await open(null);
  await storage.acquireBootstrapGate(stale.use.database(), { token: "cleanup", nowMs, leaseMs: 300_000 });
  const before = await dump(stale.use.database());
  await assert.rejects(unknown.use.clearLocalData(undefined, unknown.use.captureDatabaseContext()), { name: "AccountOwnershipError" });
  assert.deepEqual(await dump(stale.use.database()), before);
  assertQuarantined(unknown);
  stale.state.user = null;
  await stale.use.clearLocalData(undefined, stale.use.captureDatabaseContext());
  assert.ok(Object.values(await dump(unknown.use.database())).every((records) => records.length === 0));
});

test("P1.20 null-owned snapshot permits local work but cleared owner rejects stale account", async (context) => {
  const { stale, peer } = await fixture(context, null, null);
  await stale.use.persistAutoStartOperation(false);
  await stale.use.persistCommand("start");
  assert.equal((await storage.readQueues(stale.use.database())).commands.length, 1);
  await switchOwner(peer);
  await peer.use.clearLocalData(undefined, peer.use.captureDatabaseContext());
  stale.state.user = accountUser("account-A");
  stale.state.localOwnerId = ownerId("account-A");
  const before = await dump(stale.use.database());
  await assert.rejects(stale.use.persistAutoStartOperation(true), { name: "AccountOwnershipError" });
  assert.deepEqual(await dump(stale.use.database()), before);
  assertQuarantined(stale);
});

for (const method of ["finishTimer", "cancelAndClearTimer"]) {
  test(`P1.20 ${method} captures owner before queued transaction runs`, async (context) => {
    const { stale, peer } = await fixture(context, "running");
    const switching = seedMeta(peer.use.database(), { snapshot: snapshot("account-B", "running") });
    const input = {
      expectedUserId: ownerId("account-A"), timerId: "shared-timer", phase: "focus", deviceId: "shared-device",
      nowMs, localNowMs: nowMs, withUuidV7: true, requestedTimer: stale.state.timer,
      manual: true, tabId: "same-tab", leaseMs: 60_000, observedElapsedMs: 0
    };
    const writing = storage[method](stale.use.database(), input);
    input.expectedUserId = ownerId("account-B");
    const rejected = assert.rejects(writing, { name: "AccountOwnershipError" });
    await switching;
    const before = await dump(peer.use.database());
    await rejected;
    assert.deepEqual(await dump(peer.use.database()), before);
  });

  test(`P1.20 delayed ${method} result cannot become B commands or alerts`, async (context) => {
    const { stale, peer } = await fixture(context, "running");
    const committed = deferred();
    const release = deferred();
    const external = { ...stale.external, syncStorage: { ...storage, planWorkspaceMutation: async (...args) => {
      const result = await storage.planWorkspaceMutation(...args);
      committed.resolve();
      await release.promise;
      return result;
    } } };
    const connection = stale.use.database();
    Object.assign(stale.use, require("./app-storage.js").create({ state: stale.state, external, use: stale.use }));
    stale.use.setDatabaseForTest(connection);
    Object.assign(stale.use, require("./app-actions.js").create({ state: stale.state, external, use: stale.use }));
    const issuing = stale.use[method]();
    await committed.promise;
    await switchOwner(peer, "account-B", "running");
    stale.state.user = accountUser("account-B");
    await stale.use.reloadPersistedState();
    const before = await dump(peer.use.database());
    release.resolve();
    assert.equal(await issuing, false);
    assert.deepEqual(stale.use.currentSyncBatch().commands, []);
    assert.equal(stale.use.activeCompletionAlertTimerId(), null);
    assert.deepEqual(await dump(peer.use.database()), before);
    assertQuarantined(stale);
  });
}

test("P1.20 destructive callback retains owner while waiting for peer transaction", async (context) => {
  const { stale, peer } = await fixture(context);
  const switching = seedMeta(peer.use.database(), { snapshot: snapshot("account-B") });
  const input = { expectedUserId: ownerId("account-A"), allowBootstrap: true };
  let called = false;
  const writing = storage.guardedMutation(stale.use.database(), stores, () => { called = true; }, input);
  input.expectedUserId = ownerId("account-B");
  const rejected = assert.rejects(writing, { name: "AccountOwnershipError" });
  await switching;
  const before = await dump(peer.use.database());
  await rejected;
  assert.equal(called, false);
  assert.deepEqual(await dump(peer.use.database()), before);
});

test("P1.20 pagehide lease release uses issuing owner and quarantines mismatch", async (context) => {
  const { stale, peer } = await fixture(context, "running");
  await switchOwner(peer, "account-B", "running");
  const listeners = {};
  const external = { ...stale.external, host: {
    ...stale.external.host, addEventListener: (name, callback) => { listeners[name] = callback; },
    document: { addEventListener: () => {} }
  } };
  const view = require("./app-view.js").create({ state: stale.state, external, use: stale.use });
  view.setupConnectivityEvents();
  const before = await dump(peer.use.database());
  listeners.pagehide();
  await dump(stale.use.database());
  assert.deepEqual(await dump(peer.use.database()), before);
  assertQuarantined(stale);
});

test("P1.20 old completion retry cannot trigger newly validated B timer with same id", async (context) => {
  const { stale, peer } = await fixture(context, "running");
  stale.use.scheduleCompletionRetry("shared-timer", { reason: "not_owner", retryAtMs: nowMs + 1_000 });
  const callback = stale.callbacks.at(-1).callback;
  await switchOwner(peer, "account-B", "running");
  stale.state.user = accountUser("account-B");
  await stale.use.reloadPersistedState();
  stale.use.setCompletionQueuedForTest("shared-timer");
  const before = await dump(peer.use.database());
  callback();
  assert.equal(stale.use.completionQueuedForTest(), "shared-timer");
  assert.equal(stale.calls.includes("render-timer"), false);
  assert.deepEqual(await dump(peer.use.database()), before);
  assert.equal(stale.use.releaseCompletionRetry("shared-timer"), true);
  assert.equal(stale.use.completionQueuedForTest(), null);
});

test("P1.20 duration post-commit read cannot adopt peer B queues", async (context) => {
  const { stale, peer } = await fixture(context);
  const reading = deferred();
  const release = deferred();
  const external = { ...stale.external, syncStorage: { ...storage, readSyncState: async (...args) => {
    reading.resolve();
    await release.promise;
    return storage.readSyncState(...args);
  } } };
  const database = stale.use.database();
  Object.assign(stale.use, require("./app-storage.js").create({ state: stale.state, external, use: stale.use }));
  stale.use.setDatabaseForTest(database);
  const writing = stale.use.persistDurationOperation("short_break", 600_000);
  const rejected = assert.rejects(writing, { name: "AccountOwnershipError" });
  await reading.promise;
  await switchOwner(peer);
  await peer.use.issueDurationOperation("short_break", 420_000);
  const before = await dump(peer.use.database());
  release.resolve();
  await rejected;
  assert.deepEqual(await dump(peer.use.database()), before);
  assertQuarantined(stale);
});
