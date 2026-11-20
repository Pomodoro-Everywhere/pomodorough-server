"use strict";

// Static stylesheet checks for UX round 3 PWA items. The Chromium screenshots
// in the round 3 report show the rendered result.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appCss = fs.readFileSync(path.join(__dirname, "app.css"), "utf8");
const landingCss = fs.readFileSync(path.join(__dirname, "landing.css"), "utf8");

function forcedColorsBlock(css) {
  const start = css.indexOf("@media (forced-colors: active)");
  assert.notEqual(start, -1, "a forced-colors block exists");
  let depth = 0;
  for (let index = css.indexOf("{", start); index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    if (depth === 0) return css.slice(start, index + 1);
  }
  throw new Error("unterminated forced-colors block");
}

test("PWA-09 forced colours mark the selected tab and the pressed phase with system Highlight", () => {
  const block = forcedColorsBlock(appCss);
  const rule = /\.screen-nav button\[aria-selected="true"\],\s*\.phase-button\[aria-pressed="true"\]\s*\{([^}]*)\}/.exec(block);
  assert.ok(rule, "selected tab and pressed phase share a forced-colors rule");
  assert.match(rule[1], /forced-color-adjust:\s*none/);
  assert.match(rule[1], /color:\s*HighlightText/);
  assert.match(rule[1], /background:\s*Highlight/);
  assert.match(block, /\.phase-button\[aria-pressed="true"\] \.phase-index\s*\{[^}]*color:\s*HighlightText/);
});

test("PWA-10 app and landing footer links are at least 44 px tall", () => {
  assert.match(appCss, /\.site-footer a \{[^}]*display:\s*inline-flex;[^}]*min-height:\s*2\.75rem/);
  assert.match(appCss, /\.site-footer \{[^}]*align-items:\s*center/);
  assert.match(landingCss, /\nfooter a \{[^}]*display:\s*inline-flex;[^}]*min-height:\s*2\.75rem/);
});

test("PWA-15 no app text is set below 11 px", () => {
  const sizes = [...appCss.matchAll(/font-size:\s*(?:clamp\()?(\d*\.?\d+)rem/g)].map((match) => Number(match[1]));
  assert.ok(sizes.length > 20);
  const small = sizes.filter((size) => size < 0.6875);
  assert.deepEqual(small, [], `font sizes below 0.6875rem: ${small.join(", ")}`);
  assert.match(appCss, /\.phase-index \{[^}]*font-size:\s*0\.6875rem/);
});

test("PWA-21 stacked sign-out recovery buttons share a left edge", () => {
  assert.match(appCss, /\.bootstrap-actions \.bootstrap-signout \{\s*margin-inline-start:\s*0;\s*\}/);
});
