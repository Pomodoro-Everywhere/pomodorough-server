"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "app.html"), "utf8");

function workbenchTag() {
  const match = html.match(/<section[^>]*\bid="timer-workbench"[^>]*>/);
  assert.ok(match, "app.html must contain a #timer-workbench section");
  return match[0];
}

test("S70 skip link targets the timer workbench", () => {
  assert.match(html, /<a[^>]*class="skip-link"[^>]*href="#timer-workbench"[^>]*>/);
  assert.equal(html.match(/\bid="timer-workbench"/g).length, 1);
});

test("S70 timer workbench is programmatically focusable for the skip link", () => {
  const tag = workbenchTag();
  const tabindex = tag.match(/\btabindex="([^"]*)"/);
  assert.ok(tabindex, "#timer-workbench must carry a tabindex so the skip link moves focus");
  assert.equal(tabindex[1], "-1");
});

test("S70 focusing the workbench does not add it to the tab order", () => {
  const tag = workbenchTag();
  assert.doesNotMatch(tag, /\btabindex="0"/);
  assert.match(html, /<div id="timerScreen"[^>]*role="tabpanel"[^>]*>/);
});
