"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const incarnationFixture = require("./test/incarnation-fixture.js");
const stateModule = require("./app-state.js");
const sessionModule = require("./app-session.js");
const { createI18n } = require("./i18n.js");

const catalogs = { en: require("./locales/en.json"), "ar-XB": require("./locales/ar-XB.json") };

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
    captureDatabaseContext: () => incarnationFixture.captureAccountContext(state, host, () => database),
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

function captureReports(t) {
  const reports = [];
  const previous = globalThis.PomodoroughSentryClient;
  globalThis.PomodoroughSentryClient = { reportFrontendError: (error, operation) =>
    reports.push([error.message, operation]) };
  t.after(() => { globalThis.PomodoroughSentryClient = previous; });
  return reports;
}

function missingCsrfFixture(online) {
  return sessionFixture({ state: { csrfToken: null, authenticated: false,
    sessionIdentityValidated: false, offlineOwnerMode: true }, host: { navigator: { onLine: online } } });
}

function serveSession(fixture, csrfToken) {
  fixture.host.navigator.onLine = true;
  fixture.host.fetch = async (url, options) => {
    fixture.fetchCalls.push([url, options]);
    return { ok: true, status: 200, json: async () => ({
      user: incarnationFixture.accountUser("user-1"), csrfToken
    }) };
  };
}

function assertRecoveryRetained(fixture) {
  assert.equal(markerOf(fixture), "1");
  assert.deepEqual(JSON.parse(fixture.localStorage.getItem("pomodoroughPendingLogoutOwner")),
    { userId: incarnationFixture.ownerId("user-1") });
  assert.equal(fixture.state.logoutRecoveryRequired, true);
  assert.equal(controlsBlocked(fixture), true);
}

for (const online of [true, false]) {
  test(`R54-S01 missing CSRF retains recovery until authenticated revoke (online=${online})`, async (t) => {
    const reports = captureReports(t);
    const fixture = missingCsrfFixture(online);
    await fixture.actions.logout();
    assert.equal(fixture.fetchCalls.length, 0);
    assert.equal(fixture.calls.filter((entry) => entry === "clear").length, 1);
    assertRecoveryRetained(fixture);
    const warnings = fixture.calls.filter((entry) => entry[0] === "warn");
    assert.deepEqual(warnings.map((entry) => [entry[1], entry[2].message]),
      [["Pomodorough server revocation deferred until reconnect:", "missing_csrf"]]);
    assert.deepEqual(reports, [["missing_csrf", "session.logout.revocation-deferred"]]);
    assert.equal(fixture.calls.filter((entry) => entry[0] === "assign").length, online ? 1 : 0);
    serveSession(fixture, "fresh-csrf");
    await fixture.actions.loadSession(fixture.use.captureAccountContext());
    assert.deepEqual(fixture.fetchCalls.map(([url]) => url), ["/api/v1/me", "/api/v1/auth/logout"]);
    assert.equal(fixture.fetchCalls[1][1].headers["X-CSRF-Token"], "fresh-csrf");
    assert.equal(markerOf(fixture), null);
    assert.equal(fixture.localStorage.getItem("pomodoroughPendingLogoutOwner"), null);
    assert.equal(fixture.state.logoutRecoveryRequired, false);
    assert.equal(reports.length, 1);
  });
}

test("R54-S01 recovery without a fresh CSRF token keeps markers and reports once per attempt", async (t) => {
  const reports = captureReports(t);
  const fixture = missingCsrfFixture(false);
  await fixture.actions.logout();
  assertRecoveryRetained(fixture);
  serveSession(fixture, "");
  await assert.rejects(fixture.actions.loadSession(fixture.use.captureAccountContext()),
    { message: "Pending sign-out could not be revoked yet." });
  assert.deepEqual(fixture.fetchCalls.map(([url]) => url), ["/api/v1/me"]);
  assertRecoveryRetained(fixture);
  assert.deepEqual(reports, [["missing_csrf", "session.logout.revocation-deferred"]]);
  serveSession(fixture, "fresh-csrf");
  await fixture.actions.loadSession(fixture.use.captureAccountContext());
  assert.deepEqual(fixture.fetchCalls.map(([url]) => url), ["/api/v1/me", "/api/v1/me", "/api/v1/auth/logout"]);
  assert.equal(markerOf(fixture), null);
  assert.equal(fixture.state.logoutRecoveryRequired, false);
});

