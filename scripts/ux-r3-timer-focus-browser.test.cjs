"use strict";

// PWA-20 in a real browser. Chromium moves keyboard focus to the page body at
// the moment a focused button hides, which jsdom does not do, so the hand-off
// to the primary timer control needs this leg.

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const { chromium } = require(process.env.POMODOROUGH_PLAYWRIGHT_MODULE || "playwright");
const fixture = JSON.parse(readFileSync(0, "utf8"));

const KEYS = ["Enter", "Space"];
const WAIT = { timeout: 15_000, polling: 100 };

async function authenticatedContext(browser) {
  const context = await browser.newContext({ serviceWorkers: "allow", bypassCSP: false, ignoreHTTPSErrors: true });
  await context.addCookies([
    { name: fixture.sessionCookie, value: fixture.sessionToken, httpOnly: true },
    { name: fixture.csrfCookie, value: fixture.csrfToken, httpOnly: false }
  ].map((cookie) => ({ ...cookie, url: `${fixture.url}/`, secure: true, sameSite: "Lax" })));
  await context.addInitScript(() => { window.PomodoroughAppTest = { disableAutoStart: false }; });
  // No scene signs out; this keeps any navigation away from the real sign-in provider.
  await context.route((url) => url.pathname === "/auth/google/start",
    (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>signed out</title>" }));
  return context;
}

async function waitForReady(page) {
  try {
    await page.waitForFunction(() => window.PomodoroughAppTest?.state?.ready
      && !window.PomodoroughAppTest.state.bootstrapBlocked, null, WAIT);
  } catch (error) {
    const failure = await page.evaluate(() => ({ ready: window.PomodoroughAppTest?.state?.ready }));
    throw new Error(`Startup did not reach ready: ${JSON.stringify(failure)}`, { cause: error });
  }
}

function waitForIdle(page) {
  return page.waitForFunction(() => {
    const state = window.PomodoroughAppTest.state;
    return !state.actionLocked && !state.syncing && state.pending.length + state.pendingTaskOperations.length === 0;
  }, null, WAIT);
}

function waitForShown(page, id) {
  return page.waitForFunction((name) => {
    const control = document.getElementById(name);
    return !control.hidden && !control.disabled;
  }, id, WAIT);
}

function focusedId(page) {
  return page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
}

async function startRun(page) {
  await page.locator("#timerToggle").click();
  await waitForShown(page, "cancelButton");
  await waitForIdle(page);
}

// Presses the key on the focused bank control and expects focus on the
// start/pause button once the control has hidden.
async function assertKeyHandsFocusToPrimary(page, id, key) {
  await waitForShown(page, id);
  await page.locator(`#${id}`).focus();
  assert.equal(await focusedId(page), id, `${id} takes focus before ${key}`);
  await page.keyboard.press(key);
  await page.waitForFunction((name) => document.getElementById(name).hidden, id, WAIT);
  await waitForIdle(page);
  assert.equal(await focusedId(page), "timerToggle", `focus after ${key} on ${id}`);
  console.log(`focus after ${key} on ${id}: timerToggle`);
}

async function assertShownControlKeepsFocus(page) {
  await startRun(page);
  await page.locator("#finishButton").focus();
  // The running timer renders every second; two renders must leave focus alone.
  await page.waitForTimeout(2_200);
  assert.equal(await focusedId(page), "finishButton", "a bank control that stays shown keeps focus");
  await page.locator("#cancelButton").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("cancelButton").hidden, null, WAIT);
  await waitForIdle(page);
}

test("PWA-20 a timer control that hides hands keyboard focus to the start/pause button",
  { timeout: 180_000 }, async (t) => {
    const browser = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors"],
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
    t.after(() => browser.close());
    console.log(`Browser ${browser.version()}`);
    const context = await authenticatedContext(browser);
    t.after(() => context.close());
    const page = await context.newPage();
    const response = await page.goto(`${fixture.url}/app`);
    assert.equal(response.status(), 200);
    await waitForReady(page);
    await waitForIdle(page);
    const failures = [];
    for (const key of KEYS) {
      for (const id of ["cancelButton", "finishButton", "clearButton"]) {
        // Stop sound follows the Finish before it; Cancel and Finish need a run.
        if (id !== "clearButton") await startRun(page);
        try { await assertKeyHandsFocusToPrimary(page, id, key); }
        catch (error) {
          if (error.code !== "ERR_ASSERTION") throw error;
          failures.push(error.message);
        }
      }
    }
    assert.deepEqual(failures, []);
    await assertShownControlKeepsFocus(page);
  });
