"use strict";

// UX round 2 batch C: history rows and totals show the time a run really took
// (Core's elapsedMs), the read model is checked for schema version 2, and a
// timer finished early is shown as ended.

const test = require("node:test");
const assert = require("node:assert/strict");
const { viewFixture, rowFor } = require("./test/ux-view-fixture.js");
const { storage, sync, loadCore, seedMeta, dump, nowMs } = require("./test/account-ownership-fixture.js");

const SEVEN_MINUTES_MS = 7 * 60_000;
const PLANNED_MS = 25 * 60_000;

async function storedSnapshot(current) {
  return (await dump(current.use.database())).meta.find((record) => record.key === "snapshot").value;
}

async function seedSnapshot(current, fields) {
  await seedMeta(current.use.database(), { snapshot: { ...await storedSnapshot(current), ...fields } });
  await current.use.reloadPersistedState();
  current.view.render();
}

function setNow(t, current, atMs) {
  t.mock.timers.setTime(atMs);
  current.use.trustedNow = () => atMs;
}

async function finishedEarly(t) {
  const current = await viewFixture(t);
  // Without an automatic break the finished focus run stays on the dial.
  await seedSnapshot(current, { autoStartBreaks: false });
  assert.equal(await current.use.addTask("Alpha"), true);
  const taskId = current.state.tasks[0].id;
  assert.equal(current.state.selectedTaskId, taskId);
  assert.equal(await current.use.issueCommand("start", { phase: "focus" }), true);
  setNow(t, current, nowMs + SEVEN_MINUTES_MS);
  assert.equal(await current.use.finishTimer(false), true);
  current.view.render();
  return { current, taskId };
}

function historyRows(current) {
  return [...current.elements.historyList.querySelectorAll(".history-item")];
}

function historyRowText(row) {
  return {
    status: row.querySelector(".history-status")?.textContent ?? row.textContent,
    duration: row.querySelector(".history-duration").textContent
  };
}

test("an early Finish shows its real time in the history row and the task total", async (t) => {
  const { current, taskId } = await finishedEarly(t);
  const row = current.state.history.find((item) => item.status === "completed");
  assert.equal(row.elapsedMs, SEVEN_MINUTES_MS);
  assert.equal(row.plannedDurationMs, PLANNED_MS);

  const rendered = historyRows(current);
  assert.equal(rendered.length, 1);
  assert.equal(historyRowText(rendered[0]).duration, "7 min");
  assert.match(rendered[0].textContent, /Finished early/);
  assert.doesNotMatch(rendered[0].textContent, /25 min/);

  const model = current.use.getWorkspaceReadModel();
  assert.equal(model.cadence.completedFocusToday, 1);
  assert.equal(model.cadence.completedFocusTodayElapsedMs, SEVEN_MINUTES_MS);
  assert.deepEqual(model.tasks.completedFocusTodayByTask[taskId], { count: 1, elapsedMs: SEVEN_MINUTES_MS });
  const stats = [...rowFor(current.elements, taskId).querySelectorAll(".task-stat")];
  assert.deepEqual(stats.map((cell) => cell.textContent), ["1", "7 min"]);
  assert.equal(stats[1].getAttribute("aria-label"), "7 min spent today");
});


// Runs one focus session for the selected task and finishes it after
// `minutes`, so Core records that many minutes as the run's elapsedMs. A
// one-minute break follows, so the next start is a focus run again.
async function focusRunFor(t, current, startMs, minutes) {
  let at = startMs;
  for (const [phase, length] of [["focus", minutes], ["short_break", 1]]) {
    setNow(t, current, at);
    assert.equal(await current.use.issueCommand("start", { phase }), true);
    assert.equal(current.state.timer.phase, phase);
    at += length * 60_000;
    setNow(t, current, at);
    assert.equal(await current.use.finishTimer(false), true);
  }
  return at + 60_000;
}

function taskStats(current, taskId) {
  return [...rowFor(current.elements, taskId).querySelectorAll(".task-stat")].map((cell) => cell.textContent);
}

test("the Tasks screen shows each task's real time today from Core's elapsedMs", async (t) => {
  const current = await viewFixture(t);
  await seedSnapshot(current, { autoStartBreaks: false });
  assert.equal(await current.use.addTask("Alpha"), true);
  const alpha = current.state.tasks.find((task) => task.title === "Alpha").id;
  let at = await focusRunFor(t, current, nowMs, 7);
  at = await focusRunFor(t, current, at, 4);
  assert.equal(await current.use.addTask("Beta"), true);
  const beta = current.state.tasks.find((task) => task.title === "Beta").id;
  assert.equal(current.state.selectedTaskId, beta, "adding a task selects it");
  await focusRunFor(t, current, at, 12);
  assert.equal(await current.use.addTask("Gamma"), true);
  const gamma = current.state.tasks.find((task) => task.title === "Gamma").id;
  current.view.render();

  // The read model since Core 0.55.0: schema version 2, and every task has a row that
  // holds only the count and the summed elapsedMs. A row has no planned length
  // to fall back on, and the breaks between runs are not counted.
  const model = current.use.getWorkspaceReadModel();
  assert.equal(model.schemaVersion, 2);
  assert.deepEqual(model.tasks.completedFocusTodayByTask, {
    [alpha]: { count: 2, elapsedMs: 11 * 60_000 },
    [beta]: { count: 1, elapsedMs: 12 * 60_000 },
    [gamma]: { count: 0, elapsedMs: 0 }
  });
  assert.deepEqual(taskStats(current, alpha), ["2", "11 min"]);
  assert.deepEqual(taskStats(current, beta), ["1", "12 min"]);
  assert.deepEqual(taskStats(current, gamma), ["0", "0 min"]);
});


