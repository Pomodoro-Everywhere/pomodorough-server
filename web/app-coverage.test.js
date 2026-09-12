"use strict";

const test = require("node:test");
const incarnationFixture = require("./test/incarnation-fixture.js");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function baseState(overrides = {}) {
  return {
    actionLocked: false, authenticated: false, autoStartBreaks: false,
    bootstrapBlocked: false, bootstrapGatePersisted: false, bootstrapPending: null,
    clockOffset: 0, csrfToken: "", deviceId: "device-1", durationsMs: { focus: 1_500_000 },
    hlcCounter: 0, hlcWallMs: 0, history: [], localOwnerId: incarnationFixture.ownerId("user-1"), pending: [],
    pendingAutoStartOperations: [], pendingDurationOperations: [], pendingSelectedTaskOperations: [],
    pendingTaskOperations: [], ready: true, revision: 2, selectedPhase: "focus",
    selectedTaskId: null, sessionIdentityValidated: true, tasks: [], user: incarnationFixture.accountUser("user-1"),
    ...overrides
  };
}

function actionFixture(overrides = {}) {
  const notices = [];
  const calls = [];
  const state = baseState();
  const use = {
    captureAccountContext: () => incarnationFixture.captureAccountContext(state, host),
    controlsBlocked: () => false,
    persistDurationOperation: async (phase, durationMs) => ({ pendingDurationOperations: [{ phase, durationMs }] }),
    persistAutoStartOperation: async (enabled) => ({ id: `auto-${enabled}` }),
    persistSelectedTaskOperation: async (taskId) => ({ id: `selected-${taskId}` }),
    persistTaskOperation: async (type, task) => ({ id: `${type}-${task.id}` }),
    persistCommand: async (type) => ({ id: `command-${type}` }),
    persistRetargetState: async () => {}, reapplyRetargetToPending: () => {},
    rebuildOptimisticState: () => calls.push("rebuild"), render: () => calls.push("render"),
    renderDurations: () => calls.push("durations"), renderTaskSelector: () => calls.push("selector"),
    renderSyncStatus: () => calls.push("status"), scheduleSync: (delay) => calls.push(`sync:${delay}`),
    showNotice: (message) => notices.push(message), tr: (_key, _args, fallback) => fallback,
    sharedTaskIdentity: async (title) => ({ id: title.toLowerCase(), title }),
    ...overrides
  };
  const host = { setTimeout, clearTimeout };
  const syncStorage = {};
  const actions = require("./app-actions.js").create({ state, external: { host, syncStorage, syncCore: incarnationFixture.sync }, use });
  return { actions, calls, notices, state, use };
}

test("action persistence serializes writes, updates queues, and unlocks after failures", async () => {
  const fixture = actionFixture();
  assert.equal(await fixture.actions.issueDurationOperation("focus", 1_800_000), true);
  assert.deepEqual(fixture.state.pendingDurationOperations, [{ phase: "focus", durationMs: 1_800_000 }]);
  assert.equal(fixture.state.actionLocked, false);
  assert.ok(fixture.calls.includes("rebuild"));
  assert.ok(fixture.calls.includes("sync:0"));

  fixture.use.persistDurationOperation = async () => { throw new Error("disk full"); };
  assert.equal(await fixture.actions.issueDurationOperation("focus", 2_000_000), false);
  assert.deepEqual(fixture.notices, ["disk full"]);
  assert.equal(fixture.state.actionLocked, false);

  fixture.state.actionLocked = true;
  assert.equal(await fixture.actions.issueCommand("pause"), false);
});

