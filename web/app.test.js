"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const sync = require("./sync-core.js");

function loadTaskProjection() {
  const appPath = path.join(__dirname, "app.js");
  const source = fs.readFileSync(appPath, "utf8");
  const instrumented = source.replace(
    "  initialize();",
    `  globalThis.PomodoroughAppTest = {
    state,
    phaseLabel,
    timerStatusLabel,
    formatTaskDuration,
    formatHistoryDate,
    setI18nForTest(value) { i18n = value; },
    emptyTimer,
    displayTimer,
    elapsedFor,
    trustedNow,
    responseClockOffset,
    reduceCommand,
    rebuildOptimisticState,
    rebuildOptimisticTasks,
    rebuildOptimisticAutoStart,
    rebuildOptimisticSelectedTask,
    selectedTaskIdForNextFocus,
    refreshAllPendingOperations,
    renderTaskSelector,
    issueSelectedTaskOperation,
    ownerStateValue,
    resetOwnerState,
    restoreOwnerState,
    setDatabaseForTest(value) { db = value; },
    completionRetryDelay,
    completedFocusCountForDay,
    longBreakProgress,
    nextBreakPhase,
    nextPhaseAfterCompletion,
    selectedPhaseAfterRejectedFinish,
    selectedPhaseAfterCommandAcknowledgements,
    arrivalHistoryItems,
    historyTaskContext,
    historyStatusLabel,
    releaseCompletionRetry,
    scheduleCompletionRetry,
    setCompletionQueuedForTest(value) { completionQueuedFor = value; },
    completionQueuedForTest() { return completionQueuedFor; },
    closeRevisionStreamForIdentityChange,
    pollRemoteState,
    remoteSyncIntervalMs: REMOTE_SYNC_INTERVAL_MS,
    completionAlertTitle,
    primeCompletionAlerts,
    startCompletionAlert,
    stopCompletionAlert,
    completionSoundIntervalMs: COMPLETION_SOUND_INTERVAL_MS,
    completionAlertTimerIDTest() { return completionAlertTimerID; },
    completionAlertDismissedTimerIDTest() { return completionAlertDismissedTimerID; },
    accountDeletionConfirmationIsValid,
    pendingLocalLogout,
    markPendingLogout,
    clearPendingLogout,
    requestSessionRevocation,
    fetchSessionPayload,
    loadSession,
    setFetchForTest(value) { globalThis.fetch = value; },
    setRevisionStreamForTest(value) { eventSource = value; },
    hasRevisionStreamForTest() { return Boolean(eventSource); }
  };`
  );
  assert.notEqual(instrumented, source, "app test seam was not installed");
  let scheduledTimeout = null;
  const scheduledIntervals = [];
  const clearedIntervals = [];
  const notifications = [];
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
  const testElements = {
    "#taskSelector": taskSelector,
    "#syncStatus": { dataset: {} },
    "#syncStatusText": { textContent: "" }
  };
  const context = {
    PomodoroughSync: sync,
    PomodoroughStorage: {
      async normalizeLegacyDurationOperations() {},
      async readQueues() { return queues; },
      async allocateMutation(_database, input) {
        allocatedMutationInput = input;
        return input.build({ id: "selected-operation", wallMs: baseTime, counter: 0 });
      }
    },
    console,
    fetch: async () => ({ ok: true, status: 204 }),
    crypto: { randomUUID: () => "test-tab-id" },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    localStorage: {
      values: new Map(),
      getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
      setItem(key, value) { this.values.set(key, String(value)); },
      removeItem(key) { this.values.delete(key); }
    },
    document: {
      querySelector: (selector) => testElements[selector] || null,
      querySelectorAll: () => [],
      createElement: () => ({ value: "", textContent: "", disabled: false })
    },
    navigator: { onLine: true },
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
        return 1;
      }
    }
  };
  context.globalThis = context;
  vm.runInNewContext(instrumented, context, { filename: appPath });
  return {
    ...context.PomodoroughAppTest,
    scheduledTimeoutDelay() {
      return scheduledTimeout?.delay ?? null;
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
    toneStarts() {
      return toneStarts;
    },
    setOnline(value) {
      context.navigator.onLine = value;
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
    }
  };
}

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
  if (type === "start" && (target === "foreign" || status === "absent")) {
    return { id: target === "foreign" ? "timer-foreign" : "timer-state", status: "running" };
  }
  if (status === "absent") return { id: null, status: "idle" };
  if (status === "superseded") {
    return type === "resume" && target === "same"
      ? { id: "timer-state", status: "running" }
      : { id: "timer-current", status: "running" };
  }
  if (target === "foreign") return { id: "timer-state", status };
  if (type === "pause" && status === "running") return { id: "timer-state", status: "paused" };
  if (type === "resume" && status === "paused") return { id: "timer-state", status: "running" };
  if (type === "finish" && ["running", "paused"].includes(status)) return { id: "timer-state", status: "completed" };
  if (type === "cancel" && ["running", "paused"].includes(status)) return { id: "timer-state", status: "cancelled" };
  if (type === "clear" && ["completed", "cancelled"].includes(status)) return { id: null, status: "idle" };
  return { id: "timer-state", status };
}

