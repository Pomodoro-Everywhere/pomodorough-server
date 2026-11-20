"use strict";

// PWA-13 and PWA-14: the app's wordmark stays inside the service worker's
// /app scope so it works offline, both app privacy links open the serving
// origin's page in a new tab so the installed app keeps running, and no
// wordmark carries an aria-label that hides its visible text.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

function page(name) {
  return new JSDOM(fs.readFileSync(path.join(__dirname, name), "utf8")).window.document;
}

test("PWA-13 app wordmark links inside the service worker scope", () => {
  const wordmark = page("app.html").querySelector(".wordmark");
  assert.equal(wordmark.getAttribute("href"), "/app");
  const worker = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
  assert.match(worker, /serviceWorker\.register\("\/sw\.js", \{ scope: "\/app" \}\)/);
});

test("PWA-13 both app privacy links open the local page in a new tab", () => {
  const links = [...page("app.html").querySelectorAll('a[href*="privacy"]')];
  assert.equal(links.length, 2);
  for (const link of links) {
    assert.equal(link.getAttribute("href"), "/privacy");
    assert.equal(link.getAttribute("target"), "_blank");
    assert.equal(link.getAttribute("rel"), "noopener");
  }
  const landing = [...page("index.html").querySelectorAll('a[href*="privacy"]')];
  assert.deepEqual(landing.map((link) => [link.getAttribute("href"), link.getAttribute("target")]), [["/privacy", null]]);
});

test("PWA-14 wordmarks are named by their visible text", () => {
  for (const name of ["app.html", "index.html"]) {
    const wordmark = page(name).querySelector(".wordmark");
    assert.equal(wordmark.getAttribute("aria-label"), null, name);
    assert.match(wordmark.textContent.replace(/\s+/g, " "), /Pomodorough Time, in transit/, name);
  }
  const departure = page("index.html").getElementById("departure");
  assert.equal(departure.tagName, "SECTION");
  assert.equal(departure.getAttribute("aria-labelledby"), "departure-title");
});
