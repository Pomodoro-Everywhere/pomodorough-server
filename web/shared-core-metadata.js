"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "0878d0e7297971dbe5a84208c3b9c7817f3648207b6ac78f0962c011ef34eec6";
  return Object.freeze({
    coreCommit: "cf818b8636a71a2b1470df12b844e48481f051e8",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
