"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "e7b05b66569ba4e3735b8d935aa0cbdf24f71d17f1c221b84e612e8155f778a8";
  return Object.freeze({
    coreCommit: "ca552f64308de254b6c4f70ce5efa1e1f1f4271a",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
