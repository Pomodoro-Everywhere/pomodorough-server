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

function footerColors() {
  const out = {};
  for (const name of ["link", "visited", "hover", "focus", "focus-visible", "active"]) {
    const re = new RegExp(`\\.site-footer a:${name}\\s*\\{[^}]*color:\\s*(#[0-9a-fA-F]{6})`, "g");
    const m = re.exec(appCss);
    if (m) out[name] = m[1].toLowerCase();
  }
  const base = /\.site-footer a,\s*\.site-footer a:link\s*\{[^}]*color:\s*(#[0-9a-fA-F]{6})/.exec(appCss);
  if (base) out.link = base[1].toLowerCase();
  return out;
}

test("R48-S10 footer anchors define explicit link and visited colors", () => {
  const colors = footerColors();
  assert.ok(colors.link, "unvisited link color exists");
  assert.ok(colors.visited, "visited color exists");
  assert.notEqual(colors.link, "#0000ee", "no browser blue");
  assert.doesNotMatch(appCss, /\.site-footer\s*\{[^}]*#0000ee/);
});

test("R48-S10 every footer link state passes 4.5 on dark fill", () => {
  const bg = "#0c1b39";
  const colors = footerColors();
  for (const name of ["link", "visited", "hover", "focus", "focus-visible", "active"]) {
    assert.ok(colors[name], `${name} color defined`);
    assert.ok(contrast(colors[name], bg) >= 4.5, `${name} ${colors[name]} >= 4.5`);
  }
});

test("R48-S10 footer keeps non-color cue and visible focus", () => {
  assert.match(appCss, /\.site-footer a,\s*\.site-footer a:link\s*\{[^}]*text-decoration:\s*underline/);
  assert.match(appCss, /\.site-footer a:visited\s*\{[^}]*text-decoration:\s*underline/);
  assert.match(appCss, /\.site-footer a:hover\s*\{[^}]*text-decoration:\s*underline/);
  assert.match(appCss, /\.site-footer a:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--signal\)/);
  assert.match(appCss, /a:focus-visible[\s\S]{0,120}outline:\s*3px solid var\(--signal\)/);
});

test("R48-S10 S08 S09 styling still present", () => {
  assert.match(appCss, /env\(safe-area-inset-top/);
  assert.match(appCss, /env\(safe-area-inset-bottom/);
  assert.match(appCss, /env\(viewport-segment-width 0 0/);
  assert.match(appCss, /env\(viewport-segment-top 0 1/);
  assert.doesNotMatch(appCss, /viewport-segment-gap/);
});
