"use strict";

// R54 acceptance of UX round 2 batches B and C.
// F2: a change that waited for the action lock and finds the controls blocked
// when the lock is released says it was not saved. A delete clears its marker
// and is never sent later (bc2r M1, which replaced the earlier rule that kept
// the marker for the next ready start).
// F5: a timer command whose fresh read model fails no longer applies; the
// failure is reported and the workspace observation is left alone.

const test = require("node:test");
const assert = require("node:assert/strict");
const workspaceFixture = require("./test/p222-completion-fixture.js");
const { viewFixture, settle, rowFor } = require("./test/ux-view-fixture.js");

const MARKER_KEY = "pomodoroughPendingTaskDeletions";
const TASK_FAILED = "Task change could not be saved. Try again.";
const TIMER_FAILED = "Timer action could not be saved. Try again.";
const DELETE_REFUSED = "Task could not be deleted. Try again.";

// The fixtures' host timer never fires; the lock wait needs one that does.
// Handles are unreferenced and cleared, so a scheduled alarm never keeps the
// test alive.
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

async function lockFixture(t) {
  const fixture = await workspaceFixture.fixture(t);
  fireHostTimers(t, fixture.client.external.host);
  return fixture;
}

// The two ways a synchronization that holds the lock blocks the controls:
// sign-out recovery and history resolution.
const BLOCKS = Object.freeze({
  signOutRecovery: (state) => { state.logoutRecoveryRequired = true; },
  historyResolution: (state) => { state.bootstrapBlocked = true; }
});

// Holds the lock the way a synchronization does, starts the change, and has
// the synchronization block the controls before it releases the lock.
async function blockedDuringWait(state, change, block = BLOCKS.signOutRecovery) {
  state.actionLocked = true;
  let finished = false;
  const result = Promise.resolve(change()).finally(() => { finished = true; });
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(finished, false, "the change waits for the lock");
  block(state);
  state.actionLocked = false;
  return result;
}

function recordPersistedIntents(client) {
  const persisted = [];
  const persist = client.use.persistWorkspaceIntent;
  client.use.persistWorkspaceIntent = (intent, options) => {
    persisted.push(intent.kind);
    return persist(intent, options);
  };
  return persisted;
}

test("a task added while the lock is held and the controls then block says it was not saved", async (t) => {
  const { client, core } = await lockFixture(t);
  client.external.sharedCoreHost.SharedCore = { load: async () => core };
  await workspaceFixture.seedMeta(client.use.database(), { canonicalHead: { wallMs: workspaceFixture.nowMs, counter: 2 } });
  const persisted = recordPersistedIntents(client);
  assert.equal(await blockedDuringWait(client.state, () => client.use.addTask("Write report")), false);
  assert.deepEqual(client.notices, [TASK_FAILED]);
  assert.deepEqual(persisted, []);
  assert.equal(client.state.tasks.some((item) => item.title === "Write report"), false);
});

test("a rename that waited and met blocked controls says it was not saved", async (t) => {
  const { client, core } = await lockFixture(t);
  const task = core.taskIdentity({ title: "Current task" });
  assert.equal(await client.use.issueTaskOperation("upsert", task), true);
  const persisted = recordPersistedIntents(client);
  assert.equal(await blockedDuringWait(client.state, () => client.use.renameTask(task, "Renamed task")), false);
  assert.deepEqual(client.notices, [TASK_FAILED]);
  assert.deepEqual(persisted, []);
  assert.deepEqual(client.state.tasks.map((item) => item.title), ["Current task"]);
});

test("a duration entry that waited and met blocked controls says it was not saved", async (t) => {
  const { client } = await lockFixture(t);
  const before = client.state.pendingDurationOperations.length;
  assert.equal(await blockedDuringWait(client.state, () => client.use.issueDurationOperation("focus", 1_800_000)), false);
  assert.deepEqual(client.notices, ["Duration change could not be saved. Try again."]);
  assert.equal(client.state.pendingDurationOperations.length, before);
});

test("Start that waited and met history resolution shows the timer notice", async (t) => {
  const { client } = await lockFixture(t);
  assert.equal(await blockedDuringWait(client.state, () => client.use.issueCommand("start"), BLOCKS.historyResolution), false);
  assert.deepEqual(client.notices, [TIMER_FAILED]);
  assert.notEqual(client.state.timer?.status, "running");
});

