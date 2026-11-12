"use strict";

// UX round 2 (batch A acceptance L4): Try again and Dismiss hide the notice
// that holds the keyboard focus. The focus must land on the selected screen
// tab, never on the page body.

const test = require("node:test");
const assert = require("node:assert/strict");
const { viewFixture } = require("./test/ux-view-fixture.js");

async function noticeView(t) {
  const current = await viewFixture(t);
  current.use.showNotice = current.view.showNotice;
  current.view.setupAccountEvents();
  return current;
}

function selectedTab(current) {
  return current.elements.screenButtons.find((button) => button.getAttribute("aria-selected") === "true");
}

test("Try again hands the focus to the selected screen tab", async (t) => {
  const current = await noticeView(t);
  const attempts = [];
  current.view.showNotice("Task change could not be saved. Try again.", { retry: () => attempts.push("retry") });
  current.elements.noticeRetry.focus();
  current.elements.noticeRetry.click();
  assert.deepEqual(attempts, ["retry"]);
  assert.equal(current.elements.notice.hidden, true);
  assert.equal(current.document.activeElement, selectedTab(current));
});

test("Dismiss hands the focus to the selected screen tab", async (t) => {
  const current = await noticeView(t);
  current.view.showNotice("Task change could not be saved. Try again.");
  current.elements.noticeDismiss.focus();
  current.elements.noticeDismiss.click();
  assert.equal(current.elements.notice.hidden, true);
  assert.equal(current.document.activeElement, selectedTab(current));
});

test("a notice hidden while the focus is elsewhere leaves the focus alone", async (t) => {
  const current = await noticeView(t);
  current.view.showNotice("Task change could not be saved. Try again.", { kind: "task" });
  current.elements.taskInput.focus();
  current.view.clearNotice("task");
  assert.equal(current.elements.notice.hidden, true);
  assert.equal(current.document.activeElement, current.elements.taskInput);
});
