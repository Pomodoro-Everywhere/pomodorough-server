"use strict";

const test = require("node:test");
const incarnationFixture = require("./test/incarnation-fixture.js");
const assert = require("node:assert/strict");
const runtimeModule = require("./app-runtime.js");
const sessionModule = require("./app-session.js");
const actionModule = require("./app-actions.js");
const workspaceFixture = require("./test/p222-completion-fixture.js");

function runtimeModuleValue(name, fields = {}) {
  const manifest = {
    name, externals: [], requires: [], provides: [], emits: [], listens: [], ...fields.manifest
  };
  return { manifest, create: fields.create || (() => ({})) };
}

function installRuntimeModule(runtime, name, fields = {}) {
  const value = runtimeModuleValue(name, fields);
  runtime.install(value);
  return value;
}

test("runtime rejects malformed manifests and unavailable boundaries", () => {
  for (const value of [null, {}, { name: "" }]) {
    assert.throws(() => runtimeModule.validateManifest(value), /requires a name/);
  }
  for (const externals of ["host", [""], [1]]) {
    assert.throws(() => runtimeModule.validateManifest({ name: "bad", externals }), /string array/);
  }
  assert.throws(() => runtimeModule.validateManifest({ name: "bad", provides: ["same", "same"] }), /duplicates/);
  assert.throws(() => runtimeModule.createRuntime({ state: null, externals: {} }), /requires state/);
  assert.throws(() => runtimeModule.createRuntime({ state: {}, externals: null }), /requires externals/);

  const missingExternal = runtimeModule.createRuntime({ state: {}, externals: {} });
  assert.throws(() => installRuntimeModule(missingExternal, "external", {
    manifest: { externals: ["host"] }
  }), /external is unavailable/);
  const missingDependency = runtimeModule.createRuntime({ state: {}, externals: {} });
  installRuntimeModule(missingDependency, "dependent", { manifest: { requires: ["missing"] } });
  assert.throws(() => missingDependency.finalize(), /dependency is unavailable/);
});

test("runtime validates implementations, ownership, calls, and event contracts", () => {
  const invalidValues = [null, "value"];
  for (const implementation of invalidValues) {
    const runtime = runtimeModule.createRuntime({ state: {}, externals: {} });
    assert.throws(() => installRuntimeModule(runtime, "invalid", {
      manifest: { provides: ["run"] }, create: () => implementation
    }), /return an implementation/);
  }
  const arrayImplementation = runtimeModule.createRuntime({ state: {}, externals: {} });
  assert.throws(() => installRuntimeModule(arrayImplementation, "array", {
    manifest: { provides: ["run"] }, create: () => []
  }), /does not match/);
  const mismatch = runtimeModule.createRuntime({ state: {}, externals: {} });
  assert.throws(() => installRuntimeModule(mismatch, "mismatch", {
    manifest: { provides: ["run"] }, create: () => ({ other() {} })
  }), /does not match/);
  const nonFunction = runtimeModule.createRuntime({ state: {}, externals: {} });
  assert.throws(() => installRuntimeModule(nonFunction, "non-function", {
    manifest: { provides: ["run"] }, create: () => ({ run: 1 })
  }), /must be a function/);

  const runtime = runtimeModule.createRuntime({ state: {}, externals: {} });
  installRuntimeModule(runtime, "owner", { manifest: { provides: ["run"] }, create: () => ({ run: (value) => value + 1 }) });
  assert.throws(() => installRuntimeModule(runtime, "owner"), /Duplicate browser module/);
  assert.throws(() => installRuntimeModule(runtime, "other", {
    manifest: { provides: ["run"] }, create: () => ({ run() {} })
  }), /Duplicate browser action/);
  const finalized = runtime.finalize();
  assert.equal(finalized.call("run", 2), 3);
  assert.equal(finalized.facade(["run"]).run(3), 4);
  assert.throws(() => finalized.call("unknown"), /Unknown browser action/);
  assert.throws(() => finalized.facade(["unknown"]), /Unknown browser action/);
  assert.equal(finalized.describe()[0].name, "owner");
});

test("runtime routes valid revision events and fails closed on invalid event use", () => {
  const received = [];
  const runtime = runtimeModule.createRuntime({ state: {}, externals: {} });
  installRuntimeModule(runtime, "listener", {
    manifest: { listens: ["revision-hint"], provides: ["received"] },
    create: ({ listen }) => {
      listen("revision-hint", (payload) => received.push(payload));
      return { received: () => received };
    }
  });
  installRuntimeModule(runtime, "emitter", {
    manifest: { emits: ["revision-hint"], provides: ["send"] },
    create: ({ emit }) => ({ send: (payload) => emit("revision-hint", payload) })
  });
  const finalized = runtime.finalize();
  finalized.call("send", { revision: null });
  finalized.call("send", { revision: 9 });
  assert.deepEqual(received, [{ revision: null }, { revision: 9 }]);
  assert.throws(() => finalized.call("send", { revision: "9" }), /Invalid revision-hint/);

  const badListen = runtimeModule.createRuntime({ state: {}, externals: {} });
  assert.throws(() => installRuntimeModule(badListen, "bad-listen", {
    create: ({ listen }) => { listen("revision-hint", () => {}); return {}; }
  }), /cannot listen/);
  const unknownListen = runtimeModule.createRuntime({ state: {}, externals: {} });
  assert.throws(() => installRuntimeModule(unknownListen, "unknown-listen", {
    manifest: { listens: ["other"] }, create: ({ listen }) => { listen("other", () => {}); return {}; }
  }), /Unknown browser event/);
  const badHandler = runtimeModule.createRuntime({ state: {}, externals: {} });
  assert.throws(() => installRuntimeModule(badHandler, "bad-handler", {
    manifest: { listens: ["revision-hint"] }, create: ({ listen }) => { listen("revision-hint", 1); return {}; }
  }), /listener must be a function/);
  const badEmit = runtimeModule.createRuntime({ state: {}, externals: {} });
  assert.throws(() => installRuntimeModule(badEmit, "bad-emit", {
    create: ({ emit }) => { emit("revision-hint", { revision: 1 }); return {}; }
  }), /cannot emit/);
});

