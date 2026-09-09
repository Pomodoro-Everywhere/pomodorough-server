"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "f119e7d374e33e1ad2822554ebf93c836263c9b81bae2480b20523aeefa6a55e";
  return Object.freeze({
    coreCommit: "a8bcd1553239821a892dd2fab029b2aa2e8f3a08",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
