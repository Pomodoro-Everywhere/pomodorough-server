"use strict";

// UX round 2 (B4): a change made while another change or a synchronization
// holds the action lock waits for the lock instead of being dropped, and a
// delete that the workspace cannot take says so (M2).

const test = require("node:test");
const assert = require("node:assert/strict");
const workspaceFixture = require("./test/p222-completion-fixture.js");

// The fixture's host timer never fires; the lock wait needs one that does.
// Only the short lock wait may run: a timer alarm scheduled for the end of a
// focus phase is unreferenced and cleared, so it never keeps the test alive.
async function lockFixture(t) {
  const fixture = await workspaceFixture.fixture(t);
  const handles = new Set();
  fixture.client.external.host.setTimeout = (callback, delay) => {
    const handle = setTimeout(() => { handles.delete(handle); callback(); }, delay);
    handle.unref();
    handles.add(handle);
    return handle;
  };
  t.after(() => { for (const handle of handles) clearTimeout(handle); });
  return fixture;
}

// Holds the action lock the way a synchronization does, starts the change,
// and shows that the change has not finished before the lock is released.
async function whileLocked(client, change) {
  client.state.actionLocked = true;
  let finished = false;
  const result = change().finally(() => { finished = true; });
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(finished, false, "the change waits for the lock");
  client.state.actionLocked = false;
  return result;
}

test("a duration entry made while a sync holds the lock is saved after it", async (t) => {
  const { client } = await lockFixture(t);
  assert.equal(await whileLocked(client, () => client.use.issueDurationOperation("focus", 1_800_000)), true);
  assert.equal(client.state.pendingDurationOperations.at(-1).durationMs, 1_800_000);
  assert.equal(client.state.actionLocked, false);
  assert.deepEqual(client.notices, []);
});

// Rename goes through the same issueWorkspaceIntent wait as add and delete.
test("a task added while the lock is held is saved after it", async (t) => {
  const { client, core } = await lockFixture(t);
  client.external.sharedCoreHost.SharedCore = { load: async () => core };
  await workspaceFixture.seedMeta(client.use.database(), { canonicalHead: { wallMs: workspaceFixture.nowMs, counter: 2 } });
  assert.equal(await whileLocked(client, () => client.use.addTask("Write report")), true);
  assert.ok(client.state.tasks.some((item) => item.title === "Write report"));
  assert.deepEqual(client.notices, []);
});

test("a phase choice made while the lock is held is saved after it", async (t) => {
  const { client } = await lockFixture(t);
  assert.equal(await whileLocked(client, () => client.use.issuePhaseSelection("short_break")), true);
  assert.equal(client.state.selectedPhase, "short_break");
});

test("Skip pressed while the lock is held skips the shown phase after it", async (t) => {
  const { client } = await lockFixture(t);
  assert.equal(await whileLocked(client, () => client.use.issueSkip()), true);
  assert.equal(client.state.selectedPhase, "short_break");
});

test("a second Skip queued behind the first does not skip again", async (t) => {
  const { client } = await lockFixture(t);
  client.state.actionLocked = true;
  const first = client.use.issueSkip();
  const second = client.use.issueSkip();
  await new Promise((resolve) => setTimeout(resolve, 0));
  client.state.actionLocked = false;
  assert.equal(await first, true);
  assert.equal(await second, false);
  assert.equal(client.state.selectedPhase, "short_break");
  assert.deepEqual(client.notices, []);
});

test("Start pressed while the lock is held starts the timer after it", async (t) => {
  const { client } = await lockFixture(t);
  assert.equal(await whileLocked(client, () => client.use.issueCommand("start")), true);
  assert.equal(client.state.timer.status, "running");
});

test("a second Start queued behind the first changes nothing", async (t) => {
  const { client } = await lockFixture(t);
  client.state.actionLocked = true;
  const first = client.use.issueCommand("start");
  const second = client.use.issueCommand("start");
  await new Promise((resolve) => setTimeout(resolve, 0));
  client.state.actionLocked = false;
  assert.equal(await first, true);
  const timerId = client.state.timer.id;
  assert.equal(await second, false, "core no longer offers Start once the timer runs");
  assert.equal(client.state.timer.id, timerId);
  assert.equal(client.state.timer.status, "running");
  assert.deepEqual(client.notices, []);
});

