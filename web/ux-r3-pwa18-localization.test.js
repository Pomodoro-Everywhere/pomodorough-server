"use strict";

// PWA-18: the minute unit, the screen navigation label, the landing page and
// the signed-out and not-found pages all follow the selected locale. The
// pseudolocale wraps every translated string in ⟦…⟧, so English text left in
// the page shows up as an unwrapped text node.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");
const catalogs = { en: JSON.parse(read("locales/en.json")), "ar-XB": JSON.parse(read("locales/ar-XB.json")) };
const { createI18n } = require("./i18n.js");

// Brand names, decorative codes and the wordmark letter stay as written.
const untranslated = new Set(["Pomodorough", "P", "Apple", "Android", "APL", "DSK", "AND", "PMD / 25", "↗", "!"]);

function englishTextNodes(document) {
  const walker = document.createTreeWalker(document.body, document.defaultView.NodeFilter.SHOW_TEXT);
  const leftovers = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.trim();
    if (!text || untranslated.has(text) || text.includes("⟦")) continue;
    leftovers.push(text);
  }
  return leftovers;
}

async function openPublicPage(t, name, userAgent = "PomodoroughTest/1.0") {
  const dom = new JSDOM(read(name), {
    url: "https://pomodorough.test/?locale=ar-XB",
    runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  Object.defineProperty(window.navigator, "userAgent", { value: userAgent });
  const requests = [];
  window.fetch = async (url) => {
    requests.push(url);
    const locale = /\/locales\/([^.]+)\.json/.exec(url)?.[1];
    return { ok: Boolean(catalogs[locale]), status: 200, json: async () => catalogs[locale] };
  };
  window.eval(read("platform-selector.js"));
  window.eval(read("i18n.js"));
  window.eval(read("landing.js"));
  const deadline = Date.now() + 2000;
  while (window.document.documentElement.dir !== "rtl" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  return { window, document: window.document, requests };
}

test("PWA-18 app minute units and the screen navigation label are localized", () => {
  const dom = new JSDOM(read("app.html"));
  const { document } = dom.window;
  createI18n({ catalogs, locale: "ar-XB" }).applyDocument(document);
  const units = [...document.querySelectorAll(".minute-unit")];
  assert.ok(units.length >= 3, "every duration stepper has a unit");
  for (const unit of units) assert.equal(unit.textContent, catalogs["ar-XB"]["pattern.minuteUnit"]);
  assert.equal(document.querySelector(".screen-nav").getAttribute("aria-label"), catalogs["ar-XB"]["nav.screens"]);
  dom.window.close();
});

test("PWA-18 the landing page has no English left in the pseudolocale", async (t) => {
  const { document, requests } = await openPublicPage(t, "index.html");
  assert.deepEqual(requests, ["/locales/en.json?v=7", "/locales/ar-XB.json?v=7"]);
  assert.equal(document.documentElement.dir, "rtl");
  assert.deepEqual(englishTextNodes(document), []);
  assert.equal(document.title, catalogs["ar-XB"]["landing.documentTitle"]);
});

test("PWA-18 the landing platform suggestion follows the locale", async (t) => {
  const { document } = await openPublicPage(t, "index.html", "Mozilla/5.0 (X11; Linux x86_64)");
  const ar = catalogs["ar-XB"];
  assert.equal(document.querySelector("[data-native-cta]").textContent, ar["landing.platform.linux.label"]);
  assert.equal(document.querySelector("[data-platform-name]").textContent, ar["landing.platform.linux.name"]);
  assert.equal(document.querySelector("[data-platform-note]").textContent,
    ar["landing.platform.suggestion"].replace("{platform}", ar["landing.platform.linux.name"]));
});

for (const page of ["signed-out.html", "not-found.html"]) {
  test(`PWA-18 ${page} has no English left in the pseudolocale`, async (t) => {
    const { document } = await openPublicPage(t, page);
    assert.equal(document.documentElement.dir, "rtl");
    assert.deepEqual(englishTextNodes(document), []);
  });
}

test("PWA-18 a missing catalog keeps the English landing and logs the reason", async (t) => {
  const dom = new JSDOM(read("index.html"), { url: "https://pomodorough.test/", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const warnings = [];
  // jsdom's own user agent names the host OS; a neutral one keeps the
  // recommendation on "View native apps" on every host.
  Object.defineProperty(dom.window.navigator, "userAgent", { value: "PomodoroughTest/1.0" });
  dom.window.console.warn = (...args) => warnings.push(args.map(String).join(" "));
  dom.window.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  dom.window.eval(read("platform-selector.js"));
  dom.window.eval(read("i18n.js"));
  dom.window.eval(read("landing.js"));
  for (let tries = 0; tries < 200 && warnings.length === 0; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.match(warnings.join("\n"), /public page kept English: .*locale en failed \(503\)/);
  assert.equal(dom.window.document.querySelector("h1").textContent, "Keep focus moving.");
  assert.equal(dom.window.document.querySelector("[data-native-cta]").textContent, "View native apps");
});