test("task actions select existing identities and reject invalid printable names", async () => {
  const fixture = actionFixture();
  fixture.state.tasks = [{ id: "existing", title: "Existing" }];
  assert.equal(await fixture.actions.addTask("existing"), true);
  assert.deepEqual(fixture.state.pendingSelectedTaskOperations, [{ id: "selected-existing" }]);
  assert.match(fixture.notices[0], /already exists/i);

  fixture.use.sharedTaskIdentity = async () => { throw new Error("title must not be empty or non-printable"); };
  await assert.rejects(() => fixture.actions.addTask("\n"), /printable task name/i);
  fixture.use.sharedTaskIdentity = async () => { throw new Error("title exceeds 512 bytes"); };
  await assert.rejects(() => fixture.actions.addTask("x"), /too long/i);
});

function syncFixture(overrides = {}) {
  let listener;
  const timers = [];
  const calls = [];
  const state = baseState(overrides.state);
  const host = {
    navigator: { onLine: true }, console: { warn: (...args) => calls.push(["warn", ...args]) },
    clearTimeout: () => {}, setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; }
  };
  const syncCore = { ...incarnationFixture.sync,
    trustedNow: () => 100, requiresBootstrapResolution: () => false,
    serverClockOffset: () => 17, compareTimerCommands: () => 0, buildSyncBatch: (queues) => queues
  };
  class AccountOwnershipError extends Error {}
  const syncStorage = {
    AccountOwnershipError, readBootstrapState: async () => ({ gate: null, resolution: null }),
    normalizeLegacyDurationOperations: async () => {}, readQueues: async () => ({})
  };
  const use = {
    captureAccountContext: () => incarnationFixture.captureAccountContext(state, host),
    renderSyncStatus: () => calls.push("status"), rebuildOptimisticState: () => calls.push("rebuild"),
    database: () => ({}), compareDurationOperations: () => 0,
    restoreSessionAndSync: () => calls.push("restore"), stopCompletionAlert: () => calls.push("stop"),
    closeRevisionStream: () => calls.push("close"), quarantineOwnerState: () => calls.push("quarantine"),
    render: () => calls.push("render"), ...overrides.use
  };
  const actions = require("./app-sync.js").create({
    state, external: { host, syncCore, syncStorage }, use,
    listen: (_event, callback) => { listener = callback; }
  });
  return { actions, calls, host, listener: () => listener, state, syncStorage, timers };
}

test("sync retry backs off, stays offline, and revision hints force a scheduled sync", () => {
  const fixture = syncFixture();
  fixture.actions.scheduleRetry();
  assert.equal(fixture.timers[0].delay, 1000);
  assert.equal(fixture.actions.retryDelayMsForTest(), 2000);
  fixture.timers[0].callback();
  assert.ok(fixture.calls.includes("restore"));

  fixture.host.navigator.onLine = false;
  fixture.actions.scheduleRetry();
  assert.equal(fixture.timers.length, 1);
  fixture.listener()({ revision: 3 });
  assert.equal(fixture.timers[1].delay, 0);
  fixture.actions.resetSyncRetry();
  assert.equal(fixture.actions.retryDelayMsForTest(), 1000);
});

test("sync preflight blocks on persisted bootstrap state and retries storage failures", async () => {
  const fixture = syncFixture({ state: { authenticated: true, csrfToken: "csrf" } });
  fixture.syncStorage.readBootstrapState = async () => ({ gate: { token: "other" }, resolution: { id: "r" } });
  assert.equal(await fixture.actions.syncPreflight(true), false);
  assert.equal(fixture.state.bootstrapBlocked, true);
  assert.equal(fixture.state.sessionIdentityValidated, false);
  assert.ok(fixture.calls.includes("quarantine"));

  const failure = syncFixture({ state: { authenticated: true, csrfToken: "csrf" } });
  failure.syncStorage.readBootstrapState = async () => { throw new Error("indexeddb unavailable"); };
  assert.equal(await failure.actions.syncPreflight(true), false);
  assert.equal(failure.state.retrying, true);
  assert.equal(failure.timers[0].delay, 1000);
  assert.ok(failure.calls.some((call) => Array.isArray(call) && call[0] === "warn"));
});

