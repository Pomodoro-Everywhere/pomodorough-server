"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { JSDOM } = require("jsdom");
const { IDBFactory } = require("fake-indexeddb");
const { accountUser, ownerId } = require("./test/incarnation-fixture.js");
const { seedMeta, dump, deferred, snapshot } = require("./test/account-ownership-fixture.js");
const receipts = [];
const marker = "pomodoroughPendingLogout";
const companion = "pomodoroughPendingLogoutOwner";
const scripts = ["shared-core-metadata.js", "shared-core.js", "sync-core.js", "sync-authority.js", "sync-storage-uuid.js",
  "workspace-core.js", "workspace-transaction.js", "sync-storage.js", "app-runtime.js", "account-operation.js", "app-state.js",
  "app-storage.js", "app-actions.js", "app-sync.js", "app-bootstrap.js", "app-session.js", "app-view.js", "app.js"];

function source(name) {
  const baseline = process.env.CORE_PWA03_STARTUP_BASELINE;
  const frozen = baseline && path.join(baseline, name);
  return fs.readFileSync(frozen && fs.existsSync(frozen) ? frozen : path.join(__dirname, name), "utf8");
}

test.after(() => {
  if (process.env.CORE_PWA03_STARTUP_EVIDENCE) fs.writeFileSync(process.env.CORE_PWA03_STARTUP_EVIDENCE,
    JSON.stringify({ provenance: require("./shared-core-metadata.js"), cases: receipts }, null, 2));
});

function installEvents(window, operations) {
  const add = window.addEventListener.bind(window);
  window.addEventListener = (type, callback, ...args) => add(type, (event) => {
    const result = callback(event);
    if (result?.then) operations.push(Promise.resolve(result));
  }, ...args);
  const button = window.document.getElementById("logoutRecoveryRetry");
  const listen = button.addEventListener.bind(button);
  button.addEventListener = (type, callback, ...args) => listen(type, (event) => {
    const result = callback(event);
    if (result?.then) operations.push(Promise.resolve(result));
  }, ...args);
}

