"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "58a906927bae3b184684fffa7825cf46cd4bf71326533128372881ed0275b079";
  return Object.freeze({
    coreCommit: "9a77f1d3f90cd1f1a33ddb77d447a6eca05ed43f",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
