"use strict";

// R50-S06: enlarged timer digits must reflow inside the timer machine at
// 320px/200%, safe insets, 300px folds, and RTL. The machine keeps
// overflow:hidden for decoration; time and labels use zero minimums and wrap
// in place instead of clipping time or shrinking text. Live-browser evidence
// is recorded in scratch/fix-R50-S06.md (en 75..314 vs machine 294, inset
// 95..334 vs 274, RTL -14..224 vs 46, fold 463 vs 258).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const appCss = fs.readFileSync(path.join(__dirname, "app.css"), "utf8");
const appHtml = fs.readFileSync(path.join(__dirname, "app.html"), "utf8");
const viewSource = fs.readFileSync(path.join(__dirname, "app-view.js"), "utf8");
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

function s06Scope() {
  const marker = "R50-S06";
  const start = appCss.indexOf(marker);
  assert.ok(start >= 0, "R50-S06 block exists");
  const next = appCss.indexOf("/* R50-", start + marker.length);
  return appCss.slice(start, next < 0 ? appCss.length : next);
}

test("R50-S06 machine keeps decoration clip while descendants reflow", () => {
  const machine = blockOf(".timer-machine {");
  assert.match(machine, /overflow:\s*hidden/);
  assert.match(machine, /max-width:\s*100%/);
  assert.match(machine, /min-width:\s*0/);
  const plate = blockOf(".machine-plate {", appCss.indexOf("R50-S06"));
  assert.match(plate, /flex-wrap:\s*wrap/);
  assert.match(plate, /min-width:\s*0/);
  assert.match(plate, /max-width:\s*100%/);
});

test("R50-S06 dial and board use intrinsic widths, never clip time", () => {
  const dial = blockOf(".dial {", appCss.indexOf("R50-S06"));
  assert.match(dial, /min-width:\s*0/);
  assert.match(dial, /max-width:\s*100%/);
  assert.match(dial, /height:\s*auto/);
  assert.match(dial, /overflow:\s*visible/);
  const center = blockOf(".dial-center {", appCss.indexOf("R50-S06"));
  assert.match(center, /min-width:\s*0/);
  assert.match(center, /max-width:\s*100%/);
  assert.match(center, /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(center, /font-size/);
});

test("R50-S06 time wraps centered without shrinking text", () => {
  const display = blockOf(".timer-display {", appCss.indexOf("R50-S06"));
  assert.match(display, /max-width:\s*100%/);
  assert.match(display, /min-width:\s*0/);
  assert.match(display, /overflow-wrap:\s*anywhere/);
  assert.match(display, /white-space:\s*normal/);
  assert.match(display, /text-align:\s*center/);
  assert.match(display, /direction:\s*ltr/);
  assert.doesNotMatch(display, /font-size/);
  assert.doesNotMatch(display, /transform/);
  assert.doesNotMatch(display, /display:\s*none/);
  const scope = s06Scope();
  assert.ok(!/\.timer-display[^}]*font-size:\s*[0-9]/.test(scope), "S06 never resizes time");
});

