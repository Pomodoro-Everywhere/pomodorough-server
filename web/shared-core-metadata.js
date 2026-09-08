"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "7d220f35d927931f8f97d9c453071a3a9bb23a9082e5b9a3b9d42fdd16de8f79";
  return Object.freeze({
    coreCommit: "70169bb05c1e046c54c6be3b0760ef0015243bb7",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
