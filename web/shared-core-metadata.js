"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "59b5f540a9c2a5ad98a021d3e18aaafb3877266295a69c2992ba0f4aba4de12e";
  return Object.freeze({
    coreCommit: "15cdd9297e837f6c54f983517d0a78b24b5403b5",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
