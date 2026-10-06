"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const crypto = require("node:crypto");
const { fixture, storage: liveStorage, seedMeta, dump, snapshot, nowMs } = require("./test/account-ownership-fixture.js");
const sync = require("./sync-core.js");
const workspace = require("./workspace-core.js");
const receipts = [];

function productionModule(name) {
  if (!process.env.CORE_PWA03_BASELINE) return require(`./${name}`);
  const filename = path.join(__dirname, name);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(__dirname);
  loaded._compile(fs.readFileSync(path.join(process.env.CORE_PWA03_BASELINE, name), "utf8"), filename);
  return loaded.exports;
}

const storage = productionModule("sync-storage.js");
const storeNames = { commands: "pending", taskOperations: "pendingTasks", durationOperations: "pendingDurations",
  autoStartOperations: "pendingAutoStarts", selectedTaskOperations: "pendingSelectedTasks" };

test.after(() => {
  if (process.env.CORE_PWA03_EVIDENCE) fs.writeFileSync(process.env.CORE_PWA03_EVIDENCE,
    JSON.stringify({ provenance: require("./shared-core-metadata.js"), cases: receipts }, null, 2));
});

function outcome(call) {
  try { return { value: call() }; } catch (error) { return { error: error.message }; }
}

function meta(records, key) { return records.meta.find((item) => item.key === key)?.value; }
function projectionBytes(records) { return JSON.stringify(records.meta.find((item) => item.key === "projectionPending")); }

async function prepared(t) {
  const current = await fixture(t);
  storage.setSharedCore(current.core);
  const bytes = fs.readFileSync(path.join(__dirname, "pomodorough_core.wasm"));
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), require("./shared-core-metadata.js").sha256);
  const { stale } = current;
  const database = stale.use.database();
  const external = { ...stale.external, syncStorage: storage };
  for (const name of ["app-state.js", "app-storage.js", "app-sync.js", "app-bootstrap.js"]) {
    Object.assign(stale.use, productionModule(name).create({ state: stale.state, external, use: stale.use, listen() {} }));
  }
  stale.use.setDatabaseForTest(database);
  await seedMeta(database, { canonicalHead: { wallMs: nowMs, counter: 2 } });
  await stale.use.reloadPersistedState();
  await stale.use.persistDurationOperation("focus", 1800000);
  const records = await dump(database);
  const duration = { ...records.pendingDurations[0], extension: { preserved: ["retained", 47] } };
  const transaction = database.transaction(["pendingDurations", "meta"], "readwrite");
  transaction.objectStore("pendingDurations").put(duration);
  transaction.objectStore("meta").put({ key: "projectionPending", value: {
    commands: [], taskOperations: [], durationOperations: [duration], autoStartOperations: [], selectedTaskOperations: []
  } });
  await liveStorage.transactionDone(transaction);
  await stale.use.reloadPersistedState();
  stale.state.bootstrapPreview = snapshot("account-A");
  return { ...current, external, valid: meta(await dump(database), "projectionPending") };
}

function rawRecords(current, records) {
  return { snapshot: meta(records, "snapshot"), settings: meta(records, "settings"), deviceId: "shared-device",
    deliveryProof: meta(records, "deliveryProof"), canonicalHead: meta(records, "canonicalHead"),
    outgoing: meta(records, "outgoingSync"), timerDependencies: meta(records, "timerDependencies"),
    projectionPending: meta(records, "projectionPending"),
    ...Object.fromEntries(workspace.DOMAINS.map((domain) => [domain, records[storeNames[domain]]])) };
}

function bootstrapInput(current, records) {
  return { ...records, ownerId: sync.accountOwnerId(current.stale.state.user),
    currentUserId: sync.accountOwnerId(current.stale.state.user), remote: current.stale.state.bootstrapPreview,
    nowMs, defaultDurationsMs: workspace.DEFAULT_DURATIONS };
}

function directBootstrap(current, records) {
  const input = bootstrapInput(current, records);
  return outcome(() => current.core.call("bootstrap.workspacePlan.v1", workspace.bootstrapRequest(input,
    input.deviceId, input.timerDependencies || [], input.currentUserId, nowMs, input.defaultDurationsMs)));
}

function mutationInput(current, extra) {
  return { ...current.stale.use.captureAccountContext(), deviceId: "shared-device", tabId: current.stale.use.tabId(),
    nowMs, localNowMs: nowMs, leaseMs: 60000, timerUuid: crypto.randomUUID(), ...extra };
}

