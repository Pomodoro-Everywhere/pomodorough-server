"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appCss = fs.readFileSync(path.join(__dirname, "app.css"), "utf8");

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

test("R49 combos stack from usable width without hinge guesses", () => {
  assert.match(appCss, /main\s*\{[^}]*container-type:\s*inline-size/);
  assert.match(appCss, /\.recipe-rail\s*\{[^}]*container-type:\s*inline-size/);
  assert.match(appCss, /@container\s*\(max-width:\s*24rem\)/);
  assert.match(appCss, /@container\s*\(max-width:\s*12rem\)/);
  assert.match(appCss, /@container\s*\(max-width:\s*57\.5625rem\)/);
  assert.doesNotMatch(appCss, /470px/);
  assert.doesNotMatch(appCss, /490px/);
  assert.doesNotMatch(appCss, /viewport-segment-gap/);
});

test("R49 combos keep narrow fallback and target minimums", () => {
  assert.match(appCss, /@media\s*\(max-width:\s*370px\)[\s\S]{0,400}\.duration-row\s*\{[^}]*minmax\(0,\s*1fr\)/);
  assert.match(appCss, /\.stepper button\s*\{[^}]*min-width:\s*2\.75rem/);
  assert.doesNotMatch(appCss, /@container[^;{]*\{[^}]*font-size:\s*0/);
  assert.ok(!/@container[\s\S]{0,600}?\.stepper[^}]*display:\s*none/.test(appCss));
});

test("R49 combos preserve safe-area and segment tokens", () => {
  for (const token of ["env(safe-area-inset-top", "env(safe-area-inset-left",
    "env(safe-area-inset-right", "env(safe-area-inset-bottom",
    "env(viewport-segment-width 0 0", "horizontal-viewport-segments"]) {
    assert.ok(appCss.includes(token), `${token} present`);
  }
});

test("R49 S10 guard footer states stay readable after layout changes", () => {
  const bg = "#0c1b39";
  const colors = {};
  const base = /\.site-footer a,\s*\.site-footer a:link\s*\{[^}]*color:\s*(#[0-9a-fA-F]{6})/.exec(appCss);
  if (base) colors.link = base[1].toLowerCase();
  for (const name of ["visited", "hover", "focus", "active"]) {
    const m = new RegExp(`\\.site-footer a:${name}\\s*\\{[^}]*color:\\s*(#[0-9a-fA-F]{6})`).exec(appCss);
    if (m) colors[name] = m[1].toLowerCase();
  }
  for (const name of ["link", "visited", "hover", "focus", "active"]) {
    assert.ok(colors[name], `${name} color defined`);
    assert.ok(contrast(colors[name], bg) >= 4.5, `${name} ${colors[name]} >= 4.5`);
    assert.notEqual(colors[name], "#0000ee", `${name} avoids browser blue`);
  }
  assert.match(appCss, /\.site-footer a:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--signal\)/);
});
