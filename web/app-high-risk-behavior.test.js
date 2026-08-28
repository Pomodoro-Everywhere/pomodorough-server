"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { indexedDB, IDBKeyRange } = require("fake-indexeddb");
const storageModule = require("./app-storage.js");
const actionModule = require("./app-actions.js");
const syncModule = require("./app-sync.js");
const bootstrapModule = require("./app-bootstrap.js");
const viewModule = require("./app-view.js");

function state(overrides = {}) {
  return {
    actionLocked: false, activeScreen: "timer", authenticated: true, autoStartBreaks: false,
    baseAutoStartBreaks: false, baseDurationsMs: { focus: 1_500_000, short_break: 300_000 },
    baseHistory: [], baseSelectedTaskId: null, baseTasks: [], baseTimer: { status: "idle" },
    bootstrapBlocked: false, bootstrapError: null, bootstrapGateOwned: false,
    bootstrapGatePersisted: false, bootstrapLimitError: null, bootstrapPending: null,
    bootstrapPlan: null, bootstrapPreview: null, bootstrapStrategy: null, bootstrapSubmitting: false,
    clockOffset: 0, conflict: null, csrfToken: "csrf", deviceId: "device-1", deviceSequence: 0,
    durationSyncBootstrapped: true, durationsMs: { focus: 1_500_000, short_break: 300_000 },
    history: [], hlcCounter: 0, hlcWallMs: 0, localOwnerId: "user-1", pending: [],
    pendingAutoStartOperations: [], pendingDurationOperations: [], pendingSelectedTaskOperations: [],
    pendingTaskOperations: [], ready: true, retrying: false, revision: 2,
    selectedPhase: "focus", selectedTaskId: null, sessionIdentityValidated: true,
    syncing: false, tasks: [], timer: { status: "idle" }, user: { id: "user-1" },
    ...overrides
  };
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function deleteTestDatabase() {
  await requestResult(indexedDB.deleteDatabase(storageModule.DB_NAME));
}

function storageFixture(overrides = {}) {
  const current = state(overrides.state);
  let uuid = 0;
  const host = {
    indexedDB, IDBKeyRange, crypto: { randomUUID: () => `uuid-${++uuid}` },
    setTimeout: (callback) => { callback(); return 1; }
  };
  const syncCore = {
    validClockSample: (value) => Number.isFinite(value), compareTimerCommands: (a, b) => a.id.localeCompare(b.id)
  };
  const syncStorage = {
    acquireBootstrapGateWithLegacyAutoStart: async () => ({ acquired: true }),
    readBootstrapState: async () => ({ gate: null, resolution: null }),
    normalizeLegacyDurationOperations: async () => ({ resolution: null }),
    guardedMutation: async (db, stores, callback) => {
      const tx = db.transaction([storageModule.META_STORE, ...stores], "readwrite");
      callback(tx);
      await transactionDone(tx);
    },
    allocateMutation: async (_db, options) => options.build({
      id: `operation-${++uuid}`, deviceSequence: 7, wallMs: 1_700_000_000_000 + uuid, counter: uuid
    }),
    readQueues: async () => ({ durationOperations: [] }),
    ...overrides.syncStorage
  };
  const use = {
    clone: (value) => structuredClone(value), emptyTimer: (phase, plannedDurationMs) => ({ status: "idle", phase, plannedDurationMs }),
    normalizeTimer: (value) => ({ ...value, normalized: true }), normalizeDurationsMs: (value) => ({ ...value }),
    selectedDurationMs: () => current.durationsMs[current.selectedPhase], selectedTaskIdForNextFocus: () => current.selectedTaskId,
    compareDurationOperations: (a, b) => a.id.localeCompare(b.id), compareTimerCommands: syncCore.compareTimerCommands,
    clampNumber: (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, Number(value))),
    trustedNow: (value = 1_700_000_000_000) => value, elapsedFor: () => 1234,
    rebuildOptimisticState: () => {}, quarantineOwnerState: () => {}, projectOwnerState: () => {},
    tr: (_key, _args, fallback) => fallback, phaseConfig: () => ({ focus: {}, short_break: {} }),
    defaultDurationsMs: () => ({ focus: 1_500_000, short_break: 300_000 }), tabId: () => "tab-1"
  };
  const actions = storageModule.create({ state: current, external: { host, syncCore, syncStorage }, use });
  return { actions, current, host, syncStorage, use };
}

