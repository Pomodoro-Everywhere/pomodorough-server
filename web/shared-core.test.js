"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SharedCore } = require("./shared-core.js");

function fakeCore(envelope, options = {}) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
  let nextPointer = 1024;
  let freeCalls = 0;
  const exports = {
    memory,
    pomodorough_alloc(length) {
      if (options.badAllocation) return memory.buffer.byteLength + 1;
      const pointer = nextPointer;
      nextPointer += length + 8;
      return pointer;
    },
    pomodorough_free() {
      freeCalls += 1;
      if (options.freeThrows) throw new Error("synthetic free trap");
    },
    pomodorough_dispatch() {
      const bytes = new TextEncoder().encode(JSON.stringify(envelope));
      const pointer = 8192;
      new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes);
      return (BigInt(bytes.length) << 32n) | BigInt(pointer);
    }
  };
  return { core: new SharedCore({ exports }), freeCalls: () => freeCalls };
}

test("browser host rejects malformed envelopes and task identities", () => {
  const invalid = [
    { ok: true, value: {}, extra: true },
    { ok: true, value: {}, error: "bad" },
    { ok: false, error: "bad", value: {} },
    { ok: false, error: 7 }
  ];
  for (const envelope of invalid) {
    const { core } = fakeCore(envelope);
    assert.throws(() => core.call("core.version", {}), /invalid|malformed/i);
  }
  const { core } = fakeCore({
    ok: true,
    value: { id: "not-a-uuid", title: "Café", utf8Bytes: 4 }
  });
  assert.throws(() => core.call("task.identity.v1", { title: "Café" }), /task identity/i);
});

test("browser host invalidates an instance after cleanup failure", () => {
  const { core } = fakeCore({ ok: true, value: {} }, { freeThrows: true });
  assert.throws(() => core.call("core.version", {}), /cleanup/i);
  assert.throws(() => core.call("core.version", {}), /unusable/i);
});

test("browser host preserves primary allocation error and invalidates after failed cleanup", () => {
  const { core } = fakeCore(
    { ok: true, value: {} },
    { badAllocation: true, freeThrows: true }
  );
  assert.throws(
    () => core.call("core.version", {}),
    (error) => /outside/.test(error.message) && error.cleanupErrors?.length === 1
  );
  assert.throws(() => core.call("core.version", {}), /unusable/i);
});

test("browser host preserves malformed envelope error when cleanup also fails", () => {
  const { core } = fakeCore(
    { ok: true, value: {}, extra: true },
    { freeThrows: true }
  );
  assert.throws(
    () => core.call("core.version", {}),
    (error) => /malformed/i.test(error.message) && error.cleanupErrors?.length === 3
  );
  assert.throws(() => core.call("core.version", {}), /unusable/i);
});

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
