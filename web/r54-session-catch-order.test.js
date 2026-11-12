"use strict";

// initializeSession defers a failed session check: it marks the retry, renders,
// schedules the retry, and shows a failure notice. A render that throws in
// that catch path must not strand the client without a retry or a notice.
// The test does not pin whether initializeSession then resolves or rejects.

const test = require("node:test");
const assert = require("node:assert/strict");
const incarnationFixture = require("./test/incarnation-fixture.js");
const sessionModule = require("./app-session.js");
const { viewFixture } = require("./test/ux-view-fixture.js");

const SETTLE_ROUNDS = 200;

function sessionState(sessionIdentityValidated) {
  return {
    authenticated: sessionIdentityValidated, sessionIdentityValidated,
    csrfToken: sessionIdentityValidated ? "csrf" : null, user: incarnationFixture.accountUser("user-1"),
    localOwnerId: incarnationFixture.ownerId("user-1"), bootstrapGateOwned: false, bootstrapPending: null,
    bootstrapBlocked: false, quarantinedLocal: null, ready: true, retrying: false, syncing: false,
    offlineOwnerMode: false, pending: [], pendingTaskOperations: [], pendingDurationOperations: [],
    pendingAutoStartOperations: [], pendingSelectedTaskOperations: []
  };
}

function offlineHost(calls) {
  const values = new Map();
  return {
    crypto: require("node:crypto").webcrypto, navigator: { onLine: true },
    localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key) },
    location: { assign: (value) => calls.push(["assign", value]) },
    console: { warn: (...args) => calls.push(["warn", ...args]) },
    fetch: async () => { throw new Error("offline"); },
    setTimeout: (callback) => { calls.push(["timeout", callback]); return 1; },
    EventSource: class { addEventListener() {} close() {} }
  };
}

function sessionUse(state, host, calls) {
  let database = {};
  return {
    captureAccountContext: () => incarnationFixture.captureAccountContext(state, host, () => database),
    database: () => database, tabId: () => "tab-1", needsBootstrapResolution: () => false,
    tr: (_key, _values, fallback) => fallback,
    render: () => { calls.push("render"); throw new Error("render failed"); },
    renderProfile: () => calls.push("profile"), renderSyncStatus: () => calls.push("status"),
    showNotice: (value) => calls.push(["notice", value]),
    quarantineOwnerState: () => calls.push("quarantine"), restoreOwnerState: () => calls.push("restore"),
    prepareBootstrap: async () => calls.push("prepare"), syncNow: async (force) => calls.push(["sync", force]),
    scheduleSync: () => calls.push("scheduleSync"), scheduleRetry: () => calls.push("retry"),
    resetSyncRetry: () => calls.push("resetRetry"), refreshAllPendingOperations: async () => {},
    clearLocalData: async () => { calls.push("clear"); database = null; }
  };
}

function throwingRenderSession(sessionIdentityValidated) {
  const state = sessionState(sessionIdentityValidated);
  const calls = [];
  const host = offlineHost(calls);
  const syncCore = { ...incarnationFixture.sync, canUseCachedOwnerOffline: () => false };
  const syncStorage = {
    AccountOwnershipError: incarnationFixture.storage.AccountOwnershipError,
    readAccountBinding: async () => ({ sourceOwnerId: state.localOwnerId, gateOwnerId: null }),
    guardedMutation: async () => {}, allocateClockRequestSequence: async () => 1, clearBootstrapGate: async () => {}
  };
  const use = sessionUse(state, host, calls);
  const elements = { deleteAccountButton: { disabled: false }, logoutButton: { disabled: false } };
  const actions = sessionModule.create({ state, external: { host, syncCore, syncStorage, elements }, use,
    emit: (type, value) => calls.push([type, value]) });
  return { actions, calls, state, use };
}

