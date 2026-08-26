"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "1e67043a8a652c5f9c6d36b28fe280b4bb5677e0c0279faaccdceb407181face";
  return Object.freeze({
    coreCommit: "8dc24486b38d87eb2c717e80b4315b31dd6a671d",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
