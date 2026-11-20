"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "d8d9cb553aa719bf1c7fe6ece1dc7fee28afc23ddeebc040e2a76d45938a8a75";
  return Object.freeze({
    coreCommit: "a5275096659eb31fc1eeed8666a7a9914a9cfdd8",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
