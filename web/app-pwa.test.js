"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const webDir = __dirname;
const appHtml = fs.readFileSync(path.join(webDir, "app.html"), "utf8");
const indexHtml = fs.readFileSync(path.join(webDir, "index.html"), "utf8");
const appCss = fs.readFileSync(path.join(webDir, "app.css"), "utf8");
const landingCss = fs.readFileSync(path.join(webDir, "landing.css"), "utf8");

test("W1 viewport-fit cover on app and landing pages", () => {
  assert.match(appHtml, /name="viewport"[^>]*viewport-fit=cover/);
  assert.match(indexHtml, /name="viewport"[^>]*viewport-fit=cover/);
});

test("W1 safe-area insets on masthead, content, and footer", () => {
  assert.match(appCss, /\.masthead[\s\S]{0,400}env\(safe-area-inset-top/);
  assert.match(appCss, /env\(safe-area-inset-left/);
  assert.match(appCss, /env\(safe-area-inset-right/);
  assert.match(appCss, /calc\(5rem \+ env\(safe-area-inset-bottom/);
  assert.match(appCss, /\.site-footer[\s\S]{0,400}env\(safe-area-inset-bottom/);
  assert.match(landingCss, /\.masthead[\s\S]{0,400}env\(safe-area-inset-top/);
  assert.match(landingCss, /footer[\s\S]{0,400}env\(safe-area-inset-bottom/);
});

test("W2 tab list uses grid two-column layout at 375px", () => {
  const small = appCss.slice(appCss.indexOf("@media (max-width: 640px)"));
  assert.match(small, /\.screen-nav \[role="tablist"\][\s\S]{0,200}display: grid/);
  assert.match(small, /\.screen-nav \[role="tablist"\][\s\S]{0,200}repeat\(2, minmax\(0, 1fr\)\)/);
});

test("W3 pomodoro progress exposed with role img, decorative spans hidden", () => {
  assert.match(appHtml, /id="longBreakProgress"[^>]*role="img"[^>]*aria-label/);
  assert.match(appHtml, /id="phaseLabel"[^>]*aria-hidden="true"/);
  assert.match(appHtml, /id="timerDetail"[^>]*aria-hidden="true"/);
  assert.match(appHtml, /id="timerDisplay"[^>]*role="timer"/);
});

test("W4 touch targets meet 44px minimum", () => {
  assert.match(appCss, /\.text-button,[\s\S]{0,120}min-height: 2\.75rem/);
  assert.match(appCss, /\.screen-nav button \{[\s\S]{0,120}min-height: 2\.75rem/);
  assert.match(appCss, /\.stepper button \{[\s\S]{0,200}min-width: 2\.75rem/);
  assert.match(appCss, /\.action-clear \{[\s\S]{0,120}min-height: 2\.75rem/);
  assert.match(appCss, /\.task-delete \{[\s\S]{0,200}min-height: 2\.75rem/);
  assert.doesNotMatch(appCss, /\.stepper \{\s*\n\s*display: grid;\s*\n\s*grid-template-columns: 2\.55rem/);
});

test("W5 wide Duo breakpoint places timer beside rail with hinge gap", () => {
  assert.match(appCss, /@media \(min-width: 921px\)[\s\S]{0,300}\.workbench[\s\S]{0,200}grid-template-columns: minmax\(0, 1\.15fr\) minmax\(0, 0\.85fr\)/);
  assert.match(appCss, /@media \(horizontal-viewport-segments: 2\)[\s\S]{0,200}env\(viewport-segment-gap/);
});
