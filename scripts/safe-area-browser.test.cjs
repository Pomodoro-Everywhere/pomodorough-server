"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const { chromium } = require(process.env.POMODOROUGH_PLAYWRIGHT_MODULE || "playwright");
const fixture = JSON.parse(readFileSync(0, "utf8"));

const INSETS = { top: 47, left: 44, right: 44, bottom: 34 };
const VIEWPORTS = [[320, 568], [375, 667], [428, 926], [667, 375], [926, 428], [480, 720]];

async function authenticatedContext(browser) {
  const context = await browser.newContext({ serviceWorkers: "allow", bypassCSP: false, ignoreHTTPSErrors: true });
  await context.addCookies([
    { name: fixture.sessionCookie, value: fixture.sessionToken, httpOnly: true },
    { name: fixture.csrfCookie, value: fixture.csrfToken, httpOnly: false }
  ].map((cookie) => ({ ...cookie, url: `${fixture.url}/`, secure: true, sameSite: "Lax" })));
  await context.addInitScript(() => { window.PomodoroughAppTest = { disableAutoStart: false }; });
  return context;
}

async function waitForReady(page) {
  try {
    await page.waitForFunction(() => window.PomodoroughAppTest?.state?.ready
      && !window.PomodoroughAppTest.state.bootstrapBlocked, null, { timeout: 15_000 });
  } catch (error) {
    const failure = await page.evaluate(() => ({ ready: window.PomodoroughAppTest?.state?.ready,
      notice: document.querySelector("#noticeText")?.textContent }));
    throw new Error(`Startup did not reach ready: ${JSON.stringify(failure)}`, { cause: error });
  }
}

async function readFrame(page) {
  return page.evaluate(() => {
    const style = (selector) => getComputedStyle(document.querySelector(selector));
    const px = (value) => Number.parseFloat(value) || 0;
    const masthead = style(".masthead");
    const main = style("main");
    const footer = style(".site-footer");
    const wordmark = document.querySelector(".wordmark").getBoundingClientRect();
    const controls = [...document.querySelectorAll("button,input,select,a:not(.skip-link),[role=tab],#timerDisplay")]
      .filter((el) => el.checkVisibility())
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return { id: el.id || el.className.slice(0, 40), left: rect.left, right: rect.right, top: rect.top, h: rect.height };
      });
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      masthead: { top: px(masthead.paddingTop), right: px(masthead.paddingRight), left: px(masthead.paddingLeft) },
      main: { right: px(main.paddingRight), left: px(main.paddingLeft), bottom: px(main.paddingBottom) },
      footer: { right: px(footer.paddingRight), left: px(footer.paddingLeft), bottom: px(footer.paddingBottom) },
      wordmarkTop: wordmark.top,
      controls,
    };
  });
}

function assertFrame(frame, width, height, screen) {
  assert.ok(frame.wordmarkTop + 1 >= INSETS.top, `${screen} ${width}x${height} wordmark ${frame.wordmarkTop} < ${INSETS.top}`);
  assert.ok(frame.masthead.top + 1 >= INSETS.top, `${screen} masthead top ${frame.masthead.top}`);
  assert.ok(frame.masthead.left + 1 >= INSETS.left, `${screen} masthead left ${frame.masthead.left}`);
  assert.ok(frame.masthead.right + 1 >= INSETS.right, `${screen} masthead right ${frame.masthead.right}`);
  assert.ok(frame.main.left + 1 >= INSETS.left, `${screen} main left ${frame.main.left}`);
  assert.ok(frame.main.right + 1 >= INSETS.right, `${screen} main right ${frame.main.right}`);
  assert.ok(frame.main.bottom + 1 >= INSETS.bottom, `${screen} main bottom ${frame.main.bottom}`);
  assert.ok(frame.footer.left + 1 >= INSETS.left, `${screen} footer left ${frame.footer.left}`);
  assert.ok(frame.footer.right + 1 >= INSETS.right, `${screen} footer right ${frame.footer.right}`);
  assert.ok(frame.footer.bottom + 1 >= INSETS.bottom, `${screen} footer bottom ${frame.footer.bottom}`);
}

function assertControls(frame, width, height, screen) {
  assert.ok(frame.scrollWidth <= width + 1, `${screen} ${width}x${height} horizontal overflow scrollWidth ${frame.scrollWidth}`);
  const visible = frame.controls.filter((control) => control.top < frame.height && control.top + control.h > 0);
  assert.ok(visible.length > 3, `${screen} expected visible controls, got ${visible.length}`);
  for (const control of visible) {
    assert.ok(control.left + 1 >= INSETS.left, `${screen} ${width}x${height} ${control.id} left ${control.left} < ${INSETS.left}`);
    assert.ok(control.right - 1 <= width - INSETS.right, `${screen} ${width}x${height} ${control.id} right ${control.right} > ${width - INSETS.right}`);
  }
}

// R49-S06: scroll every preference control before asserting safe bounds.
async function assertScrolledPreferences(page, width, height) {
  const count = await page.evaluate(() => document.querySelectorAll("#durationForm button, #durationForm input, #durationForm select").length);
  assert.ok(count >= 12, `scrolled ${width}x${height} expected preference controls, got ${count}`);
  const frame = await page.evaluate(async () => {
    const controls = [...document.querySelectorAll("#durationForm button, #durationForm input, #durationForm select")];
    const bounds = [];
    for (const el of controls) {
      el.scrollIntoView({ block: "center", behavior: "instant" });
      await new Promise((resolve) => setTimeout(resolve, 60));
      const rect = el.getBoundingClientRect();
      bounds.push({ id: el.id || el.getAttribute("data-for") || el.textContent.trim().slice(0, 24),
        left: rect.left, right: rect.right });
    }
    return { scrollWidth: document.documentElement.scrollWidth, bounds };
  });
  assert.ok(frame.scrollWidth <= width + 1, `scrolled ${width}x${height} scrollWidth ${frame.scrollWidth} > ${width}`);
  for (const control of frame.bounds) {
    assert.ok(control.left + 1 >= INSETS.left, `scrolled ${width}x${height} ${control.id} left ${control.left} < ${INSETS.left}`);
    assert.ok(control.right - 1 <= width - INSETS.right, `scrolled ${width}x${height} ${control.id} right ${control.right} > ${width - INSETS.right}`);
  }
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(120);
}

async function checkViewport(page, cdp, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(250);
  for (const screen of ["timer", "tasks"]) {
    if (screen === "tasks") await page.locator("#tasksTab").click();
    else await page.locator("#timerTab").click();
    await page.waitForTimeout(250);
    const frame = await readFrame(page);
    assertFrame(frame, width, height, screen);
    assertControls(frame, width, height, screen);
    if (screen === "timer") await assertScrolledPreferences(page, width, height);
    console.log(`${screen} ${width}x${height} ok wordmark=${frame.wordmarkTop.toFixed(1)} controls=${frame.controls.length}`);
  }
}

test("R48-S08 narrow and landscape safe-area insets bound every control",
  { timeout: 120_000 }, async (t) => {
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
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: INSETS });
    for (const [width, height] of VIEWPORTS) await checkViewport(page, cdp, width, height);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, left: 0, right: 0, bottom: 0 } });
    await cdp.detach();
  });
