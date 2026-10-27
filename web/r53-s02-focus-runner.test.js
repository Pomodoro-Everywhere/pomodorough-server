"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadRunner() {
  const filename = path.join(__dirname, "../scripts/r49-s07-actions-browser.test.cjs");
  const runnerRequire = createRequire(filename);
  const context = vm.createContext({
    process: { env: {} },
    require(id) {
      if (id === "node:test") return () => {};
      if (id === "node:fs") return { readFileSync: () => "{}" };
      if (id === "playwright") return { chromium: {} };
      return runnerRequire(id);
    },
  });
  vm.runInContext(readFileSync(filename, "utf8"), context, { filename });
  return context;
}

const forcedFocus = { focusVisible: true, outline: "solid", width: 3,
  offset: -6, color: "rgb(0, 0, 0)", shadow: "none" };

test("R53-S02 forced-colors accepts the visible inset outline", () => {
  loadRunner().assertActionFocus(forcedFocus, "forced", true);
});

for (const [field, value, message] of [
  ["focusVisible", false, "matches focus-visible"],
  ["outline", "none", "forced-colors outline"],
  ["width", 0, "forced-colors outline width"],
  ["offset", 0, "forced-colors outline stays inside clip"],
  ["color", "rgba(0, 0, 0, 0)", "forced-colors outline is opaque"],
  ["shadow", "inset 0 0 0 3px rgb(247, 248, 242)", "forced-colors replaces shadows"],
]) {
  test(`R53-S02 forced-colors rejects invalid ${field}`, () => {
    assert.throws(() => loadRunner().assertActionFocus(
      { ...forcedFocus, [field]: value }, "forced", true),
    (error) => error.code === "ERR_ASSERTION" && error.message.includes(message));
  });
}

test("R53-S02 forced-colors failure restores media and cleans the running timer", async () => {
  const runner = loadRunner();
  const failure = new Error("forced-colors assertion failed");
  const media = [];
  const timer = { status: "idle", id: null };
  let stopped = 0;
  runner.window = { PomodoroughAppTest: { state: { timer, actionLocked: false },
    stopCompletionAlert: () => { stopped += 1; } } };
  runner.document = { getElementById: (id) => {
    assert.equal(id, "cancelButton");
    return { click: () => { timer.status = "idle"; timer.id = null; } };
  } };
  runner.emulate = runner.assertEnvironment = runner.assertBothPasses = async () => {};
  runner.keyToStatus = async () => { timer.status = "running"; timer.id = "running-id"; };
  runner.tabReachesActions = async (_page, _scenario, forcedColors) => {
    if (forcedColors) throw failure;
  };
  const page = {
    evaluate: async (read) => read(),
    waitForFunction: async (read) => assert.equal(read(), true),
    emulateMedia: async (value) => { media.push(value.forcedColors); },
  };
  await assert.rejects(runner.withTimerCleanup(page,
    () => runner.runScenario(page, {}, { name: "forced failure" })), (error) => error === failure);
  assert.deepEqual(media, ["active", "none"]);
  assert.deepEqual(timer, { status: "idle", id: null });
  assert.equal(stopped, 1);
});