test("task deletion hides independent selection and task reappearance restores it", () => {
  const app = loadTaskProjection();
  const { state, rebuildOptimisticTasks, rebuildOptimisticSelectedTask, selectedTaskIdForNextFocus } = app;
  state.baseTasks = [{ id: "selected-task", title: "Selected" }];
  state.pendingTaskOperations = [];
  state.baseSelectedTaskId = "selected-task";
  state.pendingSelectedTaskOperations = [];
  rebuildOptimisticSelectedTask();

  state.baseTasks = [];
  rebuildOptimisticTasks();
  assert.equal(state.tasks.length, 0);
  assert.equal(state.selectedTaskId, "selected-task");
  assert.equal(selectedTaskIdForNextFocus(), null);
  app.renderTaskSelector();
  assert.deepEqual(app.taskSelectorOptions(), [
    { value: "", textContent: "No task", disabled: false },
    { value: "selected-task", textContent: "Selected task unavailable", disabled: true }
  ]);

  state.pendingTaskOperations = [{
    id: "task-operation-upsert",
    taskId: "selected-task",
    type: "upsert",
    title: "Selected",
    hlcWallMs: 1,
    hlcCounter: 0
  }];
  rebuildOptimisticTasks();
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
  rebuildOptimisticTasks();
  assert.equal(state.tasks.length, 0);
  assert.equal(state.selectedTaskId, "selected-task");
});

test("paused focus keeps active assignment while next-task selector remains editable", () => {
  const app = loadTaskProjection();
  app.state.ready = true;
  app.state.bootstrapBlocked = false;
  app.state.selectedPhase = "focus";
  app.state.tasks = [{ id: "next-task", title: "Next task" }];
  app.state.selectedTaskId = "next-task";
  app.state.timer = {
    id: "active-timer",
    status: "paused",
    phase: "focus",
    taskId: "active-task",
    plannedDurationMs: 1_500_000,
    elapsedAtAnchorMs: 60_000
  };

  app.renderTaskSelector();

  assert.equal(app.taskSelectorDisabled(), false);
  assert.equal(app.state.timer.taskId, "active-task");
});