test("R50-S06 labels reflow instead of ellipsis clipping", () => {
  const detail = blockOf(".timer-detail {", appCss.indexOf("R50-S06"));
  assert.match(detail, /max-width:\s*100%/);
  assert.match(detail, /white-space:\s*normal/);
  assert.match(detail, /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(detail, /ellipsis/);
  assert.doesNotMatch(detail, /nowrap/);
  const scope = s06Scope();
  assert.match(scope, /\.dial-phase/);
  assert.match(scope, /\.long-break-progress/);
  assert.match(scope, /text-align:\s*center/);
});

test("R50-S06 narrow machines expand the board from usable width", () => {
  const first = appCss.indexOf("@container timer-actions (max-width: 32rem)");
  assert.ok(first >= 0, "32rem machine rule exists");
  const second = appCss.indexOf("@container timer-actions (max-width: 20rem)");
  assert.ok(second >= 0, "20rem machine rule exists");
  let dialScope = "";
  let cursor = 0;
  for (;;) {
    const next = appCss.indexOf("@container timer-actions (max-width: 32rem)", cursor);
    if (next < 0) break;
    cursor = next + 1;
    const scope = appCss.slice(next, next + 900);
    if (scope.includes(".dial-center")) dialScope = scope;
  }
  assert.ok(dialScope.length > 0, "a 32rem block targets .dial-center");
  assert.match(dialScope, /\.dial\s*\{[^}]*width:\s*100%/);
  assert.match(dialScope, /\.dial-center\s*\{[^}]*width:\s*100%/);
  assert.ok(!/font-size/.test(dialScope), "expansion never shrinks text");
  assert.ok(!/display:\s*none/.test(dialScope), "expansion never hides time");
});

test("R50-S06 enlarged and fold budgets wrap time into usable width", () => {
  const display = blockOf(".timer-display {", appCss.indexOf("R50-S06"));
  assert.match(display, /white-space:\s*normal/, "parsed wrap token allows two lines");
  assert.match(display, /overflow-wrap:\s*anywhere/, "parsed break token allows two lines");
  const cases = [
    { viewport: 320, root: 32, pad: 28.8, label: "320 200% full width" },
    { viewport: 320, root: 32, pad: 44, label: "320 200% with 44px insets" },
    { viewport: 300, root: 32, pad: 22.4, label: "300 fold 200% first segment" },
    { viewport: 960, root: 16, pad: 14.4, label: "960 default first segment" },
  ];
  for (const item of cases) {
    const usable = item.viewport - 2 * item.pad;
    assert.ok(usable > 0, `${item.label} leaves usable width`);
    const singleLine = 5 * 0.62 * 4.25 * item.root;
    if (item.root === 32) assert.ok(singleLine > usable, `${item.label} single line overflows`);
    // Two wrapped lines share the single-line width; parsed wrap tokens above
    // let time reflow in place instead of clipping.
    const wrapped = singleLine / 2;
    assert.ok(wrapped <= usable, `${item.label} two-line reflow fits usable`);
  }
});

function timerFixture(t) {
  const dom = new JSDOM(appHtml, { url: "https://pomodorough.test/app", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((el) => [el.id, el]));
  return { dom, document, elements };
}

test("R50-S06 Core time, labels, and cadence survive the reflow", (t) => {
  const f = timerFixture(t);
  assert.match(appHtml, /<time id="timerDisplay" class="timer-display" role="timer"/);
  assert.match(appHtml, /<div class="dial-center">/);
  assert.match(appHtml, /<article class="timer-machine"/);
  assert.match(viewSource, /timeText = `\$\{String\(minutes\)/);
  assert.match(viewSource, /elements\.timerDisplay\.textContent = view\.timeText/);
  assert.match(viewSource, /elements\.phaseLabel\.textContent/);
  assert.match(viewSource, /elements\.dial\.dataset\.status = view\.status/);
  assert.match(viewSource, /strokeDashoffset = String\(DIAL_CIRCUMFERENCE/);
  const view = viewModule.create({ state: { activeScreen: "timer" }, external: { host: f.dom.window, elements: f.elements }, use: {} });
  const sample = view.timerDisplayView({ plannedDurationMs: 1500000 }, "paused");
  assert.equal(sample.timeText, "25:00");
  assert.equal(sample.minutes, 25);
});

test("R50-S06 actions, focus rings, and narrow fallbacks are preserved", () => {
  assert.match(appHtml, /id="timerToggle"[^>]*type="button"/);
  assert.match(appHtml, /id="finishButton"[^>]*type="button"/);
  assert.match(appHtml, /id="cancelButton"[^>]*type="button"/);
  assert.match(appCss, /\.action-bank button:focus-visible:not\(\.action-clear\)\s*\{[^}]*inset 0 0 0 3px var\(--porcelain\)/);
  assert.match(appCss, /@container timer-actions \(max-width:\s*32rem\)[\s\S]{0,400}?\.action-bank\s*\{[^}]*minmax\(0,\s*1\.35fr\)/);
  assert.match(appCss, /@media \(max-width:\s*640px\)[\s\S]{0,6000}?\.timer-display\s*\{[^}]*clamp\(3\.5rem/);
});
