"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { viewFixture, setVisibility, waitFor, spy, taskRows, rowFor } = require("./test/ux-view-fixture.js");

const UNDO_MS = 5000;

async function withTasks(t, titles) {
  const current = await viewFixture(t);
  for (const title of titles) assert.equal(await current.use.addTask(title), true);
  current.deletes = spy(current.use, "deleteTask", []);
  return current;
}

function undoTimer(current) {
  const timers = current.callbacks.filter((entry) => entry.delay === UNDO_MS);
  return timers[timers.length - 1];
}

test("delete hides the row, shows the undo toast, and sends nothing for 5 s", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  const [alpha] = current.state.tasks;
  rowFor(current.elements, alpha.id).querySelector(".task-delete").click();
  assert.equal(rowFor(current.elements, alpha.id), null);
  assert.equal(current.elements.taskCount.textContent, "00");
  assert.equal(current.elements.undoToast.hidden, false);
  assert.equal(current.elements.undoToastText.textContent, "Deleted “Alpha”");
  assert.equal(current.elements.undoToast.getAttribute("role"), "status");
  assert.equal(current.elements.undoToast.getAttribute("aria-live"), "polite");
  assert.equal(current.elements.notice.hidden, true);
  assert.equal(current.deletes.length, 0);
  assert.deepEqual(current.state.tasks.map((task) => task.title), ["Alpha"]);
  const timer = undoTimer(current);
  assert.ok(timer, "undo timer scheduled at 5000 ms");
  assert.equal(await timer.callback(), true);
  assert.equal(current.deletes.length, 1);
  assert.deepEqual(current.deletes[0].args[0], { id: alpha.id, title: "Alpha" });
  assert.deepEqual(current.state.tasks, []);
  assert.equal(current.elements.undoToast.hidden, true);
});

test("undo restores the row, hides the toast, focuses its delete button, and never sends", async (t) => {
  const current = await withTasks(t, ["Alpha", "Beta"]);
  const [alpha] = current.state.tasks;
  rowFor(current.elements, alpha.id).querySelector(".task-delete").click();
  const timer = undoTimer(current);
  current.elements.undoToastUndo.click();
  assert.equal(current.elements.undoToast.hidden, true);
  const restored = rowFor(current.elements, alpha.id);
  assert.ok(restored);
  assert.equal(current.document.activeElement, restored.querySelector(".task-delete"));
  assert.equal(current.elements.taskCount.textContent, "02");
  assert.equal(await timer.callback(), false, "stale timer is inert after undo");
  assert.equal(await current.view.flushTaskDeletion(), false);
  assert.equal(current.deletes.length, 0);
  assert.deepEqual(current.state.tasks.map((task) => task.title), ["Alpha", "Beta"]);
});

test("a second delete flushes the first immediately and defers only the new one", async (t) => {
  const current = await withTasks(t, ["Alpha", "Beta"]);
  const [alpha, beta] = current.state.tasks;
  rowFor(current.elements, alpha.id).querySelector(".task-delete").click();
  rowFor(current.elements, beta.id).querySelector(".task-delete").click();
  assert.equal(current.deletes.length, 1);
  assert.equal(current.deletes[0].args[0].id, alpha.id);
  assert.equal(await current.deletes[0].result, true);
  assert.deepEqual(current.state.tasks.map((task) => task.title), ["Beta"]);
  assert.equal(current.elements.undoToastText.textContent, "Deleted “Beta”");
  assert.equal(taskRows(current.elements).length, 0);
  current.elements.undoToastUndo.click();
  assert.deepEqual(taskRows(current.elements).map((row) => row.dataset.taskId), [beta.id]);
  assert.equal(current.deletes.length, 1);
});

test("adding a task flushes the pending delete first", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  const [alpha] = current.state.tasks;
  rowFor(current.elements, alpha.id).querySelector(".task-delete").click();
  current.elements.taskInput.value = "Beta";
  const adds = spy(current.use, "addTask", []);
  current.elements.taskForm.dispatchEvent(new current.window.Event("submit", { cancelable: true }));
  await waitFor(() => adds.length === 1, "addTask after flush");
  assert.equal(current.deletes.length, 1);
  assert.equal(await current.deletes[0].result, true);
  assert.equal(await adds[0].result, true);
  assert.deepEqual(current.state.tasks.map((task) => task.title), ["Beta"]);
  assert.equal(current.elements.taskInput.value, "");
  assert.equal(current.elements.undoToast.hidden, true);
});

test("hiding the page flushes the pending delete", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  rowFor(current.elements, current.state.tasks[0].id).querySelector(".task-delete").click();
  setVisibility(current.document, "hidden");
  assert.equal(current.deletes.length, 1);
  assert.equal(await current.deletes[0].result, true);
  assert.deepEqual(current.state.tasks, []);
  setVisibility(current.document, "visible");
  assert.equal(current.deletes.length, 1, "visible transition sends nothing more");
});

test("pagehide flushes the pending delete before the timer lease handling", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  rowFor(current.elements, current.state.tasks[0].id).querySelector(".task-delete").click();
  current.window.dispatchEvent(new current.window.PageTransitionEvent("pagehide", { persisted: true }));
  assert.equal(current.deletes.length, 1);
  assert.equal(await current.deletes[0].result, true);
  assert.deepEqual(current.state.tasks, []);
});

test("flush is idempotent: repeated flushes and the fired timer send one delete", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  rowFor(current.elements, current.state.tasks[0].id).querySelector(".task-delete").click();
  const timer = undoTimer(current);
  const [first, second] = [current.view.flushTaskDeletion(), current.view.flushTaskDeletion()];
  assert.equal(await first, true);
  assert.equal(await second, false);
  assert.equal(await timer.callback(), false);
  assert.equal(current.deletes.length, 1);
});

test("focus moves to the next surviving row when a focused delete is deferred", async (t) => {
  const current = await withTasks(t, ["Alpha", "Beta"]);
  const [alpha, beta] = current.state.tasks;
  const remove = rowFor(current.elements, alpha.id).querySelector(".task-delete");
  remove.focus();
  remove.click();
  assert.equal(current.document.activeElement, rowFor(current.elements, beta.id).querySelector(".task-delete"));
});
