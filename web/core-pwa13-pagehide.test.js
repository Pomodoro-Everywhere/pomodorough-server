"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const crypto = require("node:crypto");
const { JSDOM } = require("jsdom");
const accountOperation = require("./account-operation.js");
const { fixture, storage, sync, dump, seedMeta, snapshot, deferred, nowMs } = require("./test/account-ownership-fixture.js");
const { accountUser } = require("./test/incarnation-fixture.js");
const receipts = [];
const meta = (records, key) => records.meta.find((row) => row.key === key)?.value;

function viewModule() {
  if (!process.env.CORE_PWA13_BASELINE) return require("./app-view.js");
  const filename = path.join(__dirname, "app-view.js");
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(__dirname);
  loaded._compile(fs.readFileSync(path.join(process.env.CORE_PWA13_BASELINE, "web/app-view.js"), "utf8"), filename);
  return loaded.exports;
}

test.after(() => {
  if (process.env.CORE_PWA13_EVIDENCE) fs.writeFileSync(process.env.CORE_PWA13_EVIDENCE,
    JSON.stringify({ provenance: require("./shared-core-metadata.js"), cases: receipts }, null, 2));
});

function installEffects(t, client, events) {
  const host = client.external.host;
  for (const name of ["setTimeout", "clearTimeout", "setInterval", "clearInterval"]) {
    const original = host[name];
    host[name] = (...args) => {
      events.push({ kind: name, arguments: args.map((value) => typeof value === "function" ? "callback" : value) });
      return original(...args);
    };
  }
  host.Notification = class {
    static permission = "granted";
    constructor() { events.push({ kind: "notification" }); }
    close() { events.push({ kind: "closeNotification" }); }
  };
  host.console.warn = (...args) => events.push({ kind: "warn", arguments: args.map(String) });
  const previous = globalThis.PomodoroughSentryClient;
  globalThis.PomodoroughSentryClient = { reportFrontendError: (error, operation) =>
    events.push({ kind: "report", operation, error: { name: error.name, message: error.message } }) };
  t.after(() => {
    if (previous === undefined) delete globalThis.PomodoroughSentryClient;
    else globalThis.PomodoroughSentryClient = previous;
  });
  for (const name of ["scheduleSync", "queueSessionRevalidation", "stopCompletionAlert", "showNotice"]) {
    const original = client.use[name];
    client.use[name] = (...args) => { events.push({ kind: name }); return original(...args); };
  }
}

function installRelease(current, timing) {
  const { stale, entered, release, completed, releases } = current;
  stale.external.syncStorage = { ...storage, async releaseTimerOwnership(database, input) {
    const observation = { expectedUserId: input.expectedUserId, deviceId: input.deviceId, tabId: input.tabId,
      nowMs: input.nowMs, boundToOriginalDatabase: database === current.originalDatabase };
    const scope = current.scopes.find((context) => context.assertCurrent === input.assertCurrent);
    if (scope) accountOperation.requireBound(scope);
    observation.brandedGenerationScope = Boolean(scope && scope.database === database);
    releases.push(observation);
    const first = releases.length === 1;
    input.assertCurrent();
    if (first && timing === "before transaction") { entered.resolve(); await release.promise; }
    try {
      const result = await storage.releaseTimerOwnership(database, input);
      observation.returnedUndefined = result === undefined;
      if (first && timing === "after success") { entered.resolve(); await release.promise; }
      return result;
    } catch (error) {
      observation.error = { name: error.name, message: error.message };
      if (first && timing === "after rejection") { entered.resolve(); await release.promise; }
      throw error;
    } finally { if (first) completed.resolve(); }
  } };
}

