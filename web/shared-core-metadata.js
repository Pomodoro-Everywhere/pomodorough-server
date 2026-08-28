"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "f96e712ca8350ca038888316ad2fc8bd0f08f72b3bc984f916f1127c644e776c";
  return Object.freeze({
    coreCommit: "4802ba99f9d97ee8d3aee3a84468b2f8c91ee443",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
