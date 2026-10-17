"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const { chromium } = require(process.env.POMODOROUGH_PLAYWRIGHT_MODULE || "playwright");
const fixture = JSON.parse(readFileSync(0, "utf8"));

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
    const rect = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const style = getComputedStyle(document.querySelector(".workbench"));
    const main = getComputedStyle(document.querySelector("main"));
    return {
      width: window.innerWidth, height: window.innerHeight,
      h2: matchMedia("(horizontal-viewport-segments: 2)").matches,
      v2: matchMedia("(vertical-viewport-segments: 2)").matches,
      h1: matchMedia("(horizontal-viewport-segments: 1)").matches,
      taskInput: rect("#taskInput"), taskButton: rect("#taskForm button"),
      taskForm: rect("#taskForm"), workbench: rect("#timer-workbench"),
      actionBank: rect(".action-bank"), timerToggle: rect("#timerToggle"),
      columnGap: style.columnGap, rowGap: style.rowGap, mainWidth: main.width,
    };
  });
}

function assertAvoidsX(frame, low, high, label) {
  for (const key of ["taskInput", "taskButton", "taskForm", "workbench"]) {
    const r = frame[key];
    if (!r) continue;
    assert.ok(!(r.left < high && r.right > low), `${label} ${key} [${r.left},${r.right}] crosses [${low},${high}]`);
  }
}

function assertAvoidsY(frame, low, high, label) {
  for (const key of ["taskInput", "taskButton", "taskForm"]) {
    const r = frame[key];
    if (!r) continue;
    assert.ok(!(r.top < high && r.bottom > low), `${label} ${key} [${r.top},${r.bottom}] crosses [${low},${high}]`);
  }
}

async function emulate(page, cdp, width, height, feature) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(250);
  if (!feature) {
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.send("Emulation.clearDisplayFeaturesOverride").catch(() => {});
  } else {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, screenWidth: width,
      screenHeight: height, deviceScaleFactor: 1, mobile: true, displayFeature: feature });
    await cdp.send("Emulation.setDisplayFeaturesOverride", { features: [{
      orientation: feature.orientation, offset: feature.offset, maskLength: feature.maskLength }] }).catch(() => {});
  }
  await page.waitForTimeout(300);
}

async function checkHorizontal(page, cdp, width, height, offset, mask, label) {
  await emulate(page, cdp, width, height, { orientation: "vertical", offset, maskLength: mask });
  for (const screen of ["tasks", "timer"]) {
    if (screen === "tasks") await page.locator("#tasksTab").click();
    else await page.locator("#timerTab").click();
    await page.waitForTimeout(250);
    const frame = await readFrame(page);
    assert.equal(frame.h2, true, `${label} ${screen} segment reporting`);
    assert.equal(frame.columnGap, `${mask}px`, `${label} ${screen} derived gap`);
    assertAvoidsX(frame, offset, offset + mask, `${label} ${screen}`);
    console.log(`${label} ${screen} ok input=[${frame.taskInput.left.toFixed(1)},${frame.taskInput.right.toFixed(1)}] gap=${frame.columnGap}`);
  }
}

