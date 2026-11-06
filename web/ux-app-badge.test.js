"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture } = require("./test/account-ownership-fixture.js");

function fakeBadge(current, { reject = false } = {}) {
  const log = [];
  Object.assign(current.external.host.navigator, {
    setAppBadge: async (count) => { log.push(["set", count]); if (reject) throw new Error("badge refused"); },
    clearAppBadge: async () => { log.push(["clear"]); if (reject) throw new Error("badge refused"); }
  });
  return log;
}

function warnings(current) {
  return current.calls.filter((entry) => Array.isArray(entry) && entry[0] === "warn" && entry[1] === "App badge unavailable:");
}

test("completion alert sets the app badge and stopping it clears the badge", async (t) => {
  const { stale } = await fixture(t);
  const log = fakeBadge(stale);
  assert.equal(stale.use.startCompletionAlert({ id: "timer-1", phase: "focus" }), true);
  await Promise.resolve();
  assert.deepEqual(log, [["set", 1]]);
  stale.use.stopCompletionAlert();
  await Promise.resolve();
  assert.deepEqual(log, [["set", 1], ["clear"]]);
  stale.use.stopCompletionAlert();
  await Promise.resolve();
  assert.deepEqual(log, [["set", 1], ["clear"]], "clear runs only after a set");
});

test("missing Badging API is a no-op without warnings", async (t) => {
  const { stale } = await fixture(t);
  assert.equal(stale.use.startCompletionAlert({ id: "timer-2", phase: "focus" }), true);
  stale.use.stopCompletionAlert();
  await Promise.resolve();
  assert.deepEqual(warnings(stale), []);
});

test("badge rejections warn once per session and never raise a notice", async (t) => {
  const { stale } = await fixture(t);
  const log = fakeBadge(stale, { reject: true });
  stale.use.startCompletionAlert({ id: "timer-3", phase: "focus" });
  await new Promise((resolve) => setImmediate(resolve));
  stale.use.stopCompletionAlert();
  await new Promise((resolve) => setImmediate(resolve));
  stale.use.startCompletionAlert({ id: "timer-4", phase: "shortBreak" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(log, [["set", 1], ["clear"], ["set", 1]]);
  assert.equal(warnings(stale).length, 1);
  assert.ok(!stale.calls.some((entry) => Array.isArray(entry) && entry[0] === "notice"));
});