function sessionState(overrides = {}) {
  return {
    authenticated: true, sessionIdentityValidated: true, csrfToken: "csrf", user: incarnationFixture.accountUser("user-1"),
    localOwnerId: incarnationFixture.ownerId("user-1"), bootstrapGateOwned: false, bootstrapPending: null, bootstrapBlocked: false,
    quarantinedLocal: null, ready: true, retrying: false, syncing: false, offlineOwnerMode: false,
    pending: [], pendingTaskOperations: [], pendingDurationOperations: [], pendingAutoStartOperations: [],
    pendingSelectedTaskOperations: [], ...overrides
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

function dialogElement(tag) {
  const listeners = new Map();
  return {
    tag, children: [], textContent: "", value: "", open: false, focused: false,
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); },
    addEventListener(type, callback) { listeners.set(type, callback); },
    append(...kids) { this.children.push(...kids); },
    showModal() { this.open = true; },
    close() { this.open = false; },
    focus() { this.focused = true; },
    click(type = "click") { listeners.get(type)?.(); }
  };
}

function dialogDocument() {
  const created = [];
  const body = { appended: [], append(node) { this.appended.push(node); } };
  return { created, body, createElement(tag) { const el = dialogElement(tag); created.push(el); return el; } };
}

function sessionFixture(overrides = {}) {
  const state = sessionState(overrides.state);
  let database = {};
  const calls = [];
  const localStorage = overrides.localStorage || memoryStorage();
  const host = {
    navigator: { onLine: true }, localStorage, location: { assign: (value) => calls.push(["assign", value]) },
    console: { warn: (...args) => calls.push(["warn", ...args]) },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ user: incarnationFixture.accountUser("user-1"), csrfToken: "csrf-2" }) }),
    setTimeout: (callback) => { calls.push(["timeout", callback]); return 1; },
    document: dialogDocument(), confirm: () => true,
    EventSource: class { addEventListener() {} close() {} }, ...overrides.host
  };
  const syncCore = {
    ...incarnationFixture.sync,
    canUseCachedOwnerOffline: () => false,
    postJSONWithCsrfRetry: async ({ onTiming }) => { onTiming({ requestAtMs: 1 }); return { ok: true }; },
    ...overrides.syncCore
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
    renderSyncStatus: () => calls.push("status"), showNotice: (value) => calls.push(["notice", value]),
    quarantineOwnerState: () => calls.push("quarantine"), restoreOwnerState: () => calls.push("restore"),
    restartBootstrapForCurrentAccount: async () => calls.push("restart"), prepareBootstrap: async () => calls.push("prepare"),
    syncNow: async (force) => calls.push(["sync", force]), scheduleSync: () => calls.push("scheduleSync"),
    scheduleRetry: () => calls.push("retry"), resetSyncRetry: () => calls.push("resetRetry"),
    refreshAllPendingOperations: async () => {}, ...overrides.use
  };
  const elements = { deleteAccountButton: { disabled: false }, logoutButton: { disabled: false } };
  const actions = sessionModule.create({ state, external: { host, syncCore, syncStorage, elements }, use,
    emit: (type, value) => calls.push([type, value]) });
  return { actions, calls, elements, host, localStorage, state, syncCore, syncStorage, use };
}

