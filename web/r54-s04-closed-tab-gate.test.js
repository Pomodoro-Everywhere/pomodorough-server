"use strict";

// R54-S04: a tab in deferred-logout recovery must not leave the bootstrap gate
// behind. Recovery clears local data and closes its database before it retries
// the revocation, so a tab closed in that wait cannot release anything on
// pagehide. Every other tab then showed "Checking history" until the 5-minute
// lease expired.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { JSDOM } = require("jsdom");
const { IDBFactory } = require("fake-indexeddb");
const { accountUser, ownerId } = require("./test/incarnation-fixture.js");
const { nowMs, seedMeta, snapshot } = require("./test/account-ownership-fixture.js");
const appStorage = require("./app-storage.js");

const scripts = ["shared-core-metadata.js", "shared-core.js", "sync-core.js", "sync-authority.js", "sync-storage-uuid.js",
  "workspace-core.js", "workspace-transaction.js", "sync-storage.js", "app-runtime.js", "account-operation.js", "app-state.js",
  "app-storage.js", "app-actions.js", "app-sync.js", "app-bootstrap.js", "app-session.js", "app-view.js", "app.js"];
const sources = new Map(scripts.concat("app.html").map((name) => [name, fs.readFileSync(path.join(__dirname, name), "utf8")]));
let core = null;

async function sharedCore(window) {
  if (core) return core;
  const bytes = fs.readFileSync(path.join(__dirname, "pomodorough_core.wasm"));
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), require("./shared-core-metadata.js").sha256);
  core = await window.PomodoroughSharedCore.SharedCore.fromBytes(bytes);
  return core;
}

function pendingMarker(account) {
  return { pomodoroughPendingLogout: "1", pomodoroughPendingLogoutOwner: JSON.stringify({ userId: ownerId(account) }) };
}

// The server's history for an account with no history yet.
function remoteHistory(account) {
  const payload = { ...snapshot(account), revision: 0, accountIncarnation: accountUser(account).accountIncarnation,
    serverHlcWallMs: nowMs, serverHlcCounter: 0, acknowledgements: [], taskAcknowledgements: [],
    durationAcknowledgements: [], autoStartAcknowledgements: [], selectedTaskAcknowledgements: [] };
  delete payload.user;
  return payload;
}

function serve(control, account, csrf) {
  return async (url, input = {}) => {
    control.requests.push({ url, method: input.method || "GET" });
    if (url === "/api/v1/me") {
      if (control.meStatus !== 200) return { ok: false, status: control.meStatus };
      return { ok: true, status: 200, json: async () => ({ user: accountUser(account), csrfToken: csrf }) };
    }
    if (url === "/api/v1/auth/logout") return { ok: control.logoutStatus === 204, status: control.logoutStatus };
    if (url === "/api/v1/bootstrap") return { ok: true, status: 200, json: async () => remoteHistory(account) };
    return { ok: false, status: 503 };
  };
}

// Starts the real PWA in one tab. `indexedDB` carries one browser's database
// across tabs; `storage` seeds this tab's view of localStorage; `prepare` runs
// before the app starts.
async function openTab(t, { indexedDB, storage = {}, account = "account-A", csrf = "csrf-S1", meStatus = 200,
  logoutStatus = 204, prepare = () => {} }) {
  const dom = new JSDOM(sources.get("app.html"), { url: "https://local.test/app", runScripts: "outside-only" });
  const { window } = dom;
  t.after(() => window.close());
  Object.defineProperty(window.navigator, "onLine", { get: () => true });
  Object.defineProperty(window, "crypto", { value: crypto.webcrypto });
  Object.assign(window, { indexedDB, TextEncoder, TextDecoder, structuredClone,
    PomodoroughAppTest: { disableAutoStart: true }, confirm: () => true, setInterval: () => 1, clearInterval() {} });
  const warnings = [];
  const reports = [];
  window.console.warn = (message, error) => warnings.push([message, error]);
  window.PomodoroughSentryClient = { reportFrontendError: (error, operation) => reports.push([error, operation]) };
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
  for (const name of scripts.slice(0, -1)) window.eval(sources.get(name));
  const loaded = await sharedCore(window);
  window.PomodoroughSharedCore.SharedCore.load = async () => loaded;
  const runtime = window.PomodoroughAppRuntime.createRuntime;
  window.PomodoroughAppRuntime = { ...window.PomodoroughAppRuntime, createRuntime: (input) => {
    input.externals.host.location = { href: window.location.href, pathname: "/app", search: "", assign() {}, replace() {} };
    return runtime(input);
  } };
  const control = { requests: [], meStatus, logoutStatus };
  window.fetch = serve(control, account, csrf);
  prepare(window);
  window.eval(sources.get("app.js"));
  await window.PomodoroughApp.initialize();
  await settle();
  return { window, control, warnings, reports, state: window.PomodoroughAppTest.state };
}

async function seedAccount(indexedDB, account) {
  const database = await openDatabase(indexedDB);
  await seedMeta(database, { snapshot: snapshot(account), deviceId: "shared-device", deviceSequence: 7 });
  database.close();
}

