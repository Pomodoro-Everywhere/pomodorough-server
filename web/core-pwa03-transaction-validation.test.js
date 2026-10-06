"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const crypto = require("node:crypto");
const { fixture, storage: liveStorage, seedMeta, dump, snapshot, nowMs } = require("./test/account-ownership-fixture.js");
const receipts = [];

function productionModule(name) {
  if (!process.env.CORE_PWA03_TRANSACTION_BASELINE) return require(`./${name}`);
  const filename = path.join(__dirname, name);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(__dirname);
  loaded._compile(fs.readFileSync(path.join(process.env.CORE_PWA03_TRANSACTION_BASELINE, name), "utf8"), filename);
  return loaded.exports;
}

const productionStorage = productionModule("sync-storage.js");
const storage = process.env.CORE_PWA03_TRANSACTION_BASELINE ? productionStorage
  : { ...productionStorage, ...require("./test/core-planner-storage-fixture.js") };
const meta = (records, key) => records.meta.find((item) => item.key === key)?.value;
const context = (current) => ({ ...current.stale.use.captureAccountContext(), deviceId: "shared-device",
  nowMs, localNowMs: nowMs, leaseMs: 300000, gateToken: current.stale.use.tabId() });

test.after(() => {
  if (process.env.CORE_PWA03_TRANSACTION_EVIDENCE) fs.writeFileSync(process.env.CORE_PWA03_TRANSACTION_EVIDENCE,
    JSON.stringify({ provenance: require("./shared-core-metadata.js"), cases: receipts }, null, 2));
});

async function prepared(t) {
  const current = await fixture(t);
  storage.setSharedCore(current.core);
  const bytes = fs.readFileSync(path.join(__dirname, "pomodorough_core.wasm"));
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), require("./shared-core-metadata.js").sha256);
  const database = current.stale.use.database();
  const external = { ...current.stale.external, syncStorage: storage };
  Object.assign(current.stale.use, productionModule("app-storage.js").create({ state: current.stale.state, external, use: current.stale.use }));
  current.stale.use.setDatabaseForTest(database);
  current.stale.state.bootstrapPreview = snapshot("account-A");
  await seedMeta(database, { canonicalHead: { wallMs: nowMs, counter: 2 } });
  await current.stale.use.reloadPersistedState();
  return { ...current, external };
}

async function corrupt(current) {
  const value = { commands: "corrupt", taskOperations: [], durationOperations: [], autoStartOperations: [],
    selectedTaskOperations: [], unexpected: { retained: "original" } };
  await seedMeta(current.peer.use.database(), { projectionPending: value });
  return value;
}

async function rejectedMutation(current, call, name) {
  const before = await dump(current.stale.use.database());
  let error;
  try { await call(); } catch (failure) { error = { name: failure.name, message: failure.message }; }
  const after = await dump(current.stale.use.database());
  receipts.push({ case: name, before, after, error,
    beforeBytes: JSON.stringify(before.meta.find((item) => item.key === "projectionPending")),
    afterBytes: JSON.stringify(after.meta.find((item) => item.key === "projectionPending")) });
  assert.deepEqual(after, before);
  assert.equal(error?.name, "PersistedDisplayContextError");
}

test("CORE-PWA03 transaction rejects saved merge delivery retirement before proof or gate writes", async (t) => {
  const current = await prepared(t);
  await current.stale.use.persistDurationOperation("focus", 1800000);
  const pending = await current.stale.use.persistBootstrapResolution("merge");
  assert.equal(pending.deliveryState, "neverSent");
  await corrupt(current);
  await rejectedMutation(current, () => storage.validatePendingForSend(current.stale.use.database(), {
    ...context(current), pending, currentUserId: pending.userId
  }), t.name);
});

for (const entry of ["prepareBootstrap", "loadLocalState"]) {
  test(`CORE-PWA03 ${entry} rechecks cross-tab corruption inside gate transaction after valid precheck`, async (t) => {
    const current = await prepared(t);
    let injected;
    let baseline;
    const acquire = async (...args) => {
      injected = await corrupt(current);
      baseline = await dump(current.peer.use.database());
      return storage.acquireBootstrapGateWithLegacyAutoStart(...args);
    };
    const database = current.stale.use.database();
    const external = { ...current.external, syncStorage: { ...storage, acquireBootstrapGateWithLegacyAutoStart: acquire } };
    Object.assign(current.stale.use, productionModule("app-storage.js").create({ state: current.stale.state, external, use: current.stale.use }));
    current.stale.use.setDatabaseForTest(database);
    let error;
    try { await current.stale.use[entry](); } catch (failure) { error = { name: failure.name, message: failure.message }; }
    const after = await dump(current.peer.use.database());
    receipts.push({ case: t.name, injected, before: baseline, after, error });
    assert.ok(injected, "the old precheck completed before peer corruption");
    assert.deepEqual(after, baseline);
    assert.equal(error?.name, "PersistedDisplayContextError");
  });
}

