"use strict";

(function (root, factory) {
  const exported = factory();
  if (typeof module === "object" && module.exports) module.exports = exported;
  if (root) root.PomodoroughSharedCore = exported;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const CORE_SHA256 = "89fb6300324042b61d62070242cccad10e30f125885bb1b7a05af67b077bac83";
  const CORE_URL = `/pomodorough_core.wasm?sha256=${CORE_SHA256}`;
  const MAX_OPERATION_BYTES = 256;
  const MAX_INPUT_BYTES = 16 * 1024 * 1024;
  const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
  const MAX_MEMORY_BYTES = 256 * 1024 * 1024;

  class SharedCore {
    constructor(instance) {
      this.instance = instance;
      this.unusableCause = null;
      const exports = instance.exports;
      for (const name of [
        "memory",
        "pomodorough_alloc",
        "pomodorough_free",
        "pomodorough_dispatch"
      ]) {
        if (!exports[name]) throw new Error(`Shared core is missing export ${name}`);
      }
      this.#checkMemory();
    }

    static async fromBytes(bytes) {
      const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (source.byteLength > MAX_INPUT_BYTES) throw new Error("Shared core module is too large");
      const { instance } = await WebAssembly.instantiate(source, {});
      return new SharedCore(instance);
    }

    static async load(url = CORE_URL) {
      const response = await fetch(url, { credentials: "same-origin", cache: "no-cache" });
      if (!response.ok) throw new Error(`Unable to load shared core: HTTP ${response.status}`);
      return SharedCore.fromBytes(await response.arrayBuffer());
    }

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
          primary.cleanupErrors = cleanupErrors;
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
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).sort().join(",") !== "id,title,utf8Bytes" ||
          typeof value.id !== "string" || !uuid.test(value.id) ||
          typeof value.title !== "string" || !value.title ||
          !Number.isSafeInteger(value.utf8Bytes) || value.utf8Bytes < 1 ||
          value.utf8Bytes !== encoder.encode(value.title).length) {
        throw new Error("Shared core returned an invalid task identity");
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
          this.instance.exports.pomodorough_free(pointer, bytes.length);
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
          this.instance.exports.pomodorough_free(pointer, length);
        } catch (error) {
          failures.push(error);
        }
      }
      return failures;
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
