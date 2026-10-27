"use strict";

// R49-S07 Timer action-bank regression.
// Every enabled Timer descendant fits its usable segment or inset bounds at
// 960px folds (equal 470..490 plus asymmetric 300..320, 360..380, 640..660),
// at 100% and 200% text, in en (ltr) and ar-XB (rtl), through real keyboard
// and measured-coordinate pointer flows. Measurements never call automatic
// element scrolling; vertical reachability moves only window.scrollY with
// window.scrollX pinned at zero. The closing negative control restores the
// old three-track bank and proves this test turns red without the fix.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const { chromium } = require(process.env.POMODOROUGH_PLAYWRIGHT_MODULE || "playwright");
const fixture = JSON.parse(readFileSync(0, "utf8"));

const ZERO = { top: 0, right: 0, bottom: 0, left: 0 };
const INSET = { top: 47, right: 44, bottom: 34, left: 44 };
const FOLDS = [470, 300, 360, 640];
const MASK = 20;
const LOCALES = ["en", "ar-XB"];
const EXPECTED_IDS = ["timerToggle", "finishButton", "cancelButton",
  "clearButton", "taskSelector", "focusDuration", "shortBreakDuration",
  "longBreakDuration", "autoStartBreaks"];

function scenarios() {
  const rows = [];
  for (const locale of LOCALES) {
    for (const font of [100, 200]) {
      for (const fold of FOLDS) {
        rows.push({ name: `${locale} 960 fold ${fold}..${fold + MASK} ${font}%`,
          width: 960, height: 720, font, locale, fold, insets: ZERO, pointer: true });
      }
      rows.push({ name: `${locale} 320 inset ${font}%`, width: 320,
        height: 568, font, locale, fold: 0, insets: INSET, pointer: true });
    }
    for (const width of [960, 1440]) {
      rows.push({ name: `${locale} ${width} single 100%`, width,
        height: 720, font: 100, locale, fold: 0, insets: ZERO, pointer: false });
    }
  }
  return rows;
}

async function launchBrowser(t) {
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--ignore-certificate-errors"] });
  t.after(() => browser.close());
  return browser;
}