test("session stream gates, parses hints, polls, and closes offline", () => {
  const sources = [];
  class EventSource {
    constructor(url) { this.url = url; this.listeners = {}; sources.push(this); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    close() { this.closed = true; }
  }
  const fixture = sessionFixture({ host: { EventSource } });
  fixture.actions.openRevisionStream();
  fixture.actions.openRevisionStream();
  sources[0].onmessage({ data: "7" });
  sources[0].listeners.revision({ data: "{\"revision\":8}" });
  sources[0].onmessage({ data: "bad" });
  assert.deepEqual(fixture.calls.filter((entry) => entry[0] === "revision-hint").map((entry) => entry[1]),
    [{ revision: 7 }, { revision: 8 }, { revision: null }]);
  assert.equal(fixture.actions.pollRemoteState((force) => fixture.calls.push(["poll", force])), true);
  fixture.host.navigator.onLine = false;
  sources[0].onerror();
  assert.equal(sources[0].closed, true);
  assert.equal(fixture.actions.pollRemoteState(), false);
  fixture.actions.closeRevisionStreamForIdentityChange(incarnationFixture.ownerId("user-1"));
  fixture.actions.setRevisionStreamForTest({ close: () => fixture.calls.push("manualClose") });
  fixture.actions.closeRevisionStreamForIdentityChange(incarnationFixture.ownerId("user-2"));
  assert.equal(fixture.actions.hasRevisionStreamForTest(), false);
});

test("session payload checks preserve sign-out and account-switch guarantees", async () => {
  const unauthorized = sessionFixture({ localStorage: memoryStorage({ pomodoroughPendingLogout: "1" }),
    host: { fetch: async () => ({ status: 401 }) } });
  assert.equal(await unauthorized.actions.fetchSessionPayload(unauthorized.use.captureAccountContext()), null);
  assert.equal(unauthorized.localStorage.getItem("pomodoroughPendingLogout"), null);
  assert.equal(unauthorized.calls.filter((entry) => entry[0] === "assign").length, 1);
  unauthorized.actions.redirectToLogin();
  assert.equal(unauthorized.calls.filter((entry) => entry[0] === "assign").length, 1);

  const failed = sessionFixture({ host: { fetch: async () => ({ status: 503, ok: false }) } });
  await assert.rejects(() => failed.actions.fetchSessionPayload(failed.use.captureAccountContext()), /503/);
  const switched = sessionFixture({ host: { fetch: async () => ({ ok: true, status: 200,
    json: async () => ({ user: incarnationFixture.accountUser("user-2"), csrfToken: "new" }) }) } });
  assert.equal(await switched.actions.loadSession(), true);
  assert.ok(switched.calls.includes("quarantine"));
  assert.ok(switched.calls.includes("restart"));
  await assert.rejects(() => switched.actions.refreshMutationCsrf(incarnationFixture.ownerId("user-1"), switched.use.captureAccountContext()), /account changed/i);

  const signedOut = sessionFixture();
  signedOut.actions.setFetchForTest(async () => ({ status: 401 }));
  await assert.rejects(() => signedOut.actions.refreshMutationCsrf(incarnationFixture.ownerId("user-1"), signedOut.use.captureAccountContext()), /requires sign-in/i);
});

test("pending sign-out cleans up before revocation and retains marker when revocation is unavailable", async () => {
  const deferred = sessionFixture({ localStorage: memoryStorage({ pomodoroughPendingLogout: "1" }),
    host: { fetch: async () => ({ ok: true, status: 200, json: async () => ({ user: incarnationFixture.accountUser("user-1"), csrfToken: null }) }) } });
  await assert.rejects(() => deferred.actions.loadSession(), /could not be revoked/i);
  assert.ok(deferred.calls.includes("clear"));
  assert.equal(deferred.localStorage.getItem("pomodoroughPendingLogout"), "1");

  let request = 0;
  const completed = sessionFixture({ localStorage: memoryStorage({ pomodoroughPendingLogout: "1" }),
    host: { fetch: async (url) => {
      request += 1;
      if (!url.endsWith("/me")) assert.ok(completed.calls.includes("clear"));
      return url.endsWith("/me")
        ? { ok: true, status: 200, json: async () => ({ user: incarnationFixture.accountUser("user-1"), csrfToken: "fresh" }) }
        : { ok: false, status: 401 };
    } } });
  assert.equal(await completed.actions.loadSession(), false);
  assert.equal(request, 2);
  assert.equal(completed.localStorage.getItem("pomodoroughPendingLogout"), null);
  assert.ok(completed.calls.includes("clear"));
});

test("offline restoration and cleanup fail closed around unavailable storage", async () => {
  const localStorage = {
    getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); }
  };
  const fixture = sessionFixture({ state: { quarantinedLocal: { user: incarnationFixture.accountUser("user-1") } }, localStorage,
    syncCore: { canUseCachedOwnerOffline: () => true }, syncStorage: { clearBootstrapGate: async () => { throw new Error("busy"); } } });
  assert.equal(await fixture.actions.activateCachedOwnerOffline(), false);
  assert.equal(fixture.actions.pendingLocalLogout(), false);
  fixture.actions.markPendingLogout();
  fixture.actions.clearPendingLogout();
  assert.equal((await fixture.actions.clearPendingLogoutData(undefined, fixture.use.captureAccountContext())).cleared, true);

  fixture.actions.setStorageMethodForTest("clearBootstrapGate", async () => {});
  assert.equal(await fixture.actions.activateCachedOwnerOffline(), true);
  assert.equal(fixture.state.offlineOwnerMode, true);
  const cleanup = sessionFixture({ localStorage: memoryStorage({ pomodoroughPendingLogout: "1" }),
    use: { clearLocalData: async () => { throw new Error("disk full"); } } });
  assert.equal((await cleanup.actions.clearPendingLogoutData(undefined, cleanup.use.captureAccountContext())).cleared, false);
  assert.ok(cleanup.calls.some((entry) => entry[0] === "notice" && /disk full/.test(entry[1])));
});