test("storage first launch persists identity and restores canonical records after reopening", async () => {
  await deleteTestDatabase();
  const first = storageFixture();
  await first.actions.loadLocalState();
  const deviceId = first.current.deviceId;
  assert.equal(deviceId.startsWith("uuid-"), true);
  assert.equal(first.current.bootstrapGateOwned, true);
  first.actions.database().close();

  const second = storageFixture();
  await second.actions.loadLocalState();
  assert.equal(second.current.deviceId, deviceId);
  assert.equal(second.current.deviceSequence, 0);
  await second.actions.clearLocalData();
  assert.equal(second.actions.database(), null);
});

test("storage mutation builders preserve timer ownership, task identity, and in-flight duration writes", async () => {
  const captured = [];
  const fixture = storageFixture({ syncStorage: {
    allocateMutation: async (_db, options) => {
      captured.push(options);
      return options.build({ id: `id-${captured.length}`, deviceSequence: 9, wallMs: 1000, counter: 2 });
    },
    readQueues: async () => ({ durationOperations: [{ id: "new", phase: "focus" }] })
  } });
  fixture.actions.setDatabaseForTest({});
  fixture.current.selectedTaskId = "task-1";
  const command = await fixture.actions.persistCommand("start", { phase: "focus" });
  assert.equal(command.taskId, "task-1");
  assert.equal(command.observedElapsedMs, 0);
  assert.deepEqual(captured[0].timerOwner, {
    deviceId: "device-1", tabId: "tab-1", nowMs: captured[0].timerOwner.nowMs, leaseMs: 60_000
  });

  const task = await fixture.actions.persistTaskOperation("upsert", { id: "task-1", title: "Deep work" });
  assert.equal(task.title, "Deep work");
  const selected = await fixture.actions.persistSelectedTaskOperation(null);
  assert.equal(selected.taskId, null);
  fixture.actions.setInFlightDurationOperationIds(["sent"]);
  const duration = await fixture.actions.persistDurationOperation("focus", 2_000_000);
  assert.equal(duration.pendingDurationOperations[0].id, "new");
  assert.equal(captured.at(-1).supersede({ id: "sent", phase: "focus", ownerId: "tab-1" }), false);
  assert.equal(captured.at(-1).supersede({ id: "old", phase: "focus", ownerId: "tab-1" }), true);
});

function actionFixture(overrides = {}) {
  const current = state({
    timer: { id: "timer-1", phase: "focus", status: "running", plannedDurationMs: 60_000 },
    history: [{ timerId: "prior", phase: "focus", status: "completed", completedAt: "2026-08-26T08:00:00Z" }],
    ...overrides.state
  });
  const calls = [];
  const timers = [];
  const host = {
    crypto: { randomUUID: () => "break-1" }, clearTimeout: (id) => calls.push(["clearTimeout", id]),
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearInterval: (id) => calls.push(["clearInterval", id]), setInterval: (callback, delay) => { calls.push(["interval", delay]); return 4; },
    ...overrides.host
  };
  const syncStorage = {
    finishAppliedPlan: (input) => ({
      selectedPhase: input.phase === "focus" ? "short_break" : "focus"
    }),
    finishTimer: async () => ({
      transitioned: true, reason: "", selectedPhase: "short_break", selectedPhaseDurationMs: 300_000,
      commands: [{
        id: "finish-1", deviceId: "device-1", deviceSequence: 4, timerId: "timer-1", type: "finish",
        phase: "focus", plannedDurationMs: 60_000, occurredAt: "1970-01-01T00:00:00.005Z",
        hlcWallMs: 5, hlcCounter: 6, observedElapsedMs: 1000
      }]
    }),
    cancelAndClearTimer: async () => ({ transitioned: true, commands: [{ deviceSequence: 7, hlcWallMs: 8, hlcCounter: 9 }] }),
    renewTimerOwnership: async (_db, input) => calls.push(["renew", input]), ...overrides.syncStorage
  };
  const use = {
    controlsBlocked: () => false, clone: structuredClone, trustedNow: () => 5,
    elapsedFor: () => 1000, phaseConfig: () => ({ focus: {}, short_break: {}, long_break: {} }),
    phaseLabel: (phase) => phase, tabId: () => "tab-1", settingsValue: () => ({ selectedPhase: current.selectedPhase }),
    database: () => ({}), rebuildOptimisticState: () => calls.push("rebuild"), render: () => calls.push("render"),
    renderTimer: () => calls.push("timer"), renderDurations: () => {}, renderTaskSelector: () => {}, renderSyncStatus: () => {},
    showNotice: (value) => calls.push(["notice", value]), scheduleSync: (delay) => calls.push(["sync", delay]),
    persistAutoStartOperation: async (enabled) => ({ id: `auto-${enabled}` }),
    persistSelectedTaskOperation: async (taskId) => ({ id: `selected-${taskId}`, taskId }),
    persistTaskOperation: async (type, task) => ({ id: `${type}-${task.id}`, type, taskId: task.id }),
    persistCommand: async (type) => ({ id: `command-${type}`, type }),
    tr: (_key, _args, fallback) => fallback, ...overrides.use
  };
  return { actions: actionModule.create({ state: current, external: { host, syncStorage }, use }), calls, current, host, timers };
}

