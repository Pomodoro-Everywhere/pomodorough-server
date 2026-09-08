"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "449e38747e161ba6d7fe6de984e0dc54bde62ee5a058a91250ff7af357634b44";
  return Object.freeze({
    coreCommit: "28b21195ce0057bc0e510aa21bd3c29d94c5b162",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