async function prepared(t, failures = 1, pending = true) {
  const dom = new JSDOM(source("app.html"), { url: "https://local.test/app", runScripts: "outside-only" });
  const { window } = dom;
  t.after(() => dom.window.close());
  let online = false;
  Object.defineProperty(window.navigator, "onLine", { get: () => online });
  Object.defineProperty(window, "crypto", { value: crypto.webcrypto });
  Object.assign(window, { indexedDB: new IDBFactory(), TextEncoder, TextDecoder, structuredClone,
    PomodoroughAppTest: { disableAutoStart: true }, confirm: () => true, setInterval: () => 1, clearInterval() {} });
  const redirects = [];
  const operations = [];
  const requests = [];
  const warnings = [];
  window.console.warn = (...args) => warnings.push(args.map(String));
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  installEvents(window, operations);
  for (const name of scripts.slice(0, -1)) window.eval(source(name));
  const bytes = fs.readFileSync(path.join(__dirname, "pomodorough_core.wasm"));
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), require("./shared-core-metadata.js").sha256);
  const core = await window.PomodoroughSharedCore.SharedCore.fromBytes(bytes);
  const control = { failures, loads: 0, pause: null, revoked: false, status: 204 };
  const originalStorage = window.PomodoroughStorage;
  window.PomodoroughStorage = { ...originalStorage, guardedMutation: async (...args) => {
    if (control.cleanupPause && control.force401 && requests.some((request) => request.url === "/api/v1/me")
      && args[1].length === 6 && !control.cleanupPaused) {
      control.cleanupPaused = true;
      control.cleanupEntered.resolve();
      await control.cleanupPause.promise;
    }
    return originalStorage.guardedMutation(...args);
  } };
  window.PomodoroughSharedCore.SharedCore.load = async () => {
    control.loads += 1;
    if (control.failures > 0) { control.failures -= 1; throw new Error("Mock Core load unavailable offline"); }
    if (control.pause) await control.pause.promise;
    return core;
  };
  window.fetch = async (url, input = {}) => {
    requests.push({ url, method: input.method || "GET", headers: { ...input.headers }, body: input.body });
    if (!online) throw new Error("Mock session offline");
    if (url === "/api/v1/me") {
      control.sessionEntered?.resolve();
      if (control.sessionPause) await control.sessionPause.promise;
      return control.revoked || control.force401 ? { ok: false, status: 401 }
        : { ok: true, status: 200, json: async () => ({ user: accountUser("account-A"), csrfToken: "mock-csrf" }) };
    }
    assert.equal(url, "/api/v1/auth/logout");
    assert.equal(input.headers["X-Pomodorough-Account-Incarnation"], accountUser("account-A").accountIncarnation);
    if (control.status === 204) control.revoked = true;
    return { ok: control.status === 204, status: control.status };
  };
  const runtime = window.PomodoroughAppRuntime.createRuntime;
  let application;
  window.PomodoroughAppRuntime = { ...window.PomodoroughAppRuntime, createRuntime: (input) => {
    input.externals.host.location = { assign: (url) => redirects.push(url) };
    const builder = runtime(input);
    return { install(browserModule) {
      if (browserModule.manifest.name !== "storage") return builder.install(browserModule);
      builder.install({ ...browserModule, create(dependencies) {
        const implementation = browserModule.create(dependencies);
        const clear = implementation.clearLocalData;
        return { ...implementation, clearLocalData: async (...args) => {
          const completed = await clear(...args);
          if (control.cleanupReturnPause && control.force401 && requests.some((request) => request.url === "/api/v1/me")) {
            control.cleanupReturned.resolve();
            await control.cleanupReturnPause.promise;
          }
          return completed;
        } };
      } });
    }, finalize() { application = builder.finalize(); return application; } };
  } };
  window.eval(source("app.js"));
  const use = application.facade(application.describe().flatMap((item) => item.provides));
  const database = await use.openDatabase();
  t.after(() => database.close());
  const operation = { id: "retained-duration", deviceId: "shared-device", ownerId: "old-tab", phase: "focus", durationMs: 1800000,
    occurredAt: new Date().toISOString(), hlcWallMs: Date.now(), hlcCounter: 0 };
  await seedMeta(database, { snapshot: snapshot("account-A"), deviceId: "shared-device", deviceSequence: 7,
    hlc: { wallMs: operation.hlcWallMs, counter: 0 }, settings: { selectedPhase: "focus", durationSyncBootstrapped: true,
      autoStartSyncBootstrapped: true, selectedTaskSyncBootstrapped: true },
    projectionPending: { commands: [], taskOperations: [], durationOperations: [operation], autoStartOperations: [], selectedTaskOperations: [] },
    deliveryProof: { commands: [], taskOperations: [], durationOperations: [operation.id], autoStartOperations: [], selectedTaskOperations: [] } });
  const transaction = database.transaction("pendingDurations", "readwrite");
  transaction.objectStore("pendingDurations").put(operation);
  await window.PomodoroughStorage.transactionDone(transaction);
  if (pending) {
    window.localStorage.setItem(marker, "1");
    window.localStorage.setItem(companion, JSON.stringify({ userId: ownerId("account-A") }));
  }
  return { dom, window, use, core, database, control, operations, requests, warnings, redirects,
    state: application.state, online(value) { online = value; } };
}

function observed(current) {
  const document = current.window.document;
  return { ready: current.state.ready, required: current.state.logoutRecoveryRequired, busy: current.state.logoutRecoveryBusy,
    recoveryHidden: document.getElementById("logoutRecovery").hidden,
    dialogOpen: document.getElementById("bootstrapDialog").open,
    retryDisabled: document.getElementById("logoutRecoveryRetry").disabled,
    marker: current.window.localStorage.getItem(marker), companion: current.window.localStorage.getItem(companion),
    loads: current.control.loads, requests: structuredClone(current.requests), user: structuredClone(current.state.user),
    redirects: structuredClone(current.redirects) };
}

async function settle(current) {
  await Promise.all(current.operations.splice(0));
  for (let turn = 0; turn < 30; turn += 1) await new Promise(setImmediate);
}

