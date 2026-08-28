(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PomodoroughSyncAuthority = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  const PHASES = new Set(["focus", "short_break", "long_break"]);
  const COMPLETION_KEYS = [
    "commandEligible", "expired", "generatedBreakEligible", "generatedBreakPhase",
    "queueAutoBreak", "reserveGeneratedBreak", "selectedPhase", "sourceAlreadyAccepted"
  ];
  const COMPLETION_FLAGS = [
    "expired", "commandEligible", "reserveGeneratedBreak", "queueAutoBreak",
    "generatedBreakEligible", "sourceAlreadyAccepted"
  ];

  function plainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function validPhase(value) {
    return value === null || PHASES.has(value);
  }

  function validCompletionRelationships(value, input) {
    if (value.reserveGeneratedBreak && !value.commandEligible) return false;
    if (value.queueAutoBreak && value.selectedPhase === null) return false;
    if ((value.generatedBreakPhase !== null) !== value.generatedBreakEligible) return false;
    if (input?.kind === "commandRequest") {
      return !value.expired && value.selectedPhase === null && !value.queueAutoBreak
        && !value.generatedBreakEligible && !value.sourceAlreadyAccepted;
    }
    if (input?.kind === "finishApplied") {
      return !value.expired && !value.commandEligible && !value.reserveGeneratedBreak
        && value.selectedPhase !== null && !value.generatedBreakEligible && !value.sourceAlreadyAccepted;
    }
    if (input?.kind === "generatedBreak") {
      return !value.expired && !value.commandEligible && !value.reserveGeneratedBreak
        && value.selectedPhase === null && !value.queueAutoBreak;
    }
    if (input?.kind === "expiry") {
      return !value.commandEligible && !value.reserveGeneratedBreak && !value.queueAutoBreak
        && !value.generatedBreakEligible && !value.sourceAlreadyAccepted;
    }
    return true;
  }

  function validateCompletionPlan(value, input = null) {
    if (!plainObject(value)
      || Object.keys(value).sort().join(",") !== COMPLETION_KEYS.join(",")
      || COMPLETION_FLAGS.some((key) => typeof value[key] !== "boolean")
      || !validPhase(value.selectedPhase)
      || !validPhase(value.generatedBreakPhase)
      || !validCompletionRelationships(value, input)) {
      throw new Error("Shared core returned an invalid completion plan.");
    }
    return value;
  }

  function validateHlcTick(value) {
    if (!plainObject(value) || Object.keys(value).sort().join(",") !== "counter,wallMs"
      || !Number.isSafeInteger(value.wallMs) || value.wallMs < 0
      || !Number.isSafeInteger(value.counter) || value.counter < 0) {
      throw new Error("Shared core returned an invalid HLC tick.");
    }
    return value;
  }

  class SharedCoreAuthority {
    constructor(core) {
      if (!core || typeof core.tickHlc !== "function"
        || typeof core.planTimerCompletion !== "function") {
        throw new TypeError("Typed SharedCore completion and HLC methods are required.");
      }
      this.core = core;
    }

    completionPlan(input) {
      return validateCompletionPlan(this.core.planTimerCompletion(input), input);
    }

    finishAppliedPlan(input) {
      const bounds = this.localDayBounds(input.referenceMs);
      return this.completionPlan({
        kind: "finishApplied",
        source: {
          commandId: input.commandId,
          timerId: input.timerId,
          phase: input.phase,
          occurredAt: input.occurredAt
        },
        history: input.history,
        autoStartBreaks: input.autoStartBreaks === true,
        localDeviceId: input.localDeviceId,
        ownership: input.ownsTimer === true
          ? { timerId: input.timerId, ownerDeviceId: input.localDeviceId }
          : null,
        ...bounds
      });
    }

    tickHlc(local, physicalNowMs, remote) {
      const input = { local, physicalNowMs };
      if (remote !== undefined && remote !== null) input.remote = remote;
      return validateHlcTick(this.core.tickHlc(input));
    }

    allocateHlcBatch(local, physicalNowMs, count) {
      if (!Number.isSafeInteger(count) || count < 1) throw new RangeError("HLC batch count is invalid.");
      let current = this.tickHlc(local, physicalNowMs);
      const firstCounter = current.counter;
      for (let index = 1; index < count; index += 1) {
        current = this.tickHlc(current, physicalNowMs);
      }
      return { wallMs: current.wallMs, firstCounter, counter: current.counter };
    }

    localDayBounds(referenceMs) {
      const reference = new Date(referenceMs);
      if (!Number.isFinite(reference.getTime())) throw new RangeError("Completion reference time is invalid.");
      return {
        dayStart: new Date(reference.getFullYear(), reference.getMonth(), reference.getDate()).toISOString(),
        dayEnd: new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() + 1).toISOString()
      };
    }
  }

  return Object.freeze({
    create: (core) => new SharedCoreAuthority(core),
    validateCompletionPlan,
    validateHlcTick
  });
});