test("automatic timer completion retries only after foreign ownership expires", async () => {
  const fixture = actionFixture({ syncStorage: {
    finishTimer: async () => ({ transitioned: false, reason: "not_owner", retryAtMs: Date.now() + 500 })
  } });
  assert.equal(await fixture.actions.finishTimer(true), true);
  assert.equal(fixture.current.selectedPhase, "focus");
  assert.ok(fixture.timers[0].delay >= 250);
  fixture.timers[0].callback();
  assert.equal(fixture.actions.completionQueuedForTest(), null);
  assert.ok(fixture.calls.includes("timer"));
});

test("timer completion persists phase transition, alerts once, and renews active ownership", async () => {
  const fixture = actionFixture();
  assert.equal(await fixture.actions.finishTimer(false), true);
  assert.equal(fixture.current.selectedPhase, "short_break");
  assert.equal(fixture.current.deviceSequence, 4);
  assert.equal(fixture.actions.completionAlertTimerIDTest(), "timer-1");
  assert.equal(fixture.actions.startCompletionAlert(fixture.current.timer), false);
  fixture.actions.heartbeatTimerOwnership();
  await Promise.resolve();
  assert.equal(fixture.calls.find((call) => Array.isArray(call) && call[0] === "renew")[1].timerId, "timer-1");
  fixture.actions.stopCompletionAlert();
  assert.equal(fixture.actions.completionAlertDismissedTimerIDTest(), "timer-1");
});

test("preference, task, command, and cancellation mutations update only after durable writes", async () => {
  const fixture = actionFixture();
  assert.equal(await fixture.actions.issueAutoStartOperation(true), true);
  assert.equal(fixture.current.pendingAutoStartOperations[0].id, "auto-true");
  assert.equal(await fixture.actions.issueSelectedTaskOperation("task-1"), true);
  assert.equal(fixture.current.pendingSelectedTaskOperations[0].taskId, "task-1");
  assert.equal(await fixture.actions.issueTaskOperation("upsert", { id: "task-1", title: "Deep work" }), true);
  assert.equal(fixture.current.pendingTaskOperations[0].type, "upsert");
  assert.equal(await fixture.actions.issueCommand("pause"), true);
  assert.equal(fixture.current.pending.at(-1).type, "pause");
  assert.equal(await fixture.actions.cancelAndClearTimer(), true);
  assert.equal(fixture.current.deviceSequence, 7);
  assert.ok(fixture.calls.filter((call) => Array.isArray(call) && call[0] === "sync").length >= 5);
});

