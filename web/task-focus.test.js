"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const viewModule = require("./app-view.js");

function fixture(t) {
  const dom = new JSDOM(`<button id="outside">Timer</button><section id="tasksScreen">
    <span id="taskCount"></span><form id="taskForm"><input id="taskInput">
    <button type="submit">Add</button></form><div id="taskList"></div></section>`);
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((el) => [el.id, el]));
  const state = { tasks: ["a", "b", "c"].map((id) => ({ id, title: id })), history: [] };
  const deleted = [];
  let blocked = false;
  const use = {
    controlsBlocked: () => blocked, tr: (_key, _args, fallback) => fallback,
    deleteTask: (task) => deleted.push(task), historyDateMs: (item) => Date.parse(item.completedAt),
    positiveNumber: (value, fallback) => Number(value) || fallback
  };
  const view = viewModule.create({ state, external: { host: dom.window, elements }, use });
  view.renderTasks();
  const buttons = () => [...elements.taskList.querySelectorAll("button")];
  return { document, elements, state, deleted, use, view, buttons, block: () => { blocked = true; } };
}

test("R43-S06 same task retains Delete focus through repeated fresh projections and reordering", (t) => {
  const f = fixture(t);
  f.buttons()[1].focus();
  for (let index = 0; index < 5; index += 1) {
    f.state.tasks = ["c", "a", "b"].map((id) => ({ id, title: `${id}-${index}` }));
    f.view.renderTasks();
    assert.equal(f.document.activeElement, f.buttons()[2]);
    assert.equal(f.document.activeElement.getAttribute("aria-label"), `Delete b-${index}`);
  }
  f.document.activeElement.click();
  assert.deepEqual(f.deleted, [f.state.tasks[2]], "exactly one listener uses current task object");
  assert.deepEqual([...f.elements.taskList.querySelectorAll(".task-name")].map((el) => el.textContent),
    ["c-4", "a-4", "b-4"]);
});

for (const scenario of [
  { name: "next surviving row even after reorder", focus: 1, remaining: ["c", "a"], expected: "Delete c" },
  { name: "previous row after last row deletion", focus: 2, remaining: ["a", "b"], expected: "Delete b" },
  { name: "next surviving row after batch removal", focus: 0, remaining: ["c"], expected: "Delete c" },
  { name: "empty list returns to task input", focus: 1, remaining: [], expected: null }
]) {
  test(`R43-S06 focused deletion: ${scenario.name}`, (t) => {
    const f = fixture(t);
    f.buttons()[scenario.focus].focus();
    f.state.tasks = scenario.remaining.map((id) => ({ id, title: id }));
    f.view.renderTasks();
    if (scenario.expected) assert.equal(f.document.activeElement.getAttribute("aria-label"), scenario.expected);
    else assert.equal(f.document.activeElement, f.elements.taskInput);
    assert.equal(f.elements.taskCount.textContent, String(scenario.remaining.length).padStart(2, "0"));
  });
}

test("R43-S06 background renders never steal input, outside control, or body focus", (t) => {
  const f = fixture(t);
  for (const target of [f.elements.taskInput, f.elements.outside]) {
    target.focus();
    f.elements.taskInput.value = "draft task";
    f.elements.taskInput.setSelectionRange(2, 5);
    f.view.renderTasks();
    assert.equal(f.document.activeElement, target);
    assert.equal(f.elements.taskInput.value, "draft task");
    assert.equal(f.elements.taskInput.selectionStart, 2);
    assert.equal(f.elements.taskInput.selectionEnd, 5);
  }
  f.document.activeElement.blur();
  f.view.renderTasks();
  assert.equal(f.document.activeElement, f.document.body);
});

test("R43-S06 blocked or hidden tasks do not receive restored focus", (t) => {
  const f = fixture(t);
  f.buttons()[1].focus();
  f.block();
  f.view.renderTasks();
  assert.equal(f.document.activeElement, f.document.body);
  assert.ok(f.buttons().every((button) => button.disabled));
  f.use.controlsBlocked = () => false;
  f.view.renderTasks();
  assert.equal(f.document.activeElement, f.document.body, "unblocking must not revive stale focus");
  f.buttons()[0].focus();
  f.elements.tasksScreen.hidden = true;
  f.view.renderTasks();
  assert.equal(f.document.activeElement, f.document.body);
});

test("R43-S06 focus moved during rendering wins over restoration", (t) => {
  const f = fixture(t);
  f.buttons()[1].focus();
  f.use.tr = (_key, _args, fallback) => { f.elements.outside.focus(); return fallback; };
  f.view.renderTasks();
  assert.equal(f.document.activeElement, f.elements.outside);
});

test("R43-S06 history filters and accessible task summaries survive focus restoration", async (t) => {
  const f = fixture(t);
  const crypto = require("node:crypto");
  globalThis.crypto ||= crypto.webcrypto;
  const core = await require("./shared-core.js").SharedCore.fromBytes(require("node:fs").readFileSync(require("node:path").join(__dirname, "pomodorough_core.wasm")));
  const storage = require("./sync-storage.js");
  storage.setSharedCore(core);
  f.state.ready = true;
  f.state.tasks = f.state.tasks.map((task) => core.taskIdentity({ title: task.title }));
  const taskId = f.state.tasks[1].id;
  const completedAt = new Date().toISOString();
  f.state.history = [
    { id: "done", timerId: "done-timer", taskId, phase: "focus", status: "completed", completedAt, endedAt: completedAt, plannedDurationMs: 1_500_000 },
    { id: "cancel", timerId: "cancel-timer", taskId, phase: "focus", status: "cancelled", endedAt: completedAt, plannedDurationMs: 900_000 },
    { id: "break", timerId: "break-timer", taskId, phase: "short_break", status: "completed", completedAt, endedAt: completedAt, plannedDurationMs: 300_000 },
    { id: "old", timerId: "old-timer", taskId, phase: "focus", status: "completed", completedAt: "2000-01-01T00:00:00Z", plannedDurationMs: 900_000 }
  ];
  f.use.getWorkspaceReadModel = () => storage.readWorkspace({ snapshot: { canonicalTimer: null, history: f.state.history,
    tasks: f.state.tasks, durationsMs: { focus: 1500000, short_break: 300000, long_break: 900000 },
    autoStartBreaks: false, selectedTaskId: null }, deviceId: "focus-fixture", selectedPhase: "focus", nowMs: Date.now() });
  f.view.renderTasks();
  f.buttons()[1].focus();
  f.view.renderTasks();
  assert.equal(f.document.activeElement, f.buttons()[1]);
  const stats = [...f.elements.taskList.children[1].querySelectorAll(".task-stat")];
  assert.deepEqual(stats.map((el) => el.textContent), ["1", "25 min"]);
  assert.deepEqual(stats.map((el) => el.getAttribute("aria-label")),
    ["1 finished pomodoros today", "25 min spent today"]);
});
