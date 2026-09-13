"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "02443da7067f9592e670a8d70fd25ae0ca1fccc271141e5a501c46bdfa0c70d1";
  return Object.freeze({
    coreCommit: "10bbfea40f84d689e2a6d637483b2f018db005d1",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