// Opens the PWA database the way the app does, creating its stores when new.
function openDatabase(indexedDB) {
  const { DB_NAME, DB_VERSION, META_STORE, ...names } = appStorage;
  const queues = Object.entries(names).filter(([name]) => name.endsWith("_STORE")).map(([, store]) => store);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(META_STORE, { keyPath: "key" });
      for (const store of queues) request.result.createObjectStore(store, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storedGate(indexedDB) {
  const database = await openDatabase(indexedDB);
  try {
    const request = database.transaction("meta", "readonly").objectStore("meta").get("bootstrapGate");
    return await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result?.value ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally { database.close(); }
}

function closeTab(tab) {
  tab.window.dispatchEvent(new tab.window.PageTransitionEvent("pagehide", { persisted: false }));
  tab.window.close();
}

function syncLabel(tab) {
  return tab.window.document.getElementById("syncStatusText").textContent.trim();
}

function gateReleaseFailures(tab) {
  return tab.warnings.filter(([message]) => message === "Pomodorough recovery gate release failed:");
}

function requested(tab, url) {
  return tab.control.requests.filter((request) => request.url === url).length;
}

async function settle() {
  for (let turn = 0; turn < 30; turn += 1) await new Promise(setImmediate);
}

// The marker stays and the revoke fails, so the tab clears local data and
// waits in recovery with its database closed. `seeded` keeps the signed-out
// workspace for the tab to clear; otherwise the sign-out already cleared it.
async function recoveringTab(t, indexedDB, seeded = true) {
  if (seeded) await seedAccount(indexedDB, "account-A");
  const tab = await openTab(t, { indexedDB, storage: pendingMarker("account-A"), logoutStatus: 503 });
  assert.equal(tab.state.logoutRecoveryRequired, true);
  assert.equal(requested(tab, "/api/v1/auth/logout"), 1);
  assert.equal(tab.window.localStorage.getItem("pomodoroughPendingLogout"), "1");
  assert.deepEqual(gateReleaseFailures(tab), []);
  return tab;
}

for (const seeded of [true, false]) {
  test(`R54-S04 a tab closed during failing logout recovery leaves no bootstrap gate: ${seeded ? "seeded" : "empty"}`, async (t) => {
    const indexedDB = new IDBFactory();
    const recovering = await recoveringTab(t, indexedDB, seeded);
    closeTab(recovering);
    assert.equal(await storedGate(indexedDB), null, "a closed recovery tab must not keep the history gate");
  });
}

// The session check fails, so the tab waits in recovery with its database open
// and has not tried the revoke yet.
test("R54-S04 a tab closed while recovery cannot check the session leaves no bootstrap gate", async (t) => {
  const indexedDB = new IDBFactory();
  await seedAccount(indexedDB, "account-A");
  const recovering = await openTab(t, { indexedDB, storage: pendingMarker("account-A"), meStatus: 503, logoutStatus: 503 });
  assert.equal(recovering.state.logoutRecoveryRequired, true);
  assert.equal(requested(recovering, "/api/v1/auth/logout"), 0);
  assert.equal(recovering.window.localStorage.getItem("pomodoroughPendingLogout"), "1");
  assert.equal(recovering.state.bootstrapGateOwned, false, "the recovering tab must know it released the gate");
  assert.deepEqual(gateReleaseFailures(recovering), []);
  closeTab(recovering);
  assert.equal(await storedGate(indexedDB), null, "a closed recovery tab must not keep the history gate");
});

test("R54-S04 the next signed-in tab checks history at once after a recovery tab closes", async (t) => {
  const indexedDB = new IDBFactory();
  closeTab(await recoveringTab(t, indexedDB));
  // The re-sign-in landing already cleared the marker, so this tab starts signed in.
  const next = await openTab(t, { indexedDB, csrf: "csrf-S2" });
  assert.notEqual(syncLabel(next), "Checking history", "the next tab must not wait for the closed tab's lease");
  assert.equal(next.state.bootstrapGateOwned, true, "the next tab must own history resolution");
  assert.equal((await storedGate(indexedDB))?.token, next.state.tabId);
  assert.equal(requested(next, "/api/v1/bootstrap"), 1, "the next tab must ask the server for history");
});

// The sign-out already cleared the workspace while an open tab holds the gate.
// Recovery then either confirms the empty workspace after the session check,
// or waits because the session check failed.
for (const meStatus of [200, 503]) {
  test(`R54-S04 recovery keeps a live gate that another tab owns: session ${meStatus}`, async (t) => {
    const indexedDB = new IDBFactory();
    const database = await openDatabase(indexedDB);
    const now = Date.now();
    await seedMeta(database, { bootstrapGate: { token: "open-tab", acquiredAtMs: now, expiresAtMs: now + 300_000 } });
    database.close();
    const recovering = await openTab(t, { indexedDB, storage: pendingMarker("account-A"), meStatus, logoutStatus: 503 });
    assert.equal(recovering.state.logoutRecoveryRequired, true);
    assert.equal(recovering.state.bootstrapGateOwned, false);
    assert.deepEqual(gateReleaseFailures(recovering), []);
    closeTab(recovering);
    assert.equal((await storedGate(indexedDB))?.token, "open-tab", "recovery must not take another tab's gate");
  });
}

// A failed release leaves the gate to its lease, as before, and is reported
// with the deferred session start.
test("R54-S04 a failed recovery gate release is reported and keeps the tab in recovery", async (t) => {
  const indexedDB = new IDBFactory();
  await seedAccount(indexedDB, "account-A");
  const failure = new Error("gate store unavailable");
  const recovering = await openTab(t, { indexedDB, storage: pendingMarker("account-A"), meStatus: 503, logoutStatus: 503,
    prepare: (window) => {
      window.PomodoroughStorage = { ...window.PomodoroughStorage, clearBootstrapGate: async () => { throw failure; } };
    } });
  assert.equal(recovering.state.logoutRecoveryRequired, true);
  assert.equal(recovering.state.bootstrapGateOwned, true);
  assert.deepEqual(gateReleaseFailures(recovering).map(([, error]) => error), [failure]);
  assert.ok(recovering.reports.some(([error, operation]) => error === failure && operation === "session.initialize.deferred"));
  assert.equal((await storedGate(indexedDB))?.token, recovering.state.tabId);
});

// Replaces only the first gate release, which is the recovery release in these
// scenarios. `during` receives the real release and runs in its place.
function interceptFirstRelease(window, during) {
  const storage = window.PomodoroughStorage;
  let first = true;
  window.PomodoroughStorage = { ...storage, clearBootstrapGate: async (...args) => {
    if (!first) return storage.clearBootstrapGate(...args);
    first = false;
    return during(() => storage.clearBootstrapGate(...args));
  } };
}

// Stands in for a newer account context that validates a session in this tab
// while the recovery release awaits. JSDOM has no public path that interleaves
// that handoff deterministically, so the test publishes its result directly.
function newerSessionTakesOver(window) {
  Object.assign(window.PomodoroughAppTest.state, { user: accountUser("account-B"), authenticated: true,
    csrfToken: "csrf-B", sessionIdentityValidated: true });
}

function sessionDeferrals(tab) {
  return tab.warnings.filter(([message]) => message === "Pomodorough session deferred:");
}

// The release committed, but the context went stale before the tab recorded
// it. The newer context has acquired the gate again, so the stale release must
// leave the ownership flag and the session start to that context.
test("R54-S04 a stale recovery release leaves gate ownership to the newer context", async (t) => {
  const indexedDB = new IDBFactory();
  await seedAccount(indexedDB, "account-A");
  const recovering = await openTab(t, { indexedDB, storage: pendingMarker("account-A"), meStatus: 503, logoutStatus: 503,
    prepare: (window) => interceptFirstRelease(window, async (release) => {
      await release();
      newerSessionTakesOver(window);
      const database = await openDatabase(indexedDB);
      const now = Date.now();
      const token = window.PomodoroughAppTest.state.tabId;
      await seedMeta(database, { bootstrapGate: { token, acquiredAtMs: now, expiresAtMs: now + 300_000 } });
      database.close();
      window.PomodoroughAppTest.state.bootstrapGateOwned = true;
      return true;
    }) });
  assert.equal(recovering.state.bootstrapGateOwned, true, "a stale release must not clear the newer context's ownership");
  assert.equal((await storedGate(indexedDB))?.token, recovering.state.tabId);
  assert.equal(recovering.state.csrfToken, "csrf-B");
  assert.deepEqual(gateReleaseFailures(recovering), []);
  assert.deepEqual(sessionDeferrals(recovering), [], "a stale session start must not defer for the newer context");
  assert.deepEqual(recovering.reports, []);
});

// Another tab finishes signing in and clears the pending sign-out marker while
// this tab's release fails. The failure belongs to no current session.
test("R54-S04 a recovery release that fails after the sign-out marker changes stays silent", async (t) => {
  const indexedDB = new IDBFactory();
  await seedAccount(indexedDB, "account-A");
  const failure = new Error("gate store unavailable");
  let released = false;
  const recovering = await openTab(t, { indexedDB, storage: pendingMarker("account-A"), meStatus: 503, logoutStatus: 503,
    prepare: (window) => interceptFirstRelease(window, async () => {
      released = true;
      for (const key of Object.keys(pendingMarker("account-A"))) window.localStorage.removeItem(key);
      throw failure;
    }) });
  assert.ok(released, "the recovery release must run");
  assert.equal((await storedGate(indexedDB))?.token, recovering.state.tabId, "the failed release leaves the gate to its lease");
  assert.deepEqual(gateReleaseFailures(recovering), [], "a stale release failure must not be logged");
  assert.deepEqual(recovering.reports.filter(([error]) => error === failure), [], "a stale release failure must not be reported");
  assert.deepEqual(sessionDeferrals(recovering), []);
});
