"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appCss = fs.readFileSync(path.join(__dirname, "app.css"), "utf8");

function narrowBlock() {
  const start = appCss.indexOf("@media (max-width: 640px)");
  assert.ok(start >= 0, "narrow breakpoint exists");
  return appCss.slice(start);
}

function mastheadBlock(narrow) {
  const match = narrow.match(/\.masthead\s*\{[^}]*\}/);
  assert.ok(match, "narrow masthead exists");
  return match[0];
}

function mainBlock(narrow) {
  const match = narrow.match(/(^|\n)\s*main\s*\{[^}]*\}/);
  assert.ok(match, "narrow main exists");
  return match[0];
}

function footerBlock(narrow) {
  const match = narrow.match(/\.site-footer\s*\{[^}]*\}/);
  assert.ok(match, "narrow footer exists");
  return match[0];
}

test("R48-S08 narrow masthead preserves measured top and side insets", () => {
  const masthead = mastheadBlock(narrowBlock());
  assert.match(masthead, /env\(safe-area-inset-top/);
  assert.match(masthead, /env\(safe-area-inset-left/);
  assert.match(masthead, /env\(safe-area-inset-right/);
  assert.doesNotMatch(masthead, /padding:\s*1rem\s*;/);
});

test("R48-S08 narrow main preserves measured side and bottom insets", () => {
  const main = mainBlock(narrowBlock());
  assert.match(main, /env\(safe-area-inset-left/);
  assert.match(main, /env\(safe-area-inset-right/);
  assert.match(main, /env\(safe-area-inset-bottom/);
  assert.doesNotMatch(main, /padding:\s*1rem 0\.75rem 3\.5rem\s*;/);
});

test("R48-S08 narrow footer preserves measured side insets", () => {
  const footer = footerBlock(narrowBlock());
  assert.match(footer, /env\(safe-area-inset-left/);
  assert.match(footer, /env\(safe-area-inset-right/);
  assert.doesNotMatch(footer, /padding-inline:\s*1rem\s*;/);
});

test("R48-S08 base rules still carry full inset contributions", () => {
  assert.match(appCss, /\.masthead[\s\S]{0,400}env\(safe-area-inset-top/);
  assert.match(appCss, /calc\(5rem \+ env\(safe-area-inset-bottom/);
  assert.match(appCss, /\.site-footer[\s\S]{0,400}env\(safe-area-inset-bottom/);
});
