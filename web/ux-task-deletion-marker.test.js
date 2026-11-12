"use strict";

// UX round 2 (B1): a task delete waits in an untimed undo window. A page that
// unloads inside the window cannot finish the asynchronous delete, so the
// intent is written to local storage at delete time and replayed by the next
// startup through the same `use.deleteTask` path.

const test = require("node:test");
const assert = require("node:assert/strict");
const { IDBFactory } = require("fake-indexeddb");
const { viewFixture, setVisibility, settle, waitFor, spy, rowFor } = require("./test/ux-view-fixture.js");
const { deferred } = require("./test/account-ownership-fixture.js");
const { openApp, waitFor: waitForApp } = require("./test/ux-round2-app-fixture.js");

const MARKER_KEY = "pomodoroughPendingTaskDeletions";
const LOCK_PREFIX = "pomodorough-task-deletion-undo:";

async function withTasks(t, titles) {
  const current = await viewFixture(t);
  for (const title of titles) assert.equal(await current.use.addTask(title), true);
  current.deletes = spy(current.use, "deleteTask", []);
  current.ownerId = current.use.captureAccountContext().ownerId;
  return current;
}

function deleteRow(current, task) {
  rowFor(current.elements, task.id).querySelector(".task-delete").click();
}

function storedMarkers(storage) {
  const value = storage.getItem(MARKER_KEY);
  return value === null ? null : JSON.parse(value);
}

function writeMarkers(current, records) {
  current.host.localStorage.setItem(MARKER_KEY, JSON.stringify(records));
}

function markerFor(current, task, overrides = {}) {
  return { taskId: task.id, ownerId: current.ownerId, tabId: current.use.tabId(), ...overrides };
}

// The part of the Web Locks API the marker uses. `held` names the locks some
// page holds; a request for a held name waits, or gets null with ifAvailable.
function fakeLocks() {
  const held = new Set();
  const request = async (name, options, callback = options) => {
    if (held.has(name)) {
      if (options?.ifAvailable === true) return callback(null);
      throw new Error(`test never queues behind a held lock: ${name}`);
    }
    held.add(name);
    try { return await callback({ name }); } finally { held.delete(name); }
  };
  return { held, request };
}

test("delete writes the marker before any asynchronous step, without the task title", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  const [alpha] = current.state.tasks;
  assert.equal(storedMarkers(current.host.localStorage), null);
  deleteRow(current, alpha);
  assert.deepEqual(storedMarkers(current.host.localStorage),
    [{ taskId: alpha.id, ownerId: current.ownerId, tabId: current.use.tabId() }]);
  assert.equal(typeof current.ownerId, "string");
  assert.equal(current.deletes.length, 0);
});

test("the signed-out local workspace marks its delete with a null owner", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  const [alpha] = current.state.tasks;
  Object.assign(current.state, { user: null, localOwnerId: null });
  deleteRow(current, alpha);
  assert.deepEqual(storedMarkers(current.host.localStorage),
    [{ taskId: alpha.id, ownerId: null, tabId: current.use.tabId() }]);
});

test("Undo clears the marker and nothing is replayed afterwards", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  deleteRow(current, current.state.tasks[0]);
  current.elements.undoToastUndo.click();
  assert.equal(storedMarkers(current.host.localStorage), null);
  assert.equal(await current.use.replayPendingTaskDeletions(), 0);
  assert.equal(current.deletes.length, 0);
  assert.deepEqual(current.state.tasks.map((task) => task.title), ["Alpha"]);
});

test("the marker stays while the delete is in flight and is cleared when it completes", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  const [alpha] = current.state.tasks;
  const gate = deferred();
  const deleteTask = current.use.deleteTask;
  current.use.deleteTask = async (task) => { await gate.promise; return deleteTask(task); };
  deleteRow(current, alpha);
  const flushed = current.view.flushTaskDeletion();
  await settle();
  assert.deepEqual(storedMarkers(current.host.localStorage), [markerFor(current, alpha)],
    "a page that dies here leaves the marker for the next startup");
  gate.resolve();
  assert.equal(await flushed, true);
  assert.equal(storedMarkers(current.host.localStorage), null);
  assert.deepEqual(current.state.tasks, []);
});