test("session restore chooses bootstrap, normal sync, and retry recovery", async () => {
  const bootstrap = sessionFixture({ use: { needsBootstrapResolution: () => true } });
  await bootstrap.actions.restoreSessionAndSync(bootstrap.use.captureAccountContext());
  assert.ok(bootstrap.calls.includes("prepare"));

  const normal = sessionFixture();
  await normal.actions.restoreSessionAndSync(normal.use.captureAccountContext());
  assert.ok(normal.calls.some((entry) => entry[0] === "sync" && entry[1] === true));

  const retry = sessionFixture({ state: { authenticated: false, sessionIdentityValidated: false, csrfToken: null },
    host: { fetch: async () => { throw new Error("offline"); } }, syncCore: { canUseCachedOwnerOffline: () => false } });
  await retry.actions.restoreSessionAndSync(retry.use.captureAccountContext());
  assert.equal(retry.state.retrying, true);
  assert.ok(retry.calls.includes("retry"));
  retry.actions.handleOffline();
  assert.equal(retry.state.syncing, false);
  retry.actions.handleOnline();
  assert.ok(retry.calls.includes("resetRetry"));
});

test("account deletion dialog, validation, HTTP failure, and cleanup retry preserve data", async () => {
  const opened = sessionFixture({ host: { prompt: () => { throw new Error("blocking prompt"); } } });
  await opened.actions.deleteAccount();
  const dialog = opened.host.document.body.appended[0];
  assert.equal(dialog.open, true);
  assert.match(dialog.children[1].textContent, /Type DELETE/);
  assert.ok(opened.calls.some((entry) => entry[0] === "timeout"));
  await opened.actions.cancelDeleteAccount();
  assert.equal(dialog.open, false);
  assert.equal(opened.calls.includes("clear"), false);

  const invalid = sessionFixture();
  await invalid.actions.deleteAccount("delete");
  assert.ok(invalid.calls.some((entry) => entry[0] === "notice" && /Type DELETE exactly/.test(entry[1])));
  const offline = sessionFixture({ state: { csrfToken: null } });
  await offline.actions.deleteAccount("DELETE");
  assert.ok(offline.calls.some((entry) => entry[0] === "notice" && /Connect to the account server/.test(entry[1])));

  const rejected = sessionFixture({ host: { fetch: async () => ({ ok: false, status: 500 }) } });
  await rejected.actions.deleteAccount("DELETE");
  assert.equal(rejected.elements.deleteAccountButton.disabled, false);
  assert.equal(rejected.calls.includes("clear"), false);

  const cleanup = sessionFixture({ host: { fetch: async () => ({ ok: true }) },
    use: { clearLocalData: async () => { throw new Error("locked"); } } });
  await cleanup.actions.deleteAccount("DELETE");
  assert.equal(cleanup.localStorage.getItem("pomodoroughPendingLogout"), "1");
  assert.ok(cleanup.calls.some((entry) => entry[0] === "assign"));

  const confirmed = sessionFixture({ host: { fetch: async () => ({ ok: true }) } });
  await confirmed.actions.deleteAccount();
  confirmed.host.document.body.appended[0].children[2].value = "DELETE";
  await confirmed.actions.confirmDeleteAccount();
  assert.ok(confirmed.calls.some((entry) => entry[0] === "assign"));
});

test("logout cancellation and deferred revocation retain the durable retry marker", async () => {
  const cancelled = sessionFixture({ state: { pending: [{}] }, host: { confirm: () => false } });
  await cancelled.actions.logout();
  assert.equal(cancelled.elements.logoutButton.disabled, false);
  assert.equal(cancelled.localStorage.getItem("pomodoroughPendingLogout"), null);

  const deferred = sessionFixture({ state: { pending: [{}, {}] },
    host: { confirm: () => true, fetch: async () => { throw new Error("offline"); } },
    use: { refreshAllPendingOperations: async () => { throw new Error("db busy"); }, clearLocalData: async () => { throw new Error("disk busy"); } } });
  await deferred.actions.logout();
  assert.equal(deferred.localStorage.getItem("pomodoroughPendingLogout"), null);
  assert.equal(deferred.elements.logoutButton.disabled, false);
  assert.equal(deferred.calls.filter((entry) => entry[0] === "warn").length, 1);

  const completed = sessionFixture({ host: { fetch: async () => ({ ok: true, status: 200 }) } });
  await completed.actions.logout();
  assert.equal(completed.localStorage.getItem("pomodoroughPendingLogout"), null);
  assert.ok(completed.calls.includes("clear"));
});

