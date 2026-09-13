"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const incarnationFixture = require("./test/incarnation-fixture.js");
const syncModule = require("./app-sync.js");

function state(overrides = {}) {
  return {
    actionLocked: false, authenticated: true, bootstrapBlocked: false,
    bootstrapGatePersisted: false, bootstrapGateOwned: false, bootstrapPending: null,
    csrfToken: "csrf", deviceId: "device-1", durationsMs: { focus: 1_500_000 },
    hlcCounter: 0, hlcWallMs: 0, localOwnerId: incarnationFixture.ownerId("user-1"),
    pending: [], pendingAutoStartOperations: [], pendingDurationOperations: [],
    pendingSelectedTaskOperations: [], pendingTaskOperations: [], ready: true,
    retrying: false, revision: 2, selectedPhase: "focus",
    sessionIdentityValidated: true, user: incarnationFixture.accountUser("user-1"),
    ...overrides
  };
}

function fixture(overrides = {}) {
  const current = state(overrides.state);
  const calls = [];
  const timers = [];
  const host = {
    navigator: { onLine: true }, console: { warn: (...args) => calls.push(["warn", ...args]) },
    clearTimeout: () => {}, setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; }
  };
  const syncCore = {
    ...incarnationFixture.sync,
    requiresBootstrapResolution: () => false, compareTimerCommands: () => 0,
    buildSyncBatch: (queues) => queues, ...overrides.syncCore
  };
  const syncStorage = {
    AccountOwnershipError: incarnationFixture.storage.AccountOwnershipError,
    readBootstrapState: async () => ({ gate: null, resolution: null }),
    readSyncState: async () => ({ snapshot: { user: current.user } }),
    normalizeLegacyDurationOperations: async () => {}, readQueues: async () => ({}),
    ...overrides.syncStorage
  };
  const use = {
    captureAccountContext: () => incarnationFixture.captureAccountContext(current, host),
    database: () => ({}), compareDurationOperations: () => 0,
    reapplyRetargetToPending: () => {}, rebuildOptimisticState: () => {},
    stopCompletionAlert: () => {}, closeRevisionStream: () => {},
    quarantineOwnerState: () => {}, render: () => {}, renderSyncStatus: () => calls.push("status"),
    queueSessionRevalidation: () => calls.push("revalidate"),
    restoreSessionAndSync: () => calls.push("restore"), ...overrides.use
  };
  const actions = syncModule.create({ state: current, external: { host, syncCore, syncStorage }, use, listen: () => {} });
  return { actions, calls, current, host, syncStorage, timers };
}

function withSentryCapture(t) {
  const reports = [];
  const previous = globalThis.PomodoroughSentryClient;
  globalThis.PomodoroughSentryClient = { reportFrontendError: (error, operation) => reports.push([error, operation]) };
  t.after(() => {
    if (previous === undefined) delete globalThis.PomodoroughSentryClient;
    else globalThis.PomodoroughSentryClient = previous;
  });
  return reports;
}

test("S65 preflight bootstrap-gate ownership revalidates without a frontend report", async (t) => {
  const owned = fixture({ syncStorage: {
    readBootstrapState: async () => { throw new incarnationFixture.storage.AccountOwnershipError("stale owner"); }
  } });
  const reports = withSentryCapture(t);
  assert.equal(await owned.actions.syncPreflight(true), false);
  assert.ok(owned.calls.includes("revalidate"), "ownership must queue session revalidation");
  assert.equal(reports.length, 0, "ownership must not report a frontend error");
});

test("S65 preflight pending-queues ownership revalidates without a frontend report", async (t) => {
  const owned = fixture({ syncStorage: {
    readSyncState: async () => { throw new incarnationFixture.storage.AccountOwnershipError("stale owner"); }
  } });
  const reports = withSentryCapture(t);
  assert.equal(await owned.actions.syncPreflight(true), false);
  assert.ok(owned.calls.includes("revalidate"), "ownership must queue session revalidation");
  assert.equal(reports.length, 0, "ownership must not report a frontend error");
});
