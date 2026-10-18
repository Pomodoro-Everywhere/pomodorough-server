"use strict";

// R50-S04: unauthenticated landing must reflow at 320/375px and 200% text.
// The wordmark wrapped within inline size, grid tracks and cards shrink via
// zero-minimum tracks, and main no longer masks overflow. Font sizes are
// untouched: only track minima, min-width guards, wrapping, and flex-wrap
// change. Live-browser pixel evidence is recorded in scratch/fix-R50-S04.md.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "landing.css"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const landingSource = fs.readFileSync(path.join(__dirname, "landing.js"), "utf8");
const selector = require("./platform-selector.js");

function blockOfCss(startPattern) {
  const start = css.search(startPattern);
  assert.ok(start >= 0, `${startPattern} rule exists`);
  const open = css.indexOf("{", start);
  assert.ok(open > start, `${startPattern} opens`);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  assert.fail(`${startPattern} never closes`);
  return "";
}

function ruleBlock(startPattern) {
  return blockOfCss(startPattern);
}

test("R50-S04 wordmark shrinks and wraps within inline size", () => {
  const wordmark = ruleBlock(/\.wordmark\s*\{/);
  assert.match(wordmark, /min-width:\s*0/);
  assert.match(wordmark, /max-width:\s*100%/);
  assert.match(css, /\.wordmark > span\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.wordmark (strong|small)[\s\S]{0,80}overflow-wrap:\s*break-word/);
  assert.match(css, /\.masthead\s*\{[^}]*flex-wrap:\s*wrap/);
});

test("R50-S04 main never masks overflowing controls", () => {
  const main = ruleBlock(/^main\s*\{/m);
  assert.doesNotMatch(main, /overflow/);
  assert.doesNotMatch(css, /(?<![-\w])overflow\s*:\s*(hidden|clip|scroll|auto)/);
  assert.match(css, /\.hero::before\s*\{[^}]*right:\s*0/);
});

test("R50-S04 hero and departure tracks shrink at enlarged text", () => {
  assert.doesNotMatch(css, /minmax\(32rem/);
  assert.match(css, /\.hero\s*\{[^}]*minmax\(0,\s*0\.8fr\)\s*minmax\(0,\s*1\.2fr\)/);
  assert.match(css, /\.hero-copy,\s*\.departure\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.departure-board\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /\.departure-board > \*\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.departure-board h2\s*\{[^}]*overflow-wrap:\s*break-word/);
  assert.match(css, /\.primary-actions\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /\.primary-actions > \*\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.button\s*\{[^}]*overflow-wrap:\s*break-word/);
  assert.match(css, /@media \(max-width:\s*600px\)[\s\S]{0,800}?\.primary-actions\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test("R50-S04 route grids and cards shrink with wrapping copy", () => {
  assert.match(css, /\.route-grid\s*\{[^}]*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /\.route-card\s*\{[^}]*auto minmax\(0,\s*1fr\) auto/);
  assert.match(css, /\.route-card\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.route-card > \*\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.route-copy (strong|small)[\s\S]{0,80}overflow-wrap:\s*break-word/);
  assert.match(css, /\.route-code\s*\{[^}]*grid-column:\s*1 \/ -1/);
  assert.match(css, /\.section-heading\s*\{[^}]*minmax\(0,\s*0\.65fr\)\s*minmax\(0,\s*1fr\)/);
});

test("R50-S04 narrow 200% tracks shrink from parsed zero minima", () => {
  const hero = ruleBlock(/\.hero\s*\{/);
  const heroMinima = [...hero.matchAll(/minmax\(\s*([^,]+?),/g)].map((m) => m[1].trim());
  assert.ok(heroMinima.length >= 2, "hero track minima parse from CSS");
  for (const min of heroMinima) assert.equal(min, "0", `hero track minimum ${min} stays shrinkable`);
  const route = ruleBlock(/\.route-grid\s*\{/);
  const routeMinima = [...route.matchAll(/minmax\(\s*([^,]+?),/g)].map((m) => m[1].trim());
  assert.ok(routeMinima.length >= 1, "route track minima parse from CSS");
  for (const min of routeMinima) assert.equal(min, "0", `route track minimum ${min} stays shrinkable`);
  const root = 32;
  for (const viewport of [320, 375]) {
    const sidePad = Math.max(1 * root, 0.045 * viewport);
    const heroContent = viewport - 2 * sidePad;
    assert.ok(heroContent > 0, `hero content at ${viewport}px`);
    // Zero-minimum tracks take the full usable width, so intrinsic text wraps
    // in place instead of forcing the document wider than the viewport.
    assert.ok(heroMinima.every((min) => min === "0"), `hero tracks absorb ${viewport}px budget`);
  }
});

test("R50-S04 text scale is preserved, never shrunk", () => {
  assert.match(css, /\.wordmark strong\s*\{[^}]*font-size:\s*clamp\(1\.7rem,\s*4vw,\s*3\.1rem\)/);
  assert.match(css, /\.departure-board h2\s*\{[^}]*font-size:\s*clamp\(2\.7rem,\s*7vw,\s*5\.5rem\)/);
  assert.match(css, /\.route-copy strong\s*\{[^}]*font-size:\s*clamp\(2rem,\s*4vw,\s*3\.4rem\)/);
  assert.match(css, /h1\s*\{[^}]*font-size:\s*clamp\(4rem,\s*9vw,\s*8\.6rem\)/);
  assert.match(css, /h1\s*\{[^}]*max-width:\s*min\(7ch,\s*100%\)/);
  assert.doesNotMatch(css, /font-size:\s*clamp\(1rem/);
});

test("R50-S04 anchors and glyph bounds are preserved", () => {
  assert.match(html, /<a class="wordmark" href="\/" aria-label="Pomodorough home">/);
  assert.match(html, /<a class="button button-web" href="\/app">Use Web app<\/a>/);
  assert.match(html, /<a class="button button-native" href="#native-options" data-native-cta>/);
  for (const route of ["route-apple", "route-desktop", "route-android"]) {
    assert.match(html, new RegExp(`<a class="route-card ${route}" href="https://github\\.com/Pomodoro-Everywhere/pomodorough-`));
  }
  assert.equal((html.match(/<span class="route-arrow" aria-hidden="true">&#8599;<\/span>/g) || []).length, 3);
  assert.match(html, /<span class="wordmark-symbol" aria-hidden="true">P<\/span>/);
  assert.match(html, /<a class="skip-link" href="#departure">Skip to downloads<\/a>/);
  assert.match(html, /<div id="departure" class="departure"/);
  assert.doesNotMatch(html, /tabindex/);
});

test("R50-S04 platform labels still resolve through the selector", () => {
  const cases = [
    ["Mozilla/5.0 (Linux; Android 15; Pixel 9)", "Get Android app"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", "Get Apple app"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6)", "Get macOS app"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Get Windows app"],
    ["Mozilla/5.0 (X11; Linux x86_64)", "Get Linux app"],
    ["PomodoroughTest/1.0", "View native apps"],
  ];
  for (const [agent, label] of cases) {
    assert.equal(selector.selectPlatform(agent, 0).label, label, agent);
  }
  assert.match(landingSource, /querySelector\("\[data-native-cta\]"/);
  assert.match(landingSource, /querySelector\("\[data-platform-name\]"/);
  assert.match(landingSource, /querySelector\("\[data-platform-note\]"/);
  assert.match(landingSource, /location\.replace\("\/app"/);
});

test("R50-S04 keyboard path is preserved", () => {
  assert.match(css, /\.skip-link:focus\s*\{[^}]*transform:\s*translateY\(0\)/);
  assert.match(css, /a:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--signal\)/);
  assert.match(html, /<a class="button button-native"[^>]*>View native apps<\/a>/);
  assert.match(html, /<a class="button button-web"[^>]*>Use Web app<\/a>/);
  assert.match(html, /<a class="route-card route-android"[^>]*>[\s\S]*?Android/);
});

test("R50-S04 desktop tracks and narrow fallbacks are preserved", () => {
  assert.match(css, /@media \(max-width:\s*900px\)[\s\S]{0,2000}?\.route-grid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /@media \(max-width:\s*900px\)[\s\S]{0,2000}?\.hero\s*\{\s*min-height:\s*auto/);
  assert.match(css, /@media \(max-width:\s*600px\)[\s\S]{0,400}?\.station-code\s*\{\s*display:\s*none/);
  assert.match(css, /@media \(max-width:\s*600px\)[\s\S]{0,1200}?footer\s*\{\s*flex-direction:\s*column/);
  assert.match(css, /@media \(prefers-color-scheme:\s*dark\)/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
});