test("Finish that waited and met blocked controls shows the timer notice", async (t) => {
  const { client } = await lockFixture(t);
  await workspaceFixture.startFocus(client);
  assert.equal(await blockedDuringWait(client.state, () => client.use.finishTimer(false)), false);
  assert.deepEqual(client.notices, [TIMER_FAILED]);
  assert.equal(client.state.timer.status, "running");
});

// bc2r L1: the auto-start and task-choice changes wait for the lock inside
// issueWorkspaceIntent like every other change, so a refusal after the wait
// shows their own notice instead of being dropped without one.
test("auto-start and task choice that waited and met blocked controls say they were not saved", async (t) => {
  const { client, core } = await lockFixture(t);
  const task = core.taskIdentity({ title: "Current task" });
  assert.equal(await client.use.issueTaskOperation("upsert", task), true);
  const persisted = recordPersistedIntents(client);
  const enabled = !client.state.autoStartBreaks;
  assert.equal(await blockedDuringWait(client.state, () => client.use.issueAutoStartOperation(enabled)), false);
  client.state.logoutRecoveryRequired = false;
  assert.equal(await blockedDuringWait(client.state, () => client.use.issueSelectedTaskOperation(task.id),
    BLOCKS.historyResolution), false);
  assert.deepEqual(client.notices, ["Auto-start preference could not be saved. Try again.",
    "Task choice could not be saved. Try again."]);
  assert.deepEqual(persisted, []);
});

test("a change that did not wait for the lock stays silent on blocked controls", async (t) => {
  const { client } = await lockFixture(t);
  client.state.logoutRecoveryRequired = true;
  assert.equal(await client.use.issueCommand("start"), false);
  assert.equal(await client.use.issueDurationOperation("focus", 1_800_000), false);
  assert.deepEqual(client.notices, [], "the disabled controls already explain the refusal");
});

function notices(current) {
  return current.calls.filter(([kind]) => kind === "notice").map(([, message]) => message);
}

function storedMarkerIds(current) {
  const value = current.host.localStorage.getItem(MARKER_KEY);
  return value === null ? null : JSON.parse(value).map((record) => record.taskId);
}

test("a delete that waited and met blocked controls says so, clears its marker and is not sent later", async (t) => {
  const current = await viewFixture(t);
  fireHostTimers(t, current.host);
  assert.equal(await current.use.addTask("Alpha"), true);
  const [alpha] = current.state.tasks;
  rowFor(current.elements, alpha.id).querySelector(".task-delete").click();
  const before = notices(current).length;
  const flushed = blockedDuringWait(current.state, () => current.view.flushTaskDeletion(), BLOCKS.historyResolution);
  assert.equal(await flushed, false);
  assert.deepEqual(notices(current).slice(before), [DELETE_REFUSED]);
  assert.equal(storedMarkerIds(current), null, "the refused delete is not owed");
  assert.ok(rowFor(current.elements, alpha.id), "the row is shown again");
  current.state.bootstrapBlocked = false;
  assert.equal(await current.use.replayPendingTaskDeletions(), 0);
  await settle();
  assert.deepEqual(current.state.tasks.map((task) => task.title), ["Alpha"]);
});

test("a timer command whose read model fails after the wait is dropped and reported (F5)", async (t) => {
  const { client } = await lockFixture(t);
  const reports = [];
  const previous = globalThis.PomodoroughSentryClient;
  globalThis.PomodoroughSentryClient = { reportFrontendError: (error, operation) => reports.push([error.message, operation]) };
  t.after(() => { globalThis.PomodoroughSentryClient = previous; });
  const warnings = [];
  client.external.host.console = { ...console, warn: (...args) => warnings.push(args) };
  const observation = { marker: "before the check" };
  client.state.actionLocked = true;
  const start = client.use.issueCommand("start");
  await new Promise((resolve) => setTimeout(resolve, 0));
  client.state.workspaceObservation = observation;
  client.use.getWorkspaceReadModel = () => {
    client.state.workspaceObservation = { marker: "advanced by the failed read" };
    throw new Error("projection invalid");
  };
  client.state.actionLocked = false;
  assert.equal(await start, false, "the click handler's promise resolves");
  assert.equal(client.state.workspaceObservation, observation);
  assert.deepEqual(reports, [["projection invalid", "actions.timer.save-failed"]]);
  assert.equal(warnings.length, 1);
  assert.deepEqual(client.notices, [TIMER_FAILED], "bc2r L3: the dropped command says it was not saved");
  assert.notEqual(client.state.timer?.status, "running");
});