async function ready(page) {
  await page.waitForFunction(() => window.PomodoroughAppTest?.state?.ready
    && !window.PomodoroughAppTest.state.bootstrapBlocked, null, { timeout: 20000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller
    && window.PomodoroughAppTest.state.ready, null, { timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
}

async function openLocale(browser, locale) {
  const context = await browser.newContext(
    { viewport: { width: 960, height: 720 }, ignoreHTTPSErrors: true,
      bypassCSP: false, serviceWorkers: "allow" });
  await context.addCookies([
    { name: fixture.sessionCookie, value: fixture.sessionToken, httpOnly: true },
    { name: fixture.csrfCookie, value: fixture.csrfToken, httpOnly: false },
  ].map((cookie) => ({ ...cookie, url: `${fixture.url}/`, secure: true, sameSite: "Lax" })));
  await context.addInitScript(() => { window.PomodoroughAppTest = { disableAutoStart: false }; });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  assert.equal((await page.goto(`${fixture.url}/app?locale=${locale}`)).status(), 200);
  await ready(page);
  await page.route("**/api/v1/sync", (route) => route.abort("internetdisconnected"));
  const cdp = await context.newCDPSession(page);
  return { context, page, cdp, errors };
}

async function emulate(page, cdp, scenario) {
  await page.setViewportSize({ width: scenario.width, height: scenario.height });
  await page.waitForTimeout(250);
  if (scenario.fold) {
    const feature = { orientation: "vertical", offset: scenario.fold, maskLength: MASK };
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: scenario.width,
      height: scenario.height, screenWidth: scenario.width, screenHeight: scenario.height,
      deviceScaleFactor: 1, mobile: false, displayFeature: feature });
    await cdp.send("Emulation.setDisplayFeaturesOverride", { features: [feature] });
  } else {
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.send("Emulation.clearDisplayFeaturesOverride").catch(() => {});
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: scenario.width,
      height: scenario.height, screenWidth: scenario.width, screenHeight: scenario.height,
      deviceScaleFactor: 1, mobile: false });
  }
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: scenario.insets });
  await page.waitForTimeout(300);
  await page.evaluate((font) => { document.documentElement.style.fontSize = `${font}%`; },
    scenario.font);
  await page.evaluate(() => document.fonts.ready);
  try {
    await page.waitForFunction((s) => innerWidth === s.width && innerHeight === s.height,
      { width: scenario.width, height: scenario.height }, { timeout: 10000 });
  } catch (error) {
    const actual = await page.evaluate(() => ({ w: innerWidth, h: innerHeight,
      mq: matchMedia("(horizontal-viewport-segments:2)").matches,
      segment: getComputedStyle(document.body).width }));
    console.log(`R49-S07 viewport mismatch ${scenario.name} actual=${actual.w}x${actual.h} mq=${actual.mq}`);
    throw error;
  }
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function stripActionFix(context, page) {
  const css = await context.newCDPSession(page);
  try {
    await css.send("DOM.enable");
    const seen = [];
    css.on("CSS.styleSheetAdded", ({ header }) => seen.push(header));
    await css.send("CSS.enable");
    await page.waitForTimeout(300);
    const header = seen.find((item) => /\/app\.css(?:\?|$)/.test(item.sourceURL || ""));
    assert.ok(header, "production app.css loaded");
    const { text } = await css.send("CSS.getStyleSheetText", { styleSheetId: header.styleSheetId });
    assert.ok(text.includes("timer-actions"), "action container fix present to remove");
    let stripped = text.replace(/container:\s*timer-actions\s*\/\s*inline-size\s*;/, "container: none;");
    stripped = stripped.replace(/@container\s+timer-actions\s*\(max-width:\s*32rem\)\s*\{[^{}]*\{[^{}]*\}[^{}]*\}/, "");
    stripped = stripped.replace(/@container\s+timer-actions\s*\(max-width:\s*20rem\)\s*\{[^{}]*\{[^{}]*\}[^{}]*\}/, "");
    stripped = stripped.replace(/(\.action-bank button\s*\{[^}]*?)min-width:\s*0;\s*max-width:\s*100%;\s*overflow-wrap:\s*anywhere;/,
      "$1min-width: auto; max-width: none;");
    assert.notEqual(stripped, text, "action fix removed");
    assert.ok(stripped.includes("R49-S09") && stripped.includes("R49-S10"), "later fixes retained");
    await css.send("CSS.setStyleSheetText", { styleSheetId: header.styleSheetId, text: stripped });
  } finally {
    try { await css.detach(); } catch {}
  }
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

function usableBounds(scenario) {
  if (scenario.fold) return { left: 0, right: scenario.fold };
  if (scenario.insets.left || scenario.insets.right) {
    return { left: scenario.insets.left, right: scenario.width - scenario.insets.right };
  }
  return { left: 0, right: scenario.width };
}

async function assertEnvironment(page, scenario) {
  const observed = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;visibility:hidden;"
      + "padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px)"
      + " env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);"
      + "width:env(viewport-segment-width 0 0,100vw);left:env(viewport-segment-left 0 0,0px)";
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const out = { width: innerWidth, height: innerHeight,
      font: getComputedStyle(document.documentElement).fontSize,
      fold: matchMedia("(horizontal-viewport-segments:2)").matches,
      segmentWidth: parseFloat(style.width),
      insets: ["top", "right", "bottom", "left"].map((s) => parseFloat(style.getPropertyValue(`padding-${s}`))),
      worker: !!navigator.serviceWorker.controller,
      lang: document.documentElement.lang, dir: document.documentElement.dir,
      machine: getComputedStyle(document.querySelector(".timer-machine")).containerName };
    probe.remove();
    return out;
  });
  assert.equal(observed.width, scenario.width, `${scenario.name} layout viewport width`);
  assert.equal(observed.height, scenario.height, `${scenario.name} layout viewport height`);
  assert.equal(observed.font, `${scenario.font * 0.16}px`, `${scenario.name} text enlargement`);
  assert.equal(observed.fold, !!scenario.fold, `${scenario.name} segment media`);
  assert.equal(observed.worker, true, `${scenario.name} service worker controls page`);
  assert.equal(observed.lang, scenario.locale, `${scenario.name} locale catalog`);
  assert.equal(observed.dir, scenario.locale === "ar-XB" ? "rtl" : "ltr", `${scenario.name} direction`);
  assert.deepEqual(observed.insets,
    [scenario.insets.top, scenario.insets.right, scenario.insets.bottom, scenario.insets.left],
    `${scenario.name} safe-area insets`);
  if (scenario.fold) assert.equal(observed.segmentWidth, scenario.fold, `${scenario.name} first segment`);
  assert.ok(String(observed.machine).includes("timer-actions"), `${scenario.name} action container active`);
}