async function timerControls(page, scrollVertically) {
  return page.evaluate((scrollVertically) => {
    for (const el of document.querySelectorAll("*")) if (el.scrollLeft) el.scrollLeft = 0;
    window.scrollTo({ left: 0, top: 0, behavior: "instant" });
    const controls = [...document.querySelectorAll(
      "#timerScreen :is(button, input, select, textarea, a[href], summary, [tabindex]):not([tabindex='-1'])"
    )].filter((el) => el.checkVisibility());
    const bounds = controls.map((el) => {
      if (scrollVertically) {
        const r = el.getBoundingClientRect();
        window.scrollTo({ left: 0, top: scrollY + r.top + r.height / 2 - innerHeight / 2, behavior: "instant" });
      }
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const clipped = [];
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        if (!/hidden|clip|auto|scroll/.test(getComputedStyle(parent).overflowX)) continue;
        const p = parent.getBoundingClientRect();
        if (parent.scrollLeft || r.left < p.left - 1 || r.right > p.right + 1) clipped.push(parent.className);
      }
      const textFits = el.tagName !== "BUTTON" || (() => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return [...range.getClientRects()].every((t) => t.left >= r.left - 1 && t.right <= r.right + 1);
      })();
      return { key: el.id || el.getAttribute("aria-label"), left: r.left, right: r.right, top: r.top,
        bottom: r.bottom, width: r.width, height: r.height, disabled: el.disabled, textFits, clipped,
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, hit: hit === el || el.contains(hit) };
    });
    const bank = document.querySelector(".action-bank");
    return { bounds, scrollX, scrollWidth: document.documentElement.scrollWidth,
      bankWidth: bank.clientWidth, bankScrollWidth: bank.scrollWidth };
  }, scrollVertically);
}

async function assertTimerControls(page, width, height, left, right) {
  for (const vertical of [false, true]) {
    const frame = await timerControls(page, vertical);
    assert.equal(frame.bounds.length, 18, "all Timer interactive descendants measured");
    assert.equal(frame.scrollX, 0, "no horizontal window scroll");
    assert.ok(frame.scrollWidth <= width + 1, `${width}px ${left}..${right} document width ${frame.scrollWidth}`);
    assert.ok(frame.bankScrollWidth <= frame.bankWidth + 1, "no action-bank overflow");
    for (const control of frame.bounds) {
      const label = `${width}px ${left}..${right} ${control.key}`;
      assert.ok(control.left >= left - 1 && control.right <= right + 1, `${label} horizontal bounds`);
      assert.ok(control.width >= 24 && control.height >= 24, `${label} target minimum`);
      assert.ok(control.textFits && control.scrollWidth <= control.clientWidth + 1, `${label} readable label`);
      assert.deepEqual(control.clipped, [], `${label} no clipping or hidden horizontal scroll`);
      if (vertical) {
        assert.ok(control.top >= -1 && control.bottom <= height + 1, `${label} vertically reachable`);
        assert.ok(control.hit, `${label} center hit test`);
      }
    }
  }
}

async function timerKey(page, id, key, status) {
  await page.evaluate((id) => {
    const el = document.getElementById(id);
    const r = el.getBoundingClientRect();
    window.scrollTo({ left: 0, top: scrollY + r.top + r.height / 2 - innerHeight / 2, behavior: "instant" });
    el.focus({ preventScroll: true });
  }, id);
  assert.ok(await page.locator(`#${id}`).isEnabled(), `${id} enabled`);
  await page.keyboard.press(key);
  await page.waitForFunction((status) => PomodoroughAppTest.state.timer.status === status, status);
}

