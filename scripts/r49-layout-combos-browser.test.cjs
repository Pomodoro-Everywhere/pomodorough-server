"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const { chromium } = require(process.env.POMODOROUGH_PLAYWRIGHT_MODULE || "playwright");
const fixture = JSON.parse(readFileSync(0, "utf8"));

const INSETS = { top: 47, left: 44, right: 44, bottom: 34 };
const LONG_PHASE = "Lange Fokussierungsdauer zur Konzentrationserhaltung";
const LONG_RAIL = "Dienstmuster mit aussergewoehnlich langem lokalisiertem Titel";
const DURATION_INPUTS = ["#focusDuration", "#shortBreakDuration", "#longBreakDuration"];

function luminance(rgb) {
  const lin = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function parseRgb(text) {
  const m = /rgba?\(([^)]+)\)/.exec(text);
  assert.ok(m, `parse color ${text}`);
  return m[1].split(",").slice(0, 3).map((v) => Number.parseFloat(v));
}

async function ready(page) {
  await page.waitForFunction(() => window.PomodoroughAppTest?.state?.ready
    && !PomodoroughAppTest.state.bootstrapBlocked, null, { timeout: 15_000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15_000 });
}

async function applyEnlarged(page) {
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

async function scrolledBounds(page, selector) {
  return page.evaluate((selector) => {
    const out = [];
    for (const el of document.querySelectorAll(selector)) {
      if (!el.checkVisibility()) continue;
      el.scrollIntoView({ block: "center", behavior: "instant" });
      const r = el.getBoundingClientRect();
      out.push({ key: el.id || el.getAttribute("data-for") || el.textContent.trim().slice(0, 24),
        left: r.left, right: r.right, disabled: el.disabled === true });
    }
    return { scrollWidth: document.documentElement.scrollWidth, bounds: out };
  }, selector);
}

async function settle(page, ms = 60) {
  await page.waitForTimeout(ms);
}

test("R49 combos enlarged+insets+fold keep controls placed and readable", { timeout: 180_000 }, async (t) => {
  const browser = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors"],
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: "allow", bypassCSP: false, ignoreHTTPSErrors: true });
  t.after(() => context.close());
  await context.addCookies([
    { name: fixture.sessionCookie, value: fixture.sessionToken, httpOnly: true },
    { name: fixture.csrfCookie, value: fixture.csrfToken, httpOnly: false },
  ].map((cookie) => ({ ...cookie, url: `${fixture.url}/`, secure: true, sameSite: "Lax" })));
  await context.addInitScript(() => { window.PomodoroughAppTest = { disableAutoStart: false }; });
  const page = await context.newPage();
  assert.equal((await page.goto(`${fixture.url}/app`)).status(), 200);
  await ready(page);
  const cdp = await context.newCDPSession(page);

  await page.setViewportSize({ width: 320, height: 568 });
  await page.waitForTimeout(250);
  await page.locator("#timerTab").click();
  await page.waitForTimeout(250);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: INSETS });
  await applyEnlarged(page);
  const small = await scrolledBounds(page, "#durationForm button, #durationForm input, #durationForm select");
  await settle(page);
  assert.ok(small.scrollWidth <= 321, `enlarged+insets scrollWidth ${small.scrollWidth} > 320`);
  assert.ok(small.bounds.length >= 12, `expected preference controls, got ${small.bounds.length}`);
  for (const control of small.bounds) {
    assert.ok(control.left + 1 >= INSETS.left, `enlarged+insets ${control.key} left ${control.left}`);
    assert.ok(control.right - 1 <= 320 - INSETS.right, `enlarged+insets ${control.key} right ${control.right}`);
  }
  console.log(`enlarged+insets 320x568 ok controls=${small.bounds.length} scrollWidth=${small.scrollWidth}`);

  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, left: 0, right: 0, bottom: 0 } });
  await page.setViewportSize({ width: 960, height: 720 });
  await page.waitForTimeout(250);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 960, height: 720,
    screenWidth: 960, screenHeight: 720, deviceScaleFactor: 1, mobile: true,
    displayFeature: { orientation: "vertical", offset: 470, maskLength: 20 } });
  await cdp.send("Emulation.setDisplayFeaturesOverride",
    { features: [{ orientation: "vertical", offset: 470, maskLength: 20 }] }).catch(() => {});
  await page.waitForTimeout(300);
  await page.locator("#timerTab").click();
  await page.waitForTimeout(250);
  await applyEnlarged(page);
  const fold = await page.evaluate(() => ({
    h2: matchMedia("(horizontal-viewport-segments: 2)").matches,
    columns: getComputedStyle(document.querySelector(".workbench")).gridTemplateColumns,
  }));
  assert.equal(fold.h2, true, "fold segment reporting");
  assert.ok(fold.columns.split(" ").length === 1, `fold workbench stacks, got ${fold.columns}`);
  const descendants = await scrolledBounds(page,
    "#taskSelector, .phase-button, #durationForm button, #durationForm input, #autoStartBreaks, #timerToggle");
  const enabled = descendants.bounds.filter((c) => !c.disabled);
  assert.ok(enabled.length >= 10, `expected enabled descendants, got ${enabled.length}`);
  for (const control of enabled) {
    assert.ok(!(control.left < 490 && control.right > 470), `fold+enlarged ${control.key} crosses 470..490`);
  }
  console.log(`fold+enlarged 960x720 ok enabled=${enabled.length} columns=${fold.columns}`);

  await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  await cdp.send("Emulation.clearDisplayFeaturesOverride").catch(() => {});
  await page.setViewportSize({ width: 375, height: 667 });
  await page.waitForTimeout(250);
  await applyEnlarged(page);
  const footer = await page.evaluate(() => {
    const link = document.querySelector(".site-footer a");
    link.scrollIntoView({ block: "center", behavior: "instant" });
    const style = getComputedStyle(link);
    const fill = getComputedStyle(document.querySelector(".site-footer")).backgroundColor
      || getComputedStyle(document.body).backgroundColor;
    const rect = link.getBoundingClientRect();
    return { color: style.color, fill, underline: style.textDecorationLine,
      left: rect.left, right: rect.right, innerWidth: window.innerWidth };
  });
  await settle(page);
  assert.ok(footer.left + 1 >= 0 && footer.right - 1 <= footer.innerWidth, "footer link in viewport enlarged");
  assert.notEqual(footer.underline, "none", "footer keeps non-color cue enlarged");
  assert.doesNotMatch(footer.color, /0,\s*0,\s*238/, "no browser blue enlarged");
  const ratio = (Math.max(luminance(parseRgb(footer.color)), luminance(parseRgb(footer.fill))) + 0.05)
    / (Math.min(luminance(parseRgb(footer.color)), luminance(parseRgb(footer.fill))) + 0.05);
  assert.ok(ratio >= 4.5, `footer contrast enlarged ${ratio.toFixed(2)}`);
  await page.evaluate(() => document.body.focus());
  let privacyReached = false;
  for (let i = 0; i < 60; i += 1) {
    await page.keyboard.press("Tab");
    const active = await page.evaluate(() => document.activeElement?.textContent?.trim());
    if (active === "Privacy") { privacyReached = true; break; }
  }
  assert.ok(privacyReached, "footer Privacy reachable by Tab enlarged");
  const outline = await page.evaluate(() => {
    const link = document.querySelector(".site-footer a");
    const style = getComputedStyle(link);
    return { width: style.outlineWidth, style: style.outlineStyle };
  });
  assert.notEqual(outline.style, "none", "footer focus stays visible enlarged");
  console.log(`footer enlarged ok contrast=${ratio.toFixed(2)} outline=${outline.style}/${outline.width}`);
  await cdp.detach();
});
