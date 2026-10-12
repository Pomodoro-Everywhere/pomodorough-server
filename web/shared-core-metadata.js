"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "775d3d85cc4f6ced2243fd8b831e0057d6264e2202fdc2bf28d83b62e311e05a";
  return Object.freeze({
    coreCommit: "3c609d4f2dd87a9d201f928772a466af7ab70581",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
