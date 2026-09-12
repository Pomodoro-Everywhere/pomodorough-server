"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "5f6b39f0cf8bf1aa7ec9c280c4c9cfd5dfd50f252d97c4f0722b5b75cf55ba17";
  return Object.freeze({
    coreCommit: "aa08835ac59cad25e1d52fa8a27c0eb907033520",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