function bootstrapFixture() {
  const calls = [];
  const state = baseState({ bootstrapPreview: { revision: 8 }, quarantinedLocal: null });
  class BootstrapGateError extends Error {}
  class ResolutionLimitError extends Error {}
  const syncStorage = {
    BootstrapGateError, ResolutionLimitError,
    allocateClockRequestSequence: async () => 4,
    saveClockOffset: async (_db, offset) => offset,
    captureResolution: async (_db, payload) => payload
  };
  const host = {
    crypto: { randomUUID: () => "request-1" }, console: { warn: () => {} }, setTimeout,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ revision: 8, serverTime: "now", accountIncarnation: state.user.accountIncarnation }) })
  };
  const syncCore = { ...incarnationFixture.sync, validateCanonicalResponse: () => {}, serverClockOffset: () => 23, isResolutionStrategy: (v) => v === "keep_remote" };
  const use = {
    captureAccountContext: () => incarnationFixture.captureAccountContext(state, host),
    database: () => ({}), tabId: () => "tab-1", acquireBootstrapGate: async () => ({ acquired: true }),
    refreshMigratedPreferences: async () => {}, defaultDurationsMs: () => ({}), render: () => calls.push("render"),
    redirectToLogin: () => calls.push("login"), tr: (_key, _args, fallback) => fallback
  };
  const elements = { bootstrapChoiceButtons: [{ dataset: { bootstrapStrategy: "keep_remote" } }] };
  const actions = require("./app-bootstrap.js").create({ state, external: { host, syncCore, syncStorage, elements }, use });
  return { actions, calls, host, state, syncStorage, use };
}

test("bootstrap preview handles authentication, transport failure, and clock persistence", async () => {
  const fixture = bootstrapFixture();
  assert.deepEqual(await fixture.actions.loadBootstrapPreview(), { revision: 8, serverTime: "now", accountIncarnation: fixture.state.user.accountIncarnation });
  assert.equal(fixture.state.clockOffset, 23);

  fixture.host.fetch = async () => ({ ok: false, status: 401 });
  assert.equal(await fixture.actions.loadBootstrapPreview(), undefined);
  assert.ok(fixture.calls.includes("login"));
  fixture.host.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(() => fixture.actions.loadBootstrapPreview(), /503/);
});

test("bootstrap resolution fails closed on invalid strategies and unavailable leases", async () => {
  const fixture = bootstrapFixture();
  await assert.rejects(() => fixture.actions.persistBootstrapResolution("invented"), fixture.syncStorage.BootstrapGateError);
  fixture.use.acquireBootstrapGate = async () => ({ acquired: false });
  await assert.rejects(() => fixture.actions.persistBootstrapResolution("keep_remote"), /Another tab owns/);

  fixture.use.acquireBootstrapGate = async () => ({ acquired: true });
  const pending = await fixture.actions.persistBootstrapResolution("keep_remote");
  assert.equal(pending.requestId, "request-1");
  assert.equal(fixture.state.bootstrapGateOwned, true);

  const handled = fixture.actions.handleResolutionLimit(new fixture.syncStorage.ResolutionLimitError("too many commands"));
  assert.equal(handled, true);
  assert.equal(fixture.state.bootstrapLimitError, "too many commands");
  assert.equal(fixture.actions.handleResolutionLimit(new Error("other")), false);
});

test("bootstrap conflict classification accepts replay-safe outcomes and reports rejections", () => {
  const fixture = bootstrapFixture();
  const group = (outcome) => ({ acknowledgements: [{ outcome }] });
  const validated = {
    commands: group("accepted"), tasks: group("ignored"), durations: group("duplicate"),
    autoStart: group("rejected"), selectedTask: group("")
  };
  assert.deepEqual(fixture.actions.bootstrapConflicts(validated), [{ outcome: "rejected" }]);
});

function fakeElement() {
  return {
    children: [], dataset: {}, style: {},
    append(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this[name] = value; }
  };
}

