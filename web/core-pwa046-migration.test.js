"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { fixture, storage, sync, seedMeta, seedQueues, dump, meta, snapshot, nowMs } = require("./test/p222-completion-fixture.js");
const workspace = require("./workspace-core.js");
const receipts = [];

test.after(() => {
  if (process.env.CORE_PWA046_EVIDENCE) fs.writeFileSync(process.env.CORE_PWA046_EVIDENCE,
    JSON.stringify({ provenance: require("./shared-core-metadata.js"), cases: receipts }, null, 2));
});

async function observe(current, name, action) {
  const database = current.client.use.database(), before = await dump(database);
  const call = current.core.call.bind(current.core), calls = [];
  current.core.call = (operation, input) => {
    const inputRaw = JSON.stringify(input);
    const value = call(operation, input);
    calls.push({ operation, inputRaw, input: JSON.parse(inputRaw), value: structuredClone(value) });
    return value;
  };
  let returned, error;
  try { returned = await action(); }
  catch (failure) { error = { name: failure.name, message: failure.message, recovery: failure.recovery }; }
  finally { current.core.call = call; }
  const after = await dump(database);
  receipts.push({ name, before, after, calls, returned, error });
  for (const receipt of calls) {
    assert.deepEqual(JSON.parse(receipt.inputRaw), receipt.input);
    assert.deepEqual(call(receipt.operation, receipt.input), receipt.value);
  }
  return { before, after, calls, returned, error };
}

function issuer(client) {
  return { ...client.use.captureDatabaseContext(), deviceId: client.state.deviceId, nowMs: Date.now(), localNowMs: Date.now() };
}

test("Core 0.46 legacy preferences preserve numeric tokens, all original flags and zero-clock precedence", async (t) => {
  const current = await fixture(t);
  const database = current.client.use.database();
  const original = meta(await dump(database), "snapshot");
  await seedMeta(database, { snapshot: { ...original, durationsMs: { focus: 2100000, short_break: 600000, long_break: 1800000 } },
    canonicalHead: { wallMs: nowMs, counter: 2 },
    settings: { selectedPhase: "focus", durations: { focus: 90.49999999999999, short_break: 90.49999999999999,
      long_break: 90.49999999999999 }, autoStartBreaks: false, autoStartBreaksExplicit: true,
      selectedTaskId: null, selectedTaskIdExplicit: true, unknownNumeric: 90.49999999999999 } });
  const result = await observe(current, t.name, () => storage.migrateLegacyPreferences(database, issuer(current.client)));
  assert.equal(result.error, undefined);
  const receipt = result.calls.find((item) => item.operation === "workspace.legacyPreferences.v1");
  assert.deepEqual(receipt.input.settings, meta(result.before, "settings"));
  assert.deepEqual(result.returned, receipt.value);
  assert.equal(result.returned.consumedIdentityCount, 5);
  assert.deepEqual(result.after.pendingDurations.map((item) => item.durationMs), [5400000, 5400000, 5400000]);
  for (const item of [...result.after.pendingDurations, ...result.after.pendingAutoStarts, ...result.after.pendingSelectedTasks]) {
    assert.equal(item.hlcWallMs, 0); assert.equal(item.hlcCounter, 0);
    assert.equal(item.occurredAt, "1970-01-01T00:00:00.000Z");
    assert.equal(Object.hasOwn(item, "deviceId"), false);
  }
  assert.equal(result.after.pendingAutoStarts[0].enabled, false);
  assert.equal(result.after.pendingSelectedTasks[0].taskId, null);
  assert.equal(meta(result.after, "settings").unknownNumeric, 90.49999999999999);
  assert.deepEqual(meta(result.after, "snapshot"), meta(result.before, "snapshot"));
  for (const key of ["hlc", "deviceSequence", "uuidV7"]) assert.deepEqual(meta(result.after, key), meta(result.before, key));
  const project = storage.projectWorkspace({ ...await storage.readSyncState(database), deviceId: current.client.state.deviceId, nowMs });
  assert.equal(project.workspace.durationsMs.focus, 2100000);
  const repeated = await observe(current, "legacy exact restart no-op", () => storage.migrateLegacyPreferences(database, issuer(current.client)));
  assert.equal(repeated.returned.outcome, "noop"); assert.deepEqual(repeated.after, repeated.before);
});

