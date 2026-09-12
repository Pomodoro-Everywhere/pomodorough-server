"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "ac96b0581acb7b877e6ffc356b307b75779a00ff538fe6d59b39ca0d5e146466";
  return Object.freeze({
    coreCommit: "1d30e00ba7235e2214c274ea5499987b2b996d18",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
