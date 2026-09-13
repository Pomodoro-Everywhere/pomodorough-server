"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "94bba0da3dec697e29c83b60917debeb5074911d4bbd1562fbf8dc2238c452d3";
  return Object.freeze({
    coreCommit: "f72d7ded96d78ed559ff6463e2d59de10181bfb0",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
