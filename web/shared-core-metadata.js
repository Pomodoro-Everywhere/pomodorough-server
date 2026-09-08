"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "658c3c60a90f7ee0b2131b4af8fa10b60c3f79417789a41bea5ea6712ea5a619";
  return Object.freeze({
    coreCommit: "e90929f6877c1a07e13964d00b942f09eeb5dfa8",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
