"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");
const { fixture, storage, sync, dump, seedMeta, snapshot, deferred, nowMs } = require("./test/account-ownership-fixture.js");
const { accountUser } = require("./test/incarnation-fixture.js");
const receipts = [];

function actionsModule() {
  if (!process.env.CORE_PWA08_BASELINE) return require("./app-actions.js");
  const filename = path.join(__dirname, "app-actions.js");
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(__dirname);
  loaded._compile(fs.readFileSync(path.join(process.env.CORE_PWA08_BASELINE, "web/app-actions.js"), "utf8"), filename);
  return loaded.exports;
}

test.after(() => {
  if (process.env.CORE_PWA08_EVIDENCE) fs.writeFileSync(process.env.CORE_PWA08_EVIDENCE,
    JSON.stringify({ provenance: require("./shared-core-metadata.js"), cases: receipts }, null, 2));
});

function watchEffects(t, current) {
  const events = [];
  for (const name of ["render", "renderTimer", "renderSyncStatus", "scheduleSync", "showNotice", "queueSessionRevalidation"]) {
    current.use[name] = (...argumentsList) => events.push({ kind: name, arguments: argumentsList.map(String) });
  }
  current.external.host.console.warn = (...args) => events.push({ kind: "warn", arguments: args.map(String) });
  current.external.host.Notification = class {
    static permission = "granted";
    constructor() { events.push({ kind: "notification" }); }
    close() { events.push({ kind: "closeNotification" }); }
  };
  const previous = globalThis.PomodoroughSentryClient;
  globalThis.PomodoroughSentryClient = { reportFrontendError: (error, operation) => events.push({ kind: "report", operation, error: error.message }) };
  t.after(() => {
    if (previous === undefined) delete globalThis.PomodoroughSentryClient;
    else globalThis.PomodoroughSentryClient = previous;
  });
  return events;
}

async function prepared(t, timing = "before transaction") {
  const current = await fixture(t, "running");
  assert.equal(current.core.call("core.version", {}).coreVersion, "0.46.0");
  const artifact = fs.readFileSync(path.join(__dirname, "pomodorough_core.wasm"));
  assert.equal(artifact.length, 2790028);
  assert.equal(crypto.createHash("sha256").update(artifact).digest("hex"), "55cbddc547933a75a4f20dbf46bbfab9f1274689c2f1a8b631af3e6d8a2815a4");
  const entered = deferred();
  const release = deferred();
  const completed = deferred();
  const renewals = [];
  const external = { ...current.stale.external, syncStorage: { ...storage, async renewTimerOwnership(database, input) {
    const observation = { ownerId: input.expectedUserId, timerId: input.timerId, boundToOriginalDatabase: database === current.originalDatabase };
    renewals.push(observation);
    const first = renewals.length === 1;
    if (first && timing === "before transaction") { entered.resolve(); await release.promise; }
    try {
      const result = await storage.renewTimerOwnership(database, input);
      observation.result = result;
      if (first && timing === "after transaction") { entered.resolve(); await release.promise; }
      return result;
    } catch (error) {
      observation.error = { name: error.name, message: error.message };
      if (first && timing === "after rejection") { entered.resolve(); await release.promise; }
      throw error;
    }
    finally { if (first) completed.resolve(); }
  } } };
  current.originalDatabase = current.stale.use.database();
  const events = watchEffects(t, current.stale);
  Object.assign(current.stale.use, actionsModule().create({ state: current.stale.state, external, use: current.stale.use }));
  current.stale.external = external;
  t.after(() => { release.resolve(); current.originalDatabase.close(); });
  return { ...current, entered, release, completed, renewals, events };
}

async function settle(current, operation) {
  await current.completed.promise;
  await operation;
  for (let index = 0; index < 12; index += 1) await new Promise(setImmediate);
}

async function observation(current) {
  return { persisted: await dump(current.stale.use.database()), memory: structuredClone(current.stale.state),
    alertTimerId: current.stale.use.activeCompletionAlertTimerId(), completionQueued: current.stale.use.completionQueuedForTest() };
}

