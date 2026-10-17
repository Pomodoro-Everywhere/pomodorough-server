"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const incarnationFixture = require("./test/incarnation-fixture.js");
const sessionModule = require("./app-session.js");

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values,
  };
}

function sessionFixture(overrides = {}) {
  const state = {
    authenticated: true, sessionIdentityValidated: true, csrfToken: "csrf-original",
    user: incarnationFixture.accountUser("user-1"), localOwnerId: incarnationFixture.ownerId("user-1"),
    bootstrapGateOwned: false, bootstrapPending: null, bootstrapBlocked: false,
    quarantinedLocal: null, ready: true, retrying: false, syncing: false, offlineOwnerMode: false,
    pending: [], pendingTaskOperations: [], pendingDurationOperations: [],
    pendingAutoStartOperations: [], pendingSelectedTaskOperations: [],
    ...(overrides.state || {}),
  };
  let database = {};
  const calls = [];
  const localStorage = overrides.localStorage || memoryStorage();
  const host = {
    crypto: require("node:crypto").webcrypto,
    navigator: { onLine: true }, localStorage,
    location: { assign: (value) => calls.push(["assign", value]) },
    console: { warn: (...args) => calls.push(["warn", ...args]) },
    fetch: async () => ({ ok: true, status: 204 }),
    setTimeout: () => 1,
    document: { createElement: () => null, body: { append: () => {} } },
    confirm: () => true,
    EventSource: class { addEventListener() {} close() {} },
    ...(overrides.host || {}),
  };
  const syncCore = { ...incarnationFixture.sync, ...(overrides.syncCore || {}) };
  const syncStorage = {
    AccountOwnershipError: incarnationFixture.storage.AccountOwnershipError,
    readAccountBinding: async () => ({ sourceOwnerId: state.localOwnerId, gateOwnerId: null }),
    guardedMutation: async () => {},
    allocateClockRequestSequence: async () => 1,
    clearBootstrapGate: async () => {},
    ...(overrides.syncStorage || {}),
  };
  const cleanup = require("./app-storage.js").create({ state, external: { host, syncCore, syncStorage }, use: {} });
  const use = {
    captureAccountContext: () => incarnationFixture.captureAccountContext(state, host, () => database),
    cleanupIdentity: cleanup.cleanupIdentity,
    assertCleanupIdentity: cleanup.assertCleanupIdentity,
    database: () => database, tabId: () => "tab-1",
    needsBootstrapResolution: () => false,
    clearLocalData: async () => {
      calls.push("clear"); database = null;
      return incarnationFixture.captureAccountContext(state, host, () => database);
    },
    tr: (_k, _v, fallback) => fallback,
    render: () => calls.push("render"), renderProfile: () => {},
    renderSyncStatus: () => {}, showNotice: (v) => calls.push(["notice", v]),
    quarantineOwnerState: () => {}, restoreOwnerState: () => {},
    restartBootstrapForCurrentAccount: async () => {},
    prepareBootstrap: async () => {}, syncNow: async () => {},
    scheduleSync: () => {}, scheduleRetry: () => {},
    resetSyncRetry: () => {}, refreshAllPendingOperations: async () => {},
    ...(overrides.use || {}),
  };
  const elements = { deleteAccountButton: { disabled: false }, logoutButton: { disabled: false } };
  const actions = sessionModule.create({ state, external: { host, syncCore, syncStorage, elements }, use,
    emit: () => {} });
  return { actions, calls, elements, host, localStorage, state, use };
}

function denyReadback(localStorage) {
  const read = localStorage.getItem.bind(localStorage);
  localStorage.getItem = (key) => {
    if (key === "pomodoroughPendingDeletion") throw new DOMException("denied", "SecurityError");
    return read(key);
  };
  localStorage.removeItem = () => { throw new DOMException("cannot remove", "SecurityError"); };
  return read;
}

test("R49-S01 candidate survives account-incarnation rotation with zero DELETE", async () => {
  const localStorage = memoryStorage();
  const read = denyReadback(localStorage);
  let deletes = 0;
  const first = sessionFixture({ localStorage,
    state: { pendingTaskOperations: [{ id: "retained-task" }] },
    host: { fetch: async () => { deletes += 1; return { ok: true, status: 204 }; } } });
  assert.equal(await first.actions.deleteAccount("DELETE"), false);
  assert.equal(deletes, 0);
  const candidate = localStorage.values.get("pomodoroughPendingDeletion");
  assert.equal(JSON.parse(candidate).stage, "candidate");
  localStorage.getItem = read;
  const requests = [];
  const restarted = sessionFixture({ localStorage,
    state: { user: incarnationFixture.accountUser("user-1", 2),
      localOwnerId: incarnationFixture.ownerId("user-1", 2),
      pendingTaskOperations: [{ id: "retained-task" }] },
    host: { fetch: async (url) => {
      requests.push(url);
      if (url === "/api/v1/account") { deletes += 1; return { ok: true, status: 204 }; }
      return { ok: true, status: 200,
        json: async () => ({ user: incarnationFixture.accountUser("user-1", 2), csrfToken: "new" }) };
    } } });
  assert.equal(await restarted.actions.loadSession(), true);
  assert.deepEqual(requests, ["/api/v1/me"]);
  assert.equal(localStorage.values.get("pomodoroughPendingDeletion"), candidate);
  assert.deepEqual(restarted.state.pendingTaskOperations, [{ id: "retained-task" }]);
  assert.equal(restarted.calls.includes("clear"), false);
  assert.equal(deletes, 0);
});

test("R49-S01 persistent storage outage refuses renewed confirmation after restart", async () => {
  const localStorage = memoryStorage();
  localStorage.setItem = () => { throw new DOMException("no space", "QuotaExceededError"); };
  localStorage.getItem = (key) => {
    if (key === "pomodoroughPendingDeletion") throw new DOMException("denied", "SecurityError");
    return null;
  };
  localStorage.removeItem = () => { throw new DOMException("denied", "SecurityError"); };
  let deletes = 0;
  const first = sessionFixture({ localStorage,
    host: { fetch: async () => { deletes += 1; return { ok: true, status: 204 }; } } });
  assert.equal(await first.actions.deleteAccount("DELETE"), false);
  assert.equal(deletes, 0);
  const requests = [];
  const restarted = sessionFixture({ localStorage,
    host: { fetch: async (url) => {
      requests.push(url);
      return { ok: true, status: 200,
        json: async () => ({ user: incarnationFixture.accountUser("user-1"), csrfToken: "new" }) };
    } } });
  assert.equal(await restarted.actions.loadSession(), true);
  assert.deepEqual(requests, ["/api/v1/me"]);
  assert.equal(await restarted.actions.deleteAccount("DELETE"), false);
  assert.equal(deletes, 0);
  assert.equal(restarted.calls.includes("clear"), false);
  assert.equal(restarted.elements.deleteAccountButton.disabled, false);
});