function actionBranchFixture(overrides = {}) {
  const state = {
    ready: true, actionLocked: false, autoStartBreaks: false, selectedTaskId: null,
    selectedPhase: "focus", durationsMs: { focus: 1000, short_break: 500, long_break: 800 },
    tasks: [], history: [], pending: [], pendingTaskOperations: [], pendingDurationOperations: [],
    pendingAutoStartOperations: [], pendingSelectedTaskOperations: [], deviceId: "device",
    timer: { id: "timer", phase: "focus", status: "running", plannedDurationMs: 1000 }, ...overrides.state
  };
  const calls = [];
  const timers = [];
  const host = {
    crypto: { randomUUID: () => "break" }, Notification: undefined,
    console: { warn: (...args) => calls.push(["warn", ...args]) },
    clearTimeout: (id) => calls.push(["clearTimeout", id]), clearInterval: (id) => calls.push(["clearInterval", id]),
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    setInterval: (callback, delay) => { calls.push(["interval", callback, delay]); return 4; }, ...overrides.host
  };
  const syncStorage = {
    AccountOwnershipError: incarnationFixture.storage.AccountOwnershipError,
    finishTimer: async () => ({ transitioned: false, reason: "already_finished" }),
    cancelAndClearTimer: async () => ({ transitioned: false }), renewTimerOwnership: async () => {}, ...overrides.syncStorage
  };
  const operation = (kind) => ({ id: kind, type: kind, deviceSequence: 2, hlcWallMs: 3, hlcCounter: 4 });
  const use = {
    captureAccountContext: () => incarnationFixture.captureAccountContext(state, host),
    controlsBlocked: () => false, persistDurationOperation: async () => ({ pendingDurationOperations: [operation("duration")] }),
    assertExpectedAccount: (expectedUserId) => assert.equal(incarnationFixture.sync.accountOwnerId(state.user) || state.localOwnerId || null, expectedUserId),
    persistAutoStartOperation: async () => operation("auto"), persistSelectedTaskOperation: async () => operation("selected"),
    persistTaskOperation: async () => operation("task"), persistCommand: async () => operation("command"),
    persistRetargetState: async () => {}, reapplyRetargetToPending: () => {},
    database: () => ({}), settingsValue: () => ({}), rebuildOptimisticState: () => calls.push("rebuild"),
    sharedTaskIdentity: async (title) => ({ id: title.toLowerCase(), title }), clone: structuredClone,
    trustedNow: () => 2000, elapsedFor: () => 1000, tr: (_key, _values, fallback) => fallback,
    phaseLabel: (phase) => phase, phaseConfig: () => ({ focus: {}, short_break: {}, long_break: {} }),
    tabId: () => "tab", render: () => calls.push("render"), renderDurations: () => calls.push("durations"),
    renderTaskSelector: () => calls.push("selector"), renderTimer: () => calls.push("timer"),
    renderSyncStatus: () => calls.push("status"), showNotice: (message) => calls.push(["notice", message]),
    scheduleSync: (delay) => calls.push(["sync", delay]), ...overrides.use
  };
  const actions = actionModule.create({ state, external: { host, syncStorage, syncCore: incarnationFixture.sync }, use });
  return { actions, calls, state, syncStorage, timers, use };
}

test("durable action mutations cover writes, no-ops, and translated failures", async (t) => {
  const { client, core } = await workspaceFixture.fixture(t);
  await workspaceFixture.seedMeta(client.use.database(), { canonicalHead: { wallMs: workspaceFixture.nowMs, counter: 2 } });
  assert.equal(await client.use.issueDurationOperation("focus", 1500000), false);
  assert.equal(await client.use.issueDurationOperation("focus", 1800000), true);
  assert.equal(await client.use.issueAutoStartOperation(true), true);
  assert.equal(await client.use.issueAutoStartOperation(true), false);
  const task = core.taskIdentity({ title: "Current task" });
  assert.equal(await client.use.issueTaskOperation("upsert", task), true);
  assert.equal(await client.use.issueSelectedTaskOperation(task.id), true);
  assert.equal(await client.use.issueSelectedTaskOperation(task.id), false);
  await workspaceFixture.startFocus(client);
  assert.equal(await client.use.issueCommand("pause"), true);
  client.state.actionLocked = true;
  assert.equal(await client.use.issueTaskOperation("delete", task), false);
  assert.equal(await client.use.issueCommand("resume"), false);
  client.state.actionLocked = false;
  const database = client.use.database();
  const transaction = database.transaction.bind(database);
  database.transaction = (...argumentsList) => {
    const current = transaction(...argumentsList);
    const objectStore = current.objectStore.bind(current);
    current.objectStore = (name) => {
      const store = objectStore(name);
      if (name === "pendingDurations" && current.mode === "readwrite") store.add = () => { throw new Error(""); };
      return store;
    };
    return current;
  };
  const before = await workspaceFixture.dump(database);
  assert.equal(await client.use.issueDurationOperation("focus", 2100000), false);
  assert.deepEqual(await workspaceFixture.dump(database), before);
  assert.ok(client.notices.some((message) => /Duration change/.test(message)));
});

