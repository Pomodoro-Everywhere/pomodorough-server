"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "4338e8dbfe5c34a5770344cefb0d55f7c5eb0f6d668cc87c926aae84cdb1c900";
  return Object.freeze({
    coreCommit: "6b273da6d5cf6efa7cab585263a415bca377ac60",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
