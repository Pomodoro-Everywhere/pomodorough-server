"use strict";

// R50-S07: populated history must reflow inside the viewport at 768x900
// 200% EN/RTL. The viewport-only 640px breakpoint misses enlarged intrinsic
// rem minimums, so rows end at 812px vs 812px doc width (RTL negative
// start). Container history width drives stacking; date/duration take extra
// rows before tracks overflow. Live-browser evidence in
// scratch/fix-R50-S07.md (en 707/782 widths, RTL 791/821, -53..33 starts).

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

function historyUse() {
  return {
    tr: (_k, _v, fallback) => fallback,
    phaseLabel: (phase) => phase,
    phaseShortLabel: (phase) => phase.slice(0, 1).toUpperCase(),
    phaseConfig: () => ({ focus: 1, short_break: 1 }),
    positiveNumber: (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback),
    historyDateMs: (item) => Date.parse(item.completedAt || item.endedAt || 0),
  };
}

function historyFixture(t, history, tasks = []) {
  const dom = new JSDOM(appHtml, { url: "https://pomodorough.test/app", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((el) => [el.id, el]));
  const state = { history, tasks, activeScreen: "timer" };
  const view = viewModule.create({ state, external: { host: dom.window, elements }, use: historyUse() });
  return { dom, document, elements, state, view };
}

const populated = [
  { id: "history-1", timerId: "t-1", phase: "focus", status: "completed", plannedDurationMs: 1500000, completedAt: "2026-08-26T08:00:00Z", taskId: "task-1" },
  { id: "history-2", timerId: "t-2", phase: "focus", status: "cancelled", plannedDurationMs: 1500000, endedAt: "2026-08-26T09:00:00Z" },
  { id: "history-3", timerId: "t-3", phase: "short_break", status: "completed", plannedDurationMs: 300000, completedAt: "2026-08-26T10:00:00Z", taskId: "missing" },
];

test("R50-S07 history derives rows from usable container width", () => {
  const strip = blockOf(".history-strip {");
  assert.match(strip, /container-type:\s*inline-size/);
  assert.match(strip, /min-width:\s*0/);
  assert.match(strip, /max-width:\s*100%/);
  assert.match(appCss, /main\s*\{[^}]*container-type:\s*inline-size/);
  assert.doesNotMatch(strip, /minmax\(8rem/);
});

test("R50-S07 default tracks use zero minimums, descendants wrap", () => {
  const item = blockOf(".history-item {");
  assert.match(item, /3rem minmax\(0,\s*1fr\) minmax\(0,\s*0\.85fr\) auto/);
  assert.match(item, /min-width:\s*0/);
  assert.match(item, /max-width:\s*100%/);
  assert.doesNotMatch(item, /minmax\(8rem/);
  const phase = blockOf(".history-phase {");
  assert.match(phase, /min-width:\s*0/);
  assert.match(phase, /max-width:\s*100%/);
  assert.match(phase, /overflow-wrap:\s*anywhere/);
  const meta = blockOf(".history-date,");
  assert.match(meta, /min-width:\s*0/);
  assert.match(meta, /max-width:\s*100%/);
  assert.match(meta, /overflow-wrap:\s*anywhere/);
  assert.match(meta, /white-space:\s*normal/);
  const duration = blockOf(".history-duration {", appCss.indexOf("R50-S07"));
  assert.match(duration, /justify-self:\s*start/);
  assert.match(duration, /max-width:\s*100%/);
  assert.doesNotMatch(appCss.slice(appCss.indexOf("R50-S07"), appCss.indexOf("R50-S07") + 4000), /font-size:\s*0\s*;/);
});

test("R50-S07 timeline and empty use logical insets, shrinkable padding", () => {
  assert.match(appCss, /\.history-list::before\s*\{[^}]*inset-inline-start:\s*1\.42rem/);
  assert.doesNotMatch(appCss, /\.history-list::before\s*\{[^}]*\n\s*left:\s*1\.42rem/);
  assert.match(appCss, /\.history-empty::before\s*\{[^}]*inset-inline-start:\s*1\.06rem/);
  const empty = blockOf(".history-empty {");
  assert.match(empty, /min-width:\s*0/);
  assert.match(empty, /max-width:\s*100%/);
  assert.match(empty, /padding:\s*2rem clamp\(1rem,\s*4vw,\s*4rem\)/);
  assert.doesNotMatch(empty, /padding:\s*2rem 4rem;/);
  const list = blockOf(".history-list {");
  assert.match(list, /min-width:\s*0/);
  assert.match(list, /max-width:\s*100%/);
});

test("R50-S07 40rem container stacks date before tracks overflow", () => {
  const marker = "@container (max-width: 40rem)";
  assert.ok(appCss.includes(marker), "40rem history rule exists");
  let scope = "";
  let cursor = 0;
  for (;;) {
    const next = appCss.indexOf(marker, cursor);
    if (next < 0) break;
    cursor = next + 1;
    const candidate = appCss.slice(next, next + 1200);
    if (candidate.includes(".history-date")) scope = candidate;
  }
  assert.ok(scope.length > 0, "a 40rem block targets history");
  assert.match(scope, /\.history-item\s*\{[^}]*3rem minmax\(0,\s*1fr\) auto/);
  assert.match(scope, /\.history-date\s*\{[^}]*grid-column:\s*2 \/ -1/);
  assert.match(scope, /\.history-date\s*\{[^}]*grid-row:\s*2/);
  assert.match(scope, /\.history-stamp\s*\{[^}]*grid-row:\s*1 \/ 3/);
  assert.ok(!/font-size\s*:/.test(scope), "stacking never shrinks text");
  assert.ok(!/display:\s*none/.test(scope), "stacking never hides rows");
});

test("R50-S07 26rem container stacks duration for narrowest rows", () => {
  const marker = "@container (max-width: 26rem)";
  assert.ok(appCss.includes(marker), "26rem rule exists");
  let scope = "";
  let cursor = 0;
  for (;;) {
    const next = appCss.indexOf(marker, cursor);
    if (next < 0) break;
    cursor = next + 1;
    const candidate = appCss.slice(next, next + 1400);
    if (candidate.includes(".history-duration") && candidate.includes(".history-item")) scope = candidate;
  }
  assert.ok(scope.length > 0, "a 26rem block targets history duration");
  assert.match(scope, /\.history-item\s*\{[^}]*3rem minmax\(0,\s*1fr\)/);
  assert.match(scope, /\.history-date\s*\{[^}]*grid-column:\s*2/);
  assert.match(scope, /\.history-duration\s*\{[^}]*grid-column:\s*2/);
  assert.match(scope, /\.history-duration\s*\{[^}]*grid-row:\s*3/);
  assert.match(scope, /\.history-stamp\s*\{[^}]*grid-row:\s*1 \/ 4/);
});

test("R50-S07 tablet/narrow/inset/fold budgets stack from parsed thresholds", () => {
  const item = blockOf(".history-item {");
  const minima = [...item.matchAll(/minmax\(\s*([^,]+?),/g)].map((m) => m[1].trim());
  assert.ok(minima.length >= 2, "history track minima parse from CSS");
  for (const min of minima) assert.equal(min, "0", `history track minimum ${min} stays shrinkable`);
  let dateThreshold = 0;
  let cursor = 0;
  for (;;) {
    const next = appCss.indexOf("@container (max-width: 40rem)", cursor);
    if (next < 0) break;
    cursor = next + 1;
    if (appCss.slice(next, next + 1200).includes(".history-date")) dateThreshold = 40;
  }
  assert.equal(dateThreshold, 40, "date stacking threshold parses from CSS");
  let durationThreshold = 0;
  cursor = 0;
  for (;;) {
    const next = appCss.indexOf("@container (max-width: 26rem)", cursor);
    if (next < 0) break;
    cursor = next + 1;
    if (appCss.slice(next, next + 1400).includes(".history-duration")) durationThreshold = 26;
  }
  assert.equal(durationThreshold, 26, "duration stacking threshold parses from CSS");
  const cases = [
    { viewport: 768, seg: 768, root: 32, pad: 30.7, label: "768 200% tablet" },
    { viewport: 320, seg: 320, root: 32, pad: 28.8, label: "320 200% narrow" },
    { viewport: 320, seg: 232, root: 32, pad: 28.8, label: "320 200% 44px insets" },
    { viewport: 300, seg: 300, root: 32, pad: 22.4, label: "300 fold 200% segment" },
    { viewport: 960, seg: 300, root: 32, pad: 28.8, label: "960 fold 200% first segment" },
    { viewport: 768, seg: 768, root: 16, pad: 30.7, label: "768 default control" },
  ];
  for (const c of cases) {
    const usable = c.seg - 2 * c.pad - 6;
    assert.ok(usable > 0, `${c.label} leaves usable width`);
    const stamp = 3 * c.root;
    const stacked = usable - stamp - 2 * c.root;
    assert.ok(stacked > 0, `${c.label} stacked row leaves text width`);
    if (c.root === 32) {
      // Parsed 40rem/26rem queries fire above every 200% usable width, so
      // date/duration take full stacked rows (pinned above) instead of
      // overflowing the zero-minimum tracks.
      assert.ok(dateThreshold * c.root > usable, `${c.label} date query fires`);
      assert.ok(durationThreshold * c.root > usable, `${c.label} duration query fires`);
    }
  }
});

test("R50-S07 populated history preserves IDs, order, dates, status", (t) => {
  const tasks = [{ id: "task-1", title: "Write report" }];
  const f = historyFixture(t, populated, tasks);
  f.view.renderHistory();
  assert.equal(f.elements.historyCount.textContent, "003");
  const rows = [...f.elements.historyList.children];
  assert.equal(rows.length, 3);
  for (const row of rows) assert.equal(row.className, "history-item");
  // Newest first: history-3, history-2, history-1.
  const stamps = rows.map((row) => row.children[0].textContent);
  assert.deepEqual(stamps, ["S", "F", "F"]);
  assert.equal(rows[0].children[1].textContent.includes("Completed"), true);
  assert.equal(rows[1].children[1].textContent.includes("Cancelled"), true);
  assert.ok(rows[0].children[2].textContent.length > 0, "date renders");
  assert.ok(rows[1].children[2].textContent.length > 0, "endedAt renders as date");
  assert.match(rows[0].children[3].textContent, /min/);
  assert.match(rows[2].children[3].textContent, /25 min/);
  // Task association preserved, missing task falls back without ID loss.
  assert.ok(rows[0].children[1].textContent.includes("Deleted task"), "missing task labels");
  assert.ok(rows[2].children[1].textContent.includes("Write report"), "task title survives");
  assert.match(viewSource, /listItem\.className = "history-item"/);
  assert.match(viewSource, /date\.className = "history-date"/);
  assert.match(viewSource, /duration\.className = "history-duration"/);
});

test("R50-S07 empty control stays, narrow/inset rules preserved", (t) => {
  const f = historyFixture(t, []);
  f.view.renderHistory();
  assert.equal(f.elements.historyCount.textContent, "000");
  assert.equal(f.elements.historyList.children.length, 1);
  assert.equal(f.elements.historyList.children[0].className, "history-empty");
  assert.match(appHtml, /<ol id="historyList" class="history-list">/);
  assert.match(appHtml, /<li class="history-empty"><strong[^>]*>No arrivals yet<\/strong>/);
  const narrowStart = appCss.indexOf("@media (max-width: 640px)");
  assert.ok(narrowStart >= 0, "narrow fallback exists");
  const narrow = appCss.slice(narrowStart, narrowStart + 7000);
  assert.match(narrow, /\.history-item\s*\{[^}]*3rem minmax\(0,\s*1fr\) auto/);
  assert.match(narrow, /\.history-date\s*\{[^}]*grid-column:\s*2 \/ -1/);
  assert.match(appCss, /\.history-stamp\s*\{[^}]*border-radius:\s*50%/);
  assert.match(appCss, /\.history-count\s*\{[^}]*min-width:\s*0/);
});