function viewFixture(overrides = {}) {
  const elements = {
    taskSelector: fakeElement(), timerToggle: fakeElement(), timerInstruction: fakeElement(),
    finishButton: fakeElement(), cancelButton: fakeElement(), clearButton: fakeElement(),
    ...overrides.elements
  };
  const state = baseState({
    timer: { status: "idle" }, tasks: [], selectedTaskId: null,
    ...overrides.state
  });
  const use = {
    captureAccountContext: () => incarnationFixture.captureAccountContext(state, host),
    controlsBlocked: () => false, tr: (_key, _args, fallback) => fallback,
    phaseLabel: (phase) => phase, activeCompletionAlertTimerId: () => null,
    updateTimerCompletion: () => {}, ...overrides.use
  };
  const view = require("./app-view.js").create({
    state, external: {
      host: { document: { createElement: () => fakeElement() } },
      syncCore: {}, syncStorage: {}, elements
    }, use
  });
  return { elements, state, use, view };
}

test("view task selector preserves an unavailable selection without enabling it", () => {
  const fixture = viewFixture({
    state: { selectedTaskId: "deleted", tasks: [{ id: "live", title: "Live task" }] }
  });
  fixture.view.renderTaskSelector();
  assert.equal(fixture.elements.taskSelector.children.length, 3);
  assert.equal(fixture.elements.taskSelector.children[0].textContent, "No task");
  assert.equal(fixture.elements.taskSelector.children[1].value, "deleted");
  assert.equal(fixture.elements.taskSelector.children[1].disabled, true);
  assert.equal(fixture.elements.taskSelector.children[2].textContent, "Live task");
  assert.equal(fixture.elements.taskSelector.value, "deleted");

  fixture.state.selectedPhase = "short_break";
  fixture.view.renderTaskSelector();
  assert.equal(fixture.elements.taskSelector.disabled, false);
});

test("view timer instructions and controls distinguish active and terminal states", () => {
  const updates = [];
  const fixture = viewFixture({ use: {
    updateTimerCompletion: (...args) => updates.push(args), activeCompletionAlertTimerId: () => "ringing"
  } });
  const timer = { phase: "focus" };
  fixture.view.renderTimerInstruction(timer, "running");
  assert.equal(fixture.elements.timerToggle.textContent, "Pause");
  fixture.view.renderTimerInstruction(timer, "paused");
  assert.equal(fixture.elements.timerToggle.textContent, "Resume");
  fixture.view.renderTimerInstruction(timer, "completed");
  assert.equal(fixture.elements.timerInstruction.textContent, "Run complete. Stop the sound or start another.");

  fixture.view.renderTimerControls(timer, { status: "running", remaining: 25 });
  assert.equal(fixture.elements.finishButton.disabled, false);
  fixture.view.renderTimerControls(timer, { status: "completed", remaining: 0 });
  assert.equal(fixture.elements.finishButton.disabled, true);
  assert.equal(fixture.elements.clearButton.disabled, false);
  assert.deepEqual(updates.at(-1), [timer, "completed", 0, false]);

  fixture.view.renderTimerInstruction(timer, "cancelled");
  assert.equal(fixture.elements.timerInstruction.textContent, "Run cancelled. Start another.");
});

test("view clear control is stop-sound only and never dismisses terminal timers", () => {
  const ringing = viewFixture({ use: { activeCompletionAlertTimerId: () => "ringing" } });
  ringing.view.renderTimerControls({ phase: "focus" }, { status: "completed", remaining: 0 });
  assert.equal(ringing.elements.clearButton.disabled, false);

  const silent = viewFixture();
  for (const status of ["idle", "running", "paused", "completed", "cancelled", "superseded"]) {
    silent.view.renderTimerControls({ phase: "focus" }, { status, remaining: 0 });
    assert.equal(silent.elements.clearButton.disabled, true, status);
  }
});