test("a delete the workspace refuses also clears the marker: the task is visible again", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  const [alpha] = current.state.tasks;
  current.use.deleteTask = async () => false;
  deleteRow(current, alpha);
  assert.equal(await current.view.flushTaskDeletion(), false);
  assert.equal(storedMarkers(current.host.localStorage), null);
  assert.ok(rowFor(current.elements, alpha.id));
});

test("a second pending delete keeps the first marker until the first delete settles", async (t) => {
  const current = await withTasks(t, ["Alpha", "Beta"]);
  const [alpha, beta] = current.state.tasks;
  deleteRow(current, alpha);
  deleteRow(current, beta);
  assert.deepEqual(storedMarkers(current.host.localStorage).map((record) => record.taskId), [alpha.id, beta.id]);
  await waitFor(() => current.state.tasks.length === 1, "the first delete");
  await settle();
  assert.deepEqual(storedMarkers(current.host.localStorage), [markerFor(current, beta)]);
});

test("startup replay deletes the marked task through use.deleteTask and clears the marker", async (t) => {
  const current = await withTasks(t, ["Alpha", "Beta"]);
  const [alpha] = current.state.tasks;
  writeMarkers(current, [markerFor(current, alpha)]);
  assert.equal(await current.use.replayPendingTaskDeletions(), 1);
  assert.equal(current.deletes.length, 1);
  assert.deepEqual(current.deletes[0].args, [{ id: alpha.id, title: "Alpha" }]);
  assert.deepEqual(current.state.tasks.map((task) => task.title), ["Beta"]);
  assert.equal(storedMarkers(current.host.localStorage), null);
});

test("a marker of another workspace owner is dropped and deletes nothing", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  const [alpha] = current.state.tasks;
  for (const ownerId of ["another-owner", null]) {
    writeMarkers(current, [markerFor(current, alpha, { ownerId })]);
    assert.equal(await current.use.replayPendingTaskDeletions(), 0);
    assert.equal(storedMarkers(current.host.localStorage), null);
  }
  assert.equal(current.deletes.length, 0);
  assert.deepEqual(current.state.tasks.map((task) => task.title), ["Alpha"]);
});

test("a marker for a task that no longer exists is dropped and deletes nothing else", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  writeMarkers(current, [markerFor(current, { id: "00000000-0000-7000-8000-000000000000" })]);
  assert.equal(await current.use.replayPendingTaskDeletions(), 0);
  assert.equal(current.deletes.length, 0);
  assert.deepEqual(current.state.tasks.map((task) => task.title), ["Alpha"]);
  assert.equal(storedMarkers(current.host.localStorage), null);
});

test("an unreadable or misshapen marker deletes nothing", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  const [alpha] = current.state.tasks;
  const misshapen = [
    "{not json", JSON.stringify({ taskId: alpha.id }), JSON.stringify([alpha.id]),
    JSON.stringify([{ taskId: alpha.id, ownerId: current.ownerId }]),
    JSON.stringify([{ taskId: "", ownerId: current.ownerId, tabId: current.use.tabId() }]),
    JSON.stringify([{ taskId: alpha.id, ownerId: 7, tabId: current.use.tabId() }])
  ];
  for (const value of misshapen) {
    current.host.localStorage.setItem(MARKER_KEY, value);
    assert.equal(await current.use.replayPendingTaskDeletions(), 0, value);
  }
  assert.equal(current.deletes.length, 0);
  assert.deepEqual(current.state.tasks.map((task) => task.title), ["Alpha"]);
  const warnings = current.calls.filter((call) => call[0] === "warn"
    && call[1] === "Pomodorough pending task deletion marker storage failed:");
  assert.equal(warnings.length, 1, "the unreadable marker is reported once");
  assert.equal(warnings[0][2].name, "SyntaxError");
  assert.equal(warnings[0][2].message, "Pending task deletion marker storage failed.");
});

test("a workspace in sign-out recovery at startup drops its markers", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  const [alpha] = current.state.tasks;
  writeMarkers(current, [markerFor(current, alpha)]);
  current.state.logoutRecoveryRequired = true;
  assert.equal(current.use.controlsBlocked(), true);
  assert.equal(await current.use.replayPendingTaskDeletions(), 0);
  assert.equal(storedMarkers(current.host.localStorage), null);
  assert.equal(current.deletes.length, 0);
  assert.deepEqual(current.state.tasks.map((task) => task.title), ["Alpha"]);
});

