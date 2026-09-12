"use strict";

const test = require("node:test");
const incarnationFixture = require("./test/incarnation-fixture.js");
const assert = require("node:assert/strict");
const actionModule = require("./app-actions.js");
const bootstrapModule = require("./app-bootstrap.js");
const viewModule = require("./app-view.js");

function baseState(overrides = {}) {
  return {
    actionLocked: false, activeScreen: "timer", authenticated: true, autoStartBreaks: false,
    bootstrapBlocked: true, bootstrapConflict: false, bootstrapError: null, bootstrapGateOwned: false,
    bootstrapGatePersisted: false, bootstrapLimitError: null, bootstrapPending: null,
    bootstrapPlan: null, bootstrapPreview: { revision: 3, history: [] }, bootstrapStrategy: null,
    bootstrapSubmitting: false, conflict: null, csrfToken: "csrf", deviceId: "device-1",
    deviceSequence: 0, durationsMs: { focus: 1_500_000, short_break: 300_000 }, history: [],
    hlcCounter: 0, hlcWallMs: 0, localOwnerId: incarnationFixture.ownerId("user-1"), pending: [],
    pendingAutoStartOperations: [], pendingDurationOperations: [], pendingSelectedTaskOperations: [],
    pendingTaskOperations: [], ready: true, retrying: false, selectedPhase: "focus",
    selectedTaskId: null, sessionIdentityValidated: true, syncing: false, tasks: [],
    timer: { id: "timer-1", phase: "focus", status: "running", plannedDurationMs: 1000 },
    user: incarnationFixture.accountUser("user-1"), ...overrides
  };
}

function actionFixture(overrides = {}) {
  const state = baseState(overrides.state);
  const calls = [];
  const timers = [];
  const host = {
    crypto: { randomUUID: () => "break-1" }, Notification: undefined,
    clearTimeout: (id) => calls.push(["clearTimeout", id]),
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearInterval: (id) => calls.push(["clearInterval", id]),
    setInterval: (callback, delay) => { calls.push(["interval", callback, delay]); return 7; },
    ...overrides.host
  };
  const syncStorage = {
    AccountOwnershipError: incarnationFixture.storage.AccountOwnershipError,
    cancelAndClearTimer: async () => ({ transitioned: false }),
    finishAppliedPlan: (input) => ({
      selectedPhase: input.phase === "focus" ? "short_break" : "focus"
    }),
    finishTimer: async () => ({ transitioned: false, reason: "already_finished" }),
    renewTimerOwnership: async () => {}, ...overrides.syncStorage
  };
  const use = {
    captureAccountContext: () => incarnationFixture.captureAccountContext(state, host),
    controlsBlocked: () => false, clone: structuredClone, database: () => ({}),
    assertExpectedAccount: (expectedUserId) => assert.equal(incarnationFixture.sync.accountOwnerId(state.user), expectedUserId),
    elapsedFor: () => 1000, phaseConfig: () => ({ focus: {}, short_break: {}, long_break: {} }),
    phaseLabel: (phase) => phase, settingsValue: () => ({}), tabId: () => "tab-1",
    trustedNow: (value = 1000) => value, rebuildOptimisticState: () => calls.push("rebuild"),
    render: () => calls.push("render"), renderDurations: () => calls.push("durations"),
    renderSyncStatus: () => calls.push("status"), renderTaskSelector: () => calls.push("selector"),
    renderTimer: () => calls.push("timer"), scheduleSync: () => calls.push("sync"),
    showNotice: (message) => calls.push(["notice", message]), tr: (_key, _args, fallback) => fallback,
    persistAutoStartOperation: async () => { throw new Error("auto write failed"); },
    persistSelectedTaskOperation: async () => { throw new Error("selection write failed"); },
    persistTaskOperation: async () => { throw new Error("task write failed"); },
    persistCommand: async () => { throw new Error("command write failed"); },
    sharedTaskIdentity: async (title) => ({ id: title, title }), ...overrides.use
  };
  const actions = actionModule.create({ state, external: { host, syncStorage, syncCore: incarnationFixture.sync }, use });
  return { actions, calls, host, state, timers, use };
}

test("mutation failures restore the action lock and never enqueue undurable work", async () => {
  const fixture = actionFixture();
  assert.equal(await fixture.actions.issueAutoStartOperation(true), false);
  assert.equal(await fixture.actions.issueSelectedTaskOperation("task-1"), false);
  assert.equal(await fixture.actions.issueTaskOperation("delete", { id: "task-1" }), false);
  assert.equal(await fixture.actions.issueCommand("pause"), false);
  assert.equal(await fixture.actions.cancelAndClearTimer(), false);
  assert.equal(fixture.state.actionLocked, false);
  assert.deepEqual(fixture.state.pending, []);
  assert.equal(fixture.calls.filter((entry) => Array.isArray(entry) && entry[0] === "notice").length, 4);
});