test("R49-S07 all Timer actions fit enabled, enlarged, segmented, and inset layouts",
  { timeout: 180_000 }, async (t) => {
    const browser = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors"],
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
    t.after(() => browser.close());
    const context = await authenticatedContext(browser);
    t.after(() => context.close());
    const page = await context.newPage();
    assert.equal((await page.goto(`${fixture.url}/app`)).status(), 200);
    await waitForReady(page);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller && window.PomodoroughAppTest?.state?.ready);
    await page.route("**/api/v1/sync", (route) => route.abort("internetdisconnected"));
    const cdp = await context.newCDPSession(page);
    for (const font of [100, 200]) {
      await page.evaluate((font) => { document.documentElement.style.fontSize = `${font}%`; }, font);
      for (const offset of [470, 300, 360, 640, 0]) {
        const width = offset ? 960 : 320, height = offset ? 720 : 568;
        await emulate(page, cdp, width, height, offset ? { orientation: "vertical", offset, maskLength: 20 } : null);
        if (!offset) await cdp.send("Emulation.setDeviceMetricsOverride", {
          width, height, screenWidth: width, screenHeight: height, deviceScaleFactor: 1, mobile: false });
        await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: offset
          ? { top: 0, left: 0, right: 0, bottom: 0 } : { top: 47, left: 44, right: 44, bottom: 34 } });
        await page.waitForTimeout(200);
        console.log(`R49-S07 font=${font} offset=${offset} actualWidth=${await page.evaluate(() => innerWidth)}`);
        const left = offset ? 0 : 44, right = offset || width - 44;
        assert.equal(await page.evaluate(() => innerWidth), width, "actual layout viewport width");
        assert.equal(await page.evaluate(() => matchMedia("(horizontal-viewport-segments:2)").matches), !!offset);
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), `${font * 0.16}px`);
        await assertTimerControls(page, width, height, left, right);
        await timerKey(page, "timerToggle", "Enter", "running");
        await assertTimerControls(page, width, height, left, right);
        await timerKey(page, "timerToggle", "Space", "paused");
        await timerKey(page, "timerToggle", "Space", "running");
        await timerKey(page, "finishButton", "Enter", "completed");
        await page.waitForFunction(() => !document.querySelector("#clearButton").disabled);
        await assertTimerControls(page, width, height, left, right);
        await timerKey(page, "clearButton", "Space", "completed");
        assert.ok(await page.locator("#clearButton").isDisabled(), "Clear stops the completion sound");
        await timerKey(page, "timerToggle", "Enter", "running");
        await timerKey(page, "cancelButton", "Enter", "idle");
      }
    }
  });

test("R48-S09 segments bound task editor and groups",
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
    const cdp = await context.newCDPSession(page);
    const physical = await page.evaluate(() => ({
      h2: matchMedia("(horizontal-viewport-segments: 2)").matches,
      v2: matchMedia("(vertical-viewport-segments: 2)").matches }));
    console.log(`physical segments h2=${physical.h2} v2=${physical.v2}`);
    if (physical.h2 || physical.v2) {
      const frame = await readFrame(page);
      assert.ok(frame.taskInput.right > frame.taskInput.left, "physical editor visible");
      console.log(`physical confirmation input=[${frame.taskInput.left},${frame.taskInput.right}]`);
    } else {
      console.log("no physical segments; emulated assertions still run");
    }
    await emulate(page, cdp, 480, 720, null);
    await page.locator("#tasksTab").click();
    const single = await readFrame(page);
    assert.equal(single.h2, false, "single segment reports no dual");
    assert.ok(single.taskInput.right <= 481, "single 480px editor in viewport");
    console.log(`single 480x720 ok input=[${single.taskInput.left.toFixed(1)},${single.taskInput.right.toFixed(1)}]`);
    await checkHorizontal(page, cdp, 960, 720, 470, 20, "equal landscape");
    await checkHorizontal(page, cdp, 960, 720, 300, 20, "unequal left300");
    await checkHorizontal(page, cdp, 960, 720, 640, 20, "unequal left640");
    await checkHorizontal(page, cdp, 720, 960, 350, 20, "unequal portrait");
    for (const [offset, label] of [[470, "equal"], [300, "unequal top300"], [640, "unequal top640"]]) {
      await emulate(page, cdp, 720, 960, { orientation: "horizontal", offset, maskLength: 20 });
      for (const screen of ["tasks", "timer"]) {
        if (screen === "tasks") await page.locator("#tasksTab").click();
        else await page.locator("#timerTab").click();
        await page.waitForTimeout(250);
        const vert = await readFrame(page);
        assert.equal(vert.v2, true, `${label} vertical reporting`);
        assert.equal(vert.rowGap, "20px", `${label} vertical derived gap`);
        assertAvoidsY(vert, offset, offset + 20, `${label} portrait hinge ${screen}`);
        console.log(`${label} portrait ${screen} ok top=${vert.taskInput.top.toFixed(1)} gap=${vert.rowGap}`);
      }
    }
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.send("Emulation.clearDisplayFeaturesOverride").catch(() => {});
    await cdp.detach();
  });