test("task identity distinguishes duplicates and validation failures", async (t) => {
  const { client, core } = await workspaceFixture.fixture(t);
  await workspaceFixture.seedMeta(client.use.database(), { canonicalHead: { wallMs: workspaceFixture.nowMs, counter: 2 } });
  client.external.sharedCoreHost.SharedCore = { load: async () => core };
  assert.equal(await client.use.addTask("Deep"), true);
  const before = await workspaceFixture.dump(client.use.database());
  assert.equal(await client.use.addTask("Deep"), true);
  const after = await workspaceFixture.dump(client.use.database());
  assert.deepEqual(after.pendingTasks, before.pendingTasks);
  assert.equal(await client.use.deleteTask(client.state.tasks[0]), true);
  for (const [message, expected] of [["must not be empty", /printable/], ["over 512 bytes", /too long/]]) {
    const invalid = actionBranchFixture({ use: { sharedTaskIdentity: async () => { throw new Error(message); } } });
    await assert.rejects(() => invalid.actions.addTask("bad"), expected);
  }
  const unexpected = actionBranchFixture({ use: { sharedTaskIdentity: async () => { throw new Error("core unavailable"); } } });
  await assert.rejects(() => unexpected.actions.addTask("bad"), /core unavailable/);
});

test("S43 unexpected task identity failure warns and reports while validation stays silent", async (t) => {
  const reports = [];
  const previous = globalThis.PomodoroughSentryClient;
  globalThis.PomodoroughSentryClient = { reportFrontendError: (error, operation) => reports.push([error, operation]) };
  t.after(() => {
    if (previous === undefined) delete globalThis.PomodoroughSentryClient;
    else globalThis.PomodoroughSentryClient = previous;
  });
  for (const message of ["title must not be empty or non-printable", "title exceeds 512 bytes"]) {
    const invalid = actionBranchFixture({ use: { sharedTaskIdentity: async () => { throw new Error(message); } } });
    await assert.rejects(() => invalid.actions.addTask("bad"));
    assert.ok(!invalid.calls.some((entry) => Array.isArray(entry) && entry[0] === "warn"));
  }
  assert.equal(reports.length, 0);
  const unexpected = actionBranchFixture({ use: { sharedTaskIdentity: async () => { throw new Error("core unavailable"); } } });
  await assert.rejects(() => unexpected.actions.addTask("bad"), /core unavailable/);
  assert.ok(unexpected.calls.some((entry) => Array.isArray(entry) && entry[0] === "warn"
    && /Pomodorough task identity failed:/.test(entry[1])));
  assert.equal(reports.length, 1);
  assert.equal(reports[0][1], "actions.task.identity-failed");
  assert.match(reports[0][1], /^[a-z0-9][a-z0-9.-]*$/);
});

function finishResultCommand(overrides = {}) {
  return {
    id: "finish", deviceId: "device", deviceSequence: 8, timerId: "timer", type: "finish",
    phase: "focus", plannedDurationMs: 60_000, occurredAt: "1970-01-01T00:00:02.000Z",
    hlcWallMs: 2000, hlcCounter: 1, observedElapsedMs: 1000, ...overrides
  };
}

function finishActionBranchFixture(overrides = {}) {
  return actionBranchFixture({
    ...overrides,
    state: {
      durationsMs: { focus: 60_000, short_break: 300_000, long_break: 900_000 },
      timer: { id: "timer", phase: "focus", status: "running", plannedDurationMs: 60_000 },
      ...overrides.state
    }
  });
}

test("timer finish, ownership retry, and cancellation preserve atomic outcomes", async (t) => {
  const { client, open } = await workspaceFixture.fixture(t, { autoStartBreaks: true });
  await workspaceFixture.seedMeta(client.use.database(), { canonicalHead: { wallMs: workspaceFixture.nowMs, counter: 2 } });
  await workspaceFixture.startFocus(client);
  const peer = await open();
  await peer.use.reloadPersistedState();
  peer.use.trustedNow = () => workspaceFixture.nowMs + 1500000;
  const before = await workspaceFixture.dump(client.use.database());
  assert.equal(await peer.use.finishTimer(true), true);
  assert.deepEqual(await workspaceFixture.dump(client.use.database()), before);
  assert.equal(await client.use.finishTimer(false), true);
  const after = await workspaceFixture.dump(client.use.database());
  const finish = after.pending.find((command) => command.type === "finish");
  const generated = after.pending.find((command) => command.generatedBreak);
  assert.equal(generated.dependsOnCommandId, finish.id);
  assert.equal(await client.use.cancelAndClearTimer(), true);
  const cancelled = await workspaceFixture.dump(client.use.database());
  assert.deepEqual(cancelled.pending.slice(-2).map((command) => command.type), ["cancel", "clear"]);
  assert.equal(client.use.completionRetryDelay({ reason: "other" }), null);
  assert.equal(client.use.completionRetryDelay({ reason: "not_owner", retryAtMs: "bad" }, 1000), 15001);
});

test("dependent finish command accepts its exact optional producer key", async (t) => {
  const { client } = await workspaceFixture.fixture(t, { autoStartBreaks: true });
  await workspaceFixture.seedMeta(client.use.database(), { canonicalHead: { wallMs: workspaceFixture.nowMs, counter: 2 } });
  await workspaceFixture.startFocus(client);
  assert.equal(await client.use.finishTimer(false), true);
  const generated = client.state.pending.find((command) => command.generatedBreak);
  assert.equal(await client.use.finishTimer(false), true);
  const finish = client.state.pending.at(-1);
  assert.equal(finish.dependsOnCommandId, generated.id);
  assert.equal(finish.timerId, generated.timerId);
  assert.equal(finish.type, "finish");
});

