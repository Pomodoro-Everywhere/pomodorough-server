"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "f57b411f47ef614e78ebb1ed4aea9ae58e0f1156b385c25222ee5c006837ebfd";
  return Object.freeze({
    coreCommit: "f3ab43a348d4e17bb32b61b8325664351e2ed70e",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
