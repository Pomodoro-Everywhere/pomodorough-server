"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "3fec2bf5ea6fc0c2a8ddec862fbaed0cb2fabe14e466ee4dfa3fb80b99d4da49";
  return Object.freeze({
    coreCommit: "7cdc404cb5d0ae7aed0c675dfc9e1c0faf8f39af",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