test("CORE-PWA03 failed cold Core load exposes pending-logout recovery without any writer or session fetch", async (t) => {
  const current = await prepared(t);
  const before = await dump(current.database);
  await current.window.PomodoroughApp.initialize();
  const after = await dump(current.database);
  const state = observed(current);
  receipts.push({ case: t.name, before, after, state });
  assert.deepEqual(after, before);
  assert.equal(state.ready, false);
  assert.equal(state.required, true);
  assert.equal(state.recoveryHidden, false);
  assert.equal(state.dialogOpen, true);
  assert.equal(state.retryDisabled, false);
  assert.equal(state.busy, false);
  assert.equal(state.loads, 1);
  assert.deepEqual(state.requests, []);
});

for (const event of ["online", "button"]) {
  test(`CORE-PWA03 actual ${event} event retries Core once then completes authorized cold logout`, async (t) => {
    const current = await prepared(t);
    await current.window.PomodoroughApp.initialize();
    const failed = observed(current);
    current.online(true);
    if (event === "online") current.window.dispatchEvent(new current.window.Event("online"));
    else current.window.document.getElementById("logoutRecoveryRetry").dispatchEvent(new current.window.MouseEvent("click", { bubbles: true }));
    await settle(current);
    const after = await dump(current.database);
    const state = observed(current);
    receipts.push({ case: t.name, failed, after, state });
    assert.equal(failed.required, true);
    assert.equal(failed.recoveryHidden, false);
    assert.equal(state.loads, 2);
    assert.equal(state.ready, true);
    assert.equal(state.busy, false);
    assert.equal(state.marker, null);
    assert.equal(state.companion, null);
    assert.equal(state.required, false);
    assert.equal(state.recoveryHidden, true);
    assert.deepEqual(after.pendingDurations, []);
    assert.deepEqual(state.requests.map((item) => item.url), ["/api/v1/me", "/api/v1/auth/logout"]);
  });
}

test("CORE-PWA03 concurrent actual events share one resumed startup and release busy state", async (t) => {
  const current = await prepared(t);
  await current.window.PomodoroughApp.initialize();
  const failed = observed(current);
  current.online(true);
  current.control.pause = deferred();
  current.window.dispatchEvent(new current.window.Event("online"));
  current.window.document.getElementById("logoutRecoveryRetry").dispatchEvent(new current.window.MouseEvent("click", { bubbles: true }));
  current.window.dispatchEvent(new current.window.Event("online"));
  await new Promise(setImmediate);
  const during = observed(current);
  current.control.pause.resolve();
  await settle(current);
  const state = observed(current);
  receipts.push({ case: t.name, failed, during, state, after: await dump(current.database) });
  assert.equal(failed.required, true);
  assert.equal(failed.recoveryHidden, false);
  assert.equal(during.loads, 2);
  assert.equal(during.busy, true);
  assert.equal(state.loads, 2);
  assert.equal(state.busy, false);
  assert.equal(state.marker, null);
  assert.equal(state.requests.filter((item) => item.url === "/api/v1/auth/logout").length, 1);
});

test("CORE-PWA03 normal cold pending logout still loads once and retains marker while session is offline", async (t) => {
  const current = await prepared(t, 0);
  await current.window.PomodoroughApp.initialize();
  const state = observed(current);
  receipts.push({ case: t.name, state, after: await dump(current.database) });
  assert.equal(state.loads, 1);
  assert.equal(state.ready, true);
  assert.equal(state.required, true);
  assert.equal(state.recoveryHidden, false);
  assert.equal(state.marker, "1");
  assert.equal(state.busy, false);
});

