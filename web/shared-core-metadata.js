"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "7b1436dc24e7fedb52f52bd193be78a775f062bdfc4fcef25bb41caf5325e379";
  return Object.freeze({
    coreCommit: "2af512330656b956839198f0c019b0031b2c1a8f",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
