"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { SharedCore } = require("./shared-core.js");

function fakeCore(envelope, options = {}) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
  let nextPointer = 1024;
  let allocationCalls = 0;
  let freeCalls = 0;
  const operations = [];
  const exports = {
    memory,
    pomodorough_alloc(length) {
      allocationCalls += 1;
      if (options.badAllocation || options.badAllocationAt === allocationCalls) {
        return memory.buffer.byteLength + 1;
      }
      const pointer = nextPointer;
      nextPointer += length + 8;
      return pointer;
    },
    pomodorough_free(pointer) {
      freeCalls += 1;
      if (options.freeError) throw new Error(options.freeError(pointer));
      if (options.freeThrows) throw new Error("synthetic free trap");
    },
    pomodorough_free_v2(pointer) {
      freeCalls += 1;
      if (options.freeError) throw new Error(options.freeError(pointer));
      if (options.freeThrows) throw new Error("synthetic free trap");
      return options.freeStatus ?? 1;
    },
    pomodorough_dispatch(operationPointer, operationLength) {
      operations.push(new TextDecoder().decode(
        new Uint8Array(memory.buffer, operationPointer, operationLength)
      ));
      const currentEnvelope = typeof options.envelope === "function"
        ? options.envelope(operations.length - 1)
        : envelope;
      const bytes = new TextEncoder().encode(JSON.stringify(currentEnvelope));
      const pointer = 8192;
      new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes);
      return (BigInt(bytes.length) << 32n) | BigInt(pointer);
    }
  };
  return { core: new SharedCore({ exports }), freeCalls: () => freeCalls, operations: () => operations };
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
  assert.throws(() => core.taskIdentity({ title: "Café" }), /task identity/i);

  const { core: wrongVersionCore } = fakeCore({
    ok: true,
    value: { id: "00000000-0000-0000-0000-000000000000", title: "Café", utf8Bytes: 5 }
  });
  assert.throws(
    () => wrongVersionCore.taskIdentity({ title: "Café" }),
    /task identity/i
  );
});

test("typed shared-core adapter methods dispatch pinned production operations", () => {
  const completion = {
    expired: false, commandEligible: false, reserveGeneratedBreak: false,
    selectedPhase: null, queueAutoBreak: false, generatedBreakEligible: false,
    generatedBreakPhase: null, sourceAlreadyAccepted: false
  };
  const clock = { wallMs: 101, counter: 0 };
  const envelopes = [
    {}, {}, {}, completion, clock
  ];
  const { core, operations } = fakeCore(null, {
    envelope: (index) => ({ ok: true, value: envelopes[index] })
  });

  assert.deepEqual(core.projectSynchronizedState({}), {});
  assert.deepEqual(core.planBootstrap({}), {});
  assert.deepEqual(core.reconcileSynchronizedState({}), {});
  assert.deepEqual(core.planTimerCompletion({}), completion);
  assert.deepEqual(core.tickHlc({}), clock);
  assert.deepEqual(operations(), [
    "projection.apply.v2", "bootstrap.plan.v1", "reconcile.rebase.v1",
    "timer.completionPlan.v1", "hlc.tick.v1"
  ]);
});

test("typed completion and HLC seams reject malformed successful core values", () => {
  const malformedCompletion = fakeCore({ ok: true, value: {
    expired: false, commandEligible: false, reserveGeneratedBreak: false,
    selectedPhase: "nap", queueAutoBreak: false, generatedBreakEligible: false,
    generatedBreakPhase: null, sourceAlreadyAccepted: false
  } }).core;
  const malformedClock = fakeCore({ ok: true, value: { wallMs: 10, counter: -1 } }).core;

  assert.throws(() => malformedCompletion.planTimerCompletion({}), /completion plan/i);
  assert.throws(() => malformedClock.tickHlc({}), /HLC tick/i);
});

test("typed completion seam rejects eligible generated break without a phase", () => {
  const contradictory = fakeCore({ ok: true, value: {
    expired: false, commandEligible: false, reserveGeneratedBreak: false,
    selectedPhase: null, queueAutoBreak: false, generatedBreakEligible: true,
    generatedBreakPhase: null, sourceAlreadyAccepted: false
  } }).core;

  assert.throws(
    () => contradictory.planTimerCompletion({ kind: "generatedBreak" }),
    /completion plan/i
  );
});

test("typed completion seam binds generated eligibility to exact source evidence", () => {
  const contradictory = fakeCore({ ok: true, value: {
    expired: false, commandEligible: false, reserveGeneratedBreak: false,
    selectedPhase: null, queueAutoBreak: false, generatedBreakEligible: true,
    generatedBreakPhase: "short_break", sourceAlreadyAccepted: false
  } }).core;

  assert.throws(
    () => contradictory.planTimerCompletion({
      kind: "generatedBreak",
      source: { commandId: "finish", timerId: "timer" },
      canonical: { canonicalTimer: null, history: [] },
      optimistic: { canonicalTimer: null, history: [] },
      sourceFinishPending: true,
      requireCanonical: false
    }),
    /completion plan/i
  );
});

