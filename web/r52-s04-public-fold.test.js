"use strict";

// R52-S04: public home and privacy header links must stay inside the
// measured first display segment. Pre-fix at 960x720 with a vertical fold
// at x=300..320: home link x=43.1875..357.640625 (u/g glyphs cross the
// strip, 530.65625 at settled 200% text); privacy contact x=0..364.765625
// at 200% (three letters in the strip). Fix anchors .masthead and
// .landing-shell to indexed segment left/width plus safe insets, keeps
// intrinsic wrap/reflow, wording, links, focus, and text scale. Live
// evidence in scratch/r52-server/public-fold.json (see review-R52-server
// S04); this file pins the static contract plus segment-budget geometry.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const css = fs.readFileSync(path.join(__dirname, "landing.css"), "utf8");
const landingHtml = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const privacyHtml = fs.readFileSync(path.join(__dirname, "privacy.html"), "utf8");

function horizontalBlock() {
  const start = css.indexOf("@media (horizontal-viewport-segments: 2)");
  assert.ok(start >= 0, "horizontal segment rule exists");
  const next = css.indexOf("@media (vertical-viewport-segments: 2)", start);
  return css.slice(start, next < 0 ? css.length : next);
}

function verticalBlock() {
  const start = css.indexOf("@media (vertical-viewport-segments: 2)");
  assert.ok(start >= 0, "vertical segment rule exists");
  return css.slice(start);
}

function s04Scope() {
  const marker = "R52-S04";
  let scope = "";
  let cursor = 0;
  for (;;) {
    const start = css.indexOf(marker, cursor);
    if (start < 0) break;
    cursor = start + marker.length;
    const open = css.indexOf("{", start);
    if (open < 0) continue;
    let depth = 0;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === "{") depth += 1;
      if (css[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          scope += css.slice(open + 1, i);
          break;
        }
      }
    }
  }
  assert.ok(scope.length > 0, "R52-S04 rules exist");
  return scope;
}

