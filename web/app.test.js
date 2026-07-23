"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const sync = require("./sync-core.js");

function loadTaskProjection() {
  const appPath = path.join(__dirname, "app.js");
  const source = fs.readFileSync(appPath, "utf8");
  const instrumented = source.replace(
    "  initialize();",
    `  globalThis.PomodoroughAppTest = {
    state,
    rebuildOptimisticTasks,
    rebuildOptimisticAutoStart,
    completionRetryDelay,
    nextBreakPhase,
    releaseCompletionRetry,
    scheduleCompletionRetry,
    setCompletionQueuedForTest(value) { completionQueuedFor = value; },
    completionQueuedForTest() { return completionQueuedFor; },
    closeRevisionStreamForIdentityChange,
    setRevisionStreamForTest(value) { eventSource = value; },
    hasRevisionStreamForTest() { return Boolean(eventSource); }
  };`
  );
  assert.notEqual(instrumented, source, "app test seam was not installed");
  let scheduledTimeout = null;
  const context = {
    PomodoroughSync: sync,
    PomodoroughStorage: {},
    console,
    crypto: { randomUUID: () => "test-tab-id" },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    document: {
      querySelector: () => null,
      querySelectorAll: () => []
    },
    window: {
      clearTimeout: () => {},
      setInterval: () => 0,
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
    }
  };
}

test("remote task deletion clears selection unless a pending operation recreates task", () => {
  const { state, rebuildOptimisticTasks } = loadTaskProjection();
  state.baseTasks = [{ id: "selected-task", title: "Selected" }];
  state.pendingTaskOperations = [];
  state.selectedTaskId = "selected-task";

  state.baseTasks = [];
  rebuildOptimisticTasks();
  assert.equal(state.tasks.length, 0);
  assert.equal(state.selectedTaskId, null);

  state.selectedTaskId = "selected-task";
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

  state.pendingTaskOperations.push({
    id: "task-operation-delete",
    taskId: "selected-task",
    type: "delete",
    hlcWallMs: 2,
    hlcCounter: 0
  });
  rebuildOptimisticTasks();
  assert.equal(state.tasks.length, 0);
  assert.equal(state.selectedTaskId, null);
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

test("unchanged session identity keeps current revision stream", () => {
  const app = loadTaskProjection();
  let closeCount = 0;
  app.state.user = { id: "user-1" };
  app.setRevisionStreamForTest({ close() { closeCount += 1; } });

  app.closeRevisionStreamForIdentityChange("user-1");

  assert.equal(closeCount, 0);
  assert.equal(app.hasRevisionStreamForTest(), true);
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

  for (let count = 1; count <= 4; count += 1) {
    app.state.history = Array.from({ length: count }, (_, index) => ({
      id: `focus-${index}`,
      timerId: `focus-${index}`,
      phase: "focus",
      status: "completed"
    }));
    assert.equal(
      app.nextBreakPhase(),
      count === 4 ? "long_break" : "short_break"
    );
  }
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