function syncFixture(overrides = {}) {
  const current = state(overrides.state);
  const calls = [];
  const timers = [];
  const host = {
    navigator: { onLine: true }, console: { warn: (...args) => calls.push(["warn", ...args]) },
    clearTimeout: () => {}, setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; }
  };
  const acknowledgement = { acknowledgements: [], acknowledgedIds: [] };
  const syncCore = {
    trustedNow: () => 100, serverClockOffset: () => 20, requiresBootstrapResolution: () => false,
    compareTimerCommands: () => 0, buildSyncBatch: (queues) => queues,
    validateCanonicalResponse: () => ({ commands: acknowledgement, tasks: acknowledgement, durations: acknowledgement, autoStart: acknowledgement, selectedTask: acknowledgement }),
    ...overrides.syncCore
  };
  class AccountOwnershipError extends Error {}
  const syncStorage = {
    AccountOwnershipError, readBootstrapState: async () => ({ gate: null, resolution: null }),
    normalizeLegacyDurationOperations: async () => {}, readQueues: async () => ({ commands: [{ id: "command-1" }] }),
    reconcileState: () => ({ revision: 3, baseTimer: null, baseHistory: [], baseTasks: [], baseDurationsMs: current.durationsMs,
      baseAutoStartBreaks: false, baseSelectedTaskId: null, queues: {}, droppedTimerOperationIds: [], droppedTimerIds: [] }),
    applySyncResponse: async (_db, input) => { calls.push(["apply", input]); return { applied: true }; }, ...overrides.syncStorage
  };
  const use = {
    clone: structuredClone, normalizeTimer: (value) => value, emptyTimer: (phase, duration) => ({ phase, duration }),
    selectedDurationMs: () => current.durationsMs.focus, normalizeDurationsMs: (value) => value,
    selectedPhaseAfterCommandAcknowledgements: (phase) => phase, snapshotValue: (value) => value,
    settingsValue: (value) => value, tabId: () => "tab-1", reloadPersistedState: async () => calls.push("reload"),
    database: () => ({}), setInFlightDurationOperationIds: (ids) => calls.push(["inflight", ids]),
    stopCompletionAlert: () => {}, closeRevisionStream: () => {}, quarantineOwnerState: () => {},
    render: () => calls.push("render"), renderSyncStatus: () => calls.push("status"),
    tr: (_key, _args, fallback) => fallback, redirectToLogin: () => calls.push("login"),
    queueSessionRevalidation: () => calls.push("revalidate"), restoreSessionAndSync: () => calls.push("restore"),
    compareDurationOperations: () => 0, rebuildOptimisticState: () => {},
    postMutation: async () => ({ response: { ok: true, status: 200, json: async () => ({
      revision: 3, serverTime: "now", serverHlcWallMs: 1, serverHlcCounter: 2
    }) }, timing: { requestAtMs: 1, receivedAtMs: 2, requestSequence: 3 } }), ...overrides.use
  };
  const actions = syncModule.create({ state: current, external: { host, syncCore, syncStorage }, use, listen: () => {} });
  return { actions, calls, current, host, syncStorage, timers, use };
}

test("sync sends refreshed queues and atomically accepts the canonical response", async () => {
  const fixture = syncFixture();
  await fixture.actions.syncNow(true);
  assert.equal(fixture.current.syncing, false);
  assert.ok(fixture.calls.some((call) => Array.isArray(call) && call[0] === "apply"));
  assert.deepEqual(fixture.calls.filter((call) => Array.isArray(call) && call[0] === "inflight").at(-1), ["inflight", []]);
  assert.ok(fixture.calls.includes("reload"));
});

test("sync authentication and account-ownership failures do not apply stale responses", async () => {
  const unauthorized = syncFixture({ use: { postMutation: async () => ({ response: { status: 401 } }) } });
  await unauthorized.actions.syncNow(true);
  assert.ok(unauthorized.calls.includes("login"));
  assert.equal(unauthorized.calls.some((call) => Array.isArray(call) && call[0] === "apply"), false);

  const ownership = syncFixture({ syncStorage: {
    applySyncResponse: async () => { throw new (class AccountOwnershipError extends Error {})(); }
  } });
  ownership.syncStorage.AccountOwnershipError = ownership.syncStorage.applySyncResponse.constructor;
  ownership.use.postMutation = async () => { throw new ownership.syncStorage.AccountOwnershipError(); };
  await ownership.actions.syncNow(true);
  assert.ok(ownership.calls.includes("revalidate"));
});

