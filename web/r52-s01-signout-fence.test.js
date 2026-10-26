"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const incarnationFixture = require("./test/incarnation-fixture.js");
const stateModule = require("./app-state.js");
const sessionModule = require("./app-session.js");

function sessionState(overrides = {}) {
  return {
    authenticated: true, sessionIdentityValidated: true, csrfToken: "csrf",
    user: incarnationFixture.accountUser("user-1"),
    localOwnerId: incarnationFixture.ownerId("user-1"),
    bootstrapGateOwned: false, bootstrapPending: null, bootstrapBlocked: false,
    quarantinedLocal: null, ready: true, retrying: false, syncing: false,
    offlineOwnerMode: false, logoutRecoveryRequired: false, logoutRecoveryBusy: false,
    pending: [], pendingTaskOperations: [], pendingDurationOperations: [],
    pendingAutoStartOperations: [], pendingSelectedTaskOperations: [], ...overrides
  };
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key), values
  };
}

function sessionFixture(overrides = {}) {
  const state = sessionState(overrides.state);
  let database = {};
  const calls = [];
  const fetchCalls = [];
  const localStorage = overrides.localStorage || memoryStorage();
  const host = {
    crypto: require("node:crypto").webcrypto,
    navigator: { onLine: true }, localStorage,
    location: { assign: (value) => calls.push(["assign", value]) },
    console: { warn: (...args) => calls.push(["warn", ...args]) },
    fetch: async (...args) => { fetchCalls.push(args); return { ok: true, status: 200 }; },
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
    confirm: () => true,
    EventSource: class { addEventListener() {} close() {} }, ...overrides.host
  };
  const syncCore = {
    ...incarnationFixture.sync,
    canUseCachedOwnerOffline: () => false, ...overrides.syncCore
  };
  const syncStorage = {
    AccountOwnershipError: incarnationFixture.storage.AccountOwnershipError,
    readAccountBinding: async () => ({ sourceOwnerId: state.localOwnerId, gateOwnerId: null }),
    guardedMutation: async () => {},
    allocateClockRequestSequence: async () => 1, clearBootstrapGate: async () => {}, ...overrides.syncStorage
  };
  const cleanup = require("./app-storage.js").create({ state, external: { host, syncCore, syncStorage }, use: {} });
  const use = {
    captureAccountContext: () => incarnationFixture.captureAccountContext(state, host, () => database),
    cleanupIdentity: cleanup.cleanupIdentity, assertCleanupIdentity: cleanup.assertCleanupIdentity,
    database: () => database, tabId: () => "tab-1", needsBootstrapResolution: () => false,
    clearLocalData: async () => {
      calls.push("clear"); database = null;
      return incarnationFixture.captureAccountContext(state, host, () => database);
    }, tr: (_key, _values, fallback) => fallback,
    render: () => calls.push("render"), renderProfile: () => calls.push("profile"),
    renderSyncStatus: () => calls.push("status"),
    showNotice: (value) => calls.push(["notice", value]),
    refreshAllPendingOperations: async () => {}, ...overrides.use
  };
  const elements = { deleteAccountButton: { disabled: false }, logoutButton: { disabled: false } };
  const actions = sessionModule.create({ state, external: { host, syncCore, syncStorage, elements }, use,
    emit: (type, value) => calls.push([type, value]) });
  return { actions, calls, elements, fetchCalls, host, localStorage, state, use };
}

function controlsBlocked(fixture) {
  return stateModule.create({ state: fixture.state,
    external: { host: fixture.host, sharedCoreHost: {}, syncCore: incarnationFixture.sync, syncStorage: incarnationFixture.storage },
    use: {} }).controlsBlocked();
}

function markerOf(fixture) {
  return fixture.localStorage.getItem("pomodoroughPendingLogout");
}

function withFastRevocationTimeout(t) {
  const previous = globalThis.PomodoroughAppRuntime;
  globalThis.PomodoroughAppRuntime = { TIMING_MS: { logoutRevocation: 20 }, timingMs: (name, fallback) =>
    name === "logoutRevocation" ? 20 : fallback };
  t.after(() => {
    if (previous === undefined) delete globalThis.PomodoroughAppRuntime;
    else globalThis.PomodoroughAppRuntime = previous;
  });
}

test("R52-S01 never-resolving revocation still completes local cleanup with durable recovery", async (t) => {
  withFastRevocationTimeout(t);
  const fixture = sessionFixture({ host: { fetch: (...args) => {
    fixture.fetchCalls.push(args);
    return new Promise(() => {});
  } } });
  assert.equal(controlsBlocked(fixture), false);
  await fixture.actions.logout();
  assert.ok(fixture.calls.includes("clear"));
  assert.ok(fixture.calls.includes("profile"));
  assert.ok(fixture.calls.includes("status"));
  assert.equal(markerOf(fixture), "1");
  assert.equal(fixture.state.logoutRecoveryRequired, true);
  assert.equal(controlsBlocked(fixture), true);
  assert.equal(fixture.elements.logoutButton.disabled, true);
  assert.equal(fixture.calls.filter((entry) => entry[0] === "assign").length, 1);
});

test("R52-S01 rejected revocation retains marker and reports deferred recovery", async () => {
  const fixture = sessionFixture({ host: { fetch: async (...args) => {
    fixture.fetchCalls.push(args);
    throw new Error("offline");
  } } });
  await fixture.actions.logout();
  assert.ok(fixture.calls.includes("clear"));
  assert.equal(markerOf(fixture), "1");
  assert.equal(fixture.state.logoutRecoveryRequired, true);
  assert.ok(fixture.calls.some((entry) => entry[0] === "warn"
    && /Pomodorough server revocation deferred until reconnect:/.test(entry[1])));
  assert.equal(fixture.calls.filter((entry) => entry[0] === "assign").length, 1);
});

test("R52-S01 successful revocation clears marker and recovery fence", async () => {
  const fixture = sessionFixture();
  await fixture.actions.logout();
  assert.ok(fixture.calls.includes("clear"));
  assert.equal(markerOf(fixture), null);
  assert.equal(fixture.state.logoutRecoveryRequired, false);
  assert.equal(fixture.calls.filter((entry) => entry[0] === "assign").length, 1);
});

test("R52-S01 cancelled sign-out sends no request and sets no fence", async () => {
  const fixture = sessionFixture({ state: { pending: [{}] }, host: { confirm: () => false } });
  await fixture.actions.logout();
  assert.equal(fixture.fetchCalls.length, 0);
  assert.equal(markerOf(fixture), null);
  assert.equal(fixture.state.logoutRecoveryRequired, false);
  assert.equal(controlsBlocked(fixture), false);
  assert.equal(fixture.elements.logoutButton.disabled, false);
  assert.equal(fixture.calls.filter((entry) => entry[0] === "assign").length, 0);
});

test("R52-S01 late edit after confirmed sign-out fails closed at the control gate", async (t) => {
  withFastRevocationTimeout(t);
  const fixture = sessionFixture({ host: { fetch: () => new Promise(() => {}) } });
  const inFlight = fixture.use.captureAccountContext();
  await fixture.actions.logout();
  assert.equal(markerOf(fixture), "1");
  assert.equal(controlsBlocked(fixture), true);
  assert.throws(() => inFlight.assertCurrent(), { name: "AccountOwnershipError" });
});
