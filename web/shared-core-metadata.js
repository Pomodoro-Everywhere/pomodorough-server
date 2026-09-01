"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "f735303cbd13a1671090b7ecd1e9c96a210ca007d8a35244bdf8028772c66eb6";
  return Object.freeze({
    coreCommit: "542aca9a322a1b04c3e53d4a76152f385675d0a1",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