// bc2r M1: a marker replayed while the controls are blocked is refused like a
// delete in view. The marker is cleared, the refusal notice says the task was
// not deleted, and a later ready replay deletes nothing.
const DELETE_REFUSED = "Task could not be deleted. Try again.";
for (const block of [{ ready: false }, { bootstrapBlocked: true }]) {
  test(`a replay refused by blocked controls clears its marker and says so: ${JSON.stringify(block)}`, async (t) => {
    const current = await withTasks(t, ["Alpha"]);
    const { tasks } = current.state;
    const [alpha] = tasks;
    writeMarkers(current, [markerFor(current, alpha)]);
    Object.assign(current.state, block);
    assert.equal(current.use.controlsBlocked(), true);
    assert.equal(await current.use.replayPendingTaskDeletions(), 0);
    assert.equal(storedMarkers(current.host.localStorage), null);
    assert.deepEqual(current.calls.filter(([kind]) => kind === "notice").map(([, message]) => message), [DELETE_REFUSED]);
    Object.assign(current.state, { ready: true, bootstrapBlocked: false, tasks });
    assert.equal(await current.use.replayPendingTaskDeletions(), 0);
    await settle();
    assert.deepEqual(current.state.tasks.map((task) => task.title), ["Alpha"]);
  });
}

// bc2r3 L-2: a quarantined display holds no tasks yet, so it cannot show that
// the marked task exists; the task may already be gone (a page that died after
// its delete was saved). The marker is cleared without a false "could not be
// deleted", and nothing is deleted once the display is back.
test("a blocked replay whose task is not in the display clears its marker without a notice", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  const { tasks } = current.state;
  const [alpha] = tasks;
  writeMarkers(current, [markerFor(current, alpha)]);
  Object.assign(current.state, { bootstrapBlocked: true, tasks: [] });
  assert.equal(current.use.controlsBlocked(), true);
  assert.equal(await current.use.replayPendingTaskDeletions(), 0);
  assert.equal(storedMarkers(current.host.localStorage), null);
  assert.equal(current.deletes.length, 0);
  assert.deepEqual(current.calls.filter(([kind]) => kind === "notice"), []);
  Object.assign(current.state, { bootstrapBlocked: false, tasks });
  assert.equal(await current.use.replayPendingTaskDeletions(), 0);
  await settle();
  assert.deepEqual(current.state.tasks.map((task) => task.title), ["Alpha"]);
});

test("without Web Locks another tab's marker is left alone", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  const [alpha] = current.state.tasks;
  const foreign = markerFor(current, alpha, { tabId: "another-tab" });
  writeMarkers(current, [foreign]);
  assert.equal(await current.use.replayPendingTaskDeletions(), 0);
  assert.equal(current.deletes.length, 0);
  assert.deepEqual(storedMarkers(current.host.localStorage), [foreign]);
});

test("the page holds the undo lock for the task from delete until Undo", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  const [alpha] = current.state.tasks;
  const locks = fakeLocks();
  current.host.navigator.locks = locks;
  deleteRow(current, alpha);
  assert.deepEqual([...locks.held], [LOCK_PREFIX + alpha.id]);
  current.elements.undoToastUndo.click();
  await settle();
  assert.deepEqual([...locks.held], []);
});

test("the page holds the undo lock until the delete settles", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  const [alpha] = current.state.tasks;
  const locks = fakeLocks();
  current.host.navigator.locks = locks;
  const gate = deferred();
  const deleteTask = current.use.deleteTask;
  current.use.deleteTask = async (task) => { await gate.promise; return deleteTask(task); };
  deleteRow(current, alpha);
  const flushed = current.view.flushTaskDeletion();
  await settle();
  assert.deepEqual([...locks.held], [LOCK_PREFIX + alpha.id]);
  gate.resolve();
  await flushed;
  await settle();
  assert.deepEqual([...locks.held], []);
});