function bootstrapFixture(overrides = {}) {
  const current = state({ bootstrapBlocked: true, bootstrapPreview: { revision: 4, history: [] }, ...overrides.state });
  const calls = [];
  const syncCore = {
    pendingMatchesUser: (pending, userId) => pending?.userId === userId,
    pendingResolutionCanSubmit: (pending, userId) => pending?.userId === userId,
    canExposeOwnerState: () => true, canSubmitResolution: (_mode, confirmed) => confirmed,
    isResolutionStrategy: (value) => ["keep_local", "keep_remote"].includes(value),
    hasLocalState: (local) => local.history.length > 0, hasRemoteState: (remote) => remote.history.length > 0,
    validateCanonicalResponse: () => {
      const empty = { acknowledgements: [] };
      return { commands: empty, tasks: empty, durations: empty, autoStart: empty, selectedTask: empty };
    }, serverClockOffset: () => 0,
    ...overrides.syncCore
  };
  class BootstrapGateError extends Error {}
  class ResolutionLimitError extends Error {}
  const syncStorage = {
    BootstrapGateError, ResolutionLimitError,
    bootstrapPlan: ({ hasLocalState, hasRemoteState }) => hasLocalState && hasRemoteState
      ? { mode: "choose" } : { mode: "automatic", strategy: hasLocalState ? "keep_local" : "keep_remote" },
    readBootstrapState: async () => ({ gate: null, resolution: null }),
    readSyncState: async () => ({ snapshot: { user: { id: "other-user" } } }),
    allocateClockRequestSequence: async () => 1, saveClockOffset: async (_db, offset) => offset,
    normalizeLegacyDurationOperations: async () => ({ resolution: null }), validatePendingForSend: async () => {},
    reconcileResolutionState: ({ queues }) => ({
      revision: 5, baseTimer: null, baseHistory: [], baseTasks: [], baseDurationsMs: current.durationsMs,
      baseAutoStartBreaks: false, baseSelectedTaskId: null, queues
    }),
    applyResolution: async (_db, pending, input) => { calls.push(["applyResolution", pending, input]); return { applied: true }; },
    captureResolution: async (_db, payload) => ({ userId: "user-1", payload }),
    ...overrides.syncStorage
  };
  const use = {
    database: () => ({}), tabId: () => "tab-1", acquireBootstrapGate: async () => ({ acquired: true }),
    refreshMigratedPreferences: async () => {}, defaultDurationsMs: () => current.durationsMs,
    responseClockOffset: () => 0, mergeServerHlc: () => ({ wallMs: 0, counter: 0 }), clone: structuredClone,
    normalizeTimer: (value) => value, emptyTimer: (phase, duration) => ({ phase, duration }),
    normalizeDurationsMs: (value) => value, tr: (_key, _args, fallback) => fallback,
    reloadPersistedState: async () => calls.push("reload"), resetSyncRetry: () => {}, render: () => calls.push("render"),
    renderBootstrapDialog: () => calls.push("dialog"), showNotice: (message) => calls.push(["notice", message]),
    openRevisionStream: () => calls.push("stream"), hasPendingOperations: () => false,
    scheduleSync: () => {}, syncNow: async () => calls.push("sync"), scheduleRetry: () => calls.push("retry"),
    postMutation: async () => ({ response: { ok: true, status: 200, json: async () => ({}) }, timing: {} }),
    redirectToLogin: () => calls.push("login"), queueSessionRevalidation: () => calls.push("revalidate"),
    refreshAllPendingOperations: async () => {}, ...overrides.use
  };
  const host = {
    navigator: { onLine: true }, crypto: { randomUUID: () => "request-1" },
    console: { warn: (...args) => calls.push(["warn", ...args]) }, setTimeout: (callback) => { callback(); return 1; },
    fetch: async () => ({ ok: true, status: 200, json: async () => current.bootstrapPreview }), ...overrides.host
  };
  const elements = {
    bootstrapChoiceButtons: [{ dataset: { bootstrapStrategy: "keep_local" } }, { dataset: { bootstrapStrategy: "keep_remote" } }],
    bootstrapConfirm: {}, bootstrapRetry: {}
  };
  const actions = bootstrapModule.create({ state: current, external: { host, syncCore, syncStorage, elements }, use });
  return { actions, calls, current, host, syncCore, syncStorage, use };
}