async function keepRemote(current, replacement) {
  const peer = current.peer;
  peer.state.user = replacement;
  const gateToken = peer.use.tabId();
  await storage.acquireBootstrapGate(peer.use.database(), { token: gateToken, nowMs, leaseMs: 300000 });
  const pending = await storage.captureResolution(peer.use.database(), { userId: sync.accountOwnerId(replacement),
    requestId: crypto.randomUUID(), deviceId: peer.state.deviceId, expectedRevision: peer.state.revision,
    strategy: "keep_remote" }, { gateToken });
  const canonical = { ...snapshot(replacement.id, "running"), user: replacement };
  canonical.canonicalTimer.id = "replacement-private-timer";
  const payload = { ...canonical, accountIncarnation: replacement.accountIncarnation,
    acknowledgements: [], taskAcknowledgements: [], durationAcknowledgements: [], autoStartAcknowledgements: [],
    selectedTaskAcknowledgements: [], serverHlcWallMs: nowMs, serverHlcCounter: 100 };
  delete payload.user;
  await peer.use.acceptBootstrapResponse(payload, pending, null, peer.use.captureAccountContext());
  current.stale.state.user = replacement;
  current.stale.state.localOwnerId = sync.accountOwnerId(replacement);
  await current.stale.use.reloadPersistedState();
}

async function replaceConnection(current, t, restoreOriginal = false) {
  current.stale.use.setDatabaseForTest(null);
  const opened = await current.stale.use.openDatabase();
  t.after(() => opened.close());
  current.stale.use.setDatabaseForTest(opened);
  if (restoreOriginal) current.stale.use.setDatabaseForTest(current.originalDatabase);
  await seedMeta(current.stale.use.database(), { snapshot: { ...snapshot("account-A", "running"),
    canonicalTimer: { ...snapshot("account-A", "running").canonicalTimer, id: "reset-private-timer" } },
    settings: { selectedPhase: "long_break", durationSyncBootstrapped: true,
      autoStartSyncBootstrapped: true, selectedTaskSyncBootstrapped: true, replacementPreference: "47" },
    timerOwner: { timerId: "reset-private-timer", deviceId: "shared-device", tabId: current.stale.use.tabId(), leaseExpiresAtMs: nowMs + 47000 } });
  await current.stale.use.reloadPersistedState();
}

const replacements = [
  { name: "different account Keep Remote", replace: (current) => keepRemote(current, accountUser("account-B")) },
  { name: "same public ID, new incarnation Keep Remote", replace: (current) => keepRemote(current, accountUser("account-A", 2)) },
  { name: "same account replacement connection", replace: replaceConnection },
  { name: "connection reset then original handle restored", replace: (current, t) => replaceConnection(current, t, true) }
];

for (const replacement of replacements) {
  test(`CORE-PWA08 stale heartbeat transaction rejection preserves complete replacement: ${replacement.name}`, async (t) => {
    const current = await prepared(t);
    const operation = current.stale.use.heartbeatTimerOwnership();
    await current.entered.promise;
    await replacement.replace(current, t);
    current.stale.use.startCompletionAlert({ id: "replacement-alert", phase: "long_break" });
    current.stale.use.setCompletionQueuedForTest("replacement-completion");
    const before = await observation(current);
    current.events.length = 0;
    current.release.resolve();
    await settle(current, operation);
    const after = await observation(current);
    receipts.push({ case: t.name, before, after, renewals: current.renewals, events: current.events });
    assert.equal(current.renewals[0].error?.name, "AccountOwnershipError");
    assert.equal(before.memory.sessionIdentityValidated, true);
    assert.equal(before.memory.bootstrapBlocked, false);
    assert.deepEqual(after, before);
    assert.deepEqual(current.events, []);
    await current.stale.use.heartbeatTimerOwnership();
    assert.equal(current.renewals.length, 2, "the old resource guard releases for an independently issued replacement tick");
    assert.equal(current.renewals[1].error, undefined);
  });
}

