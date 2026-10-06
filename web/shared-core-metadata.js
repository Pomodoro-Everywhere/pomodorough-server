"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "45501a8ae1dbce441c7b21c1a3862c00c69215ffd59a1754e8ca972224f3fbc3";
  return Object.freeze({
    coreCommit: "1d34fd23ea3f2bb99a8167419addd020709eb24c",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