test("bootstrap preparation exposes a choice without leaking quarantined local state", async () => {
  const fixture = bootstrapFixture({ state: {
    bootstrapPreview: { revision: 4, history: [{ status: "completed" }] },
    quarantinedLocal: { history: [{ status: "completed" }], timer: {}, tasks: [], durationsMs: {}, autoStartBreaks: false,
      selectedTaskId: null, pending: [], pendingTaskOperations: [], pendingDurationOperations: [],
      pendingAutoStartOperations: [], pendingSelectedTaskOperations: [] }
  }, use: { acquireBootstrapGate: async () => ({ acquired: true, resolution: null }) } });
  await fixture.actions.prepareBootstrap();
  assert.equal(fixture.current.bootstrapPlan.mode, "choose");
  assert.equal(fixture.current.bootstrapStrategy, null);
  assert.strictEqual(fixture.current.bootstrapFocusTarget.dataset.bootstrapStrategy, "keep_local");
});

test("bootstrap confirmation persists the exact request before network submission", async () => {
  let posted;
  const fixture = bootstrapFixture({ state: { bootstrapPlan: { mode: "choose" } }, use: {
    postMutation: async (url, body, userId) => {
      posted = { url, body, userId };
      return { response: { status: 409, ok: false, json: async () => ({ error: "request ID conflict" }) }, timing: {} };
    }
  } });
  fixture.current.bootstrapPreview = { revision: 9, history: [] };
  await fixture.actions.chooseBootstrapStrategy("keep_remote", false);
  assert.equal(fixture.current.bootstrapStrategy, "keep_remote");
  assert.equal(posted, undefined);
  await fixture.actions.chooseBootstrapStrategy("keep_remote", true);
  assert.deepEqual(JSON.parse(posted.body), fixture.current.bootstrapPending.payload);
  assert.equal(fixture.current.bootstrapConflict, true);
  assert.match(fixture.current.bootstrapError, /already used/);
});

test("bootstrap acceptance atomically applies the canonical snapshot before resuming sync", async () => {
  const rejected = { outcome: "rejected", reason: "timer already finished" };
  const fixture = bootstrapFixture({ syncCore: {
    validateCanonicalResponse: () => {
      const empty = { acknowledgements: [] };
      return { commands: { acknowledgements: [rejected] }, tasks: empty, durations: empty, autoStart: empty, selectedTask: empty };
    }
  } });
  const pending = {
    userId: "user-1", payload: {
      deviceId: "device-1", commands: [], taskOperations: [], durationOperations: [],
      autoStartOperations: [], selectedTaskOperations: []
    }, queueIds: { commands: [], taskOperations: [], durationOperations: [], autoStartOperations: [], selectedTaskOperations: [] }
  };
  await fixture.actions.acceptBootstrapResponse({
    revision: 5, serverTime: "now", serverHlcWallMs: 10, serverHlcCounter: 2
  }, pending, { requestAtMs: 1, receivedAtMs: 2, requestSequence: 3 });
  assert.ok(fixture.calls.some((call) => Array.isArray(call) && call[0] === "applyResolution"));
  assert.equal(fixture.current.bootstrapBlocked, false);
  assert.equal(fixture.current.conflict, "timer already finished");
  assert.equal(fixture.current.actionLocked, false);
  assert.ok(fixture.calls.includes("reload"));
  assert.ok(fixture.calls.includes("stream"));
});

function element() {
  return {
    children: [], dataset: {}, style: {}, listeners: new Map(), hidden: false,
    addEventListener(name, listener) { this.listeners.set(name, listener); },
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; },
    focus() { this.focused = true; }, close() { this.open = false; }, showModal() { this.open = true; },
    querySelector() { return this.submitButton || null; }
  };
}

