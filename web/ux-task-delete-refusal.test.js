"use strict";

// bc2r M1 and L4 (R54 acceptance of server-batch-bc2).
// M1: a task delete that the workspace refuses, because its controls are
// blocked, clears its marker, releases its undo lock, shows the row again with
// its own notice, and is never sent later: not after history resolution ends,
// not when the task is used, not on a later foreground and not in another tab.
// L4: a delete that rejects is reported once, and no flush caller (pagehide,
// a hidden page, a screen change, Dismiss, a rename) gets a rejected promise.

const test = require("node:test");
const assert = require("node:assert/strict");
const { viewFixture, secondTab, setVisibility, settle, waitFor, spy, rowFor } =
  require("./test/ux-view-fixture.js");

const MARKER_KEY = "pomodoroughPendingTaskDeletions";
const DELETE_REFUSED = "Task could not be deleted. Try again.";

// The fixture's host timer never fires; the action lock wait needs one that
// does. Handles are unreferenced and cleared, so no alarm keeps a test alive.
function fireHostTimers(t, host) {
  const handles = new Set();
  host.setTimeout = (callback, delay) => {
    const handle = setTimeout(() => { handles.delete(handle); callback(); }, delay);
    handle.unref();
    handles.add(handle);
    return handle;
  };
  t.after(() => { for (const handle of handles) clearTimeout(handle); });
}

// Web Locks shared by every tab of one browser profile.
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

function notices(current) {
  return current.calls.filter(([kind]) => kind === "notice").map(([, message]) => message);
}

function storedMarkers(current) {
  const value = current.host.localStorage.getItem(MARKER_KEY);
  return value === null ? null : JSON.parse(value);
}

