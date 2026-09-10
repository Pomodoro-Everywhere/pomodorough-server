"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "3c2bcb5a35caacf22dcf13291f139f05e2c530d2c0823e7a1bd7b095a58e5bd5";
  return Object.freeze({
    coreCommit: "e4fed82d6902f226fa1063bc3489f5e44828abfb",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