test("malformed successful finish leaves caller state unchanged", async () => {
  const command = finishResultCommand();
  const malformed = finishActionBranchFixture({
    state: {
      pending: [{ id: "existing" }], deviceSequence: 5, hlcWallMs: 6, hlcCounter: 7
    },
    syncStorage: { finishTimer: async () => ({
      transitioned: true, reason: "", selectedPhaseDurationMs: 300_000, commands: [command]
    }) }
  });
  const before = structuredClone({
    selectedPhase: malformed.state.selectedPhase,
    pending: malformed.state.pending,
    deviceSequence: malformed.state.deviceSequence,
    hlcWallMs: malformed.state.hlcWallMs,
    hlcCounter: malformed.state.hlcCounter
  });

  assert.equal(await malformed.actions.finishTimer(false), false);
  assert.deepEqual({
    selectedPhase: malformed.state.selectedPhase,
    pending: malformed.state.pending,
    deviceSequence: malformed.state.deviceSequence,
    hlcWallMs: malformed.state.hlcWallMs,
    hlcCounter: malformed.state.hlcCounter
  }, before);
  assert.equal(malformed.calls.includes("rebuild"), false);
  assert.equal(malformed.calls.includes("render"), false);
  assert.equal(malformed.calls.some((entry) => entry[0] === "sync"), false);
  assert.ok(malformed.calls.some((entry) => entry[0] === "notice"));
});

test("successful finish without commands leaves caller state unchanged", async () => {
  const malformed = finishActionBranchFixture({
    state: {
      pending: [{ id: "existing" }], deviceSequence: 5, hlcWallMs: 6, hlcCounter: 7
    },
    syncStorage: {
      finishTimer: async () => ({
        transitioned: true, reason: "", selectedPhase: "short_break",
        selectedPhaseDurationMs: 300_000, commands: []
      })
    }
  });
  const before = structuredClone({
    selectedPhase: malformed.state.selectedPhase,
    pending: malformed.state.pending,
    deviceSequence: malformed.state.deviceSequence,
    hlcWallMs: malformed.state.hlcWallMs,
    hlcCounter: malformed.state.hlcCounter
  });

  assert.equal(await malformed.actions.finishTimer(false), false);
  assert.deepEqual({
    selectedPhase: malformed.state.selectedPhase,
    pending: malformed.state.pending,
    deviceSequence: malformed.state.deviceSequence,
    hlcWallMs: malformed.state.hlcWallMs,
    hlcCounter: malformed.state.hlcCounter
  }, before);
  assert.equal(malformed.calls.includes("rebuild"), false);
  assert.equal(malformed.calls.includes("render"), false);
  assert.equal(malformed.calls.some((entry) => entry[0] === "sync"), false);
});

test("successful finish with invalid terminal command leaves caller state unchanged", async () => {
  const malformed = finishActionBranchFixture({
    state: {
      pending: [{ id: "existing" }], deviceSequence: 5, hlcWallMs: 6, hlcCounter: 7
    },
    syncStorage: {
      finishTimer: async () => ({
        transitioned: true, reason: "", selectedPhase: "short_break",
        selectedPhaseDurationMs: 300_000, commands: [finishResultCommand({ hlcCounter: "bad" })]
      })
    }
  });
  const before = structuredClone({
    selectedPhase: malformed.state.selectedPhase,
    pending: malformed.state.pending,
    deviceSequence: malformed.state.deviceSequence,
    hlcWallMs: malformed.state.hlcWallMs,
    hlcCounter: malformed.state.hlcCounter
  });

  assert.equal(await malformed.actions.finishTimer(false), false);
  assert.deepEqual({
    selectedPhase: malformed.state.selectedPhase,
    pending: malformed.state.pending,
    deviceSequence: malformed.state.deviceSequence,
    hlcWallMs: malformed.state.hlcWallMs,
    hlcCounter: malformed.state.hlcCounter
  }, before);
  assert.equal(malformed.calls.includes("rebuild"), false);
  assert.equal(malformed.calls.includes("render"), false);
  assert.equal(malformed.calls.some((entry) => entry[0] === "sync"), false);
});

test("metadata-only finish command is rejected before caller mutation", async () => {
  const partial = { id: "finish", deviceSequence: 8, hlcWallMs: 9, hlcCounter: 1 };
  const malformed = finishActionBranchFixture({ syncStorage: {
    finishTimer: async () => ({
      transitioned: true, reason: "", selectedPhase: "short_break",
      selectedPhaseDurationMs: 300_000, commands: [partial]
    })
  } });

  assert.equal(await malformed.actions.finishTimer(false), false);
  assert.equal(malformed.state.selectedPhase, "focus");
  assert.deepEqual(malformed.state.pending, []);
  assert.equal(malformed.calls.includes("rebuild"), false);
  assert.equal(malformed.calls.includes("render"), false);
  assert.equal(malformed.calls.some((entry) => entry[0] === "sync"), false);
});

