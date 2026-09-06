"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "82f114f9907b5f86f19f7cf99ef07b24ff5a0c55e23652f7be038a73c89dd91e";
  return Object.freeze({
    coreCommit: "ccc62578b621bab5ee4132e604b99371b171f8f1",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
