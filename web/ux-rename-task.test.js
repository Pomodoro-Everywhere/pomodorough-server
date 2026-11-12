"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const sync = require("./sync-core.js");
const { storage, loadCore, seedMeta, dump, nowMs } = require("./test/account-ownership-fixture.js");
const { viewFixture, settle, waitFor, spy, rowFor } = require("./test/ux-view-fixture.js");

// Core 0.56.0 admits `renameTask` in its strict PWA schema (R54-S11), so the
// PWA shows Rename on every task and sends the intent with `lifecycle`. Every
// test here runs the real bundled Core; the recording wrapper only keeps a
// copy of each rename request and its plan.
function recordingCore(core, requests) {
  const recording = Object.create(core);
  recording.call = (operation, input) => {
    if (operation !== "workspace.intent.v1" || input.intent?.kind !== "renameTask") return core.call(operation, input);
    const request = { ...input, plan: null, error: null };
    requests.push(request);
    try {
      request.plan = core.call(operation, input);
      return request.plan;
    } catch (error) {
      request.error = error;
      throw error;
    }
  };
  return recording;
}

async function recordedFixture(t, timerStatus = null) {
  const { core } = await loadCore();
  const requests = [];
  const recording = recordingCore(core, requests);
  const current = await viewFixture(t, timerStatus, { core: recording });
  // The ownership fixture re-registers the real core while loading, so the
  // storage-level recorder is installed after it.
  storage.setSharedCore(recording);
  t.after(() => storage.setSharedCore(core));
  current.core = core;
  current.requests = requests;
  return current;
}

function taskOperationsOf(plan) {
  return plan.durableOperations.taskOperations.map(({ type, taskId, title }) => ({ type, taskId, title }));
}

// Formerly the pin "the bundled Core rejects a PWA rename": Core 0.55.0
// refused the strict-schema intent with "intent.kind must be a JSON string
// enum", and only a stub that answered noop covered the editor.
test("the bundled Core 0.56.0 plans a PWA rename and the task list shows the new title", async (t) => {
  const current = await recordedFixture(t);
  assert.equal(await current.use.addTask("Alpha"), true);
  const [alpha] = current.state.tasks;
  assert.equal(current.state.selectedTaskId, alpha.id);
  assert.ok(rowFor(current.elements, alpha.id).querySelector(".task-rename"), "Rename is always offered");
  assert.equal(await current.use.renameTask(alpha, "Beta"), true);
  const beta = current.core.taskIdentity({ title: "Beta" });
  assert.equal(current.requests.length, 1);
  const [request] = current.requests;
  assert.equal(Object.hasOwn(request, "lifecycle"), true, "the PWA sends the strict intent");
  assert.deepEqual(request.intent, { kind: "renameTask", taskId: alpha.id, title: "Beta" });
  assert.equal(request.error, null);
  assert.deepEqual(taskOperationsOf(request.plan), [
    { type: "upsert", taskId: beta.id, title: "Beta" },
    { type: "rename", taskId: alpha.id, title: "Beta" }
  ]);
  assert.deepEqual(request.plan.durableOperations.selectedTaskOperations.map(({ taskId }) => taskId), [beta.id]);
  const renameOperation = request.plan.durableOperations.taskOperations[1];
  assert.deepEqual(Object.keys(sync.taskRequestOperation(renameOperation)).sort(),
    ["hlcCounter", "hlcWallMs", "id", "occurredAt", "taskId", "title", "type"], "the rename is sent with its new title");
  assert.deepEqual(current.state.tasks.map((task) => [task.id, task.title]), [[beta.id, "Beta"]]);
  assert.equal(current.state.selectedTaskId, beta.id, "the selection follows the rename");
  assert.equal(rowFor(current.elements, alpha.id), null);
  assert.equal(rowFor(current.elements, beta.id).querySelector("strong.task-name").textContent, "Beta");
});

const SEVEN_MINUTES_MS = 7 * 60_000;
const NINE_MINUTES_MS = 9 * 60_000;

async function seedSnapshot(current, fields) {
  const records = await dump(current.use.database());
  const snapshot = records.meta.find((record) => record.key === "snapshot").value;
  await seedMeta(current.use.database(), { snapshot: { ...snapshot, ...fields } });
  await current.use.reloadPersistedState();
  current.view.render();
}

function setNow(t, current, atMs) {
  t.mock.timers.setTime(atMs);
  current.use.trustedNow = () => atMs;
}

function todayOn(current, taskId) {
  return current.use.getWorkspaceReadModel().tasks.completedFocusTodayByTask[taskId];
}

function statsOn(current, taskId) {
  return [...rowFor(current.elements, taskId).querySelectorAll(".task-stat")].map((cell) => cell.textContent);
}