const malformed = [
  { name: "commands string", change: (value) => { value.commands = "corrupt"; } },
  { name: "unknown top-level field", change: (value) => { value.unexpected = { confidential: 47 }; } },
  { name: "null commands", change: (value) => { value.commands = null; } },
  { name: "missing commands", change: (value) => { delete value.commands; } },
  { name: "null task domain", change: (value) => { value.taskOperations = null; } },
  { name: "missing selected-task domain", change: (value) => { delete value.selectedTaskOperations; } },
  { name: "rewritten extension", change: (value) => { value.durationOperations[0].extension.preserved = ["rewritten"]; } },
  { name: "unknown retained ID", change: (value) => { value.durationOperations[0].id = "unknown-id"; } },
  { name: "duplicate retained record", change: (value) => { value.durationOperations.push(structuredClone(value.durationOperations[0])); } },
  { name: "top-level string", replace: "corrupt" },
  { name: "top-level false", replace: false }
];

for (const domain of workspace.DOMAINS) {
  if (!["commands", "taskOperations"].includes(domain)) malformed.push({ name: `null ${domain}`,
    change: (value) => { value[domain] = null; } });
  if (!["commands", "selectedTaskOperations"].includes(domain)) malformed.push({ name: `missing ${domain}`,
    change: (value) => { delete value[domain]; } });
}
malformed.push({ name: "missing domain replaced by unknown field", change: (value) => {
  delete value.autoStartOperations;
  value.unexpected = [];
} });

for (const scenario of malformed) {
  test(`CORE-PWA03 raw decode and bootstrap agree with official validator: ${scenario.name}`, async (t) => {
    const current = await prepared(t);
    const value = Object.hasOwn(scenario, "replace") ? scenario.replace : structuredClone(current.valid);
    scenario.change?.(value);
    await seedMeta(current.stale.use.database(), { projectionPending: value });
    const before = await dump(current.stale.use.database());
    const raw = rawRecords(current, before);
    const direct = directBootstrap(current, raw);
    const decoded = await storage.readSyncState(current.stale.use.database());
    const calls = [];
    const dispatch = current.core.call.bind(current.core);
    t.mock.method(current.core, "call", (operation, input) => {
      if (operation === "bootstrap.workspacePlan.v1") calls.push(structuredClone(input));
      return dispatch(operation, input);
    });
    const adapted = outcome(() => storage.bootstrapWorkspace(bootstrapInput(current, { ...decoded, deviceId: "shared-device" })));
    let buildError;
    try { await current.stale.use.buildBootstrapPlan(); } catch (error) { buildError = error.message; }
    const after = await dump(current.stale.use.database());
    receipts.push({ case: t.name, value, raw, direct, decoded, adapted, buildError, calls, before, after,
      originalBytes: projectionBytes(before), afterBytes: projectionBytes(after) });
    assert.ok(direct.error, "original raw record must fail official validation");
    assert.deepEqual(decoded.projectionPending, value);
    assert.deepEqual(adapted, direct);
    assert.equal(buildError, direct.error);
    assert.equal(calls.length, 2);
    for (const input of calls) assert.equal(JSON.stringify(input.local.projectionPending), JSON.stringify(value));
    assert.deepEqual(after, before);
  });

  test(`CORE-PWA03 corrupt context blocks timer/settings/claim transactions atomically: ${scenario.name}`, async (t) => {
    const current = await prepared(t);
    const value = Object.hasOwn(scenario, "replace") ? scenario.replace : structuredClone(current.valid);
    scenario.change?.(value);
    await seedMeta(current.stale.use.database(), { projectionPending: value });
    const before = await dump(current.stale.use.database());
    const observations = [];
    const calls = [
      () => storage.planWorkspaceMutation(current.stale.use.database(), mutationInput(current, { intent: { kind: "start" } })),
      () => storage.planWorkspaceMutation(current.stale.use.database(), mutationInput(current, { intent: { kind: "setDuration", phase: "focus", minutes: 35 }, preference: true })),
      () => storage.claimWorkspaceBatch(current.stale.use.database(), mutationInput(current, {})),
      () => current.stale.use.persistSettings()
    ];
    for (const call of calls) {
      let error;
      try { await call(); } catch (failure) { error = failure.message; }
      observations.push({ error, after: await dump(current.stale.use.database()) });
    }
    receipts.push({ case: t.name, value, before, originalBytes: projectionBytes(before), observations });
    for (const observed of observations) {
      assert.ok(observed.error, "no mutable path may discard corrupt display context");
      assert.deepEqual(observed.after, before);
      assert.equal(projectionBytes(observed.after), projectionBytes(before));
    }
  });
}