test("typed completion seam accepts exact generated-break evidence", () => {
  const output = {
    expired: false, commandEligible: false, reserveGeneratedBreak: false,
    selectedPhase: null, queueAutoBreak: false, generatedBreakEligible: true,
    generatedBreakPhase: "short_break", sourceAlreadyAccepted: true
  };
  const core = fakeCore({ ok: true, value: output }).core;
  const completed = {
    id: "timer", phase: "focus", status: "completed",
    plannedDurationMs: 1500000, elapsedAtAnchorMs: 1500000,
    anchorAt: "2026-08-25T12:00:00Z"
  };
  const history = [{
    id: "history", timerId: "timer", commandId: "finish", phase: "focus",
    status: "completed", plannedDurationMs: 1500000,
    completedAt: "2026-08-25T12:00:00Z", endedAt: "2026-08-25T12:00:00Z"
  }];
  const projection = { canonicalTimer: completed, history };
  const input = {
    kind: "generatedBreak",
    source: { commandId: "finish", timerId: "timer" },
    canonical: projection,
    optimistic: projection,
    sourceFinishPending: false,
    requireCanonical: true
  };

  assert.deepEqual(core.planTimerCompletion(input), output);
});

test("browser host invalidates an instance after cleanup failure", () => {
  const { core } = fakeCore({ ok: true, value: {} }, { freeThrows: true });
  assert.throws(() => core.call("core.version", {}), /cleanup/i);
  assert.throws(() => core.call("core.version", {}), /unusable/i);
});

test("browser host invalidates an instance after rejected free ownership", () => {
  const { core } = fakeCore({ ok: true, value: {} }, { freeStatus: 0 });
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

test("browser host preserves allocation and earlier-buffer cleanup failures", () => {
  const { core } = fakeCore(
    { ok: true, value: {} },
    {
      badAllocationAt: 2,
      freeError(pointer) {
        return pointer > 65536 ? "failed-allocation free trap" : "operation free trap";
      }
    }
  );
  assert.throws(
    () => core.call("core.version", {}),
    (error) => {
      assert.match(error.message, /outside/);
      assert.deepEqual(
        error.cleanupErrors.map((cleanup) => cleanup.message),
        ["failed-allocation free trap", "operation free trap"]
      );
      return true;
    }
  );
});

async function loadCore() {
  const bytes = fs.readFileSync(path.join(__dirname, "pomodorough_core.wasm"));
  return SharedCore.fromBytes(bytes);
}

test("packaged browser WASM reports stale, wrong-length, and duplicate frees", async () => {
  const bytes = fs.readFileSync(path.join(__dirname, "pomodorough_core.wasm"));
  const { instance } = await WebAssembly.instantiate(bytes);
  const alloc = instance.exports.pomodorough_alloc;
  const free = instance.exports.pomodorough_free_v2;
  assert.equal(typeof free, "function");
  const pointer = alloc(8);
  assert.notEqual(pointer, 0);
  assert.equal(free(pointer, 7), 0);
  assert.equal(free(pointer, 8), 1);
  assert.equal(free(pointer, 8), 0);
  assert.equal(free(0, 8), 0);
});

test("generated browser metadata matches the exact served WASM and source pin", () => {
  const metadata = require("./shared-core-metadata.js");
  const bytes = fs.readFileSync(path.join(__dirname, "pomodorough_core.wasm"));
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const pinnedDigest = fs.readFileSync(
    path.join(__dirname, "../internal/sharedcore/pomodorough_core.wasm.sha256"),
    "utf8"
  ).trim().split(/\s+/)[0];
  const pinnedCommit = fs.readFileSync(
    path.join(__dirname, "../internal/sharedcore/CORE_COMMIT"),
    "utf8"
  ).trim();

  assert.deepEqual(metadata, {
    coreCommit: pinnedCommit,
    sha256: pinnedDigest,
    wasmURL: `/pomodorough_core.wasm?sha256=${pinnedDigest}`,
    cacheVersion: `core-${pinnedDigest.slice(0, 16)}`
  });
  assert.equal(digest, metadata.sha256);
});

test("browser host fails closed when Web Crypto is unavailable", async () => {
  const bytes = fs.readFileSync(path.join(__dirname, "pomodorough_core.wasm"));
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
  try {
    await assert.rejects(() => SharedCore.fromBytes(bytes), /Web Crypto is unavailable/);
  } finally {
    if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
    else delete globalThis.crypto;
  }
});

test("browser host rejects valid WASM bytes with a modified digest", async () => {
  const bytes = new Uint8Array(fs.readFileSync(path.join(__dirname, "pomodorough_core.wasm")));
  bytes[bytes.length - 1] ^= 1;

  await assert.rejects(() => SharedCore.fromBytes(bytes), /digest/i);
});

test("browser host rejects wrong digest metadata before instantiation", async () => {
  const bytes = fs.readFileSync(path.join(__dirname, "pomodorough_core.wasm"));

  await assert.rejects(() => SharedCore.fromBytes(bytes, "0".repeat(64)), /digest/i);
});

test("shared WASM core exposes its pinned version", async () => {
  const core = await loadCore();
  assert.deepEqual(core.call("core.version", {}), {
    schemaVersion: 1,
    coreVersion: "0.14.0"
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
  assert.deepEqual(core.taskIdentity({ title: "\u0000Cafe\u0301\u001f" }), {
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