test("CORE-PWA03 repeated unavailable Core retry stays visible and byte-exact until genuine third load", async (t) => {
  const current = await prepared(t, 2);
  const before = await dump(current.database);
  await current.window.PomodoroughApp.initialize();
  current.online(true);
  current.window.dispatchEvent(new current.window.Event("online"));
  await settle(current);
  const unavailable = observed(current);
  const afterFailure = await dump(current.database);
  current.window.document.getElementById("logoutRecoveryRetry").dispatchEvent(new current.window.MouseEvent("click", { bubbles: true }));
  await settle(current);
  const state = observed(current);
  receipts.push({ case: t.name, before, afterFailure, unavailable, state, after: await dump(current.database) });
  assert.equal(unavailable.loads, 2);
  assert.equal(unavailable.ready, false);
  assert.equal(unavailable.required, true);
  assert.equal(unavailable.busy, false);
  assert.equal(unavailable.recoveryHidden, false);
  assert.deepEqual(unavailable.requests, []);
  assert.deepEqual(afterFailure, before);
  assert.equal(state.loads, 3);
  assert.equal(state.ready, true);
  assert.equal(state.marker, null);
});

for (const change of ["marker", "account", "connection", "connection closes again"]) {
  test(`CORE-PWA03 Core-await startup issuer cannot adopt changed ${change}`, async (t) => {
    const current = await prepared(t);
    await current.window.PomodoroughApp.initialize();
    current.online(true);
    current.control.pause = deferred();
    current.window.dispatchEvent(new current.window.Event("online"));
    for (let turn = 0; current.control.loads < 2 && turn < 20; turn += 1) await new Promise(setImmediate);
    if (change === "marker") current.window.localStorage.setItem(companion, JSON.stringify({ userId: ownerId("account-B") }));
    if (change === "account") {
      current.state.user = accountUser("account-B");
      current.state.localOwnerId = ownerId("account-B");
    }
    if (change.startsWith("connection")) {
      const replacement = await current.use.openDatabase();
      current.use.setDatabaseForTest(replacement);
      t.after(() => replacement.close());
      if (change === "connection closes again") { replacement.close(); current.use.setDatabaseForTest(null); }
    }
    const input = current.window.document.querySelector('input[name="focus"]');
    input.value = "47";
    const before = await dump(current.database);
    const identity = { user: structuredClone(current.state.user), ownerId: current.state.localOwnerId,
      companion: current.window.localStorage.getItem(companion) };
    current.control.pause.resolve();
    await settle(current);
    const after = await dump(current.database);
    const state = observed(current);
    receipts.push({ case: t.name, before, after, identity, state, draft: input.value });
    assert.deepEqual(after, before);
    assert.deepEqual(state.requests, []);
    assert.deepEqual(state.redirects, []);
    assert.deepEqual(state.user, identity.user);
    assert.equal(state.companion, identity.companion);
    assert.equal(state.busy, false);
    assert.equal(input.value, "47", "stale startup finalizer never renders replacement context");
  });
}

test("CORE-PWA03 available Core retry cannot bypass corrupt raw context or retire pending marker", async (t) => {
  const current = await prepared(t);
  await current.window.PomodoroughApp.initialize();
  const corrupt = { commands: "corrupt", taskOperations: [], durationOperations: [], autoStartOperations: [],
    selectedTaskOperations: [], unexpected: { preserve: true } };
  await seedMeta(current.database, { projectionPending: corrupt });
  const before = await dump(current.database);
  current.online(true);
  current.window.dispatchEvent(new current.window.Event("online"));
  await settle(current);
  const after = await dump(current.database);
  const state = observed(current);
  receipts.push({ case: t.name, before, after, state, warnings: current.warnings });
  assert.deepEqual(after, before);
  assert.equal(state.loads, 2);
  assert.equal(state.ready, false);
  assert.equal(state.required, true);
  assert.equal(state.busy, false);
  assert.equal(state.recoveryHidden, false);
  assert.equal(state.retryDisabled, false);
  assert.equal(state.marker, "1");
  assert.equal(state.requests.some((item) => item.method !== "GET"), false);
  assert.deepEqual(state.redirects, []);
});

test("CORE-PWA03 normal cold offline owner without pending logout remains usable after one Core load", async (t) => {
  const current = await prepared(t, 0, false);
  await current.window.PomodoroughApp.initialize();
  const state = observed(current);
  const after = await dump(current.database);
  receipts.push({ case: t.name, state, after, offlineOwnerMode: current.state.offlineOwnerMode });
  assert.equal(state.loads, 1);
  assert.equal(state.ready, true);
  assert.equal(state.required, false);
  assert.equal(state.recoveryHidden, true);
  assert.equal(current.state.offlineOwnerMode, true);
  assert.equal(after.pendingDurations.length, 1);
});

