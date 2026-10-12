"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appCss = fs.readFileSync(path.join(__dirname, "app.css"), "utf8");

function horizontalBlock() {
  const start = appCss.indexOf("@media (horizontal-viewport-segments: 2)");
  assert.ok(start >= 0, "horizontal segment rule exists");
  const next = appCss.indexOf("@media (vertical-viewport-segments: 2)", start);
  return next < 0 ? appCss.slice(start) : appCss.slice(start, next);
}

function verticalBlock() {
  const start = appCss.indexOf("@media (vertical-viewport-segments: 2)");
  assert.ok(start >= 0, "vertical segment rule exists");
  return appCss.slice(start);
}

test("R48-S09 no fallback gap or guessed offset", () => {
  assert.doesNotMatch(appCss, /viewport-segment-gap/);
  const segmentCss = horizontalBlock() + verticalBlock();
  assert.doesNotMatch(segmentCss, /470px|490px|320px/);
});

test("R48-S09 horizontal derives usable bounds and gap", () => {
  const block = horizontalBlock();
  assert.match(block, /env\(viewport-segment-width 0 0/);
  assert.match(block, /env\(viewport-segment-left 1 0/);
  assert.match(block, /env\(viewport-segment-right 0 0/);
  assert.match(block, /column-gap:\s*calc\(env\(viewport-segment-left 1 0[^;]*-\s*env\(viewport-segment-right 0 0/);
});

test("R48-S09 task editor stays in usable segment", () => {
  const block = horizontalBlock();
  assert.match(block, /main\s*\{[^}]*env\(viewport-segment-width 0 0/);
  assert.match(block, /main\s*\{[^}]*env\(viewport-segment-left 0 0/);
  assert.match(block, /\.task-form\s*\{[^}]*env\(viewport-segment-width 0 0/);
});

test("R48-S09 vertical covers portrait with indexed bounds", () => {
  const block = verticalBlock();
  assert.match(block, /env\(viewport-segment-top 0 1/);
  assert.match(block, /env\(viewport-segment-bottom 0 0/);
  assert.match(block, /row-gap:\s*calc\(env\(viewport-segment-top 0 1[^;]*-\s*env\(viewport-segment-bottom 0 0/);
  assert.match(block, /main\s*\{[^}]*env\(viewport-segment-top 0 1/);
});
