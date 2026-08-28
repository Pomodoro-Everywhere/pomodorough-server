"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "69ecfeb3bf292866dca2c9dba936120cb6839a761111ce19087e30cbff1428a4";
  return Object.freeze({
    coreCommit: "71c85020eab69a803ab0d3046aa7abef890c4780",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
