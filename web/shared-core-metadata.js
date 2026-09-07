"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "bb2764775417760c64309626e40503f0edc722493ec0a0833b9b92a27841f9ff";
  return Object.freeze({
    coreCommit: "47fec2008f60ae643b3bfba6ed39faa7d0b68ce5",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
