"use strict";

// R50-S02: timer-action keyboard focus must render inside the clipped shape.
// The action-bank clip-path clips the global outset outline away, so focused
// clipped actions draw two inset rings instead. These tests assert rendered
// preconditions (rule presence, ring geometry, per-fill contrast), not just
// outlineStyle/outlineWidth. Live-browser pixel evidence is in
// scratch/fix-R50-S02.md (57 checks: all three actions, both themes,
// keyboard order, narrow 320px at 200% text, forced-colors).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appCss = fs.readFileSync(path.join(__dirname, "app.css"), "utf8");
const appHtml = fs.readFileSync(path.join(__dirname, "app.html"), "utf8");
const appView = fs.readFileSync(path.join(__dirname, "app-view.js"), "utf8");
const appMain = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");

function luminance(hex) {
  const v = hex.replace("#", "");
  const rgb = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  const lin = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(fg, bg) {
  const hi = Math.max(luminance(fg), luminance(bg));
  const lo = Math.min(luminance(fg), luminance(bg));
  return (hi + 0.05) / (lo + 0.05);
}

// Palette under test: signal #ff604f, ticket #f5d05b, sky #dceaf1,
// porcelain #f7f8f2, platform #142c5c, track #111923.
function rootVar(name) {
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(appCss);
  assert.ok(m, `${name} defines a hex color`);
  return m[1].toLowerCase();
}

test("R50-S02 clipped action shape is preserved", () => {
  assert.match(appCss, /\.action-bank button\s*\{[^}]*clip-path:\s*polygon\(0 0, calc\(100% - 0\.7rem\) 0/);
  assert.match(appCss, /\.action-bank button\s*\{[^}]*border-radius:\s*0/);
  assert.match(appCss, /\.action-bank button\s*\{[^}]*min-height:\s*3\.45rem/);
});

test("R50-S02 focused clipped actions draw inset rings, not an outset outline", () => {
  const rule = /\.action-bank button:focus-visible:not\(\.action-clear\)\s*\{[^}]*\}/.exec(appCss);
  assert.ok(rule, "clipped action focus rule exists and spares .action-clear");
  assert.match(rule[0], /outline:\s*none/);
  assert.match(rule[0], /box-shadow:[^;]*inset 0 0 0 3px var\(--porcelain\)/);
  assert.match(rule[0], /inset 0 0 0 6px var\(--track\)/);
  assert.doesNotMatch(rule[0], /clip-path/);
});

test("R50-S02 primary action keeps its outer signal offset ahead of the rings", () => {
  const rule = /\.action-bank \.action-primary:focus-visible\s*\{[^}]*\}/.exec(appCss);
  assert.ok(rule, "primary focus rule exists");
  assert.match(rule[0], /box-shadow:[^;]*5px 5px 0 var\(--signal\)/);
  assert.match(rule[0], /inset 0 0 0 3px var\(--porcelain\)/);
  assert.match(rule[0], /inset 0 0 0 6px var\(--track\)/);
});

test("R50-S02 forced-colors fallback keeps a visible outline", () => {
  const block = /@media\s*\(forced-colors:\s*active\)\s*\{[\s\S]*?\.action-bank button:focus-visible:not\(\.action-clear\)\s*\{[^}]*\}/.exec(appCss);
  assert.ok(block, "forced-colors focus override exists");
  assert.match(block[0], /outline:\s*3px solid CanvasText/);
  assert.match(block[0], /outline-offset:\s*-\d+px/);
});