function readDescendants(page, vertical) {
  return page.evaluate((vertical) => {
    for (const el of document.querySelectorAll("*")) if (el.scrollLeft) el.scrollLeft = 0;
    window.scrollTo({ left: 0, top: 0, behavior: "instant" });
    const controls = [...document.querySelectorAll(
      "#timerScreen :is(button, input, select, textarea, a[href], summary, [tabindex]):not([tabindex='-1'])",
    )].filter((el) => el.checkVisibility());
    const items = controls.map((el, index) => {
      if (vertical) {
        const q = el.getBoundingClientRect();
        window.scrollTo({ left: 0,
          top: window.scrollY + q.top + q.height / 2 - window.innerHeight / 2, behavior: "instant" });
      }
      const r = el.getBoundingClientRect();
      const hitEl = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const clipped = [];
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (!/hidden|clip|auto|scroll/.test(getComputedStyle(p).overflowX)) continue;
        const pr = p.getBoundingClientRect();
        if (p.scrollLeft || r.left < pr.left - 1 || r.right > pr.right + 1) clipped.push(p.className || p.tagName);
      }
      let glyphs = [];
      if (el.tagName === "BUTTON") {
        const range = document.createRange();
        range.selectNodeContents(el);
        glyphs = [...range.getClientRects()].map((g) => ({ left: g.left, right: g.right }));
      }
      const style = getComputedStyle(el);
      return { key: el.id || el.getAttribute("aria-label") || el.getAttribute("data-phase")
          || `${el.getAttribute("data-for")}:${el.getAttribute("data-step")}` || `${el.tagName}#${index}`,
        id: el.id || null, left: r.left, right: r.right, top: r.top, bottom: r.bottom,
        width: r.width, height: r.height, disabled: !!el.disabled,
        glyphs, clipped, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
        hit: hitEl === el || el.contains(hitEl),
        zoom: style.zoom, transform: style.transform };
    });
    const bank = document.querySelector(".action-bank");
    const clear = document.querySelector("#clearButton").getBoundingClientRect();
    return { items, scrollX: window.scrollX, bankWidth: bank.clientWidth,
      bankScroll: bank.scrollWidth,
      clear: { left: clear.left, right: clear.right, height: clear.height,
        disabled: document.querySelector("#clearButton").disabled } };
  }, vertical);
}

function assertDescendants(frame, scenario, vertical) {
  const bounds = usableBounds(scenario);
  assert.equal(frame.items.length, 18, `${scenario.name} measures every Timer descendant`);
  for (const id of EXPECTED_IDS) {
    assert.ok(frame.items.some((item) => item.id === id), `${scenario.name} measures ${id}`);
  }
  assert.equal(frame.scrollX, 0, `${scenario.name} no horizontal window pan`);
  assert.ok(frame.bankScroll <= frame.bankWidth + 1,
    `${scenario.name} bank ${frame.bankScroll}/${frame.bankWidth}`);
  for (const item of frame.items) {
    const label = `${scenario.name} ${vertical ? "reached" : "unpanned"} ${item.key}`;
    assert.ok(item.left >= bounds.left - 1 && item.right <= bounds.right + 1,
      `${label} [${item.left},${item.right}] outside [${bounds.left},${bounds.right}]`);
    if (scenario.fold) {
      assert.ok(!(item.left < scenario.fold + MASK && item.right > scenario.fold),
        `${label} crosses fold ${scenario.fold}..${scenario.fold + MASK}`);
    }
    assert.ok(item.width >= 24 && item.height >= 24, `${label} minimum target`);
    assert.ok(item.glyphs.every((g) => g.left >= item.left - 1 && g.right <= item.right + 1)
      && item.scrollWidth <= item.clientWidth + 1, `${label} readable label`);
    assert.deepEqual(item.clipped, [], `${label} no clipping ancestor`);
    assert.equal(item.zoom, "1", `${label} no css zoom`);
    assert.equal(item.transform, "none", `${label} no transform`);
    if (vertical && !item.disabled) {
      assert.ok(item.top >= -1 && item.bottom <= scenario.height + 1, `${label} vertically reachable`);
      assert.ok(item.hit, `${label} center hit test`);
    }
  }
  const wantClear = scenario.font === 200 ? 88 : 44;
  assert.ok(Math.abs(frame.clear.height - wantClear) <= 2, `${scenario.name} clear height`);
}

