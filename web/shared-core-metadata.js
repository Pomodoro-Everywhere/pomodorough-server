"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "0c6bb71dfb5949e1fe9c3d4adcc8151b99607ad24545b5d1b2fc00ae8d359a74";
  return Object.freeze({
    coreCommit: "a816597514939df5c92b62b1c2d6a4d6adc4e833",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
