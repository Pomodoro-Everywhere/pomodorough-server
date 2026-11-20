"use strict";

// PWA-17: the completed-timer instruction mentions the sound only while the
// completion alert rings. PWA-21: a history row reads "Focus / Completed" on
// one line, with the task context on the line below.

const test = require("node:test");
const assert = require("node:assert/strict");
const { viewFixture } = require("./test/ux-view-fixture.js");
const { seedMeta, dump, nowMs } = require("./test/account-ownership-fixture.js");

// Without an automatic break the finished focus run stays on the dial.
async function withoutAutoBreaks(current) {
  const snapshot = (await dump(current.use.database())).meta.find((record) => record.key === "snapshot").value;
  await seedMeta(current.use.database(), { snapshot: { ...snapshot, autoStartBreaks: false } });
  await current.use.reloadPersistedState();
}

async function completedRun(t) {
  const current = await viewFixture(t);
  await withoutAutoBreaks(current);
  assert.equal(await current.use.addTask("Alpha"), true);
  assert.equal(await current.use.issueCommand("start", { phase: "focus" }), true);
  t.mock.timers.setTime(nowMs + 60_000);
  current.use.trustedNow = () => nowMs + 60_000;
  assert.equal(await current.use.finishTimer(false), true);
  current.view.render();
  return current;
}

test("PWA-17 completed instruction drops 'Stop the sound' once no sound rings", async (t) => {
  const current = await completedRun(t);
  assert.equal(current.state.timer.status, "completed");
  assert.ok(current.use.activeCompletionAlertTimerId(), "the alert rings right after completion");
  assert.equal(current.elements.timerInstruction.textContent, "Run complete. Stop the sound or start another.");
  assert.equal(current.elements.clearButton.hidden, false);
  current.use.stopCompletionAlert();
  current.view.render();
  assert.equal(current.elements.clearButton.hidden, true);
  assert.equal(current.elements.timerInstruction.textContent, "Run complete. Start another.");
});

test("PWA-21 history status follows the phase inline and the task context sits below", async (t) => {
  const current = await completedRun(t);
  const row = current.elements.historyList.querySelector(".history-item");
  const label = row.querySelector(".history-phase");
  const parts = [...label.children].map((child) => child.className);
  assert.deepEqual(parts, ["history-status", "history-task"]);
  assert.match(label.querySelector(".history-status").textContent, /^ \/ \S/);
  assert.equal(label.querySelector(".history-task").textContent, "Alpha");
});

// Chromium moves focus to the page body at the moment a focused control
// hides; jsdom leaves it on the hidden control. The bank controls get the
// browser behaviour here so the hand-off is tested on the path a browser takes.
function blurWhenHidden(current) {
  const { document, elements } = current;
  const reflected = Object.getOwnPropertyDescriptor(document.defaultView.HTMLElement.prototype, "hidden");
  for (const control of [elements.finishButton, elements.cancelButton, elements.skipButton, elements.clearButton]) {
    Object.defineProperty(control, "hidden", {
      configurable: true,
      get() { return reflected.get.call(this); },
      set(value) {
        reflected.set.call(this, value);
        if (value && document.activeElement === this) this.blur();
      },
    });
  }
}

async function timerBank(t, { underway }) {
  const current = await viewFixture(t);
  await withoutAutoBreaks(current);
  if (underway) assert.equal(await current.use.issueCommand("start", { phase: "focus" }), true);
  current.view.render();
  blurWhenHidden(current);
  return current;
}

function focusControl(current, control) {
  assert.equal(control.hidden, false, `${control.id} is shown`);
  control.focus();
  assert.equal(current.document.activeElement, control);
}

function assertHandedToPrimary(current, control) {
  assert.equal(control.hidden, true, `${control.id} hid`);
  assert.equal(current.document.activeElement, current.elements.timerToggle);
}

test("PWA-20 Cancel hands keyboard focus to the primary timer control as it hides", async (t) => {
  const current = await timerBank(t, { underway: true });
  focusControl(current, current.elements.cancelButton);
  assert.equal(await current.use.cancelAndClearTimer(), true);
  current.view.render();
  assertHandedToPrimary(current, current.elements.cancelButton);
  assert.match(current.elements.timerToggle.textContent, /^Start /);
});

test("PWA-20 Finish hands keyboard focus to the primary timer control as it hides", async (t) => {
  const current = await timerBank(t, { underway: true });
  focusControl(current, current.elements.finishButton);
  assert.equal(await current.use.finishTimer(false), true);
  current.view.render();
  assertHandedToPrimary(current, current.elements.finishButton);
});

test("PWA-20 Stop sound hands keyboard focus to the primary timer control as it hides", async (t) => {
  const current = await completedRun(t);
  blurWhenHidden(current);
  focusControl(current, current.elements.clearButton);
  current.use.stopCompletionAlert();
  current.view.renderTimer();
  assertHandedToPrimary(current, current.elements.clearButton);
});

test("PWA-20 Skip hands keyboard focus to the primary timer control as a started run hides it", async (t) => {
  const current = await timerBank(t, { underway: false });
  focusControl(current, current.elements.skipButton);
  assert.equal(await current.use.issueCommand("start", { phase: "focus" }), true);
  current.view.render();
  assertHandedToPrimary(current, current.elements.skipButton);
});

test("PWA-20 a bank control that stays shown keeps keyboard focus", async (t) => {
  const current = await timerBank(t, { underway: true });
  const { finishButton } = current.elements;
  focusControl(current, finishButton);
  assert.equal(await current.use.issueCommand("pause"), true);
  current.view.render();
  assert.equal(finishButton.hidden, false);
  assert.equal(current.document.activeElement, finishButton);
});

test("PWA-20 focus outside the bank stays put when Cancel hides", async (t) => {
  const current = await timerBank(t, { underway: true });
  const { cancelButton, taskInput } = current.elements;
  taskInput.focus();
  assert.equal(current.document.activeElement, taskInput);
  assert.equal(await current.use.cancelAndClearTimer(), true);
  current.view.render();
  assert.equal(cancelButton.hidden, true);
  assert.equal(current.document.activeElement, taskInput);
});
