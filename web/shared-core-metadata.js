"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "6605f844e7464d8f6f7e9f3be641ffc7dfbc8733ba78c93efd6bc0188799f8ba";
  return Object.freeze({
    coreCommit: "2b66cfe1d83910ae085407d9fe7b76f2d485347d",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
