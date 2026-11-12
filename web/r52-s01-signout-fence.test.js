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

test("R54-S01 recovery without a fresh CSRF token keeps markers and reports once per sign-out", async (t) => {
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

function unreadableQueueFixture(boundary, locale, beforeFailure = () => {}) {
  const failure = { active: true };
  const unreadable = async () => {
    beforeFailure(fixture);
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

test("R54-S02 a read that succeeds after a refusal clears the dialog refusal and renders before the confirm", async (t) => {
  const reports = captureReports(t);
  const { failure, fixture } = unreadableQueueFixture("refreshAllPendingOperations", "en");
  const database = fixture.use.database();
  fixture.host.confirm = () => {
    fixture.calls.push(["confirm", fixture.state.bootstrapSignOutError]);
    return false;
  };
  await fixture.actions.logout();
  assert.equal(fixture.state.bootstrapSignOutError, catalogs.en["account.logout.pendingUnavailable"]);
  failure.active = false;
  const start = fixture.calls.length;
  await fixture.actions.logout();
  // Cancel returns with limit recovery still open, so the cleared refusal
  // must be rendered before the confirm, not only dropped from state.
  assert.deepEqual(fixture.calls.slice(start).filter((entry) => entry === "render" || entry[0] === "confirm"),
    ["render", ["confirm", null]]);
  assert.equal(fixture.state.bootstrapSignOutError, null);
  assert.deepEqual(fixture.state.pending, [{ id: "queued-1" }]);
  assert.equal(fixture.fetchCalls.length, 0);
  assert.equal(fixture.calls.includes("clear"), false);
  assert.equal(fixture.use.database(), database);
  assert.equal(markerOf(fixture), null);
  assert.equal(fixture.state.logoutRecoveryRequired, false);
  assert.equal(fixture.elements.logoutButton.disabled, false);
  assert.equal(reports.length, 1);
});

test("R54-S02 a read that fails after another tab started sign-out refuses silently", async (t) => {
  const reports = captureReports(t);
  const { fixture } = unreadableQueueFixture("refreshAllPendingOperations", "en",
    (current) => current.localStorage.setItem("pomodoroughPendingLogout", "1"));
  await fixture.actions.logout();
  assert.deepEqual(reports, []);
  assert.deepEqual(fixture.calls.filter((entry) => ["warn", "notice"].includes(entry[0])), []);
  assert.equal(fixture.state.bootstrapSignOutError ?? null, null);
  assert.equal(fixture.calls.includes("render"), false);
  assert.equal(fixture.calls.includes("confirm"), false);
  assert.equal(fixture.fetchCalls.length, 0);
});

test("R54-S02 the refusal is the reviewed English sentence and its RTL pseudolocale form", () => {
  const english = "Sign out did not finish because pending changes could not be read. "
    + "Your local data was kept. Check browser storage and retry.";
  const accents = { a: "à", e: "ë", i: "ï", o: "ö", u: "û", A: "Å", E: "Ë", I: "Ï", O: "Ö", U: "Û" };
  assert.equal(catalogs.en["account.logout.pendingUnavailable"], english);
  assert.equal(catalogs["ar-XB"]["account.logout.pendingUnavailable"],
    `\u200f⟦${english.replace(/[aeiouAEIOU]/g, (letter) => accents[letter])}⟧\u200f`);
});

function overlappingRefusalFixture() {
  const storage = memoryStorage();
  storage.setItem = () => { throw Object.assign(new Error("quota"), { name: "QuotaExceededError" }); };
  const unreadable = Object.assign(new Error("IndexedDB read failed"), { name: "UnknownError" });
  const flow = { refuseOverlap: null, overlapping: null };
  const reads = [async () => {}, () => new Promise((_resolve, reject) => { flow.refuseOverlap = reject; })];
  const fixture = sessionFixture({ localStorage: storage,
    host: { fetch: async () => {
      // A second click's queue read fails while the first attempt revokes.
      flow.refuseOverlap(unreadable);
      await flow.overlapping;
      return { ok: true, status: 200 };
    } },
    use: { refreshAllPendingOperations: () => reads.shift()() } });
  fixture.use.clearLocalData = async () => { throw new Error("transaction abort"); };
  return { fixture, flow, reads, unreadable };
}

test("R54-S02 cleanup retry recovery opens without an overlapping refusal and shows the Retry refusal", async (t) => {
  const reports = captureReports(t);
  const { fixture, flow, reads, unreadable } = overlappingRefusalFixture();
  const refusal = catalogs.en["account.logout.pendingUnavailable"];
  const first = fixture.actions.logout();
  flow.overlapping = fixture.actions.logout();
  await first;
  assert.equal(fixture.state.logoutRecoveryRequired, true);
  assert.equal(fixture.state.bootstrapSignOutError, null);
  const notices = fixture.calls.filter((entry) => entry[0] === "notice").map((entry) => entry[1]);
  assert.equal(notices.length, 2);
  assert.equal(notices[0], refusal);
  assert.equal(notices[1], "Signed-out data on this device could not be cleared. Try again.");
  assert.deepEqual(reports.map(([, operation]) => operation), ["session.logout.marker-write-failed",
    "session.logout.pending-queues", "session.logout.cleanup-incomplete"]);
  reads.push(async () => { throw unreadable; });
  await fixture.actions.retryPendingLogout();
  assert.equal(fixture.state.bootstrapSignOutError, refusal);
  assert.equal(fixture.state.logoutRecoveryRequired, true);
  assert.equal(fixture.state.logoutRecoveryBusy, false);
  assert.equal(fixture.calls.filter((entry) => entry[0] === "assign").length, 0);
});

test("R52-A01 double Retry after a failed cleanup marker write runs cleanup once", async (t) => {
  captureReports(t);
  const storage = memoryStorage();
  storage.setItem = () => { throw Object.assign(new Error("quota"), { name: "QuotaExceededError" }); };
  const fixture = sessionFixture({ localStorage: storage });
  const clearLocalData = fixture.use.clearLocalData;
  fixture.use.clearLocalData = async () => { throw new Error("transaction abort"); };
  await fixture.actions.logout();
  assert.equal(fixture.state.logoutRecoveryRequired, true);
  let releaseCleanup;
  const cleanupHeld = new Promise((resolve) => { releaseCleanup = resolve; });
  fixture.use.clearLocalData = async (...args) => { await cleanupHeld; return clearLocalData(...args); };
  const revokes = fixture.fetchCalls.length;
  const first = fixture.actions.retryPendingLogout();
  const second = fixture.actions.retryPendingLogout();
  const stillRunning = new Promise((resolve) => setImmediate(resolve, "still running"));
  assert.equal(await Promise.race([second, stillRunning]), false);
  releaseCleanup();
  assert.equal(await first, true);
  assert.deepEqual(fixture.fetchCalls.slice(revokes).map(([url]) => url), ["/api/v1/auth/logout"]);
  assert.equal(fixture.calls.filter((entry) => entry === "clear").length, 1);
  assert.equal(fixture.calls.filter((entry) => entry[0] === "assign").length, 1);
  assert.equal(fixture.state.logoutRecoveryRequired, false);
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
  assert.ok(fixture.calls.some((entry) => entry[0] === "notice"
    && entry[1] === "Signed-out data on this device could not be cleared. Try again."));
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

// R54-S01 test-quality gaps: stale-context guard, diagnostic shape, and the
// Retry busy guard on the missing-CSRF recovery path.

test("R54-S01 late revocation failure after an account switch stays silent", async (t) => {
  const reports = captureReports(t);
  let rejectRevocation = null;
  const fixture = sessionFixture({ host: { fetch: (...args) => {
    fixture.fetchCalls.push(args);
    return new Promise((_resolve, reject) => { rejectRevocation = reject; });
  } } });
  const logout = fixture.actions.logout();
  for (let turn = 0; !rejectRevocation && turn < 200; turn += 1) await new Promise(setImmediate);
  assert.ok(rejectRevocation, "revocation request must be in flight");
  fixture.state.localOwnerId = incarnationFixture.ownerId("user-2");
  rejectRevocation(new Error("offline"));
  await logout;
  assert.deepEqual(fixture.fetchCalls.map(([url]) => url), ["/api/v1/auth/logout"]);
  assert.deepEqual(fixture.calls.filter((entry) => entry[0] === "warn"), []);
  assert.deepEqual(reports, []);
});

function captureReportedErrors(t) {
  const reports = [];
  const previous = globalThis.PomodoroughSentryClient;
  globalThis.PomodoroughSentryClient = { reportFrontendError: (error, operation) => reports.push([error, operation]) };
  t.after(() => { globalThis.PomodoroughSentryClient = previous; });
  return reports;
}

function errorShape(error) {
  return { name: error.name, message: error.message, ownKeys: Object.keys(error) };
}

for (const online of [true, false]) {
  test(`R54-S01 missing CSRF diagnostics carry only the fixed message (online=${online})`, async (t) => {
    const reports = captureReportedErrors(t);
    const fixture = missingCsrfFixture(online);
    fixture.state.user = { ...fixture.state.user, email: "private@example.com", name: "Private Name" };
    await fixture.actions.logout();
    const expected = { name: "Error", message: "missing_csrf", ownKeys: [] };
    const warnings = fixture.calls.filter((entry) => entry[0] === "warn");
    assert.deepEqual(warnings.map(([, prefix, error, ...extra]) => [prefix, errorShape(error), extra]),
      [["Pomodorough server revocation deferred until reconnect:", expected, []]]);
    assert.deepEqual(reports.map(([error, operation]) => [errorShape(error), operation]),
      [[expected, "session.logout.revocation-deferred"]]);
  });
}

test("R54-S01 double Retry during missing-CSRF recovery sends one revoke", async (t) => {
  captureReports(t);
  const fixture = missingCsrfFixture(false);
  await fixture.actions.logout();
  assertRecoveryRetained(fixture);
  serveSession(fixture, "fresh-csrf");
  fixture.use.resumeStartup = async (context) => ({ result: await fixture.actions.loadSession(context), context });
  const retries = await Promise.allSettled([fixture.actions.retryPendingLogout(), fixture.actions.retryPendingLogout()]);
  assert.deepEqual(fixture.fetchCalls.map(([url]) => url), ["/api/v1/me", "/api/v1/auth/logout"]);
  assert.deepEqual(retries.map((retry) => retry.status), ["fulfilled", "fulfilled"]);
  assert.equal(retries[1].value, false);
  assert.equal(markerOf(fixture), null);
  assert.equal(fixture.state.logoutRecoveryRequired, false);
  assert.equal(fixture.state.logoutRecoveryBusy, false);
});