async function prepared(t, timing = "before transaction") {
  const current = await fixture(t, "running");
  const bytes = fs.readFileSync(path.join(__dirname, "pomodorough_core.wasm"));
  assert.equal(current.core.call("core.version", {}).coreVersion, "0.47.0");
  assert.equal(bytes.length, 2790028);
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), "45501a8ae1dbce441c7b21c1a3862c00c69215ffd59a1754e8ca972224f3fbc3");
  Object.assign(current, { entered: deferred(), release: deferred(), completed: deferred(), releases: [], events: [], scopes: [],
    originalDatabase: current.stale.use.database() });
  const capture = current.stale.use.captureDatabaseContext;
  current.stale.use.captureDatabaseContext = () => {
    const scope = capture();
    accountOperation.requireBound(scope);
    current.scopes.push(scope);
    return scope;
  };
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "app.html"), "utf8"), { url: "https://local.test/app" });
  t.after(() => { current.release.resolve(); dom.window.close(); current.originalDatabase.close(); });
  const { document } = dom.window;
  const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
  for (const [name, selector] of Object.entries({ phaseButtons: ".phase-button", durationInputs: ".stepper input",
    stepButtons: "[data-step]", bootstrapChoiceButtons: "[data-bootstrap-strategy]", screenButtons: "[data-screen-button]" })) {
    elements[name] = [...document.querySelectorAll(selector)];
  }
  Object.assign(current.stale.external.host, { document, localStorage: dom.window.localStorage,
    addEventListener: dom.window.addEventListener.bind(dom.window) });
  Object.assign(current, { dom, elements });
  current.stale.external.elements = elements;
  installEffects(t, current.stale, current.events);
  installRelease(current, timing);
  const view = viewModule().create({ state: current.stale.state, external: current.stale.external, use: current.stale.use });
  for (const name of ["render", "renderTimer", "renderSyncStatus", "renderDurations", "renderTaskSelector", "renderBootstrapDialog"]) {
    current.stale.use[name] = (...args) => { current.events.push({ kind: name }); return view[name](...args); };
  }
  current.view = view;
  view.setupConnectivityEvents();
  await seedMeta(current.originalDatabase, { timerOwner: { timerId: "shared-timer", deviceId: "shared-device",
    tabId: current.stale.use.tabId(), leaseExpiresAtMs: nowMs + 60000 } });
  view.render();
  return current;
}

function pagehide(current) {
  current.dom.window.dispatchEvent(new current.dom.window.PageTransitionEvent("pagehide", { persisted: true }));
}

async function settle(current) {
  await current.completed.promise;
  for (let turn = 0; turn < 12; turn += 1) await new Promise(setImmediate);
}

async function observation(current) {
  const { stale, dom, elements } = current;
  return { persisted: await dump(stale.use.database()), memory: structuredClone(stale.state),
    dom: dom.window.document.documentElement.outerHTML,
    flags: Object.fromEntries(["timerToggle", "finishButton", "cancelButton", "clearButton", "profile", "bootstrapDialog"].map((name) =>
      [name, { disabled: elements[name].disabled ?? null, hidden: elements[name].hidden, open: elements[name].open ?? null }])),
    inputs: [...dom.window.document.querySelectorAll("input, select")].map((element) =>
      ({ id: element.id, value: element.value, checked: element.checked ?? null, disabled: element.disabled })),
    activeElement: dom.window.document.activeElement.id, controlsBlocked: stale.use.controlsBlocked(),
    alertTimerId: stale.use.activeCompletionAlertTimerId(), completionQueued: stale.use.completionQueuedForTest(),
    scheduledCallbacks: stale.callbacks.map((item) => ({ delay: item.delay })),
    logoutMarker: dom.window.localStorage.getItem("pomodoroughPendingLogout") };
}

async function keepRemote(current, replacement, restoreMemory = true) {
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
  if (!restoreMemory) return;
  current.stale.state.user = replacement;
  current.stale.state.localOwnerId = sync.accountOwnerId(replacement);
  await current.stale.use.reloadPersistedState();
}

async function replaceConnection(current, t, kind) {
  const { stale, originalDatabase } = current;
  stale.use.setDatabaseForTest(null);
  if (kind === "close/reopen") originalDatabase.close();
  const opened = await stale.use.openDatabase();
  t.after(() => opened.close());
  stale.use.setDatabaseForTest(opened);
  if (kind === "restore original handle") stale.use.setDatabaseForTest(originalDatabase);
  await seedMeta(stale.use.database(), { snapshot: { ...snapshot("account-A", "running"),
    canonicalTimer: { ...snapshot("account-A", "running").canonicalTimer, id: "replacement-private-timer" } },
    timerOwner: { timerId: "replacement-private-timer", deviceId: "shared-device", tabId: stale.use.tabId(),
      leaseExpiresAtMs: nowMs + 47000 } });
  await stale.use.reloadPersistedState();
}