test("timer policy rolls rejected finishes back without changing unrelated selections", () => {
  const fixture = actionFixture();
  const day = new Date("2026-08-26T12:00:00Z");
  const history = [
    { timerId: "a", phase: "focus", status: "completed", completedAt: "2026-08-26T08:00:00Z" },
    { timerId: "b", phase: "focus", status: "cancelled", completedAt: "2026-08-26T09:00:00Z" },
    { timerId: "c", phase: "short_break", completedAt: "2026-08-26T10:00:00Z" }
  ];
  assert.equal(fixture.actions.completedFocusCountForDay(history, day), 1);
  assert.equal(fixture.actions.historyDateMs({ endedAt: "bad" }), 0);
  assert.equal(fixture.actions.nextPhaseAfterCompletion({ phase: "short_break" }, history, day), "focus");
  assert.equal(fixture.actions.longBreakProgress(0), 0);
  const commands = [{ id: "finish-1", type: "finish", timerId: "z", phase: "focus", deviceSequence: 9,
    occurredAt: "2026-08-26T11:00:00Z" }];
  assert.equal(fixture.actions.selectedPhaseAfterCommandAcknowledgements(
    "short_break", commands, [{ commandId: "finish-1", outcome: "rejected" }], history
  ), "focus");
  assert.equal(fixture.actions.selectedPhaseAfterRejectedFinish("long_break", { type: "pause" }, history), "long_break");
});

test("completion alerts recover from unavailable browser audio and notification APIs", async () => {
  class BrokenAudioContext { constructor() { throw new Error("audio denied"); } }
  class BrokenNotification {
    static permission = "granted";
    constructor() { throw new Error("notification denied"); }
  }
  const fixture = actionFixture({ host: { AudioContext: BrokenAudioContext, Notification: BrokenNotification } });
  assert.equal(fixture.actions.startCompletionAlert({ id: "timer-1", phase: "focus" }), true);
  await fixture.actions.primeCompletionAlerts();
  assert.equal(fixture.actions.activeCompletionAlertTimerId(), "timer-1");
  assert.equal(fixture.actions.completionSoundIntervalMs(), 1200);
  assert.equal(fixture.actions.releaseCompletionRetry("other"), false);
  fixture.state.timer.status = "paused";
  fixture.actions.updateTimerCompletion(fixture.state.timer, "paused", 500, false);
  assert.equal(fixture.actions.completionQueuedForTest(), null);
});

function bootstrapFixture(overrides = {}) {
  const state = baseState(overrides.state);
  const calls = [];
  const timers = [];
  class BootstrapGateError extends Error {}
  class ResolutionLimitError extends Error {}
  const syncCore = {
    ...incarnationFixture.sync,
    canExposeOwnerState: () => true, canSubmitResolution: (_mode, confirmed) => confirmed,
    hasLocalState: (local) => local.history.length > 0, hasRemoteState: (remote) => remote.history.length > 0,
    isResolutionStrategy: (strategy) => ["keep_local", "keep_remote"].includes(strategy),
    pendingMatchesUser: (pending, userId) => pending?.userId === userId,
    pendingResolutionCanSubmit: (pending, userId) => pending?.userId === userId,
    serverClockOffset: () => 0, validateCanonicalResponse: () => {
      const empty = { acknowledgements: [] };
      return { commands: empty, tasks: empty, durations: empty, autoStart: empty, selectedTask: empty };
    }, ...overrides.syncCore
  };
  const syncStorage = {
    AccountOwnershipError: incarnationFixture.storage.AccountOwnershipError,
    BootstrapGateError, ResolutionLimitError, allocateClockRequestSequence: async () => 1,
    applyResolution: async () => ({ applied: true }), bootstrapPlan: ({ hasLocalState, hasRemoteState }) =>
      hasLocalState && hasRemoteState ? { mode: "choose" } : { mode: "automatic", strategy: hasLocalState ? "keep_local" : "keep_remote" },
    captureResolution: async (_db, payload) => ({ userId: payload.userId, payload, queueIds: {} }),
    clearBootstrapGate: async () => calls.push("clearGate"), invalidateForeignResolution: async () => ({ acquired: true, resolution: null }),
    migrateLegacyAutoStart: async () => ({ operation: "auto" }), migrateLegacySelectedTask: async () => ({ operation: "task" }),
    normalizeLegacyDurationOperations: async () => ({ resolution: null }), readBootstrapState: async () => ({ gate: null, resolution: null }),
    readSyncState: async () => ({ snapshot: { user: incarnationFixture.accountUser("other-user") } }),
    reconcileResolutionState: ({ queues }) => ({ revision: 4, baseTimer: null, baseHistory: [], baseTasks: [],
      baseDurationsMs: state.durationsMs, baseAutoStartBreaks: false, baseSelectedTaskId: null, queues }),
    saveClockOffset: async (_db, offset) => offset, validatePendingForSend: async () => {}, ...overrides.syncStorage
  };
  const use = {
    captureAccountContext: () => incarnationFixture.captureAccountContext(state, host),
    acquireBootstrapGate: async () => ({ acquired: true }), clone: structuredClone, database: () => ({}),
    defaultDurationsMs: () => state.durationsMs, emptyTimer: (phase, duration) => ({ phase, plannedDurationMs: duration }),
    hasPendingOperations: () => false, mergeServerHlc: () => ({ wallMs: 0, counter: 0 }), normalizeDurationsMs: (value) => value,
    normalizeTimer: (value) => value, openRevisionStream: () => calls.push("stream"), postMutation: async () => ({
      response: { ok: true, status: 200, json: async () => ({ revision: 4 }) }, timing: {}
    }), queueSessionRevalidation: () => calls.push("revalidate"), redirectToLogin: () => calls.push("login"),
    refreshAllPendingOperations: async () => {}, refreshMigratedPreferences: async () => calls.push("refreshPreferences"),
    reloadPersistedState: async () => calls.push("reload"), render: () => calls.push("render"),
    renderBootstrapDialog: () => calls.push("dialog"), resetSyncRetry: () => calls.push("resetRetry"),
    responseClockOffset: () => 0, scheduleRetry: () => calls.push("retry"), scheduleSync: () => calls.push("syncSchedule"),
    showNotice: (message) => calls.push(["notice", message]), syncNow: async () => calls.push("syncNow"),
    tabId: () => "tab-1", tr: (_key, _args, fallback) => fallback, ...overrides.use
  };
  const host = {
    console: { warn: (...args) => calls.push(["warn", ...args]) }, crypto: { randomUUID: () => "request-1" },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ...state.bootstrapPreview, accountIncarnation: state.user.accountIncarnation }) }),
    navigator: { onLine: true }, setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    ...overrides.host
  };
  const elements = {
    bootstrapChoiceButtons: [{ dataset: { bootstrapStrategy: "keep_local" } }, { dataset: { bootstrapStrategy: "keep_remote" } }],
    bootstrapConfirm: {}, bootstrapRetry: {}
  };
  const actions = bootstrapModule.create({ state, external: { host, syncCore, syncStorage, elements }, use });
  return { actions, calls, elements, host, state, syncCore, syncStorage, timers, use };
}