test("CORE-PWA03 unavailable ordinary cold startup routes online through Core lifecycle before auth or writes", async (t) => {
  const current = await prepared(t, 1, false);
  const before = await dump(current.database);
  await current.window.PomodoroughApp.initialize();
  const first = observed(current);
  const afterFailure = await dump(current.database);
  current.online(false);
  current.window.dispatchEvent(new current.window.Event("online"));
  await settle(current);
  const state = observed(current);
  receipts.push({ case: t.name, before, afterFailure, first, state });
  assert.equal(first.ready, false);
  assert.deepEqual(first.requests, []);
  assert.deepEqual(afterFailure, before);
  assert.equal(state.loads, 2);
  assert.equal(state.ready, true);
});

test("CORE-PWA03 resumed startup retains logout scope across paused actual session request", async (t) => {
  const current = await prepared(t);
  await current.window.PomodoroughApp.initialize();
  current.online(true);
  current.control.sessionEntered = deferred();
  current.control.sessionPause = deferred();
  current.window.dispatchEvent(new current.window.Event("online"));
  await current.control.sessionEntered.promise;
  const replacement = await current.use.openDatabase();
  t.after(() => replacement.close());
  current.use.setDatabaseForTest(replacement);
  const at = Date.now();
  const row = { id: "new-duration", deviceId: "shared-device", phase: "focus", durationMs: 2820000,
    occurredAt: new Date(at).toISOString(), hlcWallMs: at, hlcCounter: 0 };
  await seedMeta(replacement, { snapshot: snapshot("account-A"), deviceId: "shared-device", hlc: { wallMs: at, counter: 0 } });
  const transaction = replacement.transaction("pendingDurations", "readwrite");
  transaction.objectStore("pendingDurations").put(row);
  await current.window.PomodoroughStorage.transactionDone(transaction);
  const input = current.window.document.querySelector('input[name="focus"]');
  input.value = "47";
  const before = await dump(current.database);
  current.control.sessionPause.resolve();
  await settle(current);
  const after = await dump(current.database);
  const state = observed(current);
  receipts.push({ case: t.name, before, after, state, draft: input.value });
  assert.deepEqual(after, before);
  assert.equal(state.marker, "1");
  assert.equal(state.busy, false);
  assert.deepEqual(state.requests.map((request) => request.url), ["/api/v1/me"]);
  assert.deepEqual(state.redirects, []);
  assert.equal(input.value, "47");
});

test("CORE-PWA03 unavailable revocation after Core retry retains visible marker recovery and releases busy", async (t) => {
  const current = await prepared(t);
  await current.window.PomodoroughApp.initialize();
  current.control.status = 503;
  current.online(true);
  current.window.document.getElementById("logoutRecoveryRetry").dispatchEvent(new current.window.MouseEvent("click", { bubbles: true }));
  await settle(current);
  const state = observed(current);
  const after = await dump(current.database);
  receipts.push({ case: t.name, state, after });
  assert.equal(state.loads, 2);
  assert.equal(state.ready, true);
  assert.equal(state.required, true);
  assert.equal(state.busy, false);
  assert.equal(state.recoveryHidden, false);
  assert.equal(state.retryDisabled, false);
  assert.equal(state.marker, "1");
  assert.deepEqual(state.redirects, []);
  assert.deepEqual(after.pendingDurations, []);
});

