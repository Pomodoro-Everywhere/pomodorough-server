"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "e83b0ed6905317368fd13b4aa8891a305df7132e33bbee1baca6f47056fc15f7";
  return Object.freeze({
    coreCommit: "20f9696b9a7c5dd9f0a253b21a5c9bd225f9e9b2",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
