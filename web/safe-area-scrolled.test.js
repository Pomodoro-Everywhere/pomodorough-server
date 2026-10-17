"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appCss = fs.readFileSync(path.join(__dirname, "app.css"), "utf8");

function narrow370Block() {
  const start = appCss.indexOf("@media (max-width: 370px)");
  assert.ok(start >= 0, "370px breakpoint exists");
  const end = appCss.indexOf("@container (max-width: 24rem)", start);
  assert.ok(end > start, "container stacking follows narrow breakpoints");
  return appCss.slice(start, end);
}

function durationBlock(narrow) {
  const match = narrow.match(/\.duration-row\s*\{[^}]*\}/);
  assert.ok(match, "370px duration-row exists");
  return match[0];
}

function stepperBlock(narrow) {
  const match = narrow.match(/\.stepper\s*\{[^}]*\}/);
  assert.ok(match, "370px stepper exists");
  return match[0];
}

test("R49-S06 narrow duration rows stack to usable content width", () => {
  const row = durationBlock(narrow370Block());
  assert.match(row, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.doesNotMatch(row, /minmax\(6\.5rem/);
  assert.doesNotMatch(row, /minmax\(8\.75rem/);
});

test("R49-S06 narrow stepper keeps targets and stretches", () => {
  const stepper = stepperBlock(narrow370Block());
  assert.match(stepper, /grid-template-columns:\s*2\.75rem minmax\(0,\s*1fr\) 2\.75rem/);
  assert.match(stepper, /align-self:\s*stretch/);
});

test("R49-S06 preserves safe-area insets and S05 container stacking", () => {
  assert.match(appCss, /env\(safe-area-inset-left/);
  assert.match(appCss, /env\(safe-area-inset-right/);
  assert.match(appCss, /env\(safe-area-inset-bottom/);
  assert.match(appCss, /\.recipe-rail\s*\{[^}]*container-type:\s*inline-size/);
  assert.match(appCss, /@container \(max-width: 24rem\)[\s\S]{0,200}\.duration-row/);
});