test("CORE-PWA03 legacy duration bootstrap cannot consume settings or add migration row under corrupt context", async (t) => {
  const current = await prepared(t);
  await seedMeta(current.stale.use.database(), { settings: { selectedPhase: "focus", durations: { focus: 35 },
    durationSyncBootstrapped: false, retainedPreference: "keep" } });
  await corrupt(current);
  await rejectedMutation(current, () => current.stale.use.bootstrapLegacyDurations(), t.name);
});

test("CORE-PWA03 malicious false validation flag cannot authorize settings transaction writes", async (t) => {
  const current = await prepared(t);
  await corrupt(current);
  let invoked = false;
  await rejectedMutation(current, () => storage.guardedMutation(current.stale.use.database(), [], (transaction) => {
    invoked = true;
    transaction.objectStore("meta").put({ key: "settings", value: { selectedPhase: "long_break", injected: true } });
  }, { ...context(current), validateDisplayContext: false }), t.name);
  assert.equal(invoked, false);
});

for (const legacy of ["absent", "null"]) {
  test(`CORE-PWA03 genuine ${legacy} context still permits legacy duration migration and gate acquisition`, async (t) => {
    const current = await prepared(t);
    if (legacy === "null") await seedMeta(current.stale.use.database(), { projectionPending: null });
    await seedMeta(current.stale.use.database(), { settings: { selectedPhase: "focus", durations: { focus: 35 },
      durationSyncBootstrapped: false, retainedPreference: "keep" } });
    await current.stale.use.bootstrapLegacyDurations();
    const migrated = await dump(current.stale.use.database());
    const lease = await current.stale.use.acquireBootstrapGate();
    const after = await dump(current.stale.use.database());
    receipts.push({ case: t.name, migrated, lease, after });
    assert.equal(migrated.pendingDurations.length, 1);
    assert.equal(migrated.pendingDurations[0].durationMs, 2100000);
    assert.equal(meta(migrated, "settings").durationSyncBootstrapped, true);
    assert.equal(meta(migrated, "settings").durations, undefined);
    assert.equal(meta(migrated, "settings").retainedPreference, "keep");
    assert.equal(lease.acquired, true);
    assert.equal(meta(after, "bootstrapGate").token, current.stale.use.tabId());
  });
}

async function restoreRecords(current, records) {
  const transaction = current.stale.use.database().transaction(Object.keys(records), "readwrite");
  for (const [name, rows] of Object.entries(records)) {
    const store = transaction.objectStore(name);
    store.clear();
    for (const row of rows) store.put(row);
  }
  await liveStorage.transactionDone(transaction);
}

function writerCases(current) {
  const input = { ...context(current), allowBootstrap: true, validateDisplayContext: false, trustedContext: true,
    operationId: "legacy-operation", withUuidV7: true, timerId: "timer", phase: "focus", tabId: current.stale.use.tabId() };
  const database = () => current.stale.use.database();
  const sent = { commands: [], taskOperations: [], durationOperations: [], autoStartOperations: [], selectedTaskOperations: [] };
  return [
    ["clock request sequence", () => storage.allocateClockRequestSequence(database(), input)],
    ["clock sample", () => storage.saveClockOffset(database(), { offsetMs: 0, uncertaintyMs: 0,
      sampledAtWallMs: nowMs, receivedAtWallMs: nowMs, requestSequence: 1 }, input)],
    ["gate acquisition", () => storage.acquireBootstrapGate(database(), { ...input, token: input.gateToken })],
    ["foreign resolution invalidation", () => storage.invalidateForeignResolution(database(), { ...input, currentUserId: input.ownerId })],
    ["legacy auto-start", () => storage.migrateLegacyAutoStart(database(), input)],
    ["legacy selected task", () => storage.migrateLegacySelectedTask(database(), input)],
    ["legacy duration normalization", () => storage.normalizeLegacyDurationOperations(database(), input)],
    ["proof retirement", () => storage.retireProofAndPersistOutgoing(database(), sent, input)],
    ["operation allocation", () => storage.allocateMutation(database(), { ...input, storeName: "pendingDurations", nowMs,
      build: ({ id, wallMs, counter }) => ({ id, deviceId: "shared-device", phase: "focus", durationMs: 2100000,
        occurredAt: new Date(wallMs).toISOString(), hlcWallMs: wallMs, hlcCounter: counter }) })],
    ["timer cancellation", () => storage.cancelAndClearTimer(database(), input)],
    ["timer completion", () => storage.finishTimer(database(), input)],
    ["lease renewal", () => storage.renewTimerOwnership(database(), input)],
    ["lease release", () => storage.releaseTimerOwnership(database(), input)],
    ["settings queue transfer", () => current.stale.use.migrateDurationQueueFromSettings()],
    ["legacy duration bootstrap", () => current.stale.use.bootstrapLegacyDurations()],
    ["local identity publication", () => current.stale.use.persistNewLocalIdentity({})],
    ["settings persistence", () => current.stale.use.persistSettings()],
    ["authorized cleanup", () => current.stale.use.clearLocalData(undefined, current.stale.use.captureDatabaseContext())]
  ];
}