function dialFixture() {
  const lines = [];
  const dialTicks = {
    children: [],
    replaceChildren(...children) { this.children = children; },
    append(fragment) { this.children.push(...fragment.children); }
  };
  const document = {
    createDocumentFragment() {
      return { children: [], append(line) { this.children.push(line); } };
    },
    createElementNS: () => ({
      attributes: {},
      classList: { add() {} },
      setAttribute(name, value) { this.attributes[name] = value; }
    }),
    createElement: () => fakeElement()
  };
  const elements = {
    taskSelector: fakeElement(), timerToggle: fakeElement(), timerInstruction: fakeElement(),
    finishButton: fakeElement(), cancelButton: fakeElement(), clearButton: fakeElement(),
    dialTicks, dialProgress: { style: {} }, dial: { dataset: {} },
    phaseLabel: fakeElement(), timerDisplay: fakeElement(), timerDetail: fakeElement(),
    longBreakProgress: fakeElement()
  };
  const state = baseState({
    timer: { id: "timer-1", phase: "focus", status: "running", plannedDurationMs: 1_500_000 },
    tasks: [], selectedTaskId: null
  });
  const use = {
    captureAccountContext: () => incarnationFixture.captureAccountContext(state, {}),
    controlsBlocked: () => false, tr: (_key, _args, fallback) => fallback,
    phaseLabel: (phase) => phase, phaseShortLabel: (phase) => phase,
    timerStatusLabel: (status) => status,
    activeCompletionAlertTimerId: () => null, updateTimerCompletion: () => {},
    elapsedFor: () => 0, emptyTimer: (phase, plannedDurationMs) => ({ phase, plannedDurationMs }),
    selectedDurationMs: () => 1_500_000, completedFocusCountForDay: () => 0,
    longBreakProgress: () => 0, positiveNumber: (value, fallback) => Number(value) || fallback,
    startCompletionAlert: () => {}
  };
  const view = require("./app-view.js").create({
    state, external: { host: { document }, syncCore: {}, syncStorage: {}, elements }, use
  });
  return { elements, state, use, view, lines };
}

test("view dial renders one tick per minute of the displayed timer", () => {
  const fixture = dialFixture();
  assert.equal(fixture.view.dialTickCountFor({ plannedDurationMs: 1_500_000 }), 25);
  assert.equal(fixture.view.dialTickCountFor({ plannedDurationMs: 90_000 }), 2);
  assert.equal(fixture.view.dialTickCountFor({ plannedDurationMs: 60_000 }), 1);
  assert.equal(fixture.view.dialTickCountFor({ plannedDurationMs: 0 }), 1);

  fixture.view.createDialTicks(25);
  assert.equal(fixture.elements.dialTicks.children.length, 25);
  fixture.view.createDialTicks(5);
  assert.equal(fixture.elements.dialTicks.children.length, 5);

  fixture.view.renderTimer();
  assert.equal(fixture.elements.dialTicks.children.length, 25);

  fixture.state.timer = { id: null, phase: "short_break", status: "idle", plannedDurationMs: 300_000 };
  fixture.state.selectedPhase = "short_break";
  fixture.use.selectedDurationMs = () => 300_000;
  fixture.view.renderTimer();
  assert.equal(fixture.elements.dialTicks.children.length, 5);
});