test("bootstrap restart invalidates foreign capture before migrating legacy preferences", async () => {
  const fixture = bootstrapFixture();
  await fixture.actions.restartBootstrapForCurrentAccount();
  assert.equal(fixture.state.bootstrapBlocked, true);
  assert.equal(fixture.state.bootstrapGateOwned, true);
  assert.ok(fixture.calls.includes("refreshPreferences"));
  fixture.actions.queueBootstrapPreparation();
  fixture.use.acquireBootstrapGate = async () => { throw new Error("busy"); };
  await fixture.timers[0].callback();
  assert.equal(fixture.state.retrying, true);
  assert.ok(fixture.calls.includes("retry"));
});

test("invalid persisted bootstrap requests revalidate identity or resume exact owner capture", async () => {
  const foreign = bootstrapFixture({ syncStorage: { readBootstrapState: async () => ({ resolution: { userId: "other" } }) } });
  await foreign.actions.recoverInvalidBootstrapSubmission();
  assert.ok(foreign.calls.includes("revalidate"));

  const own = bootstrapFixture({ syncStorage: { readBootstrapState: async () => ({ resolution: { userId: incarnationFixture.ownerId("user-1"), payload: { strategy: "keep_remote" } } }) } });
  await own.actions.recoverInvalidBootstrapSubmission();
  assert.equal(own.state.bootstrapGateOwned, false);
  own.timers[0].callback();
  await Promise.resolve();
  assert.equal(own.state.bootstrapPending.userId, incarnationFixture.ownerId("user-1"));
});

test("bootstrap transport handles authentication, both conflict classes, and server failure", async () => {
  const fixture = bootstrapFixture();
  const pending = { userId: incarnationFixture.ownerId("user-1"), payload: { strategy: "keep_remote" } };
  fixture.use.postMutation = async () => ({ response: { status: 401 }, timing: {} });
  await fixture.actions.sendBootstrapResolution(pending);
  assert.ok(fixture.calls.includes("login"));

  fixture.use.postMutation = async () => ({ response: { status: 409, json: async () => ({ error: "changed" }) }, timing: {} });
  await fixture.actions.sendBootstrapResolution(pending);
  assert.match(fixture.state.bootstrapError, /Remote history changed/);
  fixture.use.postMutation = async () => ({ response: { status: 503, ok: false }, timing: {} });
  await assert.rejects(() => fixture.actions.sendBootstrapResolution(pending), /503/);
});

