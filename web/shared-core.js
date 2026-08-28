"use strict";

(function (root, factory) {
  const metadata = typeof module === "object" && module.exports
    ? require("./shared-core-metadata.js")
    : root?.PomodoroughSharedCoreMetadata;
  const exported = factory(metadata);
  if (typeof module === "object" && module.exports) module.exports = exported;
  if (root) root.PomodoroughSharedCore = exported;
})(typeof globalThis !== "undefined" ? globalThis : this, function (metadata) {
  if (!metadata || !/^[0-9a-f]{64}$/.test(metadata.sha256)
      || typeof metadata.wasmURL !== "string") {
    throw new Error("Shared core metadata is missing or invalid");
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const CORE_SHA256 = metadata.sha256;
  const CORE_URL = metadata.wasmURL;
  const MAX_OPERATION_BYTES = 256;
  const MAX_INPUT_BYTES = 16 * 1024 * 1024;
  const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
  const MAX_MEMORY_BYTES = 256 * 1024 * 1024;

  function projectionHasExactSource(projection, source) {
    const timer = projection?.canonicalTimer;
    const history = projection?.history;
    return typeof source?.timerId === "string"
      && typeof source?.commandId === "string"
      && timer?.id === source.timerId
      && timer?.phase === "focus"
      && timer?.status === "completed"
      && Array.isArray(history)
      && history.some((item) => item?.timerId === source.timerId
        && item?.commandId === source.commandId
        && item?.phase === "focus"
        && item?.status === "completed");
  }

  class SharedCore {
    constructor(instance) {
      this.instance = instance;
      this.unusableCause = null;
      const exports = instance.exports;
      for (const name of [
        "memory",
        "pomodorough_alloc",
        "pomodorough_free_v2",
        "pomodorough_dispatch"
      ]) {
        if (!exports[name]) throw new Error(`Shared core is missing export ${name}`);
      }
      this.#checkMemory();
    }

    static async fromBytes(bytes, expectedDigest = CORE_SHA256) {
      const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (source.byteLength > MAX_INPUT_BYTES) throw new Error("Shared core module is too large");
      if (!/^[0-9a-f]{64}$/.test(expectedDigest)) {
        throw new Error("Shared core expected digest is invalid");
      }
      const subtle = globalThis.crypto?.subtle;
      if (!subtle) throw new Error("Web Crypto is unavailable for shared-core verification");
      const digestBytes = new Uint8Array(await subtle.digest("SHA-256", source));
      const actualDigest = Array.from(digestBytes, (value) => value.toString(16).padStart(2, "0")).join("");
      if (actualDigest !== expectedDigest) throw new Error("Shared core digest mismatch");
      const { instance } = await WebAssembly.instantiate(source, {});
      return new SharedCore(instance);
    }

    static async load(url = CORE_URL) {
      const response = await fetch(url, { credentials: "same-origin", cache: "no-cache" });
      if (!response.ok) throw new Error(`Unable to load shared core: HTTP ${response.status}`);
      return SharedCore.fromBytes(await response.arrayBuffer());
    }

    taskIdentity(input) {
      return this.call("task.identity.v1", input);
    }

    projectSynchronizedState(input) {
      return this.call("projection.apply.v2", input);
    }

    planBootstrap(input) {
      return this.call("bootstrap.plan.v1", input);
    }

    reconcileSynchronizedState(input) {
      return this.call("reconcile.rebase.v1", input);
    }

    planTimerCompletion(input) {
      const value = this.call("timer.completionPlan.v1", input);
      this.#validateCompletionPlan(value, input);
      return value;
    }

    tickHlc(input) {
      const value = this.call("hlc.tick.v1", input);
      this.#validateHlcTick(value);
      return value;
    }

    // size-exception: one WASM buffer lifetime keeps dispatch cleanup atomic across every failure path.
    call(operation, input) {
      if (this.unusableCause) {
        throw new Error("Shared core instance is unusable after cleanup failure", {
          cause: this.unusableCause
        });
      }
      if (typeof operation !== "string" || !operation) {
        throw new TypeError("Shared core operation must be a non-empty string");
      }
      const operationBytes = encoder.encode(operation);
      if (operationBytes.length > MAX_OPERATION_BYTES) {
        throw new RangeError("Shared core operation is too large");
      }
      const inputJSON = JSON.stringify(input);
      if (typeof inputJSON !== "string") throw new TypeError("Shared core input is not JSON serializable");
      const inputBytes = encoder.encode(inputJSON);
      if (!inputBytes.length || inputBytes.length > MAX_INPUT_BYTES) {
        throw new RangeError("Shared core input is empty or too large");
      }

      const ownedBuffers = [];
      let value;
      let primary = null;
      try {
        this.#checkMemory();
        const operationPointer = this.#allocateAndWrite(operationBytes);
        ownedBuffers.push([operationPointer, operationBytes.length]);
        const inputPointer = this.#allocateAndWrite(inputBytes);
        ownedBuffers.push([inputPointer, inputBytes.length]);
        const packed = this.instance.exports.pomodorough_dispatch(
          operationPointer,
          operationBytes.length,
          inputPointer,
          inputBytes.length
        );
        const packedResult = BigInt.asUintN(64, packed);
        const resultPointer = Number(packedResult & 0xffff_ffffn);
        const resultLength = Number(packedResult >> 32n);
        if (resultPointer && resultLength) ownedBuffers.push([resultPointer, resultLength]);
        if (!resultPointer || !resultLength) throw new Error("Shared core returned an empty result buffer");
        if (resultLength > MAX_OUTPUT_BYTES) throw new Error("Shared core result is too large");
        this.#requireRange(resultPointer, resultLength, "dispatch result");
        const resultBytes = new Uint8Array(
          new Uint8Array(this.instance.exports.memory.buffer, resultPointer, resultLength)
        );
        const envelope = JSON.parse(decoder.decode(resultBytes));
        value = this.#parseEnvelope(operation, envelope);
      } catch (error) {
        primary = error instanceof Error ? error : new Error(String(error));
      }

      const cleanupErrors = this.#releaseAll(ownedBuffers.reverse());
      if (cleanupErrors.length) {
        this.unusableCause = cleanupErrors[0];
        if (primary) {
          const earlierCleanupErrors = Array.isArray(primary.cleanupErrors)
            ? primary.cleanupErrors
            : [];
          primary.cleanupErrors = [...earlierCleanupErrors, ...cleanupErrors];
          throw primary;
        }
        const cleanupFailure = new Error("Shared core cleanup failed", {
          cause: cleanupErrors[0]
        });
        cleanupFailure.cleanupErrors = cleanupErrors;
        throw cleanupFailure;
      }
      if (primary) throw primary;
      return value;
    }

    #parseEnvelope(operation, envelope) {
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
          typeof envelope.ok !== "boolean") {
        throw new Error("Shared core returned an invalid envelope");
      }
      const keys = Object.keys(envelope).sort();
      if (envelope.ok) {
        if (keys.length !== 2 || keys[0] !== "ok" || keys[1] !== "value") {
          throw new Error("Shared core returned a malformed success envelope");
        }
        if (operation === "task.identity.v1") this.#validateTaskIdentity(envelope.value);
        return envelope.value;
      }
      if (keys.length !== 2 || keys[0] !== "error" || keys[1] !== "ok" ||
          typeof envelope.error !== "string" || !envelope.error) {
        throw new Error("Shared core returned a malformed failure envelope");
      }
      throw new Error(envelope.error);
    }

    #validateTaskIdentity(value) {
      const uuidV8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).sort().join(",") !== "id,title,utf8Bytes" ||
          typeof value.id !== "string" || !uuidV8.test(value.id) ||
          typeof value.title !== "string" || !value.title ||
          !Number.isSafeInteger(value.utf8Bytes) || value.utf8Bytes < 1 ||
          value.utf8Bytes !== encoder.encode(value.title).length) {
        throw new Error("Shared core returned an invalid task identity");
      }
    }

    #validateCompletionPlan(value, input) {
      const keys = [
        "commandEligible", "expired", "generatedBreakEligible", "generatedBreakPhase",
        "queueAutoBreak", "reserveGeneratedBreak", "selectedPhase", "sourceAlreadyAccepted"
      ];
      const phase = (candidate) => candidate === null
        || ["focus", "short_break", "long_break"].includes(candidate);
      const invalidGeneratedBreak = input?.kind === "generatedBreak" && (() => {
        const canonicalHasSource = projectionHasExactSource(input.canonical, input.source);
        const sourceAccepted = input.sourceFinishPending === false && canonicalHasSource;
        const selected = input.requireCanonical === true || sourceAccepted
          ? input.canonical
          : input.optimistic;
        return value?.generatedBreakEligible !== (value?.generatedBreakPhase !== null)
          || value?.generatedBreakEligible !== projectionHasExactSource(selected, input.source)
          || value?.sourceAlreadyAccepted !== sourceAccepted;
      })();
      if (!value || typeof value !== "object" || Array.isArray(value)
          || Object.keys(value).sort().join(",") !== keys.sort().join(",")
          || !["expired", "commandEligible", "reserveGeneratedBreak", "queueAutoBreak",
            "generatedBreakEligible", "sourceAlreadyAccepted"].every(
            (name) => typeof value[name] === "boolean"
          )
          || !phase(value.selectedPhase) || !phase(value.generatedBreakPhase)
          || invalidGeneratedBreak) {
        throw new Error("Shared core returned an invalid completion plan");
      }
    }

    #validateHlcTick(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)
          || Object.keys(value).sort().join(",") !== "counter,wallMs"
          || !Number.isSafeInteger(value.wallMs) || value.wallMs < 0
          || !Number.isSafeInteger(value.counter) || value.counter < 0) {
        throw new Error("Shared core returned an invalid HLC tick");
      }
    }

    #allocateAndWrite(bytes) {
      const pointer = this.instance.exports.pomodorough_alloc(bytes.length);
      if (!pointer) throw new Error("Shared core allocation failed");
      try {
        this.#requireRange(pointer, bytes.length, "allocated input");
        new Uint8Array(this.instance.exports.memory.buffer, pointer, bytes.length).set(bytes);
        return pointer;
      } catch (primary) {
        try {
          this.#release(pointer, bytes.length);
        } catch (cleanup) {
          this.unusableCause = cleanup;
          primary.cleanupErrors = [cleanup];
        }
        throw primary;
      }
    }

    #releaseAll(buffers) {
      const failures = [];
      for (const [pointer, length] of buffers) {
        if (!pointer || !length) continue;
        try {
          this.#release(pointer, length);
        } catch (error) {
          failures.push(error);
        }
      }
      return failures;
    }

    #release(pointer, length) {
      const status = this.instance.exports.pomodorough_free_v2(pointer, length);
      if (status !== 1) {
        throw new Error(`Shared core rejected free with status ${status}`);
      }
    }

    #checkMemory() {
      const byteLength = this.instance.exports.memory?.buffer?.byteLength;
      if (!Number.isSafeInteger(byteLength) || byteLength > MAX_MEMORY_BYTES) {
        throw new Error("Shared core linear memory exceeds its host limit");
      }
    }

    #requireRange(pointer, length, label) {
      this.#checkMemory();
      const byteLength = this.instance.exports.memory.buffer.byteLength;
      if (!Number.isSafeInteger(pointer) || !Number.isSafeInteger(length) ||
          pointer <= 0 || length <= 0 || pointer > byteLength || length > byteLength - pointer) {
        throw new RangeError(`${label} is outside shared-core linear memory`);
      }
    }
  }

  return { SharedCore, CORE_SHA256, CORE_URL };
});