for (const replacement of replacements.slice(0, 3)) {
  test(`CORE-PWA08 delayed successful heartbeat has no replacement effects: ${replacement.name}`, async (t) => {
    const current = await prepared(t, "after transaction");
    const operation = current.stale.use.heartbeatTimerOwnership();
    await current.entered.promise;
    assert.equal(current.renewals[0].result, true);
    await replacement.replace(current, t);
    const before = await observation(current);
    current.events.length = 0;
    current.release.resolve();
    await settle(current, operation);
    const after = await observation(current);
    receipts.push({ case: t.name, before, after, renewals: current.renewals, events: current.events });
    assert.deepEqual(after, before);
    assert.deepEqual(current.events, []);
  });
}

test("CORE-PWA08 scheduled ticks join only the issuing renewal and never adopt replacement during its await", async (t) => {
  const current = await prepared(t);
  const issuer = current.stale.use.captureDatabaseContext();
  const nextTick = () => current.stale.use.heartbeatTimerOwnership(issuer);
  const operation = nextTick();
  await current.entered.promise;
  const joined = nextTick();
  await keepRemote(current, accountUser("account-B"));
  const staleJoin = nextTick();
  const independentJoin = current.stale.use.heartbeatTimerOwnership();
  const before = await observation(current);
  current.events.length = 0;
  current.release.resolve();
  await settle(current, operation);
  await Promise.all([joined, staleJoin, independentJoin]);
  await nextTick();
  const after = await observation(current);
  receipts.push({ case: t.name, before, after, renewals: current.renewals, events: current.events });
  assert.equal(current.renewals.length, 1);
  assert.deepEqual(after, before);
  assert.deepEqual(current.events, []);
  await current.stale.use.heartbeatTimerOwnership();
  assert.equal(current.renewals.length, 2);
});

test("CORE-PWA08 replacement before dispatched heartbeat starts prevents even a renewal transaction", async (t) => {
  const current = await prepared(t);
  const operation = current.stale.use.heartbeatTimerOwnership();
  current.stale.state.user = accountUser("account-B");
  current.stale.state.localOwnerId = sync.accountOwnerId(current.stale.state.user);
  const before = await observation(current);
  current.events.length = 0;
  await operation;
  for (let index = 0; index < 12; index += 1) await new Promise(setImmediate);
  const after = await observation(current);
  receipts.push({ case: t.name, before, after, renewals: current.renewals, events: current.events });
  assert.deepEqual(current.renewals, []);
  assert.deepEqual(after, before);
  assert.deepEqual(current.events, []);
});

for (const lease of ["missing", "expired peer", "current tab"]) {
  test(`CORE-PWA08 normal same-account ${lease} lease renews and continues on next tick`, async (t) => {
    const current = await prepared(t);
    const database = current.stale.use.database();
    if (lease !== "missing") await seedMeta(database, { timerOwner: { timerId: "shared-timer", deviceId: "shared-device",
      tabId: lease === "current tab" ? current.stale.use.tabId() : "peer-tab",
      leaseExpiresAtMs: lease === "current tab" ? nowMs + 10000 : nowMs - 1 } });
    const before = await observation(current);
    const operation = current.stale.use.heartbeatTimerOwnership();
    await current.entered.promise;
    current.release.resolve();
    await settle(current, operation);
    const first = await observation(current);
    t.mock.timers.setTime(nowMs + 15000);
    await current.stale.use.heartbeatTimerOwnership();
    const after = await observation(current);
    receipts.push({ case: t.name, before, first, after, renewals: current.renewals, events: current.events });
    assert.deepEqual(first.memory, before.memory);
    assert.deepEqual(after.memory, before.memory);
    const withoutOwner = (records) => ({ ...records, meta: records.meta.filter((row) => row.key !== "timerOwner") });
    assert.deepEqual(withoutOwner(first.persisted), withoutOwner(before.persisted));
    assert.deepEqual(withoutOwner(after.persisted), withoutOwner(before.persisted));
    assert.equal(current.renewals.length, 2);
    assert.equal(current.renewals.every((renewal) => renewal.result === true), true);
    const owner = after.persisted.meta.find((row) => row.key === "timerOwner").value;
    assert.deepEqual(owner, { timerId: "shared-timer", deviceId: "shared-device", tabId: current.stale.use.tabId(), leaseExpiresAtMs: nowMs + 75000 });
    assert.deepEqual(current.events, []);
  });
}

