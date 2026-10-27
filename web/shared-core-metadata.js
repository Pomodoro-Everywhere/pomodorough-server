"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "1e72c2bbc178b077fdcc98210f06f66f4bc5332b77be5de83be19792376f4bd4";
  return Object.freeze({
    coreCommit: "0f52a27aa24941bf873bda65612f2c9ede43825f",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
