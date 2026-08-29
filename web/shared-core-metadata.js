"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "33cb3bc7477a8075a9613e45b309495e44d28f794e6b88362a8073d505309f5a";
  return Object.freeze({
    coreCommit: "dda034612bd9a8b3d0f56959d9eef888980acc7b",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