async function replace401Workspace(current, t, closeAgain = false) {
  const previous = current.use.database();
  if (previous) t.after(() => previous.close());
  current.use.setDatabaseForTest(null);
  const replacement = await current.use.openDatabase();
  t.after(() => replacement.close());
  current.use.setDatabaseForTest(replacement);
  const at = Date.now();
  const operation = { id: "replacement-47-minute-duration", deviceId: "shared-device", phase: "focus", durationMs: 2820000,
    ownerId: "replacement-tab", occurredAt: new Date(at).toISOString(), hlcWallMs: at, hlcCounter: 1 };
  const queues = { commands: [], taskOperations: [], durationOperations: [operation], autoStartOperations: [], selectedTaskOperations: [] };
  await seedMeta(replacement, { snapshot: snapshot("account-A"), deviceId: "shared-device", deviceSequence: 11,
    settings: { selectedPhase: "focus", retainedPreference: "new connection" }, hlc: { wallMs: at, counter: 1 },
    projectionPending: queues, deliveryProof: { ...queues, durationOperations: [operation.id] }, batchNextDomain: "selectedTaskOperations" });
  const transaction = replacement.transaction("pendingDurations", "readwrite");
  transaction.objectStore("pendingDurations").put(operation);
  await current.window.PomodoroughStorage.transactionDone(transaction);
  if (closeAgain) { replacement.close(); current.use.setDatabaseForTest(null); }
  current.window.document.querySelector('input[name="focus"]').value = "47";
}

test("CORE-PWA03 401 original issuer fences paused actual cleanup transaction against reopened same account", async (t) => {
  const current = await prepared(t);
  await current.window.PomodoroughApp.initialize();
  current.online(true);
  Object.assign(current.control, { force401: true, cleanupPause: deferred(), cleanupEntered: deferred() });
  t.after(() => current.control.cleanupPause.resolve());
  current.window.dispatchEvent(new current.window.Event("online"));
  await current.control.cleanupEntered.promise;
  await replace401Workspace(current, t);
  const before = await dump(current.database);
  const markers = [current.window.localStorage.getItem(marker), current.window.localStorage.getItem(companion)];
  current.control.cleanupPause.resolve();
  await settle(current);
  const after = await dump(current.database);
  const state = observed(current);
  const draft = current.window.document.querySelector('input[name="focus"]').value;
  receipts.push({ case: t.name, before, after, markers, state, draft });
  assert.deepEqual(after, before);
  assert.deepEqual([state.marker, state.companion], markers);
  assert.deepEqual(state.redirects, []);
  assert.deepEqual(state.requests.map((request) => request.url), ["/api/v1/me"]);
  assert.equal(state.busy, false);
  assert.equal(draft, "47");
});

for (const closeAgain of [false, true]) {
  test(`CORE-PWA03 401 checked close receipt prevents stale marker removal and redirect: closes again=${closeAgain}`, async (t) => {
    const current = await prepared(t);
    await current.window.PomodoroughApp.initialize();
    current.online(true);
    Object.assign(current.control, { force401: true, cleanupReturnPause: deferred(), cleanupReturned: deferred() });
    t.after(() => current.control.cleanupReturnPause.resolve());
    current.window.dispatchEvent(new current.window.Event("online"));
    await current.control.cleanupReturned.promise;
    await replace401Workspace(current, t, closeAgain);
    const before = await dump(current.database);
    current.control.cleanupReturnPause.resolve();
    await settle(current);
    const after = await dump(current.database);
    const state = observed(current);
    const draft = current.window.document.querySelector('input[name="focus"]').value;
    receipts.push({ case: t.name, before, after, state, draft });
    assert.deepEqual(after, before);
    assert.equal(state.marker, "1");
    assert.equal(state.companion, JSON.stringify({ userId: ownerId("account-A") }));
    assert.deepEqual(state.redirects, []);
    assert.equal(state.busy, false);
    assert.equal(draft, "47");
  });
}

test("CORE-PWA03 401 normal authorized close preserves recreated metadata and redirects exactly once", async (t) => {
  const current = await prepared(t);
  await current.window.PomodoroughApp.initialize();
  current.online(true);
  Object.assign(current.control, { force401: true, cleanupPause: deferred(), cleanupEntered: deferred() });
  current.window.dispatchEvent(new current.window.Event("online"));
  await current.control.cleanupEntered.promise;
  const recreated = await dump(current.database);
  current.control.cleanupPause.resolve();
  await settle(current);
  current.window.dispatchEvent(new current.window.Event("online"));
  await settle(current);
  const after = await dump(current.database);
  const state = observed(current);
  receipts.push({ case: t.name, recreated, after, state });
  assert.deepEqual(after, recreated);
  assert.equal(state.marker, null);
  assert.equal(state.companion, null);
  assert.equal(state.redirects.length, 1);
  assert.equal(state.ready, true);
  assert.equal(state.busy, false);
});

