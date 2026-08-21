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
  const MAX_INPUT_BYTES = 64 * 1024 * 1024;
  const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
  const MAX_MEMORY_BYTES = 256 * 1024 * 1024;

  class SharedCore {
    constructor(instance) {
      this.instance = instance;
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

      let operationPointer = 0;
      let inputPointer = 0;
      let resultPointer = 0;
      let resultLength = 0;
      try {
        this.#checkMemory();
        operationPointer = this.#allocateAndWrite(operationBytes);
        inputPointer = this.#allocateAndWrite(inputBytes);
        const packed = this.instance.exports.pomodorough_dispatch(
          operationPointer,
          operationBytes.length,
          inputPointer,
          inputBytes.length
        );
        const packedResult = BigInt.asUintN(64, packed);
        resultPointer = Number(packedResult & 0xffff_ffffn);
        resultLength = Number(packedResult >> 32n);
        if (!resultPointer || !resultLength) throw new Error("Shared core returned an empty result buffer");
        if (resultLength > MAX_OUTPUT_BYTES) throw new Error("Shared core result is too large");
        this.#requireRange(resultPointer, resultLength, "dispatch result");
        const resultBytes = new Uint8Array(
          new Uint8Array(this.instance.exports.memory.buffer, resultPointer, resultLength)
        );
        const ownedBuffers = [
          [resultPointer, resultLength],
          [inputPointer, inputBytes.length],
          [operationPointer, operationBytes.length]
        ];
        resultPointer = inputPointer = operationPointer = 0;
        this.#releaseAll(ownedBuffers);
        const envelope = JSON.parse(decoder.decode(resultBytes));
        if (!envelope || envelope.ok !== true || !("value" in envelope)) {
          throw new Error(envelope?.error || "Shared core returned an invalid envelope");
        }
        return envelope.value;
      } catch (primary) {
        try {
          this.#releaseAll([
            [resultPointer, resultLength],
            [inputPointer, inputBytes.length],
            [operationPointer, operationBytes.length]
          ]);
        } catch (cleanup) {
          primary.cleanupError = cleanup;
        }
        throw primary;
      }
    }

    #allocateAndWrite(bytes) {
      const pointer = this.instance.exports.pomodorough_alloc(bytes.length);
      if (!pointer) throw new Error("Shared core allocation failed");
      try {
        this.#requireRange(pointer, bytes.length, "allocated input");
        new Uint8Array(this.instance.exports.memory.buffer, pointer, bytes.length).set(bytes);
        return pointer;
      } catch (error) {
        this.instance.exports.pomodorough_free(pointer, bytes.length);
        throw error;
      }
    }

    #releaseAll(buffers) {
      let failure = null;
      for (const [pointer, length] of buffers) {
        if (!pointer || !length) continue;
        try {
          this.instance.exports.pomodorough_free(pointer, length);
        } catch (error) {
          if (!failure) failure = error;
        }
      }
      if (failure) throw failure;
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