function legacyRow(id, elapsed) {
  const completedAt = new Date(nowMs - 60_000).toISOString();
  const row = { id, timerId: id, phase: "focus", status: "completed", plannedDurationMs: PLANNED_MS,
    completedAt, endedAt: completedAt };
  return elapsed === undefined ? row : { ...row, elapsedMs: elapsed };
}

for (const [name, elapsed] of [["without the field", undefined], ["with an explicit null", null]]) {
  test(`a history row ${name} loads, counts through Core, and gets no default written back`, async (t) => {
    const current = await viewFixture(t);
    await seedSnapshot(current, { history: [legacyRow("legacy-row", elapsed)] });
    assert.equal(current.state.workspaceBlocked, false);
    assert.equal(current.state.history.length, 1);
    // The shown history is Core's projection, and Core applies its rule for
    // an old completed row: the plan. The client adds nothing of its own.
    assert.equal(current.state.history[0].elapsedMs, PLANNED_MS);

    const rendered = historyRows(current);
    assert.equal(rendered.length, 1);
    assert.equal(historyRowText(rendered[0]).duration, "25 min");
    assert.match(rendered[0].textContent, /Completed/);
    assert.equal(current.use.getWorkspaceReadModel().cadence.completedFocusTodayElapsedMs, PLANNED_MS);

    assert.equal(await current.use.issueCommand("start", { phase: "focus" }), true);
    const stored = await storedSnapshot(current);
    assert.equal(stored.history[0].elapsedMs ?? null, null, "storage keeps the row without a default");
  });
}

function bootstrapPayload(history) {
  const serverTime = new Date(nowMs).toISOString();
  return {
    revision: 1, canonicalTimer: null, history, tasks: [], selectedTaskId: null, autoStartBreaks: false,
    durationsMs: { focus: PLANNED_MS, short_break: 300_000, long_break: 900_000 },
    serverTime, serverHlcWallMs: nowMs, serverHlcCounter: 0, acknowledgements: []
  };
}

test("server history accepts elapsedMs inside the plan and fails closed outside it", () => {
  for (const elapsed of [undefined, null, 0, SEVEN_MINUTES_MS, PLANNED_MS]) {
    assert.doesNotThrow(() => sync.validateCanonicalResponse(bootstrapPayload([legacyRow("row", elapsed)]), {}),
      `elapsedMs ${elapsed} must load`);
  }
  for (const elapsed of [-1, PLANNED_MS + 1, 1.5, "420000", Number.MAX_SAFE_INTEGER + 2, {}]) {
    assert.throws(() => sync.validateCanonicalResponse(bootstrapPayload([legacyRow("row", elapsed)]), {}),
      /Bootstrap response returned invalid history\./, `elapsedMs ${String(elapsed)} must fail closed`);
  }
});

test("a read model whose schemaVersion is not 2 fails closed", async (t) => {
  const current = await viewFixture(t);
  const { core } = await loadCore();
  assert.equal(current.use.getWorkspaceReadModel().schemaVersion, 2);
  const before = current.state.readModel;
  for (const version of [1, 3, "2", null, undefined]) {
    const stub = Object.create(core);
    stub.call = (operation, input) => {
      const result = core.call(operation, input);
      if (operation !== "workspace.readModel.v1") return result;
      const changed = { ...result, schemaVersion: version };
      if (version === undefined) delete changed.schemaVersion;
      return changed;
    };
    storage.setSharedCore(stub);
    try {
      assert.throws(() => current.use.getWorkspaceReadModel(), /read-model schema version/, `version ${version}`);
      assert.equal(current.state.readModel, before, "a rejected read model never replaces the last good one");
    } finally {
      storage.setSharedCore(core);
    }
  }
});

test("a timer finished early is shown as ended, with no countdown and no time left", async (t) => {
  const { current } = await finishedEarly(t);
  const model = current.use.getWorkspaceReadModel();
  // The Core view this item is about: completed, yet time remains on the plan.
  assert.equal(model.canonical.status, "completed");
  assert.ok(model.canonical.remainingMs > 0, "Core reports remaining time on the finished timer");
  assert.ok(model.canonical.progress < 1, "Core reports progress below 1 on the finished timer");

  current.view.renderTimer();
  const { timerDisplay, dial } = current.elements;
  assert.equal(dial.dataset.status, "completed");
  assert.doesNotMatch(timerDisplay.getAttribute("aria-label"), /remaining/i);
  assert.match(timerDisplay.getAttribute("aria-label"), /Completed/);
  assert.equal(current.document.title.includes(timerDisplay.textContent), false, "no clock in the tab title");
  const clock = timerDisplay.textContent;
  setNow(t, current, nowMs + SEVEN_MINUTES_MS + 90_000);
  current.view.renderTimer();
  assert.equal(timerDisplay.textContent, clock, "the clock does not count down");
});
