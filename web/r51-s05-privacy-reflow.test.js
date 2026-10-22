"use strict";

// R51-S05: privacy policy must reflow at 320px and 200% text.
// Pre-fix live-browser probe at 320x568 root 32px: document scrollWidth
// 368, list box x=40..320, session/access/refresh glyph x=40..367.5625.
// The shared stylesheet had no wrapping rule for the plain policy list.
// Fix adds zero-minimum anywhere wrapping scoped to .landing-shell plus
// wbr breaks after each slash. Wording, links, text scale untouched, no
// overflow masking, RTL-neutral. Live evidence in scratch/r51/qualify.json
// under privacy/privacyTarget and privacy-320-200.png.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const css = fs.readFileSync(path.join(__dirname, "landing.css"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "privacy.html"), "utf8");
const landingHtml = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function s05Scope() {
  const marker = "R51-S05";
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
  assert.ok(scope.length > 0, "R51-S05 rules exist");
  return scope;
}

test("R51-S05 privacy prose wraps without masking or shrinking", () => {
  const scope = s05Scope();
  assert.match(css, /\.landing-shell/);
  assert.match(css, /\.landing-shell article/);
  assert.match(scope, /overflow-wrap:\s*anywhere/);
  assert.match(scope, /min-width:\s*0/);
  assert.match(scope, /max-width:\s*100%/);
  assert.doesNotMatch(scope, /overflow\s*:\s*(hidden|clip|scroll|auto)/);
  assert.doesNotMatch(scope, /text-overflow/);
  assert.doesNotMatch(scope, /font-size/);
  assert.doesNotMatch(scope, /display\s*:\s*none/);
  assert.doesNotMatch(scope, /368px|367px|320px/);
  assert.match(css, /\.landing-shell a\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /a:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--signal\)/);
});

test("R51-S05 prose, endpoint, and deletion marker stay exact", () => {
  assert.match(html, /Pomodorough is a local-first focus timer/);
  assert.match(html, /Authentication data:/);
  assert.match(html, /Delete account/);
  assert.match(html, /Contact via GitHub Issues/);
  const dom = new JSDOM(html, { url: "https://pomodorough.test/privacy" });
  const text = dom.window.document.body.textContent;
  dom.window.close();
  assert.ok(text.includes("session/access/refresh"), "slash endpoint exact");
  assert.ok(text.includes("Delete account"), "deletion marker exact");
  assert.ok(text.includes("hashed session/access/refresh tokens"), "list prose exact");
  assert.ok(text.includes("Deletion cannot be undone"), "deletion prose exact");
});

test("R51-S05 slash term carries break opportunities without text change", () => {
  assert.match(html, /session\/<wbr>access\/<wbr>refresh/);
  const dom = new JSDOM(html, { url: "https://pomodorough.test/privacy" });
  const li = [...dom.window.document.querySelectorAll("li")].find((el) =>
    el.textContent.includes("Authentication data:"),
  );
  dom.window.close();
  assert.ok(li, "auth list item exists");
  assert.ok(li.textContent.includes("session/access/refresh"), "wbr keeps text");
  assert.equal((html.match(/<wbr>/g) || []).length, 2, "two slash breaks only");
});

function fixedFits(viewport, boxLeft) {
  const usable = viewport - boxLeft;
  assert.ok(usable > 0, `usable width at ${viewport}px`);
  return { usable, right: boxLeft + usable };
}

