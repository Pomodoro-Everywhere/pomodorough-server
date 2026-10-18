"use strict";

// R50-S05: carry-forward nav must stay inside the usable segment at 960x720
// fold + 200% RTL and at 320px with side insets. Tabs derive arrangement from
// usable container width and wrap/stack instead of escaping the first
// segment. Live-browser evidence is recorded in scratch/fix-R50-S05.md
// (ar-XB 960x720 x=300..320 fold at 200%, en 320px inset label overflow).

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

function navBlock() {
  return blockOf(".screen-nav {");
}

function tablistBlock() {
  return blockOf('.screen-nav [role="tablist"] {');
}

function tabButtonBlock() {
  return blockOf(".screen-nav button {");
}

function tabLabelBlock() {
  return blockOf(".screen-nav button span,");
}

test("R50-S05 nav derives arrangement from usable container width", () => {
  const nav = navBlock();
  assert.match(nav, /container-type:\s*inline-size/);
  assert.match(nav, /min-width:\s*0/);
  assert.match(nav, /max-width:\s*100%/);
  assert.match(appCss, /main\s*\{[^}]*container-type:\s*inline-size/);
  const segStart = appCss.indexOf("@media (horizontal-viewport-segments: 2)");
  assert.ok(segStart >= 0, "fold segment rule exists");
  const seg = appCss.slice(segStart, appCss.indexOf("@media (vertical-viewport-segments: 2)", segStart));
  assert.match(seg, /env\(viewport-segment-width 0 0/);
  assert.match(seg, /env\(viewport-segment-left 0 0/);
  assert.doesNotMatch(seg, /viewport-segment-gap/);
  assert.doesNotMatch(tablistBlock(), /300px|320px/);
});

test("R50-S05 tabs wrap and shrink instead of escaping the segment", () => {
  const list = tablistBlock();
  assert.match(list, /display:\s*flex/);
  assert.match(list, /flex-wrap:\s*wrap/);
  assert.match(list, /gap:\s*0\.4rem/);
  const button = tabButtonBlock();
  assert.match(button, /flex:\s*1 1 auto/);
  assert.match(button, /min-width:\s*0/);
  assert.match(button, /max-width:\s*100%/);
  assert.match(button, /overflow-wrap:\s*anywhere/);
  assert.match(button, /min-height:\s*2\.75rem/);
  assert.doesNotMatch(appCss, /min-width:\s*8\.5rem/);
  const label = tabLabelBlock();
  assert.match(label, /min-width:\s*0/);
  assert.match(label, /max-width:\s*100%/);
  assert.match(label, /overflow-wrap:\s*anywhere/);
});

test("R50-S05 narrow nav stacks to full-width rows from container width", () => {
  const marker = "@container (max-width: 24rem)";
  let start = -1;
  let cursor = 0;
  let navScope = "";
  for (;;) {
    const next = appCss.indexOf(marker, cursor);
    if (next < 0) break;
    start = next;
    cursor = next + marker.length;
    const scope = appCss.slice(start, start + 1200);
    if (scope.includes(".screen-nav")) navScope = scope;
  }
  assert.ok(start >= 0, "nav stacking container rule exists");
  assert.ok(navScope.length > 0, "a 24rem container block targets .screen-nav");
  assert.match(navScope, /\.screen-nav \[role="tablist"\]\s*\{[^}]*display:\s*grid/);
  assert.match(navScope, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(navScope, /\.screen-nav button\s*\{[^}]*width:\s*100%/);
  assert.ok(!/font-size:\s*0/.test(navScope), "stacking never shrinks text");
  assert.ok(!/display:\s*none/.test(navScope), "stacking never hides tabs");
});

test("R50-S05 folded and inset budgets stack to full-width rows", () => {
  const marker = "@container (max-width: 24rem)";
  let thresholdRem = 0;
  let cursor = 0;
  for (;;) {
    const next = appCss.indexOf(marker, cursor);
    if (next < 0) break;
    cursor = next + 1;
    if (appCss.slice(next, next + 1200).includes(".screen-nav")) thresholdRem = 24;
  }
  assert.equal(thresholdRem, 24, "nav stacking threshold parses from CSS");
  const button = tabButtonBlock();
  assert.match(button, /min-width:\s*0/, "stacked buttons shrink from parsed zero minimum");
  const cases = [
    { viewport: 960, segment: 300, root: 32, pad: 28.8, label: "960 fold 200% first segment" },
    { viewport: 320, segment: 320, root: 32, pad: 28.8, label: "320 200% full width" },
    { viewport: 320, segment: 232, root: 32, pad: 28.8, label: "320 200% with 44px insets" },
    { viewport: 960, segment: 300, root: 16, pad: 14.4, label: "960 fold default text" },
  ];
  for (const item of cases) {
    const usable = item.segment - 2 * item.pad;
    assert.ok(usable > 0, `${item.label} leaves usable width`);
    // The parsed 24rem query fires above every folded/narrow usable width,
    // so the container grids to minmax(0,1fr) full-width rows (pinned above).
    assert.ok(thresholdRem * item.root > usable, `${item.label} stacking query fires`);
    // Longest observed RTL label needs ~167px at 200%; stacked full-width
    // rows clear it because buttons shrink to the parsed zero minimum.
    const need = item.root === 32 ? 167 : 110;
    assert.ok(usable >= need, `${item.label} stacked row fits labels`);
  }
});

function navFixture(t) {
  const dom = new JSDOM(appHtml, { url: "https://pomodorough.test/app", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((el) => [el.id, el]));
  elements.screenButtons = [...document.querySelectorAll("[data-screen-button]")];
  const state = { activeScreen: "timer" };
  const view = viewModule.create({ state, external: { host: dom.window, elements }, use: {} });
  view.setupScreenNavigation();
  view.renderScreens();
  return { dom, document, elements, state, view };
}

function assertScreen(f, screen) {
  assert.equal(f.state.activeScreen, screen);
  for (const tab of f.elements.screenButtons) {
    const selected = tab.dataset.screenButton === screen;
    assert.equal(tab.getAttribute("aria-selected"), String(selected));
    assert.equal(tab.tabIndex, selected ? 0 : -1);
    const panel = f.document.getElementById(tab.getAttribute("aria-controls"));
    assert.equal(panel.hidden, !selected);
  }
}

test("R50-S05 roving tabindex, arrows, Home/End, and clicks survive the reflow", (t) => {
  const f = navFixture(t);
  assertScreen(f, "timer");
  assert.equal(f.document.activeElement, f.document.body);
  f.elements.timerTab.focus();
  for (const [key, screen] of [["ArrowRight", "tasks"], ["ArrowLeft", "tasks"], ["End", "tasks"], ["Home", "timer"]]) {
    f.elements.timerTab.focus();
    f.elements.timerTab.dispatchEvent(new f.dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    assertScreen(f, screen);
    assert.equal(f.document.activeElement, f.elements[`${screen}Tab`]);
  }
  f.elements.tasksTab.click();
  assertScreen(f, "tasks");
  assert.equal(f.document.activeElement, f.elements.tasksTab);
  f.elements.timerTab.click();
  assertScreen(f, "timer");
  assert.equal(f.document.activeElement, f.elements.timerTab);
});

test("R50-S05 skip-link still reveals and focuses the timer workbench", async (t) => {
  const f = navFixture(t);
  f.elements.tasksTab.click();
  assertScreen(f, "tasks");
  const link = f.document.querySelector(".skip-link");
  assert.ok(link, "skip link exists");
  assert.equal(link.getAttribute("href"), "#timer-workbench");
  link.focus();
  const navigation = f.document.location.hash === link.hash ? Promise.resolve()
    : new Promise((resolve) => f.dom.window.addEventListener("hashchange", resolve, { once: true }));
  link.click();
  assertScreen(f, "timer");
  assert.equal(f.document.activeElement, f.document.getElementById("timer-workbench"));
  await navigation;
  assert.equal(f.document.location.hash, "#timer-workbench");
});

test("R50-S05 tab identity, selection style, and narrow fallback are preserved", () => {
  assert.match(appHtml, /<nav class="screen-nav" aria-label="Pomodorough screens">/);
  assert.match(appHtml, /<div role="tablist" aria-label="Workspace"/);
  assert.match(appHtml, /id="timerTab"[^>]*role="tab"[^>]*aria-selected="true"[^>]*aria-controls="timerScreen"/);
  assert.match(appHtml, /id="tasksTab"[^>]*role="tab"[^>]*aria-selected="false"[^>]*aria-controls="tasksScreen"/);
  assert.match(appHtml, /<a id="skipTimerLink" class="skip-link" href="#timer-workbench"/);
  assert.match(appCss, /\.screen-nav button\[aria-selected="true"\]\s*\{[^}]*background:\s*var\(--platform\)/);
  assert.match(appCss, /\.screen-nav button\[aria-selected="true"\]\s*\{[^}]*border-left-color:\s*var\(--signal\)/);
  const narrowStart = appCss.indexOf("@media (max-width: 640px)");
  assert.ok(narrowStart >= 0, "narrow fallback exists");
  const narrow = appCss.slice(narrowStart, narrowStart + 3000);
  assert.match(narrow, /\.screen-nav \[role="tablist"\]\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(narrow, /\.screen-nav button\s*\{[^}]*min-width:\s*0/);
  assert.match(appCss, /\.skip-link:focus\s*\{[^}]*transform:\s*translateY\(0\)/);
});
