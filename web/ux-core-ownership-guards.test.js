"use strict";

// UX round 2 (B5, from core-ownership.md): the composer refuses a blank task
// name (PWA-07), the duration stepper keeps to its field's bounds (PWA-03),
// and cancelled or superseded history rows do not read as time spent (PWA-17).

const test = require("node:test");
const assert = require("node:assert/strict");
const { viewFixture, waitFor, spy } = require("./test/ux-view-fixture.js");

async function presentingView(t) {
  const current = await viewFixture(t);
  current.use.showNotice = current.view.showNotice;
  current.view.setupPreferenceEvents();
  return current;
}

function shownNotice(current) {
  const { notice, noticeText } = current.elements;
  return notice.hidden ? null : noticeText.textContent;
}

function stepper(current, name) {
  const input = current.elements.durationInputs.find((item) => item.name === name);
  const [minus, plus] = current.elements.stepButtons.filter((button) => button.dataset.for === input.id)
    .sort((left, right) => Number(left.dataset.step) - Number(right.dataset.step));
  return { input, minus, plus };
}

function showDuration(current, name, minutes) {
  current.state.durationsMs[name] = minutes * 60_000;
  current.view.renderDurations();
}

async function submitTask(current, title) {
  const notices = current.elements.noticeText.textContent;
  const count = current.state.tasks.length;
  current.elements.taskInput.value = title;
  current.elements.taskForm.dispatchEvent(new current.window.Event("submit", { cancelable: true }));
  await waitFor(() => current.state.tasks.length !== count || current.elements.noticeText.textContent !== notices,
    `task ${JSON.stringify(title)} to settle`);
}

test("a blank task name is refused before core sees it, and the draft stays", async (t) => {
  const current = await presentingView(t);
  const identities = spy(current.use, "sharedTaskIdentity", []);
  for (const blank of ["   ", "\t \u00a0"]) {
    current.view.dismissNotice();
    current.elements.taskInput.value = blank;
    current.elements.taskForm.dispatchEvent(new current.window.Event("submit", { cancelable: true }));
    await waitFor(() => shownNotice(current) !== null, `the blank name ${JSON.stringify(blank)} to be answered`);
    assert.equal(shownNotice(current), "Enter a printable task name.");
    assert.equal(current.state.tasks.length, 0);
    assert.equal(current.elements.taskInput.value, blank);
  }
  assert.equal(identities.length, 0);
});

test("a task name with edge spaces is sent as typed, never trimmed", async (t) => {
  const current = await presentingView(t);
  const additions = spy(current.use, "addTask", []);
  await submitTask(current, "  Draft  ");
  assert.deepEqual(additions.map((call) => call.args[0]), ["  Draft  "]);
  assert.deepEqual(current.state.tasks.map((task) => task.title), ["  Draft  "]);
});

test("the minus step is disabled at the field's minimum and the plus step at its maximum", async (t) => {
  const current = await presentingView(t);
  const { minus, plus } = stepper(current, "focus");
  showDuration(current, "focus", 1);
  assert.equal(minus.disabled, true);
  assert.equal(plus.disabled, false);
  showDuration(current, "focus", 180);
  assert.equal(minus.disabled, false);
  assert.equal(plus.disabled, true);
  showDuration(current, "focus", 25);
  assert.equal(minus.disabled, false);
  assert.equal(plus.disabled, false);
});

test("a step at the bound sends nothing, even from a button rendered before the bound", async (t) => {
  const current = await presentingView(t);
  const saves = spy(current.use, "issueDurationOperation", []);
  const { input, minus, plus } = stepper(current, "short_break");
  showDuration(current, "short_break", 1);
  minus.disabled = false;
  minus.click();
  showDuration(current, "short_break", 180);
  plus.disabled = false;
  plus.click();
  assert.equal(saves.length, 0);
  assert.equal(input.value, "180");
});

test("a step from a typed value outside the bounds sends the bound", async (t) => {
  const current = await presentingView(t);
  const saves = spy(current.use, "issueDurationOperation", []);
  const { input, minus } = stepper(current, "long_break");
  input.value = "500";
  minus.click();
  assert.deepEqual(saves.map((call) => call.args), [["long_break", 180 * 60_000]]);
  await saves[0].result;
  assert.equal(current.state.durationsMs.long_break, 180 * 60_000);
});

test("a step button that reaches its bound hands the focus to its field", async (t) => {
  const current = await presentingView(t);
  const { input, minus } = stepper(current, "focus");
  showDuration(current, "focus", 2);
  minus.focus();
  showDuration(current, "focus", 1);
  assert.equal(minus.disabled, true);
  assert.equal(current.document.activeElement, input);
});

function historyRow(status, minutes) {
  return { id: `history-${status}`, timerId: `timer-${status}`, phase: "focus", status,
    plannedDurationMs: minutes * 60_000, completedAt: new Date(Date.UTC(2026, 10, 11, 9)).toISOString(), taskId: null };
}

test("cancelled and superseded history rows label their minutes as planned", async (t) => {
  const current = await presentingView(t);
  current.state.history = [historyRow("completed", 25), historyRow("cancelled", 25), historyRow("superseded", 5)];
  current.view.renderHistory();
  const durations = Object.fromEntries([...current.elements.historyList.querySelectorAll(".history-item")]
    .map((row) => [row.querySelector(".history-status").textContent.replace(" / ", ""),
      row.querySelector(".history-duration").textContent]));
  assert.deepEqual(durations, { Completed: "25 min", Cancelled: "planned 25 min", Superseded: "planned 5 min" });
});

test("an older history row without a status still reads as completed time", async (t) => {
  const current = await presentingView(t);
  const row = historyRow("completed", 25);
  delete row.status;
  current.state.history = [row];
  current.view.renderHistory();
  assert.equal(current.elements.historyList.querySelector(".history-duration").textContent, "25 min");
});