test("with Web Locks a held undo lock keeps the marker and a free one replays any tab's marker", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  const [alpha] = current.state.tasks;
  const locks = fakeLocks();
  current.host.navigator.locks = locks;
  const foreign = markerFor(current, alpha, { tabId: "another-tab" });
  writeMarkers(current, [foreign]);
  locks.held.add(LOCK_PREFIX + alpha.id);
  assert.equal(await current.use.replayPendingTaskDeletions(), 0);
  assert.equal(current.deletes.length, 0, "the other tab can still offer Undo");
  assert.deepEqual(storedMarkers(current.host.localStorage), [foreign]);
  locks.held.delete(LOCK_PREFIX + alpha.id);
  assert.equal(await current.use.replayPendingTaskDeletions(), 1);
  assert.deepEqual(current.deletes[0].args, [{ id: alpha.id, title: "Alpha" }]);
  assert.deepEqual(current.state.tasks, []);
  assert.equal(storedMarkers(current.host.localStorage), null);
});

test("clearing the local workspace clears every marker", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  const [alpha] = current.state.tasks;
  writeMarkers(current, [markerFor(current, alpha), markerFor(current, alpha, { taskId: "other", tabId: "another-tab" })]);
  await current.use.clearLocalData(current.use.cleanupIdentity(), current.use.captureDatabaseContext());
  assert.equal(storedMarkers(current.host.localStorage), null);
  assert.equal(current.deletes.length, 0);
});

// Owner fence (acceptance H1): the undo window belongs to the workspace it was
// opened in. Task ids derive from the title, so a delete deferred in one
// account must never be sent after another account took the page over.
function switchWorkspaceOwner(current) {
  Object.assign(current.state, { user: null, localOwnerId: "another-workspace-owner" });
  assert.notEqual(current.use.captureAccountContext().ownerId, current.ownerId);
}

test("a delete deferred before an account switch is dropped, never sent to the other account", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  const [alpha] = current.state.tasks;
  deleteRow(current, alpha);
  switchWorkspaceOwner(current);
  assert.equal(await current.view.flushTaskDeletion(), false);
  assert.equal(current.deletes.length, 0, "nothing is deleted in the other account");
  assert.equal(storedMarkers(current.host.localStorage), null);
});

test("the undo toast closes when the workspace owner changes under it", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  const [alpha] = current.state.tasks;
  deleteRow(current, alpha);
  assert.equal(current.elements.undoToast.hidden, false);
  switchWorkspaceOwner(current);
  current.view.renderTasks();
  assert.equal(current.elements.undoToast.hidden, true);
  assert.equal(storedMarkers(current.host.localStorage), null);
  assert.equal(await current.view.flushTaskDeletion(), false);
  assert.equal(current.deletes.length, 0);
  assert.ok(rowFor(current.elements, alpha.id), "the row of the new workspace is not hidden by the old window");
});

test("a replay while this page's undo window is open leaves the window alone", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  const [alpha] = current.state.tasks;
  deleteRow(current, alpha);
  assert.equal(await current.use.replayPendingTaskDeletions(), 0);
  assert.equal(current.deletes.length, 0, "Undo is still possible");
  assert.deepEqual(storedMarkers(current.host.localStorage), [markerFor(current, alpha)]);
  current.elements.undoToastUndo.click();
  assert.deepEqual(current.state.tasks.map((task) => task.title), ["Alpha"]);
});

// bc2r3 M-1: a tab switch inside the undo window flushes the delete while the
// page is hidden. When the save fails, the person is told and the row comes
// back, so the marker is cleared: the next foreground must not delete the task.
test("a delete that fails while the page is hidden clears its marker, and the next foreground deletes nothing", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  const [alpha] = current.state.tasks;
  const persistWorkspaceIntent = current.use.persistWorkspaceIntent;
  current.use.persistWorkspaceIntent = async () => {
    current.use.persistWorkspaceIntent = persistWorkspaceIntent;
    throw new Error("transaction aborted");
  };
  deleteRow(current, alpha);
  setVisibility(current.document, "hidden");
  await waitFor(() => current.deletes.length === 1, "the hidden flush");
  assert.equal(await current.deletes[0].result, false);
  await settle();
  assert.equal(storedMarkers(current.host.localStorage), null, "the failure was shown, so nothing stays owed");
  assert.deepEqual(current.calls.filter(([kind]) => kind === "notice").map(([, message]) => message), [DELETE_REFUSED]);
  assert.ok(rowFor(current.elements, alpha.id), "the row is back");
  setVisibility(current.document, "visible");
  await settle(20);
  assert.equal(current.deletes.length, 1, "the foreground sent no second delete");
  await current.use.reloadPersistedState();
  assert.deepEqual(current.state.tasks.map((task) => task.title), ["Alpha"]);
});

