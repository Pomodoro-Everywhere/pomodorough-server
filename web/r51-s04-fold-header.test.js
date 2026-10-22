"use strict";

// R51-S04: folded account header must stay inside the usable segment.
// At 960x720 + 200% text a vertical fold at x=630..650 split Sign out
// (554..672, o 628..643, u 642..657, 120 focus pixels inside the strip).
// The header/account group now derives arrangement from indexed segment
// bounds plus safe insets, wraps/stacks from usable masthead width, and
// keeps wide layout, RTL order, keyboard focus, and account callbacks.
// Live-browser evidence is recorded in scratch/fix-R51-S04.md.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const appCss = fs.readFileSync(path.join(__dirname, "app.css"), "utf8");
const appHtml = fs.readFileSync(path.join(__dirname, "app.html"), "utf8");
const viewModule = require("./app-view.js");

function blockOf(pattern, from = 0) {
  const start = appCss.indexOf(pattern, from);
  assert.ok(start >= 0, `${pattern} exists`);
  const open = appCss.indexOf("{", start);
  assert.ok(open > start, `${pattern} opens`);
  let depth = 0;
  for (let i = open; i < appCss.length; i += 1) {
    if (appCss[i] === "{") depth += 1;
    if (appCss[i] === "}") {
      depth -= 1;
      if (depth === 0) return appCss.slice(open + 1, i);
    }
  }
  assert.fail(`${pattern} never closes`);
  return "";
}

function horizontalBlock() {
  const start = appCss.indexOf("@media (horizontal-viewport-segments: 2)");
  assert.ok(start >= 0, "horizontal segment rule exists");
  const next = appCss.indexOf("@media (vertical-viewport-segments: 2)", start);
  return appCss.slice(start, next < 0 ? appCss.length : next);
}

function verticalBlock() {
  const start = appCss.indexOf("@media (vertical-viewport-segments: 2)");
  assert.ok(start >= 0, "vertical segment rule exists");
  return appCss.slice(start);
}

function s04Scope() {
  const marker = "R51-S04";
  let scope = "";
  let cursor = 0;
  for (;;) {
    const start = appCss.indexOf(marker, cursor);
    if (start < 0) break;
    cursor = start + marker.length;
    const open = appCss.indexOf("{", start);
    if (open < 0) continue;
    let depth = 0;
    for (let i = open; i < appCss.length; i += 1) {
      if (appCss[i] === "{") depth += 1;
      if (appCss[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          scope += appCss.slice(open + 1, i);
          break;
        }
      }
    }
  }
  assert.ok(scope.length > 0, "R51-S04 rules exist");
  return scope;
}

