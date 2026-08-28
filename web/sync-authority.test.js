"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const authority = require("./sync-authority.js");

function validCompletion(overrides = {}) {
  return {
    expired: false, commandEligible: false, reserveGeneratedBreak: false,
    selectedPhase: null, queueAutoBreak: false, generatedBreakEligible: false,
    generatedBreakPhase: null, sourceAlreadyAccepted: false, ...overrides
  };
}

test("HLC allocation follows typed core policy rather than the legacy host tie rule", () => {
  const calls = [];
  const core = {
    tickHlc(input) {
      calls.push(structuredClone(input));
      return calls.length === 1 ? { wallMs: 100, counter: 8 } : { wallMs: 100, counter: 9 };
    },
    planTimerCompletion: () => validCompletion()
  };
  const policy = authority.create(core);

  assert.deepEqual(policy.allocateHlcBatch({ wallMs: 100, counter: 2 }, 99, 2), {
    wallMs: 100, firstCounter: 8, counter: 9
  });
  assert.deepEqual(calls, [
    { local: { wallMs: 100, counter: 2 }, physicalNowMs: 99 },
    { local: { wallMs: 100, counter: 8 }, physicalNowMs: 99 }
  ]);
});

test("authority rejects malformed typed core results before callers can mutate durable state", () => {
  const policy = authority.create({
    tickHlc: () => ({ wallMs: 1, counter: -1 }),
    planTimerCompletion: () => validCompletion({ selectedPhase: "nap" })
  });

  assert.throws(() => policy.allocateHlcBatch({ wallMs: 0, counter: 0 }, 1, 1), /HLC tick/i);
  assert.throws(() => policy.completionPlan({ kind: "finishApplied" }), /completion plan/i);
});

test("authority rejects structurally valid but contradictory completion plans", () => {
  const outputs = [
    validCompletion({ reserveGeneratedBreak: true }),
    validCompletion({ selectedPhase: "short_break", queueAutoBreak: true }),
    validCompletion({ generatedBreakEligible: false, generatedBreakPhase: "short_break" })
  ];
  const policy = authority.create({
    tickHlc: () => ({ wallMs: 1, counter: 0 }),
    planTimerCompletion: () => outputs.shift()
  });

  assert.throws(() => policy.completionPlan({ kind: "commandRequest" }), /completion plan/i);
  assert.throws(() => policy.completionPlan({ kind: "expiry" }), /completion plan/i);
  assert.throws(() => policy.completionPlan({ kind: "generatedBreak" }), /completion plan/i);
});

test("completion day bounds preserve the browser local calendar day", () => {
  const received = [];
  const policy = authority.create({
    tickHlc: () => ({ wallMs: 0, counter: 0 }),
    planTimerCompletion: (input) => { received.push(input); return validCompletion({ selectedPhase: "long_break" }); }
  });
  const reference = new Date(2026, 7, 26, 12, 30, 0);
  const bounds = policy.localDayBounds(reference.getTime());

  assert.equal(bounds.dayStart, new Date(2026, 7, 26).toISOString());
  assert.equal(bounds.dayEnd, new Date(2026, 7, 27).toISOString());
  assert.equal(policy.finishAppliedPlan({
    commandId: "finish-4", timerId: "timer-4", phase: "focus",
    occurredAt: reference.toISOString(), history: [], autoStartBreaks: true,
    localDeviceId: "device-1", ownsTimer: true, referenceMs: reference.getTime()
  }).selectedPhase, "long_break");
  assert.deepEqual(received[0], {
    kind: "finishApplied",
    source: {
      commandId: "finish-4", timerId: "timer-4", phase: "focus", occurredAt: reference.toISOString()
    },
    history: [], autoStartBreaks: true, localDeviceId: "device-1",
    ownership: { timerId: "timer-4", ownerDeviceId: "device-1" }, ...bounds
  });
});
