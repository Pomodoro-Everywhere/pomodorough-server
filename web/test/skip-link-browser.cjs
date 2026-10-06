"use strict";

// Run with Playwright available on NODE_PATH; no browser dependency in the app.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");
const web = path.resolve(__dirname, "..");

async function loadPage(browser) {
  const page = await browser.newPage();
  const html = fs.readFileSync(path.join(web, "app.html"), "utf8").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  await page.route("https://skip.test/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/app") return route.fulfill({ contentType: "text/html", body: html });
    if (url.pathname === "/app.css") return route.fulfill({ contentType: "text/css", path: path.join(web, "app.css") });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto("https://skip.test/app?source=skip");
  const content = process.argv.includes("--baseline")
    ? execFileSync("git", ["show", "HEAD:web/app-view.js"], { cwd: path.join(web, ".."), encoding: "utf8" })
    : fs.readFileSync(path.join(web, "app-view.js"), "utf8");
  await page.addScriptTag({ content });
  await page.evaluate(() => {
    const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((el) => [el.id, el]));
    elements.screenButtons = [...document.querySelectorAll("[data-screen-button]")];
    window.skipState = { activeScreen: "timer" };
    const view = PomodoroughAppView.create({ state: window.skipState, external: { host: window, elements }, use: {} });
    view.setupScreenNavigation();
    view.renderScreens();
  });
  return page;
}

async function verifySkip(page, screen, activation) {
  await page.locator(`#${screen}Tab`).click();
  await page.locator(".skip-link").focus();
  if (activation === "Enter") await page.keyboard.press("Enter");
  else await page.locator(".skip-link").click();
  const result = await page.evaluate(() => ({
    focus: document.activeElement.id, hash: location.hash, search: location.search,
    visible: document.querySelector("#timer-workbench").checkVisibility(),
    screen: window.skipState.activeScreen,
    tabs: [...document.querySelectorAll('[role="tab"]')].map((tab) => [
      tab.id, tab.getAttribute("aria-selected"), tab.tabIndex,
      document.getElementById(tab.getAttribute("aria-controls")).hidden
    ])
  }));
  assert.deepEqual(result, {
    focus: "timer-workbench", hash: "#timer-workbench", search: "?source=skip", visible: true, screen: "timer",
    tabs: [["timerTab", "true", 0, false], ["tasksTab", "false", -1, true]]
  }, `${screen}: ${activation}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  let passed = 0;
  let failed = 0;
  try {
    for (const screen of ["timer", "tasks"]) {
      for (const activation of ["Enter", "click"]) {
        const page = await loadPage(browser);
        try {
          for (let repeat = 0; repeat < 3; repeat += 1) await verifySkip(page, screen, activation);
          passed += 1;
          console.log(`PASS ${screen} ${activation}, three activations`);
        } catch (error) {
          failed += 1;
          console.error(error);
        } finally { await page.close(); }
      }
    }
  } finally { await browser.close(); }
  console.log(`${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