test("CORE-PWA03 every concrete metadata/migration/operation writer validates transaction raw context", async (t) => {
  const current = await prepared(t);
  await seedMeta(current.stale.use.database(), { settings: { selectedPhase: "focus", durations: { focus: 35 },
    autoStartBreaks: true, autoStartSyncBootstrapped: false, selectedTaskId: "legacy-task", selectedTaskSyncBootstrapped: false,
    pendingDurationOperations: [{ id: "legacy-duration", phase: "focus", durationMs: 2100000,
      occurredAt: new Date(0).toISOString(), hlcWallMs: 0, hlcCounter: 0 }] } });
  await corrupt(current);
  const before = await dump(current.stale.use.database());
  const observations = [];
  for (const [writer, call] of writerCases(current)) {
    await restoreRecords(current, before);
    if (!current.stale.use.database()) current.stale.use.setDatabaseForTest(await current.stale.use.openDatabase());
    let error;
    try { await call(); } catch (failure) { error = { name: failure.name, message: failure.message }; }
    observations.push({ writer, error, after: await dump(current.peer.use.database()) });
    if (!current.stale.use.database()) current.stale.use.setDatabaseForTest(await current.stale.use.openDatabase());
  }
  receipts.push({ case: t.name, before, observations });
  assert.equal(observations.length, 18);
  for (const observed of observations) {
    assert.deepEqual(observed.after, before, observed.writer);
    assert.equal(observed.error?.name, "PersistedDisplayContextError", observed.writer);
  }
});

test("CORE-PWA03 gate release also requires raw transaction validation", async (t) => {
  const current = await prepared(t);
  const input = { ...context(current), token: current.stale.use.tabId() };
  await storage.acquireBootstrapGate(current.stale.use.database(), input);
  await corrupt(current);
  await rejectedMutation(current, () => storage.clearBootstrapGate(current.stale.use.database(), input.token, input), t.name);
});

test("CORE-PWA03 source contracts forbid caller-controlled validation policy and partial mutation reads", () => {
  const source = fs.readFileSync(path.join(__dirname, "sync-storage.js"), "utf8");
  const repository = fs.readFileSync(path.join(__dirname, "app-storage.js"), "utf8");
  assert.doesNotMatch(source + repository, /validateDisplayContext/);
  for (const name of ["accountMetadataMutation", "guardedMutation", "normalizeLegacyDurationOperations"]) {
    const begin = source.indexOf(`function ${name}(`);
    const end = source.indexOf("\n  function ", begin + 1);
    const body = source.slice(begin, end === -1 ? source.length : end);
    assert.match(body, /mutationContextRequests\(transaction/);
    assert.match(body, /assertResponseDisplayContext\(results/);
  }
  const migration = source.slice(source.indexOf("function migrateLegacyPreferences("), source.indexOf("function installationOwnership("));
  assert.match(migration, /guardedMutation\(database/);
  assert.match(migration, /transactionWorkspace\(results/);
  assert.doesNotMatch(source, /function legacySettingsMutation\(/);
  assert.doesNotMatch(source, /transaction\((?:META_STORE|\[META_STORE(?:,\s*(?:storeName|DURATION_PENDING_STORE))?\]),\s*"readwrite"\)/);
});

test("CORE-PWA03 cold startup loads authoritative validator before authorized non-null-context cleanup", async (t) => {
  const cold = require("./test/cold-logout-recovery-fixture.js");
  const current = await cold.fixture(t);
  const transaction = current.database.transaction(cold.stores, "readwrite");
  for (const name of cold.stores.slice(1)) transaction.objectStore(name).clear();
  transaction.objectStore("meta").put({ key: "projectionPending", value: {
    commands: [], taskOperations: [], durationOperations: [], autoStartOperations: [], selectedTaskOperations: []
  } });
  await cold.storage.transactionDone(transaction);
  const filename = path.join(__dirname, "sync-storage.js");
  const fresh = new Module(filename, module);
  fresh.filename = filename;
  fresh.paths = Module._nodeModulePaths(__dirname);
  fresh._compile(fs.readFileSync(filename, "utf8"), filename);
  const order = [];
  Object.assign(current.cold.syncStorage, fresh.exports, {
    setSharedCore: (core) => { order.push("core-ready"); fresh.exports.setSharedCore(core); },
    guardedMutation: (...args) => { order.push("guarded-write"); return fresh.exports.guardedMutation(...args); }
  });
  const before = await cold.dump(current.database);
  await current.cold.initialize();
  const after = await cold.dump(current.database);
  receipts.push({ case: t.name, before, after, order, ready: current.cold.state.ready });
  assert.ok(order.includes("guarded-write"));
  assert.ok(order.indexOf("core-ready") < order.indexOf("guarded-write"));
  assert.equal(current.cold.state.ready, true);
  for (const name of cold.stores.slice(1)) assert.deepEqual(after[name], []);
});