test("Pause pressed while the lock is held pauses the timer after it", async (t) => {
  const { client } = await lockFixture(t);
  await workspaceFixture.startFocus(client);
  assert.equal(await whileLocked(client, () => client.use.issueCommand("pause")), true);
  assert.equal(client.state.timer.status, "paused");
});

test("Finish pressed while the lock is held finishes the timer after it", async (t) => {
  const { client } = await lockFixture(t);
  await workspaceFixture.startFocus(client);
  assert.equal(await whileLocked(client, () => client.use.finishTimer(false)), true);
  assert.equal(client.state.timer.status, "completed");
});

test("Finish leaves a timer alone that replaced the clicked one during the wait", async (t) => {
  const { client } = await lockFixture(t);
  await workspaceFixture.startFocus(client);
  const clicked = client.state.timer;
  client.state.actionLocked = true;
  const finish = client.use.finishTimer(false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  client.state.timer = { ...clicked, id: "replaced-by-sync" };
  client.state.actionLocked = false;
  assert.equal(await finish, false);
  assert.equal(client.state.timer.id, "replaced-by-sync");
  assert.equal(client.state.timer.status, "running");
});

test("an automatic finish that meets the lock is left to the next completion tick", async (t) => {
  const { client } = await lockFixture(t);
  await workspaceFixture.startFocus(client);
  client.state.actionLocked = true;
  assert.equal(await client.use.finishTimer(true), false);
  client.state.actionLocked = false;
  assert.equal(client.state.timer.status, "running");
});

test("a delete the workspace cannot take tells the person (M2)", async (t) => {
  const { client, core } = await lockFixture(t);
  const task = core.taskIdentity({ title: "Current task" });
  assert.equal(await client.use.issueTaskOperation("upsert", task), true);
  client.state.logoutRecoveryRequired = true;
  assert.equal(await client.use.deleteTask(task), false);
  assert.deepEqual(client.notices, ["Task could not be deleted. Try again."]);
});

test("a delete made while the lock is held is saved after it", async (t) => {
  const { client, core } = await lockFixture(t);
  const task = core.taskIdentity({ title: "Current task" });
  assert.equal(await client.use.issueTaskOperation("upsert", task), true);
  assert.equal(await whileLocked(client, () => client.use.deleteTask(task)), true);
  assert.equal(client.state.tasks.some((item) => item.id === task.id), false);
});

// R54-S10 for rename, bc2r L5: a rename made while the lock is held waits for
// it and is sent once the lock is released. A rename dropped at the lock, or
// sent while the lock is held, fails here. The bundled Core 0.56.0 admits the
// rename (R54-S11), so the renamed task replaces the old one.
test("a rename made while the lock is held is sent after it (R54-S10)", async (t) => {
  const { client, core } = await lockFixture(t);
  const task = core.taskIdentity({ title: "Current task" });
  assert.equal(await client.use.issueTaskOperation("upsert", task), true);
  const sent = [];
  const persist = client.use.persistWorkspaceIntent;
  client.use.persistWorkspaceIntent = (intent, options) => {
    sent.push(intent.kind);
    return persist(intent, options);
  };
  client.state.actionLocked = true;
  const rename = client.use.renameTask(task, "Renamed task");
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sent, [], "the rename waits for the lock");
  client.state.actionLocked = false;
  assert.equal(await rename, true);
  assert.deepEqual(sent, ["renameTask"]);
  const renamed = core.taskIdentity({ title: "Renamed task" });
  assert.deepEqual(client.state.tasks.map((item) => item.id), [renamed.id]);
});

test("an upsert made while the lock is held is saved after it (R54-S10)", async (t) => {
  const { client, core } = await lockFixture(t);
  const task = core.taskIdentity({ title: "Locked upsert" });
  assert.equal(await whileLocked(client, () => client.use.issueTaskOperation("upsert", task)), true);
  assert.ok(client.state.tasks.some((item) => item.id === task.id));
  assert.deepEqual(client.notices, []);
});
