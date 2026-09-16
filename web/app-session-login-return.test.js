"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const incarnationFixture = require("./test/incarnation-fixture.js");
const sessionModule = require("./app-session.js");

function loginRedirect(location) {
  const calls = [];
  const host = {
    navigator: { onLine: true },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { ...location, assign: (value) => calls.push(value) },
    console: { warn: () => {} },
    fetch: async () => ({ ok: true, status: 200 }),
    setTimeout: () => 1, prompt: () => null, confirm: () => true,
    EventSource: class { addEventListener() {} close() {} }
  };
  const state = {
    authenticated: false, sessionIdentityValidated: false, csrfToken: null,
    user: null, localOwnerId: null, logoutRecoveryRequired: false,
    pending: [], pendingTaskOperations: [], pendingDurationOperations: [],
    pendingAutoStartOperations: [], pendingSelectedTaskOperations: []
  };
  const actions = sessionModule.create({
    state,
    external: {
      host, syncCore: incarnationFixture.sync,
      syncStorage: { AccountOwnershipError: incarnationFixture.storage.AccountOwnershipError },
      elements: {}
    },
    use: {
      captureAccountContext: () => ({}), cleanupIdentity: () => ({}),
      assertCleanupIdentity: () => {}, database: () => ({}), tabId: () => "tab-1",
      needsBootstrapResolution: () => false, clearLocalData: async () => {},
      tr: (_key, _values, fallback) => fallback, render: () => {},
      renderProfile: () => {}, renderSyncStatus: () => {}, showNotice: () => {},
      quarantineOwnerState: () => {}, restoreOwnerState: () => {},
      restartBootstrapForCurrentAccount: async () => {}, prepareBootstrap: async () => {},
      syncNow: async () => {}, scheduleSync: () => {}, scheduleRetry: () => {},
      resetSyncRetry: () => {}, refreshAllPendingOperations: async () => {},
      resumeStartup: async () => true
    },
    emit: () => {}
  });
  actions.redirectToLogin();
  assert.equal(calls.length, 1);
  return calls[0];
}

test("redirect preserves pathname and query", () => {
  assert.equal(
    loginRedirect({ pathname: "/app/tasks", search: "?filter=today" }),
    "/auth/google/start?return=%2Fapp%2Ftasks%3Ffilter%3Dtoday"
  );
});

test("redirect strips hash and falls back for unsafe paths", () => {
  assert.equal(
    loginRedirect({ href: "/app?view=today#section" }),
    "/auth/google/start?return=%2Fapp%3Fview%3Dtoday"
  );
  assert.equal(
    loginRedirect({ pathname: "//evil.example/phish", search: "" }),
    "/auth/google/start?return=%2Fapp"
  );
  assert.equal(
    loginRedirect({ pathname: "/app\\evil", search: "" }),
    "/auth/google/start?return=%2Fapp"
  );
  assert.equal(loginRedirect({}), "/auth/google/start?return=%2Fapp");
});

test("redirect extracts same-origin path from absolute href", () => {
  assert.equal(
    loginRedirect({ href: "https://app.example/app/tasks?x=1#frag" }),
    "/auth/google/start?return=%2Fapp%2Ftasks%3Fx%3D1"
  );
});