test("bootstrap preparation resumes matching persisted state and defers a live foreign gate", async () => {
  const matching = bootstrapFixture({ syncStorage: { readSyncState: async () => ({ snapshot: { user: incarnationFixture.accountUser("user-1") } }) } });
  assert.equal(await matching.actions.acquireBootstrapPreparationGate(), true);
  assert.equal(matching.state.bootstrapBlocked, false);
  assert.ok(matching.calls.includes("clearGate"));
  assert.ok(matching.calls.includes("syncNow"));

  const waiting = bootstrapFixture({ use: { acquireBootstrapGate: async () => ({ acquired: false }) } });
  assert.equal(await waiting.actions.acquireBootstrapPreparationGate(), true);
  assert.equal(waiting.state.retrying, true);
  assert.ok(waiting.calls.includes("retry"));
});

test("bootstrap account reconciliation fails closed until session identity is validated", async () => {
  const pending = { userId: "other", payload: { strategy: "keep_remote" } };
  const blocked = bootstrapFixture({ state: { bootstrapPending: pending, sessionIdentityValidated: false } });
  assert.equal(await blocked.actions.reconcileBootstrapAccount(), true);
  assert.ok(blocked.calls.includes("revalidate"));

  const validated = bootstrapFixture({ state: { bootstrapPending: pending, sessionIdentityValidated: true } });
  assert.equal(await validated.actions.reconcileBootstrapAccount(), false);
  assert.equal(validated.state.bootstrapGateOwned, true);
});

test("automatic bootstrap strategy rejects unknown plans and submits valid persisted choices", async () => {
  const invalid = bootstrapFixture({ state: { bootstrapPlan: { mode: "automatic", strategy: "unknown" } } });
  await invalid.actions.persistAutomaticBootstrapResolution();
  assert.ok(invalid.calls.includes("revalidate"));

  const valid = bootstrapFixture({ state: { bootstrapPlan: { mode: "automatic", strategy: "keep_remote" } } });
  let submitted = false;
  valid.use.postMutation = async () => { submitted = true; return { response: { status: 401 }, timing: {} }; };
  await valid.actions.persistAutomaticBootstrapResolution();
  assert.equal(submitted, true);
});

function element() {
  const listeners = new Map();
  return {
    children: [], classList: { add() {} }, dataset: {}, hidden: false, listeners, open: false, style: {},
    addEventListener(name, callback) { listeners.set(name, callback); }, append(...children) { this.children.push(...children); },
    close() { this.open = false; }, focus() { this.focused = true; }, querySelector() { return this.submitButton || null; },
    removeAttribute(name) { delete this[name]; }, replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this[name] = value; }, showModal() { this.open = true; }
  };
}

function allViewElements() {
  const names = [
    "autoStartBreaks", "bootstrapCancel", "bootstrapChoices", "bootstrapConfirm", "bootstrapConfirmation",
    "bootstrapConfirmationMessage", "bootstrapConfirmationTitle", "bootstrapDialog", "bootstrapError", "bootstrapRetry",
    "bootstrapSignOut", "bootstrapSummary", "bootstrapTitle", "cancelButton", "clearButton", "conflictDismiss",
    "conflictPanel", "conflictReason", "deleteAccountButton", "deviceMark", "dial", "dialProgress", "dialTicks",
    "durationForm", "finishButton", "historyCount", "historyList", "installButton", "longBreakProgress", "logoutButton",
    "notice", "phaseLabel", "profile", "profileAvatar", "syncStatus", "syncStatusText", "taskCount", "taskForm",
    "taskInput", "taskList", "taskSelector", "tasksScreen", "timerDetail", "timerDisplay", "timerInstruction",
    "timerScreen", "timerToggle"
  ];
  return Object.fromEntries(names.map((name) => [name, element()]));
}

