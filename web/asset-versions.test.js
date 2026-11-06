"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { currentVersions, readLedger, updateLedger, versionedReferences } = require("./test/asset-versions.js");

test("pages, the service worker and the locale loader name one version per asset", () => {
  const versions = new Map();
  for (const { source, assetPath, version } of versionedReferences()) {
    if (!versions.has(assetPath)) versions.set(assetPath, {});
    versions.get(assetPath)[source] = version;
  }
  assert.ok(versions.has("/app.js") && versions.has("/locales/en.json"));
  for (const [assetPath, bySource] of versions) {
    assert.equal(new Set(Object.values(bySource)).size, 1, `${assetPath} versions differ: ${JSON.stringify(bySource)}`);
  }
});

test("a recorded asset version still names the same bytes", () => {
  const recorded = readLedger().assets;
  for (const [key, digest] of Object.entries(currentVersions().assets)) {
    if (recorded[key] !== undefined) assert.equal(digest, recorded[key], `${key} changed without a version bump`);
  }
});

test("a recorded shell cache name still names the same versioned assets", () => {
  const recorded = readLedger().shells;
  for (const [cacheName, assets] of Object.entries(currentVersions().shells)) {
    if (recorded[cacheName] !== undefined) {
      assert.deepEqual(assets, recorded[cacheName], `${cacheName} shell changed without a cache name bump`);
    }
  }
});

test("the ledger writer records new versions and refuses to rewrite recorded ones", () => {
  const ledger = { assets: { "/a.js?v=1": "one" }, shells: { "shell-v1-": ["/a.js?v=1"] } };
  const current = { assets: { "/a.js?v=1": "changed", "/a.js?v=2": "two" },
    shells: { "shell-v1-": ["/a.js?v=2"], "shell-v2-": ["/a.js?v=2"] } };
  const { ledger: next, conflicts } = updateLedger(ledger, current);
  assert.deepEqual(conflicts, ["/a.js?v=1", "shell-v1-"]);
  assert.deepEqual(next, { assets: { "/a.js?v=1": "one", "/a.js?v=2": "two" },
    shells: { "shell-v1-": ["/a.js?v=1"], "shell-v2-": ["/a.js?v=2"] } });
});
