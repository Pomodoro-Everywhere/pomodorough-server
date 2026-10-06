"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "55cbddc547933a75a4f20dbf46bbfab9f1274689c2f1a8b631af3e6d8a2815a4";
  return Object.freeze({
    coreCommit: "4c16270f2da6f4a65a2813070670f2ac98624ad0",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
