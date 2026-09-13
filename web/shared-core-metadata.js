"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "df872e14be9a4220cd28823f8dff5c07fd3023c11a371e7c5247366c16c7223c";
  return Object.freeze({
    coreCommit: "c145822d0e669d6e782090c1ff7f5051357a9685",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
