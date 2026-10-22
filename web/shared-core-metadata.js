"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "d46dab94267622d3cc2e7f5daab5d37f1335853711243658e4feef0dd3a2d38d";
  return Object.freeze({
    coreCommit: "67475897d6b841aa76a0e49eec90730ede173940",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
