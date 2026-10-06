"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { fixture, storage, seedMeta, dump, nowMs } = require("./test/account-ownership-fixture.js");
const workspace = require("./workspace-core.js");
const receipts = [];
const meta = (records, key) => records.meta.find((row) => row.key === key)?.value;

test("Core 0.45 production ownership dispatch and policy retirement remain explicit", () => {
  const source = fs.readFileSync(require.resolve("./sync-storage.js"), "utf8");
  for (const name of ["allocateMutation", "finishTimer", "cancelAndClearTimer", "canClaimMissingTimerOwner",
    "plannedMissingTimerOwner", "finishTimerOwnership", "finishTimerCommand", "generatedBreakCommand"]) {
    assert.equal(Object.hasOwn(storage, name), false);
    assert.doesNotMatch(source, new RegExp(`function ${name}\\(`));
  }
  for (const name of ["completedHistoryCount", "hasLocalState", "hasRemoteState", "serverClockOffset", "trustedNow"]) {
    assert.equal(Object.hasOwn(require("./sync-core.js"), name), false);
  }
  assert.match(source, /callWorkspaceCore\("workspace\.ownershipPlan\.v1"/);
  assert.match(source, /writeOwnership\(transaction\.objectStore\(META_STORE\), plan\.ownershipWrites\)/);
});

test.after(() => {
  if (process.env.CORE_PWA045_EVIDENCE) fs.writeFileSync(process.env.CORE_PWA045_EVIDENCE,
    JSON.stringify({ provenance: require("./shared-core-metadata.js"), receipts }, null, 2));
});

async function observed(t, current, operation) {
  const database = current.stale.use.database();
  const before = await dump(database);
  const calls = [];
  const writes = [];
  const wrappedStores = new WeakSet();
  const call = current.core.call.bind(current.core);
  const transaction = database.transaction.bind(database);
  current.core.call = (name, input) => {
    const raw = JSON.stringify(input);
    const value = call(name, input);
    if (["workspace.ownershipPlan.v1", "workspace.intent.v1", "workspace.legacyPreferences.v1"].includes(name)) calls.push({ operation: name, raw, input: JSON.parse(raw), value });
    return value;
  };
  t.mock.method(database, "transaction", (...argumentsList) => {
    const currentTransaction = transaction(...argumentsList);
    const objectStore = currentTransaction.objectStore.bind(currentTransaction);
    currentTransaction.objectStore = (name) => {
      const store = objectStore(name);
      if (name !== "meta" || currentTransaction.mode !== "readwrite" || wrappedStores.has(store)) return store;
      wrappedStores.add(store);
      const put = store.put.bind(store), remove = store.delete.bind(store);
      store.put = (row) => { if (row.key === "timerOwner") writes.push({ kind: "recordTimerOwner", ...row.value }); return put(row); };
      store.delete = (key) => { if (key === "timerOwner") writes.push({ kind: "removeTimerOwner" }); return remove(key); };
      return store;
    };
    return currentTransaction;
  });
  let returned, error;
  try { returned = await operation(); }
  catch (failure) { error = { name: failure.name, message: failure.message }; }
  finally { current.core.call = call; }
  const after = await dump(database);
  receipts.push({ case: t.name, before, after, calls, writes, returned, error });
  return { before, after, calls, writes, returned, error };
}

const scenarios = [
  { name: "missing owner installs and renews in order", owner: null, renewed: true },
  { name: "current tab renews live lease", tabId: "current", expires: nowMs + 1, renewed: true },
  { name: "peer before expiry is denied", tabId: "peer", expires: nowMs + 1, renewed: false },
  { name: "peer at expiry renews", tabId: "peer", expires: nowMs, renewed: true },
  { name: "peer after expiry renews", tabId: "peer", expires: nowMs - 1, renewed: true },
  { name: "foreign device remains denied after expiry", deviceId: "foreign-device", expires: nowMs - 1, renewed: false },
  { name: "missing legacy tab and expiry remain accepted", absent: true, renewed: true },
  { name: "null legacy tab and expiry remain accepted", tabId: null, expires: null, renewed: true },
  { name: "stale presented ID still installs actual owner", owner: null, timerId: "stale-presented", renewed: false }
];

for (const scenario of scenarios) {
  test(`Core 0.45 raw ownership: ${scenario.name}`, async (t) => {
    const current = await fixture(t, "running");
    const tabId = current.stale.use.tabId();
    const owner = scenario.owner === null ? null : { timerId: "shared-timer", deviceId: scenario.deviceId || "shared-device",
      ...(scenario.absent ? {} : { tabId: scenario.tabId === "current" ? tabId : scenario.tabId ?? null,
        leaseExpiresAtMs: scenario.expires ?? null }) };
    await seedMeta(current.stale.use.database(), { timerOwner: owner });
    const input = { ...current.stale.use.captureDatabaseContext(), deviceId: "shared-device", tabId,
      timerId: scenario.timerId || "shared-timer", nowMs, leaseMs: 60000 };
    const result = await observed(t, current, () => storage.renewTimerOwnership(current.stale.use.database(), { ...input, expectedUserId: input.ownerId }));
    assert.equal(result.error, undefined);
    assert.equal(result.returned, scenario.renewed);
    assert.equal(result.calls.length, 1);
    const receipt = result.calls[0];
    assert.deepEqual(JSON.parse(receipt.raw), receipt.input);
    assert.deepEqual(receipt.input.workspace.base, workspace.base(meta(result.before, "snapshot")));
    assert.deepEqual(receipt.input.ownership, owner);
    assert.deepEqual(receipt.input.workspace.displayContext.projectionPending, meta(result.before, "projectionPending") ?? null);
    assert.deepEqual(receipt.value, current.core.call("workspace.ownershipPlan.v1", receipt.input));
    assert.deepEqual(result.writes, receipt.value.ownershipWrites);
    assert.deepEqual(result.after.pending, result.before.pending);
    if (owner === null && scenario.renewed) assert.equal(result.writes.length, 2);
    if (!result.writes.length) assert.deepEqual(result.after, result.before);
  });
}

for (const owner of [[], ["shared-timer", "shared-device"], [1, 2, 3, 4], { timerId: "shared-timer", deviceId: "shared-device", injected: false }]) {
  test(`Core 0.45 corrupt raw owner aborts without any normalization: ${JSON.stringify(owner)}`, async (t) => {
    const current = await fixture(t, "running");
    await seedMeta(current.stale.use.database(), { timerOwner: owner });
    const input = { ...current.stale.use.captureDatabaseContext(), deviceId: "shared-device", tabId: current.stale.use.tabId(),
      timerId: "shared-timer", nowMs, leaseMs: 60000 };
    const result = await observed(t, current, () => storage.renewTimerOwnership(current.stale.use.database(), { ...input, expectedUserId: input.ownerId }));
    assert.match(result.error.message, /invalid shared-core/);
    assert.deepEqual(result.writes, []);
    assert.deepEqual(result.after, result.before);
  });
}

test("Core 0.45 explicit terminal timer prunes orphan owner inside renewal transaction", async (t) => {
  const current = await fixture(t, "completed");
  await seedMeta(current.stale.use.database(), { timerOwner: { timerId: "shared-timer", deviceId: "shared-device",
    tabId: current.stale.use.tabId(), leaseExpiresAtMs: nowMs + 60000 } });
  const input = { ...current.stale.use.captureDatabaseContext(), deviceId: "shared-device", tabId: current.stale.use.tabId(),
    timerId: "shared-timer", nowMs, leaseMs: 60000 };
  const result = await observed(t, current, () => storage.renewTimerOwnership(current.stale.use.database(), { ...input, expectedUserId: input.ownerId }));
  assert.equal(result.returned, false);
  assert.deepEqual(result.writes, [{ kind: "removeTimerOwner" }]);
  assert.equal(meta(result.after, "timerOwner"), undefined);
});

test("Core 0.45 legacy duration preferences commit raw planner outputs atomically", async (t) => {
  const current = await fixture(t);
  const database = current.stale.use.database();
  await seedMeta(database, { settings: { selectedPhase: "focus", durations: { focus: 30, short_break: 10, long_break: 30 },
    peerOnlySetting: "preserve" }, workspaceGroups: [{ preservedGroup: "original" }],
    completionRecords: { preservedCompletion: "original" } });
  const result = await observed(t, current, () => current.stale.use.bootstrapLegacyDurations());
  assert.equal(result.error, undefined);
  assert.equal(result.calls.length, 1);
  for (const receipt of result.calls) {
    assert.deepEqual(JSON.parse(receipt.raw), receipt.input);
    assert.deepEqual(receipt.input.workspace.base, workspace.base(meta(result.before, "snapshot")));
    assert.deepEqual(receipt.value, current.core.call(receipt.operation, receipt.input));
  }
  const after = result.after;
  assert.deepEqual(after.pendingDurations.map((operation) => [operation.phase, operation.durationMs]).sort(),
    [["focus", 1800000], ["long_break", 1800000], ["short_break", 600000]]);
  assert.equal(meta(after, "settings").peerOnlySetting, "preserve");
  assert.equal(meta(after, "settings").durationSyncBootstrapped, true);
  assert.equal(meta(after, "workspaceGroups").length, 1);
  assert.deepEqual(meta(after, "workspaceGroups")[0], { preservedGroup: "original" });
  assert.deepEqual(meta(after, "completionRecords"), { preservedCompletion: "original" });
  assert.deepEqual(meta(after, "deliveryProof").durationOperations.sort(), after.pendingDurations.map((item) => item.id).sort());
  const beforeRepeat = await dump(database);
  await current.stale.use.bootstrapLegacyDurations();
  assert.deepEqual(await dump(database), beforeRepeat);
});

test("Core 0.45 legacy preference migration preserves a possibly delivered duration and exact saved request", async (t) => {
  const current = await fixture(t);
  const client = current.stale, database = client.use.database();
  const first = (await client.use.persistDurationOperation("focus", 1800000)).operation;
  const { claim } = await storage.claimWorkspaceBatch(database, {
    ...client.use.captureAccountContext(), deviceId: client.state.deviceId, localNowMs: nowMs
  });
  await seedMeta(database, { settings: { selectedPhase: "focus", durations: { focus: 35 } } });
  const result = await observed(t, current, () => client.use.bootstrapLegacyDurations());
  assert.equal(result.error, undefined);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.calls[0].input.outgoing, claim);
  assert.deepEqual(meta(result.after, "outgoingSync"), claim);
  assert.deepEqual(result.after.pendingDurations.find((operation) => operation.id === first.id), first);
  assert.equal(result.after.pendingDurations.length, 2);
});

for (const minutes of [0, 181, 1.5]) {
  test(`Core 0.46 invalid current duration intent ${minutes} preserves the entire workspace`, async (t) => {
    const current = await fixture(t);
    const database = current.stale.use.database();
    await seedMeta(database, { settings: { selectedPhase: "focus", durations: { focus: 30, short_break: minutes } } });
    const before = await dump(database);
    await assert.rejects(current.stale.use.persistWorkspaceIntent(
      { kind: "setDuration", phase: "short_break", minutes }, { preference: true }), /invalid shared-core/);
    assert.deepEqual(await dump(database), before);
  });
}
