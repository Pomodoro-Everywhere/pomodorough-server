"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const { chromium } = require(process.env.POMODOROUGH_PLAYWRIGHT_MODULE || "playwright");
const fixture = JSON.parse(readFileSync(0, "utf8"));

const VIEWPORTS = [[320, 568], [375, 667]];
const DURATION_INPUTS = ["#focusDuration", "#shortBreakDuration", "#longBreakDuration"];
const LONG_PHASE = "Lange Fokussierungsdauer zur Konzentrationserhaltung";
const LONG_RAIL = "Dienstmuster mit aussergewoehnlich langem lokalisiertem Titel";

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
    const failure = await page.evaluate(() => ({ ready: window.PomodoroughAppTest?.state?.ready }));
    throw new Error(`Startup did not reach ready: ${JSON.stringify(failure)}`, { cause: error });
  }
}

async function applyEnlargedText(page) {
  await page.evaluate(({ phase, rail }) => {
    document.documentElement.style.fontSize = "200%";
    for (const button of document.querySelectorAll(".phase-button span:last-child")) {
      button.textContent = phase;
    }
    const heading = document.querySelector(".rail-heading strong");
    if (heading) heading.textContent = rail;
    const detail = document.querySelector(".rail-heading small");
    if (detail) detail.textContent = `${rail} ${rail}`;
  }, { phase: LONG_PHASE, rail: LONG_RAIL });
  await page.waitForTimeout(300);
}

function assertHorizontal(rect, width, label) {
  assert.ok(rect.left + 1 >= 0, `${label} left ${rect.left} < 0 at ${width}`);
  assert.ok(rect.right - 1 <= width, `${label} right ${rect.right} > ${width}`);
}

async function readFrame(page) {
  return page.evaluate(() => {
    const rect = (el) => {
      const box = el.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    };
    return {
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      rows: [...document.querySelectorAll(".duration-row")].map(rect),
      controls: [...document.querySelectorAll(".duration-row .stepper input,.duration-row .stepper button")]
        .map((el) => ({ key: el.id || el.getAttribute("data-for") || "stepper", ...rect(el) })),
      header: [...document.querySelectorAll(".masthead a,.masthead button,#syncStatus,.profile button")]
        .filter((el) => el.checkVisibility()).map((el) => ({ key: el.id || el.textContent.slice(0, 24), ...rect(el) })),
    };
  });
}

async function assertNoOverflow(page, width) {
  const frame = await readFrame(page);
  assert.ok(frame.scrollWidth <= width + 1, `horizontal overflow scrollWidth ${frame.scrollWidth} > ${width}`);
  for (const [index, row] of frame.rows.entries()) assertHorizontal(row, width, `duration-row-${index}`);
  for (const control of frame.controls) assertHorizontal(control, width, control.key);
  for (const item of frame.header) assertHorizontal(item, width, `header:${item.key}`);
  return frame;
}

async function assertScrolledBounds(page, width) {
  for (const selector of DURATION_INPUTS) {
    await page.locator(selector).scrollIntoViewIfNeeded();
    await page.waitForTimeout(120);
    const box = await page.locator(selector).boundingBox();
    assert.ok(box, `${selector} has bounds after scroll`);
    assert.ok(box.x + 1 >= 0 && box.x + box.width - 1 <= width, `${selector} x=${box.x} w=${box.width} outside ${width}`);
  }
}

async function assertKeyboardOperable(page, width) {
  await page.evaluate(() => document.body.focus());
  const seen = [];
  for (let step = 0; step < 80; step += 1) {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const box = el.getBoundingClientRect();
      const key = el.id || el.getAttribute("data-for") || `${el.tagName}`;
      return { key, left: box.left, right: box.right };
    });
    if (focused) seen.push(focused.key);
  }
  for (const selector of DURATION_INPUTS) {
    assert.ok(seen.includes(selector.slice(1)), `${selector} reachable by Tab, saw ${seen.slice(0, 12).join(",")}`);
  }
  const input = page.locator(DURATION_INPUTS[0]);
  await input.focus();
  const before = await input.inputValue();
  await page.keyboard.press("ArrowUp");
  const after = await input.inputValue();
  assert.notEqual(after, before, `keyboard ArrowUp changes ${DURATION_INPUTS[0]} (${before}->${after})`);
  const box = await input.boundingBox();
  assert.ok(box.x + 1 >= 0 && box.x + box.width - 1 <= width, `focused input outside ${width}`);
}

async function checkViewport(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(250);
  await page.locator("#timerTab").click();
  await page.waitForTimeout(250);
  await applyEnlargedText(page);
  const frame = await assertNoOverflow(page, width);
  await assertScrolledBounds(page, width);
  await assertKeyboardOperable(page, width);
  await page.locator("#tasksTab").click();
  await page.waitForTimeout(250);
  const tasks = await readFrame(page);
  assert.ok(tasks.scrollWidth <= width + 1, `tasks overflow scrollWidth ${tasks.scrollWidth} > ${width}`);
  for (const item of tasks.header) assertHorizontal(item, width, `tasks-header:${item.key}`);
  console.log(`enlarged 200% ${width}x${height} ok rows=${frame.rows.length} controls=${frame.controls.length}`);
}

test("R49-S05 enlarged text keeps duration controls in the viewport",
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
    for (const [width, height] of VIEWPORTS) await checkViewport(page, width, height);
  });
