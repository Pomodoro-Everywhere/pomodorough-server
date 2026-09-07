"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "7dd0e190a15f429bcc9b942027c9c06dd645c9c550a6a66050f58c9ec3052cdb";
  return Object.freeze({
    coreCommit: "fc6ddf43f063f839a9383d95bd33edc02fecc587",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
