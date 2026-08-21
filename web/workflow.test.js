"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("Iroh activation guidance covers signed-out first-room setup and Web scope", () => {
  const contract = fs.readFileSync(path.join(__dirname, "..", "docs", "client-experience-contract.md"), "utf8");
  assert.match(contract, /Create room.*Join room/s);
  assert.match(contract, /signed out/i);
  assert.match(contract, /must not persist (?:Iroh mode|an unusable route)/i);
  assert.match(contract, /Web\/PWA.*does not expose an Iroh route/i);
});

test("release command receives explicit GitHub repository context", () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, "..", ".github", "workflows", "release.yml"),
    "utf8"
  );
  assert.match(workflow, /GH_REPO:\s*\$\{\{ github\.repository \}\}/);
  assert.match(workflow, /gh release create "\$GITHUB_REF_NAME"/);
});