// C04: Core 0.56.0 carries finished history to the new task identity, so a
// rename keeps today's runs and minutes. On 0.55.0 the row stayed on the old
// ID, which no longer exists, and the renamed task showed zero.
test("a rename keeps today's runs and minutes from a local finished focus run", async (t) => {
  const current = await recordedFixture(t);
  await seedSnapshot(current, { autoStartBreaks: false });
  assert.equal(await current.use.addTask("Alpha"), true);
  const [alpha] = current.state.tasks;
  assert.equal(await current.use.issueCommand("start", { phase: "focus" }), true);
  setNow(t, current, nowMs + SEVEN_MINUTES_MS);
  assert.equal(await current.use.finishTimer(false), true);
  assert.deepEqual(todayOn(current, alpha.id), { count: 1, elapsedMs: SEVEN_MINUTES_MS });

  setNow(t, current, nowMs + SEVEN_MINUTES_MS + 60_000);
  assert.equal(await current.use.renameTask(alpha, "Beta"), true);
  current.view.render();
  const beta = current.core.taskIdentity({ title: "Beta" });
  assert.deepEqual(todayOn(current, beta.id), { count: 1, elapsedMs: SEVEN_MINUTES_MS });
  assert.equal(todayOn(current, alpha.id), undefined);
  assert.deepEqual(current.state.history.filter((row) => row.phase === "focus").map((row) => row.taskId), [beta.id]);
  assert.deepEqual(statsOn(current, beta.id), ["1", "7 min"]);
});

// The PWA keeps the server's history as received. A pending rename edge moves
// a base row that finished before the rename onto the new task, in Core.
test("a rename keeps today's runs and minutes from a synced base history row", async (t) => {
  const current = await recordedFixture(t);
  const alpha = current.core.taskIdentity({ title: "Alpha" });
  const completedAt = new Date(nowMs - 60_000).toISOString();
  await seedSnapshot(current, {
    tasks: [{ id: alpha.id, title: "Alpha" }], selectedTaskId: alpha.id,
    history: [{ id: "base-focus-row", timerId: "base-focus-row", taskId: alpha.id, phase: "focus", status: "completed",
      plannedDurationMs: 25 * 60_000, elapsedMs: NINE_MINUTES_MS, completedAt, endedAt: completedAt }]
  });
  assert.deepEqual(todayOn(current, alpha.id), { count: 1, elapsedMs: NINE_MINUTES_MS });
  assert.equal(await current.use.renameTask(current.state.tasks[0], "Beta"), true);
  current.view.render();
  const beta = current.core.taskIdentity({ title: "Beta" });
  assert.deepEqual(current.state.tasks.map((task) => task.id), [beta.id]);
  assert.deepEqual(todayOn(current, beta.id), { count: 1, elapsedMs: NINE_MINUTES_MS });
  assert.deepEqual(statsOn(current, beta.id), ["1", "9 min"]);
  const stored = (await dump(current.use.database())).meta.find((record) => record.key === "snapshot").value;
  assert.equal(stored.history[0].taskId, alpha.id, "the stored base stays as the server sent it");
});

async function renameFixture(t) {
  const current = await recordedFixture(t);
  assert.equal(await current.use.addTask("Alpha"), true);
  assert.equal(await current.use.addTask("Beta"), true);
  current.renames = spy(current.use, "renameTask", []);
  current.deletes = spy(current.use, "deleteTask", []);
  return current;
}

function beginRename(current, task) {
  const row = rowFor(current.elements, task.id);
  const button = row.querySelector(".task-rename");
  button.click();
  const input = rowFor(current.elements, task.id).querySelector(".task-rename-input");
  assert.ok(input, "editor rendered");
  return input;
}

