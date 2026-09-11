"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "cdb4e6184d8e88e36e20ed798372218c023fcdbf55f8b97bb015cb17f1e6cab8";
  return Object.freeze({
    coreCommit: "6561ce0e33584ff642e74eb84f412f4382c73b7a",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