test("sign-out waits for the pending delete, so it is counted with the unsynced changes", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  const [alpha] = current.state.tasks;
  const order = [];
  const gate = deferred();
  current.use.deleteTask = async (task) => { order.push(`delete ${task.id}`); await gate.promise; return true; };
  current.use.logout = () => order.push("logout");
  current.view.setupAccountEvents();
  deleteRow(current, alpha);
  current.elements.logoutButton.click();
  await settle();
  assert.deepEqual(order, [`delete ${alpha.id}`], "sign-out has not started while the delete is being saved");
  gate.resolve();
  await settle();
  assert.deepEqual(order, [`delete ${alpha.id}`, "logout"]);
  assert.equal(current.elements.undoToast.hidden, true);
});

test("sign-out also waits for a delete that Dismiss already started", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  const order = [];
  const gate = deferred();
  current.use.deleteTask = async () => { order.push("delete"); await gate.promise; order.push("deleted"); return true; };
  current.use.logout = () => order.push("logout");
  current.view.setupAccountEvents();
  deleteRow(current, current.state.tasks[0]);
  current.elements.undoToastDismiss.click();
  current.elements.logoutButton.click();
  await settle();
  assert.deepEqual(order, ["delete"]);
  gate.resolve();
  await settle();
  assert.deepEqual(order, ["delete", "deleted", "logout"]);
});

test("opening account deletion completes the pending delete first, and a failed delete does not hold it back", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  const order = [];
  current.use.deleteTask = async () => { order.push("delete"); return false; };
  current.use.deleteAccount = (confirmation) => order.push(["deleteAccount", typeof confirmation]);
  current.view.setupAccountEvents();
  deleteRow(current, current.state.tasks[0]);
  current.elements.deleteAccountButton.click();
  await settle();
  assert.deepEqual(order, ["delete", ["deleteAccount", "undefined"]]);
});

// R54 acceptance F6: the delete already told the person how it ended, so a
// delete that rejects is reported once and never rejects the account action.
test("a delete that rejects before sign-out is reported, sign-out still runs, and no rejection goes unhandled", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  const order = [];
  const reports = [];
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const previous = globalThis.PomodoroughSentryClient;
  globalThis.PomodoroughSentryClient = { reportFrontendError: (error, operation) => reports.push([error.message, operation]) };
  t.after(() => { globalThis.PomodoroughSentryClient = previous; });
  current.host.console = { ...console, warn: () => {} };
  current.use.deleteTask = async () => { order.push("delete"); throw new Error("delete rejected"); };
  current.use.logout = () => order.push("logout");
  current.view.setupAccountEvents();
  deleteRow(current, current.state.tasks[0]);
  current.elements.logoutButton.click();
  await settle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["delete", "logout"]);
  assert.deepEqual(reports, [["delete rejected", "actions.task.save-failed"]]);
  assert.deepEqual(unhandled, []);
});

test("afterTaskDeletion resolves with the account action when the delete rejects", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  current.host.console = { ...console, warn: () => {} };
  current.use.deleteTask = async () => { throw new Error("delete rejected"); };
  deleteRow(current, current.state.tasks[0]);
  assert.equal(await current.view.afterTaskDeletion(() => "signed out"), "signed out");
});

test("sign-out without a pending delete starts at once", async (t) => {
  const current = await withTasks(t, ["Alpha"]);
  const order = [];
  current.use.logout = () => order.push("logout");
  current.view.setupAccountEvents();
  current.elements.logoutButton.click();
  assert.deepEqual(order, ["logout"]);
  assert.equal(current.deletes.length, 0);
});

// The remaining tests start the whole application, so they cover the startup
// hook and the sign-out and account deletion paths end to end.

const APP_TAB = "tab-under-test";

async function openWorkspace(t, options = {}) {
  const current = await openApp(t, { tabId: APP_TAB, historyResolveStatus: 200, ...options });
  await waitForApp(() => !current.state.bootstrapBlocked && !current.state.actionLocked, "the workspace to open");
  return current;
}

function appMarker(current, taskId = "00000000-0000-7000-8000-000000000000") {
  return JSON.stringify([{ taskId, ownerId: current.app.captureAccountContext().ownerId, tabId: APP_TAB }]);
}