test("R50-S02 inset rings sit strictly inside the corner cut", () => {
  // Cut depth and deepest ring band both parse from production CSS: at y=ring
  // the cut boundary sits at W-cut+ring, right of the ring corner at W-ring,
  // so the full ring renders inside the polygon.
  const cut = /calc\(100% - ([0-9.]+)rem\)\s*0,\s*100%\s*([0-9.]+)rem/.exec(appCss);
  assert.ok(cut, "clip-path cut depth parses from CSS");
  const cutRem = Number(cut[1]);
  assert.equal(Number(cut[2]), cutRem, "cut polygon stays symmetric");
  const focusRule = /\.action-bank button:focus-visible:not\(\.action-clear\)\s*\{[^}]*\}/.exec(appCss);
  assert.ok(focusRule, "clipped focus rule parses for ring widths");
  const rings = [...focusRule[0].matchAll(/inset 0 0 0 ([0-9.]+)px/g)].map((m) => Number(m[1]));
  assert.ok(rings.length >= 2, "both inset ring bands parse from CSS");
  const ringPx = Math.max(...rings);
  const cutPx = cutRem * 16;
  assert.ok(cutPx - ringPx < ringPx, `cut remainder ${cutPx - ringPx}px stays inside the ${ringPx}px ring`);
});

for (const [ring, fill, label] of [
  ["#111923", "#f5d05b", "track ring on ticket primary"],
  ["#111923", "#dceaf1", "track ring on sky key"],
  ["#f7f8f2", "#142c5c", "porcelain ring on navy danger"],
]) {
  test(`R50-S02 ${label} passes 4.5 contrast`, () => {
    assert.ok(contrast(ring, fill) >= 4.5, `${ring} on ${fill} = ${contrast(ring, fill).toFixed(2)}`);
  });
}

test("R50-S02 ring palette resolves in both appearances", () => {
  assert.equal(rootVar("--signal"), "#ff604f");
  assert.equal(rootVar("--ticket"), "#f5d05b");
  assert.equal(rootVar("--porcelain"), "#f7f8f2");
  assert.equal(rootVar("--track"), "#111923");
  assert.equal(rootVar("--platform"), "#142c5c");
  const dark = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{[\s\S]*\}/.exec(appCss)[0];
  assert.doesNotMatch(dark, /\.action-bank/);
});

test("R50-S02 action order, identity, and callbacks are preserved", () => {
  const bank = /<div class="action-bank"[^>]*>([\s\S]*?)<\/div>/.exec(appHtml);
  assert.ok(bank, "action bank exists");
  const ids = [...bank[1].matchAll(/<button[^>]*id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["timerToggle", "finishButton", "cancelButton", "clearButton"]);
  for (const id of ["timerToggle", "finishButton", "cancelButton"]) {
    assert.match(bank[1], new RegExp(`<button[^>]*id="${id}"[^>]*type="button"`), `${id} stays a native button`);
    assert.ok(appMain.includes(`"${id}"`), `app.js still wires ${id}`);
  }
  assert.match(appView, /elements\.timerToggle\.addEventListener\("click"/);
  assert.match(appView, /elements\.finishButton\.addEventListener\("click"/);
  assert.match(appView, /elements\.cancelButton\.addEventListener\("click"/);
});

test("R50-S02 keyboard and narrow tracks are preserved", () => {
  assert.doesNotMatch(appHtml, /id="timerToggle"[^>]*tabindex/);
  assert.doesNotMatch(appHtml, /id="finishButton"[^>]*tabindex/);
  assert.doesNotMatch(appHtml, /id="cancelButton"[^>]*tabindex/);
  assert.match(appCss, /@container timer-actions \(max-width:\s*32rem\)/);
  assert.match(appCss, /@container timer-actions \(max-width:\s*20rem\)/);
  assert.match(appCss, /@media\s*\(max-width:\s*370px\)[\s\S]*?\.action-bank button\s*\{/);
});

test("R50-S02 global focus indicator still covers unclipped controls", () => {
  assert.match(appCss, /button:focus-visible,[\s\S]{0,120}outline:\s*3px solid var\(--signal\)/);
  assert.match(appCss, /\.action-clear\s*\{[^}]*clip-path:\s*none !important/);
  assert.match(appCss, /\.site-footer a:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--signal\)/);
});