async function assertBothPasses(page, scenario) {
  assertDescendants(await readDescendants(page, false), scenario, false);
  assertDescendants(await readDescendants(page, true), scenario, true);
}

function timerInfo(page) {
  return page.evaluate(() => ({ status: window.PomodoroughAppTest?.state?.timer?.status,
    id: window.PomodoroughAppTest?.state?.timer?.id ?? null }));
}

async function keyToStatus(page, id, key, status) {
  await page.evaluate((target) => { document.getElementById(target).focus({ preventScroll: true }); }, id);
  assert.equal(await page.locator(`#${id}`).isEnabled(), true, `${id} enabled for keyboard`);
  await page.keyboard.press(key);
  await page.waitForFunction((want) => window.PomodoroughAppTest?.state?.timer?.status === want,
    status, { timeout: 15000 });
  assert.equal(await page.evaluate(() => window.scrollX), 0, `${id} keyboard keeps scrollX zero`);
}

async function clickToStatus(page, id, status) {
  const point = await page.evaluate((target) => {
    const el = document.getElementById(target);
    const r = el.getBoundingClientRect();
    window.scrollTo({ left: 0,
      top: window.scrollY + r.top + r.height / 2 - window.innerHeight / 2, behavior: "instant" });
    const q = el.getBoundingClientRect();
    return { x: q.left + q.width / 2, y: q.top + q.height / 2 };
  }, id);
  assert.equal(await page.locator(`#${id}`).isEnabled(), true, `${id} enabled for pointer`);
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction((want) => window.PomodoroughAppTest?.state?.timer?.status === want,
    status, { timeout: 15000 });
  assert.equal(await page.evaluate(() => window.scrollX), 0, `${id} pointer keeps scrollX zero`);
}

function assertActionFocus(active, label, forcedColors) {
  assert.equal(active.focusVisible, true, `${label} matches focus-visible`);
  if (forcedColors) {
    assert.equal(active.outline, "solid", `${label} forced-colors outline`);
    assert.equal(active.width, 3, `${label} forced-colors outline width`);
    assert.equal(active.offset, -6, `${label} forced-colors outline stays inside clip`);
    assert.notEqual(active.color, "rgba(0, 0, 0, 0)", `${label} forced-colors outline is opaque`);
    assert.equal(active.shadow, "none", `${label} forced-colors replaces shadows`);
    return;
  }
  assert.equal(active.outline, "none", `${label} clipped outline replaced`);
  for (const [color, spread] of [["247, 248, 242", 3], ["17, 25, 35", 6]]) {
    assert.ok(active.shadow.includes(`rgb(${color}) 0px 0px 0px ${spread}px inset`),
      `${label} visible focus inset ${spread}px: ${active.shadow}`);
  }
}

async function tabReachesActions(page, scenario, forcedColors = false) {
  await page.evaluate(() => { document.getElementById("timerToggle").focus({ preventScroll: true }); });
  const seen = [];
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press("Tab");
    const active = await page.evaluate(() => {
      const el = document.activeElement;
      const style = getComputedStyle(el);
      return { id: el.id, focusVisible: el.matches(":focus-visible"),
        outline: style.outlineStyle, width: parseFloat(style.outlineWidth),
        offset: parseFloat(style.outlineOffset), color: style.outlineColor,
        shadow: style.boxShadow, x: window.scrollX };
    });
    assert.equal(active.x, 0, `${scenario.name} tab keeps scrollX zero`);
    seen.push(active);
    if (seen.some((s) => s.id === "finishButton") && seen.some((s) => s.id === "cancelButton")) break;
  }
  let order = -1;
  for (const id of ["finishButton", "cancelButton"]) {
    const at = seen.findIndex((s) => s.id === id);
    assert.ok(at > order, `${scenario.name} tab reaches ${id} in order`);
    order = at;
    assertActionFocus(seen[at], `${scenario.name} ${id}`, forcedColors);
  }
}