test("R52-S04 header anchors to measured segment width", () => {
  const block = horizontalBlock();
  assert.match(block, /\.masthead\s*\{[^}]*env\(viewport-segment-width 0 0/);
  assert.match(block, /\.masthead\s*\{[^}]*env\(viewport-segment-left 0 0/);
  assert.match(block, /\.landing-shell\s*\{[^}]*env\(viewport-segment-width 0 0/);
  assert.match(block, /\.landing-shell\s*\{[^}]*env\(viewport-segment-left 0 0/);
  assert.doesNotMatch(block, /viewport-segment-gap/);
  assert.doesNotMatch(block, /300px|320px|630px|650px/);
});

test("R52-S04 vertical fold uses indexed top bound", () => {
  const block = verticalBlock();
  assert.match(block, /\.masthead\s*\{[^}]*env\(viewport-segment-top 0 0/);
  assert.match(block, /\.landing-shell\s*\{[^}]*env\(viewport-segment-top 0 0/);
  assert.doesNotMatch(block, /viewport-segment-gap/);
});

test("R52-S04 links wrap inside segment, scale untouched", () => {
  assert.match(css, /\.masthead\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /\.wordmark\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.wordmark\s*\{[^}]*max-width:\s*100%/);
  assert.match(css, /\.landing-shell a\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.landing-shell a\s*\{[^}]*max-width:\s*100%/);
  assert.match(css, /a:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--signal\)/);
  assert.match(css, /a:focus-visible\s*\{[^}]*outline-offset:\s*4px/);
  const scope = s04Scope();
  assert.doesNotMatch(scope, /overflow\s*:\s*(hidden|clip|scroll|auto)/);
  assert.doesNotMatch(scope, /display\s*:\s*none/);
  assert.doesNotMatch(scope, /font-size/);
});

// Masthead side padding derives from the production rule, not a copy of it:
// padding-left/right: max(clamp(1rem, 4.5vw, 5rem), env(safe-area-inset-*)).
// Numbers below are parsed out of landing.css so a padding regression fails
// this test; the segment/strip/viewport rows mirror the pre-fix measurement
// environment cited in the header.
function productionPadExpression() {
  const rule = css.match(/\.masthead\s*\{[^}]*padding-left:\s*max\(clamp\(([\d.]+)rem,\s*([\d.]+)vw,\s*([\d.]+)rem\)[^;]*safe-area-inset-left[^;]*\)/);
  assert.ok(rule, "production .masthead padding-left keeps clamp + safe-area");
  assert.match(css, /\.masthead\s*\{[^}]*padding-right:\s*max\(clamp\([^;]*safe-area-inset-right[^;]*\)/);
  return { minRem: Number(rule[1]), vwPercent: Number(rule[2]), maxRem: Number(rule[3]) };
}

function productionFocusRingPx() {
  const rule = css.match(/a:focus-visible\s*\{[^}]*outline-offset:\s*([\d.]+)px/);
  assert.ok(rule, "production focus outline-offset exists");
  return Number(rule[1]);
}

function sidePad(viewport, root, safe, expr) {
  const vw = (expr.vwPercent / 100) * viewport;
  return Math.max(Math.min(Math.max(expr.minRem * root, vw), expr.maxRem * root), safe);
}

function avoidsStrip(rect, stripLeft, stripRight) {
  return rect.right <= stripLeft || rect.left >= stripRight;
}

test("R52-S04 home and contact boxes avoid the strip (model check pinned to production CSS)", () => {
  const expr = productionPadExpression();
  assert.equal(expr.minRem, 1, "production clamp floor stays 1rem");
  assert.equal(expr.vwPercent, 4.5, "production clamp slope stays 4.5vw");
  assert.equal(expr.maxRem, 5, "production clamp cap stays 5rem");
  const focusPx = productionFocusRingPx();
  // The budget this model checks only exists when the header is anchored to
  // the indexed segment width; without that rule the boxes below prove nothing.
  const block = horizontalBlock();
  assert.match(block, /\.masthead\s*\{[^}]*env\(viewport-segment-width 0 0/);
  const preHome = { left: 43.1875, right: 357.640625 };
  assert.ok(!avoidsStrip(preHome, 300, 320), "pre-fix home crosses x=300..320");
  assert.ok(530.65625 > 320, "pre-fix 200% home crosses strip");
  assert.ok(!avoidsStrip({ left: 0, right: 364.765625 }, 300, 320), "pre-fix contact crosses strip");
  const cases = [
    { seg: 300, strip: [300, 320], viewport: 960, root: 16, safe: 0, dir: "ltr", label: "300/660 default" },
    { seg: 300, strip: [300, 320], viewport: 960, root: 32, safe: 0, dir: "ltr", label: "300/660 200%" },
    { seg: 300, strip: [300, 320], viewport: 960, root: 32, safe: 0, dir: "rtl", label: "300/660 200% RTL" },
    { seg: 630, strip: [630, 650], viewport: 960, root: 32, safe: 0, dir: "ltr", label: "630/330 200%" },
    { seg: 630, strip: [630, 650], viewport: 960, root: 16, safe: 0, dir: "rtl", label: "630/330 default RTL" },
    { seg: 300, strip: [300, 320], viewport: 960, root: 32, safe: 20, dir: "ltr", label: "300 insets 200%" },
    { seg: 320, strip: [320, 320], viewport: 320, root: 32, safe: 44, dir: "ltr", label: "320 200% insets" },
  ];
  for (const item of cases) {
    const pad = sidePad(item.viewport, item.root, item.safe, expr);
    const head = { left: pad, right: item.seg - pad };
    assert.ok(head.right - head.left > 0, `${item.label} masthead keeps usable width`);
    assert.ok(avoidsStrip(head, item.strip[0], item.strip[1]), `${item.label} header box avoids strip`);
    const focus = { left: head.left - focusPx, right: head.right + focusPx };
    assert.ok(avoidsStrip(focus, item.strip[0], item.strip[1]), `${item.label} focus ring avoids strip`);
    const policy = { left: 0, right: item.seg };
    assert.ok(avoidsStrip(policy, item.strip[0], item.strip[1]), `${item.label} policy box avoids strip`);
  }
});

test("R52-S04 wording, links, and keyboard path preserved", (t) => {
  assert.match(landingHtml, /<a class="wordmark" href="\/" aria-label="Pomodorough home">/);
  assert.match(landingHtml, /<strong>Pomodorough<\/strong>/);
  assert.match(landingHtml, /<small>Time, in transit<\/small>/);
  assert.match(privacyHtml, /<a href="\/">Pomodorough<\/a>/);
  assert.match(privacyHtml, /<a href="https:\/\/github\.com\/Pomodoro-Everywhere\/pomodorough-server\/issues">Contact via GitHub Issues<\/a>/);
  for (const [html, url, selector, dir] of [
    [landingHtml, "https://pomodorough.test/", '.wordmark[href="/"]', "ltr"],
    [privacyHtml, "https://pomodorough.test/privacy", 'nav a[href="/"]', "rtl"],
  ]) {
    const dom = new JSDOM(html, { url, pretendToBeVisual: true });
    t.after(() => dom.window.close());
    if (dir === "rtl") dom.window.document.documentElement.setAttribute("dir", "rtl");
    const link = dom.window.document.querySelector(selector);
    assert.ok(link, `${dir} ${selector} exists`);
    assert.equal(link.getAttribute("tabindex"), null, `${dir} link keeps natural tab order`);
    link.focus();
    assert.equal(dom.window.document.activeElement, link, `${dir} link focusable`);
  }
});
