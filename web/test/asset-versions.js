"use strict";

// Ledger of committed asset versions in web/test/asset-versions.json. A
// versioned URL such as /app-view.js?v=11 names one byte sequence, and a shell
// cache name such as pomodorough-shell-v71- names one set of versioned URLs.
// Browsers and the service worker keep both for as long as the name is live,
// so a recorded entry must never change. Run
// `node web/test/asset-versions.js --write` on a release tree to record its
// versions; the writer adds new entries and refuses to rewrite recorded ones.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const webRoot = path.join(__dirname, "..");
const ledgerPath = path.join(__dirname, "asset-versions.json");
const referenceSources = ["app.html", "index.html", "privacy.html", "sw.js"];
// The closing quote is part of the pattern: /app.css?v=210 is not v=21.
const quotedReference = /"(\/[^"?]+)\?v=(\d+)"/g;
const localeFetch = /`\/locales\/\$\{candidate\}\.json\?v=(\d+)`/;
const shellCacheName = /`(pomodorough-shell-v\d+-)\$\{/;

function readWeb(relative) {
  return fs.readFileSync(path.join(webRoot, relative), "utf8");
}

function versionedReferences() {
  const references = [];
  for (const source of referenceSources) {
    for (const [, assetPath, version] of readWeb(source).matchAll(quotedReference)) {
      references.push({ source, assetPath, version: Number(version) });
    }
  }
  const locale = readWeb("i18n.js").match(localeFetch);
  if (!locale) throw new Error("i18n.js has no versioned locale fetch");
  const catalogs = fs.readdirSync(path.join(webRoot, "locales")).filter((name) => name.endsWith(".json")).sort();
  for (const catalog of catalogs) {
    references.push({ source: "i18n.js", assetPath: `/locales/${catalog}`, version: Number(locale[1]) });
  }
  return references;
}

function assetKey({ assetPath, version }) {
  return `${assetPath}?v=${version}`;
}

function fileDigest(assetPath) {
  const bytes = fs.readFileSync(path.join(webRoot, ...assetPath.slice(1).split("/")));
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function currentVersions(references = versionedReferences()) {
  const assets = {};
  for (const reference of references) assets[assetKey(reference)] = fileDigest(reference.assetPath);
  const cacheName = readWeb("sw.js").match(shellCacheName);
  if (!cacheName) throw new Error("sw.js has no versioned shell cache name");
  const shell = [...new Set(references.filter(({ source }) => source === "sw.js").map(assetKey))].sort();
  return { assets, shells: { [cacheName[1]]: shell } };
}

function sortedEntries(section) {
  return Object.fromEntries(Object.entries(section).sort(([left], [right]) => (left < right ? -1 : 1)));
}

// Returns the ledger with every current entry recorded, plus the recorded keys
// whose current value differs. A conflicting key keeps its recorded value.
function updateLedger(ledger, current) {
  const next = { assets: { ...ledger.assets }, shells: { ...ledger.shells } };
  const conflicts = [];
  for (const section of ["assets", "shells"]) {
    for (const [key, value] of Object.entries(current[section])) {
      const recorded = next[section][key];
      if (recorded !== undefined && JSON.stringify(recorded) !== JSON.stringify(value)) {
        conflicts.push(key);
        continue;
      }
      next[section][key] = value;
    }
  }
  return { ledger: { assets: sortedEntries(next.assets), shells: sortedEntries(next.shells) }, conflicts };
}

function readLedger() {
  return JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
}

function main(argv) {
  if (argv.length !== 1 || argv[0] !== "--write") {
    console.error("usage: node web/test/asset-versions.js --write");
    return 2;
  }
  const { ledger, conflicts } = updateLedger(readLedger(), currentVersions());
  if (conflicts.length > 0) {
    console.error(`recorded entries changed without a new version: ${conflicts.join(", ")}`);
    return 1;
  }
  fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { currentVersions, readLedger, updateLedger, versionedReferences };