function catalogTr(locale) {
  const i18n = createI18n({ catalogs, locale });
  return (key, values = {}, fallback = key) => {
    const translated = i18n.t(key, values);
    return translated && translated !== key ? translated : fallback;
  };
}

function unreadableQueueFixture(boundary, locale) {
  const failure = { active: true };
  const unreadable = async () => {
    if (failure.active) throw Object.assign(new Error("IndexedDB read failed"), { name: "UnknownError" });
  };
  const fixture = sessionFixture({ state: { pending: [{ id: "queued-1" }] },
    host: { confirm: () => { fixture.calls.push("confirm"); return true; } },
    syncStorage: boundary === "guardedMutation" ? { guardedMutation: unreadable } : {},
    use: { tr: catalogTr(locale),
      ...(boundary === "refreshAllPendingOperations" ? { refreshAllPendingOperations: unreadable } : {}) } });
  return { failure, fixture };
}

function assertLogoutRefused(fixture, database) {
  assert.equal(fixture.fetchCalls.length, 0);
  assert.equal(fixture.calls.includes("confirm"), false);
  assert.equal(fixture.calls.includes("clear"), false);
  assert.equal(fixture.use.database(), database);
  assert.deepEqual(fixture.state.pending, [{ id: "queued-1" }]);
  assert.equal(markerOf(fixture), null);
  assert.equal(fixture.localStorage.getItem("pomodoroughPendingLogoutOwner"), null);
  assert.equal(fixture.state.logoutRecoveryRequired, false);
  assert.equal(controlsBlocked(fixture), false);
  assert.equal(fixture.elements.logoutButton.disabled, false);
  assert.equal(fixture.calls.filter((entry) => entry[0] === "assign").length, 0);
}

for (const boundary of ["refreshAllPendingOperations", "guardedMutation"]) {
  for (const locale of ["en", "ar-XB"]) {
    test(`R54-S02 unreadable pending queues refuse sign-out with localized retry feedback (${boundary}, ${locale})`, async (t) => {
      const reports = captureReports(t);
      const { failure, fixture } = unreadableQueueFixture(boundary, locale);
      const database = fixture.use.database();
      const notice = catalogs[locale]["account.logout.pendingUnavailable"];
      for (const attempts of [1, 2]) {
        await fixture.actions.logout();
        assertLogoutRefused(fixture, database);
        assert.deepEqual(fixture.calls.filter((entry) => entry[0] === "notice"), Array(attempts).fill(["notice", notice]));
        assert.equal(fixture.state.bootstrapSignOutError, notice);
        assert.equal(fixture.calls.filter((entry) => entry === "render").length, attempts);
        assert.deepEqual(fixture.calls.filter((entry) => entry[0] === "warn").map((entry) => entry[1]),
          Array(attempts).fill("Pomodorough pending queues unavailable before logout:"));
        assert.deepEqual(reports, Array(attempts).fill(["IndexedDB read failed", "session.logout.pending-queues"]));
      }
      failure.active = false;
      await fixture.actions.logout();
      assert.equal(fixture.calls.filter((entry) => entry === "confirm").length, 1);
      assert.equal(fixture.calls.filter((entry) => entry === "clear").length, 1);
      assert.deepEqual(fixture.fetchCalls.map(([url]) => url), ["/api/v1/auth/logout"]);
      assert.equal(markerOf(fixture), null);
      assert.equal(fixture.calls.filter((entry) => entry[0] === "assign").length, 1);
      assert.equal(fixture.calls.filter((entry) => entry[0] === "notice").length, 2);
      assert.equal(fixture.state.bootstrapSignOutError, null);
      assert.equal(reports.length, 2);
    });
  }
}

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