test("Core 0.46 legacy migration retains raw numeric extensions and an actual immutable outgoing body", async (t) => {
  const current = await fixture(t), client = current.client, database = client.use.database();
  const first = (await client.use.persistDurationOperation("focus", 1800000)).operation;
  const extended = { ...first, unknownNumeric: 90.49999999999999 };
  const previous = await dump(database);
  const transaction = database.transaction(["meta", "pendingDurations"], "readwrite");
  transaction.objectStore("pendingDurations").put(extended);
  transaction.objectStore("meta").put({ key: "projectionPending", value: { ...meta(previous, "projectionPending"), durationOperations: [extended] } });
  await storage.transactionDone(transaction);
  const { claim } = await storage.claimWorkspaceBatch(database, issuer(client));
  await seedMeta(database, { settings: { selectedPhase: "focus", durations: { short_break: "10" }, unknownNumeric: 90.49999999999999 } });
  const result = await observe(current, t.name, () => storage.migrateLegacyPreferences(database, issuer(client)));
  assert.equal(result.error, undefined);
  assert.deepEqual(meta(result.after, "outgoingSync"), claim);
  assert.deepEqual(result.after.pendingDurations.find((item) => item.id === first.id), extended);
  assert.equal(meta(result.after, "settings").unknownNumeric, 90.49999999999999);
  assert.equal(result.after.pendingDurations.find((item) => item.phase === "short_break").durationMs, 600000);
});

async function legacyChain(current) {
  const client = current.client;
  assert.equal(await client.use.issueCommand("start"), true);
  assert.equal(await client.use.finishTimer(false), true);
  assert.equal(await client.use.issueCommand("pause"), true);
  assert.equal(await client.use.issueCommand("resume"), true);
  const original = await dump(client.use.database());
  const source = original.pending.find((item) => item.type === "finish");
  const commands = original.pending.map((item) => ["pause", "resume"].includes(item.type)
    ? { ...item, dependsOnCommandId: source.id } : item);
  const transaction = client.use.database().transaction(["meta", "pending"], "readwrite");
  for (const command of commands) transaction.objectStore("pending").put(command);
  transaction.objectStore("meta").put({ key: "timerDependencies", value: null });
  transaction.objectStore("meta").put({ key: "projectionPending", value: { ...meta(original, "projectionPending"), commands } });
  await storage.transactionDone(transaction);
  return { source, commands };
}

test("Core 0.46 upgrades proven legacy siblings with only complete metadata writes", async (t) => {
  const current = await fixture(t, { autoStartBreaks: true });
  const { source, commands } = await legacyChain(current);
  const database = current.client.use.database();
  const result = await observe(current, t.name, () => storage.migrateLegacyDependencies(database, issuer(current.client)));
  assert.equal(result.error, undefined);
  const plan = result.returned;
  assert.equal(plan.outcome, "planned");
  assert.deepEqual(result.after.pending, result.before.pending);
  const generated = commands.find((item) => item.generatedBreak);
  const pause = commands.find((item) => item.type === "pause"), resume = commands.find((item) => item.type === "resume");
  assert.equal(plan.timerDependencies.find((edge) => edge.operationId === generated.id).dependsOnOperationId, source.id);
  assert.equal(plan.timerDependencies.find((edge) => edge.operationId === pause.id).dependsOnOperationId, generated.id);
  assert.equal(plan.timerDependencies.find((edge) => edge.operationId === resume.id).dependsOnOperationId, pause.id);
  const withoutGraph = (records) => ({ ...records, meta: records.meta.filter((row) => row.key !== "timerDependencies") });
  assert.deepEqual(withoutGraph(result.after), withoutGraph(result.before));
  const peer = await current.open(); await peer.use.reloadPersistedState();
  assert.deepEqual(await dump(peer.use.database()), result.after);
  const repeated = await storage.migrateLegacyDependencies(peer.use.database(), issuer(peer));
  assert.equal(repeated.outcome, "noop");
});

test("Core 0.46 incomplete dependency provenance blocks with every wire row and saved body intact", async (t) => {
  const current = await fixture(t, { autoStartBreaks: true });
  await legacyChain(current);
  const database = current.client.use.database(), records = await dump(database);
  const source = records.pending.find((item) => item.type === "finish");
  const transaction = database.transaction(["meta", "pending"], "readwrite");
  transaction.objectStore("pending").delete(source.id);
  transaction.objectStore("meta").put({ key: "projectionPending", value: null });
  transaction.objectStore("meta").put({ key: "deliveryProof", value: {
    ...meta(records, "deliveryProof"), commands: meta(records, "deliveryProof").commands.filter((id) => id !== source.id) } });
  await storage.transactionDone(transaction);
  const result = await observe(current, t.name, () => storage.migrateLegacyDependencies(database, issuer(current.client)));
  assert.equal(result.error.name, "LegacyDependencyRecoveryError");
  assert.equal(result.error.recovery.blocksSync, true);
  assert.equal(result.error.recovery.blocksMutations, true);
  assert.deepEqual(result.after, result.before);
  const blockedPlan = result.calls.find((item) => item.operation === "workspace.legacyDependencyPlan.v1").value;
  assert.equal(blockedPlan.outcome, "blocked"); assert.deepEqual(blockedPlan.metadataWrites, []);
  assert.deepEqual(blockedPlan.workspace.local.commands, result.before.pending);
  assert.deepEqual(await dump(database), result.before);
});