// initializeSession may resolve or reject after the render failure; either way
// it must settle. Bounded so a hung catch path fails instead of stalling.
async function settled(promise) {
  let outcome = { settled: false };
  promise.then((value) => { outcome = { settled: true, value }; },
    (error) => { outcome = { settled: true, error }; });
  for (let round = 0; round < SETTLE_ROUNDS && !outcome.settled; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return outcome;
}

for (const validated of [false, true]) {
  test(`initializeSession schedules the retry and shows the notice when render throws (session validated: ${validated})`, async () => {
    const current = throwingRenderSession(validated);
    const outcome = await settled(current.actions.initializeSession(current.use.captureAccountContext()));
    assert.equal(outcome.settled, true, "initializeSession settles");
    assert.ok(current.calls.includes("render"), "the catch path rendered");
    assert.equal(current.state.retrying, true);
    assert.ok(current.calls.includes("retry"), "the retry is scheduled although render threw");
    // The notice wording is not pinned: HEAD shows error.message, a later
    // client may show a generic sentence with a retry action instead.
    assert.ok(current.calls.some((entry) => Array.isArray(entry) && entry[0] === "notice"
      && typeof entry[1] === "string" && entry[1].length > 0), "a failure notice is shown although render threw");
  });
}

// restoreSessionAndSync (the online, focus and scheduled-retry path) has the
// same catch: a failed session check marks the retry, renders and schedules
// the next retry. It shows no notice of its own; the sync status explains it.
for (const validated of [false, true]) {
  test(`restoreSessionAndSync schedules the retry when render throws (session validated: ${validated})`, async () => {
    const current = throwingRenderSession(validated);
    if (validated) current.use.syncNow = async () => { throw new Error("offline"); };
    const outcome = await settled(current.actions.restoreSessionAndSync(current.use.captureAccountContext()));
    assert.equal(outcome.settled, true, "restoreSessionAndSync settles");
    assert.ok(current.calls.includes("render"), "the catch path rendered");
    assert.equal(current.state.retrying, true);
    assert.ok(current.calls.includes("retry"), "the retry is scheduled although render threw");
  });
}

// R54 acceptance F3: settling a deferred session renders inside the paths it
// repairs. A render that throws there is warned about and reported, so a
// session that answered is not reported as offline.
async function deferredThrowingRenderSession() {
  const current = throwingRenderSession(true);
  await settled(current.actions.initializeSession(current.use.captureAccountContext()));
  assert.ok(current.calls.some((entry) => Array.isArray(entry) && entry[0] === "notice"), "the session is deferred");
  current.calls.length = 0;
  return current;
}

function warnings(current) {
  return current.calls.filter((entry) => Array.isArray(entry) && entry[0] === "warn").map((entry) => entry[1]);
}

test("a session that answers while its settle render throws is not reported as offline", async () => {
  const current = await deferredThrowingRenderSession();
  const outcome = await settled(current.actions.restoreSessionAndSync(current.use.captureAccountContext()));
  assert.deepEqual(outcome, { settled: true, value: undefined });
  assert.ok(current.calls.some((entry) => Array.isArray(entry) && entry[0] === "sync"), "the session answered and synced");
  assert.ok(current.calls.includes("render"), "settling rendered");
  assert.deepEqual(warnings(current), ["Pomodorough could not render:"]);
  assert.equal(current.calls.includes("retry"), false, "no failure retry is scheduled");
  assert.equal(current.calls.includes("quarantine"), false);
});

test("a throwing settle render in the retry timer does not stop the retry chain", async (t) => {
  const session = await deferredThrowingRenderSession();
  const current = await viewFixture(t);
  const timers = [];
  current.host.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length; };
  current.use.settleDeferredSession = session.actions.settleDeferredSession;
  Object.assign(current.state, { authenticated: true, csrfToken: "csrf-ux" });
  current.use.scheduleRetry();
  assert.equal(timers.length, 1);
  // The timer body settles, then returns the synchronization it starts. A
  // settle that threw would leave before it, and nothing would retry again.
  const synchronization = timers[0].callback();
  assert.equal(typeof synchronization?.then, "function", "the retry went on to synchronize");
  await synchronization;
  assert.ok(session.calls.includes("render"), "the retry settled the deferred session");
  assert.deepEqual(warnings(session), ["Pomodorough could not render:"]);
});
