"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "f34fe57b5e080dd69afa5c7f28b60bc77851c7f874db99744eab72b4e1858877";
  return Object.freeze({
    coreCommit: "44ff36e125cf653c1761dfb5951f6e77e41a2c82",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