function viewFixture(overrides = {}) {
  const state = baseState({ timer: { status: "idle" }, ...overrides.state });
  const elements = allViewElements();
  Object.assign(elements, overrides.elements);
  elements.screenButtons = overrides.screenButtons || [];
  elements.phaseButtons = overrides.phaseButtons || [];
  elements.durationInputs = overrides.durationInputs || [];
  elements.stepButtons = overrides.stepButtons || [];
  elements.bootstrapChoiceButtons = overrides.bootstrapChoiceButtons || [];
  elements.taskForm.submitButton = element();
  const document = {
    activeElement: null, visibilityState: "visible", nodes: new Map(),
    addEventListener(name, callback) { this[name] = callback; }, createDocumentFragment: element,
    createElement: element, createElementNS: element, getElementById(id) { return this.nodes.get(id) || null; }
  };
  const calls = [];
  const host = {
    document, navigator: { onLine: true }, console: { warn: (...args) => calls.push(["warn", ...args]) },
    addEventListener(name, callback) { this[name] = callback; }, clearTimeout: () => {},
    setTimeout(callback) { callback(); return 1; }
  };
  const syncCore = {
    ...incarnationFixture.sync,
    bootstrapDialogView: () => ({ open: false }), completedHistoryCount: (history = []) => history.length,
    confirmationFor: () => ({ title: "Confirm", message: "Apply this choice?", confirmLabel: "Apply" })
  };
  const use = {
    captureAccountContext: () => incarnationFixture.captureAccountContext(state, host),
    activeCompletionAlertTimerId: () => null, addTask: async () => true, cancelAndClearTimer: () => calls.push("cancel"),
    chooseBootstrapStrategy: (...args) => calls.push(["choose", ...args]), clampNumber: (value, min, max) => Math.max(min, Math.min(max, Number(value))),
    clearLocalData: async () => calls.push("clear"), closeRevisionStreamForIdentityChange: () => calls.push("close"),
    completedFocusCountForDay: () => 0, controlsBlocked: () => false, database: () => ({}), deleteAccount: () => calls.push("deleteAccount"),
    deleteTask: () => {}, elapsedFor: () => 0, emptyTimer: (phase, duration) => ({ phase, plannedDurationMs: duration }),
    finishTimer: () => calls.push("finish"), handleOffline: () => calls.push("offline"), handleOnline: () => calls.push("online"),
    historyDateMs: (item) => Date.parse(item.completedAt) || 0, issueAutoStartOperation: () => calls.push("auto"),
    issueCommand: (command) => calls.push(["command", command]), issueDurationOperation: async () => false,
    issueSelectedTaskOperation: () => calls.push("selected"), localBootstrapState: () => ({ history: [] }), logout: () => calls.push("logout"),
    longBreakProgress: () => 0, needsBootstrapResolution: () => false, persistSettings: async () => {},
    phaseConfig: () => ({ focus: {}, short_break: {} }), phaseLabel: (phase) => phase, phaseShortLabel: (phase) => phase[0],
    positiveNumber: (value, fallback) => Number(value) || fallback, primeCompletionAlerts: () => {}, redirectToLogin: () => calls.push("login"),
    retryBootstrapResolution: () => calls.push("retryBootstrap"), scheduleSync: (...args) => calls.push(["sync", ...args]),
    selectedDurationMs: () => 1000, startCompletionAlert: () => {}, stopCompletionAlert: () => calls.push("stop"),
    tabId: () => "tab-1", timerStatusLabel: (status) => status, tr: (_key, _args, fallback) => fallback,
    updateTimerCompletion: () => {}, ...overrides.use
  };
  const view = viewModule.create({ state, external: { host, syncCore, syncStorage: {
    releaseTimerOwnership: async (_db, input) => calls.push(["release", input])
  }, elements }, use });
  return { calls, document, elements, host, state, syncCore, use, view };
}

test("view renders empty collections, sync failures, conflicts, and a recoverable bootstrap limit", () => {
  const keepLocal = Object.assign(element(), { dataset: { bootstrapStrategy: "keep_local" } });
  const keepRemote = Object.assign(element(), { dataset: { bootstrapStrategy: "keep_remote" } });
  const fixture = viewFixture({ bootstrapChoiceButtons: [keepLocal, keepRemote], state: {
    bootstrapError: "retry failed", bootstrapLimitError: "queue too large", conflict: "rejected",
    pending: [{ id: "queued" }], user: null
  } });
  fixture.syncCore.bootstrapDialogView = () => ({ open: true, busy: false, choosing: true, confirming: false, failed: true });
  fixture.view.renderHistory();
  fixture.view.renderTasks();
  fixture.view.renderProfile();
  fixture.host.navigator.onLine = false;
  fixture.view.renderSyncStatus();
  fixture.view.renderConflict();
  fixture.view.renderBootstrapDialog();
  assert.equal(fixture.elements.historyList.children[0].className, "history-empty");
  assert.equal(fixture.elements.taskList.children[0].className, "task-empty");
  assert.equal(fixture.elements.profile.hidden, true);
  assert.equal(fixture.elements.syncStatus.dataset.state, "offline");
  assert.equal(fixture.elements.conflictReason.textContent, "rejected");
  assert.equal(fixture.elements.bootstrapDialog.open, true);
  assert.equal(keepLocal.hidden, true);
  assert.equal(keepRemote.hidden, false);
});