test("R53-S01 combined storage, revocation, and cleanup failures stay fenced until retry commits", async () => {
  const storage = memoryStorage();
  storage.setItem = () => { throw Object.assign(new Error("private marker contents"), { name: "SecurityError" }); };
  const fixture = sessionFixture({ localStorage: storage,
    host: { fetch: async () => { throw new Error("offline"); } } });
  const clearLocalData = fixture.use.clearLocalData;
  const database = fixture.use.database();
  fixture.use.clearLocalData = async () => { throw new Error("transaction abort"); };
  await fixture.actions.logout();
  assert.equal(markerOf(fixture), null);
  assert.equal(storage.getItem("pomodoroughPendingLogoutOwner"), null);
  assert.equal(fixture.use.database(), database);
  assert.equal(controlsBlocked(fixture), true);
  assert.equal(fixture.state.logoutRecoveryBusy, false);
  assert.ok(fixture.calls.some((entry) => entry[0] === "notice" && /transaction abort/.test(entry[1])));
  assert.equal(fixture.calls.filter((entry) => entry[0] === "assign").length, 0);
  fixture.use.resumeStartup = async () => { assert.fail("volatile recovery must not resume ordinary startup"); };
  fixture.use.resetSyncRetry = () => {};
  await fixture.actions.handleOnline();
  assert.equal(controlsBlocked(fixture), true);
  await fixture.actions.retryPendingLogout();
  assert.equal(fixture.use.database(), database);
  assert.equal(controlsBlocked(fixture), true);
  assert.equal(fixture.calls.filter((entry) => entry[0] === "assign").length, 0);
  const warnings = fixture.calls.filter((entry) => entry[0] === "warn" && /marker storage failed/.test(entry[1]));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][2].name, "SecurityError");
  assert.equal(warnings[0][2].message, "Sign-out recovery marker storage failed.");
  fixture.use.clearLocalData = clearLocalData;
  await fixture.actions.retryPendingLogout();
  assert.equal(fixture.use.database(), null);
  assert.equal(fixture.state.logoutRecoveryBusy, false);
  assert.equal(fixture.calls.filter((entry) => entry[0] === "assign").length, 1);
});

test("R53-S01 durable recovery still permits navigation after cleanup aborts", async () => {
  const fixture = sessionFixture({ host: { fetch: async () => { throw new Error("offline"); } },
    use: { clearLocalData: async () => { throw new Error("transaction abort"); } } });
  const database = fixture.use.database();
  await fixture.actions.logout();
  assert.equal(markerOf(fixture), "1");
  assert.equal(fixture.use.database(), database);
  assert.equal(controlsBlocked(fixture), true);
  assert.equal(fixture.calls.filter((entry) => entry[0] === "assign").length, 1);
});

test("R53-S01 marker diagnostics classify errors and never report storage exception contents", (t) => {
  const reports = [];
  const previous = globalThis.PomodoroughSentryClient;
  globalThis.PomodoroughSentryClient = { reportFrontendError: (error, operation) => reports.push([error, operation]) };
  t.after(() => { globalThis.PomodoroughSentryClient = previous; });
  const fixture = sessionFixture();
  for (const name of ["SecurityError", "QuotaExceededError", "UntrustedCredentialName"]) {
    fixture.localStorage.setItem = () => { throw Object.assign(new Error("secret credentials"), { name }); };
    assert.equal(fixture.actions.markPendingLogout(), false);
    assert.equal(fixture.actions.markPendingLogout(), false);
  }
  assert.deepEqual(reports.map(([error, operation]) => [error.name, error.message, operation]),
    ["SecurityError", "QuotaExceededError", "StorageError"].map((name) =>
      [name, "Sign-out recovery marker storage failed.", "session.logout.marker-write-failed"]));
});
