"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { viewFixture } = require("./test/ux-view-fixture.js");

function trackTitle(current) {
  const sets = [];
  const descriptor = Object.getOwnPropertyDescriptor(current.window.Document.prototype, "title");
  Object.defineProperty(current.document, "title", {
    configurable: true,
    get() { return descriptor.get.call(this); },
    set(value) { sets.push(value); descriptor.set.call(this, value); }
  });
  // The fixture's initial render already assigned the title; reset it so the
  // next render's assignment is observable.
  descriptor.set.call(current.document, "Pomodorough");
  return sets;
}

function expectedClock(current) {
  const timer = current.view.displayTimer();
  const status = current.state.readModel?.display.status || current.state.timer.status;
  const view = current.view.timerDisplayView(timer, status);
  return `${view.timeText} · ${current.use.phaseLabel(timer.phase)} — Pomodorough`;
}

test("running timer puts the countdown and phase in the tab title, assigned once per change", async (t) => {
  const current = await viewFixture(t, "running");
  const sets = trackTitle(current);
  current.view.renderTimer();
  const expected = expectedClock(current);
  assert.match(expected, /^\d{2}:\d{2} · .+ — Pomodorough$/);
  assert.equal(current.document.title, expected);
  current.view.renderTimer();
  current.view.renderTimer();
  assert.deepEqual(sets, [expected]);
});

test("paused timer keeps the clock title", async (t) => {
  const current = await viewFixture(t, "paused");
  current.view.renderTimer();
  assert.equal(current.state.readModel?.display.status || current.state.timer.status, "paused");
  assert.equal(current.document.title, expectedClock(current));
});

test("idle restores the original title", async (t) => {
  const current = await viewFixture(t, null);
  const sets = trackTitle(current);
  current.view.renderTimer();
  assert.equal(current.document.title, "Pomodorough");
  assert.deepEqual(sets, []);
});

test("ringing completion alert names the finished phase; stopping it restores the title", async (t) => {
  const current = await viewFixture(t, "completed");
  current.view.renderTimer();
  assert.ok(current.use.activeCompletionAlertTimerId(), "alert ringing");
  assert.equal(current.document.title, `Done · ${current.use.phaseLabel(current.state.timer.phase)} — Pomodorough`);
  current.use.stopCompletionAlert();
  current.view.renderTimer();
  assert.equal(current.document.title, "Pomodorough");
});