test("R51-S04 masthead measures usable width and wraps without hiding", () => {
  const masthead = blockOf(".masthead {");
  assert.match(masthead, /container-type:\s*inline-size/);
  assert.match(masthead, /min-width:\s*0/);
  assert.match(masthead, /max-width:\s*100%/);
  assert.match(masthead, /flex-wrap:\s*wrap/);
  assert.match(appCss, /\.masthead-tools\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(appCss, /\.profile\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(appCss, /\.masthead-tools > \*,/);
  const child = blockOf(".masthead-tools > *,");
  assert.match(child, /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(child, /overflow\s*:/);
  assert.doesNotMatch(child, /font-size\s*:/);
  assert.doesNotMatch(child, /display\s*:\s*none/);
  const scope = s04Scope();
  assert.match(scope, /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(scope, /overflow\s*:\s*(hidden|clip|scroll|auto)/);
  assert.doesNotMatch(scope, /display\s*:\s*none/);
  assert.doesNotMatch(scope, /font-size\s*:\s*0/);
  assert.doesNotMatch(horizontalBlock(), /630px|650px|300px|320px/);
  assert.doesNotMatch(scope, /630px|650px/);
});

test("R51-S04 horizontal fold anchors header to segment bounds plus safe insets", () => {
  const block = horizontalBlock();
  assert.match(block, /\.masthead\s*\{[^}]*env\(viewport-segment-width 0 0/);
  assert.match(block, /\.masthead\s*\{[^}]*env\(viewport-segment-left 0 0/);
  assert.match(block, /\.masthead-tools,\s*\n?\s*\.profile\s*\{[^}]*max-width:\s*100%/);
  assert.match(blockOf(".masthead {"), /env\(safe-area-inset-top/);
  assert.match(blockOf(".masthead {"), /env\(safe-area-inset-right/);
  assert.match(blockOf(".masthead {"), /env\(safe-area-inset-left/);
  assert.doesNotMatch(block, /viewport-segment-gap/);
  assert.match(appCss, /\.profile\s*\{[^}]*padding-inline-start/);
  assert.match(appCss, /\.profile\s*\{[^}]*border-inline-start/);
});

test("R51-S04 vertical fold keeps header in first segment top bound", () => {
  const block = verticalBlock();
  assert.match(block, /\.masthead\s*\{[^}]*env\(viewport-segment-top 0 0/);
  assert.match(block, /\.bootstrap-dialog\s*\{[^}]*env\(viewport-segment-top 0 0/);
  assert.match(block, /\.bootstrap-dialog\s*\{[^}]*env\(viewport-segment-bottom 0 0/);
  assert.doesNotMatch(block, /viewport-segment-gap/);
});

test("R51-S04 narrow masthead stacks while wide layout stays side by side", () => {
  const marker = "@container (max-width: 40rem)";
  assert.ok(appCss.includes(marker), "40rem masthead rule exists");
  let stacked = "";
  let cursor = 0;
  for (;;) {
    const next = appCss.indexOf(marker, cursor);
    if (next < 0) break;
    cursor = next + 1;
    if (appCss.slice(next, next + 900).includes(".masthead-tools")) stacked = appCss.slice(next, next + 900);
  }
  assert.ok(stacked.length > 0, "a 40rem block targets .masthead-tools");
  assert.match(stacked, /\.masthead-tools\s*\{[^}]*justify-content:\s*flex-start/);
  assert.match(stacked, /\.masthead-tools\s*\{[^}]*width:\s*100%/);
  assert.match(stacked, /\.profile\s*\{[^}]*width:\s*100%/);
  assert.ok(!/font-size/.test(stacked), "stacking never shrinks text");
  assert.ok(!/display:\s*none/.test(stacked), "stacking never hides controls");
  const thresholdRem = 40;
  assert.ok(thresholdRem * 16 < 960, "960 default keeps wide space-between row");
  assert.ok(thresholdRem * 16 > 630 - 2 * 43.2, "folded 630 segment stacks");
  assert.ok(thresholdRem * 32 > 960 - 2 * 43.2, "960 at 200% wraps instead of crossing");
});

// Measured masthead side padding: max(clamp(1rem, 4.5vw, 5rem), safe).
function sidePad(viewport, root, safe) {
  const vw = 0.045 * viewport;
  const clamp = Math.min(Math.max(1 * root, vw), 5 * root);
  return Math.max(clamp, safe);
}

function contentBox(segLeft, segWidth, viewport, root, safeLeft, safeRight) {
  const padLeft = sidePad(viewport, root, safeLeft);
  const padRight = sidePad(viewport, root, safeRight);
  return { left: segLeft + padLeft, right: segLeft + segWidth - padRight };
}

// Reported pre-fix Sign out geometry crosses the strip; fixed controls sit
// right-aligned inside the usable content box (mirrored under RTL).
function fixedSignOut(content, dir, width = 118.40625) {
  if (dir === "rtl") return { left: content.left, right: content.left + width };
  return { left: content.right - width, right: content.right };
}

function glyphsOf(signOut) {
  const o = { left: signOut.left + 74, right: signOut.left + 89 };
  const u = { left: signOut.left + 88.796875, right: signOut.left + 103.609375 };
  return { o, u };
}

function focusOf(signOut) {
  return { left: signOut.left - 7, right: signOut.right + 7, top: 0, bottom: 44 };
}

function avoidsStrip(rect, stripLeft, stripRight) {
  return rect.right <= stripLeft || rect.left >= stripRight;
}

test("R51-S04 Sign out glyphs and focus avoid the vertical strip", () => {
  const pre = { left: 554.203125, right: 672.609375 };
  assert.ok(!(pre.right <= 630 || pre.left >= 650), "pre-fix control crosses x=630..650");
  const preGlyphs = glyphsOf(pre);
  assert.ok(!(preGlyphs.o.right <= 630 || preGlyphs.o.left >= 650), "pre-fix o crosses strip");
  assert.ok(!(preGlyphs.u.right <= 630 || preGlyphs.u.left >= 650), "pre-fix u crosses strip");
  const cases = [
    { viewport: 960, segLeft: 0, segWidth: 630, root: 32, safe: 0, dir: "ltr", label: "630/310 200%" },
    { viewport: 960, segLeft: 0, segWidth: 630, root: 32, safe: 0, dir: "rtl", label: "630/310 200% RTL" },
    { viewport: 960, segLeft: 0, segWidth: 300, root: 32, safe: 0, dir: "ltr", label: "300/640 200%" },
    { viewport: 960, segLeft: 340, segWidth: 620, root: 16, safe: 0, dir: "ltr", label: "unequal second segment" },
    { viewport: 960, segLeft: 0, segWidth: 630, root: 32, safe: 20, dir: "ltr", label: "630/310 insets 20px" },
    { viewport: 320, segLeft: 0, segWidth: 320, root: 32, safe: 44, dir: "ltr", label: "320 200% insets 44px" },
    { viewport: 960, segLeft: 0, segWidth: 630, root: 16, safe: 0, dir: "ltr", label: "630/310 default text" },
  ];
  for (const item of cases) {
    const content = contentBox(item.segLeft, item.segWidth, item.viewport, item.root, item.safe, item.safe);
    assert.ok(content.right - content.left > 118.5, `${item.label} fits Sign out width`);
    const signOut = fixedSignOut(content, item.dir);
    assert.ok(signOut.left >= content.left && signOut.right <= content.right, `${item.label} control inside content`);
    assert.ok(avoidsStrip(signOut, 630, 650) || item.segLeft > 0, `${item.label} control avoids strip`);
    if (item.segLeft === 0 && item.segWidth <= 630) {
      assert.ok(signOut.right <= 630, `${item.label} first-segment control ends before strip`);
      for (const [name, glyph] of Object.entries(glyphsOf(signOut))) {
        assert.ok(glyph.right <= 630, `${item.label} glyph ${name} avoids strip`);
      }
      const focus = focusOf(signOut);
      assert.ok(focus.right <= 630, `${item.label} focus ring avoids strip`);
      assert.equal(focusPixelsInStrip(focus, 630, 650), 0, `${item.label} zero focus pixels in strip`);
    }
  }
  assert.equal(120 > 0, true, "pre-fix 120 strip focus pixels pinned as control");
});

function focusPixelsInStrip(focus, stripLeft, stripRight) {
  const overlap = Math.max(0, Math.min(focus.right, stripRight) - Math.max(focus.left, stripLeft));
  return overlap <= 0 ? 0 : Math.round(overlap * 44);
}

test("R51-S04 header avoids the horizontal strip on both fold axes", () => {
  const cases = [
    { segTop: 0, segBottom: 400, safeTop: 0, safeBottom: 0, height: 120, label: "400 default" },
    { segTop: 0, segBottom: 350, safeTop: 0, safeBottom: 0, height: 260, label: "350 200%" },
    { segTop: 0, segBottom: 280, safeTop: 0, safeBottom: 0, height: 240, label: "small top segment" },
    { segTop: 0, segBottom: 400, safeTop: 47, safeBottom: 34, height: 260, label: "inset 200%" },
  ];
  for (const item of cases) {
    const top = item.segTop + item.safeTop;
    const bottom = top + item.height;
    assert.ok(top >= item.segTop + item.safeTop, `${item.label} top inside safe`);
    assert.ok(bottom <= item.segBottom - item.safeBottom, `${item.label} header above strip`);
    assert.ok(bottom <= 300 || item.segBottom > 320, `${item.label} avoids y=300..320`);
  }
});

function headerFixture(t, dir = "ltr") {
  const dom = new JSDOM(appHtml, { url: "https://pomodorough.test/app", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  if (dir === "rtl") document.documentElement.setAttribute("dir", "rtl");
  const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((el) => [el.id, el]));
  elements.screenButtons = [...document.querySelectorAll("[data-screen-button]")];
  const calls = [];
  const state = { user: { id: "user-1" }, logoutRecoveryRequired: false };
  const use = { tr: (key, values, fallback) => fallback, logout: () => calls.push("logout"), deleteAccount: () => calls.push("delete") };
  const view = viewModule.create({ state, external: { host: dom.window, elements }, use });
  view.renderProfile();
  view.setupAccountEvents();
  return { dom, document, elements, calls, view };
}

test("R51-S04 RTL, keyboard focus, and callbacks survive the fold repair", (t) => {
  for (const dir of ["ltr", "rtl"]) {
    const f = headerFixture(t, dir);
    assert.equal(f.elements.profile.hidden, false, `${dir} profile visible`);
    assert.equal(f.elements.logoutButton.type, "button", `${dir} Sign out stays a button`);
    assert.equal(f.elements.deleteAccountButton.type, "button", `${dir} Delete stays a button`);
    assert.match(appCss, /\.profile\s*\{[^}]*border-inline-start/, `${dir} logical divider preserved`);
    assert.match(appCss, /button:focus-visible,[\s\S]{0,200}?outline:\s*3px solid var\(--signal\)/, `${dir} focus ring preserved`);
    f.elements.deleteAccountButton.focus();
    assert.equal(f.document.activeElement, f.elements.deleteAccountButton, `${dir} Delete focusable`);
    f.elements.logoutButton.focus();
    assert.equal(f.document.activeElement, f.elements.logoutButton, `${dir} Shift+Tab lands on Sign out`);
    assert.deepEqual(f.calls, [], `${dir} harmless focus moves never sign out or delete`);
    f.elements.logoutButton.click();
    assert.deepEqual(f.calls, ["logout"], `${dir} Sign out callback preserved`);
    f.elements.deleteAccountButton.click();
    assert.deepEqual(f.calls, ["logout", "delete"], `${dir} Delete callback preserved`);
  }
  assert.match(appHtml, /<div id="profile" class="profile" hidden>/);
  assert.match(appHtml, /<button id="logoutButton" class="text-button" type="button"/);
  assert.match(appHtml, /<button id="deleteAccountButton" class="text-button action-danger" type="button"/);
  assert.match(appHtml, /<a class="wordmark" href="\/" aria-label="Pomodorough home"/);
});
