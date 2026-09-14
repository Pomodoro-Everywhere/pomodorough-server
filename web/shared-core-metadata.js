"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "a8d0b3bbaaffa67c3704ffd555e7abf0e5b2ad712c29a7259a3b36a9c2d14f38";
  return Object.freeze({
    coreCommit: "2a134e23b6b4011e025134f69fa0d1ab35642045",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
