"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appCss = fs.readFileSync(path.join(__dirname, "app.css"), "utf8");

function containerBlock(maxWidth) {
  const marker = `@container (max-width: ${maxWidth})`;
  const start = appCss.indexOf(marker);
  assert.ok(start >= 0, `${marker} exists`);
  const next = appCss.indexOf("@container", start + marker.length);
  const end = appCss.indexOf("@media (prefers-color-scheme: dark)", start);
  const stop = next >= 0 && next < end ? next : end;
  return appCss.slice(start, stop);
}

test("R49-S05 rail measures inline size for text-relative stacking", () => {
  assert.match(appCss, /\.recipe-rail\s*\{[^}]*container-type:\s*inline-size/);
});

test("R49-S05 narrow rail stacks selector and duration rows", () => {
  const block = containerBlock("24rem");
  assert.match(block, /\.duration-row[\s\S]{0,120}grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(block, /\.task-selector-row/);
  assert.match(block, /\.stepper\s*\{[^}]*align-self:\s*stretch/);
});

test("R49-S05 stepper keeps targets and stacks when input cannot fit", () => {
  assert.match(appCss, /\.stepper\s*\{[^}]*grid-template-columns:\s*2\.75rem minmax\(0,\s*1fr\) 2\.75rem/);
  assert.match(appCss, /\.stepper button\s*\{[^}]*min-width:\s*2\.75rem/);
  assert.match(appCss, /\.phase-button\s*\{[^}]*min-height:\s*3\.25rem/);
  const stacked = containerBlock("12rem");
  assert.match(stacked, /\.stepper\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test("R49-S05 header and rail headings wrap instead of overflowing", () => {
  assert.match(appCss, /\.masthead\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(appCss, /\.masthead-tools\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(appCss, /\.profile\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(appCss, /\.rail-heading\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(appCss, /\.wordmark-main\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(appCss, /\.history-heading\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(appCss, /\.tasks-heading\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(appCss, /\.history-count\s*\{[^}]*min-width:\s*0/);
  assert.match(appCss, /\.site-footer\s*\{[^}]*flex-wrap:\s*wrap/);
});

test("R49-S05 enlarged layout keeps text and target sizes", () => {
  assert.match(appCss, /\.phase-button\s*\{[^}]*font-size:\s*1\.05rem/);
  assert.match(appCss, /\.stepper button\s*\{[^}]*font-size:\s*1\.05rem/);
  assert.match(appCss, /\.text-button,[\s\S]{0,120}min-height:\s*2\.75rem/);
  assert.doesNotMatch(containerBlock("24rem"), /font-size:\s*0|display:\s*none/);
  assert.doesNotMatch(containerBlock("12rem"), /font-size:\s*0|display:\s*none/);
});

test("R49-S05 preserves safe-area insets and segment bounds", () => {
  assert.match(appCss, /env\(safe-area-inset-top/);
  assert.match(appCss, /env\(safe-area-inset-left/);
  assert.match(appCss, /env\(safe-area-inset-right/);
  assert.match(appCss, /env\(safe-area-inset-bottom/);
  assert.match(appCss, /env\(viewport-segment-width 0 0/);
  assert.match(appCss, /env\(viewport-segment-left 1 0/);
  assert.match(appCss, /env\(viewport-segment-right 0 0/);
  assert.doesNotMatch(appCss, /viewport-segment-gap/);
});