test("producer-impossible finish relationships are rejected before caller mutation", async () => {
  const validBreak = {
    id: "break-start", deviceId: "device", deviceSequence: 9, timerId: "break", type: "start",
    phase: "short_break", plannedDurationMs: 300_000, occurredAt: "1970-01-01T00:00:02.000Z",
    hlcWallMs: 2000, hlcCounter: 2, observedElapsedMs: 0, dependsOnCommandId: "finish",
    generatedBreak: true
  };
  const cases = [
    { finish: { plannedDurationMs: 999 } },
    { generated: { timerId: "rogue-break" } },
    { finish: { occurredAt: "1970-01-01T00:00:00.010Z" }, generated: { occurredAt: "1970-01-01T00:00:00.010Z" } },
    { generated: { plannedDurationMs: 777 } }
  ];
  for (const item of cases) {
    const finish = finishResultCommand(item.finish);
    const generated = { ...validBreak, ...item.generated };
    const malformed = finishActionBranchFixture({ syncStorage: {
      finishTimer: async () => ({
        transitioned: true, reason: "", selectedPhase: "short_break",
        selectedPhaseDurationMs: 300_000, commands: [finish, generated]
      })
    } });
    assert.equal(await malformed.actions.finishTimer(false), false);
    assert.equal(malformed.state.selectedPhase, "focus");
    assert.deepEqual(malformed.state.pending, []);
    assert.equal(malformed.calls.includes("rebuild"), false);
    assert.equal(malformed.calls.includes("render"), false);
    assert.equal(malformed.calls.some((entry) => entry[0] === "sync"), false);
  }
});

test("finish result rejects unexpected keys and producer-impossible duration bounds", async () => {
  const command = finishResultCommand();
  const valid = {
    transitioned: true, reason: "", selectedPhase: "short_break",
    selectedPhaseDurationMs: 300_000, commands: [command]
  };
  const cases = [
    { ...valid, unexpected: true },
    { ...valid, commands: [{ ...command, unexpected: true }] },
    { ...valid, selectedPhaseDurationMs: 59_999 },
    { ...valid, selectedPhaseDurationMs: 14_400_001 }
  ];
  for (const outcome of cases) {
    const malformed = finishActionBranchFixture({ syncStorage: { finishTimer: async () => outcome } });
    assert.equal(await malformed.actions.finishTimer(false), false);
    assert.equal(malformed.state.selectedPhase, "focus");
    assert.deepEqual(malformed.state.pending, []);
    assert.equal(malformed.calls.includes("rebuild"), false);
    assert.equal(malformed.calls.includes("render"), false);
    assert.equal(malformed.calls.some((entry) => entry[0] === "sync"), false);
  }
});

test("nonboolean finish transition is rejected before caller mutation", async () => {
  const command = finishResultCommand();
  const malformed = finishActionBranchFixture({ syncStorage: {
    finishTimer: async () => ({
      transitioned: "true", reason: "", selectedPhase: "short_break",
      selectedPhaseDurationMs: 300_000, commands: [command]
    })
  } });

  assert.equal(await malformed.actions.finishTimer(false), false);
  assert.equal(malformed.state.selectedPhase, "focus");
  assert.deepEqual(malformed.state.pending, []);
  assert.equal(malformed.calls.includes("rebuild"), false);
  assert.equal(malformed.calls.includes("render"), false);
  assert.equal(malformed.calls.some((entry) => entry[0] === "sync"), false);
});

test("completion alerts cover audio, notifications, dismissal, and ownership heartbeat", async () => {
  const audioCalls = [];
  class AudioContext {
    constructor() { this.state = "suspended"; this.destination = {}; this.currentTime = 1; }
    async resume() { this.state = "running"; audioCalls.push("resume"); }
    createOscillator() { return { frequency: {}, connect() {}, start: () => audioCalls.push("start"), stop() {} }; }
    createGain() { return { gain: {}, connect() {} }; }
  }
  class Notification {
    static permission = "default";
    static async requestPermission() { Notification.permission = "granted"; }
    constructor(title) { this.title = title; }
    close() { audioCalls.push("close"); }
  }
  const f = actionBranchFixture({ host: { AudioContext, Notification } });
  const database = {};
  f.use.database = () => database;
  f.use.captureDatabaseContext = () => incarnationFixture.captureAccountContext(f.state, {}, () => database);
  assert.equal(f.actions.startCompletionAlert(null), false);
  assert.equal(f.actions.startCompletionAlert({ id: "timer", phase: "unknown" }), true);
  assert.equal(f.actions.startCompletionAlert({ id: "timer", phase: "focus" }), false);
  await f.actions.primeCompletionAlerts();
  assert.ok(audioCalls.includes("resume"));
  assert.ok(audioCalls.includes("start"));
  f.actions.stopCompletionAlert();
  assert.equal(f.actions.completionAlertDismissedTimerIDTest(), "timer");
  assert.equal(f.actions.startCompletionAlert({ id: "timer", phase: "focus" }), false);
  let renewed = null;
  f.syncStorage.renewTimerOwnership = async (issuedDatabase, input) => {
    assert.equal(issuedDatabase, database);
    input.assertCurrent();
    renewed = input;
  };
  await f.actions.heartbeatTimerOwnership();
  assert.equal(renewed.timerId, "timer");
  f.state.ready = false;
  renewed = null;
  f.actions.heartbeatTimerOwnership();
  assert.equal(renewed, null);
});
