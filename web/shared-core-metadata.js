"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "3d31beac95a8dcd6f6595e70acd8c116a4c15bb8accf62d9b85b3b1295b93a0e";
  return Object.freeze({
    coreCommit: "42179403671559beccc0889a8af33b7b285716ed",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