async function withTimerCleanup(page, run) {
  try {
    await run();
  } finally {
    await page.waitForFunction(() => !window.PomodoroughAppTest.state.actionLocked,
      null, { timeout: 15000 });
    await page.evaluate(() => {
      const app = window.PomodoroughAppTest;
      app.stopCompletionAlert();
      if (app.state.timer.status !== "idle") document.getElementById("cancelButton").click();
    });
    await page.waitForFunction(() => window.PomodoroughAppTest.state.timer.status === "idle",
      null, { timeout: 15000 });
    assert.deepEqual(await timerInfo(page), { status: "idle", id: null }, "scenario cleanup restores idle");
  }
}

async function runScenario(page, cdp, scenario) {
  await emulate(page, cdp, scenario);
  await assertEnvironment(page, scenario);
  assert.equal((await timerInfo(page)).status, "idle", `${scenario.name} starts idle`);
  await assertBothPasses(page, scenario);
  await keyToStatus(page, "timerToggle", "Enter", "running");
  const runningId = (await timerInfo(page)).id;
  assert.ok(runningId, `${scenario.name} running has an identity`);
  await assertBothPasses(page, scenario);
  await tabReachesActions(page, scenario);
  try {
    await page.emulateMedia({ forcedColors: "active" });
    await tabReachesActions(page, scenario, true);
  } finally {
    await page.emulateMedia({ forcedColors: "none" });
  }
  await keyToStatus(page, "timerToggle", "Space", "paused");
  assert.equal((await timerInfo(page)).id, runningId, `${scenario.name} pause retains identity`);
  await keyToStatus(page, "timerToggle", "Space", "running");
  assert.equal((await timerInfo(page)).id, runningId, `${scenario.name} resume retains identity`);
  await keyToStatus(page, "finishButton", "Enter", "completed");
  assert.equal((await timerInfo(page)).id, runningId, `${scenario.name} finish keeps identity`);
  await page.waitForFunction(() => !document.querySelector("#clearButton").disabled,
    null, { timeout: 15000 });
  await assertBothPasses(page, scenario);
  await keyToStatus(page, "clearButton", "Space", "completed");
  assert.equal(await page.locator("#clearButton").isDisabled(), true, `${scenario.name} stop sound disables clear`);
  assert.equal((await timerInfo(page)).id, runningId, `${scenario.name} stop keeps identity`);
  await keyToStatus(page, "timerToggle", "Enter", "running");
  const secondId = (await timerInfo(page)).id;
  assert.ok(secondId && secondId !== runningId, `${scenario.name} restart creates a new identity`);
  await keyToStatus(page, "cancelButton", "Enter", "idle");
  assert.equal((await timerInfo(page)).id, null, `${scenario.name} cancel returns to idle`);
  if (scenario.pointer) {
    await clickToStatus(page, "timerToggle", "running");
    await clickToStatus(page, "finishButton", "completed");
    await page.waitForFunction(() => !document.querySelector("#clearButton").disabled,
      null, { timeout: 15000 });
    await assertBothPasses(page, scenario);
    await clickToStatus(page, "clearButton", "completed");
    await clickToStatus(page, "timerToggle", "running");
    await clickToStatus(page, "cancelButton", "idle");
  }
  await assertBothPasses(page, scenario);
  console.log(`R49-S07 pass ${scenario.name}`);
}

test("R49-S07 Timer action bank fits every enabled descendant", { timeout: 300_000 }, async (t) => {
  const browser = await launchBrowser(t);
  for (const locale of LOCALES) {
    const { context, page, cdp, errors } = await openLocale(browser, locale);
    try {
      for (const scenario of scenarios().filter((s) => s.locale === locale)) {
        await t.test(scenario.name, () => withTimerCleanup(page, () => runScenario(page, cdp, scenario)));
      }
    } finally {
      try { await cdp.detach(); } catch {}
      await context.close();
      assert.deepEqual(errors, [], `${locale} no page errors`);
    }
  }
});