async function prepareReplacement(current) {
  const { stale, core, view, elements } = current;
  const task = core.taskIdentity({ title: "Replacement private task" });
  await stale.use.persistTaskOperation("upsert", task);
  await stale.use.persistDurationOperation("focus", 1800000);
  await stale.use.persistAutoStartOperation(false);
  await stale.use.persistSelectedTaskOperation(task.id);
  await seedMeta(stale.use.database(), { timerOwner: { timerId: stale.state.timer.id, deviceId: "shared-device",
    tabId: stale.use.tabId(), leaseExpiresAtMs: nowMs + 47000 } });
  view.render();
  stale.use.startCompletionAlert({ id: "replacement-alert", phase: "long_break" });
  stale.use.setCompletionQueuedForTest("replacement-completion");
  stale.use.scheduleCompletionRetry(stale.state.timer.id, { reason: "not_owner", retryAtMs: nowMs + 47000 });
  elements.durationInputs.find((input) => input.name === "focus").value = "47";
  elements.taskInput.value = "Replacement draft";
  elements.taskInput.focus();
}

function abortReleaseWrite(t, current) {
  const database = current.stale.use.database();
  const transaction = database.transaction.bind(database);
  const wrapped = new WeakSet();
  database.transaction = (...args) => {
    const currentTransaction = transaction(...args);
    const objectStore = currentTransaction.objectStore.bind(currentTransaction);
    currentTransaction.objectStore = (name) => {
      const store = objectStore(name);
      if (name !== "meta" || currentTransaction.mode !== "readwrite" || wrapped.has(store)) return store;
      wrapped.add(store);
      const put = store.put.bind(store);
      store.put = (row) => {
        const request = put(row);
        if (row.key === "timerOwner") currentTransaction.abort();
        return request;
      };
      return store;
    };
    return currentTransaction;
  };
  const restore = () => { database.transaction = transaction; };
  t.after(restore);
  return restore;
}

const replacements = [
  { name: "different account", replace: (current) => keepRemote(current, accountUser("account-B")) },
  { name: "same public ID/new incarnation", replace: (current) => keepRemote(current, accountUser("account-A", 2)) },
  { name: "same account/new connection scope", replace: (current, t) => replaceConnection(current, t, "new connection") },
  { name: "same account/close-reopen", replace: (current, t) => replaceConnection(current, t, "close/reopen") },
  { name: "generation reset/original handle restored", replace: (current, t) => replaceConnection(current, t, "restore original handle") }
];

for (const timing of ["before transaction", "after rejection", "after success"]) {
  for (const replacement of replacements) {
    test(`CORE-PWA13 DOM pagehide ${timing} preserves complete replacement: ${replacement.name}`, async (t) => {
      const current = await prepared(t, timing);
      const restore = timing === "after rejection" ? abortReleaseWrite(t, current) : () => {};
      pagehide(current);
      await current.entered.promise;
      restore();
      if (timing === "after success") assert.equal(current.releases[0].returnedUndefined, true);
      await replacement.replace(current, t);
      await prepareReplacement(current);
      const before = await observation(current);
      current.events.length = 0;
      current.release.resolve();
      await settle(current);
      const after = await observation(current);
      receipts.push({ case: t.name, before, after, releases: current.releases, events: current.events });
      assert.equal(current.releases.length, 1);
      assert.equal(current.releases[0].boundToOriginalDatabase, true);
      assert.equal(before.memory.sessionIdentityValidated, true);
      assert.equal(before.controlsBlocked, false);
      assert.deepEqual(after, before);
      assert.deepEqual(current.events, []);
      if (timing === "before transaction") assert.equal(current.releases[0].error?.name,
        replacement.name.includes("close-reopen") ? "InvalidStateError" : "AccountOwnershipError");
      if (timing === "after rejection") assert.equal(current.releases[0].error.message, "Storage transaction aborted.");
    });
  }
}