test("CORE-PWA03 late corruption makes real timer/settings actions show recovery without changing any store", async (t) => {
  const current = await prepared(t);
  await seedMeta(current.stale.use.database(), { projectionPending: { ...current.valid, commands: "corrupt" } });
  const before = await dump(current.stale.use.database());
  current.stale.calls.length = 0;
  const timer = await current.stale.use.issueCommand("start");
  const settings = await current.stale.use.issueDurationOperation("short_break", 600000);
  const after = await dump(current.stale.use.database());
  receipts.push({ case: t.name, before, after, timer, settings, notices: structuredClone(current.stale.calls) });
  assert.equal(timer, false);
  assert.equal(settings, false);
  assert.deepEqual(after, before);
  assert.ok(current.stale.calls.some((call) => call[0] === "notice" && /recovery|commands/i.test(call[1])));
});

test("CORE-PWA03 cold startup refuses corrupt record before gate/migration writes and retains raw recovery context", async (t) => {
  const current = await prepared(t);
  const value = { ...current.valid, unexpected: 47 };
  await seedMeta(current.stale.use.database(), { projectionPending: value });
  const before = await dump(current.stale.use.database());
  current.stale.use.database().close();
  current.stale.use.setDatabaseForTest(null);
  let error;
  try { await current.stale.use.loadLocalState(); } catch (failure) { error = failure.message; }
  const after = await dump(current.stale.use.database());
  receipts.push({ case: t.name, value, before, after, error, raw: structuredClone(current.stale.state.projectionPending),
    blocked: current.stale.use.controlsBlocked(), conflict: current.stale.state.conflict });
  assert.ok(error);
  assert.deepEqual(after, before);
  assert.deepEqual(current.stale.state.projectionPending, value);
  assert.equal(current.stale.use.controlsBlocked(), true);
});

test("CORE-PWA03 malformed display context cannot retire proof or move cursor even with saved claim", async (t) => {
  const current = await prepared(t);
  const input = mutationInput(current, {});
  const claimed = await storage.claimWorkspaceBatch(current.stale.use.database(), input);
  await seedMeta(current.stale.use.database(), { projectionPending: { ...current.valid, commands: "corrupt" } });
  const before = await dump(current.stale.use.database());
  let error;
  try { await storage.claimWorkspaceBatch(current.stale.use.database(), input); } catch (failure) { error = failure.message; }
  const after = await dump(current.stale.use.database());
  receipts.push({ case: t.name, claimed, before, after, error });
  assert.ok(error);
  assert.deepEqual(after, before);
  assert.deepEqual(meta(after, "outgoingSync"), claimed.claim);
});

test("CORE-PWA03 valid exact extension context remains raw and valid after unrelated mutation/reopen", async (t) => {
  const current = await prepared(t);
  const original = current.valid.durationOperations[0];
  await current.stale.use.persistTaskOperation("upsert", current.core.taskIdentity({ title: "Unrelated valid task" }));
  const after = await dump(current.stale.use.database());
  const raw = meta(after, "projectionPending");
  const direct = directBootstrap(current, rawRecords(current, after));
  current.stale.use.database().close();
  current.stale.use.setDatabaseForTest(await current.stale.use.openDatabase());
  let error;
  try { await current.stale.use.reloadPersistedState(); } catch (failure) { error = failure.message; }
  const reopened = await dump(current.stale.use.database());
  receipts.push({ case: t.name, original, raw, direct, after, reopened, error });
  assert.deepEqual(raw.durationOperations[0], original);
  assert.equal(direct.error, undefined);
  assert.equal(error, undefined);
  assert.deepEqual(reopened, after);
});