test("CORE-PWA08 current issuer ownership rejection still quarantines only its own memory", async (t) => {
  const current = await prepared(t);
  const operation = current.stale.use.heartbeatTimerOwnership();
  await current.entered.promise;
  await keepRemote({ ...current, stale: current.peer }, accountUser("account-B"));
  const before = await observation(current);
  current.events.length = 0;
  current.release.resolve();
  await settle(current, operation);
  const after = await observation(current);
  receipts.push({ case: t.name, before, after, renewals: current.renewals, events: current.events });
  assert.deepEqual(after.persisted, before.persisted);
  assert.equal(after.memory.bootstrapBlocked, true);
  assert.equal(after.memory.sessionIdentityValidated, false);
  assert.ok(after.memory.quarantinedLocal);
  assert.equal(current.events.some((event) => event.kind === "queueSessionRevalidation"), true);
  assert.equal(current.events.some((event) => event.kind === "report"), false);
});

function failRenewalWrites(t, current) {
  const database = current.stale.use.database();
  const transaction = database.transaction.bind(database);
  database.transaction = (...args) => {
    const currentTransaction = transaction(...args);
    const objectStore = currentTransaction.objectStore.bind(currentTransaction);
    currentTransaction.objectStore = (name) => {
      const store = objectStore(name);
      if (name === "meta" && currentTransaction.mode === "readwrite") store.put = () => { throw new Error("Injected renewal write failure"); };
      return store;
    };
    return currentTransaction;
  };
  t.after(() => { database.transaction = transaction; });
  return () => { database.transaction = transaction; };
}

for (const replacement of replacements.slice(0, 3)) {
  test(`CORE-PWA08 delayed real transaction failure does not report replacement: ${replacement.name}`, async (t) => {
    const current = await prepared(t, "after rejection");
    const restore = failRenewalWrites(t, current);
    const operation = current.stale.use.heartbeatTimerOwnership();
    await current.entered.promise;
    assert.equal(current.renewals[0].error?.message, "Injected renewal write failure");
    restore();
    await replacement.replace(current, t);
    const before = await observation(current);
    current.events.length = 0;
    current.release.resolve();
    await settle(current, operation);
    const after = await observation(current);
    receipts.push({ case: t.name, before, after, renewals: current.renewals, events: current.events });
    assert.deepEqual(after, before);
    assert.deepEqual(current.events, []);
  });
}

test("CORE-PWA08 current transaction failure reports once, preserves memory, and releases the renewal guard", async (t) => {
  const current = await prepared(t);
  const restore = failRenewalWrites(t, current);
  const database = current.stale.use.database();
  const before = await observation(current);
  const operation = current.stale.use.heartbeatTimerOwnership();
  await current.entered.promise;
  current.release.resolve();
  await settle(current, operation);
  const after = await observation(current);
  receipts.push({ case: t.name, before, after, renewals: current.renewals, events: current.events });
  assert.deepEqual(after, before);
  assert.deepEqual(current.events.map((event) => event.kind), ["warn", "report"]);
  assert.equal(current.events[1].operation, "actions.timer-ownership.renewal-failed");
  restore();
  await current.stale.use.heartbeatTimerOwnership();
  await dump(database);
  for (let index = 0; index < 12; index += 1) await new Promise(setImmediate);
  assert.equal(current.renewals[1].result, true);
});