test("CORE-PWA13 current issuer storage mismatch still quarantines only issuing memory", async (t) => {
  const current = await prepared(t);
  pagehide(current);
  await current.entered.promise;
  await keepRemote(current, accountUser("account-B"), false);
  const before = await observation(current);
  current.events.length = 0;
  current.release.resolve();
  await settle(current);
  const after = await observation(current);
  receipts.push({ case: t.name, before, after, releases: current.releases, events: current.events });
  assert.equal(current.releases[0].error.name, "AccountOwnershipError");
  assert.deepEqual(after.persisted, before.persisted);
  assert.equal(after.memory.sessionIdentityValidated, false);
  assert.equal(after.memory.bootstrapBlocked, true);
  assert.ok(after.memory.quarantinedLocal);
  assert.equal(current.events.filter((event) => event.kind === "queueSessionRevalidation").length, 1);
  assert.equal(current.events.some((event) => ["warn", "report"].includes(event.kind)), false);
});

test("CORE-PWA13 current ordinary release failure reports once and a later DOM event releases normally", async (t) => {
  const current = await prepared(t, "after rejection");
  const restore = abortReleaseWrite(t, current);
  const before = await observation(current);
  current.events.length = 0;
  pagehide(current);
  await current.entered.promise;
  restore(); current.release.resolve();
  await settle(current);
  const after = await observation(current);
  receipts.push({ case: t.name, before, after, releases: current.releases, events: structuredClone(current.events) });
  assert.deepEqual(after, before);
  assert.deepEqual(current.events.map((event) => event.kind), ["warn", "report"]);
  assert.equal(current.events[1].operation, "view.timer-ownership.release-failed");
  current.events.length = 0;
  pagehide(current);
  await new Promise(setImmediate);
  await dump(current.stale.use.database());
  assert.equal(current.releases.length, 2);
  assert.equal(current.releases[1].returnedUndefined, true);
  assert.equal(meta(await dump(current.stale.use.database()), "timerOwner").leaseExpiresAtMs, nowMs);
  assert.deepEqual(current.events, []);
});

for (const tab of ["current tab", "peer tab"]) {
  test(`CORE-PWA13 normal DOM pagehide preserves release policy and undefined return: ${tab}`, async (t) => {
    const current = await prepared(t, "after success");
    if (tab === "peer tab") await seedMeta(current.stale.use.database(), { timerOwner: {
      timerId: "shared-timer", deviceId: "shared-device", tabId: "peer-tab", leaseExpiresAtMs: nowMs + 60000 } });
    const before = await observation(current);
    current.events.length = 0;
    pagehide(current);
    await current.entered.promise;
    current.release.resolve(); await settle(current);
    const after = await observation(current);
    receipts.push({ case: t.name, before, after, releases: current.releases, events: current.events });
    const expected = structuredClone(before);
    if (tab === "current tab") meta(expected.persisted, "timerOwner").leaseExpiresAtMs = nowMs;
    assert.deepEqual(after, expected);
    assert.equal(current.releases[0].returnedUndefined, true);
    assert.deepEqual(current.events, []);
  });
}

test("CORE-PWA13 reporting rechecks issuer after a reentrant warning replaces identity", async (t) => {
  const current = await prepared(t, "after rejection");
  const restore = abortReleaseWrite(t, current);
  pagehide(current); await current.entered.promise; restore();
  const warn = current.stale.external.host.console.warn;
  current.stale.external.host.console.warn = (...args) => {
    warn(...args);
    current.stale.state.user = accountUser("account-B");
    current.stale.state.localOwnerId = sync.accountOwnerId(current.stale.state.user);
  };
  current.events.length = 0;
  current.release.resolve(); await settle(current);
  receipts.push({ case: t.name, after: await observation(current), releases: current.releases, events: current.events });
  assert.deepEqual(current.events.map((event) => event.kind), ["warn"]);
  assert.equal(current.stale.state.sessionIdentityValidated, true);
});

test("CORE-PWA13 pagehide with no connection or device starts no release", async (t) => {
  const current = await prepared(t);
  current.stale.use.setDatabaseForTest(null); pagehide(current);
  current.stale.use.setDatabaseForTest(current.originalDatabase);
  current.stale.state.deviceId = null; pagehide(current);
  assert.deepEqual(current.releases, []);
  receipts.push({ case: t.name, releases: current.releases });
});
