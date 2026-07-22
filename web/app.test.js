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
    closeRevisionStreamForIdentityChange,
    setRevisionStreamForTest(value) { eventSource = value; },
    hasRevisionStreamForTest() { return Boolean(eventSource); }
  };`
  );
  assert.notEqual(instrumented, source, "app test seam was not installed");
  const context = {
    PomodoroughSync: sync,
    PomodoroughStorage: {},
    console,
    crypto: { randomUUID: () => "test-tab-id" },
    document: {
      querySelector: () => null,
      querySelectorAll: () => []
    },
    window: { setInterval: () => 0 }
  };
  context.globalThis = context;
  vm.runInNewContext(instrumented, context, { filename: appPath });
  return context.PomodoroughAppTest;
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