test("view event installation routes user intent and releases only this tab's timer lease", async () => {
  const phase = Object.assign(element(), { dataset: { phase: "short_break" } });
  const duration = Object.assign(element(), { name: "focus", value: "25" });
  const step = Object.assign(element(), { dataset: { for: "focus-input", step: "5" } });
  const choice = Object.assign(element(), { dataset: { bootstrapStrategy: "keep_remote" } });
  const screen = Object.assign(element(), { dataset: { screenButton: "timer" } });
  const fixture = viewFixture({
    bootstrapChoiceButtons: [choice], durationInputs: [duration], phaseButtons: [phase], screenButtons: [screen], stepButtons: [step],
    use: { issueDurationOperation: async (name, value) => { duration.saved = { name, value }; return true; } }
  });
  fixture.document.nodes.set("focus-input", duration);
  fixture.view.setupEvents();
  phase.listeners.get("click")();
  step.listeners.get("click")();
  fixture.elements.autoStartBreaks.checked = true;
  fixture.elements.autoStartBreaks.listeners.get("change")();
  fixture.elements.taskInput.value = "Deep work";
  await fixture.elements.taskForm.listeners.get("submit")({ preventDefault() {} });
  fixture.elements.timerToggle.listeners.get("click")();
  fixture.elements.finishButton.listeners.get("click")();
  fixture.elements.clearButton.listeners.get("click")();
  choice.listeners.get("click")();
  fixture.elements.bootstrapCancel.listeners.get("click")();
  fixture.host.pagehide();
  await Promise.resolve();
  assert.equal(fixture.state.selectedPhase, "short_break");
  assert.equal(duration.value, "30");
  assert.equal(fixture.elements.taskInput.value, "");
  assert.ok(fixture.calls.some((entry) => Array.isArray(entry) && entry[0] === "release"));
});

test("install prompt lifecycle is single-use and hides the install action after acceptance", async () => {
  const fixture = viewFixture();
  fixture.view.setupInstallEvents();
  let prompted = 0;
  fixture.host.beforeinstallprompt({ preventDefault() {}, prompt() { prompted += 1; }, userChoice: Promise.resolve({ outcome: "accepted" }) });
  assert.equal(fixture.elements.installButton.hidden, false);
  await fixture.elements.installButton.listeners.get("click")();
  assert.equal(prompted, 1);
  assert.equal(fixture.elements.installButton.hidden, true);
  fixture.host.appinstalled();
  assert.equal(fixture.elements.installButton.hidden, true);
});

test("bootstrap submission boundaries preserve persisted intent and expose recoverable failures", async () => {
  const unauthorized = bootstrapFixture({ host: { fetch: async () => ({ status: 401 }) } });
  assert.equal(await unauthorized.actions.loadBootstrapPreview(), undefined);
  assert.ok(unauthorized.calls.includes("login"));
  const unavailable = bootstrapFixture({ host: { fetch: async () => ({ ok: false, status: 502 }) } });
  await assert.rejects(() => unavailable.actions.loadBootstrapPreview(), /502/);

  const limited = bootstrapFixture();
  const limit = new limited.syncStorage.ResolutionLimitError("4097 queued commands");
  assert.equal(limited.actions.handleResolutionLimit(limit), true);
  assert.equal(limited.state.bootstrapLimitError, "4097 queued commands");
  assert.equal(limited.state.bootstrapFocusTarget.dataset.bootstrapStrategy, "keep_remote");
  assert.equal(limited.actions.handleResolutionLimit(new Error("other")), false);

  const invalidRevision = bootstrapFixture({ syncStorage: { reconcileResolutionState: () => ({ revision: -1 }) } });
  assert.throws(() => invalidRevision.actions.bootstrapResponseState(
    { serverHlcWallMs: 1, serverHlcCounter: 0 }, { payload: { deviceId: "device-1" } }, {}, {}
  ), /omitted revision/);

  const acknowledgements = (outcome, reason) => ({ acknowledgements: [{ outcome, reason }] });
  const validated = {
    commands: acknowledgements("accepted"), tasks: acknowledgements("rejected", "task conflict"),
    durations: acknowledgements("ignored"), autoStart: acknowledgements(""), selectedTask: acknowledgements("duplicate")
  };
  assert.deepEqual(limited.actions.bootstrapConflicts(validated), [{ outcome: "rejected", reason: "task conflict" }]);
});

test("bootstrap retries and preparation distinguish stale identity, live gates, and resumable state", async () => {
  const pending = { userId: incarnationFixture.ownerId("user-1"), payload: { strategy: "keep_remote" } };
  const gated = bootstrapFixture({ state: { bootstrapPending: pending, bootstrapSubmitting: true } });
  await gated.actions.submitBootstrapResolution();
  gated.state.bootstrapSubmitting = false;
  gated.host.navigator.onLine = false;
  await gated.actions.submitBootstrapResolution();
  assert.equal(gated.calls.includes("login"), false);

  const stale = bootstrapFixture({ state: { bootstrapPending: pending }, syncCore: { pendingResolutionCanSubmit: () => false } });
  await stale.actions.submitBootstrapResolution();
  assert.ok(stale.calls.includes("revalidate"));

  const interrupted = bootstrapFixture({ state: { bootstrapPending: pending }, use: {
    postMutation: async () => { throw new Error("network interrupted"); }
  } });
  await interrupted.actions.submitBootstrapResolution();
  assert.match(interrupted.state.bootstrapError, /exact saved request/);
  assert.equal(interrupted.state.bootstrapSubmitting, false);

  const replaced = bootstrapFixture({ state: { bootstrapPending: pending }, use: {
    postMutation: async () => { throw new Error("network interrupted"); }
  }, syncCore: { pendingMatchesUser: () => false } });
  await replaced.actions.submitBootstrapResolution();
  assert.equal(replaced.state.bootstrapError, null);
  assert.equal(replaced.timers.length, 1);

  const foreignGate = bootstrapFixture({ syncStorage: {
    readBootstrapState: async () => ({ gate: { owner: "peer" }, resolution: null })
  } });
  assert.equal(await foreignGate.actions.reconcilePersistedBootstrapState(), true);
  assert.equal(foreignGate.state.retrying, true);
  const hiddenOwner = bootstrapFixture({ syncCore: { canExposeOwnerState: () => false } });
  assert.equal(await hiddenOwner.actions.reconcilePersistedBootstrapState(), false);
});

