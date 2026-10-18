"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "a5eeca32c464ca46ac6b61bc3ad2a1331dcf37696478a614037039e54ba5ce7f";
  return Object.freeze({
    coreCommit: "371f2b20fc2f1d9933610be6ad0d11ca561ffd9d",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
