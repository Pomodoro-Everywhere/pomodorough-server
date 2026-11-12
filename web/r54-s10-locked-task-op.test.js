"use strict";

// R54-S10: a deferred task delete flushed while a sync apply holds the action
// lock must not be dropped. acceptSyncResponse sets state.actionLocked across
// applySyncResponse and reloadPersistedState; the undo flush calls deleteTask
// during that window. The test holds the lock the same way, releases it, and
// then drives any timers the client registered after the flush, so it does not
// depend on how the client waits for the lock.

const test = require("node:test");
const assert = require("node:assert/strict");
const { viewFixture, setVisibility, spy, rowFor } = require("./test/ux-view-fixture.js");

// A 5 s undo timer, where the client has one, is not a lock wait; firing it
// would flush the second delete as well.
const UNDO_MS = 5000;
const PUMP_ROUNDS = 2000;

// Both triggers flush the pending delete on HEAD and on clients whose undo
// window has no time limit.
const TRIGGERS = Object.freeze({
  "page hidden": (current) => setVisibility(current.document, "hidden"),
  "second delete": (current, second) => rowFor(current.elements, second.id).querySelector(".task-delete").click()
});

async function lockedFlush(t, trigger) {
  const current = await viewFixture(t);
  assert.equal(await current.use.addTask("Alpha"), true);
  assert.equal(await current.use.addTask("Beta"), true);
  const alpha = current.state.tasks.find((task) => task.title === "Alpha");
  const beta = current.state.tasks.find((task) => task.title === "Beta");
  const deletes = spy(current.use, "deleteTask", []);
  rowFor(current.elements, alpha.id).querySelector(".task-delete").click();
  assert.equal(deletes.length, 0, "the undo window holds the delete");
  const firstWaitTimer = current.callbacks.length;
  current.state.actionLocked = true;
  TRIGGERS[trigger](current, beta);
  assert.equal(deletes.length, 1, "the flush issues exactly one delete");
  assert.deepEqual(deletes[0].args[0], { id: alpha.id, title: "Alpha" });
  current.state.actionLocked = false;
  const outcome = await settleWithTimers(current, deletes[0].result, firstWaitTimer);
  return { current, alpha, outcome };
}

// The fixture host captures setTimeout callbacks instead of running them.
// Fire each callback registered after the flush once, between macrotasks,
// until the delete settles. Bounded so a dropped delete fails instead of hanging.
async function settleWithTimers(current, result, firstWaitTimer) {
  let outcome = { settled: false };
  result.then((value) => { outcome = { settled: true, value }; },
    (error) => { outcome = { settled: true, error }; });
  let next = firstWaitTimer;
  for (let round = 0; round < PUMP_ROUNDS && !outcome.settled; round += 1) {
    for (; next < current.callbacks.length; next += 1) {
      const timer = current.callbacks[next];
      if (timer.delay !== UNDO_MS) timer.callback();
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return outcome;
}

for (const trigger of Object.keys(TRIGGERS)) {
  test(`R54-S10 delete flushed (${trigger}) while a sync apply holds the action lock is not dropped`, async (t) => {
    const { current, alpha, outcome } = await lockedFlush(t, trigger);
    assert.equal(outcome.settled, true, "delete settles after the lock is released");
    assert.equal(outcome.error, undefined, String(outcome.error?.stack || ""));
    assert.equal(outcome.value, true, "deleteTask resolves true once the lock is released");
    assert.equal(current.state.tasks.some((task) => task.id === alpha.id), false,
      "the deleted task is gone from local state");
    assert.ok(current.state.pendingTaskOperations.some((operation) =>
      operation.type === "delete" && operation.taskId === alpha.id), "a delete operation is queued for sync");
    assert.equal(rowFor(current.elements, alpha.id), null, "the row does not come back");
  });
}
