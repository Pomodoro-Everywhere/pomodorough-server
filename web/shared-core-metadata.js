"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "2699e1eaad02fa6819fdd9ef5452b51965a046c326543f4feca9eb2ecfe07789";
  return Object.freeze({
    coreCommit: "78888ca92c4866fc3ec6928ba52022eab9e13371",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