test("view branch matrix renders queue states, rich activity, dialogs, and guarded events", async () => {
  const now = new Date();
  const completedAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).toISOString();
  const fixture = viewFixture({ state: {
    bootstrapBlocked: false,
    tasks: [{ id: "task-1", title: "Deep work" }, { id: "task-2", title: "Review" }],
    history: [
      { phase: "focus", status: "completed", taskId: "task-1", completedAt, plannedDurationMs: 3_900_000, pending: true },
      { phase: "unknown", status: "cancelled", taskId: "deleted", endedAt: completedAt, durationMs: 60_000 },
      { phase: "focus", status: "running", taskId: "task-2", occurredAt: completedAt }
    ]
  } });
  fixture.view.renderHistory();
  fixture.view.renderTasks();
  assert.equal(fixture.elements.historyList.children.length, 2);
  assert.equal(fixture.elements.taskList.children.length, 2);
  assert.equal(fixture.view.formatTaskDuration(0), "0 min");
  assert.equal(fixture.view.formatTaskDuration(3_600_000), "1 hr");
  assert.equal(fixture.view.formatTaskDuration(3_900_000), "1 hr 5 min");
  assert.equal(fixture.view.formatHistoryDate(null), "Time not recorded");

  const statusCases = [
    [{ bootstrapSubmitting: true }, "syncing"], [{ bootstrapError: "failed" }, "error"],
    [{ bootstrapBlocked: true, bootstrapPlan: { mode: "choose" } }, "loading"],
    [{ conflict: "peer rejected", pending: [{}] }, "conflict"], [{ syncing: true }, "syncing"],
    [{ retrying: true }, "error"], [{ pendingTaskOperations: [{}] }, "loading"], [{ ready: false }, "loading"]
  ];
  for (const [state, expected] of statusCases) {
    Object.assign(fixture.state, baseState({ bootstrapBlocked: false }), state);
    fixture.view.renderSyncStatus();
    assert.equal(fixture.elements.syncStatus.dataset.state, expected);
  }

  fixture.syncCore.bootstrapDialogView = () => ({ open: true, busy: true, choosing: false, confirming: true, failed: false });
  fixture.state.bootstrapBlocked = true;
  fixture.state.bootstrapStrategy = "keep_local";
  fixture.state.bootstrapFocusTarget = fixture.elements.bootstrapConfirm;
  fixture.view.renderBootstrapDialog();
  assert.equal(fixture.elements.bootstrapConfirmationTitle.textContent, "Confirm");
  assert.equal(fixture.elements.bootstrapConfirm.focused, true);
  fixture.syncCore.bootstrapDialogView = () => ({ open: false });
  fixture.view.renderBootstrapDialog();
  assert.equal(fixture.elements.bootstrapDialog.open, false);

  fixture.view.setupEvents();
  fixture.host.storage({ key: "other", newValue: "1" });
  fixture.host.storage({ key: "pomodoroughPendingLogout", newValue: "1" });
  await Promise.resolve();
  fixture.document.visibilityState = "hidden";
  fixture.document.visibilitychange();
  fixture.document.visibilityState = "visible";
  fixture.host.navigator.onLine = true;
  fixture.state.authenticated = true;
  fixture.state.csrfToken = "csrf";
  fixture.document.visibilitychange();
  assert.ok(fixture.calls.includes("close"));
  assert.ok(fixture.calls.some((entry) => Array.isArray(entry) && entry[0] === "sync"));
});