function viewFixture(overrides = {}) {
  const current = state({ timer: { status: "idle" }, ...overrides.state });
  const elements = new Proxy(overrides.elements || {}, { get(target, key) { if (!(key in target)) target[key] = element(); return target[key]; } });
  elements.screenButtons = overrides.screenButtons || [];
  elements.phaseButtons = overrides.phaseButtons || [];
  elements.durationInputs = overrides.durationInputs || [];
  elements.stepButtons = overrides.stepButtons || [];
  elements.bootstrapChoiceButtons = overrides.bootstrapChoiceButtons || [];
  const document = {
    activeElement: null, visibilityState: "visible", createElement: () => element(),
    createElementNS: () => element(), createDocumentFragment: () => element(),
    addEventListener: (name, listener) => { document[name] = listener; }, getElementById: () => null
  };
  const host = {
    document, navigator: { onLine: true }, clearTimeout: () => {}, setTimeout: (callback) => { callback(); return 1; },
    addEventListener: (name, listener) => { host[name] = listener; }, console: { warn: () => {} }
  };
  const syncCore = {
    completedHistoryCount: (history = []) => history.length, bootstrapDialogView: () => ({ open: false }),
    confirmationFor: () => ({ title: "Confirm", message: "Sure?", confirmLabel: "Apply" })
  };
  const use = {
    controlsBlocked: () => false, tr: (_key, _args, fallback) => fallback, phaseLabel: (phase) => phase,
    phaseShortLabel: (phase) => phase[0], timerStatusLabel: (status) => status,
    phaseConfig: () => ({ focus: {}, short_break: {} }), emptyTimer: (phase, duration) => ({ phase, plannedDurationMs: duration }),
    selectedDurationMs: () => 1000, elapsedFor: () => 0, positiveNumber: (value, fallback) => Number(value) || fallback,
    clampNumber: (value, min, max) => Math.max(min, Math.min(max, Number(value))), completedFocusCountForDay: () => 0,
    longBreakProgress: () => 0, historyDateMs: (item) => Date.parse(item.completedAt) || 0,
    activeCompletionAlertTimerId: () => null, updateTimerCompletion: () => {}, startCompletionAlert: () => {},
    localBootstrapState: () => ({ history: [] }), ...overrides.use
  };
  const view = viewModule.create({ state: current, external: { host, syncCore, syncStorage: {}, elements }, use });
  return { current, document, elements, host, use, view };
}

test("view renders accessible navigation, history, tasks, profile, and sync state", () => {
  const timerButton = Object.assign(element(), { dataset: { screenButton: "timer" } });
  const taskButton = Object.assign(element(), { dataset: { screenButton: "tasks" } });
  const fixture = viewFixture({ screenButtons: [timerButton, taskButton], state: {
    activeScreen: "tasks", deviceId: "device-ABcd", tasks: [{ id: "task-1", title: "Deep work" }],
    history: [{ phase: "focus", status: "completed", taskId: "task-1", completedAt: new Date().toISOString(), plannedDurationMs: 60000 }],
    pending: [{ id: "queued" }], user: { id: "user-1", avatarUrl: "https://example.test/avatar.png" }
  } });
  fixture.elements.taskForm.submitButton = element();
  fixture.view.renderScreens();
  fixture.view.renderDeviceMark();
  fixture.view.renderHistory();
  fixture.view.renderTasks();
  fixture.view.renderProfile();
  fixture.view.renderSyncStatus();
  assert.equal(fixture.elements.timerScreen.hidden, true);
  assert.equal(taskButton["aria-selected"], "true");
  assert.equal(fixture.elements.deviceMark.textContent, "ABCD");
  assert.equal(fixture.elements.historyCount.textContent, "001");
  assert.equal(fixture.elements.taskCount.textContent, "01");
  assert.equal(fixture.elements.profileAvatar.src, "https://example.test/avatar.png");
  assert.equal(fixture.elements.syncStatus.dataset.state, "loading");
});

test("view keyboard navigation and connectivity handlers preserve ownership boundaries", async () => {
  const timerButton = Object.assign(element(), { dataset: { screenButton: "timer" } });
  const taskButton = Object.assign(element(), { dataset: { screenButton: "tasks" } });
  const calls = [];
  const fixture = viewFixture({ screenButtons: [timerButton, taskButton], use: {
    database: () => ({}), tabId: () => "tab-1", needsBootstrapResolution: () => false,
    scheduleSync: (...args) => calls.push(["sync", ...args]), handleOnline: () => calls.push("online"), handleOffline: () => calls.push("offline")
  } });
  fixture.view.handleScreenKeydown({ currentTarget: timerButton, key: "ArrowRight", preventDefault: () => calls.push("prevented") });
  assert.equal(fixture.current.activeScreen, "tasks");
  assert.equal(taskButton.focused, true);
  fixture.view.setupConnectivityEvents();
  fixture.document.visibilitychange();
  assert.deepEqual(calls.at(-1), ["sync", 0, true]);
  fixture.host.offline();
  assert.ok(calls.includes("offline"));
});
