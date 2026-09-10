"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const incarnationFixture = require("./test/incarnation-fixture.js");
const sessionModule = require("./app-session.js");

function sessionState(overrides = {}) {
  return {
    authenticated: true, sessionIdentityValidated: true, csrfToken: "csrf",
    user: incarnationFixture.accountUser("user-1"),
    localOwnerId: incarnationFixture.ownerId("user-1"),
    logoutRecoveryRequired: false, retrying: false, syncing: false,
    pending: [], pendingTaskOperations: [], pendingDurationOperations: [],
    pendingAutoStartOperations: [], pendingSelectedTaskOperations: [],
    ...overrides
  };
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

function sessionFixture(overrides = {}) {
  const state = sessionState(overrides.state);
  const calls = [];
  const localStorage = overrides.localStorage || memoryStorage();
  const host = {
    navigator: { onLine: true }, localStorage,
    location: { assign: (value) => calls.push(["assign", value]) },
    console: { warn: (...args) => calls.push(["warn", ...args]) },
    fetch: async () => ({ ok: true, status: 200 }),
    setTimeout: () => 1, prompt: () => null, confirm: () => true,
    EventSource: class { addEventListener() {} close() {} },
    ...overrides.host
  };
  const syncCore = {
    ...incarnationFixture.sync,
    canUseCachedOwnerOffline: () => false,
    ...overrides.syncCore
  };
  const syncStorage = {
    AccountOwnershipError: incarnationFixture.storage.AccountOwnershipError,
    guardedMutation: async () => {}, ...overrides.syncStorage
  };
  const use = {
    captureAccountContext: () => incarnationFixture.captureAccountContext(state, host),
    cleanupIdentity: () => ({}), assertCleanupIdentity: () => {},
    database: () => ({}), tabId: () => "tab-1",
    needsBootstrapResolution: () => false,
    clearLocalData: async () => calls.push("clear"),
    tr: (_key, _values, fallback) => fallback,
    render: () => calls.push("render"),
    showNotice: (value) => calls.push(["notice", value]),
    ...overrides.use
  };
  const elements = { deleteAccountButton: { disabled: false }, logoutButton: { disabled: false } };
  const actions = sessionModule.create({
    state, external: { host, syncCore, syncStorage, elements }, use,
    emit: (type, value) => calls.push([type, value])
  });
  return { actions, calls, elements, state, use };
}

function withSentryStub(t) {
  const calls = [];
  const previous = globalThis.PomodoroughSentryClient;
  globalThis.PomodoroughSentryClient = {
    reportFrontendError: (error, operation) => calls.push([error, operation])
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.PomodoroughSentryClient;
    else globalThis.PomodoroughSentryClient = previous;
  });
  return calls;
}

test("S39 account deletion request failure warns, notices, and reports", async (t) => {
  const fixture = sessionFixture({
    host: { prompt: () => "DELETE", fetch: async () => ({ ok: false, status: 503 }) }
  });
  const reports = withSentryStub(t);
  await fixture.actions.deleteAccount();
  assert.equal(fixture.elements.deleteAccountButton.disabled, false);
  assert.ok(fixture.calls.some((entry) => entry[0] === "notice" && /503/.test(entry[1])));
  assert.equal(fixture.calls.includes("clear"), false);
  assert.equal(fixture.calls.some((entry) => entry[0] === "assign"), false);
  assert.ok(fixture.calls.some((entry) => entry[0] === "warn"
    && /Pomodorough account deletion request failed:/.test(entry[1])));
  assert.equal(reports.length, 1);
  assert.ok(reports[0][0] instanceof Error);
  assert.equal(reports[0][1], "session.delete-account.request-failed");
  assert.match(reports[0][1], /^[a-z0-9][a-z0-9.-]*$/);
});

test("S39 pending logout cleanup failure warns, notices, and reports", async (t) => {
  const fixture = sessionFixture({
    localStorage: memoryStorage({ pomodoroughPendingLogout: "1" }),
    use: { clearLocalData: async () => { throw new Error("disk full"); } }
  });
  const reports = withSentryStub(t);
  assert.equal(await fixture.actions.clearPendingLogoutData(), false);
  assert.equal(fixture.state.logoutRecoveryRequired, true);
  assert.ok(fixture.calls.some((entry) => entry[0] === "notice" && /disk full/.test(entry[1])));
  assert.ok(fixture.calls.some((entry) => entry[0] === "warn"
    && /Pomodorough pending logout cleanup failed:/.test(entry[1])));
  assert.equal(reports.length, 1);
  assert.ok(reports[0][0] instanceof Error);
  assert.equal(reports[0][1], "session.logout-recovery.cleanup-failed");
  assert.match(reports[0][1], /^[a-z0-9][a-z0-9.-]*$/);
});