function keydown(current, input, key) {
  input.dispatchEvent(new current.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

function type(current, input, value) {
  input.value = value;
  input.dispatchEvent(new current.window.Event("input", { bubbles: true }));
}

test("the rename control commits the renameTask intent with four identities", async (t) => {
  const current = await renameFixture(t);
  const [alpha] = current.state.tasks;
  const button = rowFor(current.elements, alpha.id).querySelector(".task-rename");
  assert.equal(button.textContent, "Rename");
  assert.equal(button.getAttribute("aria-label"), "Rename Alpha");
  assert.equal(button.disabled, false);
  const input = beginRename(current, alpha);
  assert.equal(input.value, "Alpha");
  assert.equal(current.document.activeElement, input);
  assert.equal(rowFor(current.elements, alpha.id).querySelector("strong.task-name"), null);
  // Edge spaces are part of a title, so the draft is sent exactly as typed.
  type(current, input, "  Alpha renamed  ");
  keydown(current, input, "Enter");
  await waitFor(() => current.renames.length === 1, "rename intent");
  assert.deepEqual(current.renames[0].args, [alpha, "  Alpha renamed  "]);
  assert.equal(await current.renames[0].result, true, "the bundled Core applies the rename");
  assert.equal(current.requests.length, 1);
  const request = current.requests[0];
  assert.deepEqual(request.intent, { kind: "renameTask", taskId: alpha.id, title: "  Alpha renamed  " });
  assert.equal(request.identities.commandUuids.length, 4);
  assert.equal(new Set(request.identities.commandUuids).size, 4);
  assert.equal(request.ownership.expectedOwnerId, current.state.localOwnerId);
  const renamed = current.core.taskIdentity({ title: "  Alpha renamed  " });
  assert.equal(rowFor(current.elements, alpha.id), null, "the old row is gone");
  const row = rowFor(current.elements, renamed.id);
  assert.equal(row.querySelector("strong.task-name").textContent, "  Alpha renamed  ", "editor closed on the new title");
  assert.equal(row.querySelector(".task-rename-input"), null);
});

test("escape and an unchanged title cancel without an intent or a notice", async (t) => {
  const current = await renameFixture(t);
  const [alpha] = current.state.tasks;
  let input = beginRename(current, alpha);
  type(current, input, "Changed");
  keydown(current, input, "Escape");
  assert.equal(rowFor(current.elements, alpha.id).querySelector("strong.task-name").textContent, "Alpha");
  assert.equal(current.document.activeElement, rowFor(current.elements, alpha.id).querySelector(".task-rename"));
  input = beginRename(current, alpha);
  type(current, input, "Alpha");
  keydown(current, input, "Enter");
  await settle();
  assert.equal(rowFor(current.elements, alpha.id).querySelector("strong.task-name").textContent, "Alpha");
  assert.equal(current.renames.length, 0);
  assert.equal(current.requests.length, 0);
  assert.equal(current.elements.notice.hidden, true);
});

// Rename follows the composer rule: a blank draft is refused with the
// composer's notice, and any other draft is sent exactly as typed.
test("a blank rename draft is refused with the composer's notice", async (t) => {
  const current = await renameFixture(t);
  const [alpha] = current.state.tasks;
  for (const draft of ["", "   "]) {
    const input = beginRename(current, alpha);
    type(current, input, draft);
    keydown(current, input, "Enter");
    await settle();
    assert.equal(rowFor(current.elements, alpha.id).querySelector("strong.task-name").textContent, "Alpha", JSON.stringify(draft));
    assert.equal(current.elements.notice.hidden, false, JSON.stringify(draft));
    assert.equal(current.elements.noticeText.textContent, "Enter a printable task name.", JSON.stringify(draft));
    current.view.clearNotice("actions.task.save-failed");
  }
  assert.equal(current.renames.length, 0);
  assert.equal(current.requests.length, 0);

  current.elements.taskInput.value = "   ";
  current.elements.taskForm.dispatchEvent(new current.window.Event("submit", { cancelable: true }));
  await settle();
  assert.equal(current.elements.noticeText.textContent, "Enter a printable task name.", "the composer shows the same notice");
});

test("a rename draft with edge spaces is sent as typed", async (t) => {
  const current = await renameFixture(t);
  const [alpha] = current.state.tasks;
  const input = beginRename(current, alpha);
  type(current, input, " Alpha ");
  keydown(current, input, "Enter");
  await waitFor(() => current.renames.length === 1, "rename intent");
  await current.renames[0].result;
  assert.deepEqual(current.requests.map((request) => request.intent), [{ kind: "renameTask", taskId: alpha.id, title: " Alpha " }]);
});

test("blur commits a changed draft and cancels an unchanged one", async (t) => {
  const current = await renameFixture(t);
  const [alpha, beta] = current.state.tasks;
  let input = beginRename(current, alpha);
  input.dispatchEvent(new current.window.FocusEvent("blur"));
  await settle();
  assert.equal(current.renames.length, 0);
  assert.ok(rowFor(current.elements, alpha.id).querySelector("strong.task-name"));
  input = beginRename(current, beta);
  type(current, input, "Beta two");
  input.dispatchEvent(new current.window.FocusEvent("blur"));
  await waitFor(() => current.renames.length === 1, "rename intent after blur");
  await current.renames[0].result;
  assert.deepEqual(current.requests.map((request) => request.intent), [{ kind: "renameTask", taskId: beta.id, title: "Beta two" }]);
});

test("rename flushes a pending delete before sending its own intent", async (t) => {
  const current = await renameFixture(t);
  const [alpha, beta] = current.state.tasks;
  rowFor(current.elements, beta.id).querySelector(".task-delete").click();
  const input = beginRename(current, alpha);
  type(current, input, "Alpha two");
  keydown(current, input, "Enter");
  await waitFor(() => current.renames.length === 1, "rename intent after flush");
  assert.equal(current.deletes.length, 1);
  assert.equal(await current.deletes[0].result, true);
  await current.renames[0].result;
  assert.deepEqual(current.state.tasks.map((task) => task.title), ["Alpha two"]);
  assert.equal(current.requests[0].intent.title, "Alpha two");
});

test("rename and delete controls share the blocked state", async (t) => {
  const current = await renameFixture(t);
  current.state.ready = false;
  current.view.renderTasks();
  for (const row of current.elements.taskList.querySelectorAll(".task-row")) {
    assert.equal(row.querySelector(".task-rename").disabled, true);
    assert.equal(row.querySelector(".task-delete").disabled, true);
  }
});
