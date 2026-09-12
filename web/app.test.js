"use strict";

const test = require("node:test");
const incarnationFixture = require("./test/incarnation-fixture.js");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { indexedDB } = require("fake-indexeddb");
const productionSync = require("./sync-core.js");
const legacyDecisionCompat = require("./test/legacy-sync-decision-compat.js");
// VM fixtures stay synchronous; removed decision helpers live only in test compatibility code.
const sync = Object.freeze({ ...productionSync, ...legacyDecisionCompat });
const createTimerReducer = require("./test/app-timer-reducer.js");

function completionPlanFixture(input) {
  if (input.phase !== "focus") return { selectedPhase: "focus" };
  const reference = new Date(input.referenceMs);
  const start = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate()).getTime();
  const end = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() + 1).getTime();
  const completed = input.history.filter((item) => {
    const at = Date.parse(item.completedAt || item.endedAt);
    return item.phase === "focus" && item.status === "completed" && at >= start && at < end;
  }).length;
  return { selectedPhase: completed > 0 && completed % 4 === 0 ? "long_break" : "short_break" };
}

test("production bootstrap and reconciliation use shared-core storage adapters", () => {
  const source = ["app-state.js", "app-storage.js", "app-sync.js", "app-bootstrap.js"]
    .map((file) => fs.readFileSync(path.join(__dirname, file), "utf8")).join("\n");
  assert.match(source, /syncStorage\.bootstrapPlan\(/);
  assert.match(source, /syncStorage\.reconcileState\(/);
  assert.match(source, /syncStorage\.reconcileResolutionState\(/);
  assert.match(source, /\.taskIdentity\(/);
  assert.doesNotMatch(source, /syncCore\.decideBootstrap\(/);
  assert.doesNotMatch(source, /syncCore\.rebaseSyncState\(/);
  assert.doesNotMatch(source, /syncCore\.applyResolutionState\(/);
  assert.doesNotMatch(source, /\.call\("(?:task\.identity|projection\.apply|bootstrap\.plan|reconcile\.rebase)/);
  assert.doesNotMatch(source, /function reduceCommand\(/);
});

function loadTaskProjection() {
  const appPath = path.join(__dirname, "app.js");
  let scheduledTimeout = null;
  const scheduledTimeouts = [];
  const scheduledIntervals = [];
  const clearedIntervals = [];
  const notifications = [];
  const eventSources = [];
  const warnings = [];
  let toneStarts = 0;
  let allocatedMutationInput = null;
  let queues = {
    commands: [],
    taskOperations: [],
    durationOperations: [],
    autoStartOperations: [],
    selectedTaskOperations: []
  };
  const taskSelector = {
    options: [],
    replaceChildren() { this.options = []; },
    append(option) { this.options.push(option); },
    value: "",
    disabled: false
  };
  let testDocument;
  function screenButton(screen) {
    const listeners = new Map();
    return {
      dataset: { screenButton: screen },
      attributes: new Map(),
      tabIndex: screen === "timer" ? 0 : -1,
      addEventListener(type, listener) { listeners.set(type, listener); },
      setAttribute(name, value) { this.attributes.set(name, value); },
      getAttribute(name) { return this.attributes.get(name) ?? null; },
      focus() { testDocument.activeElement = this; },
      dispatch(type, properties = {}) {
        const event = {
          currentTarget: this,
          defaultPrevented: false,
          preventDefault() { this.defaultPrevented = true; },
          ...properties
        };
        listeners.get(type)?.(event);
        return event;
      }
    };
  }
  const timerTab = screenButton("timer");
  const tasksTab = screenButton("tasks");
  const screenButtons = [timerTab, tasksTab];
  const timerScreen = { hidden: false };
  const tasksScreen = { hidden: true };
  const deleteAccountButton = { disabled: false };
  const logoutButton = { disabled: false };
  const notice = { textContent: "", hidden: true };
  const testElements = {
    "#taskSelector": taskSelector,
    "#syncStatus": { dataset: {} },
    "#syncStatusText": { textContent: "" },
    "#profile": { hidden: true },
    "#profileAvatar": {
      hidden: true,
      removeAttribute(name) { if (name === "src") delete this.src; }
    },
    "#deleteAccountButton": deleteAccountButton,
    "#logoutButton": logoutButton,
    "#notice": notice,
    "#timerScreen": timerScreen,
    "#tasksScreen": tasksScreen
  };
  testDocument = {
    activeElement: null,
    querySelector: (selector) => testElements[selector] || null,
    querySelectorAll: (selector) => selector === "[data-screen-button]" ? screenButtons : [],
    createElement: () => ({ value: "", textContent: "", disabled: false })
  };
  const context = {
    PomodoroughSync: sync,
    PomodoroughAppTest: { disableAutoStart: true },
    PomodoroughStorage: {
      AccountOwnershipError: incarnationFixture.storage.AccountOwnershipError,
      assertAccountOwnership: incarnationFixture.storage.assertAccountOwnership,
      BootstrapGateError: class BootstrapGateError extends Error {},
      async guardedMutation(database, stores, callback) {
        const transaction = database.transaction([...new Set(["meta", ...stores])], "readwrite");
        callback(transaction);
        await new Promise((resolve, reject) => {
          transaction.oncomplete = resolve;
          transaction.onabort = () => reject(transaction.error);
          transaction.onerror = () => {};
        });
      },
      finishAppliedPlan: completionPlanFixture,
      async normalizeLegacyDurationOperations() {},
      async clearBootstrapGate() {},
      async readBootstrapState() { return { gate: null, resolution: null }; },
      async readAccountBinding() { return { sourceOwnerId: null, gateOwnerId: null }; },
      async acquireBootstrapGateWithLegacyAutoStart() {
        return { acquired: true, resolution: null };
      },
      async readQueues() { return queues; },
      async readSyncState() {
        const state = context.PomodoroughAppTest.state;
        return { snapshot: state.localOwnerId ? { user: state.user } : null,
          ...await context.PomodoroughStorage.readQueues() };
      },
      projectState(input) {
        const app = context.PomodoroughAppTest;
        let projectedTimer = input.snapshot?.canonicalTimer
          ? structuredClone(input.snapshot.canonicalTimer)
          : null;
        let history = structuredClone(input.snapshot?.history || []);
        const sessions = new Map();
        for (const command of [...(input.queues?.commands || [])].sort(sync.compareTimerCommands)) {
          const reduced = app.reduceCommand(projectedTimer, history, command, sessions);
          projectedTimer = reduced.timer?.id ? reduced.timer : null;
          history = reduced.history;
        }
        const tasks = sync.applyTaskOperations(
          structuredClone(input.snapshot?.tasks || []),
          input.queues?.taskOperations || []
        );
        const selectedTaskId = sync.applySelectedTaskOperations(
          input.snapshot?.selectedTaskId ?? null,
          input.queues?.selectedTaskOperations || []
        );
        return {
          canonicalTimer: projectedTimer,
          history,
          tasks,
          durationsMs: sync.applyDurationOperations(
            structuredClone(input.snapshot?.durationsMs),
            input.queues?.durationOperations || []
          ),
          autoStartBreaks: sync.applyAutoStartOperations(
            input.snapshot?.autoStartBreaks === true,
            input.queues?.autoStartOperations || []
          ),
          selectedTaskId: selectedTaskId !== null && tasks.some((task) => task.id === selectedTaskId)
            ? selectedTaskId
            : null
        };
      },
      async allocateMutation(_database, input) {
        allocatedMutationInput = input;
        return input.build({ id: "selected-operation", wallMs: baseTime, counter: 0 });
      }
    },
    console: { ...console, warn(...args) { warnings.push(args); } },
    fetch: async () => ({ ok: true, status: 204 }),
    crypto: { randomUUID: () => "test-tab-id" },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    localStorage: {
      values: new Map(),
      getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
      setItem(key, value) { this.values.set(key, String(value)); },
      removeItem(key) { this.values.delete(key); }
    },
    document: testDocument,
    indexedDB,
    navigator: { onLine: true },
    EventSource: class TestEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        this.closed = false;
        this.onmessage = null;
        this.onerror = null;
        eventSources.push(this);
      }

      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }

      emit(type, data) {
        const event = { data };
        if (type === "message") this.onmessage?.(event);
        else this.listeners.get(type)?.(event);
      }

      close() {
        this.closed = true;
      }
    },
    Notification: class TestNotification {
      static permission = "granted";

      static async requestPermission() {
        return this.permission;
      }

      constructor(title, options) {
        this.title = title;
        this.options = options;
        this.closed = false;
        notifications.push(this);
      }

      close() {
        this.closed = true;
      }
    },
    AudioContext: class TestAudioContext {
      constructor() {
        this.state = "suspended";
        this.currentTime = 10;
        this.destination = {};
      }

      async resume() {
        this.state = "running";
      }

      createOscillator() {
        return {
          frequency: { value: 0 },
          connect() {},
          start() { toneStarts += 1; },
          stop() {}
        };
      }

      createGain() {
        return { gain: { value: 0 }, connect() {} };
      }
    },
    window: {
      location: { href: "", assign(value) { this.href = value; } },
      prompt: () => null,
      confirm: () => false,
      clearInterval(id) {
        clearedIntervals.push(id);
      },
      clearTimeout: () => {},
      setInterval(callback, delay) {
        scheduledIntervals.push({ callback, delay });
        return scheduledIntervals.length;
      },
      setTimeout(callback, delay) {
        scheduledTimeout = { callback, delay };
        scheduledTimeouts.push(scheduledTimeout);
        return 1;
      }
    }
  };
  context.globalThis = context;
  for (const file of [
    "app-runtime.js", "app-state.js", "app-storage.js", "app-actions.js",
    "app-sync.js", "app-bootstrap.js", "app-session.js", "app-view.js", "app.js"
  ]) {
    const scriptPath = path.join(__dirname, file);
    vm.runInNewContext(fs.readFileSync(scriptPath, "utf8"), context, { filename: scriptPath });
  }
  context.PomodoroughAppTest.reduceCommand = createTimerReducer({
    clone: structuredClone,
    clampNumber(value, minimum, maximum) {
      const number = Number(value);
      if (!Number.isFinite(number)) return minimum;
      return Math.min(maximum, Math.max(minimum, number));
    },
    emptyTimer: context.PomodoroughAppTest.emptyTimer
  });
  context.PomodoroughAppTest.state.deviceId = "test-device";
  return {
    ...context.PomodoroughAppTest,
    scheduledTimeoutDelay() {
      return scheduledTimeout?.delay ?? null;
    },
    scheduledTimeoutDelays() {
      return scheduledTimeouts.map(({ delay }) => delay);
    },
    scheduledIntervals() {
      return scheduledIntervals;
    },
    clearedIntervals() {
      return clearedIntervals;
    },
    notifications() {
      return notifications;
    },
    eventSources() {
      return eventSources;
    },
    warnings() {
      return warnings;
    },
    toneStarts() {
      return toneStarts;
    },
    setOnline(value) {
      context.navigator.onLine = value;
    },
    setPromptResult(value) {
      context.window.prompt = () => value;
    },
    setConfirmResult(value) {
      context.window.confirm = () => value;
    },
    notice() {
      return { textContent: notice.textContent, hidden: notice.hidden };
    },
    deleteAccountButtonDisabled() {
      return deleteAccountButton.disabled;
    },
    logoutButtonDisabled() {
      return logoutButton.disabled;
    },
    locationHref() {
      return context.window.location.href;
    },
    setQueuesForTest(value) {
      queues = value;
    },
    allocatedMutationInput() {
      return allocatedMutationInput;
    },
    taskSelectorOptions() {
      return taskSelector.options.map(({ value, textContent, disabled }) => ({ value, textContent, disabled: disabled === true }));
    },
    taskSelectorDisabled() {
      return taskSelector.disabled;
    },
    screenButton(screen) {
      return screen === "tasks" ? tasksTab : timerTab;
    },
    screenPanel(screen) {
      return screen === "tasks" ? tasksScreen : timerScreen;
    },
    activeElement() {
      return testDocument.activeElement;
    }
  };
}

test("ignored cross-device acknowledgements converge without a conflict", () => {
  const app = loadTaskProjection();
  const groups = {
    commands: { acknowledgements: [{ outcome: "ignored", reason: "superseded" }] },
    tasks: { acknowledgements: [{ outcome: "ignored", reason: "superseded" }] },
    durations: { acknowledgements: [{ outcome: "ignored", reason: "superseded" }] },
    autoStart: { acknowledgements: [{ outcome: "ignored", reason: "superseded" }] },
    selectedTask: { acknowledgements: [{ outcome: "ignored", reason: "superseded" }] }
  };

  assert.deepEqual(app.rejectedSyncAcknowledgements(groups), []);
  groups.commands.acknowledgements[0].outcome = "rejected";
  assert.equal(app.rejectedSyncAcknowledgements(groups).length, 1);
});

const baseTime = Date.parse("2026-07-15T10:00:00.000Z");

function timer(status, id = "timer-state") {
  return {
    id,
    phase: "focus",
    status,
    plannedDurationMs: 60_000,
    elapsedAtAnchorMs: status === "paused" ? 1_000 : 0,
    anchorAt: new Date(baseTime).toISOString(),
    lastIntent: null,
    taskId: "task-source",
    dependsOnCommandId: null
  };
}

function terminalHistory(status, id = "timer-state", commandId = `setup-${status}`) {
  return {
    id,
    timerId: id,
    commandId,
    phase: "focus",
    status,
    plannedDurationMs: 60_000,
    completedAt: status === "completed" ? new Date(baseTime + 1_000).toISOString() : null,
    endedAt: new Date(baseTime + 1_000).toISOString(),
    taskId: "task-source"
  };
}

function matrixState(app, status) {
  if (status === "absent") return { timer: app.emptyTimer("focus", 60_000), history: [] };
  if (status === "superseded") {
    return { timer: timer("running", "timer-current"), history: [terminalHistory("superseded")] };
  }
  return {
    timer: timer(status),
    history: ["completed", "cancelled"].includes(status) ? [terminalHistory(status)] : []
  };
}

function matrixCommand(type, target) {
  return {
    id: "matrix-action",
    deviceSequence: 99,
    timerId: target === "same" ? "timer-state" : "timer-foreign",
    type,
    phase: "short_break",
    plannedDurationMs: 300_000,
    occurredAt: new Date(baseTime + 10_000).toISOString(),
    observedElapsedMs: 10_000
  };
}

function expectedMatrixTimer(status, type, target) {
  if (type === "start") {
    return { id: target === "foreign" ? "timer-foreign" : "timer-state", status: "running" };
  }
  if (status === "absent") return { id: null, status: "idle" };
  if (target === "foreign") {
    return status === "superseded"
      ? { id: "timer-current", status: "running" }
      : { id: "timer-state", status };
  }
  if (type === "clear") {
    return status === "superseded"
      ? { id: "timer-current", status: "running" }
      : { id: null, status: "idle" };
  }
  return {
    id: "timer-state",
    status: {
      pause: "paused",
      resume: "running",
      finish: "completed",
      cancel: "cancelled"
    }[type]
  };
}

test("screen tabs move focus and activation with arrows, Home, and End", () => {
  const app = loadTaskProjection();
  const timerTab = app.screenButton("timer");
  const tasksTab = app.screenButton("tasks");
  const timerPanel = app.screenPanel("timer");
  const tasksPanel = app.screenPanel("tasks");

  function assertActive(screen) {
    const timerSelected = screen === "timer";
    assert.equal(app.state.activeScreen, screen);
    assert.equal(timerTab.getAttribute("aria-selected"), String(timerSelected));
    assert.equal(tasksTab.getAttribute("aria-selected"), String(!timerSelected));
    assert.equal(timerTab.tabIndex, timerSelected ? 0 : -1);
    assert.equal(tasksTab.tabIndex, timerSelected ? -1 : 0);
    assert.equal(timerPanel.hidden, !timerSelected);
    assert.equal(tasksPanel.hidden, timerSelected);
    assert.equal(app.activeElement(), timerSelected ? timerTab : tasksTab);
  }

  app.setupScreenNavigation();
  app.renderScreens();
  timerTab.focus();
  assertActive("timer");

  assert.equal(timerTab.dispatch("keydown", { key: "ArrowRight" }).defaultPrevented, true);
  assertActive("tasks");

  assert.equal(tasksTab.dispatch("keydown", { key: "ArrowLeft" }).defaultPrevented, true);
  assertActive("timer");

  assert.equal(timerTab.dispatch("keydown", { key: "End" }).defaultPrevented, true);
  assertActive("tasks");

  assert.equal(tasksTab.dispatch("keydown", { key: "Home" }).defaultPrevented, true);
  assertActive("timer");
});

test("task projection clears unavailable selection and restores it when task reappears", () => {
  const app = loadTaskProjection();
  const { state, rebuildOptimisticState, selectedTaskIdForNextFocus } = app;
  state.baseTasks = [{ id: "selected-task", title: "Selected" }];
  state.pendingTaskOperations = [];
  state.baseSelectedTaskId = "selected-task";
  state.pendingSelectedTaskOperations = [];
  rebuildOptimisticState();

  state.baseTasks = [];
  rebuildOptimisticState();
  assert.equal(state.tasks.length, 0);
  assert.equal(state.selectedTaskId, null);
  assert.equal(selectedTaskIdForNextFocus(), null);
  app.renderTaskSelector();
  assert.deepEqual(app.taskSelectorOptions(), [
    { value: "", textContent: "No task", disabled: false }
  ]);

  state.pendingTaskOperations = [{
    id: "task-operation-upsert",
    taskId: "selected-task",
    type: "upsert",
    title: "Selected",
    hlcWallMs: 1,
    hlcCounter: 0
  }];
  rebuildOptimisticState();
  assert.deepEqual(Array.from(state.tasks, (task) => task.id), ["selected-task"]);
  assert.equal(state.selectedTaskId, "selected-task");
  assert.equal(selectedTaskIdForNextFocus(), "selected-task");

  state.pendingTaskOperations.push({
    id: "task-operation-delete",
    taskId: "selected-task",
    type: "delete",
    hlcWallMs: 2,
    hlcCounter: 0
  });
  rebuildOptimisticState();
  assert.equal(state.tasks.length, 0);
  assert.equal(state.selectedTaskId, null);
});

test("focus task selection retargets the running timer while the selector stays enabled", async () => {
  const app = loadTaskProjection();
  app.setDatabaseForTest({});
  app.state.ready = true;
  app.state.bootstrapBlocked = false;
  app.state.selectedPhase = "focus";
  app.state.tasks = [{ id: "active-task", title: "Active task" }, { id: "next-task", title: "Next task" }];
  app.state.baseTasks = structuredClone(app.state.tasks);
  app.state.selectedTaskId = "active-task";
  app.state.baseSelectedTaskId = "active-task";
  app.state.timer = {
    id: "active-timer",
    status: "paused",
    phase: "focus",
    taskId: "active-task",
    plannedDurationMs: 1_500_000,
    elapsedAtAnchorMs: 60_000
  };
  app.state.baseTimer = structuredClone(app.state.timer);
  app.state.pending = [{
    id: "start-active", deviceId: "test-device", deviceSequence: 1, timerId: "active-timer",
    type: "start", phase: "focus", plannedDurationMs: 1_500_000,
    occurredAt: new Date(baseTime).toISOString(), hlcWallMs: baseTime, hlcCounter: 0,
    observedElapsedMs: 0, taskId: "active-task"
  }];

  app.renderTaskSelector();
  assert.equal(app.taskSelectorDisabled(), false);

  assert.equal(await app.issueSelectedTaskOperation("next-task"), true);
  assert.equal(app.state.selectedTaskId, "next-task");
  assert.equal(app.state.timer.taskId, "next-task");
  assert.equal(app.state.pending.find((command) => command.id === "start-active").taskId, "next-task");
  assert.equal(app.displayTimer().taskId, "next-task");
  assert.equal(
    app.historyTaskContext({ timerId: "active-timer", taskId: "active-task" }, app.state.tasks),
    "Next task"
  );

  app.state.selectedPhase = "short_break";
  app.renderTaskSelector();
  assert.equal(app.taskSelectorDisabled(), false);
});

test("start replaces a finished timer while retaining it in history", () => {
  const app = loadTaskProjection();
  const finished = timer("completed", "timer-old");
  const history = [terminalHistory("completed", "timer-old")];
  const started = {
    id: "start-new", deviceId: "test-device", deviceSequence: 2, timerId: "timer-new",
    type: "start", phase: "focus", plannedDurationMs: 1_500_000,
    occurredAt: new Date(baseTime + 60_000).toISOString(),
    hlcWallMs: baseTime + 60_000, hlcCounter: 0, observedElapsedMs: 0
  };
  const reduced = app.reduceCommand(finished, history, started, new Map());
  assert.equal(reduced.timer.id, "timer-new");
  assert.equal(reduced.timer.status, "running");
  assert.ok(reduced.history.some((item) => item.timerId === "timer-old" && item.status === "completed"));
  assert.equal(reduced.history.some((item) => item.timerId === "timer-new"), false);
});

test("No task selection persists nullable operation and retargets the running timer", async () => {
  const app = loadTaskProjection();
  app.setDatabaseForTest({});
  app.state.ready = true;
  app.state.bootstrapBlocked = false;
  app.state.baseSelectedTaskId = "task-current";
  app.state.selectedTaskId = "task-current";
  app.state.pendingSelectedTaskOperations = [];
  app.state.timer = timer("running", "canonical-active");
  app.state.baseTimer = structuredClone(app.state.timer);

  assert.equal(await app.issueSelectedTaskOperation(null), true);

  assert.equal(app.allocatedMutationInput().storeName, "pendingSelectedTasks");
  assert.deepEqual(JSON.parse(JSON.stringify(app.state.pendingSelectedTaskOperations)), [{
    id: "selected-operation",
    deviceId: "test-device",
    taskId: null,
    occurredAt: new Date(baseTime).toISOString(),
    hlcWallMs: baseTime,
    hlcCounter: 0
  }]);
  assert.equal(app.state.selectedTaskId, null);
  assert.equal(app.state.timer.taskId, null);
  assert.equal(app.displayTimer().taskId, null);
  assert.equal(app.scheduledTimeoutDelay(), 0);
});

test("queue refresh rebuilds selected-task projection from peer operations", async () => {
  const app = loadTaskProjection();
  app.setDatabaseForTest({});
  app.state.baseTasks = [
    { id: "task-first", title: "First" },
    { id: "task-second", title: "Second" }
  ];
  app.state.baseSelectedTaskId = "task-first";
  app.state.pendingSelectedTaskOperations = [];
  app.rebuildOptimisticState();
  app.setQueuesForTest({
    commands: [],
    taskOperations: [],
    durationOperations: [],
    autoStartOperations: [],
    selectedTaskOperations: [{
      id: "peer-selected-operation",
      taskId: "task-second",
      occurredAt: new Date(baseTime).toISOString(),
      hlcWallMs: baseTime,
      hlcCounter: 0
    }]
  });

  await app.refreshAllPendingOperations();

  assert.equal(app.state.selectedTaskId, "task-second");
  assert.equal(app.selectedTaskIdForNextFocus(), "task-second");
});

test("owner quarantine round-trip preserves selected-task base and pending claims", () => {
  const app = loadTaskProjection();
  app.state.baseSelectedTaskId = "task-canonical";
  app.state.selectedTaskId = "task-pending";
  app.state.pendingSelectedTaskOperations = [{
    id: "selected-pending",
    taskId: "task-pending",
    occurredAt: new Date(baseTime).toISOString(),
    hlcWallMs: baseTime,
    hlcCounter: 1
  }];
  const owner = app.ownerStateValue();

  app.resetOwnerState();
  assert.equal(app.state.selectedTaskId, null);
  assert.deepEqual(JSON.parse(JSON.stringify(app.state.pendingSelectedTaskOperations)), []);
  app.restoreOwnerState(owner);

  assert.equal(app.state.baseSelectedTaskId, "task-canonical");
  assert.equal(app.state.selectedTaskId, "task-pending");
  assert.deepEqual(
    JSON.parse(JSON.stringify(app.state.pendingSelectedTaskOperations)),
    JSON.parse(JSON.stringify(owner.pendingSelectedTaskOperations))
  );
});

test("cached owner activation restores quarantined state only before identity validation", async () => {
  const app = loadTaskProjection();
  app.state.user = incarnationFixture.accountUser("cached-owner");
  app.state.localOwnerId = incarnationFixture.ownerId("cached-owner");
  app.state.baseSelectedTaskId = "task-cached";
  app.state.selectedTaskId = "task-cached";
  const cached = app.ownerStateValue();
  app.resetOwnerState();
  app.state.quarantinedLocal = cached;
  app.state.localOwnerId = incarnationFixture.ownerId("cached-owner");
  app.state.bootstrapGateOwned = true;
  app.state.bootstrapPending = null;
  app.state.sessionIdentityValidated = false;
  app.state.authenticated = true;
  app.state.csrfToken = "stale-csrf";
  app.state.bootstrapBlocked = true;
  app.state.bootstrapGatePersisted = true;

  assert.equal(await app.activateCachedOwnerOffline(), true);
  assert.equal(app.state.user.id, "cached-owner");
  assert.equal(app.state.selectedTaskId, "task-cached");
  assert.equal(app.state.quarantinedLocal, null);
  assert.equal(app.state.authenticated, false);
  assert.equal(app.state.csrfToken, null);
  assert.equal(app.state.offlineOwnerMode, true);
  assert.equal(app.state.bootstrapBlocked, false);
  assert.equal(app.state.bootstrapGatePersisted, false);
  assert.equal(app.state.bootstrapGateOwned, false);

  app.state.quarantinedLocal = cached;
  app.state.localOwnerId = incarnationFixture.ownerId("cached-owner");
  app.state.bootstrapGateOwned = true;
  app.state.sessionIdentityValidated = true;
  assert.equal(await app.activateCachedOwnerOffline(), false);
  assert.equal(app.state.quarantinedLocal, cached);
});

test("changed session identity closes old revision stream before replacement", () => {
  const app = loadTaskProjection();
  let closeCount = 0;
  app.state.user = incarnationFixture.accountUser("user-old");
  app.setRevisionStreamForTest({ close() { closeCount += 1; } });

  app.closeRevisionStreamForIdentityChange(incarnationFixture.ownerId("user-new"));

  assert.equal(closeCount, 1);
  assert.equal(app.hasRevisionStreamForTest(), false);
});

test("explicit identity teardown closes the current revision stream", () => {
  const app = loadTaskProjection();
  let closed = false;
  app.state.user = incarnationFixture.accountUser("account-a");
  app.setRevisionStreamForTest({ close() { closed = true; } });
  app.closeRevisionStreamForIdentityChange();
  assert.equal(closed, true);
  assert.equal(app.hasRevisionStreamForTest(), false);
});

test("unchanged session identity keeps current revision stream", () => {
  const app = loadTaskProjection();
  let closeCount = 0;
  app.state.user = incarnationFixture.accountUser("user-1");
  app.setRevisionStreamForTest({ close() { closeCount += 1; } });

  app.closeRevisionStreamForIdentityChange(incarnationFixture.ownerId("user-1"));

  assert.equal(closeCount, 0);
  assert.equal(app.hasRevisionStreamForTest(), true);
});

test("revision stream opens only for a validated online account without bootstrap work", () => {
  const app = loadTaskProjection();
  app.openRevisionStream();
  assert.equal(app.eventSources().length, 0);

  app.state.sessionIdentityValidated = true;
  app.state.authenticated = true;
  app.state.bootstrapBlocked = false;
  app.state.bootstrapGatePersisted = false;
  app.setOnline(false);
  app.openRevisionStream();
  assert.equal(app.eventSources().length, 0);

  app.setOnline(true);
  app.openRevisionStream();
  app.openRevisionStream();
  assert.equal(app.eventSources().length, 1);
  assert.equal(app.eventSources()[0].url, "/api/v1/stream");
});

test("revision stream schedules newer and malformed hints then closes on offline failure", () => {
  const app = loadTaskProjection();
  app.state.sessionIdentityValidated = true;
  app.state.authenticated = true;
  app.state.bootstrapBlocked = false;
  app.state.bootstrapGatePersisted = false;
  app.state.revision = 12;
  app.openRevisionStream();
  const source = app.eventSources()[0];

  source.emit("message", "12");
  assert.deepEqual(app.scheduledTimeoutDelays(), []);
  source.emit("revision", JSON.stringify({ revision: 13 }));
  source.emit("message", "not-a-revision");
  assert.deepEqual(app.scheduledTimeoutDelays(), [0, 0]);

  source.onerror();
  assert.equal(source.closed, false);
  app.setOnline(false);
  source.onerror();
  assert.equal(source.closed, true);
  assert.equal(app.hasRevisionStreamForTest(), false);
});

test("periodic reconciliation forces an empty-queue canonical pull after a missed revision hint", () => {
  const app = loadTaskProjection();
  const forceValues = [];
  app.state.ready = true;
  app.state.sessionIdentityValidated = true;
  app.state.authenticated = true;
  app.state.csrfToken = "csrf";
  app.state.bootstrapBlocked = false;
  app.state.pending = [];
  app.state.pendingTaskOperations = [];
  app.state.pendingDurationOperations = [];
  app.state.pendingAutoStartOperations = [];

  assert.equal(app.pollRemoteState((force) => forceValues.push(force)), true);

  assert.deepEqual(forceValues, [true]);
  assert.ok(app.scheduledIntervals().some(({ callback, delay }) => (
    callback === app.pollRemoteState && delay === app.remoteSyncIntervalMs
  )));
});

test("periodic reconciliation stays idle while offline or bootstrap-blocked", () => {
  const app = loadTaskProjection();
  let syncCount = 0;
  app.state.ready = true;
  app.state.sessionIdentityValidated = true;
  app.state.authenticated = true;
  app.state.csrfToken = "csrf";
  app.state.bootstrapBlocked = true;

  assert.equal(app.pollRemoteState(() => { syncCount += 1; }), false);
  app.state.bootstrapBlocked = false;
  app.setOnline(false);
  assert.equal(app.pollRemoteState(() => { syncCount += 1; }), false);

  assert.equal(syncCount, 0);
});

test("completion alert notifies and repeats sound until explicitly stopped", async () => {
  const app = loadTaskProjection();
  const completed = timer("completed", "completed-focus");

  await app.primeCompletionAlerts();
  assert.equal(app.completionAlertTitle(completed), "Focus complete");
  assert.equal(app.startCompletionAlert(completed), true);
  assert.equal(app.completionAlertTimerIDTest(), completed.id);
  assert.equal(app.toneStarts(), 1);
  assert.equal(app.notifications().length, 1);
  assert.equal(app.notifications()[0].title, "Focus complete");
  assert.equal(app.notifications()[0].options.body, "Your next Pomodorough interval is ready.");
  assert.equal(app.notifications()[0].options.requireInteraction, true);
  const soundInterval = app.scheduledIntervals().find(
    ({ delay }) => delay === app.completionSoundIntervalMs
  );
  assert.ok(soundInterval);

  assert.equal(app.startCompletionAlert(completed), false);
  assert.equal(app.notifications().length, 1);
  assert.equal(app.toneStarts(), 1);

  app.stopCompletionAlert();
  assert.equal(app.notifications()[0].closed, true);
  assert.ok(app.clearedIntervals().includes(app.scheduledIntervals().indexOf(soundInterval) + 1));
  assert.equal(app.completionAlertTimerIDTest(), null);
  assert.equal(app.completionAlertDismissedTimerIDTest(), completed.id);
  assert.equal(app.startCompletionAlert(completed), false);
});

test("starting next timer stops completion alert", async () => {
  const app = loadTaskProjection();
  const completed = timer("completed", "completed-focus");

  await app.primeCompletionAlerts();
  assert.equal(app.startCompletionAlert(completed), true);
  app.state.baseTimer = timer("running", "next-break");
  app.state.baseHistory = [terminalHistory("completed", completed.id)];
  app.state.pending = [];

  app.rebuildOptimisticState();

  assert.equal(app.state.timer.id, "next-break");
  assert.equal(app.completionAlertTimerIDTest(), null);
  assert.equal(app.notifications()[0].closed, true);
  assert.equal(app.clearedIntervals().length, 1);
});

test("auto-start projection follows canonical state and pending local intent", () => {
  const app = loadTaskProjection();
  app.state.baseAutoStartBreaks = true;
  app.state.pendingAutoStartOperations = [{
    id: "auto-start-local",
    enabled: false,
    hlcWallMs: 2,
    hlcCounter: 0
  }];

  app.rebuildOptimisticState();

  assert.equal(app.state.autoStartBreaks, false);
});

test("local completed focuses choose three short breaks then a long break", () => {
  const app = loadTaskProjection();
  const reference = new Date("2026-07-22T12:00:00Z");
  app.state.history = [{
    id: "yesterday",
    timerId: "yesterday",
    phase: "focus",
    status: "completed",
    completedAt: "2026-07-21T12:00:00Z"
  }];

  for (let count = 1; count <= 4; count += 1) {
    app.state.history.push({
      id: `focus-${count}`,
      timerId: `focus-${count}`,
      phase: "focus",
      status: "completed",
      completedAt: `2026-07-22T0${count}:00:00Z`
    });
    assert.equal(app.completedFocusCountForDay(app.state.history, reference), count);
    assert.equal(
      app.nextBreakPhase(app.state.history, reference),
      count === 4 ? "long_break" : "short_break"
    );
  }
  assert.equal(app.longBreakProgress(4), 4);
  assert.equal(app.longBreakProgress(5), 1);
});

test("completed timers display the selected next phase at its full duration", () => {
  const app = loadTaskProjection();
  app.state.timer = timer("completed", "completed-focus");
  app.state.selectedPhase = "short_break";
  app.state.durationsMs.short_break = 5 * 60_000;

  let displayed = app.displayTimer();
  assert.equal(app.nextPhaseAfterCompletion(app.state.timer), "short_break");
  assert.equal(displayed.phase, "short_break");
  assert.equal(displayed.status, "idle");
  assert.equal(displayed.plannedDurationMs, 5 * 60_000);

  app.state.timer = { ...timer("completed", "completed-break"), phase: "short_break" };
  app.state.selectedPhase = "focus";
  app.state.durationsMs.focus = 25 * 60_000;

  displayed = app.displayTimer();
  assert.equal(app.nextPhaseAfterCompletion(app.state.timer), "focus");
  assert.equal(displayed.phase, "focus");
  assert.equal(displayed.status, "idle");
  assert.equal(displayed.plannedDurationMs, 25 * 60_000);
});

test("rejected Finish rolls back only its own automatic phase selection", () => {
  const app = loadTaskProjection();
  const focusFinish = {
    id: "finish-focus",
    timerId: "focus-1",
    type: "finish",
    phase: "focus",
    occurredAt: "2026-07-22T04:00:00Z"
  };
  assert.equal(app.selectedPhaseAfterRejectedFinish("short_break", focusFinish, []), "focus");
  assert.equal(app.selectedPhaseAfterRejectedFinish("long_break", focusFinish, []), "long_break");
  const fourthFocusHistory = Array.from({ length: 4 }, (_, index) => ({
    timerId: index === 3 ? "focus-1" : `earlier-${index}`,
    phase: "focus",
    status: "completed",
    completedAt: `2026-07-22T0${index + 1}:00:00Z`
  }));
  assert.equal(
    app.selectedPhaseAfterRejectedFinish("long_break", focusFinish, fourthFocusHistory),
    "focus"
  );

  const breakFinish = { id: "finish-break", timerId: "break-1", type: "finish", phase: "short_break" };
  assert.equal(app.selectedPhaseAfterRejectedFinish("focus", breakFinish, []), "short_break");
  assert.equal(
    app.selectedPhaseAfterCommandAcknowledgements("short_break", [focusFinish], [
      { commandId: focusFinish.id, outcome: "rejected" }
    ], []),
    "focus"
  );
  assert.equal(
    app.selectedPhaseAfterCommandAcknowledgements("short_break", [focusFinish], [
      { commandId: focusFinish.id, outcome: "accepted" }
    ], []),
    "short_break"
  );
});

test("automatic not-owner completion retries at lease expiry without render-loop polling", () => {
  const app = loadTaskProjection();
  assert.equal(app.completionRetryDelay({
    reason: "not_owner",
    retryAtMs: 2_000
  }, 1_500), 501);
  assert.equal(app.completionRetryDelay({ reason: "not_owner" }, 1_500), 15_001);
  assert.equal(app.completionRetryDelay({ reason: "stale" }, 1_500), null);

  app.state.ready = true;
  app.state.bootstrapBlocked = false;
  app.state.timer = { id: "focus-restart", phase: "focus", status: "running", plannedDurationMs: 1 };
  app.setCompletionQueuedForTest("focus-restart");
  app.scheduleCompletionRetry("focus-restart", { reason: "not_owner", retryAtMs: Date.now() + 1_000 });
  assert.ok(app.scheduledTimeoutDelay() >= 900);
  assert.equal(app.completionQueuedForTest(), "focus-restart");
  assert.equal(app.releaseCompletionRetry("focus-restart"), true);
  assert.equal(app.completionQueuedForTest(), null);
});

test("optimistic timer reducer covers complete state command target matrix", () => {
  const app = loadTaskProjection();
  const states = ["absent", "running", "paused", "completed", "cancelled", "superseded"];
  const commands = ["start", "pause", "resume", "finish", "cancel", "clear"];
  const targets = ["same", "foreign"];
  let cases = 0;

  for (const status of states) {
    for (const type of commands) {
      for (const target of targets) {
        const initial = matrixState(app, status);
        const result = app.reduceCommand(initial.timer, initial.history, matrixCommand(type, target));
        const expected = expectedMatrixTimer(status, type, target);
        assert.equal(result.timer.id, expected.id, `${status}/${type}/${target} timer ID`);
        assert.equal(result.timer.status, expected.status, `${status}/${type}/${target} status`);
        cases += 1;
      }
    }
  }
  assert.equal(cases, 72);
});

test("optimistic reducer lets later actions override deadline completion", () => {
  const app = loadTaskProjection();
  const running = timer("running");
  running.plannedDurationMs = 5_000;
  const latePause = matrixCommand("pause", "same");
  latePause.occurredAt = new Date(baseTime + 8_000).toISOString();

  const paused = app.reduceCommand(running, [], latePause);
  assert.equal(paused.timer.status, "paused");
  assert.equal(paused.timer.anchorAt, latePause.occurredAt);
  assert.equal(paused.timer.lastIntent.commandId, latePause.id);
  assert.equal(paused.history.length, 0);

  const finish = matrixCommand("finish", "same");
  finish.id = "claim-finish";
  finish.occurredAt = new Date(baseTime + 9_000).toISOString();
  const claimed = app.reduceCommand(paused.timer, paused.history, finish);
  assert.equal(claimed.timer.anchorAt, finish.occurredAt);
  assert.equal(claimed.timer.lastIntent.commandId, "claim-finish");
  assert.equal(claimed.history[0].commandId, "claim-finish");
  assert.equal(claimed.history[0].completedAt, finish.occurredAt);
});

test("optimistic reducer preserves both histories when latest action revives another timer", () => {
  const app = loadTaskProjection();
  const source = timer("running");
  source.id = "timer-a";
  const historical = {
    id: "history-z",
    timerId: "timer-z",
    commandId: "old-finish",
    phase: "focus",
    status: "completed",
    plannedDurationMs: 25 * 60_000,
    completedAt: new Date(baseTime).toISOString(),
    endedAt: new Date(baseTime).toISOString()
  };
  const finish = matrixCommand("finish", "same");
  finish.timerId = "timer-z";

  const result = app.reduceCommand(source, [historical], finish);

  assert.deepEqual(
    Array.from(result.history, (item) => `${item.timerId}:${item.status}:${item.id}`),
    ["timer-a:superseded:timer-a", "timer-z:completed:history-z"]
  );
  assert.deepEqual(Array.from(result.history, (item) => item.commandId), [finish.id, finish.id]);
});

test("optimistic history sorting preserves RFC3339 nanosecond precision", () => {
  const app = loadTaskProjection();
  const source = timer("running");
  source.id = "timer-a";
  const target = {
    id: "history-y",
    timerId: "timer-y",
    commandId: "old-finish-y",
    phase: "focus",
    status: "completed",
    plannedDurationMs: 25 * 60_000,
    completedAt: "2026-07-20T12:00:00.000000050Z",
    endedAt: "2026-07-20T12:00:00.000000050Z"
  };
  const later = {
    ...target,
    id: "history-z",
    timerId: "timer-z",
    commandId: "old-finish-z",
    completedAt: "2026-07-20T12:00:00.000000900Z",
    endedAt: "2026-07-20T12:00:00.000000900Z"
  };
  const finish = matrixCommand("finish", "same");
  finish.timerId = "timer-y";
  finish.occurredAt = "2026-07-20T12:00:00.000000100Z";

  const result = app.reduceCommand(source, [target, later], finish);

  assert.deepEqual(
    Array.from(result.history, (item) => item.timerId),
    ["timer-z", "timer-y", "timer-a"]
  );
});

test("optimistic reducer restores a timer after an earlier clear in one replay", () => {
  const app = loadTaskProjection();
  const sessions = new Map();
  const start = matrixCommand("start", "same");
  const clear = { ...matrixCommand("clear", "same"), id: "clear", occurredAt: new Date(baseTime + 1).toISOString() };
  const pause = {
    ...matrixCommand("pause", "same"),
    id: "pause-latest",
    occurredAt: new Date(baseTime + 2).toISOString(),
    observedElapsedMs: 123_000
  };

  let result = app.reduceCommand(null, [], start, sessions);
  result = app.reduceCommand(result.timer, result.history, clear, sessions);
  result = app.reduceCommand(result.timer, result.history, pause, sessions);

  assert.equal(result.timer.status, "paused");
  assert.equal(result.timer.elapsedAtAnchorMs, 123_000);
  assert.equal(result.timer.lastIntent.commandId, pause.id);
  assert.equal(result.history.length, 0);
});

test("optimistic reducer preserves source metadata through supersede cancel and resume", () => {
  const app = loadTaskProjection();
  const source = timer("running");
  const replacement = matrixCommand("start", "foreign");
  const superseded = app.reduceCommand(source, [], replacement);
  assert.equal(superseded.timer.id, "timer-foreign");
  assert.equal(superseded.history[0].timerId, "timer-state");
  assert.equal(superseded.history[0].status, "superseded");
  assert.equal(superseded.history[0].phase, "focus");
  assert.equal(superseded.history[0].plannedDurationMs, 60_000);
  assert.equal(superseded.history[0].taskId, "task-source");

  const resume = matrixCommand("resume", "same");
  resume.id = "resume-source";
  const resumed = app.reduceCommand(superseded.timer, superseded.history, resume);
  assert.equal(resumed.timer.id, "timer-state");
  assert.equal(resumed.timer.status, "running");
  assert.equal(resumed.history.some((item) => item.timerId === "timer-state"), false);
  assert.equal(resumed.history.find((item) => item.timerId === "timer-foreign").status, "superseded");

  const cancel = matrixCommand("cancel", "same");
  const cancelled = app.reduceCommand(source, [], cancel);
  assert.equal(cancelled.history[0].status, "cancelled");
  assert.equal(cancelled.history[0].phase, "focus");
  assert.equal(cancelled.history[0].plannedDurationMs, 60_000);
  assert.equal(cancelled.history[0].taskId, "task-source");
});

test("cancel and clear rewind timer while retaining cancelled history", () => {
  const app = loadTaskProjection();
  const source = timer("running");
  const cancel = matrixCommand("cancel", "same");
  const cancelled = app.reduceCommand(source, [], cancel);
  const clear = { ...matrixCommand("clear", "same"), hlcCounter: 1 };
  const reset = app.reduceCommand(cancelled.timer, cancelled.history, clear);

  assert.equal(reset.timer.id, null);
  assert.equal(reset.timer.status, "idle");
  assert.equal(reset.history.length, 1);
  assert.equal(reset.history[0].status, "cancelled");
});

test("optimistic replay follows HLC and command ID despite crossed device sequences", () => {
  const app = loadTaskProjection();
  app.state.baseTimer = app.emptyTimer("focus", 60_000);
  app.state.baseHistory = [];
  app.state.pending = [
    { ...matrixCommand("start", "foreign"), id: "command-b", timerId: "timer-b", deviceSequence: 1, hlcWallMs: 200, hlcCounter: 0 },
    { ...matrixCommand("start", "foreign"), id: "command-a", timerId: "timer-a", deviceSequence: 99, hlcWallMs: 100, hlcCounter: 0 }
  ];

  app.rebuildOptimisticState();

  assert.equal(app.state.timer.id, "timer-b");
  assert.equal(app.state.history[0].timerId, "timer-a");
  assert.equal(app.state.history[0].status, "superseded");
});

test("elapsed timer uses persisted server offset and monotonic elapsed across wall jumps", () => {
  const app = loadTaskProjection();
  app.state.clockOffset = {
    offsetMs: 3_600_000,
    uncertaintyMs: 50,
    sampledAtWallMs: baseTime - 3_600_000,
    requestSequence: 1,
    receivedAtWallMs: baseTime - 3_600_000 + 50
  };
  const running = timer("running");
  running.anchorAt = new Date(baseTime).toISOString();

  assert.equal(app.elapsedFor(running, app.trustedNow(baseTime - 3_600_000 + 5_000, 100), 100), 5_000);
  assert.equal(app.elapsedFor(running, app.trustedNow(baseTime - 3_600_000 - 55_000, 1_100), 1_100), 6_000);
});

test("cacheable bootstrap response retains preview clock sample", () => {
  const app = loadTaskProjection();
  const previewSample = {
    offsetMs: 3_600_000,
    uncertaintyMs: 50,
    sampledAtWallMs: baseTime - 3_600_000,
    requestSequence: 1,
    receivedAtWallMs: baseTime - 3_600_000 + 50
  };
  app.state.clockOffset = previewSample;
  const staleReplay = { serverTime: new Date(baseTime - 86_400_000).toISOString() };
  const retryTiming = {
    requestAtMs: baseTime - 3_600_000,
    receivedAtMs: baseTime - 3_600_000 + 100,
    requestSequence: 2
  };

  assert.equal(app.responseClockOffset(staleReplay, retryTiming, true), previewSample);
  assert.notDeepEqual(app.responseClockOffset(staleReplay, retryTiming, false), previewSample);
});

test("optimistic reducer matches canonical convergence corpus in every arrival order", () => {
  const fixturePath = path.join(__dirname, "..", "internal", "timer", "testdata", "convergence-v1.json");
  const data = fs.readFileSync(fixturePath);
  assert.equal(
    crypto.createHash("sha256").update(data).digest("hex"),
    "51c357d8fd63e7200c1316ef36fc45821bea9ac2fbe11f255832fa21110ea104"
  );
  const fixture = JSON.parse(data);
  assert.equal(fixture.version, 2);
  const epochMs = Date.parse(fixture.epoch);

  for (const scenario of fixture.cases) {
    const commands = scenario.commands.map((command) => ({
      id: command.id,
      deviceId: command.deviceId,
      deviceSequence: command.sequence,
      timerId: command.timerId,
      taskId: command.taskId || null,
      type: command.type,
      phase: command.phase,
      plannedDurationMs: command.durationMs,
      occurredAt: new Date(epochMs + command.atMs).toISOString(),
      hlcWallMs: command.wallMs,
      hlcCounter: command.counter,
      observedElapsedMs: command.elapsedMs
    }));

    for (const arrivalOrder of permutations(commands)) {
      const app = loadTaskProjection();
      app.state.baseTimer = app.emptyTimer("focus", 1_500_000);
      app.state.baseHistory = [];
      app.state.pending = arrivalOrder;
      app.rebuildOptimisticState();
      assert.deepEqual(
        JSON.parse(JSON.stringify(normalizeFixtureProjection(app.state.timer, app.state.history, epochMs))),
        scenario.expected,
        scenario.name
      );
    }
  }

  for (const scenario of fixture.projectionCases) {
    for (const arrivalOrder of permutations(scenario.taskOperations)) {
      assert.deepEqual(sync.applyTaskOperations([], arrivalOrder), scenario.expected.tasks, scenario.name);
    }
    const defaults = { focus: 1_500_000, short_break: 300_000, long_break: 900_000 };
    for (const arrivalOrder of permutations(scenario.durationOperations)) {
      assert.deepEqual(sync.applyDurationOperations(defaults, arrivalOrder), scenario.expected.durationsMs, scenario.name);
    }
    for (const arrivalOrder of permutations(scenario.autoStartOperations)) {
      assert.equal(sync.applyAutoStartOperations(false, arrivalOrder), scenario.expected.autoStartBreaks, scenario.name);
    }
  }

  for (const scenario of fixture.responseCases) {
    const commands = scenario.local.commands.map((command) => ({
      id: command.id,
      deviceId: command.deviceId,
      deviceSequence: command.sequence,
      timerId: command.timerId,
      taskId: command.taskId || null,
      type: command.type,
      phase: command.phase,
      plannedDurationMs: command.durationMs,
      occurredAt: new Date(epochMs + command.atMs).toISOString(),
      hlcWallMs: command.wallMs,
      hlcCounter: command.counter,
      observedElapsedMs: command.elapsedMs
    }));
    const operation = (item) => ({
      ...item,
      occurredAt: new Date(epochMs + item.atMs).toISOString(),
      hlcWallMs: item.wallMs,
      hlcCounter: item.counter
    });
    const taskOperations = scenario.local.taskOperations.map(operation);
    const durationOperations = scenario.local.durationOperations.map(operation);
    const autoStartOperations = scenario.local.autoStartOperations.map(operation);
    const local = {
      commands,
      taskOperations,
      durationOperations,
      autoStartOperations,
      selectedTaskOperations: [],
      baseTimer: null,
      baseHistory: [],
      baseTasks: [],
      baseDurationsMs: { focus: 1_500_000, short_break: 300_000, long_break: 900_000 },
      baseAutoStartBreaks: false,
      baseSelectedTaskId: null,
      revision: 0
    };
    const sent = {
      commands: commands.filter((item) => scenario.sentIds.commands.includes(item.id)),
      taskOperations: taskOperations.filter((item) => scenario.sentIds.taskOperations.includes(item.id)),
      durationOperations: durationOperations.filter((item) => scenario.sentIds.durationOperations.includes(item.id)),
      autoStartOperations: autoStartOperations.filter((item) => scenario.sentIds.autoStartOperations.includes(item.id)),
      selectedTaskOperations: []
    };
    const canonicalTimer = {
      id: scenario.canonical.timer.id,
      taskId: scenario.canonical.timer.taskId || null,
      phase: scenario.canonical.timer.phase,
      status: scenario.canonical.timer.status,
      plannedDurationMs: scenario.canonical.timer.durationMs,
      elapsedAtAnchorMs: scenario.canonical.timer.elapsedMs,
      anchorAt: new Date(epochMs + scenario.canonical.timer.anchorMs).toISOString(),
      lastIntent: {
        type: "start",
        commandId: scenario.canonical.timer.lastCommandId,
        occurredAt: new Date(epochMs + scenario.canonical.timer.anchorMs).toISOString(),
        deviceId: "device-a"
      }
    };
    const acknowledgements = (items, idKey) => items.map((item) => ({
      [idKey]: item.id,
      outcome: item.outcome,
      reason: item.reason
    }));
    const payload = {
      revision: 1,
      canonicalTimer,
      history: scenario.canonical.history,
      tasks: scenario.canonical.tasks,
      durationsMs: scenario.canonical.durationsMs,
      autoStartBreaks: scenario.canonical.autoStartBreaks,
      selectedTaskId: null,
      acknowledgements: acknowledgements(scenario.acknowledgements.commands, "commandId"),
      taskAcknowledgements: acknowledgements(scenario.acknowledgements.taskOperations, "operationId"),
      durationAcknowledgements: acknowledgements(scenario.acknowledgements.durationOperations, "operationId"),
      autoStartAcknowledgements: acknowledgements(scenario.acknowledgements.autoStartOperations, "operationId"),
      selectedTaskAcknowledgements: []
    };
    const rebased = sync.rebaseSyncState(local, payload, sent);
    assert.deepEqual(rebased.pending.map((item) => item.id), scenario.expected.commandIds, scenario.name);
    assert.deepEqual(
      rebased.pendingTaskOperations.map((item) => item.id),
      scenario.expected.taskOperationIds,
      scenario.name
    );
    assert.deepEqual(
      rebased.pendingDurationOperations.map((item) => item.id),
      scenario.expected.durationOperationIds,
      scenario.name
    );
    assert.deepEqual(
      rebased.pendingAutoStartOperations.map((item) => item.id),
      scenario.expected.autoStartOperationIds,
      scenario.name
    );

    const app = loadTaskProjection();
    app.state.baseTimer = rebased.baseTimer;
    app.state.baseHistory = rebased.baseHistory;
    app.state.baseTasks = rebased.baseTasks;
    app.state.baseDurationsMs = rebased.baseDurationsMs;
    app.state.baseAutoStartBreaks = rebased.baseAutoStartBreaks;
    app.state.baseSelectedTaskId = rebased.baseSelectedTaskId;
    app.state.pending = rebased.pending;
    app.state.pendingTaskOperations = rebased.pendingTaskOperations;
    app.state.pendingDurationOperations = rebased.pendingDurationOperations;
    app.state.pendingAutoStartOperations = rebased.pendingAutoStartOperations;
    app.state.pendingSelectedTaskOperations = rebased.pendingSelectedTaskOperations;
    app.rebuildOptimisticState();
    assert.deepEqual(
      JSON.parse(JSON.stringify(normalizeFixtureProjection(app.state.timer, app.state.history, epochMs))),
      { timer: scenario.expected.timer, history: scenario.expected.history },
      scenario.name
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(app.state.tasks)),
      scenario.expected.tasks,
      scenario.name
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(app.state.durationsMs)),
      scenario.expected.durationsMs,
      scenario.name
    );
    assert.equal(app.state.autoStartBreaks, scenario.expected.autoStartBreaks, scenario.name);
  }
});

test("IndexedDB request and transaction adapters preserve success and failure causes", async () => {
  const app = loadTaskProjection();

  const successfulRequest = {};
  const successfulResult = app.requestResult(successfulRequest);
  successfulRequest.result = { key: "snapshot" };
  successfulRequest.onsuccess();
  assert.deepEqual(await successfulResult, { key: "snapshot" });

  const requestFailure = new Error("request failed");
  const failedRequest = { error: requestFailure };
  const rejectedResult = app.requestResult(failedRequest);
  failedRequest.onerror();
  await assert.rejects(rejectedResult, (error) => error === requestFailure);

  const completedTransaction = {};
  const completion = app.transactionDone(completedTransaction);
  completedTransaction.oncomplete();
  await completion;

  const abortCause = new Error("transaction rolled back");
  const abortedTransaction = { error: abortCause };
  const aborted = app.transactionDone(abortedTransaction);
  abortedTransaction.onabort();
  await assert.rejects(aborted, (error) => error === abortCause);

  const failedTransaction = { error: requestFailure };
  const failed = app.transactionDone(failedTransaction);
  failedTransaction.onerror();
  await assert.rejects(failed, (error) => error === requestFailure);
});

test("new local identity persists once and survives later in-memory identity changes", async () => {
  await indexedDBRequest(indexedDB.deleteDatabase("pomodorough"));
  const app = loadTaskProjection();
  const database = await app.openDatabase();
  app.setDatabaseForTest(database);
  app.state.deviceId = "device-first-launch";
  app.state.deviceSequence = 17;
  app.state.hlcWallMs = baseTime;
  app.state.hlcCounter = 3;
  app.state.selectedPhase = "long_break";

  await app.persistNewLocalIdentity({});
  const persisted = await app.readLocalRecords();
  assert.equal(persisted.deviceId.value, "device-first-launch");
  assert.equal(persisted.deviceSequence.value, 17);
  assert.deepEqual(JSON.parse(JSON.stringify(persisted.hlc.value)), { wallMs: baseTime, counter: 3 });
  assert.equal(persisted.settings.value.selectedPhase, "long_break");

  app.state.deviceId = "device-must-not-replace";
  app.state.deviceSequence = 99;
  await app.persistNewLocalIdentity(persisted);
  const unchanged = await app.readLocalRecords();
  assert.equal(unchanged.deviceId.value, "device-first-launch");
  assert.equal(unchanged.deviceSequence.value, 17);

  database.close();
  await indexedDBRequest(indexedDB.deleteDatabase("pomodorough"));
});

test("browser database schema and local-record read restore restart-safe defaults", async () => {
  await indexedDBRequest(indexedDB.deleteDatabase("pomodorough"));
  const app = loadTaskProjection();
  const database = await app.openDatabase();
  app.setDatabaseForTest(database);

  assert.deepEqual(
    [...database.objectStoreNames],
    ["meta", "pending", "pendingAutoStarts", "pendingDurations", "pendingSelectedTasks", "pendingTasks"]
  );

  const transaction = database.transaction("meta", "readwrite");
  transaction.objectStore("meta").put({ key: "deviceId", value: "device-restarted" });
  transaction.objectStore("meta").put({
    key: "settings",
    value: {
      selectedPhase: "short_break",
      durationSyncBootstrapped: true,
      autoStartSyncBootstrapped: true,
      selectedTaskSyncBootstrapped: true
    }
  });
  await indexedDBTransaction(transaction);

  const records = await app.readLocalRecords();
  assert.equal(records.deviceId.value, "device-restarted");
  assert.deepEqual(records.pending, []);
  assert.deepEqual(records.pendingTaskOperations, []);
  assert.deepEqual(records.pendingDurationOperations, []);
  assert.deepEqual(records.pendingAutoStartOperations, []);
  assert.deepEqual(records.pendingSelectedTaskOperations, []);

  app.restoreLocalRecords(records, { operations: [], resolution: null });
  assert.equal(app.state.deviceId, "device-restarted");
  assert.equal(app.state.selectedPhase, "short_break");
  assert.equal(app.state.durationSyncBootstrapped, true);
  assert.equal(app.state.autoStartSyncBootstrapped, true);
  assert.equal(app.state.selectedTaskSyncBootstrapped, true);

  database.close();
  await indexedDBRequest(indexedDB.deleteDatabase("pomodorough"));
});

test("legacy duration migrations atomically normalize queues and retire local settings", async () => {
  await indexedDBRequest(indexedDB.deleteDatabase("pomodorough"));
  const app = loadTaskProjection();
  const database = await app.openDatabase();
  app.setDatabaseForTest(database);

  let transaction = database.transaction("meta", "readwrite");
  transaction.objectStore("meta").put({
    key: "settings",
    value: {
      selectedPhase: "focus",
      pendingDurationOperations: [
        { id: "legacy-duration", phase: "focus", durationMs: 1_800_000, hlcWallMs: 0, hlcCounter: 0 },
        { id: "modern-duration", phase: "short_break", durationMs: 360_000, hlcWallMs: 10, hlcCounter: 1, occurredAt: "2024-01-01T00:00:00.000Z" }
      ]
    }
  });
  await indexedDBTransaction(transaction);

  await app.migrateDurationQueueFromSettings();
  transaction = database.transaction(["meta", "pendingDurations"], "readonly");
  let settings = await indexedDBRequest(transaction.objectStore("meta").get("settings"));
  let durations = await indexedDBRequest(transaction.objectStore("pendingDurations").getAll());
  await indexedDBTransaction(transaction);
  assert.equal(Object.hasOwn(settings.value, "pendingDurationOperations"), false);
  assert.equal(durations.length, 2);
  assert.equal(durations.find((item) => item.id === "legacy-duration").occurredAt, new Date(0).toISOString());
  assert.equal(durations.find((item) => item.id === "modern-duration").occurredAt, "2024-01-01T00:00:00.000Z");

  transaction = database.transaction(["meta", "pendingDurations"], "readwrite");
  transaction.objectStore("pendingDurations").clear();
  transaction.objectStore("meta").put({
    key: "settings",
    value: { selectedPhase: "focus", durations: { focus: 30, short_break: 5, long_break: 15 } }
  });
  await indexedDBTransaction(transaction);

  await app.bootstrapLegacyDurations();
  transaction = database.transaction(["meta", "pendingDurations"], "readonly");
  settings = await indexedDBRequest(transaction.objectStore("meta").get("settings"));
  durations = await indexedDBRequest(transaction.objectStore("pendingDurations").getAll());
  await indexedDBTransaction(transaction);
  assert.equal(settings.value.durationSyncBootstrapped, true);
  assert.equal(Object.hasOwn(settings.value, "durations"), false);
  assert.deepEqual(JSON.parse(JSON.stringify(durations)), [{
    id: "test-tab-id",
    ownerId: "bootstrap",
    phase: "focus",
    durationMs: 1_800_000,
    occurredAt: new Date(0).toISOString(),
    hlcWallMs: 0,
    hlcCounter: 0
  }]);

  database.close();
  await indexedDBRequest(indexedDB.deleteDatabase("pomodorough"));
});

test("settings and snapshot persistence values isolate mutable canonical state", () => {
  const app = loadTaskProjection();
  app.state.selectedPhase = "longBreak";
  app.state.durationSyncBootstrapped = true;
  app.state.autoStartSyncBootstrapped = false;
  app.state.selectedTaskSyncBootstrapped = true;
  app.state.revision = 42;
  app.state.baseTimer = { id: "timer-1", nested: { status: "running" } };
  app.state.baseHistory = [{ id: "history-1" }];
  app.state.baseTasks = [{ id: "task-1", title: "Release" }];
  app.state.baseDurationsMs = { focus: 1_500_000 };
  app.state.baseAutoStartBreaks = true;
  app.state.baseSelectedTaskId = "task-1";
  app.state.user = incarnationFixture.accountUser("user-1");

  assert.deepEqual(JSON.parse(JSON.stringify(app.settingsValue({ selectedPhase: "focus" }))), {
    selectedPhase: "focus",
    durationSyncBootstrapped: true,
    autoStartSyncBootstrapped: false,
    selectedTaskSyncBootstrapped: true
  });

  const snapshot = app.snapshotValue({ revision: 43 });
  assert.equal(snapshot.revision, 43);
  assert.equal(snapshot.canonicalTimer.id, "timer-1");
  assert.equal(snapshot.selectedTaskId, "task-1");
  snapshot.canonicalTimer.nested.status = "paused";
  snapshot.tasks[0].title = "Mutated";
  snapshot.user.id = "other-user";
  assert.equal(app.state.baseTimer.nested.status, "running");
  assert.equal(app.state.baseTasks[0].title, "Release");
  assert.equal(app.state.user.id, "user-1");
});

test("account deletion does not broadcast local sign-out before server confirmation", () => {
  const source = fs.readFileSync(path.join(__dirname, "app-session.js"), "utf8");
  const start = source.indexOf("    async deleteAccount()");
  const end = source.indexOf("    async requestAccountDeletion", start);
  assert.ok(start >= 0 && end > start, "session lifecycle must own account deletion");
  const body = source.slice(start, end);
  assert.ok(body.indexOf("await this.requestAccountDeletion(confirmation)")
    < body.indexOf("this.markPendingLogout()"));
});

test("account deletion requires the exact destructive phrase", () => {
  const app = loadTaskProjection();
  assert.equal(app.accountDeletionConfirmationIsValid("DELETE"), true);
  for (const value of ["", "delete", "DELETE ", " DELETE", null, undefined]) {
    assert.equal(app.accountDeletionConfirmationIsValid(value), false, String(value));
  }
});

test("account deletion keeps local state when confirmation, connectivity, or server deletion fails", async () => {
  const app = loadTaskProjection();
  app.state.user = incarnationFixture.accountUser("account-1");
  app.setStorageMethodForTest("guardedMutation", async () => {});
  let requests = 0;
  app.setFetchForTest(async () => {
    requests += 1;
    return { ok: false, status: 503 };
  });

  app.setPromptResult("delete");
  await app.deleteAccount();
  assert.match(app.notice().textContent, /Type DELETE exactly/);
  assert.equal(requests, 0);

  app.setPromptResult("DELETE");
  await app.deleteAccount();
  assert.match(app.notice().textContent, /Connect to the account server/);
  assert.equal(requests, 0);

  app.state.csrfToken = "csrf-current";
  await app.deleteAccount();
  assert.equal(requests, 1);
  assert.match(app.notice().textContent, /Account deletion failed \(503\)/);
  assert.equal(app.deleteAccountButtonDisabled(), false);
  assert.equal(app.pendingLocalLogout(), false);
  assert.equal(app.locationHref(), "");
});

test("confirmed account deletion clears local state only after server success", async () => {
  await indexedDBRequest(indexedDB.deleteDatabase("pomodorough"));
  const app = loadTaskProjection();
  app.state.user = incarnationFixture.accountUser("account-1");
  app.setStorageMethodForTest("guardedMutation", async () => {});
  const requests = [];
  app.state.csrfToken = "csrf-current";
  app.setPromptResult("DELETE");
  app.setFetchForTest(async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 204 };
  });

  await app.deleteAccount();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/v1/account");
  assert.equal(requests[0].options.method, "DELETE");
  assert.equal(requests[0].options.headers["X-CSRF-Token"], "csrf-current");
  assert.deepEqual(JSON.parse(requests[0].options.body), { confirmation: "DELETE" });
  assert.equal(app.pendingLocalLogout(), false);
  assert.equal(app.locationHref(), "/auth/google/start?return=%2Fapp");
});

test("offline logout clears local data but keeps a durable revocation marker", async () => {
  await indexedDBRequest(indexedDB.deleteDatabase("pomodorough"));
  const app = loadTaskProjection();
  app.state.user = incarnationFixture.accountUser("account-1");
  app.state.localOwnerId = incarnationFixture.ownerId("account-1");
  app.state.csrfToken = "csrf-current";
  app.setDatabaseForTest(await app.openDatabase());
  app.setFetchForTest(async () => ({ ok: false, status: 503 }));

  await app.logout();

  assert.equal(app.logoutButtonDisabled(), true);
  assert.equal(app.pendingLocalLogout(), true);
  assert.equal(app.locationHref(), "/auth/google/start?return=%2Fapp");
  assert.equal(app.warnings().some(([message]) => message === "Pomodorough server revocation deferred until reconnect:"), true);
});

test("offline logout marker is durable and explicitly cleared after revocation", () => {
  const app = loadTaskProjection();
  assert.equal(app.pendingLocalLogout(), false);
  app.markPendingLogout();
  assert.equal(app.pendingLocalLogout(), true);
  app.clearPendingLogout();
  assert.equal(app.pendingLocalLogout(), false);
});

test("session revocation defers without CSRF and accepts a successful server revoke", async () => {
  const app = loadTaskProjection();
  app.state.user = incarnationFixture.accountUser("account-1");
  assert.equal(await app.requestSessionRevocation(null), false);
  assert.equal(await app.requestSessionRevocation("csrf"), true);
});

test("local account teardown keeps the database open when its clear transaction aborts", async () => {
  const app = loadTaskProjection();
  let clearCount = 0;
  let closeCount = 0;
  const failure = new Error("clear transaction aborted");
  const transaction = {
    error: failure,
    objectStore() {
      return { clear() { clearCount += 1; } };
    },
    set oncomplete(_handler) {},
    set onerror(_handler) {},
    set onabort(handler) { Promise.resolve().then(handler); }
  };
  app.setDatabaseForTest({
    transaction() { return transaction; },
    close() { closeCount += 1; }
  });

  await assert.rejects(app.clearLocalData(), failure);
  assert.equal(clearCount, 6);
  assert.equal(closeCount, 0);
});

test("local account teardown clears every synchronized store and permits a clean reopen", async () => {
  const app = loadTaskProjection();
  const database = await app.openDatabase();
  app.setDatabaseForTest(database);

  await app.clearLocalData();

  const reopened = await app.openDatabase();
  app.setDatabaseForTest(reopened);
  const records = await app.readLocalRecords();
  assert.equal(records.snapshot, undefined);
  assert.deepEqual(records.pending, []);
  assert.deepEqual(records.pendingTaskOperations, []);
  assert.deepEqual(records.pendingDurationOperations, []);
  assert.deepEqual(records.pendingAutoStartOperations, []);
  assert.deepEqual(records.pendingSelectedTaskOperations, []);
  await app.clearLocalData();
});

test("unauthorized session check retires a pending local logout marker", async () => {
  const app = loadTaskProjection();
  app.markPendingLogout();
  app.setFetchForTest(async () => ({ status: 401, ok: false }));
  assert.equal(await app.fetchSessionPayload(), null);
  assert.equal(app.pendingLocalLogout(), false);
});

test("deferred offline logout never reactivates the old session while revocation retries", async () => {
  const app = loadTaskProjection();
  app.markPendingLogout();
  app.setFetchForTest(async (url) => {
    if (url === "/api/v1/me") {
      return {
        status: 200,
        ok: true,
        async json() { return { user: incarnationFixture.accountUser("old-account"), csrfToken: "csrf" }; }
      };
    }
    return { status: 503, ok: false };
  });

  await assert.rejects(app.loadSession(), /Sign out failed/);
  assert.equal(app.state.authenticated, false);
  assert.equal(app.state.user, null);
  assert.equal(app.state.csrfToken, null);
  assert.equal(app.pendingLocalLogout(), true);
});

test("session refresh uses an uncached same-origin request and rotates CSRF only for the same account", async () => {
  const app = loadTaskProjection();
  const requests = [];
  app.state.user = incarnationFixture.accountUser("account-1");
  app.state.localOwnerId = incarnationFixture.ownerId("account-1");
  app.state.csrfToken = "stale-token";
  app.setFetchForTest(async (url, options) => {
    requests.push({ url, options });
    return {
      status: 200,
      ok: true,
      async json() { return { user: incarnationFixture.accountUser("account-1"), csrfToken: "fresh-token" }; }
    };
  });

  assert.equal(await app.refreshMutationCsrf(incarnationFixture.ownerId("account-1")), "fresh-token");
  assert.equal(app.state.csrfToken, "fresh-token");
  assert.equal(app.state.sessionIdentityValidated, true);
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{
    url: "/api/v1/me",
    options: { credentials: "same-origin", cache: "no-store" }
  }]);
});

test("sync preflight reloads durable queues and skips an empty non-forced request", async () => {
  const app = loadTaskProjection();
  assert.equal(await app.syncPreflight(false), false);
  app.state.ready = true;
  app.state.authenticated = true;
  app.state.sessionIdentityValidated = true;
  app.state.csrfToken = "csrf";
  app.state.user = incarnationFixture.accountUser("account-1");
  app.state.localOwnerId = incarnationFixture.ownerId("account-1");
  app.state.bootstrapBlocked = false;
  app.state.bootstrapGatePersisted = false;
  app.setQueuesForTest({
    commands: [],
    taskOperations: [{ id: "durable-task" }],
    durationOperations: [],
    autoStartOperations: [],
    selectedTaskOperations: []
  });

  assert.equal(await app.syncPreflight(false), true);
  assert.deepEqual(JSON.parse(JSON.stringify(app.state.pendingTaskOperations)), [{ id: "durable-task" }]);
  app.setQueuesForTest({
    commands: [], taskOperations: [], durationOperations: [],
    autoStartOperations: [], selectedTaskOperations: []
  });
  assert.equal(await app.syncPreflight(false), false);
  assert.equal(await app.syncPreflight(true), true);
});

test("sync preflight schedules exponential retry when the durable bootstrap gate cannot be read", async () => {
  const app = loadTaskProjection();
  app.state.ready = true;
  app.state.authenticated = true;
  app.state.sessionIdentityValidated = true;
  app.state.csrfToken = "csrf";
  app.state.user = incarnationFixture.accountUser("account-1");
  app.state.localOwnerId = incarnationFixture.ownerId("account-1");
  app.state.bootstrapBlocked = false;
  app.state.bootstrapGatePersisted = false;
  app.setStorageMethodForTest("readBootstrapState", async () => {
    throw new Error("IndexedDB unavailable");
  });

  assert.equal(await app.syncPreflight(false), false);
  assert.equal(app.state.retrying, true);
  assert.equal(app.scheduledTimeoutDelay(), 1_000);
  assert.equal(app.retryDelayMsForTest(), 2_000);
  assert.equal(app.warnings()[0][0], "Pomodorough bootstrap gate unavailable:");

  app.setStorageMethodForTest("readBootstrapState", async () => ({ gate: null, resolution: null }));
  app.setStorageMethodForTest("readQueues", async () => {
    throw new Error("queue transaction unavailable");
  });
  assert.equal(await app.syncPreflight(false), false);
  assert.equal(app.scheduledTimeoutDelay(), 2_000);
  assert.equal(app.retryDelayMsForTest(), 4_000);
  assert.equal(app.warnings()[1][0], "Pomodorough pending queues unavailable:");
});

test("retry backoff caps at one minute and does not arm while offline", () => {
  const offline = loadTaskProjection();
  offline.setOnline(false);
  offline.scheduleRetry();
  assert.deepEqual(offline.scheduledTimeoutDelays(), []);
  assert.equal(offline.retryDelayMsForTest(), 1_000);

  const online = loadTaskProjection();
  for (let attempt = 0; attempt < 8; attempt += 1) online.scheduleRetry();
  assert.deepEqual(online.scheduledTimeoutDelays(), [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  assert.equal(online.retryDelayMsForTest(), 60_000);
});

test("account bootstrap restart invalidates foreign ownership before migrating local preferences", async () => {
  const app = loadTaskProjection();
  const calls = [];
  app.state.user = incarnationFixture.accountUser("account-current");
  app.state.bootstrapPending = { userId: incarnationFixture.ownerId("account-old") };
  app.setStorageMethodForTest("invalidateForeignResolution", async (_database, input) => {
    calls.push(["invalidate", input.currentUserId, input.gateToken]);
    return { acquired: true, resolution: null };
  });
  app.setStorageMethodForTest("migrateLegacyAutoStart", async (_database, input) => {
    calls.push(["auto-start", typeof input.operationId]);
    return { migrated: true };
  });
  app.setStorageMethodForTest("migrateLegacySelectedTask", async (_database, input) => {
    calls.push(["selected-task", typeof input.operationId]);
    return { migrated: true };
  });
  app.setStorageMethodForTest("readQueues", async () => ({
    commands: [], taskOperations: [], durationOperations: [],
    autoStartOperations: [{ id: "migrated-auto-start", enabled: true }],
    selectedTaskOperations: [{ id: "migrated-selection", taskId: null }]
  }));

  await app.restartBootstrapForCurrentAccount();

  assert.deepEqual(calls.map((entry) => entry[0]), ["invalidate", "auto-start", "selected-task"]);
  assert.equal(calls[0][1], incarnationFixture.ownerId("account-current"));
  assert.equal(calls[0][2], "test-tab-id");
  assert.equal(app.state.bootstrapPending, null);
  assert.equal(app.state.bootstrapGateOwned, true);
  assert.equal(app.state.bootstrapGatePersisted, true);
  assert.equal(app.state.bootstrapBlocked, true);
  assert.deepEqual(JSON.parse(JSON.stringify(app.state.pendingAutoStartOperations)), [
    { id: "migrated-auto-start", enabled: true }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(app.state.pendingSelectedTaskOperations)), [
    { id: "migrated-selection", taskId: null }
  ]);
});

test("bootstrap preview uses an uncached request and persists its bounded clock sample", async () => {
  const app = loadTaskProjection();
  app.state.user = incarnationFixture.accountUser("account-1");
  const requests = [];
  let savedClockOffset = null;
  const serverTime = new Date().toISOString();
  const serverHlcWallMs = Date.parse(serverTime);
  const payload = {
    accountIncarnation: app.state.user.accountIncarnation,
    revision: 0,
    canonicalTimer: null,
    history: [],
    tasks: [],
    durationsMs: { focus: 1_500_000, short_break: 300_000, long_break: 900_000 },
    autoStartBreaks: false,
    selectedTaskId: null,
    serverTime,
    serverHlcWallMs,
    serverHlcCounter: 0,
    acknowledgements: [],
    taskAcknowledgements: [],
    durationAcknowledgements: [],
    autoStartAcknowledgements: [],
    selectedTaskAcknowledgements: []
  };
  app.setStorageMethodForTest("allocateClockRequestSequence", async () => 11);
  app.setStorageMethodForTest("saveClockOffset", async (_database, sample) => {
    savedClockOffset = sample;
    return sample;
  });
  app.setFetchForTest(async (url, options) => {
    requests.push({ url, options });
    return { status: 200, ok: true, async json() { return payload; } };
  });

  assert.equal(await app.loadBootstrapPreview(), payload);
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{
    url: "/api/v1/bootstrap",
    options: { credentials: "same-origin", cache: "no-store",
      headers: sync.accountHeaders(incarnationFixture.ownerId("account-1")) }
  }]);
  assert.equal(savedClockOffset.requestSequence, 11);
  assert.equal(app.state.clockOffset.requestSequence, 11);
});

test("bootstrap send validation rotates legacy capture only for the active gate owner", async () => {
  const app = loadTaskProjection();
  const original = { userId: incarnationFixture.ownerId("account-1"), payload: { requestId: "original" } };
  const rotated = { userId: incarnationFixture.ownerId("account-1"), payload: { requestId: "rotated" } };
  const validations = [];
  let normalizeCalls = 0;
  app.state.user = incarnationFixture.accountUser("account-1");
  app.state.bootstrapPending = original;
  app.state.bootstrapGateOwned = true;
  app.setStorageMethodForTest("normalizeLegacyDurationOperations", async (_database, options) => {
    normalizeCalls += 1;
    assert.equal(options.gateToken, "test-tab-id");
    assert.equal(typeof options.replacementRequestId, "string");
    return { resolution: rotated };
  });
  app.setStorageMethodForTest("validatePendingForSend", async (_database, input) => {
    validations.push(input);
  });

  assert.equal(await app.validateBootstrapSubmission(original), rotated);
  assert.equal(app.state.bootstrapPending, rotated);
  assert.equal(normalizeCalls, 1);
  assert.equal(validations[0].pending, rotated);
  assert.equal(validations[0].currentUserId, incarnationFixture.ownerId("account-1"));
  assert.equal(validations[0].gateToken, "test-tab-id");

  app.state.bootstrapGateOwned = false;
  assert.equal(await app.validateBootstrapSubmission(original), original);
  assert.equal(normalizeCalls, 1);
  assert.equal(validations[1].pending, original);
});

test("bootstrap resolution persists an exact owner-bound request before it can be submitted", async () => {
  const app = loadTaskProjection();
  let captured = null;
  const pending = { userId: incarnationFixture.ownerId("account-1"), payload: { strategy: "keep_remote" } };
  app.state.user = incarnationFixture.accountUser("account-1");
  app.state.deviceId = "device-1";
  app.state.bootstrapPreview = { revision: 17 };
  app.setStorageMethodForTest("captureResolution", async (_database, input, options) => {
    captured = { input, options };
    return pending;
  });

  assert.equal(await app.persistBootstrapResolution("keep_remote"), pending);
  assert.equal(captured.input.userId, incarnationFixture.ownerId("account-1"));
  assert.equal(captured.input.deviceId, "device-1");
  assert.equal(captured.input.expectedRevision, 17);
  assert.equal(captured.input.strategy, "keep_remote");
  assert.equal(typeof captured.input.requestId, "string");
  assert.deepEqual(JSON.parse(JSON.stringify(captured.options)), {
    ownerId: incarnationFixture.ownerId("account-1"), currentUserId: incarnationFixture.ownerId("account-1"),
    localOwnerId: null, expectedUserId: null,
    replaceExisting: false,
    gateToken: "test-tab-id"
  });
  assert.equal(app.state.bootstrapPending, pending);
  assert.equal(app.state.bootstrapGatePersisted, true);
  assert.equal(app.state.bootstrapGateOwned, true);
});

test("bootstrap resolution fails closed for unknown strategies and a gate owned by another tab", async () => {
  const app = loadTaskProjection();
  let captureCount = 0;
  app.state.user = incarnationFixture.accountUser("account-1");
  app.state.deviceId = "device-1";
  app.state.bootstrapPreview = { revision: 17 };
  app.setStorageMethodForTest("captureResolution", async () => {
    captureCount += 1;
  });

  await assert.rejects(
    app.persistBootstrapResolution("invented_strategy"),
    /History resolution changed in another tab/
  );
  app.setStorageMethodForTest("acquireBootstrapGateWithLegacyAutoStart", async () => ({
    acquired: false,
    resolution: null
  }));
  await assert.rejects(
    app.persistBootstrapResolution("keep_remote"),
    /Another tab owns history resolution/
  );
  assert.equal(captureCount, 0);
  assert.equal(app.state.bootstrapPending, null);
});

test("session lookup rejects server failures without replacing the current credentials", async () => {
  const app = loadTaskProjection();
  app.state.user = incarnationFixture.accountUser("account-1");
  app.state.csrfToken = "current-token";
  app.setFetchForTest(async () => ({ status: 503, ok: false }));

  await assert.rejects(app.fetchSessionPayload(), /Session check failed \(503\)/);
  assert.equal(app.state.user.id, "account-1");
  assert.equal(app.state.csrfToken, "current-token");
});

test("dynamic timer, duration, and missing-time presentation routes through localization", () => {
  const app = loadTaskProjection();
  app.setI18nForTest({
    t(key, values = {}) { return `${key}:${JSON.stringify(values)}`; }
  });
  assert.match(app.timerStatusLabel("cancelled"), /^timer\.status\.cancelled:/);
  assert.match(app.formatTaskDuration(90 * 60 * 1000), /^duration\.hoursMinutesShort:/);
  assert.match(app.formatHistoryDate(null), /^history\.timeNotRecorded:/);
});

test("arrivals retain terminal states and announce task context honestly", () => {
  const app = loadTaskProjection();
  const arrivals = app.arrivalHistoryItems([
    { id: "legacy" },
    { id: "completed", status: "completed" },
    { id: "cancelled", status: "cancelled" },
    { id: "superseded", status: "superseded" },
    { id: "running", status: "running" }
  ]);
  assert.deepEqual(arrivals.map((item) => item.id), ["legacy", "completed", "cancelled", "superseded"]);

  const tasks = [{ id: "task-1", title: "Ship release" }];
  assert.equal(app.historyTaskContext({ taskId: "task-1" }, tasks), "Ship release");
  assert.equal(app.historyTaskContext({ taskId: "deleted" }, tasks), "Deleted task");
  assert.equal(app.historyTaskContext({}, tasks), "Unassigned");
  assert.equal(app.historyStatusLabel({}), "Completed");
  assert.equal(app.historyStatusLabel({ status: "cancelled" }), "Cancelled");
  assert.equal(app.historyStatusLabel({ status: "superseded" }), "Superseded");
});

function indexedDBRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB request blocked"));
  });
}

function indexedDBTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

function permutations(values) {
  if (values.length === 0) return [[]];
  return values.flatMap((value, index) => {
    const rest = values.slice(0, index).concat(values.slice(index + 1));
    return permutations(rest).map((permutation) => [value, ...permutation]);
  });
}

function normalizeFixtureProjection(timer, history, epochMs) {
  const result = {
    history: history.map((item) => {
      const normalized = {
        timerId: item.timerId,
        status: item.status,
        phase: item.phase,
        durationMs: item.plannedDurationMs,
        endedMs: Date.parse(item.endedAt) - epochMs
      };
      if (item.commandId) normalized.commandId = item.commandId;
      if (item.taskId) normalized.taskId = item.taskId;
      return normalized;
    })
  };
  if (timer?.id) {
    result.timer = {
      id: timer.id,
      status: timer.status,
      phase: timer.phase,
      durationMs: timer.plannedDurationMs,
      elapsedMs: timer.elapsedAtAnchorMs,
      anchorMs: Date.parse(timer.anchorAt) - epochMs,
      lastCommandId: timer.lastIntent?.commandId || ""
    };
    if (timer.taskId) result.timer.taskId = timer.taskId;
  }
  return result;
}