test("startup sizes the first dial paint instead of flashing the 60-tick default", () => {
  const composition = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
  assert.doesNotMatch(composition, /call\(application, "createDialTicks"\)/);
  assert.match(composition, /call\(application, "createDialTicks", call\(application, "dialTickCountFor"/);
  assert.match(composition, /const initialDialTimer = call\(application, "displayTimer"\)/);
  assert.match(composition, /dialTickCountFor", initialDialTimer/);
});

test("dial tick sizing stays bounded for edge durations and render clamps", () => {
  const fixture = dialFixture();
  assert.equal(fixture.view.dialTickCountFor(undefined), 1);
  assert.equal(fixture.view.dialTickCountFor(null), 1);
  assert.equal(fixture.view.dialTickCountFor({}), 1);
  assert.equal(fixture.view.dialTickCountFor({ plannedDurationMs: -60_000 }), 1);
  assert.equal(fixture.view.dialTickCountFor({ plannedDurationMs: Number.NaN }), 1);
  assert.equal(fixture.view.dialTickCountFor({ plannedDurationMs: 90_001 }), 2);
  assert.equal(fixture.view.dialTickCountFor({ plannedDurationMs: 14_400_000 }), 240);
  assert.equal(fixture.view.dialTickCountFor({ plannedDurationMs: 15_000_000 }), 250);

  fixture.view.createDialTicks(0);
  assert.equal(fixture.elements.dialTicks.children.length, 1);
  fixture.view.createDialTicks(-5);
  assert.equal(fixture.elements.dialTicks.children.length, 1);
  fixture.view.createDialTicks(Number.NaN);
  assert.equal(fixture.elements.dialTicks.children.length, 1);
  fixture.view.createDialTicks(1000);
  assert.equal(fixture.elements.dialTicks.children.length, 240);
  fixture.view.createDialTicks();
  assert.equal(fixture.elements.dialTicks.children.length, 60);
});

test("retarget persist failure keeps the selection and reports statically", async (t) => {
  const fixture = actionFixture();
  fixture.state.tasks = [{ id: "task-new", title: "New" }];
  fixture.state.selectedTaskId = "task-old";
  fixture.state.timer = { id: "timer-1", phase: "focus", status: "running", plannedDurationMs: 1_500_000 };
  fixture.state.pending = [];
  fixture.state.pendingSelectedTaskOperations = [];
  fixture.use.persistSelectedTaskOperation = async (taskId) => ({ id: `selected-${taskId}`, taskId });
  fixture.use.persistRetargetState = async () => { throw new Error("retarget offline"); };
  fixture.use.reapplyRetargetToPending = () => {};
  const reports = [];
  const previous = globalThis.PomodoroughSentryClient;
  globalThis.PomodoroughSentryClient = { reportFrontendError: (error, operation) => reports.push([error, operation]) };
  t.after(() => {
    if (previous === undefined) delete globalThis.PomodoroughSentryClient;
    else globalThis.PomodoroughSentryClient = previous;
  });
  assert.equal(await fixture.actions.issueSelectedTaskOperation("task-new"), true);
  assert.deepEqual(fixture.state.pendingSelectedTaskOperations, [{ id: "selected-task-new", taskId: "task-new" }]);
  assert.deepEqual(fixture.state.retargetedTaskByTimerId, { "timer-1": "task-new" });
  assert.equal(fixture.state.actionLocked, false);
  assert.ok(fixture.calls.includes("rebuild"));
  assert.equal(reports.length, 1);
  assert.equal(reports[0][1], "actions.retarget.persist-failed");
  assert.match(reports[0][1], /^[a-z0-9][a-z0-9.-]*$/);
  assert.match(String(reports[0][0]?.message || reports[0][0]), /retarget offline/);
});

test("view timer projection clamps elapsed time and formats accessible clock text", () => {
  const state = baseState({ timer: { status: "idle" } });
  const use = {
    captureAccountContext: () => incarnationFixture.captureAccountContext(state, host),
    elapsedFor: () => 61_001, emptyTimer: (phase, plannedDurationMs) => ({ phase, plannedDurationMs }),
    selectedDurationMs: () => 90_000
  };
  const view = require("./app-view.js").create({
    state, external: { host: { document: {} }, syncCore: {}, syncStorage: {}, elements: {} }, use
  });
  assert.deepEqual(view.timerDisplayView({ plannedDurationMs: 125_000 }, "running"), {
    remaining: 63_999, progress: 61_001 / 125_000, totalSeconds: 64,
    minutes: 1, seconds: 4, timeText: "01:04", status: "running"
  });
  use.elapsedFor = () => 500;
  assert.equal(view.timerDisplayView({ plannedDurationMs: 0 }, "paused").progress, 0);
  assert.deepEqual(view.displayTimer(), { phase: "focus", plannedDurationMs: 90_000 });
});
