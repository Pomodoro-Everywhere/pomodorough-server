"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "150d5aa6f1eef08e89bfd33e863897938ae5df6fc9f38a730796e41ba48ed6fa";
  return Object.freeze({
    coreCommit: "b25e0d8ef76a564e1201a02b78afe88d5710a30e",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