async function turns(count = 5) {
  for (let turn = 0; turn < count; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

// History resolution blocks the controls the way the bootstrap module does,
// and leaving it clears the same flag and renders.
function enterHistoryResolution(current) {
  current.state.bootstrapBlocked = true;
  current.view.render();
}

function leaveHistoryResolution(current) {
  current.state.bootstrapBlocked = false;
  current.view.render();
}

async function refusalFixture(t) {
  const current = await viewFixture(t);
  fireHostTimers(t, current.host);
  current.locks = fakeLocks();
  current.host.navigator.locks = current.locks;
  assert.equal(await current.use.addTask("Alpha"), true);
  assert.equal(await current.use.addTask("Beta"), true);
  current.deletes = spy(current.use, "deleteTask", []);
  return current;
}

// The three ways a delete reaches blocked controls through the page itself.
const REFUSALS = Object.freeze({
  // Dismiss ends the undo window while history resolution blocks the controls.
  dismissWhileBlocked: async (current) => {
    enterHistoryResolution(current);
    current.elements.undoToastDismiss.click();
  },
  // Dismiss waits behind a synchronization that blocks the controls before it
  // releases the lock.
  dismissAfterWait: async (current) => {
    current.state.actionLocked = true;
    current.elements.undoToastDismiss.click();
    await turns();
    assert.equal(current.deletes.length, 1, "the delete was sent to wait for the lock");
    enterHistoryResolution(current);
    current.state.actionLocked = false;
  },
  // The page is hidden while the controls are blocked; hiding flushes it.
  hiddenWhileBlocked: async (current) => {
    enterHistoryResolution(current);
    setVisibility(current.document, "hidden");
  }
});

async function refuseDelete(current, refusal) {
  const [alpha] = current.state.tasks;
  rowFor(current.elements, alpha.id).querySelector(".task-delete").click();
  assert.equal(storedMarkers(current).length, 1);
  assert.equal(rowFor(current.elements, alpha.id), null, "the row left the list");
  const before = notices(current).length;
  await REFUSALS[refusal](current);
  await waitFor(() => current.deletes.length === 1 && notices(current).length > before, "the refusal");
  await current.deletes[0].result;
  await settle();
  assert.equal(await current.deletes[0].result, false);
  assert.equal(storedMarkers(current), null, "the marker is cleared");
  assert.deepEqual([...current.locks.held], [], "no undo lock is left for another tab");
  assert.deepEqual(notices(current).slice(before), [DELETE_REFUSED]);
  assert.ok(rowFor(current.elements, alpha.id), "the row is shown again");
  return alpha;
}

async function startFocusOn(current, task) {
  assert.equal(await current.use.issueSelectedTaskOperation(task.id), true);
  assert.equal(await current.use.issueCommand("start"), true);
  assert.equal(current.state.timer?.status, "running");
}

async function renameBeta(current) {
  const beta = current.state.tasks.find((task) => task.title === "Beta");
  rowFor(current.elements, beta.id).querySelector(".task-rename").click();
  const input = rowFor(current.elements, beta.id).querySelector(".task-rename-input");
  input.value = "Gamma";
  input.dispatchEvent(new current.window.Event("input", { bubbles: true }));
  input.dispatchEvent(new current.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await waitFor(() => current.state.tasks.some((task) => task.title === "Gamma"), "the bundled Core applying the rename");
  await settle(20);
  assert.equal(current.state.tasks.some((task) => task.id === beta.id), false, "the rename moved Beta to a new ID");
}

const USES = Object.freeze({
  startFocus: (current, alpha) => startFocusOn(current, alpha),
  rename: (current) => renameBeta(current)
});

async function foreground(document) {
  setVisibility(document, "hidden");
  setVisibility(document, "visible");
  await settle(20);
}

for (const refusal of Object.keys(REFUSALS)) {
  for (const use of Object.keys(USES)) {
    test(`a refused delete is never sent later: ${refusal}, then ${use}, foreground and another tab`, async (t) => {
      const current = await refusalFixture(t);
      const alpha = await refuseDelete(current, refusal);
      leaveHistoryResolution(current);
      await USES[use](current, alpha);
      await foreground(current.document);
      const other = await secondTab(t, current);
      await foreground(other.document);
      await current.use.reloadPersistedState();
      await other.use.reloadPersistedState();
      assert.equal(current.deletes.length, 1, "the refused delete is the only one");
      for (const tab of [current, other]) {
        assert.ok(tab.state.tasks.some((task) => task.id === alpha.id), "the task survives");
      }
      assert.equal(storedMarkers(current), null);
    });
  }
}

// Positive control for the cases above: the second tab's foreground is a live
// replay trigger. A page that died inside its undo window is the one way a
// marker is left behind; it is written here under that closed tab's id. The
// closed tab holds no undo lock, so tab B's foreground claims the marker and
// completes the delete.
test("another tab's foreground completes a delete that a closed tab left behind", async (t) => {
  const current = await refusalFixture(t);
  const [alpha] = current.state.tasks;
  const marker = { taskId: alpha.id, ownerId: current.use.captureAccountContext().ownerId, tabId: "tab-closed" };
  current.host.localStorage.setItem(MARKER_KEY, JSON.stringify([marker]));
  const other = await secondTab(t, current);
  assert.notEqual(other.use.tabId(), marker.tabId);
  assert.ok(other.state.tasks.some((task) => task.id === alpha.id));
  await foreground(other.document);
  await waitFor(() => !other.state.tasks.some((task) => task.id === alpha.id), "the other tab's replay");
  await settle();
  assert.equal(storedMarkers(current), null);
  assert.deepEqual([...current.locks.held], []);
  await current.use.reloadPersistedState();
  assert.equal(current.state.tasks.some((task) => task.id === alpha.id), false);
});

// bc2r3 M-1: the real tab-switch path. The delete fails while the page is
// hidden, so the person is told and the row comes back. The deleted task is
// then used in tab B. After tab B and tab A come to the foreground, and after a
// tab A's page is gone and a new tab starts up, no tab has sent another delete
// and the task survives. The new tab replays markers with the same call app.js
// makes once bootstrap is done (app.js `resumeStorageAndSession`). That call
// is not awaited there, so it is not awaited here either; the positive control
// for that call is "startup replay deletes the marked task" in
// ux-task-deletion-marker.test.js.
async function failDeleteOnTabSwitch(current, task) {
  const persistWorkspaceIntent = current.use.persistWorkspaceIntent;
  current.use.persistWorkspaceIntent = async () => {
    current.use.persistWorkspaceIntent = persistWorkspaceIntent;
    throw new Error("transaction aborted");
  };
  rowFor(current.elements, task.id).querySelector(".task-delete").click();
  setVisibility(current.document, "hidden");
  await waitFor(() => current.deletes.length === 1, "the hidden flush");
  assert.equal(await current.deletes[0].result, false);
  await settle();
  assert.equal(storedMarkers(current), null, "the marker is cleared");
  assert.deepEqual(notices(current), [DELETE_REFUSED]);
  assert.ok(rowFor(current.elements, task.id), "the row is back");
}

// The bundled Core moves a renamed task to the ID of its new title. A marker
// owed for the old ID would no longer find it, so this leg checks that no tab
// sends a delete and that the task survives under its new ID.
async function renameIn(tab, task) {
  const renames = spy(tab.use, "renameTask", []);
  rowFor(tab.elements, task.id).querySelector(".task-rename").click();
  const input = rowFor(tab.elements, task.id).querySelector(".task-rename-input");
  input.value = "Alpha renamed";
  input.dispatchEvent(new tab.window.Event("input", { bubbles: true }));
  input.dispatchEvent(new tab.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await waitFor(() => renames.length === 1, "tab B sending the rename");
  assert.deepEqual(renames.map((call) => call.args[0].id), [task.id], "tab B sent the rename");
  assert.equal(await renames[0].result, true, "the bundled Core applied the rename");
  return tab.state.tasks.find((candidate) => candidate.title === "Alpha renamed");
}

const SECOND_TAB_USES = Object.freeze({
  startFocus: async (tab, task) => {
    await startFocusOn(tab, task);
    return { survivor: task, stillInUse: (other) => assert.equal(other.state.timer?.status, "running") };
  },
  rename: async (tab, task) => {
    const renamed = await renameIn(tab, task);
    assert.notEqual(renamed.id, task.id);
    return { survivor: renamed, stillInUse: () => {} };
  }
});

// The page is gone: it hides, fires pagehide and its window closes.
function closeTab(tab) {
  setVisibility(tab.document, "hidden");
  tab.window.dispatchEvent(new tab.window.Event("pagehide"));
  tab.window.close();
}

for (const use of Object.keys(SECOND_TAB_USES)) {
  test(`a delete that failed on a tab switch is never sent later: ${use} in tab B, foregrounds and startup`, async (t) => {
    const current = await refusalFixture(t);
    const [alpha] = current.state.tasks;
    await failDeleteOnTabSwitch(current, alpha);
    const other = await secondTab(t, current);
    other.deletes = spy(other.use, "deleteTask", []);
    const { survivor, stillInUse } = await SECOND_TAB_USES[use](other, alpha);
    await foreground(other.document);
    setVisibility(current.document, "visible");
    await settle(20);
    closeTab(current);
    await settle(20);
    const started = await secondTab(t, current, "tab-started");
    started.deletes = spy(started.use, "deleteTask", []);
    const replay = spy(started.use, "replayPendingTaskDeletions", []);
    started.use.replayPendingTaskDeletions();
    assert.equal(await replay[0].result, 0, "startup finds nothing owed");
    await settle(20);
    assert.equal(current.deletes.length, 1, "the failed delete is the only one");
    assert.deepEqual([...other.deletes, ...started.deletes], [], "no other tab sent a delete");
    for (const tab of [other, started]) {
      await tab.use.reloadPersistedState();
      assert.ok(tab.state.tasks.some((task) => task.id === survivor.id), "the task survives");
    }
    stillInUse(other);
  });
}

// L4: every flush caller gets a promise that resolves, even when the delete
// itself rejects. The rejection is reported once and the row comes back.
const FLUSH_CALLERS = Object.freeze({
  pagehide: (current) => current.window.dispatchEvent(new current.window.Event("pagehide")),
  hidden: (current) => setVisibility(current.document, "hidden"),
  screenChange: (current) => current.document.querySelector("[data-screen-button='timer']").click(),
  dismiss: (current) => current.elements.undoToastDismiss.click()
});

function rejectingDeletes(t, current) {
  const reports = [];
  const previous = globalThis.PomodoroughSentryClient;
  globalThis.PomodoroughSentryClient = { reportFrontendError: (error, operation) => reports.push([error.message, operation]) };
  t.after(() => { globalThis.PomodoroughSentryClient = previous; });
  const rejections = [];
  const onRejection = (error) => rejections.push(error);
  process.on("unhandledRejection", onRejection);
  t.after(() => process.off("unhandledRejection", onRejection));
  current.use.deleteTask = async () => { throw new Error("delete rejected"); };
  return { reports, rejections };
}

for (const [caller, flush] of Object.entries(FLUSH_CALLERS)) {
  test(`a rejected delete is reported once and never rejects its flush caller: ${caller}`, async (t) => {
    const current = await refusalFixture(t);
    const { reports, rejections } = rejectingDeletes(t, current);
    const [alpha] = current.state.tasks;
    rowFor(current.elements, alpha.id).querySelector(".task-delete").click();
    flush(current);
    await settle(20);
    assert.equal(await current.view.flushTaskDeletion(), false, "a later flush resolves too");
    await settle(20);
    assert.deepEqual(reports, [["delete rejected", "actions.task.save-failed"]]);
    assert.deepEqual(rejections, []);
    // The view shows this notice through its own presenter.
    assert.equal(current.elements.notice.hidden, false);
    assert.equal(current.elements.noticeText.textContent, DELETE_REFUSED);
    assert.ok(current.state.tasks.some((task) => task.id === alpha.id));
  });
}

test("a rejected delete does not stop a rename that flushes it", async (t) => {
  const current = await refusalFixture(t);
  const { reports, rejections } = rejectingDeletes(t, current);
  const renames = spy(current.use, "renameTask", []);
  const [alpha, beta] = current.state.tasks;
  rowFor(current.elements, alpha.id).querySelector(".task-delete").click();
  await renameBeta(current);
  await settle(20);
  assert.deepEqual(renames.map(({ args }) => [args[0].id, args[1]]), [[beta.id, "Gamma"]]);
  assert.deepEqual(reports, [["delete rejected", "actions.task.save-failed"]]);
  assert.deepEqual(rejections, []);
});
