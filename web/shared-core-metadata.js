"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "659a492ee2543e8166526b8bb7a7b4b51aef43447aba4c97b5baa841f924cbfa";
  return Object.freeze({
    coreCommit: "238ef9fb9bff60d541da00b9b58b72b0d68d1f4d",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