for (const pending of [true, false]) {
  test(`CORE-PWA03 401 cleanup interface rejects missing or copied issuer before any persisted effect: pending=${pending}`, async (t) => {
    const current = await prepared(t, 0, pending);
    current.window.PomodoroughStorage.setSharedCore(current.core);
    const identity = current.use.cleanupIdentity();
    const issuer = current.use.captureDatabaseContext();
    const before = await dump(current.database);
    const outcomes = [];
    for (const method of ["clearPendingLogoutData", "clearLocalData"]) {
      for (const scope of [undefined, { ...issuer }]) {
        let failure;
        try { await current.use[method](identity, scope); }
        catch (error) { failure = { name: error.name, message: error.message }; }
        outcomes.push({ method, failure, after: await dump(current.database) });
      }
    }
    receipts.push({ case: t.name, before, outcomes, state: observed(current) });
    for (const outcome of outcomes) {
      assert.equal(outcome.failure?.name, "TypeError");
      assert.match(outcome.failure.message, /bound account operation context is required/);
      assert.deepEqual(outcome.after, before);
    }
  });
}

test("CORE-PWA03 401 source contracts require issuer for every pending cleanup production caller", () => {
  const session = source("app-session.js");
  const startup = source("app.js");
  assert.match(session, /async clearPendingLogoutData\(identity, issuer\)/);
  assert.doesNotMatch(session, /clearPendingLogoutData\(identity, issuer\s*=/);
  assert.match(session, /clearPendingLogoutData\(identity, context\)/);
  assert.match(session, /accountOperation\.requireBound\(cleanup\.context\)/);
  assert.match(startup, /call\(application, "clearPendingLogoutData", identity, context\)/);
  assert.equal([...session.matchAll(/\.clearPendingLogoutData\(/g)].length, 1);
  assert.equal([...startup.matchAll(/call\(application, "clearPendingLogoutData"/g)].length, 1);
  const repository = source("app-storage.js");
  const view = source("app-view.js");
  assert.match(repository, /async clearLocalData\(identity = this\.cleanupIdentity\(\), context\)/);
  assert.doesNotMatch(repository, /clearLocalData\([^\n]*context\s*=/);
  assert.doesNotMatch(session, /clearLocalData\([^\n]*(?:issuer\?|issuer\.database \?)/);
  assert.match(view, /clearLocalData\(undefined, context\)/);
  assert.match(view, /accountOperation\.isCurrent\(completed\)/);
  assert.equal([...session.matchAll(/\.clearLocalData\(\w+, (?:issuer|context)\)/g)].length, 3);
  assert.equal([...session.matchAll(/\.clearLocalData\(/g)].length, 3);
  assert.equal([...view.matchAll(/\.clearLocalData\(/g)].length, 1);
  assert.equal([...repository.matchAll(/return this\.clearLocalData\(/g)].length, 0);
  assert.match(repository, /assertAuthorizedCleanup\(identity, context\) \{\s*accountOperation\.requireBound\(context\)/);
  const production = fs.readdirSync(__dirname).filter((name) => name.endsWith(".js") && !name.endsWith(".test.js"))
    .map(source).join("\n");
  const writers = [...production.matchAll(/\.clearLocalData\(([^\n]*)\)/g)];
  assert.equal(writers.length, 4);
  for (const [, argumentsText] of writers) assert.match(argumentsText, /, (?:issuer|context)$/);
  assert.equal([...production.matchAll(/\.clearPendingLogoutData\(/g)].length, 1);
  assert.equal([...production.matchAll(/call\(application, "clearPendingLogoutData"/g)].length, 1);
  assert.equal([...production.matchAll(/call\(application, "clearLocalData"/g)].length, 0);
});
