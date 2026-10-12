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

function sessionState(overrides = {}) {
  return {
    authenticated: true, sessionIdentityValidated: true, csrfToken: "csrf-original",
    user: incarnationFixture.accountUser("user-1"), localOwnerId: incarnationFixture.ownerId("user-1"),
    bootstrapGateOwned: false, bootstrapPending: null, bootstrapBlocked: false,
    quarantinedLocal: null, ready: true, retrying: false, syncing: false, offlineOwnerMode: false,
    pending: [], pendingTaskOperations: [], pendingDurationOperations: [],
    pendingAutoStartOperations: [], pendingSelectedTaskOperations: [], ...overrides,
  };
}

function sessionFixture(overrides = {}) {
  const state = sessionState(overrides.state);
  let database = {};
  const calls = [];
  const localStorage = overrides.localStorage || memoryStorage();
  const host = {
    navigator: { onLine: true }, localStorage,
    location: { assign: (value) => calls.push(["assign", value]) },
    console: { warn: (...args) => calls.push(["warn", ...args]) },
    fetch: async () => ({ ok: true, status: 204 }),
    setTimeout: (callback) => { calls.push("timeout"); return 1; },
    document: { createElement: () => null, body: { append: () => {} } },
    confirm: () => true,
    EventSource: class { addEventListener() {} close() {} },
    ...overrides.host,
  };
  const syncCore = { ...incarnationFixture.sync, ...overrides.syncCore };
  const syncStorage = {
    AccountOwnershipError: incarnationFixture.storage.AccountOwnershipError,
    readAccountBinding: async () => ({ sourceOwnerId: state.localOwnerId, gateOwnerId: null }),
    guardedMutation: async () => {},
    allocateClockRequestSequence: async () => 1,
    clearBootstrapGate: async () => {},
    ...overrides.syncStorage,
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
    ...overrides.use,
  };
  const elements = { deleteAccountButton: { disabled: false }, logoutButton: { disabled: false } };
  const actions = sessionModule.create({ state, external: { host, syncCore, syncStorage, elements }, use,
    emit: () => {} });
  return { actions, calls, elements, host, localStorage, state, syncCore, use, getDatabase: () => database };
}

test("R48-S03 persists account-bound attempt with original CSRF before DELETE", async () => {
  const seen = [];
  const fixture = sessionFixture({ host: { fetch: async (url, init) => {
    seen.push({ url, init }); return { ok: true, status: 204 };
  } } });
  assert.equal(await fixture.actions.deleteAccount("DELETE"), true);
  const raw = fixture.localStorage.getItem("pomodoroughPendingDeletion");
  assert.equal(raw, null);
  assert.equal(seen[0].url, "/api/v1/account");
  assert.equal(seen[0].init.headers["X-CSRF-Token"], "csrf-original");
  assert.ok(seen[0].init.headers["X-Pomodorough-Account-Incarnation"]);
  assert.equal(fixture.calls.filter((c) => c === "clear").length, 1);
});

test("R48-S03 lost DELETE response keeps marker and never falsely confirms", async () => {
  const fixture = sessionFixture({ host: { fetch: async () => { throw new Error("Failed to fetch"); } } });
  assert.equal(await fixture.actions.deleteAccount("DELETE"), false);
  const attempt = JSON.parse(fixture.localStorage.getItem("pomodoroughPendingDeletion"));
  assert.equal(attempt.csrfToken, "csrf-original");
  assert.equal(attempt.userId, incarnationFixture.ownerId("user-1"));
  assert.equal(fixture.calls.includes("clear"), false);
  assert.equal(fixture.elements.deleteAccountButton.disabled, false);
});

test("R48-S03 5xx keeps marker while 401 clears without cleanup", async () => {
  const ambiguous = sessionFixture({ host: { fetch: async () => ({ ok: false, status: 503 }) } });
  assert.equal(await ambiguous.actions.deleteAccount("DELETE"), false);
  assert.ok(ambiguous.localStorage.getItem("pomodoroughPendingDeletion") !== null);
  assert.equal(ambiguous.calls.includes("clear"), false);
  const definitive = sessionFixture({ host: { fetch: async () => ({ ok: false, status: 401 }) } });
  assert.equal(await definitive.actions.deleteAccount("DELETE"), false);
  assert.equal(definitive.localStorage.getItem("pomodoroughPendingDeletion"), null);
  assert.equal(definitive.calls.includes("clear"), false);
});

test("R48-S03 restart replays original receipt before ordinary session and cleans atomically", async () => {
  const shared = memoryStorage();
  const first = sessionFixture({ localStorage: shared, host: { fetch: async () => { throw new Error("abort"); } } });
  assert.equal(await first.actions.deleteAccount("DELETE"), false);
  assert.ok(shared.getItem("pomodoroughPendingDeletion") !== null);
  const order = [];
  const second = sessionFixture({ localStorage: shared, host: { fetch: async (url) => {
    order.push(url);
    if (url === "/api/v1/account") return { ok: true, status: 204 };
    return { ok: true, status: 200, json: async () => ({ user: incarnationFixture.accountUser("user-1"), csrfToken: "new" }) };
  } } });
  assert.equal(await second.actions.loadSession(), false);
  assert.deepEqual(order[0], "/api/v1/account");
  assert.equal(second.calls.includes("clear"), true);
  assert.equal(shared.getItem("pomodoroughPendingDeletion"), null);
  assert.equal(shared.getItem("pomodoroughPendingLogout"), null);
  assert.ok(second.calls.some((c) => Array.isArray(c) && c[0] === "assign"));
});

test("R48-S03 another account never clears unrelated state", async () => {
  const shared = memoryStorage({ pomodoroughPendingDeletion: JSON.stringify({
    userId: incarnationFixture.ownerId("user-1"), csrfToken: "csrf-original" }) });
  const seen = [];
  const other = sessionFixture({ localStorage: shared,
    state: { user: incarnationFixture.accountUser("user-2"), localOwnerId: incarnationFixture.ownerId("user-2") },
    host: { fetch: async (url) => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => ({ user: incarnationFixture.accountUser("user-2"), csrfToken: "new" }) };
    } } });
  assert.equal(await other.actions.loadSession(), true);
  assert.equal(seen.includes("/api/v1/account"), false);
  assert.equal(other.calls.includes("clear"), false);
  assert.ok(shared.getItem("pomodoroughPendingDeletion") !== null);
});

test("R48-S03 storage abort retains markers without false confirmation", async () => {
  const fixture = sessionFixture({ host: { fetch: async () => ({ ok: true, status: 204 }) },
    use: { clearLocalData: async () => { throw new Error("disk full"); } } });
  assert.equal(await fixture.actions.deleteAccount("DELETE"), true);
  assert.equal(fixture.localStorage.getItem("pomodoroughPendingLogout"), "1");
  assert.ok(fixture.localStorage.getItem("pomodoroughPendingDeletion") !== null);
});
