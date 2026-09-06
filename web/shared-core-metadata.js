"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "c7b37d9f5c105db8007543e6d10065f3e8b6d23960052bbd43b606cff9a6c6de";
  return Object.freeze({
    coreCommit: "f6da7e92f7bcc40beb1aea3a6f1ad5f9e6783b6b",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
