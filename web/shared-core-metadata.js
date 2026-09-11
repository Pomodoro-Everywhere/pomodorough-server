"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "723a3e642aaf29f0f68bcc38ecf2ec0e97ad05912787785dc459d7425c6f545f";
  return Object.freeze({
    coreCommit: "c7a5b0ea110ae75df1f4629881220b850d5f7ea2",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
