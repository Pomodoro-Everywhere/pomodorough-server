"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "3ec4ca03393a5822d3c5cb3b4c3c654a1cb7b0cae1938b731bd8e6505360a73d";
  return Object.freeze({
    coreCommit: "cd3c129438309cba33f2aead6f3bc72257cd5564",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
