"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "cb2d552c7b016905e6bee6a74f4f1830188d09c2d37966f951c430b8efa0584c";
  return Object.freeze({
    coreCommit: "6b69bba9fad26b02f073b27c502bccc38b131458",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