test("view event failures and timer states fail safely while the full renderer stays usable", async () => {
  const phase = Object.assign(element(), { dataset: { phase: "unknown" } });
  const fixture = viewFixture({ phaseButtons: [phase], state: { bootstrapBlocked: false }, use: {
    addTask: async () => { throw new Error(""); }, persistSettings: async () => { throw new Error("settings locked"); },
    clearLocalData: async () => { throw new Error("storage locked"); }
  } });
  fixture.view.render();
  fixture.view.setupEvents();
  phase.listeners.get("click")();
  fixture.elements.taskInput.value = "Task";
  await fixture.elements.taskForm.listeners.get("submit")({ preventDefault() {} });
  assert.match(fixture.elements.notice.textContent, /Task could not be added/);

  for (const [status, command] of [["running", "pause"], ["paused", "resume"], ["idle", "start"],
    ["completed", "start"], ["cancelled", "start"], ["superseded", "start"]]) {
    fixture.state.timer.status = status;
    fixture.elements.timerToggle.listeners.get("click")();
    assert.ok(fixture.calls.some((entry) => Array.isArray(entry) && entry[0] === "command" && entry[1] === command));
  }
  fixture.state.timer.status = "completed";
  fixture.elements.clearButton.listeners.get("click")();
  fixture.state.timer.status = "idle";
  fixture.elements.clearButton.listeners.get("click")();
  assert.ok(fixture.calls.includes("stop"));
  assert.equal(fixture.calls.some((entry) => Array.isArray(entry) && entry[0] === "command" && entry[1] === "clear"), false);

  fixture.host.storage({ key: "pomodoroughPendingLogout", newValue: "1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(fixture.calls.some((entry) => Array.isArray(entry) && entry[0] === "warn"
    && entry.some((value) => /storage locked/.test(String(value)))));
  fixture.state.conflict = "rejected";
  fixture.elements.conflictDismiss.listeners.get("click")();
  assert.equal(fixture.state.conflict, null);

  fixture.elements.installButton.listeners.get("click")();
  fixture.document.visibilityState = "visible";
  fixture.host.navigator.onLine = true;
  fixture.state.authenticated = false;
  fixture.document.visibilitychange();
  assert.ok(fixture.calls.includes("online"));
});

test("phase choice save failure warns, notices, and reports with static operation", async (t) => {
  const phase = Object.assign(element(), { dataset: { phase: "short_break" } });
  const fixture = viewFixture({ phaseButtons: [phase], use: {
    persistSettings: async () => { throw new Error("phase offline"); }
  } });
  const reports = [];
  const previous = globalThis.PomodoroughSentryClient;
  globalThis.PomodoroughSentryClient = { reportFrontendError: (error, operation) => reports.push([error, operation]) };
  t.after(() => {
    if (previous === undefined) delete globalThis.PomodoroughSentryClient;
    else globalThis.PomodoroughSentryClient = previous;
  });
  fixture.view.setupPreferenceEvents();
  phase.listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.state.selectedPhase, "short_break");
  assert.match(fixture.elements.notice.textContent, /Phase choice could not be saved/);
  assert.ok(fixture.calls.some((entry) => Array.isArray(entry) && entry[0] === "warn"
    && entry.some((value) => /Pomodorough phase choice save failed:/.test(String(value)))));
  assert.equal(reports.length, 1);
  assert.equal(reports[0][1], "view.phase.save-failed");
  assert.match(reports[0][1], /^[a-z0-9][a-z0-9.-]*$/);
  assert.match(String(reports[0][0]?.message || reports[0][0]), /phase offline/);
});

test("bootstrap conflict retry rotates requests and handles invalid or oversized persisted choices", async () => {
  const pending = { userId: incarnationFixture.ownerId("user-1"), payload: { strategy: "keep_remote" } };
  const invalid = bootstrapFixture({ state: {
    bootstrapPending: pending, bootstrapConflict: true, bootstrapStrategy: "unknown"
  } });
  await invalid.actions.retryBootstrapResolution();
  assert.ok(invalid.calls.includes("revalidate"));

  let replacements = 0;
  const retry = bootstrapFixture({ state: {
    bootstrapPending: pending, bootstrapConflict: true, bootstrapStrategy: "keep_remote"
  }, syncStorage: {
    captureResolution: async (_db, payload, options) => {
      replacements += Number(options.replaceExisting);
      throw new Error("capture unavailable");
    }
  } });
  await retry.actions.retryBootstrapResolution();
  assert.equal(replacements, 1);
  assert.equal(retry.state.bootstrapSubmitting, false);
  assert.match(retry.state.bootstrapError, /capture unavailable/);

  const limited = bootstrapFixture({ state: {
    bootstrapPending: pending, bootstrapConflict: true, bootstrapStrategy: "keep_remote"
  } });
  limited.syncStorage.captureResolution = async () => {
    throw new limited.syncStorage.ResolutionLimitError("too many operations");
  };
  await limited.actions.retryBootstrapResolution();
  assert.equal(limited.state.bootstrapLimitError, "too many operations");

  const chooser = bootstrapFixture({ state: { bootstrapPlan: { mode: "choose" } }, syncCore: {
    canSubmitResolution: () => false
  } });
  await chooser.actions.chooseBootstrapStrategy("keep_local");
  assert.equal(chooser.state.bootstrapStrategy, "keep_local");
  await chooser.actions.chooseBootstrapStrategy("keep_remote");
  assert.equal(chooser.state.bootstrapStrategy, "keep_remote");
});