for (const phase of ["focus", "short_break", "long_break"]) for (const chooseDuringTimer of [false, true]) {
  test(`Core 0.46 public cycle keeps original Finish evidence through read and reopen: ${phase}, choice=${chooseDuringTimer}`, async (t) => {
    const current = await fixture(t, { autoStartBreaks: true }), client = current.client;
    client.use.trustedNow = () => Date.now();
    const canonical = meta(await dump(client.use.database()), "snapshot");
    assert.equal(await client.use.issuePhaseSelection(phase), true);
    const choice = meta(await dump(client.use.database()), "completionState");
    assert.equal(choice.selection.explicit, true); assert.equal(choice.selection.generation, "1");
    assert.equal(await client.use.issueCommand("start"), true);
    const started = meta(await dump(client.use.database()), "completionState");
    assert.equal(started.selection.explicit, false); assert.equal(started.selection.generation, "1");
    if (chooseDuringTimer) assert.equal(await client.use.issuePhaseSelection("long_break"), true);
    const timer = structuredClone(client.state.timer);
    t.mock.timers.setTime(nowMs + timer.plannedDurationMs);
    const model = client.use.getWorkspaceReadModel();
    assert.ok(model.availableIntents.includes("finish"));
    assert.equal(model.display.phase, chooseDuringTimer ? "long_break" : phase === "focus" ? "short_break" : "focus");
    const result = await observe(current, t.name, () => client.use.finishTimer(false));
    assert.equal(result.returned, true, client.notices.join("; "));
    const call = result.calls.find((item) => item.operation === "workspace.completionMutation.v1");
    const stored = meta(result.after, "completionState");
    assert.deepEqual(stored, { selection: call.value.selection, lifecycle: call.value.lifecycle });
    assert.equal(stored.lifecycle.finishEvidence.length, 1);
    assert.deepEqual(stored.lifecycle.finishEvidence[0].command, call.value.commands[0]);
    assert.deepEqual(meta(result.after, "snapshot"), canonical);
    if (chooseDuringTimer) assert.equal(call.value.commands.length, 1);
    assert.equal(client.use.getWorkspaceReadModel().availableIntents.includes("finish"), call.value.commands.length === 2);
    const reopened = await current.open(); reopened.use.trustedNow = () => Date.now();
    await reopened.use.reloadPersistedState();
    assert.deepEqual(reopened.state.completionState, stored);
    assert.deepEqual(await dump(reopened.use.database()), result.after);
    const before = await dump(reopened.use.database());
    const repeated = await reopened.use.persistWorkspaceCompletion("finishCommit", timer);
    assert.equal(repeated.outcome, "noop"); assert.deepEqual(repeated.commands, []);
    assert.deepEqual(await dump(reopened.use.database()), before);
  });
}

test("Core 0.46 concurrent phase choices read the actual committed generation and never reset on reopen", async (t) => {
  const current = await fixture(t), peer = await current.open();
  await peer.use.reloadPersistedState();
  await Promise.all([current.client.use.issuePhaseSelection("focus"), peer.use.issuePhaseSelection("long_break")]);
  const stored = meta(await dump(peer.use.database()), "completionState");
  assert.equal(stored.selection.generation, "2"); assert.equal(stored.selection.explicit, true);
  const reopened = await current.open(); await reopened.use.reloadPersistedState();
  assert.deepEqual(reopened.state.completionState, stored);
});

test("Core 0.46 fabricated consumed Finish marker fails read and mutation without any persisted change", async (t) => {
  const current = await fixture(t), client = current.client;
  await client.use.issueCommand("start");
  const timer = client.state.timer;
  await seedMeta(client.use.database(), { completionState: {
    selection: { phase: "focus", generation: "17", explicit: false },
    lifecycle: { consumedCompletions: [{ timerId: timer.id, phase: "focus", commandId: "fabricated-finish" }],
      pendingBreaks: [], finishEvidence: [] }
  } });
  await client.use.reloadPersistedState();
  const before = await dump(client.use.database());
  assert.throws(() => client.use.getWorkspaceReadModel(), /consumed Finish lacks raw or durable original evidence/);
  assert.equal(await client.use.finishTimer(false), false);
  assert.deepEqual(await dump(client.use.database()), before);
});