test("No task selection persists nullable operation and schedules sync without changing timer", async () => {
  const app = loadTaskProjection();
  app.setDatabaseForTest({});
  app.state.ready = true;
  app.state.bootstrapBlocked = false;
  app.state.baseSelectedTaskId = "task-current";
  app.state.selectedTaskId = "task-current";
  app.state.pendingSelectedTaskOperations = [];
  app.state.timer = timer("running", "canonical-active");
  const activeTimer = structuredClone(app.state.timer);

  assert.equal(await app.issueSelectedTaskOperation(null), true);

  assert.equal(app.allocatedMutationInput().storeName, "pendingSelectedTasks");
  assert.deepEqual(JSON.parse(JSON.stringify(app.state.pendingSelectedTaskOperations)), [{
    id: "selected-operation",
    taskId: null,
    occurredAt: new Date(baseTime).toISOString(),
    hlcWallMs: baseTime,
    hlcCounter: 0
  }]);
  assert.equal(app.state.selectedTaskId, null);
  assert.deepEqual(JSON.parse(JSON.stringify(app.state.timer)), activeTimer);
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

test("changed session identity closes old revision stream before replacement", () => {
  const app = loadTaskProjection();
  let closeCount = 0;
  app.state.user = { id: "user-old" };
  app.setRevisionStreamForTest({ close() { closeCount += 1; } });

  app.closeRevisionStreamForIdentityChange("user-new");

  assert.equal(closeCount, 1);
  assert.equal(app.hasRevisionStreamForTest(), false);
});

test("explicit identity teardown closes the current revision stream", () => {
  const app = loadTaskProjection();
  let closed = false;
  app.state.user = { id: "account-a" };
  app.setRevisionStreamForTest({ close() { closed = true; } });
  app.closeRevisionStreamForIdentityChange();
  assert.equal(closed, true);
  assert.equal(app.hasRevisionStreamForTest(), false);
});

test("unchanged session identity keeps current revision stream", () => {
  const app = loadTaskProjection();
  let closeCount = 0;
  app.state.user = { id: "user-1" };
  app.setRevisionStreamForTest({ close() { closeCount += 1; } });

  app.closeRevisionStreamForIdentityChange("user-1");

  assert.equal(closeCount, 0);
  assert.equal(app.hasRevisionStreamForTest(), true);
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

  app.rebuildOptimisticAutoStart();

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

test("optimistic reducer auto-completes before late commands and lets finish claim deadline", () => {
  const app = loadTaskProjection();
  const running = timer("running");
  running.plannedDurationMs = 5_000;
  const latePause = matrixCommand("pause", "same");
  latePause.occurredAt = new Date(baseTime + 8_000).toISOString();

  const completed = app.reduceCommand(running, [], latePause);
  assert.equal(completed.timer.status, "completed");
  assert.equal(completed.timer.anchorAt, new Date(baseTime + 5_000).toISOString());
  assert.equal(completed.history.length, 1);
  assert.equal(completed.history[0].commandId, null);
  assert.equal(completed.history[0].taskId, "task-source");

  const finish = matrixCommand("finish", "same");
  finish.id = "claim-finish";
  finish.occurredAt = new Date(baseTime + 9_000).toISOString();
  const claimed = app.reduceCommand(completed.timer, completed.history, finish);
  assert.equal(claimed.timer.anchorAt, new Date(baseTime + 5_000).toISOString());
  assert.equal(claimed.timer.lastIntent.commandId, "claim-finish");
  assert.equal(claimed.history[0].commandId, "claim-finish");
  assert.equal(claimed.history[0].completedAt, new Date(baseTime + 5_000).toISOString());
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
    "a293a679179f7f441a89b04f0260ee77fc0d810abc61e99501f9260a6ea9012e"
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

test("account deletion does not broadcast local sign-out before server confirmation", () => {
  const source = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
  const body = source.slice(source.indexOf("  async function deleteAccount()"), source.indexOf("  async function logout()"));
  assert.ok(body.indexOf("if (!response.ok)") < body.indexOf("markPendingLogout()"));
});

test("account deletion requires the exact destructive phrase", () => {
  const app = loadTaskProjection();
  assert.equal(app.accountDeletionConfirmationIsValid("DELETE"), true);
  for (const value of ["", "delete", "DELETE ", " DELETE", null, undefined]) {
    assert.equal(app.accountDeletionConfirmationIsValid(value), false, String(value));
  }
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
  assert.equal(await app.requestSessionRevocation(null), false);
  assert.equal(await app.requestSessionRevocation("csrf"), true);
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
        async json() { return { user: { id: "old-account" }, csrfToken: "csrf" }; }
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