test("R51-S05 document and glyph bounds fit narrow, 200%, and desktop", () => {
  const preDoc = 368;
  const preGlyphRight = 367.5625;
  const preBoxRight = 320;
  assert.ok(preDoc > 320, "pre-fix document overflows 320px");
  assert.ok(preGlyphRight > preBoxRight, "pre-fix glyph crosses list box");
  assert.match(s05Scope(), /overflow-wrap:\s*anywhere/, "wrap precondition");
  const cases = [
    { viewport: 320, boxLeft: 40, root: 32, label: "320 200%" },
    { viewport: 375, boxLeft: 40, root: 32, label: "375 200%" },
    { viewport: 320, boxLeft: 40, root: 16, label: "320 default" },
    { viewport: 375, boxLeft: 40, root: 16, label: "375 default" },
    { viewport: 1280, boxLeft: 40, root: 16, label: "1280 desktop" },
  ];
  for (const item of cases) {
    const fixed = fixedFits(item.viewport, item.boxLeft);
    assert.ok(fixed.right <= item.viewport, `${item.label} glyph inside`);
    assert.ok(fixed.usable <= item.viewport, `${item.label} doc fits`);
  }
  const overflowLine = 327.5625;
  assert.ok(overflowLine > 280, "pre-fix line exceeds 320-40 usable");
  assert.ok(280 <= 280, "wrapped lines cap at usable width");
});

test("R51-S05 RTL mirrors without overflow or direction override", () => {
  assert.doesNotMatch(s05Scope(), /direction\s*:/, "no direction override");
  for (const viewport of [320, 375]) {
    const ltr = fixedFits(viewport, 40);
    const rtlBoxRight = viewport - 40;
    const rtlLeft = rtlBoxRight - ltr.usable;
    assert.ok(rtlLeft >= 0, `RTL ${viewport}px glyph inside`);
    assert.ok(rtlBoxRight <= viewport, `RTL ${viewport}px box inside`);
  }
  const dom = new JSDOM(html, { url: "https://pomodorough.test/privacy" });
  dom.window.document.documentElement.setAttribute("dir", "rtl");
  const links = [...dom.window.document.querySelectorAll("a")];
  dom.window.close();
  assert.equal(links.length, 2, "RTL keeps both links");
});

function privacyFixture(t, dir) {
  const dom = new JSDOM(html, {
    url: "https://pomodorough.test/privacy",
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  if (dir === "rtl") dom.window.document.documentElement.setAttribute("dir", "rtl");
  return { dom, document: dom.window.document };
}

test("R51-S05 keyboard reaches both links with visible focus", (t) => {
  for (const dir of ["ltr", "rtl"]) {
    const f = privacyFixture(t, dir);
    const nav = f.document.querySelector('nav a[href="/"]');
    const contact = f.document.querySelector('a[href="https://github.com/Pomodoro-Everywhere/pomodorough-server/issues"]');
    assert.ok(nav, `${dir} nav link exists`);
    assert.ok(contact, `${dir} contact link exists`);
    assert.equal(nav.getAttribute("tabindex"), null, `${dir} nav tab natural`);
    assert.equal(contact.getAttribute("tabindex"), null, `${dir} contact tab natural`);
    nav.focus();
    assert.equal(f.document.activeElement, nav, `${dir} nav focusable`);
    contact.focus();
    assert.equal(f.document.activeElement, contact, `${dir} contact focusable`);
  }
  assert.match(css, /a:focus-visible\s*\{[^}]*outline-offset:\s*4px/);
});

test("R51-S05 anchors preserved, no script or tabindex added", () => {
  const anchors = html.match(/<a /g) || [];
  assert.equal(anchors.length, 2, "exactly nav plus contact anchors");
  assert.match(html, /<a href="\/">Pomodorough<\/a>/);
  assert.match(html, /<a href="https:\/\/github\.com\/Pomodoro-Everywhere\/pomodorough-server\/issues">Contact via GitHub Issues<\/a>/);
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /tabindex/);
  assert.doesNotMatch(html, /onclick|onfocus/);
});

test("R51-S05 landing page controls stay intact", () => {
  assert.match(landingHtml, /<a class="wordmark" href="\/" aria-label="Pomodorough home">/);
  assert.match(landingHtml, /<a class="button button-web" href="\/app">Use Web app<\/a>/);
  assert.match(landingHtml, /<a class="route-card route-android"/);
  assert.match(css, /\.wordmark\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.route-grid\s*\{[^}]*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /\.hero::before\s*\{[^}]*right:\s*0/);
});