test("CORE-PWA03 head-covered claimed timer remains actionable through raw validated display context", async (t) => {
  const current = await prepared(t);
  assert.equal(await current.stale.use.issueCommand("start"), true);
  await storage.claimWorkspaceBatch(current.stale.use.database(), mutationInput(current, {}));
  const before = await dump(current.stale.use.database());
  const direct = directBootstrap(current, rawRecords(current, before));
  let error;
  try { await storage.planWorkspaceMutation(current.stale.use.database(), mutationInput(current, { intent: { kind: "pause" } })); }
  catch (failure) { error = failure.message; }
  const after = await dump(current.stale.use.database());
  receipts.push({ case: t.name, before, after, direct, error });
  assert.equal(direct.error, undefined);
  assert.equal(error, undefined);
  assert.deepEqual(after.pending.slice(0, -1), before.pending);
  assert.equal(after.pending.at(-1).type, "pause");
  assert.deepEqual(meta(after, "outgoingSync"), meta(before, "outgoingSync"));
  await current.stale.use.reloadPersistedState();
  assert.equal(current.stale.state.timer.status, "paused");
});

test("CORE-PWA03 malformed record remains byte-exact with visible recovery across reload and reopen", async (t) => {
  const current = await prepared(t);
  const value = { ...current.valid, unexpected: { retain: "original" }, commands: "corrupt" };
  await seedMeta(current.stale.use.database(), { projectionPending: value });
  const before = await dump(current.stale.use.database());
  const observations = [];
  for (let reopen = 0; reopen < 2; reopen += 1) {
    let error;
    try { await current.stale.use.reloadPersistedState(); } catch (failure) { error = failure.message; }
    observations.push({ error, raw: structuredClone(current.stale.state.projectionPending),
      blocked: current.stale.use.controlsBlocked(), conflict: current.stale.state.conflict,
      notices: structuredClone(current.stale.calls), after: await dump(current.stale.use.database()) });
    if (!reopen) {
      current.stale.use.database().close();
      current.stale.use.setDatabaseForTest(await current.stale.use.openDatabase());
    }
  }
  receipts.push({ case: t.name, value, before, originalBytes: projectionBytes(before), observations });
  for (const observed of observations) {
    assert.ok(observed.error);
    assert.deepEqual(observed.raw, value);
    assert.equal(observed.blocked, true);
    assert.match(observed.conflict, /recovery|projection/i);
    assert.deepEqual(observed.after, before);
  }
});

test("CORE-PWA03 bootstrap preparation rejects corrupt input before gate or request writes", async (t) => {
  const current = await prepared(t);
  await seedMeta(current.stale.use.database(), { projectionPending: { ...current.valid, commands: "corrupt" } });
  const before = await dump(current.stale.use.database());
  let error;
  try { await current.stale.use.prepareBootstrap(); } catch (failure) { error = failure.message; }
  const after = await dump(current.stale.use.database());
  receipts.push({ case: t.name, before, after, error, conflict: current.stale.state.conflict });
  assert.ok(error);
  assert.deepEqual(after, before);
  assert.match(current.stale.state.conflict, /recovery|projection/i);
});

for (const mode of ["absent", "null", "exact matching extension record"]) {
  test(`CORE-PWA03 valid legacy or exact display context keeps ordinary mutation: ${mode}`, async (t) => {
    const current = await prepared(t);
    if (mode === "absent") {
      const transaction = current.stale.use.database().transaction("meta", "readwrite");
      transaction.objectStore("meta").delete("projectionPending");
      await liveStorage.transactionDone(transaction);
    } else if (mode === "null") await seedMeta(current.stale.use.database(), { projectionPending: null });
    const before = await dump(current.stale.use.database());
    const records = rawRecords(current, before);
    const direct = directBootstrap(current, records);
    const decoded = await storage.readSyncState(current.stale.use.database());
    const adapted = outcome(() => storage.bootstrapWorkspace(bootstrapInput(current, { ...decoded, deviceId: "shared-device" })));
    await current.stale.use.reloadPersistedState();
    const plan = await storage.planWorkspaceMutation(current.stale.use.database(), mutationInput(current, { intent: { kind: "setDuration", phase: "short_break", minutes: 10 }, preference: true }));
    const after = await dump(current.stale.use.database());
    receipts.push({ case: t.name, before, decoded, direct, adapted, plan, after });
    assert.equal(direct.error, undefined);
    assert.deepEqual(adapted, direct);
    assert.deepEqual(decoded.projectionPending, mode === "exact matching extension record" ? current.valid : null);
    assert.equal(plan.outcome, "planned");
    assert.equal(after.pendingDurations.some((item) => item.phase === "short_break" && item.durationMs === 600000), true);
  });
}