async function addTaskInApp(current, title) {
  current.element("taskInput").value = title;
  current.element("taskForm").dispatchEvent(new current.window.Event("submit", { cancelable: true }));
  await waitForApp(() => current.state.tasks.some((task) => task.title === title), `task ${title}`);
  await waitForApp(() => current.state.actionLocked === false, "the add to settle");
  return current.state.tasks.find((task) => task.title === title);
}

test("the task list's Delete button writes the marker in the running application", async (t) => {
  const current = await openWorkspace(t);
  const alpha = await addTaskInApp(current, "Alpha");
  current.document.querySelector(`.task-row[data-task-id="${alpha.id}"] .task-delete`).click();
  assert.equal(current.element("undoToast").hidden, false);
  assert.equal(current.window.localStorage.getItem(MARKER_KEY), appMarker(current, alpha.id));
  current.element("undoToastUndo").click();
  assert.equal(current.window.localStorage.getItem(MARKER_KEY), null);
});

// A real reload with the delete replayed end to end runs in Chromium
// (scripts/ux-round2-browser.test.cjs); here the startup hook itself is pinned.
test("startup replays the markers once the workspace is loaded", async (t) => {
  const indexedDB = new IDBFactory();
  const first = await openWorkspace(t, { indexedDB });
  const reloaded = await openApp(t, { indexedDB, tabId: APP_TAB, historyResolveStatus: 200,
    storage: { [MARKER_KEY]: appMarker(first) } });
  assert.equal(reloaded.state.ready && !reloaded.state.bootstrapBlocked, true, "the reloaded workspace is open");
  await waitForApp(() => reloaded.window.localStorage.getItem(MARKER_KEY) === null, "the startup replay");
  assert.deepEqual(reloaded.control.reports.filter(([, operation]) => operation === "storage.failure"), []);
});

test("sign-out clears the marker", async (t) => {
  const current = await openWorkspace(t);
  current.window.localStorage.setItem(MARKER_KEY, appMarker(current));
  await current.app.logout();
  assert.equal(current.window.localStorage.getItem(MARKER_KEY), null);
});

test("account deletion clears the marker", async (t) => {
  const current = await openWorkspace(t);
  current.window.localStorage.setItem(MARKER_KEY, appMarker(current));
  current.control.accountDeleteStatus = 200;
  assert.equal(await current.app.deleteAccount("DELETE"), true);
  assert.equal(current.window.localStorage.getItem(MARKER_KEY), null);
});

test("a marker that survives to a sign-out recovery startup is dropped with the workspace", async (t) => {
  const indexedDB = new IDBFactory();
  const first = await openWorkspace(t, { indexedDB });
  const storage = { [MARKER_KEY]: appMarker(first), pomodoroughPendingLogout: "1",
    pomodoroughPendingLogoutOwner: JSON.stringify({ userId: first.app.captureAccountContext().ownerId }) };
  const recovering = await openApp(t, { indexedDB, tabId: APP_TAB, storage });
  assert.equal(recovering.window.localStorage.getItem(MARKER_KEY), null);
});

// Acceptance M1: sign-out used to discard a delete that was still inside its
// undo window, so the task came back after the next sign-in. The stub server
// refuses every sync, so the add and the delete both wait to sync; sign-out
// must count both before it asks.
test("sign-out during the undo window completes the delete and counts it before it asks", async (t) => {
  const asked = [];
  const current = await openWorkspace(t, { prepare: (window) => {
    window.confirm = (message) => { asked.push(String(message)); return false; };
  } });
  const alpha = await addTaskInApp(current, "Alpha");
  current.element("logoutButton").click();
  await waitForApp(() => asked.length === 1, "the sign-out question before the delete");
  const waiting = (message) => Number(/^(\d+) changes are waiting to sync\./.exec(message)?.[1]);
  current.document.querySelector(`.task-row[data-task-id="${alpha.id}"] .task-delete`).click();
  current.element("logoutButton").click();
  await waitForApp(() => asked.length === 2, "the sign-out question during the undo window");
  assert.deepEqual(Array.from(current.state.tasks, (task) => task.title), [], "the delete was completed before sign-out decided");
  assert.equal(waiting(asked[1]), waiting(asked[0]) + 1, `${asked[0]} / ${asked[1]}`);
  assert.equal(current.window.localStorage.getItem(MARKER_KEY), null);
  assert.equal(current.element("undoToast").hidden, true);
});
