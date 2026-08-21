"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SharedCore } = require("./shared-core.js");

async function loadCore() {
  const bytes = fs.readFileSync(path.join(__dirname, "pomodorough_core.wasm"));
  return SharedCore.fromBytes(bytes);
}

test("shared WASM core exposes its pinned version", async () => {
  const core = await loadCore();
  assert.deepEqual(core.call("core.version", {}), {
    schemaVersion: 1,
    coreVersion: "0.1.0"
  });
});

test("shared WASM core preserves omitted, null, and selected task values", async () => {
  const core = await loadCore();
  assert.equal(core.call("selectedTask.classify", {}), "omitted");
  assert.equal(core.call("selectedTask.classify", { selectedTaskId: null }), "deselected");
  assert.equal(core.call("selectedTask.classify", { selectedTaskId: "task-a" }), "selected:task-a");
});

test("shared WASM core reports unsupported operations", async () => {
  const core = await loadCore();
  assert.throws(() => core.call("unknown", {}), /unsupported shared-core operation/);
});

test("shared WASM core owns production task identity", async () => {
  const core = await loadCore();
  assert.deepEqual(core.call("task.identity.v1", { title: "\u0000Cafe\u0301\u001f" }), {
    id: "aaf83054-24b2-8c0e-901f-a974147bfe82",
    title: "Café",
    utf8Bytes: 5
  });
});

test("shared WASM host rejects empty and oversized ABI inputs", async () => {
  const core = await loadCore();
  assert.throws(() => core.call("", {}), /non-empty string/);
  assert.throws(() => core.call("x".repeat(257), {}), /too large/);
});
