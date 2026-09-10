"use strict";

(function (root, factory) {
  const metadata = factory();
  if (typeof module === "object" && module.exports) module.exports = metadata;
  if (root) root.PomodoroughSharedCoreMetadata = metadata;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const sha256 = "bd0a00ae05abc4ecdd2702cd14f96dcd5a77814e46edb7c68fbb5fdf7d8e9740";
  return Object.freeze({
    coreCommit: "b0de2386e41c4b3189eff537e761b8cdfa2b4cdd",
    sha256,
    wasmURL: `/pomodorough_core.wasm?sha256=${sha256}`,
    cacheVersion: `core-${sha256.slice(0, 16)}`
  });
});
