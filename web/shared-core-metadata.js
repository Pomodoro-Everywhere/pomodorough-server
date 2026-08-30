"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "4a58bd2b702e0d43d6f2262d21f7e940dfdf05cc911d6519b67c1b5e988d8b0b";
  return Object.freeze({
    coreCommit: "440f5364f036d02d46abca048f09b893b0134791",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