test("R53-S02 invisible focus fails without contaminating the next scenario", { timeout: 120_000 }, async (t) => {
  const browser = await launchBrowser(t);
  const { context, page, cdp, errors } = await openLocale(browser, "en");
  const scenario = scenarios()[0];
  try {
    await emulate(page, cdp, scenario);
    for (const shadow of ["none", "inset 0 0 0 3px transparent, inset 0 0 0 6px transparent"]) {
      await assert.rejects(withTimerCleanup(page, async () => {
        await keyToStatus(page, "timerToggle", "Enter", "running");
        await page.evaluate((shadow) => {
          for (const id of ["finishButton", "cancelButton"]) {
            document.getElementById(id).style.setProperty("box-shadow", shadow, "important");
          }
        }, shadow);
        await tabReachesActions(page, scenario);
      }), /finishButton visible focus inset 3px/);
      assert.deepEqual(await timerInfo(page), { status: "idle", id: null }, "failed focus check leaves idle");
    }
    await page.evaluate(() => {
      for (const id of ["finishButton", "cancelButton"]) {
        document.getElementById(id).style.removeProperty("box-shadow");
      }
    });
    await withTimerCleanup(page, () => runScenario(page, cdp, scenario));
  } finally {
    try { await cdp.detach(); } catch {}
    await context.close();
    assert.deepEqual(errors, [], "negative focus controls have no page errors");
  }
});

test("R49-S07 baseline without the action fix overflows", { timeout: 120_000 }, async (t) => {
  const browser = await launchBrowser(t);
  const negatives = [
    { name: "en asymmetric 300", locale: "en", width: 960, height: 720, font: 200, fold: 300, insets: ZERO },
    { name: "ar-XB equal 470", locale: "ar-XB", width: 960, height: 720, font: 200, fold: 470, insets: ZERO },
  ];
  for (const scenario of negatives) {
    const full = { ...scenario, pointer: false };
    const { context, page, cdp } = await openLocale(browser, full.locale);
    try {
      await emulate(page, cdp, full);
      await assertEnvironment(page, full);
      await keyToStatus(page, "timerToggle", "Enter", "running");
      await keyToStatus(page, "finishButton", "Enter", "completed");
      await page.waitForFunction(() => !document.querySelector("#clearButton").disabled,
        null, { timeout: 15000 });
      const before = await readDescendants(page, false);
      assert.ok(before.bankScroll <= before.bankWidth + 1, `${scenario.name} fixed bank fits`);
      await stripActionFix(context, page);
      await page.waitForTimeout(250);
      const after = await page.evaluate(() => {
        for (const el of document.querySelectorAll("*")) if (el.scrollLeft) el.scrollLeft = 0;
        window.scrollTo({ left: 0, top: 0, behavior: "instant" });
        const bank = document.querySelector(".action-bank");
        const clear = document.querySelector("#clearButton").getBoundingClientRect();
        const finish = document.querySelector("#finishButton").getBoundingClientRect();
        const cancel = document.querySelector("#cancelButton").getBoundingClientRect();
        return { bankWidth: bank.clientWidth, bankScroll: bank.scrollWidth,
          clear: { left: clear.left, right: clear.right },
          finish: { left: finish.left, right: finish.right },
          cancel: { left: cancel.left, right: cancel.right }, scrollX: window.scrollX };
      });
      assert.equal(after.scrollX, 0, `${scenario.name} negative stays unpanned`);
      const bounds = usableBounds(full);
      const crosses = (r) => r.left < scenario.fold + MASK && r.right > scenario.fold;
      const escapes = (r) => r.left < bounds.left - 1 || r.right > bounds.right + 1;
      assert.ok(after.bankScroll > after.bankWidth + 5,
        `${scenario.name} old bank overflows ${after.bankScroll}/${after.bankWidth}`);
      assert.ok(crosses(after.clear) || crosses(after.finish) || crosses(after.cancel)
        || escapes(after.clear) || escapes(after.finish) || escapes(after.cancel),
        `${scenario.name} old actions cross fold ${scenario.fold}..${scenario.fold + MASK} or escape usable bounds`);
      console.log(`R49-S07 negative red ${scenario.name} bank=${after.bankScroll}/${after.bankWidth}`);
    } finally {
      try { await cdp.detach(); } catch {}
      await context.close();
    }
  }
});
